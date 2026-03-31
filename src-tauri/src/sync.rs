use std::{env, time::Duration};

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::time::sleep;

use crate::{models::SyncState, vault::VaultManager};

const KEYRING_SERVICE: &str = "com.drysius.termopen";
const KEYRING_REFRESH_TOKEN: &str = "google-drive-refresh-token";
const DRIVE_FILE_NAME: &str = "termopen-vault.enc.json";
const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const DEFAULT_GOOGLE_CLIENT_ID: &str =
    "1084074486119-2nt60qs1kje76n9f9vkp4crqc6u7538n.apps.googleusercontent.com";

#[derive(Default)]
pub struct SyncManager {
    pending_pull_confirmation: Option<String>,
}

impl SyncManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn google_login(&mut self, app: &tauri::AppHandle) -> Result<SyncState> {
        let client_id = google_client_id()?;
        let client = Client::new();

        let device = request_device_code(&client, &client_id).await?;

        let pending_state = SyncState {
            connected: false,
            status: "running".to_string(),
            message: "Abra o link de verificacao e informe o codigo para completar o login."
                .to_string(),
            last_sync_at: None,
            pending_user_code: Some(device.user_code.clone()),
            verification_url: Some(device.verification_url.clone()),
        };
        app.emit("sync:status", &pending_state).ok();

        let poll_until =
            Utc::now() + chrono::Duration::seconds(i64::from(device.expires_in.min(600)));
        let mut interval = u64::try_from(device.interval.max(5)).unwrap_or(5);

        while Utc::now() < poll_until {
            sleep(Duration::from_secs(interval)).await;
            match exchange_device_code(&client, &client_id, &device.device_code).await {
                Ok(token) => {
                    if let Some(refresh) = token.refresh_token {
                        store_refresh_token(&refresh)?;
                    }

                    let state = SyncState::ok("Google Drive conectado com sucesso.", None);
                    app.emit("sync:status", &state).ok();
                    return Ok(state);
                }
                Err(AuthPollError::Pending) => {
                    continue;
                }
                Err(AuthPollError::SlowDown) => {
                    interval += 2;
                    continue;
                }
                Err(AuthPollError::Fatal(message)) => {
                    let state = SyncState::error(format!("Falha no login do Google: {}", message));
                    app.emit("sync:status", &state).ok();
                    return Ok(state);
                }
            }
        }

        let timeout_state = SyncState {
            connected: false,
            status: "running".to_string(),
            message: "Tempo de login expirado. Execute o login novamente para gerar novo codigo."
                .to_string(),
            last_sync_at: None,
            pending_user_code: Some(device.user_code),
            verification_url: Some(device.verification_url),
        };
        app.emit("sync:status", &timeout_state).ok();
        Ok(timeout_state)
    }

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

fn google_client_id() -> Result<String> {
    let from_runtime = env::var("TERMOPEN_GOOGLE_CLIENT_ID")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let from_compile = option_env!("TERMOPEN_GOOGLE_CLIENT_ID").map(|v| v.to_string());

    Ok(from_runtime
        .or(from_compile)
        .unwrap_or_else(|| DEFAULT_GOOGLE_CLIENT_ID.to_string()))
}

fn google_client_secret() -> Option<String> {
    env::var("TERMOPEN_GOOGLE_CLIENT_SECRET")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| option_env!("TERMOPEN_GOOGLE_CLIENT_SECRET").map(|v| v.to_string()))
}

async fn request_device_code(client: &Client, client_id: &str) -> Result<DeviceCodeResponse> {
    let response = client
        .post("https://oauth2.googleapis.com/device/code")
        .form(&[("client_id", client_id), ("scope", GOOGLE_SCOPE)])
        .send()
        .await
        .context("Falha na chamada de device code")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        if body.contains("invalid_client") {
            return Err(anyhow!("{}", invalid_client_help(&body)));
        }
        return Err(anyhow!("Device code recusado ({}): {}", status, body));
    }

    response
        .json::<DeviceCodeResponse>()
        .await
        .context("Falha ao decodificar resposta de device code")
}

async fn exchange_device_code(
    client: &Client,
    client_id: &str,
    device_code: &str,
) -> Result<TokenResponse, AuthPollError> {
    let mut form = vec![
        ("client_id", client_id.to_string()),
        ("device_code", device_code.to_string()),
        (
            "grant_type",
            "urn:ietf:params:oauth:grant-type:device_code".to_string(),
        ),
    ];

    if let Some(secret) = google_client_secret() {
        form.push(("client_secret", secret));
    }

    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&form)
        .send()
        .await
        .map_err(|error| AuthPollError::Fatal(format!("Erro na troca de token: {}", error)))?;

    if response.status().is_success() {
        return response.json::<TokenResponse>().await.map_err(|error| {
            AuthPollError::Fatal(format!("Erro ao decodificar token: {}", error))
        });
    }

    let error = response
        .json::<OAuthErrorResponse>()
        .await
        .map_err(|decode_error| {
            AuthPollError::Fatal(format!("Erro na resposta de token: {}", decode_error))
        })?;

    match error.error.as_str() {
        "authorization_pending" => Err(AuthPollError::Pending),
        "slow_down" => Err(AuthPollError::SlowDown),
        "invalid_client" => Err(AuthPollError::Fatal(invalid_client_help(
            error
                .error_description
                .unwrap_or_else(|| "invalid_client".to_string())
                .as_str(),
        ))),
        _ => Err(AuthPollError::Fatal(
            error.error_description.unwrap_or_else(|| error.error),
        )),
    }
}

async fn access_token_from_refresh() -> Result<String> {
    let client_id = google_client_id()?;
    let refresh_token = load_refresh_token()?;

    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token".to_string()),
    ];

    if let Some(secret) = google_client_secret() {
        form.push(("client_secret", secret));
    }

    let client = Client::new();
    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&form)
        .send()
        .await
        .context("Falha ao renovar access token")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Falha ao renovar token Google ({}). Execute login novamente. {}",
            status,
            body
        ));
    }

    let token = response
        .json::<TokenResponse>()
        .await
        .context("Falha ao ler token renovado")?;

    Ok(token.access_token)
}

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
        .context("Refresh token ausente. Rode sync_google_login primeiro.")
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_url: String,
    expires_in: i32,
    interval: i32,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthErrorResponse {
    error: String,
    error_description: Option<String>,
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

enum AuthPollError {
    Pending,
    SlowDown,
    Fatal(String),
}

fn invalid_client_help(raw_error: &str) -> String {
    format!(
        "Google OAuth recusou o client ({raw_error}). Configure um OAuth Client do tipo Desktop App no Google Cloud com Device Authorization, escopo drive.file e variaveis TERMOPEN_GOOGLE_CLIENT_ID (e TERMOPEN_GOOGLE_CLIENT_SECRET se exigido)."
    )
}
