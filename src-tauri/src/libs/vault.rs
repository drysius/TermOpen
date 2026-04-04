use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use chrono::Utc;
use directories::ProjectDirs;
use keyring::Entry;
use rand::{rngs::OsRng, RngCore};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::constants::{
    APP_KEYRING_SERVICE, CURRENT_PAYLOAD_VERSION, CURRENT_STORAGE_VERSION, KEYRING_VAULT_KEY,
    MANIFEST_FILE_NAME, OPENPTL_FILE_NAME, PROFILE_FILE_NAME, STORAGE_DIR_NAME,
    STORAGE_FILE_EXTENSION,
};
use crate::libs::models::{
    AppSettings, AuthServer, ConnectionProfile, KeyMode, KeychainEntry, ManifestBinPayload,
    ProfileBinPayload, SyncMetadata, VaultPayload, VaultStatus, WindowState,
};

#[derive(Debug, Clone)]
struct VaultRuntime {
    unlocked: bool,
    key_mode: Option<KeyMode>,
    key: Option<[u8; 32]>,
    salt: Option<[u8; 16]>,
    payload: Option<VaultPayload>,
    created_at: Option<i64>,
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
    storage_root: PathBuf,
    openptl_path: PathBuf,
    profile_path: PathBuf,
    manifest_path: PathBuf,
    runtime: VaultRuntime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OpenPtlBin {
    version: u32,
    key_mode: KeyMode,
    salt: Option<[u8; 16]>,
    key_check: [u8; 32],
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedBin {
    version: u32,
    nonce: [u8; 24],
    ciphertext: Vec<u8>,
    updated_at: i64,
}

impl VaultManager {
    pub fn new() -> Result<Self> {
        let dirs = ProjectDirs::from("com", "urubucode", "openptl")
            .ok_or_else(|| anyhow!("Nao foi possivel resolver diretorio de dados do aplicativo"))?;
        let data_dir = dirs.data_dir();
        fs::create_dir_all(data_dir).with_context(|| {
            format!("Falha ao criar diretorio de dados: {}", data_dir.display())
        })?;

        let storage_root = data_dir.join(STORAGE_DIR_NAME);
        fs::create_dir_all(&storage_root)
            .with_context(|| format!("Falha ao criar diretorio {}", storage_root.display()))?;

        cleanup_legacy_layout(data_dir, &storage_root)?;

        Ok(Self {
            openptl_path: storage_root.join(OPENPTL_FILE_NAME),
            profile_path: storage_root.join(PROFILE_FILE_NAME),
            manifest_path: storage_root.join(MANIFEST_FILE_NAME),
            storage_root,
            runtime: VaultRuntime::default(),
        })
    }

    pub fn status(&self) -> Result<VaultStatus> {
        let initialized = self.vault_initialized();
        let recoverable = self.openptl_exists() && !initialized;

        let key_mode = if self.runtime.key_mode.is_some() {
            self.runtime.key_mode.clone()
        } else if self.openptl_exists() {
            Some(self.read_openptl_file()?.key_mode)
        } else {
            None
        };

        Ok(VaultStatus {
            initialized,
            locked: !self.runtime.unlocked,
            key_mode,
            recoverable,
        })
    }

    pub fn init(&mut self, password: Option<String>) -> Result<VaultStatus> {
        if self.vault_initialized() {
            return Err(anyhow!("Vault ja foi inicializado"));
        }

        self.clear_local_storage()?;

        let (key_mode, key, salt) = if let Some(raw_password) = password {
            let pass = raw_password.trim().to_string();
            if pass.len() < 6 {
                return Err(anyhow!("A senha mestre deve ter ao menos 6 caracteres"));
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

        let mut payload = VaultPayload {
            version: CURRENT_PAYLOAD_VERSION,
            ..VaultPayload::default()
        };
        ensure_default_server(&mut payload.auth_servers);

        self.runtime = VaultRuntime {
            unlocked: true,
            key_mode: Some(key_mode),
            key: Some(key),
            salt,
            payload: Some(payload),
            created_at: Some(Utc::now().timestamp()),
        };

        self.persist()?;
        self.status()
    }

    pub fn unlock(&mut self, password: Option<String>) -> Result<VaultStatus> {
        if !self.vault_initialized() {
            return Err(anyhow!("Vault ainda nao foi inicializado"));
        }

        let openptl = self.read_openptl_file()?;
        if openptl.version != CURRENT_STORAGE_VERSION {
            return Err(anyhow!(
                "Versao de openptl.bin nao suportada. Atual: {}, encontrada: {}",
                CURRENT_STORAGE_VERSION,
                openptl.version
            ));
        }

        let (key, salt) = match openptl.key_mode {
            KeyMode::Password => {
                let raw_password =
                    password.ok_or_else(|| anyhow!("Senha mestre obrigatoria para este vault"))?;
                let pass = raw_password.trim();
                if pass.is_empty() {
                    return Err(anyhow!("Senha mestre obrigatoria para este vault"));
                }
                let salt = openptl
                    .salt
                    .ok_or_else(|| anyhow!("Salt ausente no openptl.bin"))?;
                let key = derive_key(pass, &salt)?;
                (key, Some(salt))
            }
            KeyMode::Keychain => (load_keychain_key()?, None),
        };

        if compute_key_check(&key) != openptl.key_check {
            return Err(anyhow!("Senha mestre invalida"));
        }

        let mut payload = self.read_payload_from_disk(&key)?;
        payload.version = CURRENT_PAYLOAD_VERSION;
        ensure_default_server(&mut payload.auth_servers);

        self.runtime = VaultRuntime {
            unlocked: true,
            key_mode: Some(openptl.key_mode),
            key: Some(key),
            salt,
            payload: Some(payload),
            created_at: Some(openptl.created_at),
        };

        self.status()
    }

    pub fn lock(&mut self) -> VaultStatus {
        self.runtime = VaultRuntime::default();
        VaultStatus {
            initialized: self.vault_initialized(),
            locked: true,
            key_mode: None,
            recoverable: self.openptl_exists() && !self.vault_initialized(),
        }
    }

    pub fn reset_all(&mut self) -> Result<VaultStatus> {
        self.runtime = VaultRuntime::default();
        self.clear_local_storage()?;
        clear_keychain_key();
        self.status()
    }

    pub fn verify_master_password(&self, password: &str) -> Result<()> {
        self.assert_unlocked()?;

        let normalized = password.trim();
        if normalized.is_empty() {
            return Err(anyhow!("Informe a senha mestre atual"));
        }

        let current_mode = self
            .runtime
            .key_mode
            .clone()
            .ok_or_else(|| anyhow!("Modo de chave nao encontrado"))?;

        match current_mode {
            KeyMode::Password => {
                let salt = self
                    .runtime
                    .salt
                    .ok_or_else(|| anyhow!("Salt ausente para validar senha atual"))?;
                let derived = derive_key(normalized, &salt)?;
                let current_key = self
                    .runtime
                    .key
                    .ok_or_else(|| anyhow!("Chave atual indisponivel"))?;

                if derived != current_key {
                    return Err(anyhow!("Senha mestre atual invalida"));
                }
            }
            KeyMode::Keychain => {
                return Err(anyhow!(
                    "Este vault usa chave do sistema e nao aceita senha mestre local"
                ));
            }
        }

        Ok(())
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
                self.verify_master_password(&old)?;
            }
            KeyMode::Keychain => {}
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

        if uuid::Uuid::parse_str(profile.id.trim()).is_err() {
            return Err(anyhow!("ID de host invalido: deve ser UUID"));
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

        if uuid::Uuid::parse_str(entry.id.trim()).is_err() {
            return Err(anyhow!("ID de keychain invalido: deve ser UUID"));
        }

        entry.name = entry.name.trim().to_string();
        entry.password = normalize_option(entry.password);
        entry.private_key = normalize_option(entry.private_key);
        entry.public_key = normalize_option(entry.public_key);
        entry.passphrase = normalize_option(entry.passphrase);

        if entry.name.is_empty() {
            return Err(anyhow!("Nome e obrigatorio no keychain"));
        }

        if entry.private_key.is_none() && entry.public_key.is_none() && entry.password.is_none() {
            return Err(anyhow!(
                "Informe ao menos uma credencial no keychain (senha, chave privada ou chave publica)"
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
        let mut servers = if self.runtime.unlocked {
            self.payload()?.auth_servers.clone()
        } else {
            Vec::new()
        };
        ensure_default_server(&mut servers);
        servers.sort_by(|a, b| a.label.cmp(&b.label));
        Ok(servers)
    }

    pub fn merge_remote_servers(&mut self, remote: Vec<AuthServer>) -> Result<()> {
        if !self.runtime.unlocked {
            return Ok(());
        }

        let payload = self.payload_mut()?;
        for server in remote {
            if !payload.auth_servers.iter().any(|s| s.id == server.id) {
                payload.auth_servers.push(server);
            }
        }
        ensure_default_server(&mut payload.auth_servers);
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
        ensure_default_server(&mut payload.auth_servers);
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
        ensure_default_server(&mut payload.auth_servers);
        touch_local_change(payload);
        self.persist()
    }

    pub fn selected_auth_server(&self) -> Result<AuthServer> {
        if !self.runtime.unlocked {
            return Ok(AuthServer::default_server());
        }

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
        settings.sftp_chunk_size_kb = settings.sftp_chunk_size_kb.clamp(64, 8192);
        settings.sftp_reconnect_delay_seconds = settings.sftp_reconnect_delay_seconds.clamp(1, 120);
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

    pub fn current_key(&self) -> Result<[u8; 32]> {
        self.runtime
            .key
            .ok_or_else(|| anyhow!("Chave do vault indisponivel"))
    }

    pub fn decrypt_manifest_bytes(&self, encrypted_bytes: &[u8]) -> Result<ManifestBinPayload> {
        let key = self.current_key()?;
        let encrypted: EncryptedBin = decode_bin(encrypted_bytes, "manifest.bin invalido")?;
        decrypt_bin_payload(&encrypted, &key, "manifest.bin")
    }

    pub fn read_local_bin_file(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let normalized = normalize_bin_file_name(name)?;
        let path = self.storage_root.join(&normalized);
        if !path.exists() {
            return Ok(None);
        }
        let bytes =
            fs::read(&path).with_context(|| format!("Falha ao ler arquivo {}", path.display()))?;
        Ok(Some(bytes))
    }

    pub fn write_local_bin_file(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let normalized = normalize_bin_file_name(name)?;
        let path = self.storage_root.join(&normalized);
        fs::write(&path, bytes).with_context(|| format!("Falha ao escrever {}", path.display()))
    }

    pub fn remove_local_bin_file(&self, name: &str) -> Result<()> {
        let normalized = normalize_bin_file_name(name)?;
        let path = self.storage_root.join(&normalized);
        if path.exists() {
            fs::remove_file(&path)
                .with_context(|| format!("Falha ao remover arquivo {}", path.display()))?;
        }
        Ok(())
    }

    pub fn list_local_bin_files(&self) -> Result<Vec<(String, Vec<u8>)>> {
        if !self.storage_root.exists() {
            return Ok(Vec::new());
        }

        let entries = fs::read_dir(&self.storage_root)
            .with_context(|| format!("Falha ao listar {}", self.storage_root.display()))?;
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
            else {
                continue;
            };
            if !is_bin_file_name(&name) {
                continue;
            }
            let bytes = fs::read(&path)
                .with_context(|| format!("Falha ao ler arquivo {}", path.display()))?;
            files.push((name, bytes));
        }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(files)
    }

    pub fn replace_local_files(&mut self, files: &HashMap<String, Vec<u8>>) -> Result<()> {
        self.clear_local_storage()?;
        fs::create_dir_all(&self.storage_root)
            .with_context(|| format!("Falha ao criar {}", self.storage_root.display()))?;

        for (name, bytes) in files {
            let normalized = normalize_bin_file_name(name)?;
            let path = self.storage_root.join(&normalized);
            fs::write(&path, bytes)
                .with_context(|| format!("Falha ao escrever {}", path.display()))?;
        }

        if self.runtime.unlocked {
            self.reload_unlocked_from_disk()?;
        }

        Ok(())
    }

    pub fn clear_local_storage(&self) -> Result<()> {
        if !self.storage_root.exists() {
            return Ok(());
        }

        let entries = fs::read_dir(&self.storage_root)
            .with_context(|| format!("Falha ao listar {}", self.storage_root.display()))?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(&path)
                    .with_context(|| format!("Falha ao remover pasta {}", path.display()))?;
            } else {
                fs::remove_file(&path)
                    .with_context(|| format!("Falha ao remover arquivo {}", path.display()))?;
            }
        }
        Ok(())
    }

    pub fn validate_password_for_openptl_bytes(
        &self,
        openptl_bytes: &[u8],
        password: &str,
    ) -> Result<bool> {
        let openptl: OpenPtlBin = decode_bin(openptl_bytes, "openptl.bin invalido")?;
        match openptl.key_mode {
            KeyMode::Password => {
                let salt = openptl
                    .salt
                    .ok_or_else(|| anyhow!("Salt ausente no openptl.bin"))?;
                let key = derive_key(password.trim(), &salt)?;
                Ok(compute_key_check(&key) == openptl.key_check)
            }
            KeyMode::Keychain => Err(anyhow!(
                "Backup usa keychain do sistema. Recuperacao remota exige senha mestre"
            )),
        }
    }

    pub fn local_manifest_snapshot(&self) -> Result<ManifestBinPayload> {
        let key = self.current_key()?;
        let encrypted: EncryptedBin = read_bin_file(&self.manifest_path)?;
        decrypt_bin_payload(&encrypted, &key, "manifest.bin")
    }

    pub fn reload_unlocked_from_disk_and_persist(&mut self) -> Result<()> {
        self.reload_unlocked_from_disk()?;
        self.persist()
    }

    pub fn save_window_state(&mut self, next: WindowState) -> Result<()> {
        self.assert_unlocked()?;
        let payload = self.payload_mut()?;
        payload.window_state = Some(next);
        self.persist()
    }

    pub fn window_state(&self) -> Result<Option<WindowState>> {
        Ok(self.payload()?.window_state.clone())
    }

    fn reload_unlocked_from_disk(&mut self) -> Result<()> {
        self.assert_unlocked()?;

        let key = self
            .runtime
            .key
            .ok_or_else(|| anyhow!("Chave do vault indisponivel"))?;
        let openptl = self.read_openptl_file()?;

        if compute_key_check(&key) != openptl.key_check {
            return Err(anyhow!("openptl.bin local pertence a outra chave mestre"));
        }

        let mut payload = self.read_payload_from_disk(&key)?;
        payload.version = CURRENT_PAYLOAD_VERSION;
        ensure_default_server(&mut payload.auth_servers);

        self.runtime.payload = Some(payload);
        self.runtime.key_mode = Some(openptl.key_mode);
        self.runtime.salt = openptl.salt;
        self.runtime.created_at = Some(openptl.created_at);

        Ok(())
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

    fn persist(&mut self) -> Result<()> {
        self.assert_unlocked()?;

        let key_mode = self
            .runtime
            .key_mode
            .clone()
            .ok_or_else(|| anyhow!("Modo de chave nao definido"))?;
        let key = self
            .runtime
            .key
            .ok_or_else(|| anyhow!("Chave do vault indisponivel"))?;

        fs::create_dir_all(&self.storage_root)
            .with_context(|| format!("Falha ao criar {}", self.storage_root.display()))?;

        let now = Utc::now().timestamp();
        let created_at = self.runtime.created_at.unwrap_or(now);

        let payload = self
            .runtime
            .payload
            .as_mut()
            .ok_or_else(|| anyhow!("Payload do vault indisponivel"))?;

        for profile in &mut payload.connections {
            if profile.id.trim().is_empty() {
                profile.id = uuid::Uuid::new_v4().to_string();
            }
            ensure_uuid(&profile.id, "host")?;
            profile.normalize_protocols();
        }

        for entry in &mut payload.keychain {
            if entry.id.trim().is_empty() {
                entry.id = uuid::Uuid::new_v4().to_string();
                entry.created_at = now;
            }
            ensure_uuid(&entry.id, "keychain")?;
        }

        payload.connections.sort_by(|a, b| a.name.cmp(&b.name));
        payload.keychain.sort_by(|a, b| a.name.cmp(&b.name));
        ensure_default_server(&mut payload.auth_servers);

        let profile_payload = ProfileBinPayload {
            version: CURRENT_PAYLOAD_VERSION,
            settings: payload.settings.clone(),
            sync: payload.sync.clone(),
            auth_servers: payload.auth_servers.clone(),
            window_state: payload.window_state.clone(),
        };
        let profile_hash = profile_content_hash(&profile_payload, &key)?;

        let mut hosts = BTreeMap::new();
        let mut keychain = BTreeMap::new();
        let mut expected_files = HashSet::new();

        for profile in &payload.connections {
            let file_name = format!("{}.bin", profile.id);
            let path = self.storage_root.join(&file_name);
            let encrypted = encrypt_bin_payload(profile, &key, &profile.id, now)?;
            let encoded = encode_bin(&encrypted)?;
            fs::write(&path, &encoded)
                .with_context(|| format!("Falha ao escrever arquivo {}", path.display()))?;
            hosts.insert(
                profile.id.clone(),
                content_hash_payload(profile, &key, &profile.id)?,
            );
            expected_files.insert(file_name);
        }

        for entry in &payload.keychain {
            let file_name = format!("{}.bin", entry.id);
            let path = self.storage_root.join(&file_name);
            let encrypted = encrypt_bin_payload(entry, &key, &entry.id, now)?;
            let encoded = encode_bin(&encrypted)?;
            fs::write(&path, &encoded)
                .with_context(|| format!("Falha ao escrever arquivo {}", path.display()))?;
            keychain.insert(
                entry.id.clone(),
                content_hash_payload(entry, &key, &entry.id)?,
            );
            expected_files.insert(file_name);
        }

        let manifest_payload = ManifestBinPayload {
            version: CURRENT_PAYLOAD_VERSION,
            profile: profile_hash,
            hosts,
            keychain,
        };
        let manifest_encrypted =
            encrypt_bin_payload(&manifest_payload, &key, MANIFEST_FILE_NAME, now)?;
        write_bin_file(&self.manifest_path, &manifest_encrypted)?;

        let profile_encrypted =
            encrypt_bin_payload(&profile_payload, &key, PROFILE_FILE_NAME, now)?;
        write_bin_file(&self.profile_path, &profile_encrypted)?;

        let openptl = OpenPtlBin {
            version: CURRENT_STORAGE_VERSION,
            key_mode,
            salt: self.runtime.salt,
            key_check: compute_key_check(&key),
            created_at,
            updated_at: now,
        };
        write_bin_file(&self.openptl_path, &openptl)?;

        self.runtime.created_at = Some(created_at);
        self.cleanup_stale_item_files(&expected_files)
    }

    fn cleanup_stale_item_files(&self, expected: &HashSet<String>) -> Result<()> {
        let entries = fs::read_dir(&self.storage_root)
            .with_context(|| format!("Falha ao listar {}", self.storage_root.display()))?;

        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
            else {
                continue;
            };

            if !is_bin_file_name(&name) {
                continue;
            }
            if name == OPENPTL_FILE_NAME || name == PROFILE_FILE_NAME || name == MANIFEST_FILE_NAME
            {
                continue;
            }
            if expected.contains(&name) {
                continue;
            }

            fs::remove_file(&path)
                .with_context(|| format!("Falha ao remover arquivo obsoleto {}", path.display()))?;
        }

        Ok(())
    }

    fn read_openptl_file(&self) -> Result<OpenPtlBin> {
        read_bin_file(&self.openptl_path)
    }

    fn read_payload_from_disk(&self, key: &[u8; 32]) -> Result<VaultPayload> {
        let profile_encrypted: EncryptedBin = read_bin_file(&self.profile_path)?;
        let profile_payload: ProfileBinPayload =
            decrypt_bin_payload(&profile_encrypted, key, PROFILE_FILE_NAME)?;

        let manifest_encrypted: EncryptedBin = read_bin_file(&self.manifest_path)?;
        let manifest_payload: ManifestBinPayload =
            decrypt_bin_payload(&manifest_encrypted, key, MANIFEST_FILE_NAME)?;

        if profile_payload.version != CURRENT_PAYLOAD_VERSION {
            return Err(anyhow!(
                "Versao de profile.bin nao suportada. Atual: {}, encontrada: {}",
                CURRENT_PAYLOAD_VERSION,
                profile_payload.version
            ));
        }

        if manifest_payload.version != CURRENT_PAYLOAD_VERSION {
            return Err(anyhow!(
                "Versao de manifest.bin nao suportada. Atual: {}, encontrada: {}",
                CURRENT_PAYLOAD_VERSION,
                manifest_payload.version
            ));
        }

        let expected_profile_hash = manifest_payload.profile.clone();
        let actual_profile_hash = profile_content_hash(&profile_payload, key)?;
        if actual_profile_hash != expected_profile_hash {
            return Err(anyhow!(
                "Hash divergente para profile. Esperado {}, obtido {}",
                expected_profile_hash,
                actual_profile_hash
            ));
        }

        let mut connections = Vec::new();
        let mut keychain = Vec::new();

        for (uuid, expected_hash) in manifest_payload.hosts {
            ensure_uuid(&uuid, "host")?;
            let path = self.storage_root.join(format!("{}.bin", uuid));
            let encoded = fs::read(&path)
                .with_context(|| format!("Falha ao ler arquivo {}", path.display()))?;
            let encrypted: EncryptedBin = decode_bin(&encoded, "Arquivo de host invalido")?;
            let mut profile: ConnectionProfile =
                decrypt_bin_payload(&encrypted, key, "Arquivo de host")?;
            profile.id = uuid;
            profile.normalize_protocols();
            let actual_content_hash = content_hash_payload(&profile, key, profile.id.as_str())?;
            if actual_content_hash != expected_hash {
                return Err(anyhow!(
                    "Hash de conteudo divergente para host {}. Esperado {}, obtido {}",
                    profile.id,
                    expected_hash,
                    actual_content_hash
                ));
            }
            connections.push(profile);
        }

        for (uuid, expected_hash) in manifest_payload.keychain {
            ensure_uuid(&uuid, "keychain")?;
            let path = self.storage_root.join(format!("{}.bin", uuid));
            let encoded = fs::read(&path)
                .with_context(|| format!("Falha ao ler arquivo {}", path.display()))?;
            let encrypted: EncryptedBin = decode_bin(&encoded, "Arquivo de keychain invalido")?;
            let mut entry: KeychainEntry =
                decrypt_bin_payload(&encrypted, key, "Arquivo de keychain")?;
            entry.id = uuid;
            let actual_content_hash = content_hash_payload(&entry, key, entry.id.as_str())?;
            if actual_content_hash != expected_hash {
                return Err(anyhow!(
                    "Hash de conteudo divergente para keychain {}. Esperado {}, obtido {}",
                    entry.id,
                    expected_hash,
                    actual_content_hash
                ));
            }
            keychain.push(entry);
        }

        Ok(VaultPayload {
            version: CURRENT_PAYLOAD_VERSION,
            connections,
            keychain,
            settings: profile_payload.settings,
            sync: profile_payload.sync,
            auth_servers: profile_payload.auth_servers,
            window_state: profile_payload.window_state,
        })
    }

    fn vault_initialized(&self) -> bool {
        self.openptl_exists() && self.profile_path.exists() && self.manifest_path.exists()
    }

    fn openptl_exists(&self) -> bool {
        self.openptl_path.exists()
    }
}

fn cleanup_legacy_layout(data_dir: &Path, storage_root: &Path) -> Result<()> {
    let legacy_vault = data_dir.join("vault.enc.json");
    if legacy_vault.exists() {
        let _ = fs::remove_file(&legacy_vault);
    }

    let legacy_default = storage_root.join("default");
    if legacy_default.exists() && legacy_default.is_dir() {
        let _ = fs::remove_dir_all(&legacy_default);
    }

    if storage_root.exists() {
        let entries = fs::read_dir(storage_root)
            .with_context(|| format!("Falha ao listar {}", storage_root.display()))?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                let _ = fs::remove_dir_all(&path);
                continue;
            }

            let Some(name) = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
            else {
                continue;
            };
            if is_bin_file_name(&name) {
                continue;
            }
            let _ = fs::remove_file(&path);
        }
    }

    Ok(())
}

fn ensure_default_server(servers: &mut Vec<AuthServer>) {
    if !servers.iter().any(|item| item.id == "default") {
        servers.push(AuthServer::default_server());
    }
}

fn ensure_uuid(value: &str, kind: &str) -> Result<()> {
    if uuid::Uuid::parse_str(value).is_err() {
        return Err(anyhow!("ID de {} invalido: {}", kind, value));
    }
    Ok(())
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

fn compute_key_check(key: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(b"openptl-key-check-v1");
    let digest = hasher.finalize();

    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

#[cfg(test)]
fn hash_bytes_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    to_hex(&digest)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn content_hash_bytes(key: &[u8; 32], file_tag: &str, plaintext: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"openptl-content-hash-v1");
    hasher.update(key);
    hasher.update(file_tag.as_bytes());
    hasher.update(plaintext);
    let digest = hasher.finalize();
    to_hex(&digest)
}

fn content_hash_payload<T: Serialize>(
    payload: &T,
    key: &[u8; 32],
    file_tag: &str,
) -> Result<String> {
    let plaintext = encode_bin(payload)?;
    Ok(content_hash_bytes(key, file_tag, &plaintext))
}

fn profile_hash_payload_input(payload: &ProfileBinPayload) -> ProfileBinPayload {
    let mut normalized = payload.clone();
    // Ignore local sync bookkeeping fields so profile conflicts reflect real user-config changes.
    normalized.sync = SyncMetadata {
        last_sync_at: None,
        last_remote_modified: None,
        last_local_change: 0,
    };
    normalized
}

fn profile_content_hash(payload: &ProfileBinPayload, key: &[u8; 32]) -> Result<String> {
    let normalized = profile_hash_payload_input(payload);
    content_hash_payload(&normalized, key, PROFILE_FILE_NAME)
}

fn encode_bin<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    bincode::serde::encode_to_vec(value, bincode::config::standard())
        .map_err(|error| anyhow!("Falha ao serializar binario: {}", error))
}

fn decode_bin<T: DeserializeOwned>(bytes: &[u8], context: &str) -> Result<T> {
    bincode::serde::decode_from_slice(bytes, bincode::config::standard())
        .map(|(value, _)| value)
        .map_err(|error| anyhow!("{}: {}", context, error))
}

fn read_bin_file<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let raw = fs::read(path).with_context(|| format!("Falha ao ler arquivo {}", path.display()))?;
    decode_bin(&raw, &format!("Falha ao decodificar {}", path.display()))
}

fn write_bin_file<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Falha ao criar diretorio {}", parent.display()))?;
    }
    let data = encode_bin(value)?;
    fs::write(path, data).with_context(|| format!("Falha ao escrever arquivo {}", path.display()))
}

