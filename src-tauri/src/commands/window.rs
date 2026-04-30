use tauri::State;

use crate::libs::models::WindowState;
use crate::{app_error, is_legacy_compact_window_state, is_window_below_minimum, restore_window_to_default_size, AppState};

#[tauri::command]
pub async fn window_state_save(
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
pub async fn window_state_restore(
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
pub fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(app_error)
}

#[tauri::command]
pub fn window_toggle_maximize(window: tauri::Window) -> Result<bool, String> {
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
pub fn window_is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(app_error)
}

#[tauri::command]
pub fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(app_error)
}
