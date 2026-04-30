use crate::debug_log_state;
use crate::libs::models::DebugLogEntryPayload;

#[tauri::command]
pub fn debug_logs_list() -> Result<Vec<DebugLogEntryPayload>, String> {
    let state = debug_log_state()
        .lock()
        .map_err(|_| "Falha ao acessar logs de depuracao.".to_string())?;
    Ok(state.entries.iter().cloned().collect())
}

#[tauri::command]
pub fn debug_logs_clear() -> Result<(), String> {
    let mut state = debug_log_state()
        .lock()
        .map_err(|_| "Falha ao limpar logs de depuracao.".to_string())?;
    state.entries.clear();
    Ok(())
}

#[tauri::command]
pub fn debug_logs_set_enabled(enabled: bool) -> Result<(), String> {
    crate::set_debug_logs_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub fn debug_log_frontend(
    level: String,
    source: String,
    message: String,
    context: Option<String>,
) -> Result<(), String> {
    let normalized_level = crate::normalize_debug_level(&level);
    crate::push_debug_log(normalized_level, source, message, context);
    Ok(())
}
