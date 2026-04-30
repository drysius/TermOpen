use tauri::{Emitter, State};

use crate::libs::models::{BinaryPreviewResult, SftpEntry, TextReadChunkPayload};
use crate::protocols::ssh::SshManager;
use crate::{app_error, chunk_size_from_kb, resolve_sftp_chunk_size_bytes, AppState, BASE64};
use std::io::{Read, Seek, SeekFrom, Write};
use tempfile::NamedTempFile;

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_list(&session_id, &path).await.map_err(app_error)
}

#[tauri::command]
pub async fn sftp_read(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_read(&session_id, &path, chunk_size)
        .await
        .map_err(app_error)
}

#[tauri::command]
pub async fn sftp_read_chunk(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    offset: u64,
) -> Result<TextReadChunkPayload, String> {
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let mut ssh = state.ssh.lock().await;
    let (chunk, total, eof) = ssh
        .sftp_read_chunk(&session_id, &path, offset, chunk_size)
        .await
        .map_err(app_error)?;
    let bytes_read = offset.saturating_add(chunk.len() as u64);
    Ok(TextReadChunkPayload {
        chunk_base64: BASE64.encode(chunk),
        bytes_read,
        total_bytes: total,
        eof,
    })
}

#[tauri::command]
pub async fn sftp_write(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_write(&session_id, &path, &content, chunk_size)
        .await
        .map_err(app_error)
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_rename(&session_id, &from_path, &to_path)
        .await
        .map_err(app_error)
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_delete(&session_id, &path, is_dir)
        .await
        .map_err(app_error)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_mkdir(&session_id, &path).await.map_err(app_error)
}

#[tauri::command]
pub async fn sftp_create_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_create_file(&session_id, &path)
        .await
        .map_err(app_error)
}

