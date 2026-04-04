use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rdev::{Button, Event, EventType, Key};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::protocols::rdp::{RdpInputBatch, RdpInputEvent, RdpMouseButton};

const STATUS_EVENT: &str = "key_actions:status";
const MAX_MOVE_RATE: Duration = Duration::from_millis(16);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyActionsStatusKind {
    Ready,
    Disabled,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct KeyActionsStatusPayload {
    pub status: KeyActionsStatusKind,
    pub reason: Option<String>,
    pub platform: String,
    pub details: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SurfaceRectInput {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KeyActionsActiveTargetInput {
    Rdp {
        session_id: String,
        tab_id: String,
        block_id: String,
        surface_rect: SurfaceRectInput,
        #[serde(default)]
        dpi_scale: Option<f64>,
        remote_width: u16,
        remote_height: u16,
    },
    Ssh {
        session_id: String,
        tab_id: String,
        block_id: String,
        surface_rect: SurfaceRectInput,
        #[serde(default)]
        dpi_scale: Option<f64>,
        cols: u16,
        rows: u16,
    },
}

#[derive(Debug, Clone)]
struct TargetCommon {
    session_id: String,
    _tab_id: String,
    _block_id: String,
    surface_rect: SurfaceRectInput,
    dpi_scale: f64,
}

#[derive(Debug, Clone)]
enum ActiveTarget {
    Rdp {
        common: TargetCommon,
        remote_width: u16,
        remote_height: u16,
    },
    Ssh {
        common: TargetCommon,
        cols: u16,
        rows: u16,
    },
}

#[derive(Debug, Clone, Copy)]
struct Modifiers {
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

#[derive(Debug, Clone)]
enum DispatchEvent {
    Rdp {
        session_id: String,
        event: RdpInputEvent,
    },
    Ssh {
        session_id: String,
        bytes: Vec<u8>,
        requires_mouse_mode: bool,
    },
}

#[derive(Debug)]
struct InnerState {
    active_target: Option<ActiveTarget>,
    window_focused: bool,
    window_origin: Option<(f64, f64)>,
    last_pointer_screen: Option<(f64, f64)>,
    last_move_at: Option<Instant>,
    pressed_keys: HashSet<Key>,
    pressed_buttons: HashSet<Button>,
    dispatch_tx: Option<mpsc::UnboundedSender<DispatchEvent>>,
    status: KeyActionsStatusPayload,
}

impl InnerState {
    fn new() -> Self {
        Self {
            active_target: None,
            window_focused: true,
            window_origin: None,
            last_pointer_screen: None,
            last_move_at: None,
            pressed_keys: HashSet::new(),
            pressed_buttons: HashSet::new(),
            dispatch_tx: None,
            status: KeyActionsStatusPayload {
                status: KeyActionsStatusKind::Disabled,
                reason: Some("not_started".to_string()),
                platform: platform_name(),
                details: Some("Captura nativa ainda nao iniciou.".to_string()),
            },
        }
    }

    fn modifiers(&self) -> Modifiers {
        Modifiers {
            ctrl: self
                .pressed_keys
                .iter()
                .any(|key| matches!(key, Key::ControlLeft | Key::ControlRight)),
            alt: self
                .pressed_keys
                .iter()
                .any(|key| matches!(key, Key::Alt | Key::AltGr)),
            shift: self
                .pressed_keys
                .iter()
                .any(|key| matches!(key, Key::ShiftLeft | Key::ShiftRight)),
            meta: self
                .pressed_keys
                .iter()
                .any(|key| matches!(key, Key::MetaLeft | Key::MetaRight)),
        }
    }
}

pub struct KeyActionsService {
    inner: Arc<StdMutex<InnerState>>,
    started: AtomicBool,
}

impl Default for KeyActionsService {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyActionsService {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(StdMutex::new(InnerState::new())),
            started: AtomicBool::new(false),
        }
    }

    pub fn start(&self, app: AppHandle) {
        if self.started.swap(true, Ordering::SeqCst) {
            self.emit_status(&app);
            return;
        }

        let (dispatch_tx, mut dispatch_rx) = mpsc::unbounded_channel::<DispatchEvent>();
        if let Ok(mut state) = self.inner.lock() {
            state.dispatch_tx = Some(dispatch_tx);
        }

        let dispatch_app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = dispatch_rx.recv().await {
                handle_dispatch_event(&dispatch_app, event).await;
            }
        });

        if let Some((reason, details)) = platform_capture_disabled_reason() {
            self.set_status(
                KeyActionsStatusKind::Disabled,
                Some(reason.to_string()),
                Some(details.to_string()),
            );
            self.emit_status(&app);
            return;
        }

        self.set_status(KeyActionsStatusKind::Ready, None, None);
        self.emit_status(&app);

        let listener_inner = Arc::clone(&self.inner);
        let listener_app = app.clone();
        std::thread::spawn(move || {
            let process_inner = Arc::clone(&listener_inner);
            let result = rdev::listen(move |event| process_native_event(&process_inner, event));
            if let Err(error) = result {
                if let Ok(mut state) = listener_inner.lock() {
                    state.status = KeyActionsStatusPayload {
                        status: KeyActionsStatusKind::Disabled,
                        reason: Some("hook_error".to_string()),
                        platform: platform_name(),
                        details: Some(format!("Falha ao iniciar captura nativa: {error:?}")),
                    };
                }
                if let Ok(state) = listener_inner.lock() {
                    let _ = listener_app.emit(STATUS_EVENT, state.status.clone());
                }
            }
        });
    }

    pub fn set_active_target(
        &self,
        target: Option<KeyActionsActiveTargetInput>,
    ) -> Result<(), String> {
        let parsed = target.map(parse_active_target).transpose()?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Falha ao atualizar alvo de captura.".to_string())?;
        state.active_target = parsed;
        state.pressed_buttons.clear();
        Ok(())
    }

    pub fn set_window_focused(&self, focused: bool) {
        if let Ok(mut state) = self.inner.lock() {
            state.window_focused = focused;
            if !focused {
                state.pressed_buttons.clear();
            }
        }
    }

    pub fn set_window_origin(&self, x: f64, y: f64) {
        if let Ok(mut state) = self.inner.lock() {
            state.window_origin = Some((x, y));
        }
    }

    pub fn emit_status(&self, app: &AppHandle) {
        if let Ok(state) = self.inner.lock() {
            let _ = app.emit(STATUS_EVENT, state.status.clone());
        }
    }

    fn set_status(
        &self,
        status: KeyActionsStatusKind,
        reason: Option<String>,
        details: Option<String>,
    ) {
        if let Ok(mut state) = self.inner.lock() {
            state.status = KeyActionsStatusPayload {
                status,
                reason,
                platform: platform_name(),
                details,
            };
        }
    }
}

fn parse_active_target(input: KeyActionsActiveTargetInput) -> Result<ActiveTarget, String> {
    match input {
        KeyActionsActiveTargetInput::Rdp {
            session_id,
            tab_id,
            block_id,
            surface_rect,
            dpi_scale,
            remote_width,
            remote_height,
        } => {
            let common =
                parse_target_common(session_id, tab_id, block_id, surface_rect, dpi_scale)?;
            if remote_width == 0 || remote_height == 0 {
                return Err("Resolucao remota RDP invalida para captura.".to_string());
            }
            Ok(ActiveTarget::Rdp {
                common,
                remote_width,
                remote_height,
            })
        }
        KeyActionsActiveTargetInput::Ssh {
            session_id,
            tab_id,
            block_id,
            surface_rect,
            dpi_scale,
            cols,
            rows,
        } => {
            let common =
                parse_target_common(session_id, tab_id, block_id, surface_rect, dpi_scale)?;
            if cols == 0 || rows == 0 {
                return Err("Grade do terminal invalida para captura.".to_string());
            }
            Ok(ActiveTarget::Ssh { common, cols, rows })
        }
    }
}

fn parse_target_common(
    session_id: String,
    tab_id: String,
    block_id: String,
    surface_rect: SurfaceRectInput,
    dpi_scale: Option<f64>,
) -> Result<TargetCommon, String> {
    let session_id = session_id.trim().to_string();
    let tab_id = tab_id.trim().to_string();
    let block_id = block_id.trim().to_string();
    if session_id.is_empty() || tab_id.is_empty() || block_id.is_empty() {
        return Err("Contexto ativo de captura invalido.".to_string());
    }
    if surface_rect.width <= 0.0 || surface_rect.height <= 0.0 {
        return Err("Retangulo da superficie invalido para captura.".to_string());
    }
    let dpi_scale = dpi_scale.filter(|value| *value > 0.0).unwrap_or(1.0);
    Ok(TargetCommon {
        session_id,
        _tab_id: tab_id,
        _block_id: block_id,
        surface_rect,
        dpi_scale,
    })
}

fn process_native_event(inner: &Arc<StdMutex<InnerState>>, event: Event) {
    let mut dispatches = Vec::new();
    let mut state = match inner.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };

    let Some(target) = state.active_target.clone() else {
        return;
    };
    let Some(tx) = state.dispatch_tx.clone() else {
        return;
    };

    if let EventType::MouseMove { x, y } = event.event_type {
        state.last_pointer_screen = Some((x, y));
    }

    match event.event_type {
        EventType::KeyPress(key) => {
            state.pressed_keys.insert(key);
            if state.window_focused {
                if let Some(dispatch) =
                    build_key_dispatch(&target, key, event.name.as_deref(), state.modifiers())
                {
                    dispatches.push(dispatch);
                }
            }
        }
        EventType::KeyRelease(key) => {
            state.pressed_keys.remove(&key);
        }
        EventType::MouseMove { x, y } => {
            if state.window_focused && !should_throttle_move(state.last_move_at) {
                state.last_move_at = Some(Instant::now());
                if let Some(dispatch) =
                    build_move_dispatch(&target, x, y, state.window_origin, &state.pressed_buttons)
                {
                    dispatches.push(dispatch);
                }
            }
        }
        EventType::ButtonPress(button) => {
            state.pressed_buttons.insert(button);
            if state.window_focused {
                if let Some((x, y)) = state.last_pointer_screen {
                    if let Some(dispatch) =
                        build_button_dispatch(&target, button, true, x, y, state.window_origin)
                    {
                        dispatches.push(dispatch);
                    }
                }
            }
        }
        EventType::ButtonRelease(button) => {
            if state.window_focused {
                if let Some((x, y)) = state.last_pointer_screen {
                    if let Some(dispatch) =
                        build_button_dispatch(&target, button, false, x, y, state.window_origin)
                    {
                        dispatches.push(dispatch);
                    }
                }
            }
            state.pressed_buttons.remove(&button);
        }
        EventType::Wheel { delta_x, delta_y } => {
            if state.window_focused {
                if let Some((x, y)) = state.last_pointer_screen {
                    if let Some(dispatch) =
                        build_wheel_dispatch(&target, delta_x, delta_y, x, y, state.window_origin)
                    {
                        dispatches.push(dispatch);
                    }
                }
            }
        }
    }

    drop(state);
    for dispatch in dispatches {
        let _ = tx.send(dispatch);
    }
}

