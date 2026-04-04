#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanCode {
    pub code: u8,
    pub extended: bool,
}

impl ScanCode {
    pub const fn new(code: u8, extended: bool) -> Self {
        Self { code, extended }
    }
}

pub fn web_code_to_scan_code(code: &str) -> Option<ScanCode> {
    match code {
        "KeyA" => Some(ScanCode::new(0x1E, false)),
        "KeyB" => Some(ScanCode::new(0x30, false)),
        "KeyC" => Some(ScanCode::new(0x2E, false)),
        "KeyD" => Some(ScanCode::new(0x20, false)),
        "KeyE" => Some(ScanCode::new(0x12, false)),
        "KeyF" => Some(ScanCode::new(0x21, false)),
        "KeyG" => Some(ScanCode::new(0x22, false)),
        "KeyH" => Some(ScanCode::new(0x23, false)),
        "KeyI" => Some(ScanCode::new(0x17, false)),
        "KeyJ" => Some(ScanCode::new(0x24, false)),
        "KeyK" => Some(ScanCode::new(0x25, false)),
        "KeyL" => Some(ScanCode::new(0x26, false)),
        "KeyM" => Some(ScanCode::new(0x32, false)),
        "KeyN" => Some(ScanCode::new(0x31, false)),
        "KeyO" => Some(ScanCode::new(0x18, false)),
        "KeyP" => Some(ScanCode::new(0x19, false)),
        "KeyQ" => Some(ScanCode::new(0x10, false)),
        "KeyR" => Some(ScanCode::new(0x13, false)),
        "KeyS" => Some(ScanCode::new(0x1F, false)),
        "KeyT" => Some(ScanCode::new(0x14, false)),
        "KeyU" => Some(ScanCode::new(0x16, false)),
        "KeyV" => Some(ScanCode::new(0x2F, false)),
        "KeyW" => Some(ScanCode::new(0x11, false)),
        "KeyX" => Some(ScanCode::new(0x2D, false)),
        "KeyY" => Some(ScanCode::new(0x15, false)),
        "KeyZ" => Some(ScanCode::new(0x2C, false)),
        "Digit0" => Some(ScanCode::new(0x0B, false)),
        "Digit1" => Some(ScanCode::new(0x02, false)),
        "Digit2" => Some(ScanCode::new(0x03, false)),
        "Digit3" => Some(ScanCode::new(0x04, false)),
        "Digit4" => Some(ScanCode::new(0x05, false)),
        "Digit5" => Some(ScanCode::new(0x06, false)),
        "Digit6" => Some(ScanCode::new(0x07, false)),
        "Digit7" => Some(ScanCode::new(0x08, false)),
        "Digit8" => Some(ScanCode::new(0x09, false)),
        "Digit9" => Some(ScanCode::new(0x0A, false)),
        "Minus" => Some(ScanCode::new(0x0C, false)),
        "Equal" => Some(ScanCode::new(0x0D, false)),
        "Backspace" => Some(ScanCode::new(0x0E, false)),
        "Tab" => Some(ScanCode::new(0x0F, false)),
        "BracketLeft" => Some(ScanCode::new(0x1A, false)),
        "BracketRight" => Some(ScanCode::new(0x1B, false)),
        "Enter" => Some(ScanCode::new(0x1C, false)),
        "NumpadEnter" => Some(ScanCode::new(0x1C, true)),
        "ControlLeft" => Some(ScanCode::new(0x1D, false)),
        "ControlRight" => Some(ScanCode::new(0x1D, true)),
        "Semicolon" => Some(ScanCode::new(0x27, false)),
        "Quote" => Some(ScanCode::new(0x28, false)),
        "Backquote" => Some(ScanCode::new(0x29, false)),
        "ShiftLeft" => Some(ScanCode::new(0x2A, false)),
        "Backslash" => Some(ScanCode::new(0x2B, false)),
        "IntlBackslash" => Some(ScanCode::new(0x56, false)),
        "ShiftRight" => Some(ScanCode::new(0x36, false)),
        "AltLeft" => Some(ScanCode::new(0x38, false)),
        "AltRight" => Some(ScanCode::new(0x38, true)),
        "Space" => Some(ScanCode::new(0x39, false)),
        "CapsLock" => Some(ScanCode::new(0x3A, false)),
        "F1" => Some(ScanCode::new(0x3B, false)),
        "F2" => Some(ScanCode::new(0x3C, false)),
        "F3" => Some(ScanCode::new(0x3D, false)),
        "F4" => Some(ScanCode::new(0x3E, false)),
        "F5" => Some(ScanCode::new(0x3F, false)),
        "F6" => Some(ScanCode::new(0x40, false)),
        "F7" => Some(ScanCode::new(0x41, false)),
        "F8" => Some(ScanCode::new(0x42, false)),
        "F9" => Some(ScanCode::new(0x43, false)),
        "F10" => Some(ScanCode::new(0x44, false)),
        "F11" => Some(ScanCode::new(0x57, false)),
        "F12" => Some(ScanCode::new(0x58, false)),
        "NumLock" => Some(ScanCode::new(0x45, false)),
        "ScrollLock" => Some(ScanCode::new(0x46, false)),
        "NumpadMultiply" => Some(ScanCode::new(0x37, false)),
        "NumpadAdd" => Some(ScanCode::new(0x4E, false)),
        "NumpadSubtract" => Some(ScanCode::new(0x4A, false)),
        "NumpadDecimal" => Some(ScanCode::new(0x53, false)),
        "NumpadDivide" => Some(ScanCode::new(0x35, true)),
        "Numpad0" => Some(ScanCode::new(0x52, false)),
        "Numpad1" => Some(ScanCode::new(0x4F, false)),
        "Numpad2" => Some(ScanCode::new(0x50, false)),
        "Numpad3" => Some(ScanCode::new(0x51, false)),
        "Numpad4" => Some(ScanCode::new(0x4B, false)),
        "Numpad5" => Some(ScanCode::new(0x4C, false)),
        "Numpad6" => Some(ScanCode::new(0x4D, false)),
        "Numpad7" => Some(ScanCode::new(0x47, false)),
        "Numpad8" => Some(ScanCode::new(0x48, false)),
        "Numpad9" => Some(ScanCode::new(0x49, false)),
        "Comma" => Some(ScanCode::new(0x33, false)),
        "Period" => Some(ScanCode::new(0x34, false)),
        "Slash" => Some(ScanCode::new(0x35, false)),
        "Escape" => Some(ScanCode::new(0x01, false)),
        "ArrowUp" => Some(ScanCode::new(0x48, true)),
        "ArrowDown" => Some(ScanCode::new(0x50, true)),
        "ArrowLeft" => Some(ScanCode::new(0x4B, true)),
        "ArrowRight" => Some(ScanCode::new(0x4D, true)),
        "Insert" => Some(ScanCode::new(0x52, true)),
        "Delete" => Some(ScanCode::new(0x53, true)),
        "Home" => Some(ScanCode::new(0x47, true)),
        "End" => Some(ScanCode::new(0x4F, true)),
        "PageUp" => Some(ScanCode::new(0x49, true)),
        "PageDown" => Some(ScanCode::new(0x51, true)),
        "ContextMenu" => Some(ScanCode::new(0x5D, true)),
        "MetaLeft" => Some(ScanCode::new(0x5B, true)),
        "MetaRight" => Some(ScanCode::new(0x5C, true)),
        _ => None,
    }
}

