import { Channel, invoke } from "@tauri-apps/api/core";

import type {
  AppSettings,
  AuthServer,
  BinaryPreviewResult,
  KeyActionsActiveTargetInput,
  ClipboardLocalItem,
  ConnectionProfile,
  DebugLogEntry,
  KnownHostEntry,
  KeychainEntry,
  SshKeyGenerateInput,
  SshKeyGenerateResult,
  LocalPathStat,
  RemoteTransferEndpoint,
  RecoveryProbeResult,
  ReleaseCheckResult,
  RdpInputBatch,
  RdpSessionControlEvent,
  RdpSessionFocusInput,
  RdpSessionStartResult,
  SftpEntry,
  SshConnectPurpose,
  SyncLoggedUser,
  SyncConflictDecision,
  SyncConflictPreview,
  SshConnectResult,
  SshSessionInfo,
  SyncState,
  TextReadChunk,
  VaultStatus,
} from "@/types/openptl";

export const api = {
  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  vaultInit: (password?: string | null) =>
    invoke<VaultStatus>("vault_init", { password }),
  vaultUnlock: (password?: string | null) =>
    invoke<VaultStatus>("vault_unlock", { password }),
  vaultLock: () => invoke<VaultStatus>("vault_lock"),
  vaultResetAll: () => invoke<VaultStatus>("vault_reset_all"),
  vaultDeleteAccount: (currentPassword: string, deleteCloudData: boolean) =>
    invoke<VaultStatus>("vault_delete_account", {
      currentPassword,
      deleteCloudData,
    }),
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
  sshKeyGenerate: (input: SshKeyGenerateInput) =>
    invoke<SshKeyGenerateResult>("ssh_key_generate", { input }),

  settingsGet: () => invoke<AppSettings>("settings_get"),
  settingsUpdate: (settings: AppSettings) => invoke<AppSettings>("settings_update", { settings }),
  debugLogsList: () => invoke<DebugLogEntry[]>("debug_logs_list"),
  debugLogsClear: () => invoke<void>("debug_logs_clear"),
  debugLogsSetEnabled: (enabled: boolean) => invoke<void>("debug_logs_set_enabled", { enabled }),
  debugLogFrontend: (
    level: string,
    message: string,
    options?: {
      source?: string;
      context?: string | null;
    },
  ) =>
    invoke<void>("debug_log_frontend", {
      level,
      source: options?.source,
      message,
      context: options?.context,
    }),

  sshConnect: (profileId: string) => invoke<SshSessionInfo>("ssh_connect", { profileId }),
  sshConnectEx: (
    profileId: string,
    options?: {
      acceptUnknownHost?: boolean;
      passwordOverride?: string | null;
      keychainIdOverride?: string | null;
      saveAuthChoice?: boolean;
      connectPurpose?: SshConnectPurpose;
    },
  ) =>
    invoke<SshConnectResult>("ssh_connect_ex", {
      profileId,
      acceptUnknownHost: options?.acceptUnknownHost,
      passwordOverride: options?.passwordOverride,
      keychainIdOverride: options?.keychainIdOverride,
      saveAuthChoice: options?.saveAuthChoice,
      connectPurpose: options?.connectPurpose,
    }),
  rdpSessionStart: (
    profileId: string,
    controlChannel: Channel<RdpSessionControlEvent>,
    videoRectsChannel: Channel<ArrayBuffer>,
    cursorChannel: Channel<ArrayBuffer>,
    audioPcmChannel: Channel<ArrayBuffer>,
    options?: {
      width?: number;
      height?: number;
      passwordOverride?: string | null;
      keychainIdOverride?: string | null;
      saveAuthChoice?: boolean;
    },
  ) =>
    invoke<RdpSessionStartResult>("rdp_session_start", {
      profileId,
      width: options?.width,
      height: options?.height,
      passwordOverride: options?.passwordOverride,
      keychainIdOverride: options?.keychainIdOverride,
      saveAuthChoice: options?.saveAuthChoice,
      controlChannel,
      videoRectsChannel,
      cursorChannel,
      audioPcmChannel,
    }),
  rdpSessionFocus: (sessionId: string, focus: RdpSessionFocusInput) =>
    invoke<void>("rdp_session_focus", { sessionId, focus }),
  rdpInputBatch: (sessionId: string, batch: RdpInputBatch) =>
    invoke<void>("rdp_input_batch", { sessionId, batch }),
  rdpSessionStop: (sessionId: string) => invoke<void>("rdp_session_stop", { sessionId }),
  keyActionsSetActiveWorkspace: (target?: KeyActionsActiveTargetInput | null) =>
    invoke<void>("key_actions_set_active_workspace", { target }),
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
  remoteProfileList: (profileId: string, protocol: "ftp" | "ftps" | "smb", path: string) =>
    invoke<SftpEntry[]>("remote_profile_list", { profileId, protocol, path }),
  remoteProfileRead: (profileId: string, protocol: "ftp" | "ftps" | "smb", path: string) =>
    invoke<string>("remote_profile_read", { profileId, protocol, path }),
  remoteProfileReadChunk: (
    profileId: string,
    protocol: "ftp" | "ftps" | "smb",
    path: string,
    offset: number,
  ) => invoke<TextReadChunk>("remote_profile_read_chunk", { profileId, protocol, path, offset }),
  remoteProfileWrite: (profileId: string, protocol: "ftp" | "ftps" | "smb", path: string, content: string) =>
    invoke<void>("remote_profile_write", { profileId, protocol, path, content }),
  remoteProfileRename: (
    profileId: string,
    protocol: "ftp" | "ftps" | "smb",
    fromPath: string,
    toPath: string,
  ) => invoke<void>("remote_profile_rename", { profileId, protocol, fromPath, toPath }),
  remoteProfileDelete: (profileId: string, protocol: "ftp" | "ftps" | "smb", path: string, isDir: boolean) =>
    invoke<void>("remote_profile_delete", { profileId, protocol, path, isDir }),
  remoteProfileMkdir: (profileId: string, protocol: "ftp" | "ftps" | "smb", path: string) =>
    invoke<void>("remote_profile_mkdir", { profileId, protocol, path }),
  remoteProfileCreateFile: (profileId: string, protocol: "ftp" | "ftps" | "smb", path: string) =>
    invoke<void>("remote_profile_create_file", { profileId, protocol, path }),
  remoteProfileReadBinaryPreview: (
    profileId: string,
    protocol: "ftp" | "ftps" | "smb",
    path: string,
    maxBytes?: number | null,
  ) => invoke<BinaryPreviewResult>("remote_profile_read_binary_preview", { profileId, protocol, path, maxBytes }),
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
  remoteTransfer: (
    transferId: string,
    fromEndpoint: RemoteTransferEndpoint,
    fromPath: string,
    toEndpoint: RemoteTransferEndpoint,
    toPath: string,
  ) =>
    invoke<void>("remote_transfer", {
      transferId,
      fromEndpoint,
      fromPath,
      toEndpoint,
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
  localStat: (path: string) => invoke<LocalPathStat>("local_stat", { path }),
  clipboardLocalItems: () => invoke<ClipboardLocalItem[]>("clipboard_local_items"),

  authServersList: () => invoke<AuthServer[]>("auth_servers_list"),
  authServerSave: (server: AuthServer) => invoke<AuthServer>("auth_server_save", { server }),
  authServerDelete: (id: string) => invoke<void>("auth_server_delete", { id }),
  authServersFetchRemote: () => invoke<AuthServer[]>("auth_servers_fetch_remote"),

  syncGoogleLogin: (serverAddress?: string | null) =>
    invoke<SyncState>("sync_google_login", { serverAddress }),
  syncLoggedUser: () => invoke<SyncLoggedUser | null>("sync_logged_user"),
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
  deeplinkTakePending: () => invoke<string[]>("deeplink_take_pending"),
  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),

  openExternalEditor: (filename: string, content: string, command?: string | null) =>
    invoke<void>("open_external_editor", { filename, content, command }),

  windowMinimize: () => invoke<void>("window_minimize"),
  windowToggleMaximize: () => invoke<boolean>("window_toggle_maximize"),
  windowIsMaximized: () => invoke<boolean>("window_is_maximized"),
  windowClose: () => invoke<void>("window_close"),
  windowStateSave: () => invoke<void>("window_state_save"),
  windowStateRestore: () => invoke<void>("window_state_restore"),
};
