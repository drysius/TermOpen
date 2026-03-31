use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use chrono::Utc;
use directories::ProjectDirs;
use keyring::Entry;
use rand::{rngs::OsRng, RngCore};

use crate::models::{
    AppSettings, AuthServer, ConnectionProfile, KeyMode, KeychainEntry, SyncMetadata, VaultFile,
    VaultPayload, VaultStatus,
};

const KEYRING_SERVICE: &str = "com.drysius.termopen";
const KEYRING_VAULT_KEY: &str = "vault-key";
const VAULT_FILE_NAME: &str = "vault.enc.json";
const CURRENT_VAULT_VERSION: u32 = 1;

#[derive(Debug, Clone)]
struct VaultRuntime {
    unlocked: bool,
    key_mode: Option<KeyMode>,
    key: Option<[u8; 32]>,
    salt: Option<[u8; 16]>,
    payload: Option<VaultPayload>,
    created_at: Option<String>,
}

impl Default for VaultRuntime {
    fn default() -> Self {
        Self {
            unlocked: false,
            key_mode: None,
            key: None,
            salt: None,
            payload: None,
            created_at: None,
        }
    }
}

pub struct VaultManager {
    vault_path: PathBuf,
    runtime: VaultRuntime,
}

impl VaultManager {
    pub fn new() -> Result<Self> {
        let dirs = ProjectDirs::from("com", "drysius", "termopen")
            .ok_or_else(|| anyhow!("Nao foi possivel resolver diretorio de dados do aplicativo"))?;
        let data_dir = dirs.data_dir();
        fs::create_dir_all(data_dir).with_context(|| {
            format!("Falha ao criar diretorio de dados: {}", data_dir.display())
        })?;

        Ok(Self {
            vault_path: data_dir.join(VAULT_FILE_NAME),
            runtime: VaultRuntime::default(),
        })
    }

    pub fn status(&self) -> Result<VaultStatus> {
        let key_mode = if self.runtime.key_mode.is_some() {
            self.runtime.key_mode.clone()
        } else if self.vault_path.exists() {
            let file = self.read_vault_file()?;
            Some(file.key_mode)
        } else {
            None
        };

        Ok(VaultStatus {
            initialized: self.vault_path.exists(),
            locked: !self.runtime.unlocked,
            key_mode,
        })
    }

    pub fn init(&mut self, password: Option<String>) -> Result<VaultStatus> {
        if self.vault_path.exists() {
            return Err(anyhow!("Vault ja foi inicializado"));
        }

        let (key_mode, key, salt) = if let Some(raw_password) = password {
            let pass = raw_password.trim().to_string();
            if pass.is_empty() {
                return Err(anyhow!("Senha mestre nao pode ser vazia"));
            }

            let mut salt = [0u8; 16];
            OsRng.fill_bytes(&mut salt);
            let key = derive_key(&pass, &salt)?;
            (KeyMode::Password, key, Some(salt))
        } else {
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            persist_keychain_key(&key)?;
            (KeyMode::Keychain, key, None)
        };

        let payload = VaultPayload {
            version: CURRENT_VAULT_VERSION,
            ..VaultPayload::default()
        };

        let now = Utc::now().to_rfc3339();

        self.runtime = VaultRuntime {
            unlocked: true,
            key_mode: Some(key_mode),
            key: Some(key),
            salt,
            payload: Some(payload),
            created_at: Some(now),
        };

        self.persist()?;
        self.status()
    }

