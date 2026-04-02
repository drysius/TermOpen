use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::atomic::{AtomicBool, Ordering},
    sync::{Mutex as StdMutex, OnceLock},
};
use tauri::Emitter;
#[cfg(not(target_os = "windows"))]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(not(target_os = "windows"))]
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::{
    models::{
        RecoveryProbeResult, SyncConflictDecision, SyncConflictItem, SyncConflictKind,
        SyncConflictPreview, SyncKeepSide, SyncLoggedUser, SyncState, VaultStatus,
    },
    vault::VaultManager,
};

const KEYRING_SERVICE: &str = "com.urubucode.termopen";
const KEYRING_REFRESH_TOKEN: &str = "google-drive-refresh-token";
const KEYRING_USER_EMAIL: &str = "google-user-email";
const KEYRING_USER_NAME: &str = "google-user-name";
const KEYRING_USER_PICTURE: &str = "google-user-picture";
const DRIVE_FOLDER_MIME_TYPE: &str = "application/vnd.google-apps.folder";
const DRIVE_ROOT_FOLDER_NAME: &str = "TermOpen";
const DRIVE_TOP_PARENT_ID: &str = "root";
const AUTH_DEEPLINK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

const TERM_OPEN_FILE_NAME: &str = "term-open.bin";
const PROFILE_FILE_NAME: &str = "profile.bin";
const MANIFEST_FILE_NAME: &str = "manifest.bin";

struct AuthCallbackQueue {
    queue: StdMutex<VecDeque<CallbackAuthData>>,
    notify: Notify,
}

static AUTH_CALLBACK_QUEUE: OnceLock<AuthCallbackQueue> = OnceLock::new();
static SYNC_CANCELLED: AtomicBool = AtomicBool::new(false);
static SYNC_CANCEL_NOTIFY: OnceLock<Notify> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
struct SyncProgressPayload {
    percent: u8,
    stage: String,
    current_file: Option<String>,
    processed: u32,
    total: u32,
}

fn emit_sync_progress(
    app: &tauri::AppHandle,
    stage: &str,
    current_file: Option<&str>,
    processed: usize,
    total: usize,
) {
    let bounded_processed = processed.min(total);
    let percent = if total == 0 {
        100
    } else {
        ((bounded_processed * 100) / total).min(100) as u8
    };
    let payload = SyncProgressPayload {
        percent,
        stage: stage.to_string(),
        current_file: current_file.map(|value| value.to_string()),
        processed: bounded_processed as u32,
        total: total as u32,
    };
    app.emit("sync:progress", payload).ok();
}

fn auth_callback_queue() -> &'static AuthCallbackQueue {
    AUTH_CALLBACK_QUEUE.get_or_init(|| AuthCallbackQueue {
        queue: StdMutex::new(VecDeque::new()),
        notify: Notify::new(),
    })
}

fn sync_cancel_notify() -> &'static Notify {
    SYNC_CANCEL_NOTIFY.get_or_init(Notify::new)
}

fn clear_sync_cancel() {
    SYNC_CANCELLED.store(false, Ordering::Relaxed);
}

fn is_sync_cancelled() -> bool {
    SYNC_CANCELLED.load(Ordering::Relaxed)
}

async fn wait_for_sync_cancel() {
    let notify = sync_cancel_notify();
    loop {
        if is_sync_cancelled() {
            return;
        }
        notify.notified().await;
    }
}

fn cancelled_state() -> SyncState {
    SyncState::idle("Sincronizacao cancelada pelo usuario.")
}

pub fn request_sync_cancel() -> SyncState {
    SYNC_CANCELLED.store(true, Ordering::Relaxed);
    sync_cancel_notify().notify_waiters();
    cancelled_state()
}

#[derive(Default)]
pub struct SyncManager;

impl SyncManager {
    pub fn new() -> Self {
        Self
    }

    pub fn clear_local_auth(&self) {
        delete_keyring_field(KEYRING_REFRESH_TOKEN);
        delete_keyring_field(KEYRING_USER_EMAIL);
        delete_keyring_field(KEYRING_USER_NAME);
        delete_keyring_field(KEYRING_USER_PICTURE);
    }

