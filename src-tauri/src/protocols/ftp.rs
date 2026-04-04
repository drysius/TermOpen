use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use suppaftp::rustls::ClientConfig;
use suppaftp::{rustls, RustlsConnector, RustlsFtpStream};

use crate::constants::FTP_DEFAULT_PORT;
use crate::libs::models::{ConnectionProfile, SftpEntry};

fn normalize_chunk_size(chunk_size: usize) -> usize {
    chunk_size.max(32 * 1024).min(8 * 1024 * 1024)
}

fn require_profile_host(profile: &ConnectionProfile) -> Result<String> {
    let host = profile.host.trim().to_string();
    if host.is_empty() {
        return Err(anyhow!("Host remoto invalido."));
    }
    Ok(host)
}

fn require_profile_password(profile: &ConnectionProfile) -> Result<String> {
    let password = profile
        .password
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("Senha obrigatoria para autenticar no host remoto."))?;
    Ok(password)
}

fn normalize_ftp_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        "/".to_string()
    } else if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{}", normalized)
    }
}

fn join_ftp_child(base_path: &str, name: &str) -> String {
    if base_path == "/" {
        format!("/{}", name.trim_start_matches('/'))
    } else {
        format!(
            "{}/{}",
            base_path.trim_end_matches('/'),
            name.trim_start_matches('/')
        )
    }
}

fn build_ftps_connector() -> Result<RustlsConnector> {
    let cert_result = rustls_native_certs::load_native_certs();
    let mut root_store = rustls::RootCertStore::empty();
    for cert in cert_result.certs {
        let _ = root_store.add(cert);
    }

    if root_store.is_empty() {
        return Err(anyhow!(
            "Nao foi possivel carregar certificados raiz para FTPS."
        ));
    }

    let config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    Ok(RustlsConnector::from(Arc::new(config)))
}

fn connect_ftp(profile: &ConnectionProfile, secure: bool) -> Result<RustlsFtpStream> {
    let host = require_profile_host(profile)?;
    let username = profile.username.trim().to_string();
    let password = require_profile_password(profile)?;
    let port = if profile.port == 0 {
        FTP_DEFAULT_PORT
    } else {
        profile.port
    };
    let address = format!("{}:{}", host, port);

    let mut ftp = RustlsFtpStream::connect(address.as_str())
        .with_context(|| format!("Falha ao conectar FTP em {}", address))?;
    ftp.get_ref()
        .set_read_timeout(Some(Duration::from_secs(30)))
        .ok();
    ftp.get_ref()
        .set_write_timeout(Some(Duration::from_secs(30)))
        .ok();

    if secure {
        let connector = build_ftps_connector().context("Falha ao inicializar TLS para FTPS.")?;
        ftp = ftp
            .into_secure(connector, host.as_str())
            .context("Falha ao negociar canal TLS FTPS.")?;
    }

    ftp.login(username.as_str(), password.as_str())
        .with_context(|| format!("Falha de autenticacao FTP para {}", username))?;

    Ok(ftp)
}

pub fn list(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<Vec<SftpEntry>> {
    let mut ftp = connect_ftp(profile, secure)?;
    let normalized_path = normalize_ftp_path(path);

    let raw_entries = ftp
        .mlsd(Some(normalized_path.as_str()))
        .or_else(|_| ftp.list(Some(normalized_path.as_str())))
        .with_context(|| format!("Falha ao listar diretorio FTP {}", normalized_path))?;

    let mut entries = Vec::new();
    for line in raw_entries {
        let parsed = suppaftp::list::File::try_from(line.as_str());
        if let Ok(file) = parsed {
            let name = file.name().trim().to_string();
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }

            let modified_at = file
                .modified()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|duration| duration.as_secs() as i64);

            entries.push(SftpEntry {
                name: name.clone(),
                path: join_ftp_child(normalized_path.as_str(), name.as_str()),
                is_dir: file.is_directory(),
                size: file.size() as u64,
                permissions: None,
                modified_at,
            });
        }
    }

    entries.sort_by(|left, right| left.name.cmp(&right.name));
    let _ = ftp.quit();
    Ok(entries)
}

pub fn download_to_writer<W, F>(
    profile: &ConnectionProfile,
    path: &str,
    writer: &mut W,
    chunk_size: usize,
    secure: bool,
    mut on_chunk: F,
) -> Result<u64>
where
    W: Write,
    F: FnMut(u64),
{
    let mut ftp = connect_ftp(profile, secure)?;
    let normalized_path = normalize_ftp_path(path);
    let mut stream = ftp
        .retr_as_stream(normalized_path.as_str())
        .with_context(|| format!("Falha ao iniciar download FTP: {}", normalized_path))?;

    let mut transferred = 0u64;
    let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];
    loop {
        let size = stream
            .read(&mut buffer)
            .with_context(|| format!("Falha ao ler stream FTP: {}", normalized_path))?;
        if size == 0 {
            break;
        }
        writer.write_all(&buffer[..size]).with_context(|| {
            format!(
                "Falha ao escrever dados FTP em destino local: {}",
                normalized_path
            )
        })?;
        transferred = transferred.saturating_add(size as u64);
        on_chunk(size as u64);
    }

    ftp.finalize_retr_stream(stream)
        .with_context(|| format!("Falha ao finalizar download FTP: {}", normalized_path))?;
    let _ = ftp.quit();

    Ok(transferred)
}

