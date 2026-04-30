use tauri::{Emitter, State};

use crate::libs::models::{KnownHostEntry, SshSessionInfo};
use crate::protocols::ssh::{
    known_hosts_add, known_hosts_ensure, known_hosts_list, known_hosts_remove, SshManager,
};
use crate::{app_error, AppState};

#[tauri::command]
pub async fn ssh_connect_ex(
    state: State<'_, AppState>,
    profile_id: String,
    password_override: Option<String>,
    keychain_id_override: Option<String>,
    save_auth_choice: Option<bool>,
) -> Result<SshSessionInfo, String> {
    let mut ssh = state.ssh.lock().await;
    let result = crate::resolve_profile_with_keychain(&state, &profile_id).await?;
    
    ssh.connect(
        result,
        password_override,
        keychain_id_override,
        save_auth_choice,
    )
    .await
    .map_err(app_error)
}

#[tauri::command]
pub async fn known_hosts_list_cmd(
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
pub async fn known_hosts_add_cmd(
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
pub async fn known_hosts_remove_cmd(
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
pub async fn known_hosts_ensure_cmd(
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
pub async fn ssh_write(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<String, String> {
    let output = {
        let mut ssh = state.ssh.lock().await;
        ssh.run_command(&session_id, &data)
            .await
            .map_err(app_error)?
    };

    let event = format!("terminal:output:{}", session_id);
    let _ = app.emit(&event, output.clone());
    Ok(output)
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.resize_pty(&session_id, cols, rows)
        .await
        .map_err(app_error)
}

#[tauri::command]
pub async fn ssh_disconnect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    {
        let mut ssh = state.ssh.lock().await;
        ssh.disconnect(&session_id).await;
    }

    let event = format!("terminal:exit:{}", session_id);
    let _ = app.emit(&event, "Disconnected".to_string());
    Ok(())
}

#[tauri::command]
pub async fn ssh_sessions(state: State<'_, AppState>) -> Result<Vec<SshSessionInfo>, String> {
    let ssh = state.ssh.lock().await;
    Ok(ssh.sessions_info())
}