    pub async fn google_login(
        &mut self,
        app: &tauri::AppHandle,
        server_address: &str,
    ) -> Result<SyncState> {
        clear_sync_cancel();
        let pending = SyncState {
            connected: false,
            status: "running".to_string(),
            message: "Abrindo navegador para login com Google...".to_string(),
            last_sync_at: None,
            pending_user_code: None,
            verification_url: None,
        };
        app.emit("sync:status", &pending).ok();

        #[cfg(target_os = "windows")]
        {
            clear_auth_callback_queue();
            let login_url = format!("{}/auth/google", server_address);
            open::that_detached(&login_url).context("Falha ao abrir navegador para login")?;
            let result = tokio::select! {
                result = tokio::time::timeout(AUTH_DEEPLINK_TIMEOUT, wait_for_auth_callback()) => {
                    finalize_auth_result(app, result)?
                }
                _ = wait_for_sync_cancel() => {
                    let state = cancelled_state();
                    app.emit("sync:status", &state).ok();
                    state
                }
            };
            return Ok(result);
        }

        #[cfg(not(target_os = "windows"))]
        {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .context("Falha ao abrir porta local para callback")?;
            let local_port = listener.local_addr()?.port();
            let callback_url = format!("http://localhost:{}/callback", local_port);
            let login_url = format!(
                "{}/auth/google?local_callback={}",
                server_address,
                urlencoding::encode(&callback_url)
            );

            open::that_detached(&login_url).context("Falha ao abrir navegador para login")?;
            let result = tokio::select! {
                result = tokio::time::timeout(AUTH_DEEPLINK_TIMEOUT, wait_for_callback(&listener)) => {
                    finalize_auth_result(app, result)?
                }
                _ = wait_for_sync_cancel() => {
                    let state = cancelled_state();
                    app.emit("sync:status", &state).ok();
                    state
                }
            };
            return Ok(result);
        }
    }

    pub fn logged_user(&self) -> Option<SyncLoggedUser> {
        let email = load_user_field(KEYRING_USER_EMAIL)
            .ok()
            .filter(|value| !value.trim().is_empty());
        let name = load_user_field(KEYRING_USER_NAME)
            .ok()
            .filter(|value| !value.trim().is_empty());
        let picture_url = load_user_field(KEYRING_USER_PICTURE)
            .ok()
            .filter(|value| !value.trim().is_empty());

        if email.is_none() && name.is_none() && picture_url.is_none() {
            return None;
        }

        Some(SyncLoggedUser {
            name,
            email,
            picture_url,
        })
    }

    pub async fn push(
        &mut self,
        app: &tauri::AppHandle,
        vault: &mut VaultManager,
        server_address: &str,
        fallback_addresses: &[String],
    ) -> Result<SyncState> {
        clear_sync_cancel();
        let access_token =
            access_token_from_refresh_with_fallback(server_address, fallback_addresses).await?;
        if is_sync_cancelled() {
            let state = cancelled_state();
            app.emit("sync:status", &state).ok();
            return Ok(state);
        }

        let client = Client::new();
        let folder_id = ensure_termopen_folder(&client, &access_token, true)
            .await?
            .ok_or_else(|| anyhow!("Falha ao preparar pasta TermOpen no Google Drive"))?;
        let remote_files = list_drive_bin_files(&client, &access_token, &folder_id).await?;

        let local_files = vault.list_local_bin_files()?;
        let mut local_names = HashSet::new();
        for (name, _) in &local_files {
            local_names.insert(name.clone());
        }
        let stale_remote_count = remote_files
            .keys()
            .filter(|name| !local_names.contains(*name))
            .count();
        let total_steps = local_files.len() + stale_remote_count;
        let mut processed_steps = 0usize;
        emit_sync_progress(app, "uploading", None, processed_steps, total_steps);

        for (name, bytes) in local_files {
            if let Some(existing) = remote_files.get(&name) {
                upload_file_bytes(&client, &access_token, &existing.id, bytes).await?;
            } else {
                let created = create_drive_file(&client, &access_token, &folder_id, &name).await?;
                upload_file_bytes(&client, &access_token, &created.id, bytes).await?;
            }
            processed_steps = processed_steps.saturating_add(1);
            emit_sync_progress(
                app,
                "uploading",
                Some(name.as_str()),
                processed_steps,
                total_steps,
            );
        }

        for (name, metadata) in remote_files {
            if !local_names.contains(&name) {
                delete_drive_file(&client, &access_token, &metadata.id).await?;
                processed_steps = processed_steps.saturating_add(1);
                emit_sync_progress(
                    app,
                    "cleaning_remote",
                    Some(name.as_str()),
                    processed_steps,
                    total_steps,
                );
            }
        }

        let now = Utc::now();
        let mut metadata = vault.sync_metadata()?;
        metadata.last_remote_modified = Some(now.to_rfc3339());
        metadata.last_sync_at = Some(now.to_rfc3339());
        metadata.last_local_change = now.timestamp();
        vault.set_sync_metadata(metadata.clone())?;

        let state = SyncState::ok(
            "Arquivos enviados para o Google Drive com sucesso.",
            metadata.last_sync_at,
        );
        emit_sync_progress(app, "complete", None, total_steps, total_steps);
        app.emit("sync:status", &state).ok();
        Ok(state)
    }

