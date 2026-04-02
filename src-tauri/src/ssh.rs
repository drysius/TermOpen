use std::{
    collections::HashMap,
    env, fs,
    io::{ErrorKind, Read, Seek, SeekFrom, Write},
    net::TcpStream,
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
use sha2::{Digest, Sha256};
use ssh2::{Channel, CheckResult, ExtendedData, KnownHostFileKind, Session};
use tempfile::NamedTempFile;

use crate::models::{
    ConnectionProfile, KnownHostEntry, SftpEntry, SshConnectResult, SshSessionInfo,
};

pub struct SshManager {
    sessions: HashMap<String, ManagedSession>,
    local_sessions: HashMap<String, LocalManagedSession>,
}

struct ManagedSession {
    info: SshSessionInfo,
    session: Session,
    shell: Channel,
    mouse_sgr_enabled: bool,
}

struct LocalManagedSession {
    info: SshSessionInfo,
    child: Child,
    stdin: ChildStdin,
    output: Arc<Mutex<Vec<u8>>>,
}

enum AuthFailure {
    NeedsInput(String),
    Fatal(String),
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
            session_kind: "ssh".to_string(),
        };

        self.sessions.insert(
            session_id,
            ManagedSession {
                info: info.clone(),
                session,
                shell,
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

    pub fn disconnect(&mut self, session_id: &str) {
        if let Some(mut managed) = self.sessions.remove(session_id) {
            let _ = managed.shell.close();
            let _ = managed.shell.wait_close();
            return;
        }

        if let Some(mut local) = self.local_sessions.remove(session_id) {
            let _ = local.stdin.flush();
            let _ = local.child.kill();
            let _ = local.child.wait();
        }
    }

    pub fn run_command(&mut self, session_id: &str, command: &str) -> Result<String> {
        if let Some(managed) = self.sessions.get_mut(session_id) {
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

            let output = read_shell_output(managed, Duration::from_millis(140))?;
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

    pub fn write_raw_input(&mut self, session_id: &str, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }

        if let Some(managed) = self.sessions.get_mut(session_id) {
            managed
                .shell
                .write_all(bytes)
                .context("Falha ao enviar input bruto para shell SSH")?;
            managed
                .shell
                .flush()
                .context("Falha ao flush de input bruto SSH")?;
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

    pub fn resize_pty(&mut self, session_id: &str, cols: u32, rows: u32) -> Result<()> {
        if let Some(managed) = self.sessions.get_mut(session_id) {
            return managed
                .shell
                .request_pty_size(cols, rows, None, None)
                .context("Falha ao redimensionar PTY SSH");
        }
        if self.local_sessions.contains_key(session_id) {
            return Ok(());
        }
        Err(anyhow!("Sessao {} nao encontrada", session_id))
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

    pub fn sftp_read_chunk(
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

        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let target = normalize_remote_path(path);
        let total = sftp
            .stat(&target)
            .ok()
            .and_then(|stat| stat.size)
            .unwrap_or(0);

        let mut file = sftp
            .open(&target)
            .with_context(|| format!("Falha ao abrir arquivo remoto: {}", target.display()))?;
        file.seek(SeekFrom::Start(offset)).with_context(|| {
            format!("Falha ao posicionar leitura remota em {}", target.display())
        })?;

        let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];
        let size = file
            .read(&mut buffer)
            .with_context(|| format!("Falha ao ler chunk remoto: {}", target.display()))?;
        buffer.truncate(size);
        let bytes_read = offset.saturating_add(size as u64);
        let eof = size == 0 || bytes_read >= total;

        Ok((buffer, total, eof))
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

    pub fn sftp_rename(&mut self, session_id: &str, from_path: &str, to_path: &str) -> Result<()> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let from = normalize_remote_path(from_path);
        let to = normalize_remote_path(to_path);
        sftp.rename(&from, &to, None).with_context(|| {
            format!(
                "Falha ao renomear item remoto de {} para {}",
                from.display(),
                to.display()
            )
        })?;
        Ok(())
    }

    pub fn sftp_delete(&mut self, session_id: &str, path: &str, is_dir: bool) -> Result<()> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let target = normalize_remote_path(path);

        if is_dir {
            sftp.rmdir(&target)
                .with_context(|| format!("Falha ao remover pasta remota: {}", target.display()))?;
        } else {
            sftp.unlink(&target).with_context(|| {
                format!("Falha ao remover arquivo remoto: {}", target.display())
            })?;
        }
        Ok(())
    }

    pub fn sftp_mkdir(&mut self, session_id: &str, path: &str) -> Result<()> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let target = normalize_remote_path(path);
        sftp.mkdir(&target, 0o755)
            .with_context(|| format!("Falha ao criar pasta remota: {}", target.display()))?;
        Ok(())
    }

    pub fn sftp_create_file(&mut self, session_id: &str, path: &str) -> Result<()> {
        let managed = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("Sessao {} nao encontrada", session_id))?;
        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let target = normalize_remote_path(path);
        let _ = sftp
            .create(&target)
            .with_context(|| format!("Falha ao criar arquivo remoto: {}", target.display()))?;
        Ok(())
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

    pub fn sftp_copy_between_sessions(
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

        let sftp = managed
            .session
            .sftp()
            .context("Falha ao abrir canal SFTP")?;
        let source = normalize_remote_path(from_path);
        let target = normalize_remote_path(to_path);
        if source == target {
            return Ok(());
        }

        let stat = sftp
            .stat(&source)
            .with_context(|| format!("Falha ao obter metadata remota: {}", source.display()))?;
        let source_is_dir = stat
            .perm
            .map(|value| (value & 0o170000) == 0o040000)
            .unwrap_or(false);
        drop(sftp);

        run_remote_copy_command(&managed.session, &source, &target, source_is_dir)
    }
}

fn run_remote_copy_command(
    session: &Session,
    source: &Path,
    target: &Path,
    source_is_dir: bool,
) -> Result<()> {
    let source_quoted = shell_quote_posix(source.to_string_lossy().as_ref());
    let target_quoted = shell_quote_posix(target.to_string_lossy().as_ref());

    let cp_a = format!("cp -a -- {} {}", source_quoted, target_quoted);
    if run_remote_exec(session, cp_a.as_str()).is_ok() {
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
    run_remote_exec(session, cp_r.as_str())
}

fn run_remote_exec(session: &Session, command: &str) -> Result<()> {
    let mut channel = session
        .channel_session()
        .context("Falha ao abrir canal exec SSH")?;
    channel
        .handle_extended_data(ExtendedData::Merge)
        .context("Falha ao configurar stderr para exec SSH")?;
    channel
        .exec(command)
        .with_context(|| format!("Falha ao executar comando remoto: {}", command))?;

    let mut output = Vec::new();
    channel
        .read_to_end(&mut output)
        .context("Falha ao ler saida de comando remoto")?;

    channel
        .wait_close()
        .context("Falha ao finalizar comando remoto")?;
    let status = channel
        .exit_status()
        .context("Falha ao ler status do comando remoto")?;
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