fn build_key_dispatch(
    target: &ActiveTarget,
    key: Key,
    key_name: Option<&str>,
    modifiers: Modifiers,
) -> Option<DispatchEvent> {
    match target {
        ActiveTarget::Rdp { common, .. } => Some(DispatchEvent::Rdp {
            session_id: common.session_id.clone(),
            event: RdpInputEvent::KeyPress {
                code: rdev_key_to_web_code(key)?.to_string(),
                text: key_name
                    .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
                    .map(|value| value.to_string()),
                ctrl: modifiers.ctrl,
                alt: modifiers.alt,
                shift: modifiers.shift,
                meta: modifiers.meta,
            },
        }),
        ActiveTarget::Ssh { common, .. } => Some(DispatchEvent::Ssh {
            session_id: common.session_id.clone(),
            bytes: ssh_bytes_from_key(key, key_name, modifiers)?,
            requires_mouse_mode: false,
        }),
    }
}

fn build_move_dispatch(
    target: &ActiveTarget,
    x: f64,
    y: f64,
    window_origin: Option<(f64, f64)>,
    pressed_buttons: &HashSet<Button>,
) -> Option<DispatchEvent> {
    match target {
        ActiveTarget::Rdp {
            common,
            remote_width,
            remote_height,
        } => {
            let (mapped_x, mapped_y) =
                map_rdp_pointer(*remote_width, *remote_height, common, x, y, window_origin?)?;
            Some(DispatchEvent::Rdp {
                session_id: common.session_id.clone(),
                event: RdpInputEvent::MouseMove {
                    x: mapped_x,
                    y: mapped_y,
                    t_ms: Some(now_millis()),
                },
            })
        }
        ActiveTarget::Ssh { common, cols, rows } => {
            let button = if pressed_buttons.contains(&Button::Left) {
                Button::Left
            } else if pressed_buttons.contains(&Button::Middle) {
                Button::Middle
            } else if pressed_buttons.contains(&Button::Right) {
                Button::Right
            } else {
                return None;
            };
            let (col, row) = map_ssh_pointer(*cols, *rows, common, x, y, window_origin?)?;
            let bytes = sgr_mouse_packet(ssh_button_code(button) + 32, col, row, true);
            Some(DispatchEvent::Ssh {
                session_id: common.session_id.clone(),
                bytes,
                requires_mouse_mode: true,
            })
        }
    }
}