    pub fn unlock(&mut self, password: Option<String>) -> Result<VaultStatus> {
        if !self.vault_path.exists() {
            return Err(anyhow!("Vault ainda nao foi inicializado"));
        }

        let file = self.read_vault_file()?;
        if file.version != CURRENT_VAULT_VERSION {
            return Err(anyhow!(
                "Versao de vault nao suportada. Atual: {}, encontrada: {}",
                CURRENT_VAULT_VERSION,
                file.version
            ));
        }

        let (key, salt) = match file.key_mode {
            KeyMode::Password => {
                let raw_password =
                    password.ok_or_else(|| anyhow!("Senha mestre obrigatoria para este perfil"))?;
                let pass = raw_password.trim();
                if pass.is_empty() {
                    return Err(anyhow!("Senha mestre obrigatoria para este perfil"));
                }

                let salt_bytes = decode_fixed_16(
                    file.salt
                        .as_ref()
                        .ok_or_else(|| anyhow!("Salt ausente no arquivo criptografado"))?,
                )?;
                let key = derive_key(pass, &salt_bytes)?;
                (key, Some(salt_bytes))
            }
            KeyMode::Keychain => (load_keychain_key()?, None),
        };

        let payload = decrypt_payload(&file, &key)?;

        self.runtime = VaultRuntime {
            unlocked: true,
            key_mode: Some(file.key_mode),
            key: Some(key),
            salt,
            payload: Some(payload),
            created_at: Some(file.created_at),
        };

        self.status()
    }

    pub fn lock(&mut self) -> VaultStatus {
        self.runtime = VaultRuntime::default();
        VaultStatus {
            initialized: self.vault_path.exists(),
            locked: true,
            key_mode: None,
        }
    }

    pub fn change_master_password(
        &mut self,
        old_password: Option<String>,
        new_password: String,
    ) -> Result<VaultStatus> {
        self.assert_unlocked()?;

        let normalized_new = new_password.trim();
        if normalized_new.len() < 6 {
            return Err(anyhow!(
                "A nova senha mestre deve ter pelo menos 6 caracteres"
            ));
        }

        let current_mode = self
            .runtime
            .key_mode
            .clone()
            .ok_or_else(|| anyhow!("Modo de chave nao encontrado"))?;

        match current_mode {
            KeyMode::Password => {
                let old = old_password
                    .ok_or_else(|| anyhow!("Informe a senha mestre atual para trocar"))?
                    .trim()
                    .to_string();
                if old.is_empty() {
                    return Err(anyhow!("Informe a senha mestre atual para trocar"));
                }

                let salt = self
                    .runtime
                    .salt
                    .ok_or_else(|| anyhow!("Salt ausente para validar senha atual"))?;
                let derived = derive_key(&old, &salt)?;
                let current_key = self
                    .runtime
                    .key
                    .ok_or_else(|| anyhow!("Chave atual indisponivel"))?;

                if derived != current_key {
                    return Err(anyhow!("Senha mestre atual invalida"));
                }
            }
            KeyMode::Keychain => {
                // keychain mode does not require old password
            }
        }

        let mut new_salt = [0u8; 16];
        OsRng.fill_bytes(&mut new_salt);
        let new_key = derive_key(normalized_new, &new_salt)?;

        self.runtime.key_mode = Some(KeyMode::Password);
        self.runtime.key = Some(new_key);
        self.runtime.salt = Some(new_salt);
        clear_keychain_key();

        self.persist()?;
        self.status()
    }

    pub fn connections_list(&self) -> Result<Vec<ConnectionProfile>> {
        let mut connections = self.payload()?.connections.clone();
        connections
            .iter_mut()
            .for_each(|profile| profile.normalize_protocols());
        Ok(connections)
    }

    pub fn connection_save(&mut self, mut profile: ConnectionProfile) -> Result<ConnectionProfile> {
        self.assert_unlocked()?;

        if profile.id.trim().is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }

        if profile.port == 0 {
            profile.port = 22;
        }

        profile.host = profile.host.trim().to_string();
        profile.username = profile.username.trim().to_string();
        if profile.name.trim().is_empty() {
            profile.name = profile.host.clone();
        } else {
            profile.name = profile.name.trim().to_string();
        }

        profile.password = normalize_option(profile.password);
        profile.private_key = normalize_option(profile.private_key);
        profile.keychain_id = normalize_option(profile.keychain_id);
        profile.remote_path = normalize_option(profile.remote_path);
        profile.normalize_protocols();

