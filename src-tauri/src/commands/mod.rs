pub mod auth;
pub mod debug_logs;
pub mod local_fs;
pub mod rdp;
pub mod remote_fs;
pub mod sftp;
pub mod settings;
pub mod ssh;
pub mod sync;
pub mod vault;
pub mod window;

// Re-export all commands for convenience
pub use auth::*;
pub use debug_logs::*;
pub use local_fs::*;
pub use rdp::*;
pub use remote_fs::*;
pub use sftp::*;
pub use settings::*;
pub use ssh::*;
pub use sync::*;
pub use vault::*;
pub use window::*;