fn build_button_dispatch(
    target: &ActiveTarget,
    button: Button,
    pressed: bool,
    x: f64,
    y: f64,
    window_origin: Option<(f64, f64)>,
) -> Option<DispatchEvent> {
    match target {
        ActiveTarget::Rdp {
            common,
            remote_width,
            remote_height,
        } => {
            let (mapped_x, mapped_y) =
                map_rdp_pointer(*remote_width, *remote_height, common, x, y, window_origin?)?;
            let mapped_button = match button {
                Button::Left => RdpMouseButton::Left,
                Button::Right => RdpMouseButton::Right,
                Button::Middle => RdpMouseButton::Middle,
                Button::Unknown(_) => return None,
            };
            let event = if pressed {
                RdpInputEvent::MouseButtonDown {
                    x: mapped_x,
                    y: mapped_y,
                    button: mapped_button,
                }
            } else {
                RdpInputEvent::MouseButtonUp {
                    x: mapped_x,
                    y: mapped_y,
                    button: mapped_button,
                }
            };
            Some(DispatchEvent::Rdp {
                session_id: common.session_id.clone(),
                event,
            })
        }
        ActiveTarget::Ssh { common, cols, rows } => {
            let (col, row) = map_ssh_pointer(*cols, *rows, common, x, y, window_origin?)?;
            let code = if pressed { ssh_button_code(button) } else { 3 };
            Some(DispatchEvent::Ssh {
                session_id: common.session_id.clone(),
                bytes: sgr_mouse_packet(code, col, row, pressed),
                requires_mouse_mode: true,
            })
        }
    }
}