        let payload = self.payload_mut()?;
        payload.connections.retain(|item| item.id != profile.id);
        payload.connections.push(profile.clone());
        payload.connections.sort_by(|a, b| a.name.cmp(&b.name));
        touch_local_change(payload);

        self.persist()?;
        Ok(profile)
    }

    pub fn connection_delete(&mut self, id: &str) -> Result<()> {
        self.assert_unlocked()?;
        let payload = self.payload_mut()?;
        payload.connections.retain(|item| item.id != id);
        touch_local_change(payload);
        self.persist()
    }

    pub fn profile_by_id(&self, id: &str) -> Result<ConnectionProfile> {
        let mut profile = self
            .payload()?
            .connections
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| anyhow!("Perfil {} nao encontrado", id))?;
        profile.normalize_protocols();
        Ok(profile)
    }

    pub fn keychain_by_id(&self, id: &str) -> Result<KeychainEntry> {
        self.payload()?
            .keychain
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| anyhow!("Keychain {} nao encontrado", id))
    }

    pub fn keychain_list(&self) -> Result<Vec<KeychainEntry>> {
        Ok(self.payload()?.keychain.clone())
    }

    pub fn keychain_save(&mut self, mut entry: KeychainEntry) -> Result<KeychainEntry> {
        self.assert_unlocked()?;

        if entry.id.trim().is_empty() {
            entry.id = uuid::Uuid::new_v4().to_string();
            entry.created_at = Utc::now().timestamp();
        }

        entry.name = entry.name.trim().to_string();
        entry.private_key = normalize_option(entry.private_key);
        entry.public_key = normalize_option(entry.public_key);
        entry.passphrase = normalize_option(entry.passphrase);

        if entry.name.is_empty() {
            return Err(anyhow!("Nome e obrigatorio no keychain"));
        }

        if entry.private_key.is_none() && entry.public_key.is_none() {
            return Err(anyhow!(
                "Informe ao menos uma chave (privada ou publica) no keychain"
            ));
        }

        let payload = self.payload_mut()?;
        payload.keychain.retain(|item| item.id != entry.id);
        payload.keychain.push(entry.clone());
        payload.keychain.sort_by(|a, b| a.name.cmp(&b.name));
        touch_local_change(payload);
        self.persist()?;

        Ok(entry)
    }

    pub fn keychain_delete(&mut self, id: &str) -> Result<()> {
        self.assert_unlocked()?;
        let payload = self.payload_mut()?;
        payload.keychain.retain(|item| item.id != id);
        touch_local_change(payload);
        self.persist()
    }

    pub fn auth_servers_list(&self) -> Result<Vec<AuthServer>> {
        let payload = self.payload()?;
        let mut servers = payload.auth_servers.clone();
        // Garantir que o default sempre existe
        if !servers.iter().any(|s| s.id == "default") {
            servers.insert(0, AuthServer::default_server());
        }
        servers.sort_by(|a, b| a.label.cmp(&b.label));
        Ok(servers)
    }

    pub fn merge_remote_servers(&mut self, remote: Vec<AuthServer>) -> Result<()> {
        self.assert_unlocked()?;
        let payload = self.payload_mut()?;
        for server in remote {
            if !payload.auth_servers.iter().any(|s| s.id == server.id) {
                payload.auth_servers.push(server);
            }
        }
        self.persist()
    }

    pub fn auth_server_save(&mut self, mut server: AuthServer) -> Result<AuthServer> {
        self.assert_unlocked()?;

        if server.id.trim().is_empty() {
            server.id = uuid::Uuid::new_v4().to_string();
        }

        server.label = server.label.trim().to_string();
        server.address = server.address.trim().trim_end_matches('/').to_string();

        if server.label.is_empty() {
            return Err(anyhow!("Label e obrigatorio"));
        }
        if server.address.is_empty() {
            return Err(anyhow!("Endereco e obrigatorio"));
        }
        if !server.address.starts_with("http://") && !server.address.starts_with("https://") {
            return Err(anyhow!("Endereco deve comecar com http:// ou https://"));
        }

        let payload = self.payload_mut()?;
        payload.auth_servers.retain(|s| s.id != server.id);
        payload.auth_servers.push(server.clone());
        payload.auth_servers.sort_by(|a, b| a.label.cmp(&b.label));
        touch_local_change(payload);
        self.persist()?;

        Ok(server)
    }

    pub fn auth_server_delete(&mut self, id: &str) -> Result<()> {
        self.assert_unlocked()?;
        if id == "default" {
            return Err(anyhow!("Nao e possivel remover o servidor padrao"));
        }
        let payload = self.payload_mut()?;
        payload.auth_servers.retain(|s| s.id != id);
        if payload.settings.selected_auth_server_id.as_deref() == Some(id) {
            payload.settings.selected_auth_server_id = None;
        }
        touch_local_change(payload);
        self.persist()
    }

    pub fn selected_auth_server(&self) -> Result<AuthServer> {
        let payload = self.payload()?;
        let selected_id = payload
            .settings
            .selected_auth_server_id
            .as_deref()
            .unwrap_or("default");
        payload
            .auth_servers
            .iter()
            .find(|s| s.id == selected_id)
            .cloned()
            .or_else(|| Some(AuthServer::default_server()))
            .ok_or_else(|| anyhow!("Servidor de auth nao encontrado"))
    }

    pub fn settings_get(&self) -> Result<AppSettings> {
        Ok(self.payload()?.settings.clone())
    }

    pub fn settings_update(&mut self, mut settings: AppSettings) -> Result<AppSettings> {
        self.assert_unlocked()?;
        settings.external_editor_command = settings.external_editor_command.trim().to_string();
        settings.known_hosts_path = settings.known_hosts_path.trim().to_string();
        settings.sync_interval_minutes = settings.sync_interval_minutes.clamp(1, 60);
        settings.inactivity_lock_minutes = settings.inactivity_lock_minutes.clamp(1, 240);
        settings.reconnect_delay_seconds = settings.reconnect_delay_seconds.clamp(1, 120);

        let payload = self.payload_mut()?;
        payload.settings = settings.clone();
        touch_local_change(payload);
        self.persist()?;

        Ok(settings)
    }

    pub fn sync_metadata(&self) -> Result<SyncMetadata> {
        Ok(self.payload()?.sync.clone())
    }

    pub fn set_sync_metadata(&mut self, metadata: SyncMetadata) -> Result<()> {
        let payload = self.payload_mut()?;
        payload.sync = metadata;
        self.persist()
    }

    pub fn replace_encrypted_file(&mut self, encrypted_bytes: &[u8]) -> Result<()> {
        fs::write(&self.vault_path, encrypted_bytes)
            .with_context(|| format!("Falha ao escrever vault em {}", self.vault_path.display()))?;

        if self.runtime.unlocked {
            let key = self
                .runtime
                .key
                .ok_or_else(|| anyhow!("Chave de runtime indisponivel para recarregar vault"))?;
            let file = self.read_vault_file()?;
            let payload = decrypt_payload(&file, &key)?;

            let salt = match file.key_mode {
                KeyMode::Password => Some(decode_fixed_16(
                    file.salt
                        .as_ref()
                        .ok_or_else(|| anyhow!("Salt ausente no vault baixado"))?,
                )?),
                KeyMode::Keychain => None,
            };

            self.runtime.key_mode = Some(file.key_mode);
            self.runtime.salt = salt;
            self.runtime.payload = Some(payload);
            self.runtime.created_at = Some(file.created_at);
        }

        Ok(())
    }

    pub fn encrypted_file_bytes(&self) -> Result<Vec<u8>> {
        fs::read(&self.vault_path)
            .with_context(|| format!("Falha ao ler vault em {}", self.vault_path.display()))
    }

    fn assert_unlocked(&self) -> Result<()> {
        if !self.runtime.unlocked {
            return Err(anyhow!("Vault bloqueado. Desbloqueie para continuar."));
        }
        Ok(())
    }

    fn payload(&self) -> Result<&VaultPayload> {
        self.assert_unlocked()?;
        self.runtime
            .payload
            .as_ref()
            .ok_or_else(|| anyhow!("Payload do vault indisponivel"))
    }

    fn payload_mut(&mut self) -> Result<&mut VaultPayload> {
        self.assert_unlocked()?;
        self.runtime
            .payload
            .as_mut()
            .ok_or_else(|| anyhow!("Payload do vault indisponivel"))
    }

    fn persist(&self) -> Result<()> {
        self.assert_unlocked()?;

        let payload = self
            .runtime
            .payload
            .as_ref()
            .ok_or_else(|| anyhow!("Payload do vault indisponivel"))?;
        let key = self
            .runtime
            .key
            .as_ref()
            .ok_or_else(|| anyhow!("Chave do vault indisponivel"))?;
        let key_mode = self
            .runtime
            .key_mode
            .clone()
            .ok_or_else(|| anyhow!("Modo de chave nao definido"))?;

        let now = Utc::now().to_rfc3339();
        let created_at = self
            .runtime
            .created_at
            .clone()
            .unwrap_or_else(|| now.clone());

        let file = encrypt_payload(
            payload,
            key_mode,
            key,
            self.runtime.salt.as_ref(),
            created_at,
            now,
        )?;
        let bytes = serde_json::to_vec_pretty(&file)?;

        if let Some(parent) = self.vault_path.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::write(&self.vault_path, bytes)
            .with_context(|| format!("Falha ao escrever vault em {}", self.vault_path.display()))
    }

    fn read_vault_file(&self) -> Result<VaultFile> {
        read_vault_file(&self.vault_path)
    }
}