    pub async fn pull(
        &mut self,
        app: &tauri::AppHandle,
        vault: &mut VaultManager,
        server_address: &str,
        fallback_addresses: &[String],
    ) -> Result<SyncState> {
        clear_sync_cancel();
        let access_token =
            access_token_from_refresh_with_fallback(server_address, fallback_addresses).await?;
        if is_sync_cancelled() {
            let state = cancelled_state();
            app.emit("sync:status", &state).ok();
            return Ok(state);
        }

        let client = Client::new();
        let Some(folder_id) = ensure_termopen_folder(&client, &access_token, false).await? else {
            let state = SyncState::idle("Nenhum backup encontrado no Google Drive.");
            app.emit("sync:status", &state).ok();
            return Ok(state);
        };

        let remote_files = list_drive_bin_files(&client, &access_token, &folder_id).await?;
        if !remote_files.contains_key(TERM_OPEN_FILE_NAME)
            || !remote_files.contains_key(PROFILE_FILE_NAME)
            || !remote_files.contains_key(MANIFEST_FILE_NAME)
        {
            let state = SyncState::idle("Backup remoto incompleto: faltam arquivos base.");
            app.emit("sync:status", &state).ok();
            return Ok(state);
        }

        let total_steps = remote_files.len();
        let mut processed_steps = 0usize;
        emit_sync_progress(app, "downloading", None, processed_steps, total_steps);
        let mut snapshot = HashMap::new();
        for (name, metadata) in &remote_files {
            let bytes = download_file_bytes(&client, &access_token, &metadata.id).await?;
            snapshot.insert(name.clone(), bytes);
            processed_steps = processed_steps.saturating_add(1);
            emit_sync_progress(
                app,
                "downloading",
                Some(name.as_str()),
                processed_steps,
                total_steps,
            );
        }

        vault.replace_local_files(&snapshot)?;

        let now = Utc::now();
        let mut next_metadata = vault.sync_metadata()?;
        next_metadata.last_sync_at = Some(now.to_rfc3339());
        next_metadata.last_remote_modified = Some(now.to_rfc3339());
        next_metadata.last_local_change = now.timestamp();
        vault.set_sync_metadata(next_metadata.clone())?;

        let state = SyncState::ok(
            "Arquivos baixados do Google Drive com sucesso.",
            next_metadata.last_sync_at,
        );
        emit_sync_progress(app, "complete", None, total_steps, total_steps);
        app.emit("sync:status", &state).ok();
        Ok(state)
    }

    pub async fn startup_conflicts(
        &mut self,
        vault: &VaultManager,
        server_address: &str,
        fallback_addresses: &[String],
    ) -> Result<SyncConflictPreview> {
        let access_token =
            access_token_from_refresh_with_fallback(server_address, fallback_addresses).await?;
        let client = Client::new();

        let Some(folder_id) = ensure_termopen_folder(&client, &access_token, false).await? else {
            return Ok(SyncConflictPreview::default());
        };

        let remote_files = list_drive_bin_files(&client, &access_token, &folder_id).await?;
        let Some(remote_manifest_meta) = remote_files.get(MANIFEST_FILE_NAME) else {
            return Ok(SyncConflictPreview::default());
        };

        let remote_manifest_bytes =
            download_file_bytes(&client, &access_token, &remote_manifest_meta.id).await?;

        let remote_manifest = vault.decrypt_manifest_bytes(&remote_manifest_bytes)?;
        let local_manifest = vault.local_manifest_snapshot()?;

        let mut conflicts = Vec::new();

        let mut host_ids = HashSet::new();
        host_ids.extend(local_manifest.hosts.keys().cloned());
        host_ids.extend(remote_manifest.hosts.keys().cloned());
        for id in host_ids {
            let local_hash = local_manifest.hosts.get(&id).cloned();
            let remote_hash = remote_manifest.hosts.get(&id).cloned();
            if local_hash != remote_hash {
                conflicts.push(SyncConflictItem {
                    kind: SyncConflictKind::Host,
                    id: id.clone(),
                    label: format!("Host {}", id),
                    local_hash,
                    remote_hash,
                });
            }
        }

        let mut keychain_ids = HashSet::new();
        keychain_ids.extend(local_manifest.keychain.keys().cloned());
        keychain_ids.extend(remote_manifest.keychain.keys().cloned());
        for id in keychain_ids {
            let local_hash = local_manifest.keychain.get(&id).cloned();
            let remote_hash = remote_manifest.keychain.get(&id).cloned();
            if local_hash != remote_hash {
                conflicts.push(SyncConflictItem {
                    kind: SyncConflictKind::Keychain,
                    id: id.clone(),
                    label: format!("Keychain {}", id),
                    local_hash,
                    remote_hash,
                });
            }
        }

        let local_profile_hash = Some(local_manifest.profile.clone());
        let remote_profile_hash = Some(remote_manifest.profile.clone());
        if local_profile_hash != remote_profile_hash {
            conflicts.push(SyncConflictItem {
                kind: SyncConflictKind::Profile,
                id: "profile".to_string(),
                label: "Profile / Settings".to_string(),
                local_hash: local_profile_hash,
                remote_hash: remote_profile_hash,
            });
        }

        conflicts.sort_by(|a, b| a.label.cmp(&b.label));
        Ok(SyncConflictPreview { conflicts })
    }

