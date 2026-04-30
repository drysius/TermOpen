use std::{
    collections::HashMap,
    env, fs,
    io::{Read, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use russh::{
    client,
    keys::{
        self,
        known_hosts::{check_known_hosts_path, learn_known_hosts_path},
        PrivateKeyWithHashAlg, PublicKeyBase64,
    },
    ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect,
};
use russh_sftp::client::SftpSession;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    task::JoinHandle,
    time::sleep,
};

use crate::libs::models::{
    BackendMessage, ConnectionProfile, KnownHostEntry, SftpEntry, SshConnectPurpose,
    SshConnectResult, SshSessionInfo,
};

pub struct SshManager {
    sessions: HashMap<String, ManagedSession>,
    local_sessions: HashMap<String, LocalManagedSession>,
}

async fn ensure_sftp_session(managed: &mut ManagedSession) -> Result<&mut SftpSession> {
    if managed.sftp.is_none() {
        let channel = managed
            .handle
            .channel_open_session()
            .await
            .context("Falha ao abrir canal SFTP")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("Falha ao iniciar subsistema SFTP")?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .context("Falha ao inicializar sessao SFTP")?;
        managed.sftp = Some(sftp);
    }

    managed
        .sftp
        .as_mut()
        .ok_or_else(|| anyhow!("Falha ao inicializar sessao SFTP"))
}

async fn open_terminal_session(
    handle: &client::Handle<SshClientHandler>,
) -> Result<TerminalSession> {
    let channel = handle
        .channel_open_session()
        .await
        .context("Falha ao abrir canal shell SSH")?;
    channel
        .request_pty(true, "xterm", 160, 48, 0, 0, &[])
        .await
        .context("Falha ao solicitar PTY SSH")?;
    channel
        .request_shell(true)
        .await
        .context("Falha ao iniciar shell SSH")?;

    let (read_half, write_half) = channel.split();
    let output = Arc::new(Mutex::new(Vec::new()));
    let reader_task = spawn_terminal_reader(read_half, Arc::clone(&output));

    Ok(TerminalSession {
        writer: write_half,
        output,
        reader_task,
    })
}

fn spawn_terminal_reader(
    mut read_half: ChannelReadHalf,
    output: Arc<Mutex<Vec<u8>>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(message) = read_half.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if let Ok(mut guard) = output.lock() {
                        guard.extend_from_slice(data.as_ref());
                    } else {
                        break;
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    })
}

fn drain_remote_output(output: &Arc<Mutex<Vec<u8>>>) -> String {
    if let Ok(mut guard) = output.lock() {
        if guard.is_empty() {
            return String::new();
        }
        let bytes = guard.drain(..).collect::<Vec<_>>();
        return String::from_utf8_lossy(&bytes).to_string();
    }
    String::new()
}

async fn write_to_remote_channel(
    writer: &ChannelWriteHalf<client::Msg>,
    bytes: &[u8],
) -> Result<()> {
    let cursor = std::io::Cursor::new(bytes.to_vec());
    writer
        .data(cursor)
        .await
        .context("Falha ao escrever no canal SSH")
}

async fn run_remote_copy_command(
    handle: &client::Handle<SshClientHandler>,
    source: &str,
    target: &str,
    source_is_dir: bool,
) -> Result<()> {
    let source_quoted = shell_quote_posix(source);
    let target_quoted = shell_quote_posix(target);

    let cp_a = format!("cp -a -- {} {}", source_quoted, target_quoted);
    if run_remote_exec(handle, cp_a.as_str()).await.is_ok() {
        return Ok(());
    }

    let recursive_flag = if source_is_dir { "-R" } else { "" };
    let cp_r = if recursive_flag.is_empty() {
        format!("cp -- {} {}", source_quoted, target_quoted)
    } else {
        format!(
            "cp {} -- {} {}",
            recursive_flag, source_quoted, target_quoted
        )
    };
    run_remote_exec(handle, cp_r.as_str()).await
}

async fn run_remote_exec(handle: &client::Handle<SshClientHandler>, command: &str) -> Result<()> {
    let mut channel = handle
        .channel_open_session()
        .await
        .context("Falha ao abrir canal exec SSH")?;
    channel
        .exec(true, command)
        .await
        .with_context(|| format!("Falha ao executar comando remoto: {}", command))?;

    let mut output = Vec::new();
    let mut exit_status = None::<u32>;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                output.extend_from_slice(data.as_ref());
            }
            ChannelMsg::ExitStatus {
                exit_status: status,
            } => {
                exit_status = Some(status);
            }
            ChannelMsg::Eof => {}
            ChannelMsg::Close => break,
            _ => {}
        }
    }

    let status = exit_status.unwrap_or(255);
    if status == 0 {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output).trim().to_string();
    if stderr.is_empty() {
        return Err(anyhow!(
            "Comando remoto retornou status {} sem detalhes",
            status
        ));
    }

    Err(anyhow!(
        "Comando remoto retornou status {}: {}",
        status,
        stderr
    ))
}

