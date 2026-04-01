import { invoke } from "@tauri-apps/api/core";

import type {
  AppSettings,
  AuthServer,
  BinaryPreviewResult,
  ConnectionProfile,
  KnownHostEntry,
  KeychainEntry,
  RecoveryProbeResult,
  ReleaseCheckResult,
  SftpEntry,
  SyncConflictDecision,
  SyncConflictPreview,
  SshConnectResult,
  SshSessionInfo,
  SyncState,
  TextReadChunk,
  VaultStatus,
} from "@/types/termopen";

export const api = {
  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  vaultInit: (password?: string | null) =>
    invoke<VaultStatus>("vault_init", { password }),
  vaultUnlock: (password?: string | null) =>
    invoke<VaultStatus>("vault_unlock", { password }),
  vaultLock: () => invoke<VaultStatus>("vault_lock"),
  vaultResetAll: () => invoke<VaultStatus>("vault_reset_all"),
  vaultChangeMasterPassword: (oldPassword: string | null, newPassword: string) =>
    invoke<VaultStatus>("vault_change_master_password", {
      oldPassword,
      newPassword,
    }),

  connectionsList: () => invoke<ConnectionProfile[]>("connections_list"),
  connectionSave: (profile: ConnectionProfile) => invoke<ConnectionProfile>("connection_save", { profile }),
  connectionDelete: (id: string) => invoke<void>("connection_delete", { id }),

  keychainList: () => invoke<KeychainEntry[]>("keychain_list"),
  keychainSave: (entry: KeychainEntry) => invoke<KeychainEntry>("keychain_save", { entry }),
  keychainDelete: (id: string) => invoke<void>("keychain_delete", { id }),

  settingsGet: () => invoke<AppSettings>("settings_get"),
  settingsUpdate: (settings: AppSettings) => invoke<AppSettings>("settings_update", { settings }),

  sshConnect: (profileId: string) => invoke<SshSessionInfo>("ssh_connect", { profileId }),
  sshConnectEx: (
    profileId: string,
    options?: {
      acceptUnknownHost?: boolean;
      passwordOverride?: string | null;
      keychainIdOverride?: string | null;
      saveAuthChoice?: boolean;
    },
  ) =>
    invoke<SshConnectResult>("ssh_connect_ex", {
      profileId,
      acceptUnknownHost: options?.acceptUnknownHost,
      passwordOverride: options?.passwordOverride,
      keychainIdOverride: options?.keychainIdOverride,
      saveAuthChoice: options?.saveAuthChoice,
    }),
  sshWrite: (sessionId: string, data: string) => invoke<string>("ssh_write", { sessionId, data }),
  sshResize: (sessionId: string, cols: number, rows: number) => invoke<void>("ssh_resize", { sessionId, cols, rows }),
  sshDisconnect: (sessionId: string) => invoke<void>("ssh_disconnect", { sessionId }),
  sshSessions: () => invoke<SshSessionInfo[]>("ssh_sessions"),
  localTerminalConnect: (path?: string | null) =>
    invoke<SshSessionInfo>("local_terminal_connect", { path }),
  knownHostsList: (path?: string | null) => invoke<KnownHostEntry[]>("known_hosts_list_cmd", { path }),
  knownHostsEnsure: (path?: string | null) => invoke<string>("known_hosts_ensure_cmd", { path }),
  knownHostsRemove: (lineRaw: string, path?: string | null) =>
    invoke<void>("known_hosts_remove_cmd", { lineRaw, path }),
  knownHostsAdd: (payload: {
    host: string;
    port: number;
    keyType: string;
    keyBase64: string;
    path?: string | null;
  }) =>
    invoke<KnownHostEntry>("known_hosts_add_cmd", {
      host: payload.host,
      port: payload.port,
      keyType: payload.keyType,
      keyBase64: payload.keyBase64,
      path: payload.path,
    }),

  sftpList: (sessionId: string, path: string) => invoke<SftpEntry[]>("sftp_list", { sessionId, path }),
  sftpRead: (sessionId: string, path: string) => invoke<string>("sftp_read", { sessionId, path }),
  sftpReadChunk: (sessionId: string, path: string, offset: number) =>
    invoke<TextReadChunk>("sftp_read_chunk", { sessionId, path, offset }),
  sftpWrite: (sessionId: string, path: string, content: string) =>
    invoke<void>("sftp_write", { sessionId, path, content }),
  sftpRename: (sessionId: string, fromPath: string, toPath: string) =>
    invoke<void>("sftp_rename", { sessionId, fromPath, toPath }),
  sftpDelete: (sessionId: string, path: string, isDir: boolean) =>
    invoke<void>("sftp_delete", { sessionId, path, isDir }),
  sftpMkdir: (sessionId: string, path: string) => invoke<void>("sftp_mkdir", { sessionId, path }),
  sftpCreateFile: (sessionId: string, path: string) => invoke<void>("sftp_create_file", { sessionId, path }),
  sftpReadBinaryPreview: (sessionId: string, path: string, maxBytes?: number | null) =>
    invoke<BinaryPreviewResult>("sftp_read_binary_preview", { sessionId, path, maxBytes }),
  sftpTransfer: (
    transferId: string,
    fromSessionId: string | null,
    fromPath: string,
    toSessionId: string | null,
    toPath: string,
  ) =>
    invoke<void>("sftp_transfer", {
      transferId,
      fromSessionId,
      fromPath,
      toSessionId,
      toPath,
    }),
  localList: (path?: string | null) => invoke<SftpEntry[]>("local_list", { path }),
  localRead: (path: string) => invoke<string>("local_read", { path }),
  localReadChunk: (path: string, offset: number) =>
    invoke<TextReadChunk>("local_read_chunk", { path, offset }),
  localRename: (fromPath: string, toPath: string) => invoke<void>("local_rename", { fromPath, toPath }),
  localDelete: (path: string, isDir: boolean) => invoke<void>("local_delete", { path, isDir }),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),
  localCreateFile: (path: string) => invoke<void>("local_create_file", { path }),
  localReadBinaryPreview: (path: string, maxBytes?: number | null) =>
    invoke<BinaryPreviewResult>("local_read_binary_preview", { path, maxBytes }),
  localWrite: (path: string, content: string) => invoke<void>("local_write", { path, content }),

  authServersList: () => invoke<AuthServer[]>("auth_servers_list"),
  authServerSave: (server: AuthServer) => invoke<AuthServer>("auth_server_save", { server }),
  authServerDelete: (id: string) => invoke<void>("auth_server_delete", { id }),
  authServersFetchRemote: () => invoke<AuthServer[]>("auth_servers_fetch_remote"),

  syncGoogleLogin: (serverAddress?: string | null) =>
    invoke<SyncState>("sync_google_login", { serverAddress }),
  syncLoggedUser: () => invoke<[string, string] | null>("sync_logged_user"),
  syncCancel: () => invoke<SyncState>("sync_cancel"),
  syncPush: () => invoke<SyncState>("sync_push"),
  syncPull: () => invoke<SyncState>("sync_pull"),
  syncStartupPreview: () => invoke<SyncConflictPreview>("sync_startup_preview"),
  syncStartupResolve: (decisions: SyncConflictDecision[]) =>
    invoke<SyncState>("sync_startup_resolve", { decisions }),
  syncRecoveryProbe: (serverAddress?: string | null) =>
    invoke<RecoveryProbeResult>("sync_recovery_probe", { serverAddress }),
  syncRecoveryRestore: (password: string, serverAddress?: string | null) =>
    invoke<VaultStatus>("sync_recovery_restore", { password, serverAddress }),
  releaseCheckLatest: () => invoke<ReleaseCheckResult>("release_check_latest"),

  openExternalEditor: (filename: string, content: string, command?: string | null) =>
    invoke<void>("open_external_editor", { filename, content, command }),

  windowMinimize: () => invoke<void>("window_minimize"),
  windowToggleMaximize: () => invoke<boolean>("window_toggle_maximize"),
  windowIsMaximized: () => invoke<boolean>("window_is_maximized"),
  windowClose: () => invoke<void>("window_close"),
  windowStateSave: () => invoke<void>("window_state_save"),
  windowStateRestore: () => invoke<void>("window_state_restore"),
};