    pub async fn resolve_startup_conflicts(
        &mut self,
        app: &tauri::AppHandle,
        vault: &mut VaultManager,
        server_address: &str,
        fallback_addresses: &[String],
        decisions: Vec<SyncConflictDecision>,
    ) -> Result<SyncState> {
        clear_sync_cancel();
        let access_token =
            access_token_from_refresh_with_fallback(server_address, fallback_addresses).await?;
        let client = Client::new();
        let folder_id = ensure_termopen_folder(&client, &access_token, true)
            .await?
            .ok_or_else(|| anyhow!("Falha ao preparar pasta TermOpen no Google Drive"))?;

        let remote_files = list_drive_bin_files(&client, &access_token, &folder_id).await?;

        let mut client_overrides: HashMap<String, Option<Vec<u8>>> = HashMap::new();
        for decision in decisions {
            if decision.keep != SyncKeepSide::Client {
                continue;
            }
            let file_name = conflict_file_name(&decision)?;
            let bytes = vault.read_local_bin_file(&file_name)?;
            client_overrides.insert(file_name, bytes);
        }

        let mut remote_snapshot = HashMap::new();
        for (name, metadata) in &remote_files {
            let bytes = download_file_bytes(&client, &access_token, &metadata.id).await?;
            remote_snapshot.insert(name.clone(), bytes);
        }

        if !remote_snapshot.is_empty() {
            vault.replace_local_files(&remote_snapshot)?;
        }

        for (name, maybe_bytes) in client_overrides {
            if let Some(bytes) = maybe_bytes {
                vault.write_local_bin_file(&name, &bytes)?;
            } else {
                vault.remove_local_bin_file(&name)?;
            }
        }

        vault.reload_unlocked_from_disk_and_persist()?;

        let local_files = vault.list_local_bin_files()?;
        let latest_remote = list_drive_bin_files(&client, &access_token, &folder_id).await?;
        let mut local_names = HashSet::new();

        for (name, bytes) in local_files {
            local_names.insert(name.clone());
            if let Some(existing) = latest_remote.get(&name) {
                upload_file_bytes(&client, &access_token, &existing.id, bytes).await?;
            } else {
                let created = create_drive_file(&client, &access_token, &folder_id, &name).await?;
                upload_file_bytes(&client, &access_token, &created.id, bytes).await?;
            }
        }

        for (name, metadata) in latest_remote {
            if !local_names.contains(&name) {
                delete_drive_file(&client, &access_token, &metadata.id).await?;
            }
        }

        let now = Utc::now();
        let mut next_metadata = vault.sync_metadata()?;
        next_metadata.last_sync_at = Some(now.to_rfc3339());
        next_metadata.last_remote_modified = Some(now.to_rfc3339());
        next_metadata.last_local_change = now.timestamp();
        vault.set_sync_metadata(next_metadata.clone())?;

        let state = SyncState::ok(
            "Conflitos resolvidos e sincronizados com sucesso.",
            next_metadata.last_sync_at,
        );
        app.emit("sync:status", &state).ok();
        Ok(state)
    }

