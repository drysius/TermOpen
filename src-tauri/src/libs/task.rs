#![allow(dead_code)]

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{broadcast, Semaphore};
use uuid::Uuid;

pub type TaskId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskProtocol {
    Generic,
    Local,
    Sftp,
    Ftp,
    Ftps,
    Smb,
    Rdp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Queued,
    Running,
    Completed,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdate {
    pub id: TaskId,
    pub protocol: TaskProtocol,
    pub state: TaskState,
    pub message: Option<String>,
    pub progress: Option<u8>,
}

#[derive(Debug, Clone)]
pub struct TaskCancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl TaskCancellationToken {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Debug)]
pub struct TaskHandle {
    pub id: TaskId,
    pub protocol: TaskProtocol,
    token: TaskCancellationToken,
    updates: broadcast::Receiver<TaskUpdate>,
}

impl TaskHandle {
    pub fn cancel(&self) {
        self.token.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    pub fn updates(&self) -> broadcast::Receiver<TaskUpdate> {
        self.updates.resubscribe()
    }
}

#[derive(Debug, Clone)]
pub struct TaskContext {
    id: TaskId,
    protocol: TaskProtocol,
    token: TaskCancellationToken,
    updates: broadcast::Sender<TaskUpdate>,
}

impl TaskContext {
    pub fn id(&self) -> &str {
        self.id.as_str()
    }

    pub fn protocol(&self) -> TaskProtocol {
        self.protocol
    }

    pub fn token(&self) -> TaskCancellationToken {
        self.token.clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    pub fn emit_progress(&self, progress: u8) {
        let _ = self.updates.send(TaskUpdate {
            id: self.id.clone(),
            protocol: self.protocol,
            state: TaskState::Running,
            message: None,
            progress: Some(progress.min(100)),
        });
    }

    pub async fn run_blocking<T, F>(&self, work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, String> + Send + 'static,
    {
        tokio::task::spawn_blocking(work)
            .await
            .map_err(|error| format!("Falha ao aguardar tarefa bloqueante: {}", error))?
    }
}

#[derive(Debug, Clone)]
pub struct TaskManager {
    global_limit: Arc<Semaphore>,
    protocol_limits: Arc<HashMap<TaskProtocol, Arc<Semaphore>>>,
    updates: broadcast::Sender<TaskUpdate>,
}

impl Default for TaskManager {
    fn default() -> Self {
        Self::new(4, 2)
    }
}

impl TaskManager {
    pub fn new(global_limit: usize, per_protocol_limit: usize) -> Self {
        let mut protocol_limits = HashMap::new();
        for protocol in [
            TaskProtocol::Generic,
            TaskProtocol::Local,
            TaskProtocol::Sftp,
            TaskProtocol::Ftp,
            TaskProtocol::Ftps,
            TaskProtocol::Smb,
            TaskProtocol::Rdp,
        ] {
            protocol_limits.insert(protocol, Arc::new(Semaphore::new(per_protocol_limit.max(1))));
        }

        let (updates, _) = broadcast::channel(256);
        Self {
            global_limit: Arc::new(Semaphore::new(global_limit.max(1))),
            protocol_limits: Arc::new(protocol_limits),
            updates,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TaskUpdate> {
        self.updates.subscribe()
    }

    pub fn spawn<F, Fut>(&self, protocol: TaskProtocol, task: F) -> TaskHandle
    where
        F: FnOnce(TaskContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        let id = Uuid::new_v4().to_string();
        let token = TaskCancellationToken::new();
        let updates_for_task = self.updates.clone();
        let updates_for_handle = self.updates.subscribe();

        let _ = updates_for_task.send(TaskUpdate {
            id: id.clone(),
            protocol,
            state: TaskState::Queued,
            message: None,
            progress: Some(0),
        });

        let global_limit = self.global_limit.clone();
        let protocol_limit = self
            .protocol_limits
            .get(&protocol)
            .cloned()
            .or_else(|| self.protocol_limits.get(&TaskProtocol::Generic).cloned())
            .unwrap_or_else(|| Arc::new(Semaphore::new(1)));
        let id_for_task = id.clone();
        let token_for_task = token.clone();

        tokio::spawn(async move {
            let Ok(_global_permit) = global_limit.acquire_owned().await else {
                return;
            };
            let Ok(_protocol_permit) = protocol_limit.acquire_owned().await else {
                return;
            };

            if token_for_task.is_cancelled() {
                let _ = updates_for_task.send(TaskUpdate {
                    id: id_for_task.clone(),
                    protocol,
                    state: TaskState::Cancelled,
                    message: Some("Tarefa cancelada antes de iniciar.".to_string()),
                    progress: Some(0),
                });
                return;
            }

            let _ = updates_for_task.send(TaskUpdate {
                id: id_for_task.clone(),
                protocol,
                state: TaskState::Running,
                message: None,
                progress: Some(0),
            });

            let context = TaskContext {
                id: id_for_task.clone(),
                protocol,
                token: token_for_task.clone(),
                updates: updates_for_task.clone(),
            };

            let result = task(context.clone()).await;
            let update = if context.is_cancelled() {
                TaskUpdate {
                    id: id_for_task,
                    protocol,
                    state: TaskState::Cancelled,
                    message: Some("Tarefa cancelada.".to_string()),
                    progress: None,
                }
            } else {
                match result {
                    Ok(()) => TaskUpdate {
                        id: id_for_task,
                        protocol,
                        state: TaskState::Completed,
                        message: None,
                        progress: Some(100),
                    },
                    Err(message) => TaskUpdate {
                        id: id_for_task,
                        protocol,
                        state: TaskState::Error,
                        message: Some(message),
                        progress: None,
                    },
                }
            };

            let _ = updates_for_task.send(update);
        });

        TaskHandle {
            id,
            protocol,
            token,
            updates: updates_for_handle,
        }
    }
}
