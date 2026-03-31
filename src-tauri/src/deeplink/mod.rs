use std::io::Result;
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod platform_impl;

#[cfg(not(target_os = "windows"))]
mod platform_impl {
    use std::io::Result;

    pub fn register<F: FnMut(String) + Send + 'static>(_scheme: &str, _handler: F) -> Result<()> {
        Ok(())
    }

    pub fn prepare(_identifier: &str) -> bool {
        false
    }
}

static ID: OnceLock<String> = OnceLock::new();

pub fn register<F: FnMut(String) + Send + 'static>(scheme: &str, handler: F) -> Result<()> {
    platform_impl::register(scheme, handler)
}

pub fn prepare(identifier: &str) -> bool {
    platform_impl::prepare(identifier)
}
