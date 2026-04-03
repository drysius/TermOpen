#[cfg(windows)]
use std::collections::HashSet;
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex as StdMutex, OnceLock},
    time::UNIX_EPOCH,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use key_actions::{KeyActionsActiveTargetInput, KeyActionsService};
use models::{
    AppSettings, AuthServer, BinaryPreviewResult, ConnectionProfile, ConnectionProtocol,
    KeychainEntry, KnownHostEntry, RecoveryProbeResult, ReleaseCheckResult, SftpEntry,
    SshConnectResult, SshSessionInfo,
    SyncConflictDecision, SyncConflictPreview, SyncLoggedUser, SyncState, VaultStatus, WindowState,
};
use rdp::{
    RdpInputBatch, RdpSessionControlEvent, RdpSessionFocusInput, RdpSessionManager,
    RdpSessionOptions, RdpSessionStartResult,
};
use ssh::{known_hosts_add, known_hosts_ensure, known_hosts_list, known_hosts_remove, SshManager};
use sync::{handle_auth_callback_deeplink, request_sync_cancel, SyncManager};
use tauri::{Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tempfile::NamedTempFile;
use tokio::sync::Mutex;
use vault::VaultManager;

mod keyboard;
mod key_actions;
mod models;
mod mouse;
mod rdp;
mod remote_fs;
mod ssh;
mod sync;
#[cfg(test)]
mod tests;
mod vault;

struct AppState {
    vault: Mutex<VaultManager>,
    ssh: Mutex<SshManager>,
    rdp_sessions: Mutex<RdpSessionManager>,
    key_actions: KeyActionsService,
    sync: Mutex<SyncManager>,
    deeplink_queue: StdMutex<Vec<String>>,
}

const DEFAULT_SFTP_CHUNK_SIZE_KB: u32 = 1024;
const MIN_SFTP_CHUNK_SIZE_KB: u32 = 64;
const MAX_SFTP_CHUNK_SIZE_KB: u32 = 8192;
const DEFAULT_RDP_PORT: u16 = 3389;
const DEFAULT_RDP_WIDTH: u16 = 1280;
const DEFAULT_RDP_HEIGHT: u16 = 720;
const MIN_RDP_DIMENSION: u16 = 320;
const MAX_RDP_DIMENSION: u16 = 3840;
const DEFAULT_BINARY_PREVIEW_LIMIT_BYTES: u64 = 25 * 1024 * 1024;
const RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/MarcosBrendonDePaula/TermOpen/releases/latest";
const DEFAULT_WORKSPACE_WIDTH: f64 = 1440.0;
const DEFAULT_WORKSPACE_HEIGHT: f64 = 900.0;
const MIN_WORKSPACE_WIDTH: u32 = 350;
const MIN_WORKSPACE_HEIGHT: u32 = 600;
const LEGACY_COMPACT_WIDTH: u32 = 380;
const LEGACY_COMPACT_HEIGHT: u32 = 600;
const DEBUG_LOG_CAPACITY: usize = 2000;

#[derive(serde::Serialize)]
struct TextReadChunkPayload {
    chunk_base64: String,
    bytes_read: u64,
    total_bytes: u64,
    eof: bool,
}

#[derive(serde::Serialize)]
struct ClipboardLocalItemPayload {
    path: String,
    is_dir: bool,
}

#[derive(serde::Serialize)]
struct LocalPathStatPayload {
    is_dir: bool,
    size: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
struct SshKeyGenerateInput {
    algorithm: String,
    comment: Option<String>,
    passphrase: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct SshKeyGenerateResult {
    private_key: String,
    public_key: String,
    fingerprint: String,
    name_suggestion: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RemoteTransferEndpointInput {
    Local,
    SftpSession { session_id: String },
    Profile {
        profile_id: String,
        protocol: ConnectionProtocol,
    },
}

#[derive(Debug, Clone, serde::Serialize)]
struct DebugLogEntryPayload {
    id: u64,
    timestamp_ms: i64,
    level: String,
    source: String,
    message: String,
    context: Option<String>,
}

#[derive(Debug, Default)]
struct DebugLogState {
    enabled: bool,
    sequence: u64,
    entries: VecDeque<DebugLogEntryPayload>,
}

static DEBUG_LOGS: OnceLock<StdMutex<DebugLogState>> = OnceLock::new();

fn debug_log_state() -> &'static StdMutex<DebugLogState> {
    DEBUG_LOGS.get_or_init(|| StdMutex::new(DebugLogState::default()))
}

fn set_debug_logs_enabled(enabled: bool) {
    if let Ok(mut state) = debug_log_state().lock() {
        state.enabled = enabled;
    }
}

fn push_debug_log(
    level: impl Into<String>,
    source: impl Into<String>,
    message: impl Into<String>,
    context: Option<String>,
) {
    if let Ok(mut state) = debug_log_state().lock() {
        if !state.enabled {
            return;
        }

        state.sequence = state.sequence.wrapping_add(1);
        let id = state.sequence;
        state.entries.push_back(DebugLogEntryPayload {
            id,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            level: level.into(),
            source: source.into(),
            message: message.into(),
            context,
        });

        while state.entries.len() > DEBUG_LOG_CAPACITY {
            let _ = state.entries.pop_front();
        }
    }
}

fn normalize_debug_level(level: &str) -> &'static str {
    match level.trim().to_ascii_lowercase().as_str() {
        "error" => "error",
        "warn" | "warning" => "warn",
        "debug" => "debug",
        _ => "info",
    }
}

fn app_error(error: impl ToString) -> String {
    let message = error.to_string();
    push_debug_log(
        "error",
        "backend",
        "Falha no backend",
        Some(message.clone()),
    );
    message
}

fn normalize_optional_input(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn protocol_label(protocol: &ConnectionProtocol) -> &'static str {
    match protocol {
        ConnectionProtocol::Ssh => "SSH",
        ConnectionProtocol::Sftp => "SFTP",
        ConnectionProtocol::Ftp => "FTP",
        ConnectionProtocol::Ftps => "FTPS",
        ConnectionProtocol::Smb => "SMB",
        ConnectionProtocol::Rdp => "RDP",
    }
}

fn supports_profile_protocol(profile: &ConnectionProfile, protocol: &ConnectionProtocol) -> bool {
    let mut normalized = profile.clone();
    normalized.normalize_protocols();
    normalized.protocols.iter().any(|item| item == protocol)
}

fn ensure_file_protocol(protocol: &ConnectionProtocol) -> Result<(), String> {
    match protocol {
        ConnectionProtocol::Ftp | ConnectionProtocol::Ftps | ConnectionProtocol::Smb => Ok(()),
        _ => Err(format!(
            "Protocolo {} nao e suportado para sistema de arquivos remoto.",
            protocol_label(protocol)
        )),
    }
}

async fn resolve_profile_with_keychain(
    state: &State<'_, AppState>,
    profile_id: &str,
) -> Result<ConnectionProfile, String> {
    let vault = state.vault.lock().await;
    let mut profile = vault.profile_by_id(profile_id).map_err(app_error)?;

    if let Some(keychain_id) = profile.keychain_id.clone() {
        let key = vault.keychain_by_id(&keychain_id).map_err(app_error)?;
        if profile.private_key.is_none() {
            profile.private_key = key.private_key;
        }
        if profile.password.is_none() {
            profile.password = key.password.or(key.passphrase);
        }
    }

    Ok(profile)
}

async fn resolve_profile_for_file_protocol(
    state: &State<'_, AppState>,
    profile_id: &str,
    protocol: &ConnectionProtocol,
) -> Result<ConnectionProfile, String> {
    ensure_file_protocol(protocol)?;
    let profile = resolve_profile_with_keychain(state, profile_id).await?;
    if !supports_profile_protocol(&profile, protocol) {
        return Err(format!(
            "Perfil nao suporta o protocolo {} solicitado.",
            protocol_label(protocol)
        ));
    }
    Ok(profile)
}

fn split_domain_username(username: &str) -> (Option<String>, String) {
    let trimmed = username.trim();
    if let Some((domain, user)) = trimmed.split_once('\\') {
        let normalized_user = user.trim().to_string();
        if normalized_user.is_empty() {
            return (None, trimmed.to_string());
        }

        let normalized_domain = domain.trim().to_string();
        let domain_value = if normalized_domain.is_empty() {
            None
        } else {
            Some(normalized_domain)
        };

        return (domain_value, normalized_user);
    }

    (None, trimmed.to_string())
}

struct ResolvedRdpProfile {
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
}

async fn resolve_rdp_profile(
    state: &State<'_, AppState>,
    profile_id: String,
    password_override: Option<String>,
    keychain_id_override: Option<String>,
    save_auth_choice: Option<bool>,
) -> Result<ResolvedRdpProfile, RdpSessionStartResult> {
    let profile = {
        let mut vault = state.vault.lock().await;
        let mut profile = match vault.profile_by_id(&profile_id) {
            Ok(value) => value,
            Err(error) => {
                return Err(RdpSessionStartResult::Error {
                    message: app_error(error),
                });
            }
        };

        let selected_keychain = normalize_optional_input(keychain_id_override.clone())
            .or_else(|| profile.keychain_id.clone());

        if let Some(keychain_id) = selected_keychain.clone() {
            let key = match vault.keychain_by_id(&keychain_id) {
                Ok(value) => value,
                Err(error) => {
                    return Err(RdpSessionStartResult::Error {
                        message: app_error(error),
                    });
                }
            };
            if profile.password.is_none() {
                profile.password = key.password.or(key.passphrase);
            }
            profile.keychain_id = Some(keychain_id);
        }

        if let Some(password) = normalize_optional_input(password_override.clone()) {
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
            profile_to_save.keychain_id = normalize_optional_input(keychain_id_override.clone());
            let _ = vault.connection_save(profile_to_save);
        }

        profile
    };

    let host = profile.host.trim().to_string();
    if host.is_empty() {
        return Err(RdpSessionStartResult::Error {
            message: "Host RDP invalido.".to_string(),
        });
    }

    let (domain_from_user, username) = split_domain_username(profile.username.as_str());
    if username.trim().is_empty() {
        return Err(RdpSessionStartResult::AuthRequired {
            message: "Usuario RDP nao informado.".to_string(),
        });
    }

    let Some(password) = normalize_optional_input(profile.password.clone()) else {
        return Err(RdpSessionStartResult::AuthRequired {
            message: "Senha RDP necessaria para conectar.".to_string(),
        });
    };

    Ok(ResolvedRdpProfile {
        host,
        port: if profile.port == 0 {
            DEFAULT_RDP_PORT
        } else {
            profile.port
        },
        username,
        password,
        domain: domain_from_user,
    })
}

fn is_legacy_compact_window_state(snapshot: &WindowState) -> bool {
    snapshot.width == LEGACY_COMPACT_WIDTH && snapshot.height == LEGACY_COMPACT_HEIGHT
}

fn is_window_below_minimum(width: u32, height: u32) -> bool {
    width < MIN_WORKSPACE_WIDTH || height < MIN_WORKSPACE_HEIGHT
}

fn restore_window_to_default_size(window: &tauri::Window) {
    let _ = window.unmaximize();
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
        DEFAULT_WORKSPACE_WIDTH,
        DEFAULT_WORKSPACE_HEIGHT,
    )));
    let _ = window.center();
}