    pub async fn recovery_probe(
        &mut self,
        server_address: &str,
        fallback_addresses: &[String],
    ) -> Result<RecoveryProbeResult> {
        let access_token =
            access_token_from_refresh_with_fallback(server_address, fallback_addresses).await?;
        let client = Client::new();

        let Some(folder_id) = ensure_termopen_folder(&client, &access_token, false).await? else {
            return Ok(RecoveryProbeResult {
                found: false,
                message: "Pasta TermOpen nao encontrada no Google Drive.".to_string(),
            });
        };

        let files = list_drive_bin_files(&client, &access_token, &folder_id).await?;
        if files.contains_key(TERM_OPEN_FILE_NAME) {
            Ok(RecoveryProbeResult {
                found: true,
                message: "Backup encontrado no Google Drive.".to_string(),
            })
        } else {
            Ok(RecoveryProbeResult {
                found: false,
                message: "Backup nao encontrado no Google Drive.".to_string(),
            })
        }
    }

    pub async fn recovery_restore(
        &mut self,
        app: &tauri::AppHandle,
        vault: &mut VaultManager,
        server_address: &str,
        fallback_addresses: &[String],
        password: String,
    ) -> Result<VaultStatus> {
        clear_sync_cancel();
        let access_token =
            access_token_from_refresh_with_fallback(server_address, fallback_addresses).await?;
        let client = Client::new();

        let Some(folder_id) = ensure_termopen_folder(&client, &access_token, false).await? else {
            return Err(anyhow!("Pasta TermOpen nao encontrada no Google Drive"));
        };

        let files = list_drive_bin_files(&client, &access_token, &folder_id).await?;
        let term_open_meta = files
            .get(TERM_OPEN_FILE_NAME)
            .ok_or_else(|| anyhow!("term-open.bin nao encontrado na nuvem"))?;
        let term_open_bytes =
            download_file_bytes(&client, &access_token, &term_open_meta.id).await?;

        if !vault.validate_password_for_term_open_bytes(&term_open_bytes, password.trim())? {
            return Err(anyhow!("Senha mestre invalida"));
        }

        let pending = SyncState {
            connected: true,
            status: "running".to_string(),
            message: "Baixando arquivos da nuvem...".to_string(),
            last_sync_at: None,
            pending_user_code: None,
            verification_url: None,
        };
        app.emit("sync:status", &pending).ok();

        let mut snapshot = HashMap::new();
        for (name, metadata) in files {
            let bytes = download_file_bytes(&client, &access_token, &metadata.id).await?;
            snapshot.insert(name, bytes);
        }

        if !snapshot.contains_key(TERM_OPEN_FILE_NAME)
            || !snapshot.contains_key(PROFILE_FILE_NAME)
            || !snapshot.contains_key(MANIFEST_FILE_NAME)
        {
            return Err(anyhow!("Backup remoto incompleto: faltam arquivos base"));
        }

        vault.replace_local_files(&snapshot)?;
        let status = vault.unlock(Some(password))?;
        Ok(status)
    }
}

fn conflict_file_name(decision: &SyncConflictDecision) -> Result<String> {
    match decision.kind {
        SyncConflictKind::Profile => Ok(PROFILE_FILE_NAME.to_string()),
        SyncConflictKind::Host | SyncConflictKind::Keychain => {
            if uuid::Uuid::parse_str(decision.id.trim()).is_err() {
                return Err(anyhow!("ID de conflito invalido: {}", decision.id));
            }
            Ok(format!("{}.bin", decision.id.trim()))
        }
    }
}

fn finalize_auth_result(
    app: &tauri::AppHandle,
    result: std::result::Result<Result<CallbackAuthData>, tokio::time::error::Elapsed>,
) -> Result<SyncState> {
    let state = match result {
        Ok(Ok(auth_data)) => {
            store_refresh_token(&auth_data.refresh_token)?;
            if let Some(ref email) = auth_data.email {
                store_user_field(KEYRING_USER_EMAIL, email).ok();
            }
            if let Some(ref name) = auth_data.name {
                store_user_field(KEYRING_USER_NAME, name).ok();
            }
            if let Some(ref picture_url) = auth_data.picture_url {
                store_user_field(KEYRING_USER_PICTURE, picture_url).ok();
            }

            let message = if let Some(ref name) = auth_data.name {
                let email = auth_data.email.as_deref().unwrap_or("");
                format!("Conectado como {} ({}).", name, email)
            } else {
                "Google Drive conectado com sucesso.".to_string()
            };

            SyncState::ok(&message, None)
        }
        Ok(Err(error)) => SyncState::error(format!("Erro no login: {}", error)),
        Err(_) => SyncState::error("Tempo de login expirado. Tente novamente."),
    };

    app.emit("sync:status", &state).ok();
    Ok(state)
}