fn build_wheel_dispatch(
    target: &ActiveTarget,
    delta_x: i64,
    delta_y: i64,
    x: f64,
    y: f64,
    window_origin: Option<(f64, f64)>,
) -> Option<DispatchEvent> {
    match target {
        ActiveTarget::Rdp {
            common,
            remote_width,
            remote_height,
        } => {
            let (mapped_x, mapped_y) =
                map_rdp_pointer(*remote_width, *remote_height, common, x, y, window_origin?)?;
            let dx = normalize_wheel(delta_x);
            let dy = normalize_wheel(delta_y);
            if dx == 0 && dy == 0 {
                return None;
            }
            Some(DispatchEvent::Rdp {
                session_id: common.session_id.clone(),
                event: RdpInputEvent::MouseScroll {
                    x: mapped_x,
                    y: mapped_y,
                    delta_x: dx,
                    delta_y: dy,
                },
            })
        }
        ActiveTarget::Ssh { common, cols, rows } => {
            let (col, row) = map_ssh_pointer(*cols, *rows, common, x, y, window_origin?)?;
            let mut bytes = Vec::new();
            for _ in 0..delta_y.unsigned_abs().min(8) {
                let code = if delta_y >= 0 { 64 } else { 65 };
                bytes.extend_from_slice(&sgr_mouse_packet(code, col, row, true));
            }
            for _ in 0..delta_x.unsigned_abs().min(8) {
                let code = if delta_x >= 0 { 66 } else { 67 };
                bytes.extend_from_slice(&sgr_mouse_packet(code, col, row, true));
            }
            if bytes.is_empty() {
                return None;
            }
            Some(DispatchEvent::Ssh {
                session_id: common.session_id.clone(),
                bytes,
                requires_mouse_mode: true,
            })
        }
    }
}