fn restore_webview_window_to_default_size(window: &tauri::WebviewWindow) {
    let _ = window.unmaximize();
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
        DEFAULT_WORKSPACE_WIDTH,
        DEFAULT_WORKSPACE_HEIGHT,
    )));
    let _ = window.center();
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

fn endpoint_is_local(endpoint: &RemoteTransferEndpointInput) -> bool {
    matches!(endpoint, RemoteTransferEndpointInput::Local)
}

async fn endpoint_file_size(
    state: &State<'_, AppState>,
    endpoint: &RemoteTransferEndpointInput,
    path: &str,
) -> Result<Option<u64>, String> {
    match endpoint {
        RemoteTransferEndpointInput::Local => {
            let source = resolve_local_path(Some(path))?;
            let metadata = fs::metadata(&source).map_err(|error| {
                format!(
                    "Falha ao obter metadata de arquivo local {}: {}",
                    source.display(),
                    error
                )
            })?;
            Ok(Some(metadata.len()))
        }
        RemoteTransferEndpointInput::SftpSession { session_id } => {
            let mut ssh = state.ssh.lock().await;
            ssh.sftp_file_size(session_id, path).map_err(app_error)
        }
        RemoteTransferEndpointInput::Profile {
            profile_id,
            protocol,
        } => {
            let profile = resolve_profile_for_file_protocol(state, profile_id, protocol).await?;
            match protocol {
                ConnectionProtocol::Ftp => remote_fs::ftp_file_size(&profile, path, false)
                    .map_err(app_error),
                ConnectionProtocol::Ftps => remote_fs::ftp_file_size(&profile, path, true)
                    .map_err(app_error),
                ConnectionProtocol::Smb => remote_fs::smb_file_size(&profile, path)
                    .await
                    .map_err(app_error),
                _ => Err(format!(
                    "Protocolo {} nao suportado para leitura remota.",
                    protocol_label(protocol)
                )),
            }
        }
    }
}

