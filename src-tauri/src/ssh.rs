use std::{
    collections::HashMap,
    env, fs,
    io::{ErrorKind, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use sha2::{Digest, Sha256};
use ssh2::{Channel, CheckResult, ExtendedData, KnownHostFileKind, Session};
use tempfile::NamedTempFile;

use crate::models::{
    ConnectionProfile, KnownHostEntry, SftpEntry, SshConnectResult, SshSessionInfo,
};

pub struct SshManager {
    sessions: HashMap<String, ManagedSession>,
}

struct ManagedSession {
    info: SshSessionInfo,
    session: Session,
    shell: Channel,
}

enum AuthFailure {
    NeedsInput(String),
    Fatal(String),
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn list_sessions(&self) -> Vec<SshSessionInfo> {
        self.sessions
            .values()
            .map(|item| item.info.clone())
            .collect()
    }

    pub fn connect(
        &mut self,
        profile: &ConnectionProfile,
        known_hosts_path: Option<&Path>,
    ) -> Result<SshSessionInfo> {
        match self.connect_ex(profile, known_hosts_path, true)? {
            SshConnectResult::Connected { session } => Ok(session),
            SshConnectResult::UnknownHostChallenge { message, .. } => Err(anyhow!(message)),
            SshConnectResult::AuthRequired { message } => Err(anyhow!(message)),
            SshConnectResult::Error { message } => Err(anyhow!(message)),
        }
    }

    pub fn connect_ex(
        &mut self,
        profile: &ConnectionProfile,
        known_hosts_path: Option<&Path>,
        accept_unknown_host: bool,
    ) -> Result<SshConnectResult> {
        let mut session = establish_handshake(profile)?;
        let known_hosts_file = resolve_known_hosts_path(
            known_hosts_path
                .map(|path| path.to_string_lossy().to_string())
                .as_deref(),
        )?;
        ensure_known_hosts_file(&known_hosts_file)?;

        match verify_known_host(&session, profile, &known_hosts_file, accept_unknown_host)? {
            Some(challenge) => return Ok(challenge),
            None => {}
        }

        match authenticate_session(&mut session, profile) {
            Ok(()) => {}
            Err(AuthFailure::NeedsInput(message)) => {
                return Ok(SshConnectResult::AuthRequired { message });
            }
            Err(AuthFailure::Fatal(message)) => {
                return Ok(SshConnectResult::Error { message });
            }
        }

        if !session.authenticated() {
            return Ok(SshConnectResult::AuthRequired {
                message: "Falha ao autenticar sessao SSH.".to_string(),
            });
        }

        session.set_blocking(true);

        let mut shell = session
            .channel_session()
            .context("Falha ao abrir canal shell SSH")?;
        shell
            .handle_extended_data(ExtendedData::Merge)
            .context("Falha ao configurar stderr do shell SSH")?;
        shell
            .request_pty("xterm", None, Some((160, 48, 0, 0)))
            .context("Falha ao solicitar PTY SSH")?;
        shell.shell().context("Falha ao iniciar shell SSH")?;
        shell.flush().ok();

        let session_id = uuid::Uuid::new_v4().to_string();
        let info = SshSessionInfo {
            session_id: session_id.clone(),
            profile_id: profile.id.clone(),
            connected_at: Utc::now().timestamp(),
        };

        self.sessions.insert(
            session_id,
            ManagedSession {
                info: info.clone(),
                session,
                shell,
            },
        );

        Ok(SshConnectResult::Connected { session: info })
    }

    pub fn disconnect(&mut self, session_id: &str) {
        if let Some(mut managed) = self.sessions.remove(session_id) {
            let _ = managed.shell.close();
            let _ = managed.shell.wait_close();
        }
    }

    pub fn run_command(&mut self, session_id: &str, command: &str) -> Result<String> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;

        let payload = command.replace('\r', "\n");
        if !payload.is_empty() {
            managed
                .shell
                .write_all(payload.as_bytes())
                .context("Falha ao enviar entrada para shell SSH")?;
            managed
                .shell
                .flush()
                .context("Falha ao flush da shell SSH")?;
        }

        read_shell_output(managed, Duration::from_millis(140))
    }

    pub fn resize_pty(&mut self, session_id: &str, cols: u32, rows: u32) -> Result<()> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        managed
            .shell
            .request_pty_size(cols, rows, None, None)
            .context("Falha ao redimensionar PTY SSH")
    }

    pub fn sftp_list(&mut self, session_id: &str, path: &str) -> Result<Vec<SftpEntry>> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;

        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let target = normalize_remote_path(path);

        let entries = sftp
            .readdir(&target)
            .with_context(|| format!("Falha ao listar diretorio remoto: {}", target.display()))?;

        let mapped = entries
            .into_iter()
            .map(|(pathbuf, stat)| {
                let name = pathbuf
                    .file_name()
                    .map(|item| item.to_string_lossy().to_string())
                    .unwrap_or_else(|| pathbuf.to_string_lossy().to_string());
                let permissions = stat.perm;
                let is_dir = permissions
                    .map(|value| (value & 0o170000) == 0o040000)
                    .unwrap_or(false);

                SftpEntry {
                    name,
                    path: pathbuf.to_string_lossy().replace('\\', "/"),
                    is_dir,
                    size: stat.size.unwrap_or_default(),
                    permissions,
                    modified_at: stat.mtime.map(|value| value as i64),
                }
            })
            .collect::<Vec<_>>();

        Ok(mapped)
    }

    pub fn sftp_read(&mut self, session_id: &str, path: &str, chunk_size: usize) -> Result<String> {
        let bytes = self.sftp_read_bytes(session_id, path, chunk_size)?;
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }

    pub fn sftp_read_bytes(
        &mut self,
        session_id: &str,
        path: &str,
        chunk_size: usize,
    ) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.sftp_download_to_writer(session_id, path, &mut bytes, chunk_size, |_| {})?;

        Ok(bytes)
    }

    pub fn sftp_read_bytes_with_limit(
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

        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let target = normalize_remote_path(path);

        let mut file = sftp
            .open(&target)
            .with_context(|| format!("Falha ao abrir arquivo remoto: {}", target.display()))?;

        let mut bytes = Vec::new();
        let mut total = 0u64;
        let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];
        loop {
            let size = file
                .read(&mut buffer)
                .with_context(|| format!("Falha ao ler arquivo remoto: {}", target.display()))?;
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

    pub fn sftp_write(
        &mut self,
        session_id: &str,
        path: &str,
        content: &str,
        chunk_size: usize,
    ) -> Result<()> {
        self.sftp_write_bytes(session_id, path, content.as_bytes(), chunk_size)
    }

    pub fn sftp_write_bytes(
        &mut self,
        session_id: &str,
        path: &str,
        content: &[u8],
        chunk_size: usize,
    ) -> Result<()> {
        let mut cursor = std::io::Cursor::new(content);
        self.sftp_upload_from_reader(session_id, path, &mut cursor, chunk_size, |_| {})?;
        Ok(())
    }

    pub fn sftp_file_size(&mut self, session_id: &str, path: &str) -> Result<Option<u64>> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;

        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let target = normalize_remote_path(path);

        match sftp.stat(&target) {
            Ok(stat) => Ok(stat.size),
            Err(_) => Ok(None),
        }
    }

    pub fn sftp_download_to_writer<W, F>(
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

        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let target = normalize_remote_path(path);

        let mut file = sftp
            .open(&target)
            .with_context(|| format!("Falha ao abrir arquivo remoto: {}", target.display()))?;

        let mut transferred = 0u64;
        let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];

        loop {
            let size = file
                .read(&mut buffer)
                .with_context(|| format!("Falha ao ler arquivo remoto: {}", target.display()))?;
            if size == 0 {
                break;
            }

            writer.write_all(&buffer[..size]).with_context(|| {
                format!("Falha ao escrever chunk recebido de {}", target.display())
            })?;
            transferred = transferred.saturating_add(size as u64);
            on_chunk(size as u64);
        }

        Ok(transferred)
    }

    pub fn sftp_upload_from_reader<R, F>(
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

        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let target = normalize_remote_path(path);

        let mut file = sftp
            .create(&target)
            .with_context(|| format!("Falha ao criar arquivo remoto: {}", target.display()))?;

        let mut transferred = 0u64;
        let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];
        loop {
            let size = reader.read(&mut buffer).with_context(|| {
                format!("Falha ao ler origem para upload: {}", target.display())
            })?;
            if size == 0 {
                break;
            }

            file.write_all(&buffer[..size]).with_context(|| {
                format!("Falha ao escrever arquivo remoto: {}", target.display())
            })?;

            transferred = transferred.saturating_add(size as u64);
            on_chunk(size as u64);
        }

        Ok(transferred)
    }
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
    session: &Session,
    profile: &ConnectionProfile,
    known_hosts_path: &Path,
    accept_unknown_host: bool,
) -> Result<Option<SshConnectResult>> {
    let (key, key_type) = session
        .host_key()
        .ok_or_else(|| anyhow!("Servidor SSH nao retornou host key"))?;
    let key_type_label = host_key_type_label(key_type);
    let fingerprint = host_fingerprint(key);

    let mut known_hosts = session
        .known_hosts()
        .context("Falha ao inicializar known_hosts")?;
    let _ = known_hosts.read_file(known_hosts_path, KnownHostFileKind::OpenSSH);

    let check = known_hosts.check_port(&profile.host, profile.port, key);
    match check {
        CheckResult::Match => Ok(None),
        CheckResult::NotFound => {
            if !accept_unknown_host {
                return Ok(Some(SshConnectResult::UnknownHostChallenge {
                    host: profile.host.clone(),
                    port: profile.port,
                    key_type: key_type_label.to_string(),
                    fingerprint,
                    known_hosts_path: known_hosts_path.to_string_lossy().to_string(),
                    message:
                        "Host desconhecido. Confirme para adicionar ao known_hosts e continuar."
                            .to_string(),
                }));
            }

            let host_token = known_host_token(&profile.host, profile.port);
            known_hosts
                .add(&host_token, key, &profile.host, key_type.into())
                .context("Falha ao adicionar host ao known_hosts")?;
            known_hosts
                .write_file(known_hosts_path, KnownHostFileKind::OpenSSH)
                .context("Falha ao persistir known_hosts")?;
            Ok(None)
        }
        CheckResult::Mismatch => Ok(Some(SshConnectResult::Error {
            message: "Host key divergente. Possivel alteracao remota ou risco de MITM.".to_string(),
        })),
        CheckResult::Failure => Ok(Some(SshConnectResult::Error {
            message: "Falha ao validar host key no known_hosts.".to_string(),
        })),
    }
}