pub fn pressed_modifier_scan_codes(
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
) -> Vec<ScanCode> {
    let mut output = Vec::with_capacity(4);
    if ctrl {
        output.push(ScanCode::new(0x1D, false));
    }
    if alt {
        output.push(ScanCode::new(0x38, false));
    }
    if shift {
        output.push(ScanCode::new(0x2A, false));
    }
    if meta {
        output.push(ScanCode::new(0x5B, true));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{pressed_modifier_scan_codes, web_code_to_scan_code};

    #[test]
    fn should_map_function_keys() {
        let f5 = web_code_to_scan_code("F5");
        assert!(f5.is_some());
        assert_eq!(f5.expect("F5").code, 0x3F);
    }

    #[test]
    fn should_map_navigation_as_extended() {
        let home = web_code_to_scan_code("Home").expect("Home");
        assert_eq!(home.code, 0x47);
        assert!(home.extended);
    }

    #[test]
    fn should_build_modifiers_in_stable_order() {
        let modifiers = pressed_modifier_scan_codes(true, true, true, true);
        assert_eq!(modifiers.len(), 4);
        assert_eq!(modifiers[0].code, 0x1D);
        assert_eq!(modifiers[1].code, 0x38);
        assert_eq!(modifiers[2].code, 0x2A);
        assert_eq!(modifiers[3].code, 0x5B);
    }
}
