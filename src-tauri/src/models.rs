use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

fn default_ssh_port() -> u16 {
    22
}

fn default_connection_protocols() -> Vec<ConnectionProtocol> {
    vec![ConnectionProtocol::Ssh, ConnectionProtocol::Sftp]
}

fn default_connection_kind() -> Option<ConnectionKind> {
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    Host,
    Sftp,
    Both,
}

impl Default for ConnectionKind {
    fn default() -> Self {
        Self::Both
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionProtocol {
    Ssh,
    Sftp,
}

impl Default for ConnectionProtocol {
    fn default() -> Self {
        Self::Ssh
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub keychain_id: Option<String>,
    pub remote_path: Option<String>,
    #[serde(default = "default_connection_protocols")]
    pub protocols: Vec<ConnectionProtocol>,
    #[serde(default = "default_connection_kind")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ConnectionKind>,
}

impl ConnectionProfile {
    pub fn normalize_protocols(&mut self) {
        if self.protocols.is_empty() {
            self.protocols = match self.kind.clone().unwrap_or(ConnectionKind::Both) {
                ConnectionKind::Host => vec![ConnectionProtocol::Ssh],
                ConnectionKind::Sftp => vec![ConnectionProtocol::Sftp],
                ConnectionKind::Both => vec![ConnectionProtocol::Ssh, ConnectionProtocol::Sftp],
            };
        }

        let mut ordered = Vec::new();
        for protocol in &self.protocols {
            if !ordered.contains(protocol) {
                ordered.push(protocol.clone());
            }
        }
        self.protocols = ordered;

        if self.protocols.is_empty() {
            self.protocols = default_connection_protocols();
        }

        self.kind = None;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeychainEntry {
    pub id: String,
    pub name: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub public_key: Option<String>,
    pub passphrase: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EditorPreference {
    Internal,
    Vscode,
    System,
}

impl Default for EditorPreference {
    fn default() -> Self {
        Self::Internal
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModifiedUploadPolicy {
    Auto,
    Ask,
    Manual,
}

impl Default for ModifiedUploadPolicy {
    fn default() -> Self {
        Self::Ask
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub preferred_editor: EditorPreference,
    #[serde(default = "default_external_editor_command")]
    pub external_editor_command: String,
    #[serde(default = "default_sync_auto_enabled")]
    pub sync_auto_enabled: bool,
    #[serde(default = "default_sync_on_startup")]
    pub sync_on_startup: bool,
    #[serde(default = "default_sync_on_settings_change")]
    pub sync_on_settings_change: bool,
    #[serde(default = "default_sync_interval")]
    pub sync_interval_minutes: u32,
    #[serde(default = "default_sftp_chunk_size_kb")]
    pub sftp_chunk_size_kb: u32,
    #[serde(default = "default_inactivity_lock_minutes")]
    pub inactivity_lock_minutes: u32,
    #[serde(default = "default_auto_reconnect_enabled")]
    pub auto_reconnect_enabled: bool,
    #[serde(default = "default_reconnect_delay_seconds")]
    pub reconnect_delay_seconds: u32,
    #[serde(default = "default_terminal_copy_on_select")]
    pub terminal_copy_on_select: bool,
    #[serde(default = "default_terminal_right_click_paste")]
    pub terminal_right_click_paste: bool,
    #[serde(default = "default_terminal_ctrl_shift_shortcuts")]
    pub terminal_ctrl_shift_shortcuts: bool,
    #[serde(default)]
    pub modified_files_upload_policy: ModifiedUploadPolicy,
    #[serde(default = "default_known_hosts_path")]
    pub known_hosts_path: String,
    #[serde(default)]
    pub selected_auth_server_id: Option<String>,
}

fn default_external_editor_command() -> String {
    String::new()
}

fn default_sync_auto_enabled() -> bool {
    true
}

fn default_sync_on_startup() -> bool {
    true
}

fn default_sync_on_settings_change() -> bool {
    false
}

fn default_sync_interval() -> u32 {
    5
}

fn default_sftp_chunk_size_kb() -> u32 {
    1024
}

fn default_inactivity_lock_minutes() -> u32 {
    10
}

fn default_auto_reconnect_enabled() -> bool {
    true
}

fn default_reconnect_delay_seconds() -> u32 {
    5
}

fn default_terminal_copy_on_select() -> bool {
    true
}

fn default_terminal_right_click_paste() -> bool {
    true
}

fn default_terminal_ctrl_shift_shortcuts() -> bool {
    true
}

fn default_known_hosts_path() -> String {
    String::new()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            preferred_editor: EditorPreference::Internal,
            external_editor_command: default_external_editor_command(),
            sync_auto_enabled: default_sync_auto_enabled(),
            sync_on_startup: default_sync_on_startup(),
            sync_on_settings_change: default_sync_on_settings_change(),
            sync_interval_minutes: default_sync_interval(),
            sftp_chunk_size_kb: default_sftp_chunk_size_kb(),
            inactivity_lock_minutes: default_inactivity_lock_minutes(),
            auto_reconnect_enabled: default_auto_reconnect_enabled(),
            reconnect_delay_seconds: default_reconnect_delay_seconds(),
            terminal_copy_on_select: default_terminal_copy_on_select(),
            terminal_right_click_paste: default_terminal_right_click_paste(),
            terminal_ctrl_shift_shortcuts: default_terminal_ctrl_shift_shortcuts(),
            modified_files_upload_policy: ModifiedUploadPolicy::Ask,
            known_hosts_path: default_known_hosts_path(),
            selected_auth_server_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthServer {
    pub id: String,
    pub label: String,
    pub address: String,
    pub author: Option<String>,
    #[serde(default)]
    pub official: bool,
}

impl AuthServer {
    pub fn default_server() -> Self {
        Self {
            id: "default".to_string(),
            label: "TermOpen Official (Cloudflare Worker)".to_string(),
            address: "https://small-band-2a72.marcosbrendonaz.workers.dev".to_string(),
            author: Some("https://github.com/MarcosBrendonDePaula".to_string()),
            official: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncMetadata {
    pub last_sync_at: Option<String>,
    pub last_remote_modified: Option<String>,
    pub last_local_change: i64,
}

impl Default for SyncMetadata {
    fn default() -> Self {
        Self {
            last_sync_at: None,
            last_remote_modified: None,
            last_local_change: chrono::Utc::now().timestamp(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VaultPayload {
    pub version: u32,
    #[serde(default)]
    pub connections: Vec<ConnectionProfile>,
    #[serde(default)]
    pub keychain: Vec<KeychainEntry>,
    #[serde(default)]
    pub settings: AppSettings,
    #[serde(default)]
    pub sync: SyncMetadata,
    #[serde(default)]
    pub auth_servers: Vec<AuthServer>,
    #[serde(default)]
    pub window_state: Option<WindowState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KeyMode {
    Password,
    Keychain,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStatus {
    pub initialized: bool,
    pub locked: bool,
    pub key_mode: Option<KeyMode>,
    #[serde(default)]
    pub recoverable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshSessionInfo {
    pub session_id: String,
    pub profile_id: String,
    pub connected_at: i64,
    #[serde(default = "default_session_kind")]
    pub session_kind: String,
}

fn default_session_kind() -> String {
    "ssh".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: Option<u32>,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BinaryPreviewResult {
    Ready { base64: String, size: u64 },
    TooLarge { size: u64, limit: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub line_raw: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SshConnectResult {
    Connected {
        session: SshSessionInfo,
    },
    UnknownHostChallenge {
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
        known_hosts_path: String,
        message: String,
    },
    AuthRequired {
        message: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncState {
    pub connected: bool,
    pub status: String,
    pub message: String,
    pub last_sync_at: Option<String>,
    pub pending_user_code: Option<String>,
    pub verification_url: Option<String>,
}

impl SyncState {
    pub fn idle(message: impl Into<String>) -> Self {
        Self {
            connected: false,
            status: "idle".to_string(),
            message: message.into(),
            last_sync_at: None,
            pending_user_code: None,
            verification_url: None,
        }
    }

    pub fn ok(message: impl Into<String>, last_sync_at: Option<String>) -> Self {
        Self {
            connected: true,
            status: "ok".to_string(),
            message: message.into(),
            last_sync_at,
            pending_user_code: None,
            verification_url: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            connected: false,
            status: "error".to_string(),
            message: message.into(),
            last_sync_at: None,
            pending_user_code: None,
            verification_url: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncConflictKind {
    Host,
    Keychain,
    Profile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConflictItem {
    pub kind: SyncConflictKind,
    pub id: String,
    pub label: String,
    pub local_hash: Option<String>,
    pub remote_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncConflictPreview {
    #[serde(default)]
    pub conflicts: Vec<SyncConflictItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncKeepSide {
    Client,
    Server,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConflictDecision {
    pub kind: SyncConflictKind,
    pub id: String,
    pub keep: SyncKeepSide,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryProbeResult {
    pub found: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseCheckResult {
    pub available: bool,
    pub latest_version: Option<String>,
    pub url: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProfileBinPayload {
    pub version: u32,
    #[serde(default)]
    pub settings: AppSettings,
    #[serde(default)]
    pub sync: SyncMetadata,
    #[serde(default)]
    pub auth_servers: Vec<AuthServer>,
    #[serde(default)]
    pub window_state: Option<WindowState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ManifestBinPayload {
    pub version: u32,
    #[serde(default)]
    pub hosts: BTreeMap<String, String>,
    #[serde(default)]
    pub keychain: BTreeMap<String, String>,
}