fn shell_quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub fn known_hosts_list(path_override: Option<&str>) -> Result<Vec<KnownHostEntry>> {
    let path = resolve_known_hosts_path(path_override)?;
    ensure_known_hosts_file(&path)?;

    let raw = fs::read_to_string(&path)
        .with_context(|| format!("Falha ao ler known_hosts em {}", path.display()))?;

    let mut entries = Vec::new();
    for line in raw.lines() {
        if let Some(entry) = parse_known_host_line(line, &path) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

pub fn known_hosts_ensure(path_override: Option<&str>) -> Result<String> {
    let path = resolve_known_hosts_path(path_override)?;
    ensure_known_hosts_file(&path)?;
    Ok(path.to_string_lossy().to_string())
}

pub fn known_hosts_remove(path_override: Option<&str>, line_raw: &str) -> Result<()> {
    let path = resolve_known_hosts_path(path_override)?;
    ensure_known_hosts_file(&path)?;

    let raw = fs::read_to_string(&path)
        .with_context(|| format!("Falha ao ler known_hosts em {}", path.display()))?;
    let target = line_raw.trim();

    let mut changed = false;
    let mut next_lines = Vec::new();
    for line in raw.lines() {
        if !changed && line.trim() == target {
            changed = true;
            continue;
        }
        next_lines.push(line);
    }

    if !changed {
        return Err(anyhow!("Entrada nao encontrada no known_hosts"));
    }

    let mut content = next_lines.join("\n");
    if !content.is_empty() {
        content.push('\n');
    }
    fs::write(&path, content)
        .with_context(|| format!("Falha ao escrever known_hosts em {}", path.display()))
}

pub fn known_hosts_add(
    path_override: Option<&str>,
    host: &str,
    port: u16,
    key_type: &str,
    key_base64: &str,
) -> Result<KnownHostEntry> {
    let path = resolve_known_hosts_path(path_override)?;
    ensure_known_hosts_file(&path)?;

    let host_token = known_host_token(host, port);
    let line = format!("{} {} {}", host_token, key_type.trim(), key_base64.trim());

    let mut current = fs::read_to_string(&path)
        .with_context(|| format!("Falha ao ler known_hosts em {}", path.display()))?;
    if !current.ends_with('\n') && !current.is_empty() {
        current.push('\n');
    }
    current.push_str(&line);
    current.push('\n');
    fs::write(&path, current)
        .with_context(|| format!("Falha ao escrever known_hosts em {}", path.display()))?;

    parse_known_host_line(&line, &path)
        .ok_or_else(|| anyhow!("Falha ao montar entrada de known host"))
}

fn verify_known_host(
    server_key: &keys::PublicKey,
    profile: &ConnectionProfile,
    known_hosts_path: &Path,
    accept_unknown_host: bool,
) -> Result<Option<SshConnectResult>> {
    let key_type_label = server_key.algorithm().to_string();
    let fingerprint = host_fingerprint(&server_key.public_key_bytes());

    match check_known_hosts_path(&profile.host, profile.port, server_key, known_hosts_path) {
        Ok(true) => Ok(None),
        Ok(false) => {
            if !accept_unknown_host {
                return Ok(Some(SshConnectResult::UnknownHostChallenge {
                    host: profile.host.clone(),
                    port: profile.port,
                    key_type: key_type_label,
                    fingerprint,
                    known_hosts_path: known_hosts_path.to_string_lossy().to_string(),
                    message: BackendMessage::key("ssh_unknown_host_challenge"),
                }));
            }

            learn_known_hosts_path(&profile.host, profile.port, server_key, known_hosts_path)
                .context("Falha ao adicionar host ao known_hosts")?;
            Ok(None)
        }
        Err(keys::Error::KeyChanged { .. }) => Ok(Some(SshConnectResult::Error {
            message: BackendMessage::key("ssh_host_key_mismatch"),
        })),
        Err(error) => {
            let mut params = HashMap::new();
            params.insert("reason".to_string(), error.to_string());
            Ok(Some(SshConnectResult::Error {
                message: BackendMessage::with_params("ssh_known_hosts_validation_failed", params),
            }))
        }
    }
}

async fn authenticate_session(
    handle: &mut client::Handle<SshClientHandler>,
    profile: &ConnectionProfile,
) -> Result<(), AuthFailure> {
    let key_data = profile
        .private_key
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    let password_data = profile
        .password
        .as_ref()
        .map(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());

    if key_data.is_none() && password_data.is_none() {
        return Err(AuthFailure::NeedsInput(BackendMessage::key(
            "ssh_credentials_missing",
        )));
    }

    if let Some(private_key) = key_data {
        let key_result =
            auth_with_private_key(handle, &profile.username, private_key, password_data).await;

        if let Ok(true) = key_result {
            return Ok(());
        }

        if password_data.is_none() {
            let message = match key_result {
                Ok(false) => BackendMessage::key("ssh_private_key_auth_failed"),
                Ok(true) => BackendMessage::key("ssh_private_key_auth_unexpected"),
                Err(error) => {
                    let mut params = HashMap::new();
                    params.insert("reason".to_string(), error.to_string());
                    BackendMessage::with_params("ssh_private_key_auth_failed_with_reason", params)
                }
            };
            return Err(AuthFailure::NeedsInput(message));
        }
    }

    if let Some(password) = password_data {
        let auth = handle
            .authenticate_password(&profile.username, password)
            .await
            .map_err(|error| {
                let mut params = HashMap::new();
                params.insert("reason".to_string(), error.to_string());
                AuthFailure::NeedsInput(BackendMessage::with_params(
                    "ssh_password_auth_failed_with_reason",
                    params,
                ))
            })?;

        if auth.success() {
            return Ok(());
        }

        return Err(AuthFailure::NeedsInput(BackendMessage::key(
            "ssh_password_auth_failed",
        )));
    }

    Err(AuthFailure::Fatal(BackendMessage::key("ssh_auth_failed")))
}

fn parse_known_host_line(line: &str, source_path: &Path) -> Option<KnownHostEntry> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let parts = trimmed.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 3 {
        return None;
    }

    let host_token = parts[0].split(',').next().unwrap_or(parts[0]);
    let (host, port) = parse_host_port(host_token);
    let key_type = parts[1].to_string();
    let fingerprint = decode_known_host_fingerprint(parts[2]);

    Some(KnownHostEntry {
        host,
        port,
        key_type,
        fingerprint,
        line_raw: trimmed.to_string(),
        path: source_path.to_string_lossy().to_string(),
    })
}

fn parse_host_port(host_token: &str) -> (String, u16) {
    if host_token.starts_with('[') {
        if let Some(close_idx) = host_token.find(']') {
            let host = host_token[1..close_idx].to_string();
            if let Some(port_text) = host_token.get(close_idx + 2..) {
                if let Ok(port) = port_text.parse::<u16>() {
                    return (host, port);
                }
            }
            return (host, 22);
        }
    }
    (host_token.to_string(), 22)
}

fn decode_known_host_fingerprint(base64_key: &str) -> String {
    match BASE64.decode(base64_key) {
        Ok(bytes) => host_fingerprint(&bytes),
        Err(_) => "-".to_string(),
    }
}

fn host_fingerprint(host_key: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(host_key);
    format!("SHA256:{}", BASE64.encode(hasher.finalize()))
}

fn known_host_token(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{}]:{}", host, port)
    }
}

