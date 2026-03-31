use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicBool, Ordering},
    sync::{Mutex as StdMutex, OnceLock},
};
use tauri::Emitter;
#[cfg(not(target_os = "windows"))]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(not(target_os = "windows"))]
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::{models::SyncState, vault::VaultManager};

const KEYRING_SERVICE: &str = "com.drysius.termopen";
const KEYRING_REFRESH_TOKEN: &str = "google-drive-refresh-token";
const KEYRING_USER_EMAIL: &str = "google-user-email";
const KEYRING_USER_NAME: &str = "google-user-name";
const DRIVE_FILE_NAME: &str = "termopen-vault.enc.json";
const AUTH_DEEPLINK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

struct AuthCallbackQueue {
    queue: StdMutex<VecDeque<CallbackAuthData>>,
    notify: Notify,
}

static AUTH_CALLBACK_QUEUE: OnceLock<AuthCallbackQueue> = OnceLock::new();
static SYNC_CANCELLED: AtomicBool = AtomicBool::new(false);
static SYNC_CANCEL_NOTIFY: OnceLock<Notify> = OnceLock::new();

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
pub struct SyncManager {
    pending_pull_confirmation: Option<String>,
}

impl SyncManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Abre o browser para login via Google OAuth.
    /// Em Windows aguarda callback via deep link; nos demais usa callback local.
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

    /// Retorna dados do usuário logado (se houver).
    pub fn logged_user(&self) -> Option<(String, String)> {
        let email = load_user_field(KEYRING_USER_EMAIL).ok();
        let name = load_user_field(KEYRING_USER_NAME).ok();
        if email.is_some() || name.is_some() {
            Some((name.unwrap_or_default(), email.unwrap_or_default()))
        } else {
            None
        }
    }

    /// Envia o vault criptografado para o Google Drive.
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
        let content = vault.encrypted_file_bytes()?;

        let existing = lookup_drive_file(&client, &access_token).await?;
        let remote = if let Some(found) = existing {
            upload_file_bytes(&client, &access_token, &found.id, content).await?
        } else {
            let created = create_drive_file(&client, &access_token).await?;
            upload_file_bytes(&client, &access_token, &created.id, content).await?
        };
        if is_sync_cancelled() {
            let state = cancelled_state();
            app.emit("sync:status", &state).ok();
            return Ok(state);
        }

        let now = Utc::now();
        let mut metadata = vault.sync_metadata()?;
        metadata.last_remote_modified = remote.modified_time.clone();
        metadata.last_sync_at = Some(now.to_rfc3339());
        metadata.last_local_change = now.timestamp();
        vault.set_sync_metadata(metadata.clone())?;

        self.pending_pull_confirmation = None;

        let state = SyncState::ok(
            "Vault enviado para Google Drive com sucesso.",
            metadata.last_sync_at,
        );
        app.emit("sync:status", &state).ok();
        Ok(state)
    }

    /// Baixa o vault do Google Drive.
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

        let Some(remote_file) = lookup_drive_file(&client, &access_token).await? else {
            let state = SyncState::idle("Nenhum backup encontrado no Google Drive.");
            app.emit("sync:status", &state).ok();
            return Ok(state);
        };

        let metadata = vault.sync_metadata()?;
        if is_conflict(&metadata, remote_file.modified_time.as_deref()) {
            let remote_revision = remote_file
                .modified_time
                .clone()
                .unwrap_or_else(|| "unknown".to_string());
            if self.pending_pull_confirmation.as_deref() != Some(remote_revision.as_str()) {
                self.pending_pull_confirmation = Some(remote_revision.clone());
                let state = SyncState::conflict(
                    "Conflito detectado. Rode Pull novamente para aceitar nuvem ou Push para manter local.",
                    metadata.last_sync_at,
                );
                app.emit("sync:status", &state).ok();
                return Ok(state);
            }
        }

        let payload = download_file_bytes(&client, &access_token, &remote_file.id).await?;
        if is_sync_cancelled() {
            let state = cancelled_state();
            app.emit("sync:status", &state).ok();
            return Ok(state);
        }
        vault.replace_encrypted_file(&payload)?;

        let now = Utc::now();
        let mut next_metadata = vault.sync_metadata()?;
        next_metadata.last_sync_at = Some(now.to_rfc3339());
        next_metadata.last_remote_modified = remote_file.modified_time;
        next_metadata.last_local_change = now.timestamp();
        vault.set_sync_metadata(next_metadata.clone())?;

        self.pending_pull_confirmation = None;

        let state = SyncState::ok(
            "Vault baixado do Google Drive com sucesso.",
            next_metadata.last_sync_at,
        );
        app.emit("sync:status", &state).ok();
        Ok(state)
    }
}

// ─── Callback listener ─────────────────────────────────────────────

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

    Ok(Some(CallbackAuthData {
        refresh_token,
        email,
        name,
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
    })
}

// ─── Conflict detection ────────────────────────────────────────────

fn is_conflict(metadata: &crate::models::SyncMetadata, remote_modified: Option<&str>) -> bool {
    let Some(remote) = remote_modified else {
        return false;
    };

    let Some(previous_remote) = metadata.last_remote_modified.as_ref() else {
        return false;
    };

    if previous_remote == remote {
        return false;
    }

    let Some(last_sync) = metadata
        .last_sync_at
        .as_ref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|dt| dt.timestamp())
    else {
        return true;
    };

    metadata.last_local_change > last_sync
}

// ─── Google tokens via worker (com fallback) ───────────────────────

/// Tenta renovar o access_token usando o servidor primário.
/// Se falhar por erro de rede (servidor fora do ar), tenta os fallbacks.
/// Nunca altera o servidor selecionado do usuário.
async fn access_token_from_refresh_with_fallback(
    primary: &str,
    fallbacks: &[String],
) -> Result<String> {
    match try_refresh_token(primary).await {
        Ok(token) => return Ok(token),
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

// ─── Google Drive helpers ───────────────────────────────────────────

async fn lookup_drive_file(
    client: &Client,
    access_token: &str,
) -> Result<Option<DriveFileMetadata>> {
    let query = "name='termopen-vault.enc.json' and trashed=false and appProperties has { key='termopen_profile' and value='vault' }";

    let response = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[
            ("q", query),
            ("spaces", "drive"),
            ("fields", "files(id,name,modifiedTime)"),
            ("pageSize", "1"),
        ])
        .send()
        .await
        .context("Falha ao listar arquivos no Google Drive")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Falha ao listar backup no Drive ({}): {}",
            status,
            body
        ));
    }

    let list = response
        .json::<DriveFileListResponse>()
        .await
        .context("Falha ao decodificar listagem do Drive")?;

    Ok(list.files.into_iter().next())
}

async fn create_drive_file(client: &Client, access_token: &str) -> Result<DriveFileMetadata> {
    let response = client
        .post("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[("fields", "id,name,modifiedTime")])
        .json(&serde_json::json!({
            "name": DRIVE_FILE_NAME,
            "appProperties": {
                "termopen_profile": "vault"
            }
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
        .query(&[("uploadType", "media"), ("fields", "id,name,modifiedTime")])
        .header("Content-Type", "application/octet-stream")
        .body(content)
        .send()
        .await
        .context("Falha ao enviar vault para o Drive")?;

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
        .context("Falha ao baixar vault do Drive")?;

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

// ─── Keyring helpers ────────────────────────────────────────────────

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

// ─── Types ──────────────────────────────────────────────────────────

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
    #[allow(dead_code)]
    name: Option<String>,
    #[serde(rename = "modifiedTime")]
    modified_time: Option<String>,
}
