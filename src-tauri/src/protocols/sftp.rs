#![allow(dead_code)]

use anyhow::{anyhow, Result};

use crate::libs::models::SftpEntry;

use super::ssh::SshManager;

/// Thin adapter for SFTP session operations.
///
/// This module exists so the app can evolve protocol adapters independently
/// while keeping a stable high-level API for transfer orchestration.
pub async fn list(
    manager: &mut SshManager,
    session_id: &str,
    path: &str,
) -> Result<Vec<SftpEntry>> {
    manager.sftp_list(session_id, path).await
}

pub async fn read(
    manager: &mut SshManager,
    session_id: &str,
    path: &str,
    chunk_size: usize,
) -> Result<String> {
    manager.sftp_read(session_id, path, chunk_size).await
}

pub async fn read_chunk(
    manager: &mut SshManager,
    session_id: &str,
    path: &str,
    offset: u64,
    chunk_size: usize,
) -> Result<(Vec<u8>, u64, bool)> {
    manager
        .sftp_read_chunk(session_id, path, offset, chunk_size)
        .await
}

pub async fn write(
    manager: &mut SshManager,
    session_id: &str,
    path: &str,
    content: &str,
    chunk_size: usize,
) -> Result<()> {
    manager.sftp_write(session_id, path, content, chunk_size).await
}

pub fn ensure_supported_session_id(session_id: &str) -> Result<()> {
    if session_id.trim().is_empty() {
        return Err(anyhow!("SFTP session_id invalido."));
    }
    Ok(())
}