fn ensure_known_hosts_file(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Falha ao criar diretorio de known_hosts: {}",
                parent.display()
            )
        })?;
    }
    if !path.exists() {
        fs::write(path, "")
            .with_context(|| format!("Falha ao criar arquivo known_hosts em {}", path.display()))?;
    }
    Ok(())
}

fn resolve_known_hosts_path(configured: Option<&str>) -> Result<PathBuf> {
    let from_settings = configured
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let path = if let Some(path) = from_settings {
        PathBuf::from(path)
    } else {
        default_known_hosts_path()?
    };

    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map_err(|error| anyhow!("Falha ao resolver diretorio atual: {}", error))
            .map(|cwd| cwd.join(path))
    }
}

fn default_known_hosts_path() -> Result<PathBuf> {
    if let Some(home) = env::var_os("HOME") {
        return Ok(PathBuf::from(home).join(".ssh").join("known_hosts"));
    }
    if let Some(home) = env::var_os("USERPROFILE") {
        return Ok(PathBuf::from(home).join(".ssh").join("known_hosts"));
    }
    Err(anyhow!(
        "Nao foi possivel descobrir HOME/USERPROFILE para known_hosts"
    ))
}

fn update_mouse_sgr_mode(output: &str, enabled: &mut bool) {
    let bytes = output.as_bytes();
    let mut index = 0usize;

    while index + 3 < bytes.len() {
        if bytes[index] == 0x1b && bytes[index + 1] == b'[' && bytes[index + 2] == b'?' {
            let mut cursor = index + 3;
            let mut modes = Vec::<u16>::new();
            loop {
                let start = cursor;
                while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                    cursor += 1;
                }
                if start == cursor {
                    break;
                }
                if let Ok(value) = std::str::from_utf8(&bytes[start..cursor]) {
                    if let Ok(number) = value.parse::<u16>() {
                        modes.push(number);
                    }
                }
                if cursor >= bytes.len() || bytes[cursor] != b';' {
                    break;
                }
                cursor += 1;
            }

            if cursor < bytes.len() {
                let command = bytes[cursor];
                if command == b'h' || command == b'l' {
                    let next_value = command == b'h';
                    if modes.into_iter().any(|mode| mode == 1006) {
                        *enabled = next_value;
                    }
                }
            }
        }
        index += 1;
    }
}

