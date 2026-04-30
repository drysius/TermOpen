use std::{
    io::{Read, Write},
    sync::Arc,
    time::UNIX_EPOCH,
};

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use smb::binrw_util::prelude::SizedWideString;
use smb::{
    Client, ClientConfig, CreateOptions, DirAccessMask, Directory, FileAccessMask, FileAttributes,
    FileCreateArgs, FileDispositionInformation, FileIdBothDirectoryInformation,
    FileRenameInformation, GetLen, ReadAt, Resource, UncPath, WriteAt,
};

use crate::constants::SMB_DEFAULT_PORT;
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
        return Err(anyhow!(
            "Compartilhamento SMB nao informado no caminho remoto."
        ));
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
            &FileCreateArgs::make_open_existing(
                DirAccessMask::new().with_list_directory(true).into(),
            ),
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

    let total = file
        .get_len()
        .await
        .map_err(|error| anyhow!(error.to_string()))?;
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

pub async fn smb_read(
    profile: &ConnectionProfile,
    path: &str,
    chunk_size: usize,
) -> Result<String> {
    let mut bytes = Vec::new();
    smb_download_to_writer(profile, path, &mut bytes, chunk_size, |_| {}).await?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

pub async fn smb_read_bytes(
    profile: &ConnectionProfile,
    path: &str,
    chunk_size: usize,
) -> Result<Vec<u8>> {
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
    let total = file
        .get_len()
        .await
        .map_err(|error| anyhow!(error.to_string()))?;
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

pub async fn list(profile: &ConnectionProfile, path: &str) -> Result<Vec<SftpEntry>> {
    smb_list(profile, path).await
}

pub async fn read(profile: &ConnectionProfile, path: &str, chunk_size: usize) -> Result<String> {
    smb_read(profile, path, chunk_size).await
}

pub async fn read_chunk(
    profile: &ConnectionProfile,
    path: &str,
    offset: u64,
    chunk_size: usize,
) -> Result<(Vec<u8>, u64, bool)> {
    smb_read_chunk(profile, path, offset, chunk_size).await
}

pub async fn read_bytes_with_limit(
    profile: &ConnectionProfile,
    path: &str,
    chunk_size: usize,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>> {
    smb_read_bytes_with_limit(profile, path, chunk_size, max_bytes).await
}

pub async fn write(
    profile: &ConnectionProfile,
    path: &str,
    content: &str,
    chunk_size: usize,
) -> Result<()> {
    smb_write(profile, path, content, chunk_size).await
}

pub async fn rename(profile: &ConnectionProfile, from_path: &str, to_path: &str) -> Result<()> {
    smb_rename(profile, from_path, to_path).await
}

pub async fn delete(profile: &ConnectionProfile, path: &str) -> Result<()> {
    smb_delete(profile, path).await
}

pub async fn mkdir(profile: &ConnectionProfile, path: &str) -> Result<()> {
    smb_mkdir(profile, path).await
}

pub async fn create_file(profile: &ConnectionProfile, path: &str) -> Result<()> {
    smb_create_file(profile, path).await
}

pub async fn file_size(profile: &ConnectionProfile, path: &str) -> Result<Option<u64>> {
    smb_file_size(profile, path).await
}

pub async fn download_to_writer<W, F>(
    profile: &ConnectionProfile,
    path: &str,
    writer: &mut W,
    chunk_size: usize,
    on_chunk: F,
) -> Result<u64>
where
    W: Write,
    F: FnMut(u64),
{
    smb_download_to_writer(profile, path, writer, chunk_size, on_chunk).await
}

pub async fn upload_from_reader<R, F>(
    profile: &ConnectionProfile,
    path: &str,
    reader: &mut R,
    chunk_size: usize,
    on_chunk: F,
) -> Result<u64>
where
    R: Read,
    F: FnMut(u64),
{
    smb_upload_from_reader(profile, path, reader, chunk_size, on_chunk).await
}
