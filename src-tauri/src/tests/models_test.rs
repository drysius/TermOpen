use crate::libs::models::{AppSettings, KeychainEntry, KeychainEntryType};

#[test]
fn should_default_terminal_interaction_settings() {
    let settings = AppSettings::default();
    assert!(settings.terminal_copy_on_select);
    assert!(settings.terminal_right_click_paste);
    assert!(settings.terminal_ctrl_shift_shortcuts);
    assert!(!settings.debug_logs_enabled);
    assert_eq!(settings.sftp_reconnect_delay_seconds, 5);
}

#[test]
fn should_serialize_keychain_password_field() {
    let entry = KeychainEntry {
        id: "a0f1f421-d7a7-4416-8f34-c8f6a4f84ff9".to_string(),
        name: "shared".to_string(),
        entry_type: KeychainEntryType::Password,
        password: Some("super-secret".to_string()),
        private_key: None,
        public_key: None,
        passphrase: None,
        created_at: 1_710_000_000,
    };
    let json = serde_json::to_value(&entry).expect("keychain should serialize");
    let password = json
        .get("password")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    assert_eq!(password, "super-secret");
}

