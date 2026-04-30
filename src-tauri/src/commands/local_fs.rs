use crate::libs::models::{BinaryPreviewResult, LocalPathStatPayload, SftpEntry, TextReadChunkPayload};
use crate::{app_error, resolve_local_path, BASE64};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

#[tauri::command]
pub async fn local_list(path: Option<String>) -> Result<Vec<SftpEntry>, String> {
    let target = resolve_local_path(path.as_deref())?;
    let read_dir = fs::read_dir(&target).map_err(|error| {
        format!(
            "Falha ao listar diretorio local {}: {}",
            target.display(),
            error
        )
    })?;

    let mut entries = Vec::new();
    for item in read_dir {
        let item = item.map_err(app_error)?;
        let metadata = item.metadata().map_err(app_error)?;
        let item_path = item.path();
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);
        entries.push(SftpEntry {
            name: item.file_name().to_string_lossy().to_string(),
            path: item_path.to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            permissions: None,
            modified_at,
        });
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[tauri::command]
pub async fn local_read(path: String) -> Result<String, String> {
    let target = resolve_local_path(Some(&path))?;
    fs::read_to_string(&target)
        .map_err(|error| format!("Falha ao ler arquivo local {}: {}", target.display(), error))
}

#[tauri::command]
pub async fn local_read_chunk(path: String, offset: u64) -> Result<TextReadChunkPayload, String> {
    let target = resolve_local_path(Some(&path))?;
    let mut file = fs::File::open(&target).map_err(|error| {
        format!(
            "Falha ao abrir arquivo local {}: {}",
            target.display(),
            error
        )
    })?;
    let total = file.metadata().map_err(app_error)?.len();
    file.seek(SeekFrom::Start(offset)).map_err(app_error)?;

    let chunk_size = crate::chunk_size_from_kb(crate::constants::DEFAULT_SFTP_CHUNK_SIZE_KB);
    let mut buffer = vec![0u8; chunk_size];
    let size = file.read(&mut buffer).map_err(app_error)?;
    buffer.truncate(size);
    let bytes_read = offset.saturating_add(size as u64);
    let eof = size == 0 || bytes_read >= total;

    Ok(TextReadChunkPayload {
        chunk_base64: BASE64.encode(buffer),
        bytes_read,
        total_bytes: total,
        eof,
    })
}

#[tauri::command]
pub async fn local_write(path: String, content: String) -> Result<(), String> {
    let target = resolve_local_path(Some(&path))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(app_error)?;
    }
    fs::write(&target, content).map_err(|error| {
        format!(
            "Falha ao escrever arquivo local {}: {}",
            target.display(),
            error
        )
    })
}

#[tauri::command]
pub async fn local_rename(from_path: String, to_path: String) -> Result<(), String> {
    let from = resolve_local_path(Some(&from_path))?;
    let to = resolve_local_path(Some(&to_path))?;
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(app_error)?;
    }
    fs::rename(&from, &to).map_err(|error| {
        format!(
            "Falha ao renomear item local de {} para {}: {}",
            from.display(),
            to.display(),
            error
        )
    })
}

#[tauri::command]
pub async fn local_delete(path: String, is_dir: bool) -> Result<(), String> {
    let target = resolve_local_path(Some(&path))?;
    if is_dir {
        fs::remove_dir_all(&target).map_err(|error| {
            format!(
                "Falha ao remover pasta local {}: {}",
                target.display(),
                error
            )
        })
    } else {
        fs::remove_file(&target).map_err(|error| {
            format!(
                "Falha ao remover arquivo local {}: {}",
                target.display(),
                error
            )
        })
    }
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<(), String> {
    let target = resolve_local_path(Some(&path))?;
    fs::create_dir_all(&target)
        .map_err(|error| format!("Falha ao criar pasta local {}: {}", target.display(), error))
}

#[tauri::command]
pub async fn local_create_file(path: String) -> Result<(), String> {
    let target = resolve_local_path(Some(&path))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(app_error)?;
    }
    fs::File::create(&target)
        .map_err(|error| {
            format!(
                "Falha ao criar arquivo local {}: {}",
                target.display(),
                error
            )
        })
        .map(|_| ())
}

#[tauri::command]
pub async fn local_read_binary_preview(
    path: String,
    max_bytes: Option<u64>,
) -> Result<BinaryPreviewResult, String> {
    let limit = crate::resolve_preview_limit(max_bytes);
    let target = resolve_local_path(Some(&path))?;
    let metadata = fs::metadata(&target).map_err(|error| {
        format!(
            "Falha ao obter metadata de arquivo local {}: {}",
            target.display(),
            error
        )
    })?;
    let size = metadata.len();
    if size > limit {
        return Ok(BinaryPreviewResult::TooLarge { size, limit });
    }

    let bytes = fs::read(&target)
        .map_err(|error| format!("Falha ao ler arquivo local {}: {}", target.display(), error))?;

    Ok(BinaryPreviewResult::Ready {
        base64: BASE64.encode(bytes),
        size,
    })
}

#[tauri::command]
pub async fn local_stat(path: String) -> Result<LocalPathStatPayload, String> {
    let target = resolve_local_path(Some(&path))?;
    let metadata = fs::metadata(&target).map_err(|error| {
        format!(
            "Falha ao obter metadata do caminho local {}: {}",
            target.display(),
            error
        )
    })?;

    Ok(LocalPathStatPayload {
        is_dir: metadata.is_dir(),
        size: metadata.len(),
    })
}
