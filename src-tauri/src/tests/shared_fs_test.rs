use std::fs;

use tempfile::tempdir;

use crate::libs::shared_fs::{SharedFsBridge, SharedFsJob, SharedFsProtocol, TransferEndpoint};
use crate::libs::task::TaskManager;
use crate::libs::transfer::TransferJobConfig;

#[test]
fn shared_fs_bridge_stages_and_copies_between_endpoints() {
    let temp = tempdir().expect("tempdir should be created");
    let source_path = temp.path().join("source.txt");
    let target_path = temp.path().join("target.txt");
    fs::write(&source_path, b"openptl-shared-fs").expect("source write should succeed");

    let bridge = SharedFsBridge::new(TaskManager::new(2, 1), TransferJobConfig::default());
    let job = SharedFsJob {
        task_id: "shared-fs-test".to_string(),
        source: TransferEndpoint::new(SharedFsProtocol::Sftp, "sftp"),
        target: TransferEndpoint::new(SharedFsProtocol::Smb, "smb"),
        source_path: source_path.to_string_lossy().to_string(),
        target_path: target_path.to_string_lossy().to_string(),
    };

    let source_clone = source_path.clone();
    let target_clone = target_path.clone();
    let metrics = bridge
        .copy_via_openptl_staging(
            job,
            move |spool, _chunk_size| {
                fs::copy(&source_clone, spool).map_err(|error| error.to_string())
            },
            move |spool, _chunk_size| {
                fs::copy(spool, &target_clone).map_err(|error| error.to_string())
            },
        )
        .expect("copy via shared fs should succeed");

    assert!(metrics.total_bytes > 0);
    let content = fs::read_to_string(&target_path).expect("target should be readable");
    assert_eq!(content, "openptl-shared-fs");
}