fn read_vault_file(path: &Path) -> Result<VaultFile> {
    let raw = fs::read(path).with_context(|| format!("Falha ao ler arquivo {}", path.display()))?;
    let file: VaultFile = serde_json::from_slice(&raw)
        .with_context(|| format!("Falha ao decodificar arquivo {}", path.display()))?;
    Ok(file)
}

fn derive_key(password: &str, salt: &[u8; 16]) -> Result<[u8; 32]> {
    let params = Params::new(19_456, 3, 1, Some(32))
        .map_err(|error| anyhow!("Falha ao configurar parametros Argon2id: {}", error))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| anyhow!("Falha ao derivar chave via Argon2id: {}", error))?;
    Ok(key)
}

fn encrypt_payload(
    payload: &VaultPayload,
    key_mode: KeyMode,
    key: &[u8; 32],
    salt: Option<&[u8; 16]>,
    created_at: String,
    updated_at: String,
) -> Result<VaultFile> {
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);

    let cipher = XChaCha20Poly1305::new(key.into());
    let plaintext = serde_json::to_vec(payload)?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| anyhow!("Falha ao criptografar payload"))?;

    Ok(VaultFile {
        version: CURRENT_VAULT_VERSION,
        key_mode,
        salt: salt.map(|value| BASE64.encode(value)),
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
        created_at,
        updated_at,
    })
}