fn authenticate_session(
    session: &mut Session,
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
        return Err(AuthFailure::NeedsInput(
            "Credenciais ausentes. Informe senha ou keychain para conectar.".to_string(),
        ));
    }

    if let Some(private_key) = key_data {
        let key_result =
            auth_with_private_key(session, &profile.username, private_key, password_data);
        if key_result.is_ok() && session.authenticated() {
            return Ok(());
        }
        if password_data.is_none() {
            return Err(AuthFailure::NeedsInput(
                "Falha na autenticacao com chave privada. Verifique passphrase ou selecione outro keychain."
                    .to_string(),
            ));
        }
    }

    if let Some(password) = password_data {
        session
            .userauth_password(&profile.username, password)
            .map_err(|error| {
                AuthFailure::NeedsInput(format!(
                    "Falha na autenticacao por senha: {}. Informe nova senha ou keychain.",
                    error
                ))
            })?;
        return Ok(());
    }

    Err(AuthFailure::Fatal(
        "Falha ao autenticar com as credenciais informadas.".to_string(),
    ))
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

fn host_key_type_label(host_key_type: ssh2::HostKeyType) -> &'static str {
    match host_key_type {
        ssh2::HostKeyType::Rsa => "ssh-rsa",
        ssh2::HostKeyType::Dss => "ssh-dss",
        ssh2::HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        ssh2::HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        ssh2::HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        ssh2::HostKeyType::Ed25519 => "ssh-ed25519",
        ssh2::HostKeyType::Unknown => "unknown",
    }
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

