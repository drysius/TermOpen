use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    time::UNIX_EPOCH,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use models::{
    AppSettings, AuthServer, BinaryPreviewResult, ConnectionProfile, KeychainEntry, KnownHostEntry,
    RecoveryProbeResult, ReleaseCheckResult, SftpEntry, SshConnectResult, SshSessionInfo,
    SyncConflictDecision, SyncConflictPreview, SyncState, VaultStatus, WindowState,
};
use ssh::{known_hosts_add, known_hosts_ensure, known_hosts_list, known_hosts_remove, SshManager};
use sync::{handle_auth_callback_deeplink, request_sync_cancel, SyncManager};
use tauri::{Emitter, Manager, State};
use tempfile::NamedTempFile;
use tokio::sync::Mutex;
use vault::VaultManager;

mod deeplink;
mod models;
mod ssh;
mod sync;
mod vault;
#[cfg(test)]
mod tests;

struct AppState {
    vault: Mutex<VaultManager>,
    ssh: Mutex<SshManager>,
    sync: Mutex<SyncManager>,
}

const DEFAULT_SFTP_CHUNK_SIZE_KB: u32 = 1024;
const MIN_SFTP_CHUNK_SIZE_KB: u32 = 64;
const MAX_SFTP_CHUNK_SIZE_KB: u32 = 8192;
const DEFAULT_BINARY_PREVIEW_LIMIT_BYTES: u64 = 25 * 1024 * 1024;
const RELEASES_LATEST_URL: &str = "https://api.github.com/repos/MarcosBrendonDePaula/TermOpen/releases/latest";
const DEFAULT_WORKSPACE_WIDTH: f64 = 1440.0;
const DEFAULT_WORKSPACE_HEIGHT: f64 = 900.0;

#[derive(serde::Serialize)]
struct TextReadChunkPayload {
    chunk_base64: String,
    bytes_read: u64,
    total_bytes: u64,
    eof: bool,
}

fn app_error(error: impl ToString) -> String {
    error.to_string()
}

fn chunk_size_from_kb(kb: u32) -> usize {
    let effective = if kb == 0 {
        DEFAULT_SFTP_CHUNK_SIZE_KB
    } else {
        kb
    };
    let clamped = effective.clamp(MIN_SFTP_CHUNK_SIZE_KB, MAX_SFTP_CHUNK_SIZE_KB);
    (clamped as usize).saturating_mul(1024)
}

async fn resolve_sftp_chunk_size_bytes(state: &State<'_, AppState>) -> Result<usize, String> {
    let settings = {
        let vault = state.vault.lock().await;
        vault.settings_get().map_err(app_error)?
    };
    Ok(chunk_size_from_kb(settings.sftp_chunk_size_kb))
}

fn resolve_preview_limit(max_bytes: Option<u64>) -> u64 {
    max_bytes
        .unwrap_or(DEFAULT_BINARY_PREVIEW_LIMIT_BYTES)
        .min(DEFAULT_BINARY_PREVIEW_LIMIT_BYTES)
}

fn emit_transfer_progress(
    app: &tauri::AppHandle,
    progress_event: &str,
    transferred: u64,
    total: Option<u64>,
) {
    if let Some(total_bytes) = total.filter(|value| *value > 0) {
        let percent = ((transferred.saturating_mul(100)) / total_bytes).min(100) as u8;
        let _ = app.emit(progress_event, percent);
    }
}

#[tauri::command]
async fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    let vault = state.vault.lock().await;
    vault.status().map_err(app_error)
}

#[tauri::command]
async fn vault_init(
    state: State<'_, AppState>,
    password: Option<String>,
) -> Result<VaultStatus, String> {
    let mut vault = state.vault.lock().await;
    vault.init(password).map_err(app_error)
}

#[tauri::command]
async fn vault_unlock(
    state: State<'_, AppState>,
    password: Option<String>,
) -> Result<VaultStatus, String> {
    let mut vault = state.vault.lock().await;
    vault.unlock(password).map_err(app_error)
}

#[tauri::command]
async fn vault_lock(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    let mut vault = state.vault.lock().await;
    Ok(vault.lock())
}

#[tauri::command]
async fn vault_reset_all(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    let status = {
        let mut vault = state.vault.lock().await;
        vault.reset_all().map_err(app_error)?
    };
    {
        let sync = state.sync.lock().await;
        sync.clear_local_auth();
    }
    Ok(status)
}

