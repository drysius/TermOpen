use tauri::State;

use crate::libs::models::RdpSessionStartResult;
use crate::protocols::rdp::{
    RdpInputBatch, RdpSessionControlEvent, RdpSessionFocusInput, RdpSessionManager,
};
use crate::{app_error, resolve_rdp_profile, AppState};

#[tauri::command]
pub async fn rdp_session_start(
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
    use crate::constants::{
        DEFAULT_RDP_HEIGHT, DEFAULT_RDP_WIDTH, MAX_RDP_DIMENSION, MIN_RDP_DIMENSION,
    };
    
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

    let options = crate::protocols::rdp::RdpSessionOptions {
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
pub async fn rdp_session_focus(
    state: State<'_, AppState>,
    session_id: String,
    focus: RdpSessionFocusInput,
) -> Result<(), String> {
    let mut manager = state.rdp_sessions.lock().await;
    manager.focus(session_id.as_str(), focus).map_err(app_error)
}

#[tauri::command]
pub async fn rdp_input_batch(
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
pub async fn rdp_session_stop(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut manager = state.rdp_sessions.lock().await;
    manager.stop(session_id.as_str()).map_err(app_error)
}