pub fn handle_auth_callback_deeplink(raw_url: &str) -> Result<bool> {
    let Some(auth_data) = parse_auth_callback_from_deeplink(raw_url)? else {
        return Ok(false);
    };

    push_auth_callback(auth_data)?;
    Ok(true)
}

fn clear_auth_callback_queue() {
    if let Ok(mut queue) = auth_callback_queue().queue.lock() {
        queue.clear();
    }
}

fn push_auth_callback(auth_data: CallbackAuthData) -> Result<()> {
    let queue = auth_callback_queue();
    let mut guard = queue
        .queue
        .lock()
        .map_err(|_| anyhow!("Falha ao acessar fila de callback"))?;
    guard.push_back(auth_data);
    drop(guard);
    queue.notify.notify_one();
    Ok(())
}

fn pop_auth_callback() -> Result<Option<CallbackAuthData>> {
    auth_callback_queue()
        .queue
        .lock()
        .map(|mut guard| guard.pop_front())
        .map_err(|_| anyhow!("Falha ao acessar fila de callback"))
}

async fn wait_for_auth_callback() -> Result<CallbackAuthData> {
    let queue = auth_callback_queue();
    loop {
        let notified = queue.notify.notified();
        if let Some(data) = pop_auth_callback()? {
            return Ok(data);
        }
        notified.await;
    }
}

fn parse_auth_callback_from_deeplink(raw_url: &str) -> Result<Option<CallbackAuthData>> {
    let cleaned = raw_url.trim().trim_matches('"');
    let Some(path_query) = cleaned.strip_prefix("termopen://") else {
        return Ok(None);
    };

    let mut parts = path_query.splitn(2, '?');
    let endpoint = parts.next().unwrap_or("").trim_matches('/');
    if !endpoint.eq_ignore_ascii_case("auth") {
        return Ok(None);
    }

    let params = parse_auth_callback_query(parts.next().unwrap_or(""));
    if let Some(error) = params.get("error").filter(|value| !value.is_empty()) {
        return Err(anyhow!("Login falhou: {}", error));
    }

    let refresh_token = params
        .get("refresh_token")
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| anyhow!("refresh_token nao recebido no deep link"))?;

    let email = params
        .get("email")
        .cloned()
        .filter(|value| !value.is_empty());
    let name = params
        .get("name")
        .cloned()
        .filter(|value| !value.is_empty());
    let picture_url = params
        .get("picture")
        .or_else(|| params.get("picture_url"))
        .cloned()
        .filter(|value| !value.is_empty());

    Ok(Some(CallbackAuthData {
        refresh_token,
        email,
        name,
        picture_url,
    }))
}

fn parse_auth_callback_query(query: &str) -> std::collections::HashMap<String, String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((
                urlencoding::decode(key).unwrap_or_default().to_string(),
                urlencoding::decode(value).unwrap_or_default().to_string(),
            ))
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct CallbackAuthData {
    refresh_token: String,
    email: Option<String>,
    name: Option<String>,
    picture_url: Option<String>,
}

#[cfg(not(target_os = "windows"))]
async fn wait_for_callback(listener: &TcpListener) -> Result<CallbackAuthData> {
    let (mut stream, _) = listener
        .accept()
        .await
        .context("Falha ao aceitar conexao")?;

    let mut buf = vec![0u8; 8192];
    let n = stream
        .read(&mut buf)
        .await
        .context("Falha ao ler request")?;
    let request = String::from_utf8_lossy(&buf[..n]);

    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    let query = path.split('?').nth(1).unwrap_or("");
    let params = parse_auth_callback_query(query);

    if let Some(error) = params.get("error") {
        let html = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
            <html><body><h2>Erro no login</h2><p>{}</p>\
            <script>setTimeout(()=>window.close(),2000)</script></body></html>",
            error
        );
        stream.write_all(html.as_bytes()).await.ok();
        stream.flush().await.ok();
        return Err(anyhow!("Login falhou: {}", error));
    }

    let refresh_token = params
        .get("refresh_token")
        .filter(|v| !v.is_empty())
        .cloned()
        .ok_or_else(|| anyhow!("refresh_token nao recebido no callback"))?;

    let email = params.get("email").cloned().filter(|v| !v.is_empty());
    let name = params.get("name").cloned().filter(|v| !v.is_empty());
    let picture_url = params
        .get("picture")
        .or_else(|| params.get("picture_url"))
        .cloned()
        .filter(|value| !value.is_empty());

    let display_name = name.as_deref().unwrap_or("usuario");
    let html = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
        <html><body style=\"font-family:system-ui;text-align:center;padding:60px\">\
        <h2>Conectado como {}</h2>\
        <p>Pode fechar esta janela.</p>\
        <script>setTimeout(()=>window.close(),2000)</script></body></html>",
        display_name
    );
    stream.write_all(html.as_bytes()).await.ok();
    stream.flush().await.ok();

    Ok(CallbackAuthData {
        refresh_token,
        email,
        name,
        picture_url,
    })
}

