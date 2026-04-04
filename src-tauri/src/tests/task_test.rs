use std::time::Duration;

use tokio::time::timeout;

use crate::libs::task::{TaskManager, TaskProtocol, TaskState};

#[tokio::test]
async fn task_manager_runs_and_emits_completed_state() {
    let manager = TaskManager::new(2, 1);
    let handle = manager.spawn(TaskProtocol::Sftp, |_context| async move { Ok(()) });
    let mut updates = handle.updates();

    let mut final_state = None;
    for _ in 0..8 {
        let next = timeout(Duration::from_secs(2), updates.recv())
            .await
            .expect("task update timed out")
            .expect("broadcast channel should stay open");
        if next.id == handle.id && matches!(next.state, TaskState::Completed | TaskState::Error) {
            final_state = Some(next.state);
            break;
        }
    }

    assert_eq!(final_state, Some(TaskState::Completed));
}