fn map_rdp_pointer(
    remote_width: u16,
    remote_height: u16,
    common: &TargetCommon,
    screen_x: f64,
    screen_y: f64,
    window_origin: (f64, f64),
) -> Option<(u16, u16)> {
    let (local_x, local_y, width, height) =
        map_surface_pointer(common, screen_x, screen_y, window_origin)?;
    let x = ((local_x / width) * f64::from(remote_width.saturating_sub(1)))
        .round()
        .clamp(0.0, f64::from(remote_width.saturating_sub(1))) as u16;
    let y = ((local_y / height) * f64::from(remote_height.saturating_sub(1)))
        .round()
        .clamp(0.0, f64::from(remote_height.saturating_sub(1))) as u16;
    Some((x, y))
}

fn map_ssh_pointer(
    cols: u16,
    rows: u16,
    common: &TargetCommon,
    screen_x: f64,
    screen_y: f64,
    window_origin: (f64, f64),
) -> Option<(u16, u16)> {
    let (local_x, local_y, width, height) =
        map_surface_pointer(common, screen_x, screen_y, window_origin)?;
    let col =
        (((local_x / width) * f64::from(cols)).floor() + 1.0).clamp(1.0, f64::from(cols)) as u16;
    let row =
        (((local_y / height) * f64::from(rows)).floor() + 1.0).clamp(1.0, f64::from(rows)) as u16;
    Some((col, row))
}

fn map_surface_pointer(
    common: &TargetCommon,
    screen_x: f64,
    screen_y: f64,
    window_origin: (f64, f64),
) -> Option<(f64, f64, f64, f64)> {
    let scale = common.dpi_scale.max(1.0);
    let sx = common.surface_rect.x * scale;
    let sy = common.surface_rect.y * scale;
    let sw = common.surface_rect.width * scale;
    let sh = common.surface_rect.height * scale;
    if sw <= 0.0 || sh <= 0.0 {
        return None;
    }
    let local_x = screen_x - window_origin.0 - sx;
    let local_y = screen_y - window_origin.1 - sy;
    if local_x < 0.0 || local_y < 0.0 || local_x > sw || local_y > sh {
        return None;
    }
    Some((local_x, local_y, sw, sh))
}

fn should_throttle_move(last_move_at: Option<Instant>) -> bool {
    last_move_at.is_some_and(|value| value.elapsed() < MAX_MOVE_RATE)
}

