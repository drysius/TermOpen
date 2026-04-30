use tauri::State;

use crate::libs::models::AppSettings;
use crate::{app_error, set_debug_logs_enabled, AppState};

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let vault = state.vault.lock().await;
    let settings = vault.settings_get().map_err(app_error)?;
    set_debug_logs_enabled(settings.debug_logs_enabled);
    Ok(settings)
}

#[tauri::command]
pub async fn settings_update(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let mut vault = state.vault.lock().await;
    let saved = vault.settings_update(settings).map_err(app_error)?;
    set_debug_logs_enabled(saved.debug_logs_enabled);
    Ok(saved)
}
