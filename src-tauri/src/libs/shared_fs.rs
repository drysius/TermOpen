#![allow(dead_code)]

use std::path::Path;

use crate::libs::remote_fs;
use crate::libs::task::{TaskHandle, TaskManager, TaskProtocol, TaskState, TaskUpdate};
use crate::libs::transfer::{TransferJobConfig, TransferMetrics};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SharedFsProtocol {
    Local,
    Sftp,
    Ftp,
    Ftps,
    Smb,
    RdpUpload,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEndpoint {
    pub protocol: SharedFsProtocol,
    pub label: String,
    pub can_read: bool,
    pub can_write: bool,
    pub can_list: bool,
    pub can_stat: bool,
}

impl TransferEndpoint {
    pub fn new(protocol: SharedFsProtocol, label: impl Into<String>) -> Self {
        Self {
            protocol,
            label: label.into(),
            can_read: true,
            can_write: true,
            can_list: true,
            can_stat: true,
        }
    }

    pub fn for_rdp_upload(label: impl Into<String>) -> Self {
        Self {
            protocol: SharedFsProtocol::RdpUpload,
            label: label.into(),
            can_read: false,
            can_write: true,
            can_list: false,
            can_stat: false,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFsJob {
    pub task_id: String,
    pub source: TransferEndpoint,
    pub target: TransferEndpoint,
    pub source_path: String,
    pub target_path: String,
}

impl SharedFsJob {
    pub fn to_task_protocol(&self) -> TaskProtocol {
        match self.source.protocol {
            SharedFsProtocol::Local => TaskProtocol::Local,
            SharedFsProtocol::Sftp => TaskProtocol::Sftp,
            SharedFsProtocol::Ftp => TaskProtocol::Ftp,
            SharedFsProtocol::Ftps => TaskProtocol::Ftps,
            SharedFsProtocol::Smb => TaskProtocol::Smb,
            SharedFsProtocol::RdpUpload => TaskProtocol::Rdp,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SharedFsBridge {
    task_manager: TaskManager,
    transfer_config: TransferJobConfig,
}

impl SharedFsBridge {
    pub fn new(task_manager: TaskManager, transfer_config: TransferJobConfig) -> Self {
        Self {
            task_manager,
            transfer_config,
        }
    }

    pub fn task_manager(&self) -> &TaskManager {
        &self.task_manager
    }

    pub fn transfer_config(&self) -> TransferJobConfig {
        self.transfer_config
    }

    pub fn copy_via_openptl_staging<Download, Upload>(
        &self,
        job: SharedFsJob,
        mut download_to_spool: Download,
        mut upload_from_spool: Upload,
    ) -> Result<TransferMetrics, String>
    where
        Download: FnMut(&Path, usize) -> Result<u64, String>,
        Upload: FnMut(&Path, usize) -> Result<u64, String>,
    {
        let area = remote_fs::prepare_staging_area(job.task_id.as_str())
            .map_err(|error| error.to_string())?;
        let chunk_size = self.transfer_config.initial_chunk_size;

        let downloaded = download_to_spool(&area.spool_file, chunk_size)?;
        let _manifest =
            remote_fs::fragment_spool(&area, chunk_size).map_err(|error| error.to_string())?;
        let uploaded = upload_from_spool(&area.spool_file, chunk_size)?;

        let _ = remote_fs::cleanup_task_cache(job.task_id.as_str());

        Ok(TransferMetrics {
            total_bytes: downloaded.saturating_add(uploaded),
            total_chunks: 0,
            current_chunk_size: chunk_size,
            average_throughput_bps: 0.0,
            last_rtt_ms: 0.0,
            peak_inflight_bytes: self.transfer_config.inflight_limit_bytes,
        })
    }

    pub async fn copy_via_openptl_staging_async<Download, Upload, DownloadFuture, UploadFuture>(
        &self,
        job: SharedFsJob,
        mut download_to_spool: Download,
        mut upload_from_spool: Upload,
    ) -> Result<TransferMetrics, String>
    where
        Download: FnMut(&Path, usize) -> DownloadFuture,
        Upload: FnMut(&Path, usize) -> UploadFuture,
        DownloadFuture: std::future::Future<Output = Result<u64, String>>,
        UploadFuture: std::future::Future<Output = Result<u64, String>>,
    {
        let area = remote_fs::prepare_staging_area(job.task_id.as_str())
            .map_err(|error| error.to_string())?;
        let chunk_size = self.transfer_config.initial_chunk_size;

        let downloaded = download_to_spool(&area.spool_file, chunk_size).await?;
        let _manifest =
            remote_fs::fragment_spool(&area, chunk_size).map_err(|error| error.to_string())?;
        let uploaded = upload_from_spool(&area.spool_file, chunk_size).await?;

        let _ = remote_fs::cleanup_task_cache(job.task_id.as_str());

        Ok(TransferMetrics {
            total_bytes: downloaded.saturating_add(uploaded),
            total_chunks: 0,
            current_chunk_size: chunk_size,
            average_throughput_bps: 0.0,
            last_rtt_ms: 0.0,
            peak_inflight_bytes: self.transfer_config.inflight_limit_bytes,
        })
    }

    pub fn spawn_copy_task<Download, Upload>(
        &self,
        job: SharedFsJob,
        download_to_spool: Download,
        upload_from_spool: Upload,
    ) -> TaskHandle
    where
        Download: FnMut(&Path, usize) -> Result<u64, String> + Send + 'static,
        Upload: FnMut(&Path, usize) -> Result<u64, String> + Send + 'static,
    {
        let bridge = self.clone();
        let protocol = job.to_task_protocol();
        self.task_manager.spawn(protocol, move |context| async move {
            let task_id = context.id().to_string();
            let mut task_job = job;
            task_job.task_id = task_id.clone();
            let download = download_to_spool;
            let upload = upload_from_spool;

            let result = context
                .run_blocking(move || bridge.copy_via_openptl_staging(task_job, download, upload))
                .await;

            match result {
                Ok(_metrics) => {
                    context.emit_progress(100);
                    Ok(())
                }
                Err(message) => Err(message),
            }
        })
    }
}

pub fn map_task_update_to_transfer_state(update: &TaskUpdate) -> &'static str {
    match update.state {
        TaskState::Queued => "queued",
        TaskState::Running => "running",
        TaskState::Completed => "completed",
        TaskState::Error => "error",
        TaskState::Cancelled => "cancelled",
    }
}