#[tauri::command]
async fn vault_change_master_password(
    state: State<'_, AppState>,
    old_password: Option<String>,
    new_password: String,
) -> Result<VaultStatus, String> {
    let mut vault = state.vault.lock().await;
    vault
        .change_master_password(old_password, new_password)
        .map_err(app_error)
}

#[tauri::command]
async fn connections_list(state: State<'_, AppState>) -> Result<Vec<ConnectionProfile>, String> {
    let vault = state.vault.lock().await;
    vault.connections_list().map_err(app_error)
}

#[tauri::command]
async fn connection_save(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    let mut vault = state.vault.lock().await;
    vault.connection_save(profile).map_err(app_error)
}

#[tauri::command]
async fn connection_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut vault = state.vault.lock().await;
    vault.connection_delete(&id).map_err(app_error)
}

#[tauri::command]
async fn keychain_list(state: State<'_, AppState>) -> Result<Vec<KeychainEntry>, String> {
    let vault = state.vault.lock().await;
    vault.keychain_list().map_err(app_error)
}

#[tauri::command]
async fn keychain_save(
    state: State<'_, AppState>,
    entry: KeychainEntry,
) -> Result<KeychainEntry, String> {
    let mut vault = state.vault.lock().await;
    vault.keychain_save(entry).map_err(app_error)
}

#[tauri::command]
async fn keychain_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut vault = state.vault.lock().await;
    vault.keychain_delete(&id).map_err(app_error)
}

#[tauri::command]
async fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let vault = state.vault.lock().await;
    vault.settings_get().map_err(app_error)
}

#[tauri::command]
async fn settings_update(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let mut vault = state.vault.lock().await;
    vault.settings_update(settings).map_err(app_error)
}

#[tauri::command]
async fn ssh_connect(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<SshSessionInfo, String> {
    let (profile, known_hosts_path) = {
        let vault = state.vault.lock().await;
        let mut profile = vault.profile_by_id(&profile_id).map_err(app_error)?;
        if let Some(keychain_id) = profile.keychain_id.clone() {
            let key = vault.keychain_by_id(&keychain_id).map_err(app_error)?;
            if profile.private_key.is_none() {
                profile.private_key = key.private_key;
            }
            if profile.password.is_none() {
                profile.password = key.password.or(key.passphrase);
            }
        }
        let settings = vault.settings_get().map_err(app_error)?;
        (profile, settings.known_hosts_path)
    };

    let mut ssh = state.ssh.lock().await;
    ssh.connect(&profile, Some(Path::new(&known_hosts_path)))
        .map_err(app_error)
}

#[tauri::command]
async fn ssh_connect_ex(
    state: State<'_, AppState>,
    profile_id: String,
    accept_unknown_host: Option<bool>,
    password_override: Option<String>,
    keychain_id_override: Option<String>,
    save_auth_choice: Option<bool>,
) -> Result<SshConnectResult, String> {
    let (profile, known_hosts_path) = {
        let mut vault = state.vault.lock().await;
        let mut profile = vault.profile_by_id(&profile_id).map_err(app_error)?;

        let selected_keychain = keychain_id_override
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| profile.keychain_id.clone());

        if let Some(keychain_id) = selected_keychain.clone() {
            let key = vault.keychain_by_id(&keychain_id).map_err(app_error)?;
            if profile.private_key.is_none() {
                profile.private_key = key.private_key;
            }
            if profile.password.is_none() {
                profile.password = key.password.or(key.passphrase);
            }
            profile.keychain_id = Some(keychain_id);
        }

        if let Some(password) = password_override
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            profile.password = Some(password.clone());
            if save_auth_choice.unwrap_or(false) {
                let mut profile_to_save = profile.clone();
                profile_to_save.password = Some(password);
                let _ = vault.connection_save(profile_to_save);
            }
        }

        if save_auth_choice.unwrap_or(false)
            && keychain_id_override
                .as_ref()
                .is_some_and(|value| !value.trim().is_empty())
        {
            let mut profile_to_save = profile.clone();
            profile_to_save.keychain_id = keychain_id_override
                .as_ref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let _ = vault.connection_save(profile_to_save);
        }

        let settings = vault.settings_get().map_err(app_error)?;
        (profile, settings.known_hosts_path)
    };

    let mut ssh = state.ssh.lock().await;
    ssh.connect_ex(
        &profile,
        Some(Path::new(&known_hosts_path)),
        accept_unknown_host.unwrap_or(false),
    )
    .map_err(app_error)
}