#[tauri::command]
pub async fn sftp_read_binary_preview(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<BinaryPreviewResult, String> {
    let limit = crate::resolve_preview_limit(max_bytes);
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;

    let mut ssh = state.ssh.lock().await;
    let remote_size = ssh
        .sftp_file_size(&session_id, &path)
        .await
        .map_err(app_error)?;
    if let Some(size) = remote_size.filter(|size| *size > limit) {
        return Ok(BinaryPreviewResult::TooLarge { size, limit });
    }

    let content = ssh
        .sftp_read_bytes_with_limit(&session_id, &path, chunk_size, limit)
        .await
        .map_err(app_error)?;

    match content {
        Some(bytes) => {
            let size = bytes.len() as u64;
            Ok(BinaryPreviewResult::Ready {
                base64: BASE64.encode(bytes),
                size,
            })
        }
        None => Ok(BinaryPreviewResult::TooLarge {
            size: remote_size.unwrap_or(limit.saturating_add(1)),
            limit,
        }),
    }
}

#[tauri::command]
pub async fn sftp_transfer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    from_session_id: Option<String>,
    from_path: String,
    to_session_id: Option<String>,
    to_path: String,
) -> Result<(), String> {
    use crate::{emit_transfer_progress, resolve_local_path};
    use std::fs;
    
    let progress_event = format!("transfer:progress:{}", transfer_id);
    let state_event = format!("transfer:state:{}", transfer_id);
    let _ = app.emit(&progress_event, 0u8);
    let _ = app.emit(&state_event, "queued");
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;

    let source_size = if let Some(session_id) = from_session_id.as_ref() {
        let mut ssh = state.ssh.lock().await;
        ssh.sftp_file_size(session_id, &from_path)
            .await
            .map_err(app_error)?
    } else {
        let source = resolve_local_path(Some(&from_path))?;
        let metadata = fs::metadata(&source).map_err(|error| {
            format!(
                "Falha ao obter metadata de arquivo local {}: {}",
                source.display(),
                error
            )
        })?;
        Some(metadata.len())
    };

    let progress_total = if from_session_id.is_some() && to_session_id.is_some() {
        source_size.map(|size| size.saturating_mul(2))
    } else {
        source_size
    };
    let mut transferred = 0u64;
    let _ = app.emit(&state_event, "running");

    match (from_session_id.as_ref(), to_session_id.as_ref()) {
        (Some(from_session), Some(to_session)) => {
            let should_try_remote_copy = {
                let ssh = state.ssh.lock().await;
                from_session == to_session || ssh.sessions_share_profile(from_session, to_session)
            };

            if should_try_remote_copy {
                let remote_copy = {
                    let mut ssh = state.ssh.lock().await;
                    ssh.sftp_copy_between_sessions(from_session, to_session, &from_path, &to_path)
                        .await
                };

                if remote_copy.is_ok() {
                    let _ = app.emit(&progress_event, 100u8);
                    let _ = app.emit(&state_event, "completed");
                    return Ok(());
                }
            }

            let mut temp_file = NamedTempFile::new().map_err(app_error)?;
            {
                let mut ssh = state.ssh.lock().await;
                ssh.sftp_download_to_writer(
                    from_session,
                    &from_path,
                    temp_file.as_file_mut(),
                    chunk_size,
                    |bytes| {
                        transferred = transferred.saturating_add(bytes);
                        emit_transfer_progress(&app, &progress_event, transferred, progress_total);
                    },
                )
                .await
                .map_err(app_error)?;
            }

            let mut reader = temp_file.reopen().map_err(app_error)?;
            reader.seek(SeekFrom::Start(0)).map_err(app_error)?;
            let mut ssh = state.ssh.lock().await;
            ssh.sftp_upload_from_reader(to_session, &to_path, &mut reader, chunk_size, |bytes| {
                transferred = transferred.saturating_add(bytes);
                emit_transfer_progress(&app, &progress_event, transferred, progress_total);
            })
            .await
            .map_err(app_error)?;
        }
        (Some(from_session), None) => {
            let target = resolve_local_path(Some(&to_path))?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(app_error)?;
            }
            let mut file = fs::File::create(&target).map_err(|error| {
                format!(
                    "Falha ao criar arquivo local {}: {}",
                    target.display(),
                    error
                )
            })?;

            let mut ssh = state.ssh.lock().await;
            ssh.sftp_download_to_writer(from_session, &from_path, &mut file, chunk_size, |bytes| {
                transferred = transferred.saturating_add(bytes);
                emit_transfer_progress(&app, &progress_event, transferred, progress_total);
            })
            .await
            .map_err(app_error)?;
        }
        (None, Some(to_session)) => {
            let source = resolve_local_path(Some(&from_path))?;
            let mut file = fs::File::open(&source).map_err(|error| {
                format!(
                    "Falha ao abrir arquivo local {}: {}",
                    source.display(),
                    error
                )
            })?;

            let mut ssh = state.ssh.lock().await;
            ssh.sftp_upload_from_reader(to_session, &to_path, &mut file, chunk_size, |bytes| {
                transferred = transferred.saturating_add(bytes);
                emit_transfer_progress(&app, &progress_event, transferred, progress_total);
            })
            .await
            .map_err(app_error)?;
        }
        (None, None) => {
            let source = resolve_local_path(Some(&from_path))?;
            let target = resolve_local_path(Some(&to_path))?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(app_error)?;
            }

            let mut reader = fs::File::open(&source).map_err(|error| {
                format!(
                    "Falha ao abrir arquivo local {}: {}",
                    source.display(),
                    error
                )
            })?;
            let mut writer = fs::File::create(&target).map_err(|error| {
                format!(
                    "Falha ao criar arquivo local {}: {}",
                    target.display(),
                    error
                )
            })?;

            let mut buffer = vec![0u8; chunk_size];
            loop {
                let size = reader.read(&mut buffer).map_err(app_error)?;
                if size == 0 {
                    break;
                }
                writer.write_all(&buffer[..size]).map_err(app_error)?;
                transferred = transferred.saturating_add(size as u64);
                emit_transfer_progress(&app, &progress_event, transferred, progress_total);
            }
        }
    }

    let _ = app.emit(&progress_event, 100u8);
    let _ = app.emit(&state_event, "completed");
    Ok(())
}
