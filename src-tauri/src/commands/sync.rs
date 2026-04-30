use tauri::{Emitter, State};

use crate::libs::models::{RecoveryProbeResult, SyncConflictDecision, SyncConflictPreview, SyncLoggedUser, SyncState, VaultStatus};
use crate::{app_error, resolve_server_addresses, resolve_server_addresses_with_override, AppState};

#[tauri::command]
pub async fn sync_google_login(
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
pub async fn sync_logged_user(state: State<'_, AppState>) -> Result<Option<SyncLoggedUser>, String> {
    let sync = state.sync.lock().await;
    Ok(sync.logged_user())
}

#[tauri::command]
pub async fn sync_cancel(app: tauri::AppHandle) -> Result<SyncState, String> {
    let state = crate::libs::sync::request_sync_cancel();
    let _ = app.emit("sync:status", &state);
    Ok(state)
}

#[tauri::command]
pub async fn sync_push(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<SyncState, String> {
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
pub async fn sync_pull(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<SyncState, String> {
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
pub async fn sync_startup_preview(state: State<'_, AppState>) -> Result<SyncConflictPreview, String> {
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
pub async fn sync_startup_resolve(
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
pub async fn sync_recovery_probe(
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
pub async fn sync_recovery_restore(
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