#[tauri::command]
async fn known_hosts_list_cmd(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<Vec<KnownHostEntry>, String> {
    let path_value = if let Some(value) = path {
        value
    } else {
        let vault = state.vault.lock().await;
        vault.settings_get().map_err(app_error)?.known_hosts_path
    };

    known_hosts_list(Some(path_value.as_str())).map_err(app_error)
}

#[tauri::command]
async fn known_hosts_add_cmd(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    key_type: String,
    key_base64: String,
    path: Option<String>,
) -> Result<KnownHostEntry, String> {
    let path_value = if let Some(value) = path {
        value
    } else {
        let vault = state.vault.lock().await;
        vault.settings_get().map_err(app_error)?.known_hosts_path
    };

    known_hosts_add(
        Some(path_value.as_str()),
        host.as_str(),
        port,
        key_type.as_str(),
        key_base64.as_str(),
    )
    .map_err(app_error)
}

#[tauri::command]
async fn known_hosts_remove_cmd(
    state: State<'_, AppState>,
    line_raw: String,
    path: Option<String>,
) -> Result<(), String> {
    let path_value = if let Some(value) = path {
        value
    } else {
        let vault = state.vault.lock().await;
        vault.settings_get().map_err(app_error)?.known_hosts_path
    };

    known_hosts_remove(Some(path_value.as_str()), line_raw.as_str()).map_err(app_error)
}

#[tauri::command]
async fn known_hosts_ensure_cmd(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<String, String> {
    let path_value = if let Some(value) = path {
        value
    } else {
        let vault = state.vault.lock().await;
        vault.settings_get().map_err(app_error)?.known_hosts_path
    };

    known_hosts_ensure(Some(path_value.as_str())).map_err(app_error)
}

#[tauri::command]
async fn ssh_write(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<String, String> {
    let output = {
        let mut ssh = state.ssh.lock().await;
        ssh.run_command(&session_id, &data).map_err(app_error)?
    };

    let event = format!("terminal:output:{}", session_id);
    let _ = app.emit(&event, output.clone());
    Ok(output)
}

#[tauri::command]
async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.resize_pty(&session_id, cols, rows).map_err(app_error)
}

#[tauri::command]
async fn ssh_disconnect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    {
        let mut ssh = state.ssh.lock().await;
        ssh.disconnect(&session_id);
    }

    let event = format!("terminal:exit:{}", session_id);
    let _ = app.emit(&event, "Disconnected".to_string());
    Ok(())
}

#[tauri::command]
async fn ssh_sessions(state: State<'_, AppState>) -> Result<Vec<SshSessionInfo>, String> {
    let ssh = state.ssh.lock().await;
    Ok(ssh.list_sessions())
}

#[tauri::command]
async fn local_terminal_connect(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<SshSessionInfo, String> {
    let start_path = resolve_local_path(path.as_deref())?;
    let mut ssh = state.ssh.lock().await;
    ssh.connect_local(Some(&start_path)).map_err(app_error)
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_list(&session_id, &path).map_err(app_error)
}

#[tauri::command]
async fn sftp_read(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_read(&session_id, &path, chunk_size)
        .map_err(app_error)
}

#[tauri::command]
async fn sftp_read_chunk(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    offset: u64,
) -> Result<TextReadChunkPayload, String> {
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let mut ssh = state.ssh.lock().await;
    let (chunk, total, eof) = ssh
        .sftp_read_chunk(&session_id, &path, offset, chunk_size)
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
async fn sftp_write(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_write(&session_id, &path, &content, chunk_size)
        .map_err(app_error)
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_rename(&session_id, &from_path, &to_path)
        .map_err(app_error)
}

#[tauri::command]
async fn sftp_delete(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_delete(&session_id, &path, is_dir)
        .map_err(app_error)
}

#[tauri::command]
async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_mkdir(&session_id, &path).map_err(app_error)
}

#[tauri::command]
async fn sftp_create_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_create_file(&session_id, &path).map_err(app_error)
}

#[tauri::command]
async fn sftp_transfer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    from_session_id: Option<String>,
    from_path: String,
    to_session_id: Option<String>,
    to_path: String,
) -> Result<(), String> {
    let progress_event = format!("transfer:progress:{}", transfer_id);
    let _ = app.emit(&progress_event, 0u8);
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;

    let source_size = if let Some(session_id) = from_session_id.as_ref() {
        let mut ssh = state.ssh.lock().await;
        ssh.sftp_file_size(session_id, &from_path)
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

    match (from_session_id.as_ref(), to_session_id.as_ref()) {
        (Some(from_session), Some(to_session)) => {
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
                .map_err(app_error)?;
            }

            let mut reader = temp_file.reopen().map_err(app_error)?;
            reader.seek(SeekFrom::Start(0)).map_err(app_error)?;
            let mut ssh = state.ssh.lock().await;
            ssh.sftp_upload_from_reader(to_session, &to_path, &mut reader, chunk_size, |bytes| {
                transferred = transferred.saturating_add(bytes);
                emit_transfer_progress(&app, &progress_event, transferred, progress_total);
            })
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
    Ok(())
}

#[tauri::command]
async fn local_list(path: Option<String>) -> Result<Vec<SftpEntry>, String> {
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
async fn local_read(path: String) -> Result<String, String> {
    let target = resolve_local_path(Some(&path))?;
    fs::read_to_string(&target)
        .map_err(|error| format!("Falha ao ler arquivo local {}: {}", target.display(), error))
}

#[tauri::command]
async fn local_read_chunk(path: String, offset: u64) -> Result<TextReadChunkPayload, String> {
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

    let mut buffer = vec![0u8; chunk_size_from_kb(DEFAULT_SFTP_CHUNK_SIZE_KB)];
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
async fn local_write(path: String, content: String) -> Result<(), String> {
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
async fn local_rename(from_path: String, to_path: String) -> Result<(), String> {
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
async fn local_delete(path: String, is_dir: bool) -> Result<(), String> {
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
async fn local_mkdir(path: String) -> Result<(), String> {
    let target = resolve_local_path(Some(&path))?;
    fs::create_dir_all(&target)
        .map_err(|error| format!("Falha ao criar pasta local {}: {}", target.display(), error))
}

#[tauri::command]
async fn local_create_file(path: String) -> Result<(), String> {
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
async fn sftp_read_binary_preview(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<BinaryPreviewResult, String> {
    let limit = resolve_preview_limit(max_bytes);
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;

    let mut ssh = state.ssh.lock().await;
    let remote_size = ssh.sftp_file_size(&session_id, &path).map_err(app_error)?;
    if let Some(size) = remote_size.filter(|size| *size > limit) {
        return Ok(BinaryPreviewResult::TooLarge { size, limit });
    }

    let content = ssh
        .sftp_read_bytes_with_limit(&session_id, &path, chunk_size, limit)
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
async fn local_read_binary_preview(
    path: String,
    max_bytes: Option<u64>,
) -> Result<BinaryPreviewResult, String> {
    let limit = resolve_preview_limit(max_bytes);
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
async fn auth_servers_list(state: State<'_, AppState>) -> Result<Vec<AuthServer>, String> {
    let vault = state.vault.lock().await;
    vault.auth_servers_list().map_err(app_error)
}

const AUTH_SERVERS_RAW_URL: &str =
    "https://raw.githubusercontent.com/drysius/TermOpen/main/auth-servers.json";

#[tauri::command]
async fn auth_server_save(
    state: State<'_, AppState>,
    server: AuthServer,
) -> Result<AuthServer, String> {
    let mut vault = state.vault.lock().await;
    vault.auth_server_save(server).map_err(app_error)
}

#[tauri::command]
async fn auth_server_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut vault = state.vault.lock().await;
    vault.auth_server_delete(&id).map_err(app_error)
}

const AUTH_SERVERS_LOCAL_FALLBACK: &str = include_str!("../../auth-servers.json");

#[tauri::command]
async fn auth_servers_fetch_remote(state: State<'_, AppState>) -> Result<Vec<AuthServer>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Sempre carregar local
    let local = load_local_servers();

    // Tentar buscar do GitHub
    let remote: Vec<AuthServer> = match client.get(AUTH_SERVERS_RAW_URL).send().await {
        Ok(response) if response.status().is_success() => response.json().await.unwrap_or_default(),
        _ => vec![],
    };

    // Merge: remote + local (remote tem prioridade, local complementa)
    let mut merged = remote;
    for server in local {
        if !merged.iter().any(|s| s.id == server.id) {
            merged.push(server);
        }
    }
    if !merged.iter().any(|server| server.id == "default") {
        merged.push(models::AuthServer::default_server());
    }
    merged.sort_by(|a, b| a.label.cmp(&b.label));

    let mut vault = state.vault.lock().await;
    if vault.merge_remote_servers(merged.clone()).is_ok() {
        if let Ok(list) = vault.auth_servers_list() {
            return Ok(list);
        }
    }

    Ok(merged)
}

fn load_local_servers() -> Vec<AuthServer> {
    serde_json::from_str(AUTH_SERVERS_LOCAL_FALLBACK)
        .unwrap_or_else(|_| vec![models::AuthServer::default_server()])
}

#[tauri::command]
async fn sync_google_login(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server_address: Option<String>,
) -> Result<SyncState, String> {
    let server_address = if let Some(address) = server_address
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        address
    } else {
        let vault = state.vault.lock().await;
        vault.selected_auth_server().map_err(app_error)?.address
    };
    let mut sync = state.sync.lock().await;
    sync.google_login(&app, &server_address)
        .await
        .map_err(app_error)
}

#[tauri::command]
async fn sync_logged_user(state: State<'_, AppState>) -> Result<Option<(String, String)>, String> {
    let sync = state.sync.lock().await;
    Ok(sync.logged_user())
}

#[tauri::command]
async fn sync_cancel(app: tauri::AppHandle) -> Result<SyncState, String> {
    let state = request_sync_cancel();
    let _ = app.emit("sync:status", &state);
    Ok(state)
}

fn resolve_server_addresses(vault: &vault::VaultManager) -> Result<(String, Vec<String>), String> {
    let primary = vault.selected_auth_server().map_err(app_error)?.address;
    let fallbacks: Vec<String> = vault
        .auth_servers_list()
        .map_err(app_error)?
        .into_iter()
        .filter(|s| s.address != primary)
        .map(|s| s.address)
        .collect();
    Ok((primary, fallbacks))
}

fn resolve_server_addresses_with_override(
    vault: &vault::VaultManager,
    override_address: Option<String>,
) -> Result<(String, Vec<String>), String> {
    if let Some(primary) = override_address
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let fallbacks: Vec<String> = vault
            .auth_servers_list()
            .map_err(app_error)?
            .into_iter()
            .map(|server| server.address)
            .filter(|address| address != &primary)
            .collect();
        return Ok((primary, fallbacks));
    }
    resolve_server_addresses(vault)
}

#[tauri::command]
async fn sync_push(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<SyncState, String> {
    let (server_address, fallbacks) = {
        let vault = state.vault.lock().await;
        resolve_server_addresses(&vault)?
    };
    let mut sync = state.sync.lock().await;
    let mut vault = state.vault.lock().await;
    sync.push(&app, &mut vault, &server_address, &fallbacks)
        .await
        .map_err(app_error)
}

#[tauri::command]
async fn sync_pull(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<SyncState, String> {
    let (server_address, fallbacks) = {
        let vault = state.vault.lock().await;
        resolve_server_addresses(&vault)?
    };
    let mut sync = state.sync.lock().await;
    let mut vault = state.vault.lock().await;
    sync.pull(&app, &mut vault, &server_address, &fallbacks)
        .await
        .map_err(app_error)
}

#[tauri::command]
async fn sync_startup_preview(
    state: State<'_, AppState>,
) -> Result<SyncConflictPreview, String> {
    let (server_address, fallbacks) = {
        let vault = state.vault.lock().await;
        resolve_server_addresses(&vault)?
    };

    let mut sync = state.sync.lock().await;
    let vault = state.vault.lock().await;
    sync.startup_conflicts(&vault, &server_address, &fallbacks)
        .await
        .map_err(app_error)
}

#[tauri::command]
async fn sync_startup_resolve(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    decisions: Vec<SyncConflictDecision>,
) -> Result<SyncState, String> {
    let (server_address, fallbacks) = {
        let vault = state.vault.lock().await;
        resolve_server_addresses(&vault)?
    };

    let mut sync = state.sync.lock().await;
    let mut vault = state.vault.lock().await;
    sync.resolve_startup_conflicts(
        &app,
        &mut vault,
        &server_address,
        &fallbacks,
        decisions,
    )
    .await
    .map_err(app_error)
}

#[tauri::command]
async fn sync_recovery_probe(
    state: State<'_, AppState>,
    server_address: Option<String>,
) -> Result<RecoveryProbeResult, String> {
    let (server_address, fallbacks) = {
        let vault = state.vault.lock().await;
        resolve_server_addresses_with_override(&vault, server_address)?
    };

    let mut sync = state.sync.lock().await;
    sync.recovery_probe(&server_address, &fallbacks)
        .await
        .map_err(app_error)
}

#[tauri::command]
async fn sync_recovery_restore(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server_address: Option<String>,
    password: String,
) -> Result<VaultStatus, String> {
    let (server_address, fallbacks) = {
        let vault = state.vault.lock().await;
        resolve_server_addresses_with_override(&vault, server_address)?
    };

    let mut sync = state.sync.lock().await;
    let mut vault = state.vault.lock().await;
    sync.recovery_restore(
        &app,
        &mut vault,
        &server_address,
        &fallbacks,
        password,
    )
    .await
    .map_err(app_error)
}

#[tauri::command]
async fn open_external_editor(
    filename: String,
    content: String,
    command: Option<String>,
) -> Result<(), String> {
    let safe_name = sanitize_filename(&filename);
    let dir = std::env::temp_dir().join("termopen-editor");
    fs::create_dir_all(&dir).map_err(app_error)?;

    let file_path = dir.join(safe_name);
    fs::write(&file_path, content).map_err(app_error)?;

    if let Some(template) = command
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        run_custom_editor_command(&template, &file_path)?;
        return Ok(());
    }

    if Command::new("code")
        .arg("--reuse-window")
        .arg(&file_path)
        .spawn()
        .is_ok()
    {
        return Ok(());
    }

    open::that_detached(&file_path).map_err(app_error)
}

#[tauri::command]
async fn window_state_save(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let position = window.outer_position().map_err(app_error)?;
    let size = window.outer_size().map_err(app_error)?;
    let maximized = window.is_maximized().map_err(app_error)?;

    let snapshot = WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    };

    let mut vault = state.vault.lock().await;
    let _ = vault.save_window_state(snapshot);
    Ok(())
}

#[tauri::command]
async fn window_state_restore(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let maybe_state = {
        let vault = state.vault.lock().await;
        vault.window_state().ok().flatten()
    };

    let Some(snapshot) = maybe_state else {
        let _ = window.unmaximize();
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            DEFAULT_WORKSPACE_WIDTH,
            DEFAULT_WORKSPACE_HEIGHT,
        )));
        let _ = window.center();
        return Ok(());
    };

    if !snapshot.maximized {
        let _ = window.unmaximize();
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            snapshot.width as f64,
            snapshot.height as f64,
        )));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            snapshot.x as f64,
            snapshot.y as f64,
        )));
    } else {
        let _ = window.maximize();
    }

    Ok(())
}

