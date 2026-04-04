//! App-level constants shared across commands, runtime modules and protocol adapters.

use std::time::Duration;

/// Primary deep-link scheme handled by the desktop app.
pub const OPENPTL_SCHEME: &str = "openptl";

/// URL used to query the latest release metadata.
pub const RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/urubucode/OpenPtl/releases/latest";

/// User-Agent sent during release checks.
pub const RELEASE_CHECK_USER_AGENT: &str = "OpenPtl-Updater";

/// Remote JSON list of authentication servers.
pub const AUTH_SERVERS_REMOTE_URL: &str =
    "https://raw.githubusercontent.com/urubucode/OpenPtl/main/auth-servers.json";

/// Local fallback list bundled with the application.
pub const AUTH_SERVERS_LOCAL_FALLBACK_JSON: &str = include_str!("../../auth-servers.json");

/// Temporary directory name used by the external editor bridge.
pub const EXTERNAL_EDITOR_TEMP_DIR: &str = "openptl-editor";

/// Default filename used when no valid filename is provided.
pub const DEFAULT_EXTERNAL_FILE_NAME: &str = "openptl-file.txt";

/// Default suffix used when generating SSH key comments.
pub const DEFAULT_SSH_KEY_COMMENT: &str = "openptl-generated";

/// Default SFTP chunk size in kilobytes.
pub const DEFAULT_SFTP_CHUNK_SIZE_KB: u32 = 1024;
/// Minimum allowed SFTP chunk size in kilobytes.
pub const MIN_SFTP_CHUNK_SIZE_KB: u32 = 64;
/// Maximum allowed SFTP chunk size in kilobytes.
pub const MAX_SFTP_CHUNK_SIZE_KB: u32 = 8192;

/// Default viewport width for new workspace windows.
pub const DEFAULT_WORKSPACE_WIDTH: f64 = 1440.0;
/// Default viewport height for new workspace windows.
pub const DEFAULT_WORKSPACE_HEIGHT: f64 = 900.0;
/// Minimum allowed workspace width when restoring state.
pub const MIN_WORKSPACE_WIDTH: u32 = 480;
/// Minimum allowed workspace height when restoring state.
pub const MIN_WORKSPACE_HEIGHT: u32 = 800;
/// Legacy compact width previously used by older builds.
pub const LEGACY_COMPACT_WIDTH: u32 = 480;
/// Legacy compact height previously used by older builds.
pub const LEGACY_COMPACT_HEIGHT: u32 = 800;

/// Maximum entries kept in the in-memory debug log ring buffer.
pub const DEBUG_LOG_CAPACITY: usize = 2000;

/// Default RDP port when omitted by the user.
pub const DEFAULT_RDP_PORT: u16 = 3389;
/// Default RDP render width.
pub const DEFAULT_RDP_WIDTH: u16 = 1280;
/// Default RDP render height.
pub const DEFAULT_RDP_HEIGHT: u16 = 720;
/// Minimum accepted RDP dimension.
pub const MIN_RDP_DIMENSION: u16 = 320;
/// Maximum accepted RDP dimension.
pub const MAX_RDP_DIMENSION: u16 = 3840;

/// Default upper limit for binary preview responses.
pub const DEFAULT_BINARY_PREVIEW_LIMIT_BYTES: u64 = 25 * 1024 * 1024;

/// Shared keyring service namespace.
pub const APP_KEYRING_SERVICE: &str = "com.urubucode.openptl";

/// Key name used to persist encrypted vault key material in OS keyring.
pub const KEYRING_VAULT_KEY: &str = "vault-key";
/// Key name used to persist Google refresh token.
pub const KEYRING_REFRESH_TOKEN: &str = "google-drive-refresh-token";
/// Key name used to persist synced Google user e-mail.
pub const KEYRING_USER_EMAIL: &str = "google-user-email";
/// Key name used to persist synced Google user name.
pub const KEYRING_USER_NAME: &str = "google-user-name";
/// Key name used to persist synced Google user avatar URL.
pub const KEYRING_USER_PICTURE: &str = "google-user-picture";

/// Root folder name for encrypted local storage payload.
pub const STORAGE_DIR_NAME: &str = "OpenPtl";
/// Main encrypted metadata file.
pub const OPENPTL_FILE_NAME: &str = "openptl.bin";
/// Encrypted profile payload file.
pub const PROFILE_FILE_NAME: &str = "profile.bin";
/// Encrypted manifest payload file.
pub const MANIFEST_FILE_NAME: &str = "manifest.bin";
/// File extension expected for encrypted payload files.
pub const STORAGE_FILE_EXTENSION: &str = "bin";

/// Current vault metadata file version.
pub const CURRENT_STORAGE_VERSION: u32 = 1;
/// Current encrypted payload schema version.
pub const CURRENT_PAYLOAD_VERSION: u32 = 1;

/// Google Drive mime type used for folder lookups/creation.
pub const DRIVE_FOLDER_MIME_TYPE: &str = "application/vnd.google-apps.folder";
/// Google Drive root folder name for OpenPtl sync data.
pub const DRIVE_ROOT_FOLDER_NAME: &str = "OpenPtl";
/// Google Drive top parent folder id.
pub const DRIVE_TOP_PARENT_ID: &str = "root";

/// Timeout used while waiting for auth deep-link callbacks.
pub const AUTH_DEEPLINK_TIMEOUT: Duration = Duration::from_secs(300);

/// Default FTP control port.
pub const FTP_DEFAULT_PORT: u16 = 21;
/// Default SMB port.
pub const SMB_DEFAULT_PORT: u16 = 445;