fn derive_nonce(key: &[u8; 32], file_tag: &str, plaintext: &[u8]) -> [u8; 24] {
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(file_tag.as_bytes());
    hasher.update(plaintext);
    let digest = hasher.finalize();

    let mut nonce = [0u8; 24];
    nonce.copy_from_slice(&digest[..24]);
    nonce
}

fn encrypt_bin_payload<T: Serialize>(
    payload: &T,
    key: &[u8; 32],
    file_tag: &str,
    updated_at: i64,
) -> Result<EncryptedBin> {
    let plaintext = encode_bin(payload)?;
    let nonce = derive_nonce(key, file_tag, &plaintext);

    let cipher = XChaCha20Poly1305::new(key.into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| anyhow!("Falha ao criptografar payload"))?;

    Ok(EncryptedBin {
        version: CURRENT_STORAGE_VERSION,
        nonce,
        ciphertext,
        updated_at,
    })
}

fn decrypt_bin_payload<T: DeserializeOwned>(
    file: &EncryptedBin,
    key: &[u8; 32],
    context_message: &str,
) -> Result<T> {
    if file.version != CURRENT_STORAGE_VERSION {
        return Err(anyhow!(
            "Versao de arquivo nao suportada. Atual: {}, encontrada: {}",
            CURRENT_STORAGE_VERSION,
            file.version
        ));
    }

    let cipher = XChaCha20Poly1305::new(key.into());
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&file.nonce), file.ciphertext.as_ref())
        .map_err(|_| anyhow!("Falha ao descriptografar {}", context_message))?;

    decode_bin(
        &plaintext,
        &format!("Falha ao decodificar {}", context_message),
    )
}