#[tauri::command]
async fn release_check_latest() -> Result<ReleaseCheckResult, String> {
    #[derive(serde::Deserialize)]
    struct GithubRelease {
        tag_name: String,
        html_url: String,
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let response = match client
        .get(RELEASES_LATEST_URL)
        .header("User-Agent", "TermOpen-Updater")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return Ok(ReleaseCheckResult {
                available: false,
                latest_version: None,
                url: None,
                message: format!("Falha ao verificar atualizacoes: {}", error),
            });
        }
    };

    if !response.status().is_success() {
        return Ok(ReleaseCheckResult {
            available: false,
            latest_version: None,
            url: None,
            message: format!("Falha ao verificar atualizacoes ({})", response.status()),
        });
    }

    let release: GithubRelease = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return Ok(ReleaseCheckResult {
                available: false,
                latest_version: None,
                url: None,
                message: format!("Resposta de release invalida: {}", error),
            });
        }
    };

    let current = env!("CARGO_PKG_VERSION");
    let latest = release.tag_name.trim_start_matches('v');
    let available = is_remote_version_newer(current, latest);

    Ok(ReleaseCheckResult {
        available,
        latest_version: Some(latest.to_string()),
        url: Some(release.html_url),
        message: if available {
            format!("Nova versao disponivel: {}", latest)
        } else {
            "Aplicativo atualizado.".to_string()
        },
    })
}

