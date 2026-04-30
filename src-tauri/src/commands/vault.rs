use tauri::State;

use crate::libs::models::{ConnectionProfile, KeychainEntry, VaultStatus};
use crate::{app_error, resolve_server_addresses, AppState};

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    let vault = state.vault.lock().await;
    vault.status().map_err(app_error)
}

#[tauri::command]
pub async fn vault_init(
    state: State<'_, AppState>,
    password: Option<String>,
) -> Result<VaultStatus, String> {
    let mut vault = state.vault.lock().await;
    vault.init(password).map_err(app_error)
}

#[tauri::command]
pub async fn vault_unlock(
    state: State<'_, AppState>,
    password: Option<String>,
) -> Result<VaultStatus, String> {
    let mut vault = state.vault.lock().await;
    vault.unlock(password).map_err(app_error)
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    let mut vault = state.vault.lock().await;
    Ok(vault.lock())
}

#[tauri::command]
pub async fn vault_reset_all(state: State<'_, AppState>) -> Result<VaultStatus, String> {
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
pub async fn vault_delete_account(
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
pub async fn vault_change_master_password(
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
pub async fn connections_list(state: State<'_, AppState>) -> Result<Vec<ConnectionProfile>, String> {
    let vault = state.vault.lock().await;
    vault.connections_list().map_err(app_error)
}

#[tauri::command]
pub async fn connection_save(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    let mut vault = state.vault.lock().await;
    vault.connection_save(profile).map_err(app_error)
}

#[tauri::command]
pub async fn connection_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut vault = state.vault.lock().await;
    vault.connection_delete(&id).map_err(app_error)
}

#[tauri::command]
pub async fn keychain_list(state: State<'_, AppState>) -> Result<Vec<KeychainEntry>, String> {
    let vault = state.vault.lock().await;
    vault.keychain_list().map_err(app_error)
}

#[tauri::command]
pub async fn keychain_save(
    state: State<'_, AppState>,
    entry: KeychainEntry,
) -> Result<KeychainEntry, String> {
    let mut vault = state.vault.lock().await;
    vault.keychain_save(entry).map_err(app_error)
}

#[tauri::command]
pub async fn keychain_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut vault = state.vault.lock().await;
    vault.keychain_delete(&id).map_err(app_error)
}