async fn endpoint_download_to_writer<W, F>(
    state: &State<'_, AppState>,
    endpoint: &RemoteTransferEndpointInput,
    path: &str,
    writer: &mut W,
    chunk_size: usize,
    mut on_chunk: F,
) -> Result<(), String>
where
    W: Write,
    F: FnMut(u64),
{
    match endpoint {
        RemoteTransferEndpointInput::Local => {
            let source = resolve_local_path(Some(path))?;
            let mut reader = fs::File::open(&source).map_err(|error| {
                format!(
                    "Falha ao abrir arquivo local {}: {}",
                    source.display(),
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
                on_chunk(size as u64);
            }
            Ok(())
        }
        RemoteTransferEndpointInput::SftpSession { session_id } => {
            let mut ssh = state.ssh.lock().await;
            ssh.sftp_download_to_writer(session_id, path, writer, chunk_size, |bytes| on_chunk(bytes))
                .map_err(app_error)
                .map(|_| ())
        }
        RemoteTransferEndpointInput::Profile {
            profile_id,
            protocol,
        } => {
            let profile = resolve_profile_for_file_protocol(state, profile_id, protocol).await?;
            match protocol {
                ConnectionProtocol::Ftp => remote_fs::ftp_download_to_writer(
                    &profile,
                    path,
                    writer,
                    chunk_size,
                    false,
                    |bytes| on_chunk(bytes),
                )
                .map_err(app_error)
                .map(|_| ()),
                ConnectionProtocol::Ftps => remote_fs::ftp_download_to_writer(
                    &profile,
                    path,
                    writer,
                    chunk_size,
                    true,
                    |bytes| on_chunk(bytes),
                )
                .map_err(app_error)
                .map(|_| ()),
                ConnectionProtocol::Smb => remote_fs::smb_download_to_writer(
                    &profile,
                    path,
                    writer,
                    chunk_size,
                    |bytes| on_chunk(bytes),
                )
                .await
                .map_err(app_error)
                .map(|_| ()),
                _ => Err(format!(
                    "Protocolo {} nao suportado para download remoto.",
                    protocol_label(protocol)
                )),
            }
        }
    }
}

async fn endpoint_upload_from_reader<R, F>(
    state: &State<'_, AppState>,
    endpoint: &RemoteTransferEndpointInput,
    path: &str,
    reader: &mut R,
    chunk_size: usize,
    mut on_chunk: F,
) -> Result<(), String>
where
    R: Read,
    F: FnMut(u64),
{
    match endpoint {
        RemoteTransferEndpointInput::Local => {
            let target = resolve_local_path(Some(path))?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(app_error)?;
            }
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
                on_chunk(size as u64);
            }
            Ok(())
        }
        RemoteTransferEndpointInput::SftpSession { session_id } => {
            let mut ssh = state.ssh.lock().await;
            ssh.sftp_upload_from_reader(session_id, path, reader, chunk_size, |bytes| on_chunk(bytes))
                .map_err(app_error)
                .map(|_| ())
        }
        RemoteTransferEndpointInput::Profile {
            profile_id,
            protocol,
        } => {
            let profile = resolve_profile_for_file_protocol(state, profile_id, protocol).await?;
            match protocol {
                ConnectionProtocol::Ftp => remote_fs::ftp_upload_from_reader(
                    &profile,
                    path,
                    reader,
                    chunk_size,
                    false,
                    |bytes| on_chunk(bytes),
                )
                .map_err(app_error)
                .map(|_| ()),
                ConnectionProtocol::Ftps => remote_fs::ftp_upload_from_reader(
                    &profile,
                    path,
                    reader,
                    chunk_size,
                    true,
                    |bytes| on_chunk(bytes),
                )
                .map_err(app_error)
                .map(|_| ()),
                ConnectionProtocol::Smb => remote_fs::smb_upload_from_reader(
                    &profile,
                    path,
                    reader,
                    chunk_size,
                    |bytes| on_chunk(bytes),
                )
                .await
                .map_err(app_error)
                .map(|_| ()),
                _ => Err(format!(
                    "Protocolo {} nao suportado para upload remoto.",
                    protocol_label(protocol)
                )),
            }
        }
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
async fn vault_delete_account(
    state: State<'_, AppState>,
    current_password: String,
    delete_cloud_data: bool,
) -> Result<VaultStatus, String> {
    {
        let vault = state.vault.lock().await;
        vault
            .verify_master_password(&current_password)
            .map_err(app_error)?;
    }

    if delete_cloud_data {
        let (server_address, fallbacks) = {
            let vault = state.vault.lock().await;
            resolve_server_addresses(&vault)?
        };
        let mut sync = state.sync.lock().await;
        sync.delete_remote_backup(&server_address, &fallbacks)
            .await
            .map_err(app_error)?;
    }

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
    let settings = vault.settings_get().map_err(app_error)?;
    set_debug_logs_enabled(settings.debug_logs_enabled);
    Ok(settings)
}

#[tauri::command]
async fn settings_update(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let mut vault = state.vault.lock().await;
    let saved = vault.settings_update(settings).map_err(app_error)?;
    set_debug_logs_enabled(saved.debug_logs_enabled);
    Ok(saved)
}

#[tauri::command]
fn debug_logs_list() -> Result<Vec<DebugLogEntryPayload>, String> {
    let state = debug_log_state()
        .lock()
        .map_err(|_| "Falha ao acessar logs de depuracao.".to_string())?;
    Ok(state.entries.iter().cloned().collect())
}

#[tauri::command]
fn debug_logs_clear() -> Result<(), String> {
    let mut state = debug_log_state()
        .lock()
        .map_err(|_| "Falha ao limpar logs de depuracao.".to_string())?;
    state.entries.clear();
    Ok(())
}

#[tauri::command]
fn debug_logs_set_enabled(enabled: bool) -> Result<(), String> {
    set_debug_logs_enabled(enabled);
    if enabled {
        push_debug_log("info", "backend", "Logs de depuracao habilitados", None);
    }
    Ok(())
}

#[tauri::command]
fn debug_log_frontend(
    level: String,
    source: Option<String>,
    message: String,
    context: Option<String>,
) -> Result<(), String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Ok(());
    }

    let source = source
        .and_then(|value| normalize_optional_input(Some(value)))
        .unwrap_or_else(|| "frontend".to_string());
    let context = context.and_then(|value| normalize_optional_input(Some(value)));

    push_debug_log(
        normalize_debug_level(level.as_str()),
        source,
        message,
        context,
    );
    Ok(())
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
async fn rdp_session_start(
    state: State<'_, AppState>,
    profile_id: String,
    width: Option<u16>,
    height: Option<u16>,
    password_override: Option<String>,
    keychain_id_override: Option<String>,
    save_auth_choice: Option<bool>,
    control_channel: tauri::ipc::Channel<RdpSessionControlEvent>,
    video_rects_channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    cursor_channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    audio_pcm_channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<RdpSessionStartResult, String> {
    let resolved = match resolve_rdp_profile(
        &state,
        profile_id,
        password_override,
        keychain_id_override,
        save_auth_choice,
    )
    .await
    {
        Ok(value) => value,
        Err(result) => return Ok(result),
    };

    let target_width = width
        .unwrap_or(DEFAULT_RDP_WIDTH)
        .clamp(MIN_RDP_DIMENSION, MAX_RDP_DIMENSION);
    let target_height = height
        .unwrap_or(DEFAULT_RDP_HEIGHT)
        .clamp(MIN_RDP_DIMENSION, MAX_RDP_DIMENSION);

    let options = RdpSessionOptions {
        host: resolved.host,
        port: resolved.port,
        username: resolved.username,
        password: resolved.password,
        domain: resolved.domain,
        width: target_width,
        height: target_height,
        timeout_seconds: 20,
    };

    let mut manager = state.rdp_sessions.lock().await;
    Ok(manager.start(
        options,
        control_channel,
        video_rects_channel,
        cursor_channel,
        audio_pcm_channel,
    ))
}

#[tauri::command]
async fn rdp_session_focus(
    state: State<'_, AppState>,
    session_id: String,
    focus: RdpSessionFocusInput,
) -> Result<(), String> {
    let mut manager = state.rdp_sessions.lock().await;
    manager.focus(session_id.as_str(), focus).map_err(app_error)
}

#[tauri::command]
async fn rdp_input_batch(
    state: State<'_, AppState>,
    session_id: String,
    batch: RdpInputBatch,
) -> Result<(), String> {
    let mut manager = state.rdp_sessions.lock().await;
    manager
        .input_batch(session_id.as_str(), batch)
        .map_err(app_error)
}

#[tauri::command]
async fn rdp_session_stop(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut manager = state.rdp_sessions.lock().await;
    manager.stop(session_id.as_str()).map_err(app_error)
}

#[tauri::command]
fn key_actions_set_active_workspace(
    state: State<'_, AppState>,
    target: Option<KeyActionsActiveTargetInput>,
) -> Result<(), String> {
    state.key_actions.set_active_target(target).map_err(app_error)?;
    Ok(())
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
async fn remote_profile_list(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => remote_fs::ftp_list(&profile, &path, false).map_err(app_error),
        ConnectionProtocol::Ftps => remote_fs::ftp_list(&profile, &path, true).map_err(app_error),
        ConnectionProtocol::Smb => remote_fs::smb_list(&profile, &path).await.map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para listagem remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
async fn remote_profile_read(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
) -> Result<String, String> {
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => remote_fs::ftp_read(&profile, &path, false).map_err(app_error),
        ConnectionProtocol::Ftps => remote_fs::ftp_read(&profile, &path, true).map_err(app_error),
        ConnectionProtocol::Smb => remote_fs::smb_read(&profile, &path, chunk_size)
            .await
            .map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para leitura remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
async fn remote_profile_read_chunk(
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
            remote_fs::ftp_read_chunk(&profile, &path, offset, chunk_size, false).map_err(app_error)?
        }
        ConnectionProtocol::Ftps => {
            remote_fs::ftp_read_chunk(&profile, &path, offset, chunk_size, true).map_err(app_error)?
        }
        ConnectionProtocol::Smb => remote_fs::smb_read_chunk(&profile, &path, offset, chunk_size)
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
async fn remote_profile_write(
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
            remote_fs::ftp_write(&profile, &path, &content, chunk_size, false).map_err(app_error)
        }
        ConnectionProtocol::Ftps => {
            remote_fs::ftp_write(&profile, &path, &content, chunk_size, true).map_err(app_error)
        }
        ConnectionProtocol::Smb => remote_fs::smb_write(&profile, &path, &content, chunk_size)
            .await
            .map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para escrita remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
async fn remote_profile_rename(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => {
            remote_fs::ftp_rename(&profile, &from_path, &to_path, false).map_err(app_error)
        }
        ConnectionProtocol::Ftps => {
            remote_fs::ftp_rename(&profile, &from_path, &to_path, true).map_err(app_error)
        }
        ConnectionProtocol::Smb => remote_fs::smb_rename(&profile, &from_path, &to_path)
            .await
            .map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para renomeacao remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
async fn remote_profile_delete(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => {
            remote_fs::ftp_delete(&profile, &path, is_dir, false).map_err(app_error)
        }
        ConnectionProtocol::Ftps => {
            remote_fs::ftp_delete(&profile, &path, is_dir, true).map_err(app_error)
        }
        ConnectionProtocol::Smb => remote_fs::smb_delete(&profile, &path).await.map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para remocao remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
async fn remote_profile_mkdir(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
) -> Result<(), String> {
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => remote_fs::ftp_mkdir(&profile, &path, false).map_err(app_error),
        ConnectionProtocol::Ftps => remote_fs::ftp_mkdir(&profile, &path, true).map_err(app_error),
        ConnectionProtocol::Smb => remote_fs::smb_mkdir(&profile, &path).await.map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para criacao de pasta remota.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
async fn remote_profile_create_file(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
) -> Result<(), String> {
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;
    match protocol {
        ConnectionProtocol::Ftp => {
            remote_fs::ftp_create_file(&profile, &path, false).map_err(app_error)
        }
        ConnectionProtocol::Ftps => {
            remote_fs::ftp_create_file(&profile, &path, true).map_err(app_error)
        }
        ConnectionProtocol::Smb => remote_fs::smb_create_file(&profile, &path)
            .await
            .map_err(app_error),
        _ => Err(format!(
            "Protocolo {} nao suportado para criacao de arquivo remoto.",
            protocol_label(&protocol)
        )),
    }
}

#[tauri::command]
async fn remote_profile_read_binary_preview(
    state: State<'_, AppState>,
    profile_id: String,
    protocol: ConnectionProtocol,
    path: String,
    max_bytes: Option<u64>,
) -> Result<BinaryPreviewResult, String> {
    let limit = resolve_preview_limit(max_bytes);
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;
    let profile = resolve_profile_for_file_protocol(&state, &profile_id, &protocol).await?;

    let remote_size = match protocol {
        ConnectionProtocol::Ftp => remote_fs::ftp_file_size(&profile, &path, false).map_err(app_error)?,
        ConnectionProtocol::Ftps => remote_fs::ftp_file_size(&profile, &path, true).map_err(app_error)?,
        ConnectionProtocol::Smb => remote_fs::smb_file_size(&profile, &path).await.map_err(app_error)?,
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
            remote_fs::ftp_read_bytes_with_limit(&profile, &path, limit, false).map_err(app_error)?
        }
        ConnectionProtocol::Ftps => {
            remote_fs::ftp_read_bytes_with_limit(&profile, &path, limit, true).map_err(app_error)?
        }
        ConnectionProtocol::Smb => remote_fs::smb_read_bytes_with_limit(&profile, &path, chunk_size, limit)
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

#[tauri::command]
async fn remote_transfer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    from_endpoint: RemoteTransferEndpointInput,
    from_path: String,
    to_endpoint: RemoteTransferEndpointInput,
    to_path: String,
) -> Result<(), String> {
    let progress_event = format!("transfer:progress:{}", transfer_id);
    let state_event = format!("transfer:state:{}", transfer_id);
    let _ = app.emit(&progress_event, 0u8);
    let _ = app.emit(&state_event, "queued");
    let chunk_size = resolve_sftp_chunk_size_bytes(&state).await?;

    let source_size = endpoint_file_size(&state, &from_endpoint, &from_path).await?;
    let progress_total = if !endpoint_is_local(&from_endpoint) && !endpoint_is_local(&to_endpoint) {
        source_size.map(|size| size.saturating_mul(2))
    } else {
        source_size
    };
    let mut transferred = 0u64;
    let _ = app.emit(&state_event, "running");

    match (&from_endpoint, &to_endpoint) {
        (
            RemoteTransferEndpointInput::SftpSession { session_id: from_session },
            RemoteTransferEndpointInput::SftpSession { session_id: to_session },
        ) => {
            let should_try_remote_copy = {
                let ssh = state.ssh.lock().await;
                from_session == to_session || ssh.sessions_share_profile(from_session, to_session)
            };

            if should_try_remote_copy {
                let remote_copy = {
                    let mut ssh = state.ssh.lock().await;
                    ssh.sftp_copy_between_sessions(from_session, to_session, &from_path, &to_path)
                };

                if remote_copy.is_ok() {
                    let _ = app.emit(&progress_event, 100u8);
                    let _ = app.emit(&state_event, "completed");
                    return Ok(());
                }
            }

            let mut temp_file = NamedTempFile::new().map_err(app_error)?;
            endpoint_download_to_writer(
                &state,
                &from_endpoint,
                &from_path,
                temp_file.as_file_mut(),
                chunk_size,
                |bytes| {
                    transferred = transferred.saturating_add(bytes);
                    emit_transfer_progress(&app, &progress_event, transferred, progress_total);
                },
            )
            .await?;

            let mut reader = temp_file.reopen().map_err(app_error)?;
            reader.seek(SeekFrom::Start(0)).map_err(app_error)?;
            endpoint_upload_from_reader(
                &state,
                &to_endpoint,
                &to_path,
                &mut reader,
                chunk_size,
                |bytes| {
                    transferred = transferred.saturating_add(bytes);
                    emit_transfer_progress(&app, &progress_event, transferred, progress_total);
                },
            )
            .await?;
        }
        _ if !endpoint_is_local(&from_endpoint) && !endpoint_is_local(&to_endpoint) => {
            let mut temp_file = NamedTempFile::new().map_err(app_error)?;
            endpoint_download_to_writer(
                &state,
                &from_endpoint,
                &from_path,
                temp_file.as_file_mut(),
                chunk_size,
                |bytes| {
                    transferred = transferred.saturating_add(bytes);
                    emit_transfer_progress(&app, &progress_event, transferred, progress_total);
                },
            )
            .await?;

            let mut reader = temp_file.reopen().map_err(app_error)?;
            reader.seek(SeekFrom::Start(0)).map_err(app_error)?;
            endpoint_upload_from_reader(
                &state,
                &to_endpoint,
                &to_path,
                &mut reader,
                chunk_size,
                |bytes| {
                    transferred = transferred.saturating_add(bytes);
                    emit_transfer_progress(&app, &progress_event, transferred, progress_total);
                },
            )
            .await?;
        }
        _ => {
            let mut temp_file = NamedTempFile::new().map_err(app_error)?;
            endpoint_download_to_writer(
                &state,
                &from_endpoint,
                &from_path,
                temp_file.as_file_mut(),
                chunk_size,
                |bytes| {
                    transferred = transferred.saturating_add(bytes);
                    emit_transfer_progress(&app, &progress_event, transferred, progress_total);
                },
            )
            .await?;

            let mut reader = temp_file.reopen().map_err(app_error)?;
            reader.seek(SeekFrom::Start(0)).map_err(app_error)?;
            endpoint_upload_from_reader(
                &state,
                &to_endpoint,
                &to_path,
                &mut reader,
                chunk_size,
                |bytes| {
                    transferred = transferred.saturating_add(bytes);
                    emit_transfer_progress(&app, &progress_event, transferred, progress_total);
                },
            )
            .await?;
        }
    }

    let _ = app.emit(&progress_event, 100u8);
    let _ = app.emit(&state_event, "completed");
    Ok(())
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
    let state_event = format!("transfer:state:{}", transfer_id);
    let _ = app.emit(&progress_event, 0u8);
    let _ = app.emit(&state_event, "queued");
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
    let _ = app.emit(&state_event, "completed");
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
async fn local_stat(path: String) -> Result<LocalPathStatPayload, String> {
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

#[cfg(windows)]
fn clipboard_file_drop_paths_windows() -> Result<Vec<String>, String> {
    let script = "$ErrorActionPreference='SilentlyContinue'; $items = Get-Clipboard -Format FileDropList; if ($null -eq $items) { '[]' } else { @($items | ForEach-Object { $_.ToString() }) | ConvertTo-Json -Compress }";
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|error| {
            format!(
                "Falha ao consultar area de transferencia do Windows: {}",
                error
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        if detail.is_empty() {
            return Ok(Vec::new());
        }
        return Err(format!(
            "Falha ao ler arquivos copiados da area de transferencia: {}",
            detail
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json = stdout.trim();
    if json.is_empty() || json == "null" {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<String>>(json).map_err(|error| {
        format!(
            "Falha ao interpretar arquivos do clipboard do Windows: {}",
            error
        )
    })
}

#[tauri::command]
async fn clipboard_local_items() -> Result<Vec<ClipboardLocalItemPayload>, String> {
    #[cfg(windows)]
    {
        let raw_paths = clipboard_file_drop_paths_windows()?;
        if raw_paths.is_empty() {
            return Ok(Vec::new());
        }

        let mut visited = HashSet::new();
        let mut output = Vec::new();
        for raw_path in raw_paths {
            let trimmed = raw_path.trim();
            if trimmed.is_empty() {
                continue;
            }
            let canonical = trimmed.to_string();
            if !visited.insert(canonical.clone()) {
                continue;
            }

            let path = PathBuf::from(&canonical);
            let metadata = fs::metadata(&path).map_err(|error| {
                format!(
                    "Falha ao ler metadata do item copiado {}: {}",
                    path.display(),
                    error
                )
            })?;

            output.push(ClipboardLocalItemPayload {
                path: path.to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
            });
        }
        return Ok(output);
    }

    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
async fn auth_servers_list(state: State<'_, AppState>) -> Result<Vec<AuthServer>, String> {
    let vault = state.vault.lock().await;
    vault.auth_servers_list().map_err(app_error)
}

const AUTH_SERVERS_RAW_URL: &str =
    "https://raw.githubusercontent.com/urubucode/TermOpen/main/auth-servers.json";

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
async fn sync_logged_user(state: State<'_, AppState>) -> Result<Option<SyncLoggedUser>, String> {
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
async fn sync_startup_preview(state: State<'_, AppState>) -> Result<SyncConflictPreview, String> {
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
    sync.resolve_startup_conflicts(&app, &mut vault, &server_address, &fallbacks, decisions)
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
    sync.recovery_restore(&app, &mut vault, &server_address, &fallbacks, password)
        .await
        .map_err(app_error)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let target = url.trim();
    if target.is_empty() {
        return Err("URL externa vazia.".to_string());
    }

    let normalized = target.to_ascii_lowercase();
    if !(normalized.starts_with("https://") || normalized.starts_with("http://")) {
        return Err("Somente URLs HTTP/HTTPS sao permitidas.".to_string());
    }

    open::that_detached(target).map_err(app_error)
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

fn sanitize_key_name_fragment(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() {
            out.push('_');
        }
    }
    let compact = out.trim_matches('_').to_string();
    if compact.is_empty() {
        "generated".to_string()
    } else {
        compact
    }
}

fn parse_ssh_keygen_fingerprint(line: &str) -> String {
    let mut parts = line.split_whitespace();
    let _bits = parts.next();
    parts
        .next()
        .map(|value| value.to_string())
        .unwrap_or_else(|| line.trim().to_string())
}

#[tauri::command]
async fn ssh_key_generate(input: SshKeyGenerateInput) -> Result<SshKeyGenerateResult, String> {
    let algorithm = input.algorithm.trim().to_ascii_lowercase();
    let normalized_passphrase = normalize_optional_input(input.passphrase).unwrap_or_default();
    let normalized_comment = normalize_optional_input(input.comment)
        .unwrap_or_else(|| "connecthub-generated".to_string());

    let (key_type, bits, name_prefix) = match algorithm.as_str() {
        "ed25519" => ("ed25519", None, "id_ed25519"),
        "rsa4096" => ("rsa", Some("4096"), "id_rsa"),
        "rsa2048" => ("rsa", Some("2048"), "id_rsa"),
        "ecdsa521" => ("ecdsa", Some("521"), "id_ecdsa"),
        other => {
            return Err(format!(
                "Algoritmo de chave SSH nao suportado: {}. Use ed25519, rsa4096, rsa2048 ou ecdsa521.",
                other
            ));
        }
    };

    let base_name = format!(
        "{}_{}",
        name_prefix,
        sanitize_key_name_fragment(&normalized_comment)
    );

    let temp_dir = tempfile::tempdir().map_err(app_error)?;
    let key_path = temp_dir.path().join(&base_name);

    let mut generate = Command::new("ssh-keygen");
    generate
        .arg("-t")
        .arg(key_type)
        .arg("-N")
        .arg(&normalized_passphrase)
        .arg("-C")
        .arg(&normalized_comment)
        .arg("-f")
        .arg(&key_path)
        .arg("-q");
    if let Some(bits_value) = bits {
        generate.arg("-b").arg(bits_value);
    }

    let output = generate.output().map_err(|error| {
        app_error(format!(
            "Falha ao executar ssh-keygen. Verifique se OpenSSH esta instalado ({})",
            error
        ))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let reason = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "erro desconhecido".to_string()
        };
        return Err(app_error(format!("ssh-keygen retornou erro: {}", reason)));
    }

    let private_key = fs::read_to_string(&key_path).map_err(|error| {
        app_error(format!(
            "Falha ao ler chave privada gerada ({})",
            error
        ))
    })?;
    let public_key_path = PathBuf::from(format!("{}.pub", key_path.to_string_lossy()));
    let public_key = fs::read_to_string(&public_key_path).map_err(|error| {
        app_error(format!(
            "Falha ao ler chave publica gerada ({})",
            error
        ))
    })?;

    let fingerprint_output = Command::new("ssh-keygen")
        .arg("-lf")
        .arg(&public_key_path)
        .output()
        .map_err(|error| {
            app_error(format!(
                "Falha ao calcular fingerprint da chave gerada ({})",
                error
            ))
        })?;

    let fingerprint = if fingerprint_output.status.success() {
        parse_ssh_keygen_fingerprint(&String::from_utf8_lossy(&fingerprint_output.stdout))
    } else {
        "N/A".to_string()
    };

    Ok(SshKeyGenerateResult {
        private_key,
        public_key,
        fingerprint,
        name_suggestion: base_name,
    })
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
        restore_window_to_default_size(&window);
        return Ok(());
    };

    if is_legacy_compact_window_state(&snapshot) {
        restore_window_to_default_size(&window);
        return Ok(());
    }

    if is_window_below_minimum(snapshot.width, snapshot.height) {
        restore_window_to_default_size(&window);
        return Ok(());
    }

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

fn sanitize_deep_link_input(input: &str) -> String {
    input
        .trim()
        .trim_matches('"')
        .replace("termopen:://", "termopen://")
        .replace("openterm:://", "openterm://")
}

fn deep_link_scheme(payload: &str) -> Option<&str> {
    payload.split_once("://").map(|(scheme, _)| scheme)
}

fn is_supported_deep_link(payload: &str) -> bool {
    let Some(scheme) = deep_link_scheme(payload) else {
        return false;
    };
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "termopen" | "openterm" | "ssh" | "sftp" | "rdp"
    )
}

fn queue_deep_link(app: &tauri::AppHandle, payload: &str) {
    let state = app.state::<AppState>();
    if let Ok(mut queue) = state.deeplink_queue.lock() {
        if queue.len() >= 64 {
            let overflow = queue.len().saturating_sub(63);
            queue.drain(0..overflow);
        }
        queue.push(payload.to_string());
    }

    let _ = app.emit("app:deeplink", payload.to_string());
}

fn handle_deep_link_url(app: &tauri::AppHandle, input: &str) {
    let payload = sanitize_deep_link_input(input);
    if payload.is_empty() {
        focus_main_window(app);
        return;
    }

    if !is_supported_deep_link(&payload) {
        return;
    }

    match handle_auth_callback_deeplink(payload.as_str()) {
        Ok(true) => {}
        Ok(false) => {
            queue_deep_link(app, payload.as_str());
        }
        Err(error) => {
            eprintln!("Falha ao processar deep link {}: {}", payload, error);
            queue_deep_link(app, payload.as_str());
        }
    }

    focus_main_window(app);
}

#[tauri::command]
fn deeplink_take_pending(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let mut queue = state
        .deeplink_queue
        .lock()
        .map_err(|_| "Falha ao acessar fila de deeplinks.".to_string())?;
    Ok(queue.drain(..).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let vault = VaultManager::new().expect("failed to initialize vault manager");
    let mut builder = tauri::Builder::default().manage(AppState {
        vault: Mutex::new(vault),
        ssh: Mutex::new(SshManager::new()),
        rdp_sessions: Mutex::new(RdpSessionManager::default()),
        key_actions: KeyActionsService::new(),
        sync: Mutex::new(SyncManager::new()),
        deeplink_queue: StdMutex::new(Vec::new()),
    });

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for argument in argv {
                let payload = sanitize_deep_link_input(&argument);
                if is_supported_deep_link(&payload) {
                    handle_deep_link_url(app, payload.as_str());
                }
            }
        }));
    }

    builder
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state = app.state::<AppState>();
            state.key_actions.start(app_handle.clone());

            if let Some(window) = app.get_webview_window("main") {
                if let Ok(position) = window.inner_position().or_else(|_| window.outer_position()) {
                    state
                        .key_actions
                        .set_window_origin(position.x as f64, position.y as f64);
                }
                if let Ok(focused) = window.is_focused() {
                    state.key_actions.set_window_focused(focused);
                }

                let key_actions_app = app_handle.clone();
                let key_actions_window = window.clone();
                window.on_window_event(move |event| {
                    let shared = key_actions_app.state::<AppState>();
                    match event {
                        tauri::WindowEvent::Focused(focused) => {
                            shared.key_actions.set_window_focused(*focused);
                        }
                        tauri::WindowEvent::Moved(_) => {
                            if let Ok(position) = key_actions_window
                                .inner_position()
                                .or_else(|_| key_actions_window.outer_position())
                            {
                                shared
                                    .key_actions
                                    .set_window_origin(position.x as f64, position.y as f64);
                            }
                        }
                        tauri::WindowEvent::Resized(size) => {
                            if is_window_below_minimum(size.width, size.height) {
                                restore_webview_window_to_default_size(&key_actions_window);
                            }
                        }
                        _ => {}
                    }
                });
            }

            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    handle_deep_link_url(&app_handle, url.as_str());
                }
            }
            let listener_handle = app_handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link_url(&listener_handle, url.as_str());
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            deeplink_take_pending,
            vault_status,
            vault_init,
            vault_unlock,
            vault_lock,
            vault_reset_all,
            vault_delete_account,
            vault_change_master_password,
            connections_list,
            connection_save,
            connection_delete,
            keychain_list,
            keychain_save,
            keychain_delete,
            ssh_key_generate,
            settings_get,
            settings_update,
            debug_logs_list,
            debug_logs_clear,
            debug_logs_set_enabled,
            debug_log_frontend,
            ssh_connect,
            ssh_connect_ex,
            rdp_session_start,
            rdp_session_focus,
            rdp_input_batch,
            rdp_session_stop,
            key_actions_set_active_workspace,
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
            remote_profile_list,
            remote_profile_read,
            remote_profile_read_chunk,
            remote_profile_write,
            remote_profile_rename,
            remote_profile_delete,
            remote_profile_mkdir,
            remote_profile_create_file,
            remote_profile_read_binary_preview,
            sftp_transfer,
            remote_transfer,
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
            local_stat,
            clipboard_local_items,
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
            open_external_url,
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