fn read_shell_output(managed: &mut ManagedSession, timeout: Duration) -> Result<String> {
    managed.session.set_blocking(false);

    let started = std::time::Instant::now();
    let mut output = Vec::new();
    let mut buffer = [0u8; 4096];

    loop {
        match managed.shell.read(&mut buffer) {
            Ok(0) => {
                if started.elapsed() >= timeout {
                    break;
                }
                thread::sleep(Duration::from_millis(12));
            }
            Ok(size) => {
                output.extend_from_slice(&buffer[..size]);
                if started.elapsed() >= timeout {
                    break;
                }
            }
            Err(error) => {
                if error.kind() == ErrorKind::WouldBlock {
                    if started.elapsed() >= timeout {
                        break;
                    }
                    thread::sleep(Duration::from_millis(12));
                    continue;
                }
                managed.session.set_blocking(true);
                return Err(anyhow!("Falha ao ler saida da shell SSH: {}", error));
            }
        }
    }

    managed.session.set_blocking(true);
    Ok(String::from_utf8_lossy(&output).to_string())
}

fn establish_handshake(profile: &ConnectionProfile) -> Result<Session> {
    let address = format!("{}:{}", profile.host, profile.port);
    let tcp = TcpStream::connect(&address)
        .with_context(|| format!("Falha ao conectar em {}", address))?;
    tcp.set_read_timeout(Some(Duration::from_secs(15))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(15))).ok();

    let mut session = Session::new().context("Falha ao iniciar sessao SSH")?;
    session.set_tcp_stream(tcp);
    session.handshake().context("Handshake SSH falhou")?;
    Ok(session)
}

fn auth_with_private_key(
    session: &mut Session,
    username: &str,
    private_key: &str,
    passphrase: Option<&str>,
) -> Result<()> {
    let mut temp_key =
        NamedTempFile::new().context("Falha ao criar arquivo temporario para chave privada")?;
    temp_key
        .write_all(private_key.as_bytes())
        .context("Falha ao escrever chave privada temporaria")?;

    session
        .userauth_pubkey_file(username, None, temp_key.path(), passphrase)
        .context("Falha ao autenticar com chave privada")
}

fn normalize_remote_path(path: &str) -> PathBuf {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        Path::new("/").to_path_buf()
    } else {
        Path::new(&trimmed).to_path_buf()
    }
}

fn normalize_chunk_size(chunk_size: usize) -> usize {
    chunk_size.max(64 * 1024).min(8 * 1024 * 1024)
}