fn decrypt_payload(file: &VaultFile, key: &[u8; 32]) -> Result<VaultPayload> {
    let nonce = decode_fixed_24(&file.nonce)?;
    let ciphertext = BASE64
        .decode(&file.ciphertext)
        .context("Falha ao decodificar ciphertext do vault")?;

    let cipher = XChaCha20Poly1305::new(key.into());
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow!("Senha/chave invalida para descriptografia do vault"))?;

    serde_json::from_slice::<VaultPayload>(&plaintext)
        .context("Falha ao interpretar payload descriptografado")
}

fn decode_fixed_16(encoded: &str) -> Result<[u8; 16]> {
    let data = BASE64
        .decode(encoded)
        .context("Falha ao decodificar salt")?;
    if data.len() != 16 {
        return Err(anyhow!("Salt invalido: esperado 16 bytes"));
    }

    let mut out = [0u8; 16];
    out.copy_from_slice(&data);
    Ok(out)
}

fn decode_fixed_24(encoded: &str) -> Result<[u8; 24]> {
    let data = BASE64
        .decode(encoded)
        .context("Falha ao decodificar nonce")?;
    if data.len() != 24 {
        return Err(anyhow!("Nonce invalido: esperado 24 bytes"));
    }

    let mut out = [0u8; 24];
    out.copy_from_slice(&data);
    Ok(out)
}