fn normalize_wheel(delta: i64) -> i16 {
    delta
        .saturating_mul(120)
        .clamp(i64::from(i16::MIN), i64::from(i16::MAX)) as i16
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn sgr_mouse_packet(code: u8, col: u16, row: u16, pressed: bool) -> Vec<u8> {
    let suffix = if pressed { "M" } else { "m" };
    format!("\u{1b}[<{};{};{}{}", code, col, row, suffix).into_bytes()
}

fn ssh_button_code(button: Button) -> u8 {
    match button {
        Button::Left => 0,
        Button::Middle => 1,
        Button::Right => 2,
        Button::Unknown(_) => 0,
    }
}

fn ssh_bytes_from_key(key: Key, key_name: Option<&str>, modifiers: Modifiers) -> Option<Vec<u8>> {
    let mut bytes = if let Some(control) = ssh_ctrl_byte(key, modifiers.ctrl) {
        vec![control]
    } else {
        match key {
            Key::Return | Key::KpReturn => b"\r".to_vec(),
            Key::Tab => b"\t".to_vec(),
            Key::Backspace => vec![0x7f],
            Key::Escape => vec![0x1b],
            Key::LeftArrow => b"\x1b[D".to_vec(),
            Key::RightArrow => b"\x1b[C".to_vec(),
            Key::UpArrow => b"\x1b[A".to_vec(),
            Key::DownArrow => b"\x1b[B".to_vec(),
            Key::Home => b"\x1b[H".to_vec(),
            Key::End => b"\x1b[F".to_vec(),
            Key::PageUp => b"\x1b[5~".to_vec(),
            Key::PageDown => b"\x1b[6~".to_vec(),
            Key::Insert => b"\x1b[2~".to_vec(),
            Key::Delete => b"\x1b[3~".to_vec(),
            Key::F1 => b"\x1bOP".to_vec(),
            Key::F2 => b"\x1bOQ".to_vec(),
            Key::F3 => b"\x1bOR".to_vec(),
            Key::F4 => b"\x1bOS".to_vec(),
            Key::F5 => b"\x1b[15~".to_vec(),
            Key::F6 => b"\x1b[17~".to_vec(),
            Key::F7 => b"\x1b[18~".to_vec(),
            Key::F8 => b"\x1b[19~".to_vec(),
            Key::F9 => b"\x1b[20~".to_vec(),
            Key::F10 => b"\x1b[21~".to_vec(),
            Key::F11 => b"\x1b[23~".to_vec(),
            Key::F12 => b"\x1b[24~".to_vec(),
            Key::Space => b" ".to_vec(),
            _ => key_name
                .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
                .map(|value| value.as_bytes().to_vec())?,
        }
    };
    if modifiers.alt || modifiers.meta {
        bytes.insert(0, 0x1b);
    }
    Some(bytes)
}

fn ssh_ctrl_byte(key: Key, ctrl: bool) -> Option<u8> {
    if !ctrl {
        return None;
    }
    match key {
        Key::KeyA => Some(0x01),
        Key::KeyB => Some(0x02),
        Key::KeyC => Some(0x03),
        Key::KeyD => Some(0x04),
        Key::KeyE => Some(0x05),
        Key::KeyF => Some(0x06),
        Key::KeyG => Some(0x07),
        Key::KeyH => Some(0x08),
        Key::KeyI => Some(0x09),
        Key::KeyJ => Some(0x0a),
        Key::KeyK => Some(0x0b),
        Key::KeyL => Some(0x0c),
        Key::KeyM => Some(0x0d),
        Key::KeyN => Some(0x0e),
        Key::KeyO => Some(0x0f),
        Key::KeyP => Some(0x10),
        Key::KeyQ => Some(0x11),
        Key::KeyR => Some(0x12),
        Key::KeyS => Some(0x13),
        Key::KeyT => Some(0x14),
        Key::KeyU => Some(0x15),
        Key::KeyV => Some(0x16),
        Key::KeyW => Some(0x17),
        Key::KeyX => Some(0x18),
        Key::KeyY => Some(0x19),
        Key::KeyZ => Some(0x1a),
        Key::Space => Some(0x00),
        Key::LeftBracket => Some(0x1b),
        Key::BackSlash => Some(0x1c),
        Key::RightBracket => Some(0x1d),
        Key::Num6 => Some(0x1e),
        Key::Minus => Some(0x1f),
        _ => None,
    }
}

fn rdev_key_to_web_code(key: Key) -> Option<&'static str> {
    match key {
        Key::KeyA => Some("KeyA"),
        Key::KeyB => Some("KeyB"),
        Key::KeyC => Some("KeyC"),
        Key::KeyD => Some("KeyD"),
        Key::KeyE => Some("KeyE"),
        Key::KeyF => Some("KeyF"),
        Key::KeyG => Some("KeyG"),
        Key::KeyH => Some("KeyH"),
        Key::KeyI => Some("KeyI"),
        Key::KeyJ => Some("KeyJ"),
        Key::KeyK => Some("KeyK"),
        Key::KeyL => Some("KeyL"),
        Key::KeyM => Some("KeyM"),
        Key::KeyN => Some("KeyN"),
        Key::KeyO => Some("KeyO"),
        Key::KeyP => Some("KeyP"),
        Key::KeyQ => Some("KeyQ"),
        Key::KeyR => Some("KeyR"),
        Key::KeyS => Some("KeyS"),
        Key::KeyT => Some("KeyT"),
        Key::KeyU => Some("KeyU"),
        Key::KeyV => Some("KeyV"),
        Key::KeyW => Some("KeyW"),
        Key::KeyX => Some("KeyX"),
        Key::KeyY => Some("KeyY"),
        Key::KeyZ => Some("KeyZ"),
        Key::Num0 => Some("Digit0"),
        Key::Num1 => Some("Digit1"),
        Key::Num2 => Some("Digit2"),
        Key::Num3 => Some("Digit3"),
        Key::Num4 => Some("Digit4"),
        Key::Num5 => Some("Digit5"),
        Key::Num6 => Some("Digit6"),
        Key::Num7 => Some("Digit7"),
        Key::Num8 => Some("Digit8"),
        Key::Num9 => Some("Digit9"),
        Key::Return => Some("Enter"),
        Key::KpReturn => Some("NumpadEnter"),
        Key::Tab => Some("Tab"),
        Key::Backspace => Some("Backspace"),
        Key::Escape => Some("Escape"),
        Key::Space => Some("Space"),
        Key::ControlLeft => Some("ControlLeft"),
        Key::ControlRight => Some("ControlRight"),
        Key::ShiftLeft => Some("ShiftLeft"),
        Key::ShiftRight => Some("ShiftRight"),
        Key::Alt => Some("AltLeft"),
        Key::AltGr => Some("AltRight"),
        Key::MetaLeft => Some("MetaLeft"),
        Key::MetaRight => Some("MetaRight"),
        Key::LeftArrow => Some("ArrowLeft"),
        Key::RightArrow => Some("ArrowRight"),
        Key::UpArrow => Some("ArrowUp"),
        Key::DownArrow => Some("ArrowDown"),
        Key::Insert => Some("Insert"),
        Key::Delete => Some("Delete"),
        Key::Home => Some("Home"),
        Key::End => Some("End"),
        Key::PageUp => Some("PageUp"),
        Key::PageDown => Some("PageDown"),
        Key::F1 => Some("F1"),
        Key::F2 => Some("F2"),
        Key::F3 => Some("F3"),
        Key::F4 => Some("F4"),
        Key::F5 => Some("F5"),
        Key::F6 => Some("F6"),
        Key::F7 => Some("F7"),
        Key::F8 => Some("F8"),
        Key::F9 => Some("F9"),
        Key::F10 => Some("F10"),
        Key::F11 => Some("F11"),
        Key::F12 => Some("F12"),
        _ => None,
    }
}