fn spawn_local_shell(
    start_path: Option<&Path>,
) -> Result<(Child, ChildStdin, ChildStdout, ChildStderr)> {
    #[cfg(target_os = "windows")]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("powershell");
        cmd.arg("-NoLogo").arg("-NoProfile");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let mut cmd = Command::new("bash");
        cmd.arg("-i");
        cmd
    };

    if let Some(path) = start_path {
        command.current_dir(path);
    }

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Failed to start local terminal process")?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Failed to capture local terminal stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Failed to capture local terminal stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Failed to capture local terminal stderr"))?;

    Ok((child, stdin, stdout, stderr))
}

fn pump_reader_into_buffer<R>(mut reader: R, output: Arc<Mutex<Vec<u8>>>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if let Ok(mut guard) = output.lock() {
                        guard.extend_from_slice(&buffer[..size]);
                    } else {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn drain_local_output(output: &Arc<Mutex<Vec<u8>>>) -> String {
    if let Ok(mut guard) = output.lock() {
        if guard.is_empty() {
            return String::new();
        }
        let bytes = guard.drain(..).collect::<Vec<_>>();
        return String::from_utf8_lossy(&bytes).to_string();
    }
    String::new()
}

async fn auth_with_private_key(
    handle: &mut client::Handle<SshClientHandler>,
    username: &str,
    private_key: &str,
    passphrase: Option<&str>,
) -> Result<bool> {
    let key = keys::decode_secret_key(private_key, passphrase)
        .context("Falha ao carregar chave privada SSH")?;

    let hash_alg = if key.algorithm().is_rsa() {
        handle
            .best_supported_rsa_hash()
            .await
            .context("Falha ao negociar algoritmo RSA com servidor SSH")?
            .flatten()
    } else {
        None
    };

    let auth = handle
        .authenticate_publickey(
            username,
            PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
        )
        .await
        .context("Falha ao autenticar com chave privada")?;

    Ok(auth.success())
}

fn normalize_remote_path(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        "/".to_string()
    } else if trimmed.starts_with('/') {
        trimmed
    } else {
        format!("/{}", trimmed)
    }
}

fn join_remote_path(base: &str, child: &str) -> String {
    let base = normalize_remote_path(base);
    let child = child.trim().trim_start_matches('/');
    if base == "/" {
        format!("/{}", child)
    } else {
        format!("{}/{}", base.trim_end_matches('/'), child)
    }
}

fn normalize_chunk_size(chunk_size: usize) -> usize {
    chunk_size.max(64 * 1024).min(8 * 1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::update_mouse_sgr_mode;

    #[test]
    fn should_toggle_sgr_mouse_mode_from_terminal_output() {
        let mut enabled = false;
        update_mouse_sgr_mode("\x1b[?1006h", &mut enabled);
        assert!(enabled);

        update_mouse_sgr_mode("\x1b[?1006l", &mut enabled);
        assert!(!enabled);
    }

    #[test]
    fn should_ignore_non_sgr_mouse_sequences() {
        let mut enabled = false;
        update_mouse_sgr_mode("\x1b[?1000h", &mut enabled);
        assert!(!enabled);

        enabled = true;
        update_mouse_sgr_mode("\x1b[?25l", &mut enabled);
        assert!(enabled);
    }
}

struct ManagedSession {
    info: SshSessionInfo,
    handle: client::Handle<SshClientHandler>,
    terminal: Option<TerminalSession>,
    sftp: Option<SftpSession>,
    mouse_sgr_enabled: bool,
}

struct TerminalSession {
    writer: ChannelWriteHalf<client::Msg>,
    output: Arc<Mutex<Vec<u8>>>,
    reader_task: JoinHandle<()>,
}

struct LocalManagedSession {
    info: SshSessionInfo,
    child: Child,
    stdin: ChildStdin,
    output: Arc<Mutex<Vec<u8>>>,
}

#[derive(Clone, Default)]
struct HostKeyCapture {
    inner: Arc<Mutex<Option<keys::PublicKey>>>,
}

impl HostKeyCapture {
    fn set(&self, key: &keys::PublicKey) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some(key.clone());
        }
    }

    fn get(&self) -> Option<keys::PublicKey> {
        self.inner.lock().ok().and_then(|guard| guard.clone())
    }
}

