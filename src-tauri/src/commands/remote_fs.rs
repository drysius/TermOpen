use tauri::State;

use crate::libs::models::{BinaryPreviewResult, ConnectionProtocol, SftpEntry, TextReadChunkPayload};
use crate::protocols::{ftp, smb};
use crate::{app_error, protocol_label, resolve_profile_for_file_protocol, resolve_sftp_chunk_size_bytes, AppState, BASE64};

#[tauri::command]
pub async fn remote_profile_list(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => ftp::list(&profile, &path, false).map_err(app_error),
        ConnectionProtocol::Ftps => ftp::list(&profile, &path, true).map_err(app_error),
        ConnectionProtocol::Smb => smb::list(&profile, &path).await.map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para listagem remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
pub async fn remote_profile_read(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
) -> Result<String, String> {
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => ftp::read(&profile, &path, false).map_err(app_error),
        ConnectionProtocol::Ftps => ftp::read(&profile, &path, true).map_err(app_error),
        ConnectionProtocol::Smb => smb::read(&profile, &path, chunk_size)
            .await
            .map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para leitura remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
pub async fn remote_profile_read_chunk(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
    offset: u64,
) -> Result<TextReadChunkPayload, String> {
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    let (chunk, total, eof) = match protocol {
        ConnectionProtocol::Ftp => {
            ftp::read_chunk(&profile, &path, offset, chunk_size, false).map_err(app_error)?
        }
        ConnectionProtocol::Ftps => {
            ftp::read_chunk(&profile, &path, offset, chunk_size, true).map_err(app_error)?
        }
        ConnectionProtocol::Smb => smb::read_chunk(&profile, &path, offset, chunk_size)
            .await
            .map_err(app_error)?,
        _ => {
            return Err(format!(
                "Protocolo {} nao suportado para leitura remota em blocos.",
                protocol_label(&protocol)
            ))
        }
    };
    let bytes_read = offset.saturating_add(chunk.len() as u64);
    Ok(TextReadChunkPayload {
        chunk_base64: BASE64.encode(chunk),
        bytes_read,
        total_bytes: total,
        eof,
    })
}

#[tauri::command]
pub async fn remote_profile_write(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
    content: String,
) -> Result<(), String> {
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => {
            ftp::write(&profile, &path, &content, chunk_size, false).map_err(app_error)
        }
        ConnectionProtocol::Ftps => {
            ftp::write(&profile, &path, &content, chunk_size, true).map_err(app_error)
        }
        ConnectionProtocol::Smb => smb::write(&profile, &path, &content, chunk_size)
            .await
            .map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para escrita remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
pub async fn remote_profile_rename(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => {
            ftp::rename(&profile, &from_path, &to_path, false).map_err(app_error)
        }
        ConnectionProtocol::Ftps => {
            ftp::rename(&profile, &from_path, &to_path, true).map_err(app_error)
        }
        ConnectionProtocol::Smb => smb::rename(&profile, &from_path, &to_path)
            .await
            .map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para renomeacao remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
pub async fn remote_profile_delete(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => ftp::delete(&profile, &path, is_dir, false).map_err(app_error),
        ConnectionProtocol::Ftps => ftp::delete(&profile, &path, is_dir, true).map_err(app_error),
        ConnectionProtocol::Smb => smb::delete(&profile, &path).await.map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para remocao remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
pub async fn remote_profile_mkdir(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
) -> Result<(), String> {
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => ftp::mkdir(&profile, &path, false).map_err(app_error),
        ConnectionProtocol::Ftps => ftp::mkdir(&profile, &path, true).map_err(app_error),
        ConnectionProtocol::Smb => smb::mkdir(&profile, &path).await.map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para criacao de pasta remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
pub async fn remote_profile_create_file(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
) -> Result<(), String> {
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => ftp::create_file(&profile, &path, false).map_err(app_error),
        ConnectionProtocol::Ftps => ftp::create_file(&profile, &path, true).map_err(app_error),
        ConnectionProtocol::Smb => smb::create_file(&profile, &path).await.map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para criacao de arquivo remoto.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
pub async fn remote_profile_read_binary_preview(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
    max_bytes: Option<u64>,
) -> Result<BinaryPreviewResult, String> {
    use crate::resolve_preview_limit;
    
    let limit = resolve_preview_limit(max_bytes);
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;

    let remote_size = match protocol {
        ConnectionProtocol::Ftp => ftp::file_size(&profile, &path, false).map_err(app_error)?,
        ConnectionProtocol::Ftps => ftp::file_size(&profile, &path, true).map_err(app_error)?,
        ConnectionProtocol::Smb => smb::file_size(&profile, &path).await.map_err(app_error)?,
        _ => {
            return Err(format!(
                "Protocolo {} nao suportado para preview remoto.",
                protocol_label(&protocol)
            ))
        }
    };

    if let Some(size) = remote_size.filter(|size| *size > limit) {
        return Ok(BinaryPreviewResult::TooLarge { size, limit });
    }

    let content = match protocol {
        ConnectionProtocol::Ftp => {
            ftp::read_bytes_with_limit(&profile, &path, limit, false).map_err(app_error)?
        }
        ConnectionProtocol::Ftps => {
            ftp::read_bytes_with_limit(&profile, &path, limit, true).map_err(app_error)?
        }
        ConnectionProtocol::Smb => smb::read_bytes_with_limit(&profile, &path, chunk_size, limit)
            .await
            .map_err(app_error)?,
        _ => None,
    };

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