#[tauri::command]
fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(app_error)
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::Window) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(app_error)?;
    if maximized {
        window.unmaximize().map_err(app_error)?;
        Ok(false)
    } else {
        window.maximize().map_err(app_error)?;
        Ok(true)
    }
}

#[tauri::command]
fn window_is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(app_error)
}

#[tauri::command]
fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(app_error)
}

fn sanitize_filename(filename: &str) -> String {
    let candidate = PathBuf::from(filename);
    candidate
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "termopen-file.txt".to_string())
}

fn run_custom_editor_command(command_template: &str, file_path: &Path) -> Result<(), String> {
    let path_text = file_path.to_string_lossy();
    let rendered = if command_template.contains("{filename}") {
        command_template.replace("{filename}", &path_text)
    } else {
        format!("{} {}", command_template, path_text)
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut process = Command::new("cmd");
        process.arg("/C").arg(rendered);
        process
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut process = Command::new("sh");
        process.arg("-lc").arg(rendered);
        process
    };

    cmd.spawn().map(|_| ()).map_err(app_error)
}

fn resolve_local_path(input: Option<&str>) -> Result<PathBuf, String> {
    let raw = input.unwrap_or("").trim();
    if raw.is_empty() {
        if let Some(user_dirs) = directories::UserDirs::new() {
            return Ok(user_dirs.home_dir().to_path_buf());
        }
        return std::env::current_dir().map_err(app_error);
    }

    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        Ok(candidate.to_path_buf())
    } else {
        std::env::current_dir()
            .map_err(app_error)
            .map(|cwd| cwd.join(candidate))
    }
}

