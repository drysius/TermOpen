use std::{
    io::{Read, Write},
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use smb::binrw_util::prelude::SizedWideString;
use smb::{
    Client, ClientConfig, CreateOptions, DirAccessMask, Directory, FileAccessMask, FileAttributes,
    FileCreateArgs, FileDispositionInformation, FileIdBothDirectoryInformation, FileRenameInformation,
    GetLen, ReadAt, Resource, UncPath, WriteAt,
};
use suppaftp::{
    NativeTlsConnector, NativeTlsFtpStream, native_tls::TlsConnector,
};

use crate::models::{ConnectionProfile, SftpEntry};

const FTP_DEFAULT_PORT: u16 = 21;
const SMB_DEFAULT_PORT: u16 = 445;

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

fn connect_ftp(profile: &ConnectionProfile, secure: bool) -> Result<NativeTlsFtpStream> {
    let host = require_profile_host(profile)?;
    let username = profile.username.trim().to_string();
    let password = require_profile_password(profile)?;
    let port = if profile.port == 0 {
        FTP_DEFAULT_PORT
    } else {
        profile.port
    };
    let address = format!("{}:{}", host, port);

    let mut ftp = NativeTlsFtpStream::connect(address.as_str())
        .with_context(|| format!("Falha ao conectar FTP em {}", address))?;
    ftp.get_ref().set_read_timeout(Some(Duration::from_secs(30))).ok();
    ftp.get_ref()
        .set_write_timeout(Some(Duration::from_secs(30)))
        .ok();

    if secure {
        let connector = TlsConnector::new().context("Falha ao inicializar TLS para FTPS.")?;
        ftp = ftp
            .into_secure(NativeTlsConnector::from(connector), host.as_str())
            .context("Falha ao negociar canal TLS FTPS.")?;
    }

    ftp.login(username.as_str(), password.as_str())
        .with_context(|| format!("Falha de autenticacao FTP para {}", username))?;

    Ok(ftp)
}

pub fn ftp_list(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<Vec<SftpEntry>> {
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

pub fn ftp_download_to_writer<W, F>(
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
        writer
            .write_all(&buffer[..size])
            .with_context(|| format!("Falha ao escrever dados FTP em destino local: {}", normalized_path))?;
        transferred = transferred.saturating_add(size as u64);
        on_chunk(size as u64);
    }

    ftp.finalize_retr_stream(stream)
        .with_context(|| format!("Falha ao finalizar download FTP: {}", normalized_path))?;
    let _ = ftp.quit();

    Ok(transferred)
}

pub fn ftp_upload_from_reader<R, F>(
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

pub fn ftp_read(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<String> {
    let bytes = ftp_read_bytes(profile, path, secure)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

pub fn ftp_read_bytes(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<Vec<u8>> {
    let mut ftp = connect_ftp(profile, secure)?;
    let normalized_path = normalize_ftp_path(path);
    let bytes = ftp
        .retr_as_buffer(normalized_path.as_str())
        .with_context(|| format!("Falha ao ler arquivo FTP {}", normalized_path))?
        .into_inner();
    let _ = ftp.quit();
    Ok(bytes)
}

pub fn ftp_read_bytes_with_limit(
    profile: &ConnectionProfile,
    path: &str,
    max_bytes: u64,
    secure: bool,
) -> Result<Option<Vec<u8>>> {
    let normalized_path = normalize_ftp_path(path);
    if let Some(size) = ftp_file_size(profile, normalized_path.as_str(), secure)? {
        if size > max_bytes {
            return Ok(None);
        }
    }

    let bytes = ftp_read_bytes(profile, normalized_path.as_str(), secure)?;
    if (bytes.len() as u64) > max_bytes {
        return Ok(None);
    }
    Ok(Some(bytes))
}

pub fn ftp_read_chunk(
    profile: &ConnectionProfile,
    path: &str,
    offset: u64,
    chunk_size: usize,
    secure: bool,
) -> Result<(Vec<u8>, u64, bool)> {
    let bytes = ftp_read_bytes(profile, path, secure)?;
    let total = bytes.len() as u64;
    let start = offset.min(total) as usize;
    let end = (offset.saturating_add(normalize_chunk_size(chunk_size) as u64)).min(total) as usize;
    let chunk = bytes[start..end].to_vec();
    let eof = end as u64 >= total;
    Ok((chunk, total, eof))
}

pub fn ftp_write(
    profile: &ConnectionProfile,
    path: &str,
    content: &str,
    chunk_size: usize,
    secure: bool,
) -> Result<()> {
    ftp_write_bytes(profile, path, content.as_bytes(), chunk_size, secure)
}

pub fn ftp_write_bytes(
    profile: &ConnectionProfile,
    path: &str,
    content: &[u8],
    chunk_size: usize,
    secure: bool,
) -> Result<()> {
    let mut cursor = std::io::Cursor::new(content);
    ftp_upload_from_reader(profile, path, &mut cursor, chunk_size, secure, |_| {})?;
    Ok(())
}

pub fn ftp_rename(
    profile: &ConnectionProfile,
    from_path: &str,
    to_path: &str,
    secure: bool,
) -> Result<()> {
    let mut ftp = connect_ftp(profile, secure)?;
    let from = normalize_ftp_path(from_path);
    let to = normalize_ftp_path(to_path);
    ftp.rename(from.as_str(), to.as_str())
        .with_context(|| format!("Falha ao renomear FTP de {} para {}", from, to))?;
    let _ = ftp.quit();
    Ok(())
}

pub fn ftp_delete(profile: &ConnectionProfile, path: &str, is_dir: bool, secure: bool) -> Result<()> {
    let mut ftp = connect_ftp(profile, secure)?;
    let target = normalize_ftp_path(path);
    if is_dir {
        ftp.rmdir(target.as_str())
            .with_context(|| format!("Falha ao remover pasta FTP {}", target))?;
    } else {
        ftp.rm(target.as_str())
            .with_context(|| format!("Falha ao remover arquivo FTP {}", target))?;
    }
    let _ = ftp.quit();
    Ok(())
}

pub fn ftp_mkdir(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<()> {
    let mut ftp = connect_ftp(profile, secure)?;
    let target = normalize_ftp_path(path);
    ftp.mkdir(target.as_str())
        .with_context(|| format!("Falha ao criar pasta FTP {}", target))?;
    let _ = ftp.quit();
    Ok(())
}

pub fn ftp_create_file(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<()> {
    let mut ftp = connect_ftp(profile, secure)?;
    let target = normalize_ftp_path(path);
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    ftp.put_file(target.as_str(), &mut cursor)
        .with_context(|| format!("Falha ao criar arquivo FTP {}", target))?;
    let _ = ftp.quit();
    Ok(())
}

pub fn ftp_file_size(profile: &ConnectionProfile, path: &str, secure: bool) -> Result<Option<u64>> {
    let mut ftp = connect_ftp(profile, secure)?;
    let target = normalize_ftp_path(path);
    let size = ftp.size(target.as_str()).ok().map(|value| value as u64);
    let _ = ftp.quit();
    Ok(size)
}

fn normalize_smb_virtual_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        "/".to_string()
    } else if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{}", normalized)
    }
}

fn profile_default_smb_path(profile: &ConnectionProfile) -> Option<String> {
    profile
        .remote_path
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| normalize_smb_virtual_path(value.as_str()))
}

fn resolve_smb_path(profile: &ConnectionProfile, input_path: &str) -> Result<(String, String)> {
    let normalized = normalize_smb_virtual_path(input_path);
    let effective = if normalized == "/" {
        profile_default_smb_path(profile).unwrap_or(normalized)
    } else {
        normalized
    };

    let trimmed = effective.trim().trim_matches('/').to_string();
    if trimmed.is_empty() {
        return Err(anyhow!(
            "Caminho SMB invalido. Use o formato /COMPARTILHAMENTO/pasta/arquivo."
        ));
    }

    let mut segments = trimmed.split('/');
    let share = segments.next().unwrap_or_default().trim().to_string();
    if share.is_empty() {
        return Err(anyhow!("Compartilhamento SMB nao informado no caminho remoto."));
    }
    let inner = segments.collect::<Vec<_>>().join("\\");
    Ok((share, inner))
}

fn smb_virtual_path(share: &str, inner_path: &str) -> String {
    if inner_path.trim().is_empty() {
        format!("/{}", share)
    } else {
        format!("/{}/{}", share, inner_path.replace('\\', "/"))
    }
}

fn smb_server_target(profile: &ConnectionProfile) -> Result<String> {
    let host = require_profile_host(profile)?;
    let port = if profile.port == 0 {
        SMB_DEFAULT_PORT
    } else {
        profile.port
    };
    if port == SMB_DEFAULT_PORT {
        Ok(host)
    } else {
        Ok(format!("{}:{}", host, port))
    }
}

async fn connect_smb_share(profile: &ConnectionProfile, share: &str) -> Result<(Client, UncPath)> {
    let server = smb_server_target(profile)?;
    let username = profile.username.trim().to_string();
    let password = require_profile_password(profile)?;

    let share_path = UncPath::new(server.as_str())
        .and_then(|path| path.with_share(share))
        .context("Falha ao montar UNC path SMB.")?;

    let client = Client::new(ClientConfig::default());
    client
        .share_connect(&share_path, username.as_str(), password)
        .await
        .with_context(|| format!("Falha ao conectar no compartilhamento SMB {}", share))?;

    Ok((client, share_path))
}

fn smb_unc_with_inner(share_path: &UncPath, inner_path: &str) -> UncPath {
    if inner_path.trim().is_empty() {
        share_path.clone()
    } else {
        share_path.clone().with_path(inner_path)
    }
}

pub async fn smb_list(profile: &ConnectionProfile, path: &str) -> Result<Vec<SftpEntry>> {
    let (share, inner_path) = resolve_smb_path(profile, path)?;
    let (client, share_path) = connect_smb_share(profile, share.as_str()).await?;
    let target_path = smb_unc_with_inner(&share_path, inner_path.as_str());

    let resource = client
        .create_file(
            &target_path,
            &FileCreateArgs::make_open_existing(DirAccessMask::new().with_list_directory(true).into()),
        )
        .await
        .with_context(|| format!("Falha ao abrir diretorio SMB {}", target_path))?;
    let directory = Arc::new(resource.unwrap_dir());
    let mut stream = Directory::query::<FileIdBothDirectoryInformation>(&directory, "*")
        .await
        .with_context(|| format!("Falha ao listar diretorio SMB {}", target_path))?;

    let mut entries = Vec::new();
    while let Some(entry) = stream.next().await {
        let entry = entry.map_err(|error| anyhow!(error.to_string()))?;
        let name = entry.file_name.to_string();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }

        let child_inner = if inner_path.is_empty() {
            name.clone()
        } else {
            format!("{}\\{}", inner_path, name)
        };
        let modified_at = {
            let time: std::time::SystemTime = entry.last_write_time.into();
            time.duration_since(UNIX_EPOCH)
                .ok()
                .map(|duration| duration.as_secs() as i64)
        };

        entries.push(SftpEntry {
            name: name.clone(),
            path: smb_virtual_path(share.as_str(), child_inner.as_str()),
            is_dir: entry.file_attributes.directory(),
            size: entry.end_of_file,
            permissions: None,
            modified_at,
        });
    }

    directory.close().await.ok();
    client.close().await.ok();
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

pub async fn smb_download_to_writer<W, F>(
    profile: &ConnectionProfile,
    path: &str,
    writer: &mut W,
    chunk_size: usize,
    mut on_chunk: F,
) -> Result<u64>
where
    W: Write,
    F: FnMut(u64),
{
    let (share, inner_path) = resolve_smb_path(profile, path)?;
    let (client, share_path) = connect_smb_share(profile, share.as_str()).await?;
    let target_path = smb_unc_with_inner(&share_path, inner_path.as_str());

    let resource = client
        .create_file(
            &target_path,
            &FileCreateArgs::make_open_existing(
                FileAccessMask::new()
                    .with_file_read_data(true)
                    .with_file_read_attributes(true),
            ),
        )
        .await
        .with_context(|| format!("Falha ao abrir arquivo SMB {}", target_path))?;
    let file = resource.unwrap_file();

    let total = file.get_len().await.map_err(|error| anyhow!(error.to_string()))?;
    let mut offset = 0u64;
    let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];
    while offset < total {
        let read = file
            .read_at(&mut buffer, offset)
            .await
            .map_err(|error| anyhow!(error.to_string()))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .with_context(|| format!("Falha ao escrever destino de download SMB {}", path))?;
        offset = offset.saturating_add(read as u64);
        on_chunk(read as u64);
    }

    file.close().await.ok();
    client.close().await.ok();
    Ok(offset)
}

pub async fn smb_upload_from_reader<R, F>(
    profile: &ConnectionProfile,
    path: &str,
    reader: &mut R,
    chunk_size: usize,
    mut on_chunk: F,
) -> Result<u64>
where
    R: Read,
    F: FnMut(u64),
{
    let (share, inner_path) = resolve_smb_path(profile, path)?;
    let (client, share_path) = connect_smb_share(profile, share.as_str()).await?;
    let target_path = smb_unc_with_inner(&share_path, inner_path.as_str());

    let resource = client
        .create_file(
            &target_path,
            &FileCreateArgs::make_overwrite(
                FileAttributes::new().with_archive(true),
                CreateOptions::new(),
            ),
        )
        .await
        .with_context(|| format!("Falha ao abrir destino SMB {}", target_path))?;
    let file = resource.unwrap_file();

    let mut offset = 0u64;
    let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];
    loop {
        let size = reader
            .read(&mut buffer)
            .with_context(|| format!("Falha ao ler origem para upload SMB {}", path))?;
        if size == 0 {
            break;
        }

        file.write_at(&buffer[..size], offset)
            .await
            .map_err(|error| anyhow!(error.to_string()))?;
        offset = offset.saturating_add(size as u64);
        on_chunk(size as u64);
    }

    file.close().await.ok();
    client.close().await.ok();
    Ok(offset)
}

pub async fn smb_read(profile: &ConnectionProfile, path: &str, chunk_size: usize) -> Result<String> {
    let mut bytes = Vec::new();
    smb_download_to_writer(profile, path, &mut bytes, chunk_size, |_| {}).await?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

pub async fn smb_read_bytes(profile: &ConnectionProfile, path: &str, chunk_size: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    smb_download_to_writer(profile, path, &mut bytes, chunk_size, |_| {}).await?;
    Ok(bytes)
}

pub async fn smb_read_bytes_with_limit(
    profile: &ConnectionProfile,
    path: &str,
    chunk_size: usize,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>> {
    if let Some(size) = smb_file_size(profile, path).await? {
        if size > max_bytes {
            return Ok(None);
        }
    }

    let bytes = smb_read_bytes(profile, path, chunk_size).await?;
    if (bytes.len() as u64) > max_bytes {
        return Ok(None);
    }
    Ok(Some(bytes))
}

pub async fn smb_read_chunk(
    profile: &ConnectionProfile,
    path: &str,
    offset: u64,
    chunk_size: usize,
) -> Result<(Vec<u8>, u64, bool)> {
    let (share, inner_path) = resolve_smb_path(profile, path)?;
    let (client, share_path) = connect_smb_share(profile, share.as_str()).await?;
    let target_path = smb_unc_with_inner(&share_path, inner_path.as_str());

    let resource = client
        .create_file(
            &target_path,
            &FileCreateArgs::make_open_existing(
                FileAccessMask::new()
                    .with_file_read_data(true)
                    .with_file_read_attributes(true),
            ),
        )
        .await
        .with_context(|| format!("Falha ao abrir arquivo SMB {}", target_path))?;
    let file = resource.unwrap_file();
    let total = file.get_len().await.map_err(|error| anyhow!(error.to_string()))?;
    let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];
    let read = file
        .read_at(&mut buffer, offset.min(total))
        .await
        .map_err(|error| anyhow!(error.to_string()))?;
    buffer.truncate(read);
    let bytes_read = offset.saturating_add(read as u64);
    let eof = read == 0 || bytes_read >= total;

    file.close().await.ok();
    client.close().await.ok();
    Ok((buffer, total, eof))
}

pub async fn smb_write(
    profile: &ConnectionProfile,
    path: &str,
    content: &str,
    chunk_size: usize,
) -> Result<()> {
    smb_write_bytes(profile, path, content.as_bytes(), chunk_size).await
}

pub async fn smb_write_bytes(
    profile: &ConnectionProfile,
    path: &str,
    content: &[u8],
    chunk_size: usize,
) -> Result<()> {
    let mut cursor = std::io::Cursor::new(content);
    smb_upload_from_reader(profile, path, &mut cursor, chunk_size, |_| {}).await?;
    Ok(())
}

pub async fn smb_file_size(profile: &ConnectionProfile, path: &str) -> Result<Option<u64>> {
    let (share, inner_path) = resolve_smb_path(profile, path)?;
    let (client, share_path) = connect_smb_share(profile, share.as_str()).await?;
    let target_path = smb_unc_with_inner(&share_path, inner_path.as_str());
    let resource = client
        .create_file(
            &target_path,
            &FileCreateArgs::make_open_existing(
                FileAccessMask::new().with_file_read_attributes(true),
            ),
        )
        .await;

    let size = if let Ok(resource) = resource {
        let file = resource.unwrap_file();
        let value = file.get_len().await.ok();
        file.close().await.ok();
        value
    } else {
        None
    };

    client.close().await.ok();
    Ok(size)
}

pub async fn smb_rename(profile: &ConnectionProfile, from_path: &str, to_path: &str) -> Result<()> {
    let (from_share, from_inner) = resolve_smb_path(profile, from_path)?;
    let (to_share, to_inner) = resolve_smb_path(profile, to_path)?;
    if from_share != to_share {
        return Err(anyhow!(
            "Renomeacao SMB entre compartilhamentos diferentes nao e suportada."
        ));
    }

    let (client, share_path) = connect_smb_share(profile, from_share.as_str()).await?;
    let from_unc = smb_unc_with_inner(&share_path, from_inner.as_str());
    let resource = client
        .create_file(
            &from_unc,
            &FileCreateArgs::make_open_existing(FileAccessMask::new().with_generic_all(true)),
        )
        .await
        .with_context(|| format!("Falha ao abrir item SMB para renomear {}", from_unc))?;

    let rename = FileRenameInformation {
        replace_if_exists: true.into(),
        root_directory: 0,
        file_name: SizedWideString::from(format!("\\{}", to_inner).as_str()),
    };

    match resource {
        Resource::File(file) => {
            file.set_info(rename)
                .await
                .map_err(|error| anyhow!(error.to_string()))?;
            file.close().await.ok();
        }
        Resource::Directory(dir) => {
            dir.set_info(rename)
                .await
                .map_err(|error| anyhow!(error.to_string()))?;
            dir.close().await.ok();
        }
        Resource::Pipe(_) => {
            client.close().await.ok();
            return Err(anyhow!("Renomeacao SMB em pipe nao e suportada."));
        }
    }

    client.close().await.ok();
    Ok(())
}

pub async fn smb_delete(profile: &ConnectionProfile, path: &str) -> Result<()> {
    let (share, inner_path) = resolve_smb_path(profile, path)?;
    let (client, share_path) = connect_smb_share(profile, share.as_str()).await?;
    let target_path = smb_unc_with_inner(&share_path, inner_path.as_str());

    let resource = client
        .create_file(
            &target_path,
            &FileCreateArgs::make_open_existing(FileAccessMask::new().with_generic_all(true)),
        )
        .await
        .with_context(|| format!("Falha ao abrir item SMB para remover {}", target_path))?;

    match resource {
        Resource::File(file) => {
            file.set_info(FileDispositionInformation::default())
                .await
                .map_err(|error| anyhow!(error.to_string()))?;
            file.close().await.ok();
        }
        Resource::Directory(dir) => {
            dir.set_info(FileDispositionInformation::default())
                .await
                .map_err(|error| anyhow!(error.to_string()))?;
            dir.close().await.ok();
        }
        Resource::Pipe(_) => {
            client.close().await.ok();
            return Err(anyhow!("Remocao SMB em pipe nao e suportada."));
        }
    }

    client.close().await.ok();
    Ok(())
}

pub async fn smb_mkdir(profile: &ConnectionProfile, path: &str) -> Result<()> {
    let (share, inner_path) = resolve_smb_path(profile, path)?;
    if inner_path.trim().is_empty() {
        return Err(anyhow!("Nome de pasta SMB invalido."));
    }

    let (client, share_path) = connect_smb_share(profile, share.as_str()).await?;
    let target_path = smb_unc_with_inner(&share_path, inner_path.as_str());

    let args = FileCreateArgs {
        options: CreateOptions::new().with_directory_file(true),
        attributes: FileAttributes::new().with_directory(true),
        ..FileCreateArgs::make_overwrite(Default::default(), Default::default())
    };

    let directory = client
        .create_file(&target_path, &args)
        .await
        .with_context(|| format!("Falha ao criar pasta SMB {}", target_path))?
        .unwrap_dir();

    directory.close().await.ok();
    client.close().await.ok();
    Ok(())
}

pub async fn smb_create_file(profile: &ConnectionProfile, path: &str) -> Result<()> {
    let (share, inner_path) = resolve_smb_path(profile, path)?;
    if inner_path.trim().is_empty() {
        return Err(anyhow!("Nome de arquivo SMB invalido."));
    }

    let (client, share_path) = connect_smb_share(profile, share.as_str()).await?;
    let target_path = smb_unc_with_inner(&share_path, inner_path.as_str());
    let file = client
        .create_file(
            &target_path,
            &FileCreateArgs::make_overwrite(
                FileAttributes::new().with_archive(true),
                CreateOptions::new(),
            ),
        )
        .await
        .with_context(|| format!("Falha ao criar arquivo SMB {}", target_path))?
        .unwrap_file();

    file.close().await.ok();
    client.close().await.ok();
    Ok(())
}
