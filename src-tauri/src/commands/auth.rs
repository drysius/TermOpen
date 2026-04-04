use tauri::State;

use crate::constants::{AUTH_SERVERS_LOCAL_FALLBACK_JSON, AUTH_SERVERS_REMOTE_URL};
use crate::libs::models::AuthServer;
use crate::{app_error, AppState};

#[tauri::command]
pub async fn auth_servers_list(state: State<'_, AppState>) -> Result<Vec<AuthServer>, String> {
    let vault = state.vault.lock().await;
    vault.auth_servers_list().map_err(app_error)
}

#[tauri::command]
pub async fn auth_server_save(
    state: State<'_, AppState>,
    server: AuthServer,
) -> Result<AuthServer, String> {
    let mut vault = state.vault.lock().await;
    vault.auth_server_save(server).map_err(app_error)
}

#[tauri::command]
pub async fn auth_server_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut vault = state.vault.lock().await;
    vault.auth_server_delete(&id).map_err(app_error)
}

#[tauri::command]
pub async fn auth_servers_fetch_remote(
    state: State<'_, AppState>,
) -> Result<Vec<AuthServer>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Sempre carregar local
    let local = load_local_servers();

    // Tentar buscar do GitHub
    let remote: Vec<AuthServer> = match client.get(AUTH_SERVERS_REMOTE_URL).send().await {
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
        merged.push(AuthServer::default_server());
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
    serde_json::from_str(AUTH_SERVERS_LOCAL_FALLBACK_JSON)
        .unwrap_or_else(|_| vec![AuthServer::default_server()])
}