async fn access_token_from_refresh_with_fallback(
    primary: &str,
    fallbacks: &[String],
) -> Result<String> {
    match try_refresh_token(primary).await {
        Ok(token) => Ok(token),
        Err(e) => {
            if e.to_string().contains("401") || e.to_string().contains("Execute login") {
                return Err(e);
            }
            for fallback in fallbacks {
                if fallback == primary {
                    continue;
                }
                if let Ok(token) = try_refresh_token(fallback).await {
                    return Ok(token);
                }
            }
            Err(e)
        }
    }
}

async fn try_refresh_token(server_address: &str) -> Result<String> {
    let refresh_token = load_refresh_token()?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| Client::new());

    let response = client
        .post(format!("{}/auth/refresh-token", server_address))
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .context("Falha ao renovar access token via worker")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Falha ao renovar token ({}). Execute login novamente. {}",
            status,
            body
        ));
    }

    let data: RefreshTokenResponse = response
        .json()
        .await
        .context("Falha ao ler resposta de refresh")?;

    Ok(data.access_token)
}

async fn ensure_termopen_folder(
    client: &Client,
    access_token: &str,
    create_if_missing: bool,
) -> Result<Option<String>> {
    ensure_named_folder(
        client,
        access_token,
        DRIVE_ROOT_FOLDER_NAME,
        DRIVE_TOP_PARENT_ID,
        create_if_missing,
    )
    .await
}

async fn ensure_named_folder(
    client: &Client,
    access_token: &str,
    folder_name: &str,
    parent_id: &str,
    create_if_missing: bool,
) -> Result<Option<String>> {
    let query = format!(
        "name='{}' and mimeType='{}' and trashed=false and '{}' in parents",
        folder_name, DRIVE_FOLDER_MIME_TYPE, parent_id
    );

    let response = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[
            ("q", query.as_str()),
            ("spaces", "drive"),
            ("fields", "files(id,name,mimeType,modifiedTime)"),
            ("pageSize", "10"),
        ])
        .send()
        .await
        .context("Falha ao listar pastas no Google Drive")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Falha ao listar pasta no Drive ({}): {}",
            status,
            body
        ));
    }

    let list = response
        .json::<DriveFileListResponse>()
        .await
        .context("Falha ao decodificar listagem de pastas")?;

    if let Some(found) = list.files.into_iter().next() {
        return Ok(Some(found.id));
    }

    if !create_if_missing {
        return Ok(None);
    }

    let create_response = client
        .post("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[("fields", "id,name,mimeType,modifiedTime")])
        .json(&serde_json::json!({
            "name": folder_name,
            "mimeType": DRIVE_FOLDER_MIME_TYPE,
            "parents": [parent_id],
        }))
        .send()
        .await
        .context("Falha ao criar pasta no Google Drive")?;

    let create_status = create_response.status();
    if !create_status.is_success() {
        let body = create_response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Falha ao criar pasta no Drive ({}): {}",
            create_status,
            body
        ));
    }

    let created = create_response
        .json::<DriveFileMetadata>()
        .await
        .context("Falha ao decodificar pasta criada")?;

    Ok(Some(created.id))
}

async fn list_drive_bin_files(
    client: &Client,
    access_token: &str,
    folder_id: &str,
) -> Result<HashMap<String, DriveFileMetadata>> {
    let query = format!(
        "trashed=false and '{}' in parents and mimeType!='{}'",
        folder_id, DRIVE_FOLDER_MIME_TYPE
    );

    let response = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[
            ("q", query.as_str()),
            ("spaces", "drive"),
            ("fields", "files(id,name,mimeType,modifiedTime)"),
            ("pageSize", "1000"),
        ])
        .send()
        .await
        .context("Falha ao listar arquivos no Google Drive")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Falha ao listar arquivos no Drive ({}): {}",
            status,
            body
        ));
    }

    let list = response
        .json::<DriveFileListResponse>()
        .await
        .context("Falha ao decodificar listagem de arquivos")?;

    let mut out: HashMap<String, DriveFileMetadata> = HashMap::new();
    for item in list.files {
        let Some(name) = item.name.clone() else {
            continue;
        };
        if !name.to_ascii_lowercase().ends_with(".bin") {
            continue;
        }

        if let Some(current) = out.get(&name) {
            if item.modified_time > current.modified_time {
                out.insert(name, item);
            }
        } else {
            out.insert(name, item);
        }
    }
    Ok(out)
}

