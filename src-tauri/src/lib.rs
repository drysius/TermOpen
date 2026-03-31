use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::UNIX_EPOCH,
};

use models::{
    AppSettings, ConnectionProfile, KeychainEntry, KnownHostEntry, SftpEntry, SshConnectResult,
    SshSessionInfo, SyncState, VaultStatus,
};
use ssh::{known_hosts_add, known_hosts_ensure, known_hosts_list, known_hosts_remove, SshManager};
use sync::SyncManager;
use tauri::{Emitter, State};
use tokio::sync::Mutex;
use vault::VaultManager;

mod models;
mod ssh;
mod sync;
mod vault;

struct AppState {
    vault: Mutex<VaultManager>,
    ssh: Mutex<SshManager>,
    sync: Mutex<SyncManager>,
}

fn app_error(error: impl ToString) -> String {
    error.to_string()
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
                profile.password = key.passphrase;
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
                profile.password = key.passphrase;
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
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_read(&session_id, &path).map_err(app_error)
}

#[tauri::command]
async fn sftp_write(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let mut ssh = state.ssh.lock().await;
    ssh.sftp_write(&session_id, &path, &content)
        .map_err(app_error)
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

    let content = if let Some(session_id) = from_session_id {
        let mut ssh = state.ssh.lock().await;
        ssh.sftp_read_bytes(&session_id, &from_path).map_err(app_error)?
    } else {
        let source = resolve_local_path(Some(&from_path))?;
        fs::read(&source).map_err(|error| {
            format!(
                "Falha ao ler arquivo local {}: {}",
                source.display(),
                error
            )
        })?
    };

    let _ = app.emit(&progress_event, 60u8);

    if let Some(session_id) = to_session_id {
        let mut ssh = state.ssh.lock().await;
        ssh.sftp_write_bytes(&session_id, &to_path, &content)
            .map_err(app_error)?;
    } else {
        let target = resolve_local_path(Some(&to_path))?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(app_error)?;
        }
        fs::write(&target, &content).map_err(|error| {
            format!(
                "Falha ao escrever arquivo local {}: {}",
                target.display(),
                error
            )
        })?;
    }

    let _ = app.emit(&progress_event, 100u8);
    Ok(())
}

#[tauri::command]
async fn local_list(path: Option<String>) -> Result<Vec<SftpEntry>, String> {
    let target = resolve_local_path(path.as_deref())?;
    let read_dir = fs::read_dir(&target)
        .map_err(|error| format!("Falha ao listar diretorio local {}: {}", target.display(), error))?;

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
async fn local_write(path: String, content: String) -> Result<(), String> {
    let target = resolve_local_path(Some(&path))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(app_error)?;
    }
    fs::write(&target, content)
        .map_err(|error| format!("Falha ao escrever arquivo local {}: {}", target.display(), error))
}

#[tauri::command]
async fn sync_google_login(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SyncState, String> {
    let mut sync = state.sync.lock().await;
    sync.google_login(&app).await.map_err(app_error)
}

#[tauri::command]
async fn sync_logged_user(state: State<'_, AppState>) -> Result<Option<(String, String)>, String> {
    let sync = state.sync.lock().await;
    Ok(sync.logged_user())
}

#[tauri::command]
async fn sync_push(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<SyncState, String> {
    let mut sync = state.sync.lock().await;
    let mut vault = state.vault.lock().await;
    sync.push(&app, &mut vault).await.map_err(app_error)
}

#[tauri::command]
async fn sync_pull(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<SyncState, String> {
    let mut sync = state.sync.lock().await;
    let mut vault = state.vault.lock().await;
    sync.pull(&app, &mut vault).await.map_err(app_error)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let vault = VaultManager::new().expect("failed to initialize vault manager");
    tauri::Builder::default()
        .manage(AppState {
            vault: Mutex::new(vault),
            ssh: Mutex::new(SshManager::new()),
            sync: Mutex::new(SyncManager::new()),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_init,
            vault_unlock,
            vault_lock,
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
            known_hosts_list_cmd,
            known_hosts_add_cmd,
            known_hosts_remove_cmd,
            known_hosts_ensure_cmd,
            sftp_list,
            sftp_read,
            sftp_write,
            sftp_transfer,
            local_list,
            local_read,
            local_write,
            sync_google_login,
            sync_logged_user,
            sync_push,
            sync_pull,
            open_external_editor,
            window_minimize,
            window_toggle_maximize,
            window_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