pub fn upload_from_reader<R, F>(
    profile: &ConnectionProfile,
    path: &str,
    reader: &mut R,
    chunk_size: usize,
    secure: bool,
    mut on_chunk: F,
) -> Result<u64>
where
    R: Read,
    F: FnMut(u64),
{
    let mut ftp = connect_ftp(profile, secure)?;
    let normalized_path = normalize_ftp_path(path);
    let mut stream = ftp
        .put_with_stream(normalized_path.as_str())
        .with_context(|| format!("Falha ao iniciar upload FTP: {}", normalized_path))?;

    let mut transferred = 0u64;
    let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];
    loop {
        let size = reader
            .read(&mut buffer)
            .with_context(|| format!("Falha ao ler origem para upload FTP: {}", normalized_path))?;
        if size == 0 {
            break;
        }

        stream
            .write_all(&buffer[..size])
            .with_context(|| format!("Falha ao escrever stream FTP: {}", normalized_path))?;
        transferred = transferred.saturating_add(size as u64);
        on_chunk(size as u64);
    }

    ftp.finalize_put_stream(stream)
        .with_context(|| format!("Falha ao finalizar upload FTP: {}", normalized_path))?;
    let _ = ftp.quit();

    Ok(transferred)
}

pub fn read(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<String> {
    let bytes = read_bytes(profile, path, secure)?;
    String::from_utf8(bytes).map_err(|_| anyhow!("Arquivo remoto nao e UTF-8 valido."))
}

fn read_bytes(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    download_to_writer(profile, path, &mut bytes, 64 * 1024, secure, |_| {})?;
    Ok(bytes)
}

pub fn read_bytes_with_limit(
    profile: &ConnectionProfile,
    path: &str,
    max_bytes: u64,
    secure: bool,
) -> Result<Option<Vec<u8>>> {
    if let Some(size) = file_size(profile, path, secure)? {
        if size > max_bytes {
            return Ok(None);
        }
    }
    Ok(Some(read_bytes(profile, path, secure)?))
}

pub fn read_chunk(
    profile: &ConnectionProfile,
    path: &str,
    offset: u64,
    chunk_size: usize,
    secure: bool,
) -> Result<(Vec<u8>, u64, bool)> {
    let mut bytes = read_bytes(profile, path, secure)?;
    let total = bytes.len() as u64;
    if offset >= total {
        return Ok((Vec::new(), total, true));
    }

    let take = normalize_chunk_size(chunk_size) as u64;
    let end = (offset + take).min(total) as usize;
    let start = offset as usize;
    let chunk = bytes.drain(start..end).collect::<Vec<u8>>();
    Ok((chunk, total, end as u64 >= total))
}

pub fn write(
    profile: &ConnectionProfile,
    path: &str,
    content: &str,
    chunk_size: usize,
    secure: bool,
) -> Result<()> {
    write_bytes(profile, path, content.as_bytes(), chunk_size, secure)
}

fn write_bytes(
    profile: &ConnectionProfile,
    path: &str,
    content: &[u8],
    chunk_size: usize,
    secure: bool,
) -> Result<()> {
    let mut reader = std::io::Cursor::new(content.to_vec());
    upload_from_reader(profile, path, &mut reader, chunk_size, secure, |_| {})?;
    Ok(())
}

pub fn rename(
    profile: &ConnectionProfile,
    from_path: &str,
    to_path: &str,
    secure: bool,
) -> Result<()> {
    let mut ftp = connect_ftp(profile, secure)?;
    let from = normalize_ftp_path(from_path);
    let to = normalize_ftp_path(to_path);
    ftp.rename(from.as_str(), to.as_str())
        .with_context(|| format!("Falha ao renomear FTP {} -> {}", from, to))?;
    let _ = ftp.quit();
    Ok(())
}

pub fn delete(profile: &ConnectionProfile, path: &str, is_dir: bool, secure: bool) -> Result<()> {
    let mut ftp = connect_ftp(profile, secure)?;
    let normalized = normalize_ftp_path(path);
    if is_dir {
        ftp.rmdir(normalized.as_str())
            .with_context(|| format!("Falha ao remover diretorio FTP {}", normalized))?;
    } else {
        ftp.rm(normalized.as_str())
            .with_context(|| format!("Falha ao remover arquivo FTP {}", normalized))?;
    }
    let _ = ftp.quit();
    Ok(())
}

pub fn mkdir(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<()> {
    let mut ftp = connect_ftp(profile, secure)?;
    let normalized = normalize_ftp_path(path);
    ftp.mkdir(normalized.as_str())
        .with_context(|| format!("Falha ao criar pasta FTP {}", normalized))?;
    let _ = ftp.quit();
    Ok(())
}

pub fn create_file(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<()> {
    write_bytes(profile, path, &[], 64 * 1024, secure)?;
    Ok(())
}

pub fn file_size(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<Option<u64>> {
    let mut ftp = connect_ftp(profile, secure)?;
    let normalized = normalize_ftp_path(path);
    let size = ftp.size(normalized.as_str()).ok().map(|value| value as u64);
    let _ = ftp.quit();
    Ok(size)
}