fn normalize_bin_file_name(input: &str) -> Result<String> {
    let value = input.trim();
    if value.is_empty() {
        return Err(anyhow!("Nome de arquivo vazio"));
    }
    if value.contains('/') || value.contains('\\') {
        return Err(anyhow!("Nome de arquivo invalido"));
    }
    if !is_bin_file_name(value) {
        return Err(anyhow!("Apenas arquivos .bin sao permitidos"));
    }
    Ok(value.to_string())
}

fn is_bin_file_name(name: &str) -> bool {
    name.to_ascii_lowercase()
        .ends_with(&format!(".{}", STORAGE_FILE_EXTENSION))
}

fn persist_keychain_key(key: &[u8; 32]) -> Result<()> {
    let entry =
        Entry::new(APP_KEYRING_SERVICE, KEYRING_VAULT_KEY).context("Falha ao preparar keychain")?;
    entry
        .set_password(&to_hex(key))
        .context("Falha ao salvar chave no keychain")
}

fn load_keychain_key() -> Result<[u8; 32]> {
    let entry =
        Entry::new(APP_KEYRING_SERVICE, KEYRING_VAULT_KEY).context("Falha ao preparar keychain")?;
    let value = entry
        .get_password()
        .context("Nao foi possivel ler chave do keychain")?;

    let bytes = hex_to_bytes(&value)?;
    if bytes.len() != 32 {
        return Err(anyhow!("Chave do keychain invalida"));
    }

    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn clear_keychain_key() {
    if let Ok(entry) = Entry::new(APP_KEYRING_SERVICE, KEYRING_VAULT_KEY) {
        let _ = entry.delete_password();
    }
}

fn hex_to_bytes(input: &str) -> Result<Vec<u8>> {
    let clean = input.trim();
    if clean.len() % 2 != 0 {
        return Err(anyhow!("Hex invalido"));
    }
    let mut out = Vec::with_capacity(clean.len() / 2);
    let bytes = clean.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let chunk = std::str::from_utf8(&bytes[i..i + 2]).context("Hex invalido")?;
        let value = u8::from_str_radix(chunk, 16).context("Hex invalido")?;
        out.push(value);
    }
    Ok(out)
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
    use crate::libs::models::{ConnectionKind, ConnectionProtocol};
    use std::path::Path;
    use tempfile::tempdir;

    fn test_vault_manager(storage_root: &Path) -> VaultManager {
        fs::create_dir_all(storage_root).expect("test storage should be created");
        VaultManager {
            storage_root: storage_root.to_path_buf(),
            openptl_path: storage_root.join(OPENPTL_FILE_NAME),
            profile_path: storage_root.join(PROFILE_FILE_NAME),
            manifest_path: storage_root.join(MANIFEST_FILE_NAME),
            runtime: VaultRuntime::default(),
        }
    }

    fn snapshot_files(vault: &VaultManager) -> HashMap<String, Vec<u8>> {
        vault
            .list_local_bin_files()
            .expect("snapshot should list files")
            .into_iter()
            .collect()
    }

    #[test]
    fn should_encrypt_and_decrypt_record() {
        let profile = ConnectionProfile {
            id: "6ec2a7db-c0af-4435-b38c-228f0cc9ec31".to_string(),
            name: "srv".to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            password: Some("secret".to_string()),
            private_key: None,
            keychain_id: None,
            remote_path: Some("/".to_string()),
            protocols: vec![ConnectionProtocol::Ssh, ConnectionProtocol::Sftp],
            kind: Some(ConnectionKind::Both),
        };

        let salt = [7u8; 16];
        let key = derive_key("master-password", &salt).expect("kdf should work");
        let encrypted =
            encrypt_bin_payload(&profile, &key, &profile.id, 1_700_000_000).expect("encrypt");
        let decrypted: ConnectionProfile =
            decrypt_bin_payload(&encrypted, &key, "decrypt test").expect("decrypt");
        assert_eq!(decrypted.host, "127.0.0.1");
    }

    #[test]
    fn should_fail_on_wrong_key() {
        let value = ManifestBinPayload {
            version: 1,
            profile: "hash-profile".to_string(),
            hosts: BTreeMap::new(),
            keychain: BTreeMap::new(),
        };

        let salt = [1u8; 16];
        let key = derive_key("correct", &salt).expect("kdf should work");
        let encrypted =
            encrypt_bin_payload(&value, &key, "manifest.bin", 1_700_000_000).expect("encrypt");

        let wrong_key = derive_key("wrong", &salt).expect("kdf should work");
        let decrypted =
            decrypt_bin_payload::<ManifestBinPayload>(&encrypted, &wrong_key, "decrypt");
        assert!(decrypted.is_err());
    }

    #[test]
    fn should_keep_password_valid_for_snapshot_x_even_after_snapshot_y_changes() {
        let temp_dir = tempdir().expect("temp dir should be created");
        let storage_root = temp_dir.path().join("vault-test");
        let mut vault = test_vault_manager(&storage_root);
        let password = "senha-super-segura";

        vault
            .init(Some(password.to_string()))
            .expect("vault should initialize");

        // Versao X: estado inicial sincronizado.
        let snapshot_x = snapshot_files(&vault);
        let profile_hash_x = hash_bytes_hex(
            snapshot_x
                .get(PROFILE_FILE_NAME)
                .expect("version X should include profile.bin"),
        );
        let openptl_x = snapshot_x
            .get(OPENPTL_FILE_NAME)
            .expect("version X should include openptl.bin")
            .clone();

        // Versao Y: cliente altera settings/profile e persiste.
        let mut settings = vault.settings_get().expect("settings should load");
        settings.sync_interval_minutes = 7;
        settings.sync_on_settings_change = true;
        vault
            .settings_update(settings)
            .expect("settings should be updated");

        let snapshot_y = snapshot_files(&vault);
        let profile_hash_y = hash_bytes_hex(
            snapshot_y
                .get(PROFILE_FILE_NAME)
                .expect("version Y should include profile.bin"),
        );

        // Simula conflito client/server: hashes divergentes entre X (server) e Y (client).
        assert_ne!(
            profile_hash_x, profile_hash_y,
            "profile hash should diverge between snapshot X and Y"
        );

        // Mesmo com Y local, a senha atual continua valida para o openptl de X.
        assert!(
            vault
                .validate_password_for_openptl_bytes(&openptl_x, password)
                .expect("password validation should run"),
            "same password should validate against version X metadata"
        );

        // Restaurando X com a mesma senha deve continuar descriptografando normalmente.
        vault
            .replace_local_files(&snapshot_x)
            .expect("replacing with snapshot X should succeed");
        vault.lock();
        let status = vault
            .unlock(Some(password.to_string()))
            .expect("unlock with same password should succeed for snapshot X");
        assert!(!status.locked, "vault should be unlocked after restoring X");
    }
}