struct SshClientHandler {
    host_key_capture: HostKeyCapture,
}

impl client::Handler for SshClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        self.host_key_capture.set(server_public_key);
        Ok(true)
    }
}

enum AuthFailure {
    NeedsInput(BackendMessage),
    Fatal(BackendMessage),
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            local_sessions: HashMap::new(),
        }
    }

    pub fn list_sessions(&self) -> Vec<SshSessionInfo> {
        let mut sessions = self
            .sessions
            .values()
            .map(|item| item.info.clone())
            .collect::<Vec<_>>();
        sessions.extend(self.local_sessions.values().map(|item| item.info.clone()));
        sessions
    }

    pub async fn connect(
        &mut self,
        profile: &ConnectionProfile,
        known_hosts_path: Option<&Path>,
    ) -> Result<SshSessionInfo> {
        match self
            .connect_ex(profile, known_hosts_path, true, SshConnectPurpose::Terminal)
            .await?
        {
            SshConnectResult::Connected { session } => Ok(session),
            SshConnectResult::UnknownHostChallenge { message, .. } => {
                Err(anyhow!(message.message.clone()))
            }
            SshConnectResult::AuthRequired { message } => Err(anyhow!(message.message.clone())),
            SshConnectResult::Error { message } => Err(anyhow!(message.message.clone())),
        }
    }

    pub async fn connect_ex(
        &mut self,
        profile: &ConnectionProfile,
        known_hosts_path: Option<&Path>,
        accept_unknown_host: bool,
        connect_purpose: SshConnectPurpose,
    ) -> Result<SshConnectResult> {
        let known_hosts_file = resolve_known_hosts_path(
            known_hosts_path
                .map(|path| path.to_string_lossy().to_string())
                .as_deref(),
        )?;
        ensure_known_hosts_file(&known_hosts_file)?;

        let host_key_capture = HostKeyCapture::default();
        let handler = SshClientHandler {
            host_key_capture: host_key_capture.clone(),
        };
        let config = Arc::new(client::Config::default());

        let mut handle = client::connect(config, (profile.host.as_str(), profile.port), handler)
            .await
            .with_context(|| {
                format!(
                    "Handshake SSH falhou ao conectar em {}:{}",
                    profile.host, profile.port
                )
            })?;

        let server_key = host_key_capture
            .get()
            .ok_or_else(|| anyhow!("Servidor SSH nao retornou host key"))?;

        if let Some(challenge) =
            verify_known_host(&server_key, profile, &known_hosts_file, accept_unknown_host)?
        {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "Disconnected", "pt-BR")
                .await;
            return Ok(challenge);
        }

        match authenticate_session(&mut handle, profile).await {
            Ok(()) => {}
            Err(AuthFailure::NeedsInput(message)) => {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "Disconnected", "pt-BR")
                    .await;
                return Ok(SshConnectResult::AuthRequired { message });
            }
            Err(AuthFailure::Fatal(message)) => {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "Disconnected", "pt-BR")
                    .await;
                return Ok(SshConnectResult::Error { message });
            }
        }

        let terminal = if connect_purpose == SshConnectPurpose::Terminal {
            Some(open_terminal_session(&handle).await?)
        } else {
            None
        };

        let session_id = uuid::Uuid::new_v4().to_string();
        let info = SshSessionInfo {
            session_id: session_id.clone(),
            profile_id: profile.id.clone(),
            connected_at: Utc::now().timestamp(),
            session_kind: "ssh".to_string(),
        };

        self.sessions.insert(
            session_id,
            ManagedSession {
                info: info.clone(),
                handle,
                terminal,
                sftp: None,
                mouse_sgr_enabled: false,
            },
        );

        Ok(SshConnectResult::Connected { session: info })
    }

    pub fn connect_local(&mut self, start_path: Option<&Path>) -> Result<SshSessionInfo> {
        let (child, stdin, stdout, stderr) = spawn_local_shell(start_path)?;
        let output = Arc::new(Mutex::new(Vec::new()));
        pump_reader_into_buffer(stdout, Arc::clone(&output));
        pump_reader_into_buffer(stderr, Arc::clone(&output));

        let session_id = uuid::Uuid::new_v4().to_string();
        let info = SshSessionInfo {
            session_id: session_id.clone(),
            profile_id: "local".to_string(),
            connected_at: Utc::now().timestamp(),
            session_kind: "local".to_string(),
        };

        let local = LocalManagedSession {
            info: info.clone(),
            child,
            stdin,
            output,
        };
        self.local_sessions.insert(session_id, local);

        Ok(info)
    }

    pub async fn disconnect(&mut self, session_id: &str) {
        if let Some(mut managed) = self.sessions.remove(session_id) {
            if let Some(terminal) = managed.terminal.take() {
                let _ = terminal.writer.eof().await;
                let _ = terminal.writer.close().await;
                terminal.reader_task.abort();
            }

            if let Some(sftp) = managed.sftp.take() {
                let _ = sftp.close().await;
            }

            let _ = managed
                .handle
                .disconnect(Disconnect::ByApplication, "Disconnected", "pt-BR")
                .await;
            return;
        }

        if let Some(mut local) = self.local_sessions.remove(session_id) {
            let _ = local.stdin.flush();
            let _ = local.child.kill();
            let _ = local.child.wait();
        }
    }

    pub async fn run_command(&mut self, session_id: &str, command: &str) -> Result<String> {
        if let Some(managed) = self.sessions.get_mut(session_id) {
            let terminal = managed
                .terminal
                .as_mut()
                .ok_or_else(|| anyhow!("Sessao {} nao suporta shell interativo", session_id))?;

            let payload = command.replace('\r', "\n");
            if !payload.is_empty() {
                write_to_remote_channel(&terminal.writer, payload.as_bytes())
                    .await
                    .context("Falha ao enviar entrada para shell SSH")?;
            }

            sleep(Duration::from_millis(140)).await;
            let output = drain_remote_output(&terminal.output);
            update_mouse_sgr_mode(&output, &mut managed.mouse_sgr_enabled);
            return Ok(output);
        }

        let local = self
            .local_sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;

        let payload = command.replace('\r', "\n");
        if !payload.is_empty() {
            local
                .stdin
                .write_all(payload.as_bytes())
                .context("Falha ao enviar entrada para terminal local")?;
            local
                .stdin
                .flush()
                .context("Falha ao flush do terminal local")?;
        }

        thread::sleep(Duration::from_millis(80));
        Ok(drain_local_output(&local.output))
    }

    pub async fn write_raw_input(&mut self, session_id: &str, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }

        if let Some(managed) = self.sessions.get_mut(session_id) {
            let terminal = managed
                .terminal
                .as_mut()
                .ok_or_else(|| anyhow!("Sessao {} nao suporta shell interativo", session_id))?;
            write_to_remote_channel(&terminal.writer, bytes)
                .await
                .context("Falha ao enviar input bruto para shell SSH")?;
            return Ok(());
        }

        if let Some(local) = self.local_sessions.get_mut(session_id) {
            local
                .stdin
                .write_all(bytes)
                .context("Falha ao enviar input bruto para terminal local")?;
            local
                .stdin
                .flush()
                .context("Falha ao flush de input bruto local")?;
            return Ok(());
        }

        Err(anyhow!("Sessao {} nao encontrada", session_id))
    }

    pub fn is_mouse_sgr_enabled(&self, session_id: &str) -> Result<bool> {
        if let Some(managed) = self.sessions.get(session_id) {
            return Ok(managed.mouse_sgr_enabled);
        }
        if self.local_sessions.contains_key(session_id) {
            return Ok(false);
        }
        Err(anyhow!("Sessao {} nao encontrada", session_id))
    }

    pub async fn resize_pty(&mut self, session_id: &str, cols: u32, rows: u32) -> Result<()> {
        if let Some(managed) = self.sessions.get_mut(session_id) {
            let terminal = managed.terminal.as_mut().ok_or_else(|| {
                anyhow!("Sessao {} nao suporta redimensionamento PTY", session_id)
            })?;
            terminal
                .writer
                .window_change(cols, rows, 0, 0)
                .await
                .context("Falha ao redimensionar PTY SSH")?;
            return Ok(());
        }

        if self.local_sessions.contains_key(session_id) {
            return Ok(());
        }

        Err(anyhow!("Sessao {} nao encontrada", session_id))
    }

    pub async fn sftp_list(&mut self, session_id: &str, path: &str) -> Result<Vec<SftpEntry>> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;

        let target = normalize_remote_path(path);
        let sftp = ensure_sftp_session(managed).await?;
        let read_dir = sftp
            .read_dir(target.clone())
            .await
            .with_context(|| format!("Falha ao listar diretorio remoto: {}", target))?;

        let mut mapped = Vec::new();
        for entry in read_dir {
            let name = entry.file_name();
            let metadata = entry.metadata();
            mapped.push(SftpEntry {
                name: name.clone(),
                path: join_remote_path(&target, &name),
                is_dir: metadata.is_dir(),
                size: metadata.size.unwrap_or_default(),
                permissions: metadata.permissions,
                modified_at: metadata.mtime.map(|value| value as i64),
            });
        }

        Ok(mapped)
    }

    pub async fn sftp_read(
        &mut self,
        session_id: &str,
        path: &str,
        chunk_size: usize,
    ) -> Result<String> {
        let bytes = self.sftp_read_bytes(session_id, path, chunk_size).await?;
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }

    pub async fn sftp_read_bytes(
        &mut self,
        session_id: &str,
        path: &str,
        chunk_size: usize,
    ) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.sftp_download_to_writer(session_id, path, &mut bytes, chunk_size, |_| {})
            .await?;

        Ok(bytes)
    }

    pub async fn sftp_read_bytes_with_limit(
        &mut self,
        session_id: &str,
        path: &str,
        chunk_size: usize,
        max_bytes: u64,
    ) -> Result<Option<Vec<u8>>> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        let target = normalize_remote_path(path);
        let sftp = ensure_sftp_session(managed).await?;

        let mut file = sftp
            .open(target.clone())
            .await
            .with_context(|| format!("Falha ao abrir arquivo remoto: {}", target))?;

        let mut bytes = Vec::new();
        let mut total = 0u64;
        let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];

        loop {
            let size = file
                .read(&mut buffer)
                .await
                .with_context(|| format!("Falha ao ler arquivo remoto: {}", target))?;
            if size == 0 {
                break;
            }

            total = total.saturating_add(size as u64);
            if total > max_bytes {
                return Ok(None);
            }

            bytes.extend_from_slice(&buffer[..size]);
        }

        Ok(Some(bytes))
    }

    pub async fn sftp_read_chunk(
        &mut self,
        session_id: &str,
        path: &str,
        offset: u64,
        chunk_size: usize,
    ) -> Result<(Vec<u8>, u64, bool)> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        let target = normalize_remote_path(path);
        let sftp = ensure_sftp_session(managed).await?;

        let total = sftp
            .metadata(target.clone())
            .await
            .ok()
            .and_then(|metadata| metadata.size)
            .unwrap_or(0);

        let mut file = sftp
            .open(target.clone())
            .await
            .with_context(|| format!("Falha ao abrir arquivo remoto: {}", target))?;

        file.seek(SeekFrom::Start(offset))
            .await
            .with_context(|| format!("Falha ao posicionar leitura remota em {}", target))?;

        let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];
        let size = file
            .read(&mut buffer)
            .await
            .with_context(|| format!("Falha ao ler chunk remoto: {}", target))?;
        buffer.truncate(size);

        let bytes_read = offset.saturating_add(size as u64);
        let eof = size == 0 || bytes_read >= total;

        Ok((buffer, total, eof))
    }

    pub async fn sftp_write(
        &mut self,
        session_id: &str,
        path: &str,
        content: &str,
        chunk_size: usize,
    ) -> Result<()> {
        self.sftp_write_bytes(session_id, path, content.as_bytes(), chunk_size)
            .await
    }

    pub async fn sftp_rename(
        &mut self,
        session_id: &str,
        from_path: &str,
        to_path: &str,
    ) -> Result<()> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        let from = normalize_remote_path(from_path);
        let to = normalize_remote_path(to_path);
        let sftp = ensure_sftp_session(managed).await?;
        sftp.rename(from.clone(), to.clone())
            .await
            .with_context(|| format!("Falha ao renomear item remoto de {} para {}", from, to))?;
        Ok(())
    }

    pub async fn sftp_delete(&mut self, session_id: &str, path: &str, is_dir: bool) -> Result<()> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        let target = normalize_remote_path(path);
        let sftp = ensure_sftp_session(managed).await?;

        if is_dir {
            sftp.remove_dir(target.clone())
                .await
                .with_context(|| format!("Falha ao remover pasta remota: {}", target))?;
        } else {
            sftp.remove_file(target.clone())
                .await
                .with_context(|| format!("Falha ao remover arquivo remoto: {}", target))?;
        }
        Ok(())
    }

    pub async fn sftp_mkdir(&mut self, session_id: &str, path: &str) -> Result<()> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        let target = normalize_remote_path(path);
        let sftp = ensure_sftp_session(managed).await?;
        sftp.create_dir(target.clone())
            .await
            .with_context(|| format!("Falha ao criar pasta remota: {}", target))?;
        Ok(())
    }

    pub async fn sftp_create_file(&mut self, session_id: &str, path: &str) -> Result<()> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        let target = normalize_remote_path(path);
        let sftp = ensure_sftp_session(managed).await?;
        let mut file = sftp
            .create(target.clone())
            .await
            .with_context(|| format!("Falha ao criar arquivo remoto: {}", target))?;
        let _ = file.shutdown().await;
        Ok(())
    }

    pub async fn sftp_write_bytes(
        &mut self,
        session_id: &str,
        path: &str,
        content: &[u8],
        chunk_size: usize,
    ) -> Result<()> {
        let mut cursor = std::io::Cursor::new(content);
        self.sftp_upload_from_reader(session_id, path, &mut cursor, chunk_size, |_| {})
            .await?;
        Ok(())
    }

    pub async fn sftp_file_size(&mut self, session_id: &str, path: &str) -> Result<Option<u64>> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;

        let target = normalize_remote_path(path);
        let sftp = ensure_sftp_session(managed).await?;

        match sftp.metadata(target).await {
            Ok(metadata) => Ok(metadata.size),
            Err(_) => Ok(None),
        }
    }

    pub async fn sftp_download_to_writer<W, F>(
        &mut self,
        session_id: &str,
        path: &str,
        writer: &mut W,
        chunk_size: usize,
        mut on_chunk: F,
    ) -> Result<u64>
    where
        W: Write,
        F: FnMut(u64),
    {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;

        let target = normalize_remote_path(path);
        let sftp = ensure_sftp_session(managed).await?;

        let mut file = sftp
            .open(target.clone())
            .await
            .with_context(|| format!("Falha ao abrir arquivo remoto: {}", target))?;

        let mut transferred = 0u64;
        let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];

        loop {
            let size = file
                .read(&mut buffer)
                .await
                .with_context(|| format!("Falha ao ler arquivo remoto: {}", target))?;
            if size == 0 {
                break;
            }

            writer
                .write_all(&buffer[..size])
                .with_context(|| format!("Falha ao escrever chunk recebido de {}", target))?;

            transferred = transferred.saturating_add(size as u64);
            on_chunk(size as u64);
        }

        Ok(transferred)
    }

    pub async fn sftp_upload_from_reader<R, F>(
        &mut self,
        session_id: &str,
        path: &str,
        reader: &mut R,
        chunk_size: usize,
        mut on_chunk: F,
    ) -> Result<u64>
    where
        R: Read,
        F: FnMut(u64),
    {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;

        let target = normalize_remote_path(path);
        let sftp = ensure_sftp_session(managed).await?;
        let mut file = sftp
            .create(target.clone())
            .await
            .with_context(|| format!("Falha ao criar arquivo remoto: {}", target))?;

        let mut transferred = 0u64;
        let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];
        loop {
            let size = reader
                .read(&mut buffer)
                .with_context(|| format!("Falha ao ler origem para upload: {}", target))?;
            if size == 0 {
                break;
            }

            file.write_all(&buffer[..size])
                .await
                .with_context(|| format!("Falha ao escrever arquivo remoto: {}", target))?;

            transferred = transferred.saturating_add(size as u64);
            on_chunk(size as u64);
        }

        file.shutdown()
            .await
            .with_context(|| format!("Falha ao finalizar arquivo remoto: {}", target))?;

        Ok(transferred)
    }

    pub fn sessions_share_profile(&self, left_session_id: &str, right_session_id: &str) -> bool {
        let left = self.sessions.get(left_session_id);
        let right = self.sessions.get(right_session_id);
        match (left, right) {
            (Some(left_session), Some(right_session)) => {
                left_session.info.profile_id == right_session.info.profile_id
            }
            _ => false,
        }
    }

    pub async fn sftp_copy_between_sessions(
        &mut self,
        from_session_id: &str,
        to_session_id: &str,
        from_path: &str,
        to_path: &str,
    ) -> Result<()> {
        if from_session_id != to_session_id
            && !self.sessions_share_profile(from_session_id, to_session_id)
        {
            return Err(anyhow!(
                "Copia remota otimizada requer sessoes no mesmo perfil"
            ));
        }

        let managed = self
            .sessions
            .get_mut(from_session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", from_session_id))?;

        let source = normalize_remote_path(from_path);
        let target = normalize_remote_path(to_path);
        if source == target {
            return Ok(());
        }

        let source_is_dir = {
            let sftp = ensure_sftp_session(managed).await?;
            let stat = sftp
                .metadata(source.clone())
                .await
                .with_context(|| format!("Falha ao obter metadata remota: {}", source))?;
            stat.is_dir()
        };

        run_remote_copy_command(&managed.handle, &source, &target, source_is_dir).await
    }
}