fn is_remote_version_newer(current: &str, latest: &str) -> bool {
    fn parse_parts(value: &str) -> Vec<u32> {
        value
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u32>().unwrap_or(0))
            .collect()
    }

    let mut current_parts = parse_parts(current);
    let mut latest_parts = parse_parts(latest);
    let max_len = current_parts.len().max(latest_parts.len());
    current_parts.resize(max_len, 0);
    latest_parts.resize(max_len, 0);

    latest_parts > current_parts
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn handle_deeplink_input(app: &tauri::AppHandle, input: &str) {
    let payload = input.trim().trim_matches('"');
    if payload.is_empty() {
        focus_main_window(app);
        return;
    }

    match handle_auth_callback_deeplink(payload) {
        Ok(true) => {}
        Ok(false) => {}
        Err(error) => {
            eprintln!("Falha ao processar deep link {}: {}", payload, error);
        }
    }

    focus_main_window(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if deeplink::prepare("com.drysius.termopen.deeplink") {
        return;
    }

    let vault = VaultManager::new().expect("failed to initialize vault manager");
    tauri::Builder::default()
        .manage(AppState {
            vault: Mutex::new(vault),
            ssh: Mutex::new(SshManager::new()),
            sync: Mutex::new(SyncManager::new()),
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let listener_handle = app_handle.clone();
            if let Err(error) = deeplink::register("termopen", move |payload| {
                handle_deeplink_input(&listener_handle, &payload);
            }) {
                eprintln!("Falha ao registrar protocolo termopen:// {}", error);
            }

            if let Some(initial_arg) = std::env::args().nth(1) {
                handle_deeplink_input(&app_handle, &initial_arg);
            }

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_init,
            vault_unlock,
            vault_lock,
            vault_reset_all,
            vault_change_master_password,
            connections_list,
            connection_save,
            connection_delete,
            keychain_list,
            keychain_save,
            keychain_delete,
            settings_get,
            settings_update,
            ssh_connect,
            ssh_connect_ex,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_sessions,
            local_terminal_connect,
            known_hosts_list_cmd,
            known_hosts_add_cmd,
            known_hosts_remove_cmd,
            known_hosts_ensure_cmd,
            sftp_list,
            sftp_read,
            sftp_read_chunk,
            sftp_write,
            sftp_rename,
            sftp_delete,
            sftp_mkdir,
            sftp_create_file,
            sftp_transfer,
            sftp_read_binary_preview,
            local_list,
            local_read,
            local_read_chunk,
            local_write,
            local_rename,
            local_delete,
            local_mkdir,
            local_create_file,
            local_read_binary_preview,
            auth_servers_list,
            auth_server_save,
            auth_server_delete,
            auth_servers_fetch_remote,
            sync_google_login,
            sync_logged_user,
            sync_cancel,
            sync_push,
            sync_pull,
            sync_startup_preview,
            sync_startup_resolve,
            sync_recovery_probe,
            sync_recovery_restore,
            release_check_latest,
            open_external_editor,
            window_state_save,
            window_state_restore,
            window_minimize,
            window_toggle_maximize,
            window_is_maximized,
            window_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