async fn create_drive_file(
    client: &Client,
    access_token: &str,
    folder_id: &str,
    file_name: &str,
) -> Result<DriveFileMetadata> {
    let response = client
        .post("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[("fields", "id,name,mimeType,modifiedTime")])
        .json(&serde_json::json!({
            "name": file_name,
            "parents": [folder_id],
        }))
        .send()
        .await
        .context("Falha ao criar metadata de arquivo no Drive")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Falha ao criar arquivo no Drive ({}): {}",
            status,
            body
        ));
    }

    response
        .json::<DriveFileMetadata>()
        .await
        .context("Falha ao decodificar metadata criada")
}

async fn upload_file_bytes(
    client: &Client,
    access_token: &str,
    file_id: &str,
    content: Vec<u8>,
) -> Result<DriveFileMetadata> {
    let url = format!(
        "https://www.googleapis.com/upload/drive/v3/files/{}",
        file_id
    );

    let response = client
        .patch(url)
        .bearer_auth(access_token)
        .query(&[
            ("uploadType", "media"),
            ("fields", "id,name,mimeType,modifiedTime"),
        ])
        .header("Content-Type", "application/octet-stream")
        .body(content)
        .send()
        .await
        .context("Falha ao enviar arquivo para o Drive")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("Falha no upload para Drive ({}): {}", status, body));
    }

    response
        .json::<DriveFileMetadata>()
        .await
        .context("Falha ao ler resposta de upload")
}

async fn download_file_bytes(
    client: &Client,
    access_token: &str,
    file_id: &str,
) -> Result<Vec<u8>> {
    let url = format!("https://www.googleapis.com/drive/v3/files/{}", file_id);

    let response = client
        .get(url)
        .bearer_auth(access_token)
        .query(&[("alt", "media")])
        .send()
        .await
        .context("Falha ao baixar arquivo do Drive")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("Falha no download do Drive ({}): {}", status, body));
    }

    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .context("Falha ao ler bytes de download")
}

async fn delete_drive_file(client: &Client, access_token: &str, file_id: &str) -> Result<()> {
    let url = format!("https://www.googleapis.com/drive/v3/files/{}", file_id);
    let response = client
        .delete(url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("Falha ao remover arquivo no Drive")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Falha ao remover arquivo no Drive ({}): {}",
            status,
            body
        ));
    }

    Ok(())
}

fn store_refresh_token(token: &str) -> Result<()> {
    let entry =
        Entry::new(KEYRING_SERVICE, KEYRING_REFRESH_TOKEN).context("Falha ao preparar keychain")?;
    entry
        .set_password(token)
        .context("Falha ao salvar refresh token no keychain")
}

fn load_refresh_token() -> Result<String> {
    let entry =
        Entry::new(KEYRING_SERVICE, KEYRING_REFRESH_TOKEN).context("Falha ao preparar keychain")?;
    entry
        .get_password()
        .context("Refresh token ausente. Faca login primeiro.")
}

fn store_user_field(key: &str, value: &str) -> Result<()> {
    let entry = Entry::new(KEYRING_SERVICE, key).context("Falha ao preparar keychain")?;
    entry
        .set_password(value)
        .context("Falha ao salvar dado no keychain")
}

fn load_user_field(key: &str) -> Result<String> {
    let entry = Entry::new(KEYRING_SERVICE, key).context("Falha ao preparar keychain")?;
    entry.get_password().context("Campo ausente no keychain")
}

fn delete_keyring_field(key: &str) {
    if let Ok(entry) = Entry::new(KEYRING_SERVICE, key) {
        let _ = entry.delete_password();
    }
}

#[derive(Debug, Deserialize)]
struct RefreshTokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct DriveFileListResponse {
    files: Vec<DriveFileMetadata>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct DriveFileMetadata {
    id: String,
    name: Option<String>,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
    #[serde(rename = "modifiedTime")]
    modified_time: Option<String>,
}