fn platform_name() -> String {
    #[cfg(target_os = "windows")]
    {
        return "windows".to_string();
    }
    #[cfg(target_os = "macos")]
    {
        return "macos".to_string();
    }
    #[cfg(target_os = "linux")]
    {
        return "linux".to_string();
    }
    #[allow(unreachable_code)]
    "unknown".to_string()
}

fn platform_capture_disabled_reason() -> Option<(&'static str, &'static str)> {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return Some((
                "wayland_not_supported",
                "Captura global ainda nao suporta Wayland nesta fase (use X11).",
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if !macos_accessibility_client::accessibility::application_is_trusted() {
            return Some((
                "macos_accessibility_required",
                "Permissao de acessibilidade ausente para captura global no macOS.",
            ));
        }
    }
    None
}

async fn handle_dispatch_event(app: &AppHandle, event: DispatchEvent) {
    match event {
        DispatchEvent::Rdp { session_id, event } => {
            let state = app.state::<crate::AppState>();
            let mut manager = state.rdp_sessions.lock().await;
            let _ = manager.input_batch(
                session_id.as_str(),
                RdpInputBatch {
                    events: vec![event],
                },
            );
        }
        DispatchEvent::Ssh {
            session_id,
            bytes,
            requires_mouse_mode,
        } => {
            let state = app.state::<crate::AppState>();
            let mut ssh = state.ssh.lock().await;
            if requires_mouse_mode
                && !ssh
                    .is_mouse_sgr_enabled(session_id.as_str())
                    .unwrap_or_default()
            {
                return;
            }
            let _ = ssh
                .write_raw_input(session_id.as_str(), bytes.as_slice())
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_key_dispatch, map_rdp_pointer, map_ssh_pointer, parse_active_target,
        process_native_event, should_throttle_move, ssh_bytes_from_key, ssh_ctrl_byte,
        ActiveTarget, DispatchEvent, InnerState, KeyActionsActiveTargetInput, Modifiers,
        SurfaceRectInput, TargetCommon,
    };
    use rdev::{Event, EventType, Key};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::SystemTime;
    use std::time::{Duration, Instant};
    use tokio::sync::mpsc;

    fn test_common() -> TargetCommon {
        TargetCommon {
            session_id: "session".to_string(),
            _tab_id: "tab".to_string(),
            _block_id: "block".to_string(),
            surface_rect: SurfaceRectInput {
                x: 10.0,
                y: 20.0,
                width: 100.0,
                height: 50.0,
            },
            dpi_scale: 1.0,
        }
    }

    #[test]
    fn should_build_ctrl_key_codes() {
        assert_eq!(ssh_ctrl_byte(Key::KeyC, true), Some(0x03));
        assert_eq!(ssh_ctrl_byte(Key::KeyC, false), None);
    }

    #[test]
    fn should_apply_move_throttle() {
        assert!(should_throttle_move(Some(
            Instant::now() - Duration::from_millis(5)
        )));
        assert!(!should_throttle_move(Some(
            Instant::now() - Duration::from_millis(50)
        )));
    }

    #[test]
    fn should_validate_active_target() {
        let parsed = parse_active_target(KeyActionsActiveTargetInput::Ssh {
            session_id: "session".to_string(),
            tab_id: "tab".to_string(),
            block_id: "block".to_string(),
            surface_rect: SurfaceRectInput {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            dpi_scale: Some(1.0),
            cols: 80,
            rows: 24,
        });
        assert!(parsed.is_ok());
    }

    #[test]
    fn should_map_rdp_pointer_to_remote_surface() {
        let mapped = map_rdp_pointer(200, 100, &test_common(), 60.0, 45.0, (0.0, 0.0));
        assert_eq!(mapped, Some((100, 50)));
    }

    #[test]
    fn should_map_ssh_pointer_to_terminal_cells() {
        let mapped = map_ssh_pointer(80, 24, &test_common(), 109.0, 69.0, (0.0, 0.0));
        assert_eq!(mapped, Some((80, 24)));
    }

    #[test]
    fn should_translate_native_key_to_rdp_dispatch() {
        let target = ActiveTarget::Rdp {
            common: test_common(),
            remote_width: 1920,
            remote_height: 1080,
        };
        let modifiers = Modifiers {
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        };

        let dispatch = build_key_dispatch(&target, Key::KeyA, Some("a"), modifiers);
        match dispatch {
            Some(DispatchEvent::Rdp { session_id, event }) => {
                assert_eq!(session_id, "session");
                match event {
                    crate::protocols::rdp::RdpInputEvent::KeyPress { code, text, .. } => {
                        assert_eq!(code, "KeyA");
                        assert_eq!(text.as_deref(), Some("a"));
                    }
                    _ => panic!("Esperava evento de tecla RDP."),
                }
            }
            _ => panic!("Esperava dispatch RDP."),
        }
    }

    #[test]
    fn should_translate_native_key_to_ssh_bytes() {
        let modifiers = Modifiers {
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        };
        assert_eq!(
            ssh_bytes_from_key(Key::Return, None, modifiers),
            Some(b"\r".to_vec())
        );
    }

    #[test]
    fn should_ignore_events_without_window_focus() {
        let inner = Arc::new(StdMutex::new(InnerState::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        if let Ok(mut state) = inner.lock() {
            state.dispatch_tx = Some(tx);
            state.window_origin = Some((0.0, 0.0));
            state.window_focused = false;
            state.active_target = Some(ActiveTarget::Ssh {
                common: test_common(),
                cols: 80,
                rows: 24,
            });
        }

        process_native_event(
            &inner,
            Event {
                time: SystemTime::now(),
                name: Some("a".to_string()),
                event_type: EventType::KeyPress(Key::KeyA),
            },
        );

        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn should_ignore_events_without_active_target() {
        let inner = Arc::new(StdMutex::new(InnerState::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        if let Ok(mut state) = inner.lock() {
            state.dispatch_tx = Some(tx);
            state.window_origin = Some((0.0, 0.0));
            state.window_focused = true;
            state.active_target = None;
        }

        process_native_event(
            &inner,
            Event {
                time: SystemTime::now(),
                name: Some("a".to_string()),
                event_type: EventType::KeyPress(Key::KeyA),
            },
        );

        assert!(rx.try_recv().is_err());
    }
}