fn persist_keychain_key(key: &[u8; 32]) -> Result<()> {
    let entry =
        Entry::new(KEYRING_SERVICE, KEYRING_VAULT_KEY).context("Falha ao preparar keychain")?;
    entry
        .set_password(&BASE64.encode(key))
        .context("Falha ao salvar chave no keychain")
}

fn load_keychain_key() -> Result<[u8; 32]> {
    let entry =
        Entry::new(KEYRING_SERVICE, KEYRING_VAULT_KEY).context("Falha ao preparar keychain")?;
    let value = entry
        .get_password()
        .context("Nao foi possivel ler chave do keychain")?;

    let bytes = BASE64
        .decode(value)
        .context("Falha ao decodificar chave do keychain")?;

    if bytes.len() != 32 {
        return Err(anyhow!("Chave do keychain invalida"));
    }

    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn clear_keychain_key() {
    if let Ok(entry) = Entry::new(KEYRING_SERVICE, KEYRING_VAULT_KEY) {
        let _ = entry.delete_password();
    }
}

fn touch_local_change(payload: &mut VaultPayload) {
    payload.sync.last_local_change = Utc::now().timestamp();
}

fn normalize_option(input: Option<String>) -> Option<String> {
    input
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ConnectionProtocol;

    #[test]
    fn should_encrypt_and_decrypt_payload() {
        let payload = VaultPayload {
            version: CURRENT_VAULT_VERSION,
            connections: vec![ConnectionProfile {
                id: "id-1".to_string(),
                name: "srv".to_string(),
                host: "127.0.0.1".to_string(),
                port: 22,
                username: "root".to_string(),
                password: Some("secret".to_string()),
                private_key: None,
                remote_path: Some("/".to_string()),
                protocols: vec![ConnectionProtocol::Ssh, ConnectionProtocol::Sftp],
                kind: None,
            }],
            ..VaultPayload::default()
        };

        let salt = [7u8; 16];
        let key = derive_key("master-password", &salt).expect("kdf should work");

        let encrypted = encrypt_payload(
            &payload,
            KeyMode::Password,
            &key,
            Some(&salt),
            "2026-01-01T00:00:00Z".to_string(),
            "2026-01-01T00:00:00Z".to_string(),
        )
        .expect("encrypt should work");

        let decrypted = decrypt_payload(&encrypted, &key).expect("decrypt should work");
        assert_eq!(decrypted.connections.len(), 1);
        assert_eq!(decrypted.connections[0].host, "127.0.0.1");
    }

    #[test]
    fn should_fail_on_wrong_key() {
        let payload = VaultPayload::default();
        let salt = [1u8; 16];
        let key = derive_key("correct", &salt).expect("kdf should work");
        let encrypted = encrypt_payload(
            &payload,
            KeyMode::Password,
            &key,
            Some(&salt),
            "2026-01-01T00:00:00Z".to_string(),
            "2026-01-01T00:00:00Z".to_string(),
        )
        .expect("encrypt should work");

        let wrong_key = derive_key("wrong", &salt).expect("kdf should work");
        assert!(decrypt_payload(&encrypted, &wrong_key).is_err());
    }
}
