use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::{models::SyncState, vault::VaultManager};

const KEYRING_SERVICE: &str = "com.drysius.termopen";
const KEYRING_REFRESH_TOKEN: &str = "google-drive-refresh-token";
const KEYRING_USER_EMAIL: &str = "google-user-email";
const KEYRING_USER_NAME: &str = "google-user-name";
const DRIVE_FILE_NAME: &str = "termopen-vault.enc.json";
const WORKER_BASE_URL: &str = "https://small-band-2a72.marcosbrendonaz.workers.dev";

#[derive(Default)]
pub struct SyncManager {
    pending_pull_confirmation: Option<String>,
}

impl SyncManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Abre o browser para login via Google OAuth.
    /// Levanta um servidor HTTP temporário em localhost para receber o callback.
    pub async fn google_login(&mut self, app: &tauri::AppHandle) -> Result<SyncState> {
        let pending = SyncState {
            connected: false,
            status: "running".to_string(),
            message: "Abrindo navegador para login com Google...".to_string(),
            last_sync_at: None,
            pending_user_code: None,
            verification_url: None,
        };
        app.emit("sync:status", &pending).ok();

        // Levantar listener em porta aleatória
        let listener = TcpListener::bind("127.0.0.1:0").await
            .context("Falha ao abrir porta local para callback")?;
        let local_port = listener.local_addr()?.port();
        let callback_url = format!("http://localhost:{}/callback", local_port);

        // Abrir browser com a URL do worker + redirect local
        let login_url = format!(
            "{}/auth/google?local_callback={}",
            WORKER_BASE_URL,
            urlencoding::encode(&callback_url)
        );
        open::that_detached(&login_url).context("Falha ao abrir navegador para login")?;

        // Esperar a resposta do browser (timeout 5 min)
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            wait_for_callback(&listener),
        )
        .await;

        match result {
            Ok(Ok(auth_data)) => {
                store_refresh_token(&auth_data.refresh_token)?;
                if let Some(ref email) = auth_data.email {
                    store_user_field(KEYRING_USER_EMAIL, email).ok();
                }
                if let Some(ref name) = auth_data.name {
                    store_user_field(KEYRING_USER_NAME, name).ok();
                }

                let msg = if let Some(ref name) = auth_data.name {
                    let email = auth_data.email.as_deref().unwrap_or("");
                    format!("Conectado como {} ({}).", name, email)
                } else {
                    "Google Drive conectado com sucesso.".to_string()
                };

                let state = SyncState::ok(&msg, None);
                app.emit("sync:status", &state).ok();
                Ok(state)
            }
            Ok(Err(e)) => {
                let state = SyncState::error(format!("Erro no login: {}", e));
                app.emit("sync:status", &state).ok();
                Ok(state)
            }
            Err(_) => {
                let state = SyncState::error("Tempo de login expirado. Tente novamente.");
                app.emit("sync:status", &state).ok();
                Ok(state)
            }
        }
    }

    /// Retorna dados do usuário logado (se houver).
    pub fn logged_user(&self) -> Option<(String, String)> {
        let email = load_user_field(KEYRING_USER_EMAIL).ok();
        let name = load_user_field(KEYRING_USER_NAME).ok();
        if email.is_some() || name.is_some() {
            Some((
                name.unwrap_or_default(),
                email.unwrap_or_default(),
            ))
        } else {
            None
        }
    }

    /// Envia o vault criptografado para o Google Drive.
    pub async fn push(
        &mut self,
        app: &tauri::AppHandle,
        vault: &mut VaultManager,
    ) -> Result<SyncState> {
        let access_token = access_token_from_refresh().await?;
        let client = Client::new();
        let content = vault.encrypted_file_bytes()?;

        let existing = lookup_drive_file(&client, &access_token).await?;
        let remote = if let Some(found) = existing {
            upload_file_bytes(&client, &access_token, &found.id, content).await?
        } else {
            let created = create_drive_file(&client, &access_token).await?;
            upload_file_bytes(&client, &access_token, &created.id, content).await?
        };

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
    ) -> Result<SyncState> {
        let access_token = access_token_from_refresh().await?;
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

#[derive(Debug, Deserialize)]
struct CallbackAuthData {
    refresh_token: String,
    email: Option<String>,
    name: Option<String>,
}

async fn wait_for_callback(listener: &TcpListener) -> Result<CallbackAuthData> {
    let (mut stream, _) = listener.accept().await.context("Falha ao aceitar conexao")?;

    let mut buf = vec![0u8; 8192];
    let n = stream.read(&mut buf).await.context("Falha ao ler request")?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Extrair a primeira linha: GET /callback?... HTTP/1.1
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    // Parse query params
    let query = path.split('?').nth(1).unwrap_or("");
    let params: std::collections::HashMap<String, String> = query
        .split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((
                urlencoding::decode(key).unwrap_or_default().to_string(),
                urlencoding::decode(value).unwrap_or_default().to_string(),
            ))
        })
        .collect();

    // Verificar erro
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

    // Responder com HTML de sucesso
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

// ─── Google tokens via worker ───────────────────────────────────────

async fn access_token_from_refresh() -> Result<String> {
    let refresh_token = load_refresh_token()?;
    let client = Client::new();

    let response = client
        .post(format!("{}/auth/refresh-token", WORKER_BASE_URL))
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
