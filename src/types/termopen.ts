export type KeyMode = "password" | "keychain";
export type ConnectionKind = "host" | "sftp" | "both";
export type ConnectionProtocol = "ssh" | "sftp";
export type EditorPreference = "internal" | "vscode" | "system";
export type ModifiedUploadPolicy = "auto" | "ask" | "manual";

export interface AuthServer {
  id: string;
  label: string;
  address: string;
  author?: string | null;
  official: boolean;
}

export interface VaultStatus {
  initialized: boolean;
  locked: boolean;
  key_mode: KeyMode | null;
  recoverable: boolean;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string | null;
  private_key?: string | null;
  keychain_id?: string | null;
  remote_path?: string | null;
  protocols: ConnectionProtocol[];
  kind?: ConnectionKind | null;
}

export interface KeychainEntry {
  id: string;
  name: string;
  password?: string | null;
  private_key?: string | null;
  public_key?: string | null;
  passphrase?: string | null;
  created_at: number;
}

export interface AppSettings {
  preferred_editor: EditorPreference;
  external_editor_command: string;
  sync_auto_enabled: boolean;
  sync_on_startup: boolean;
  sync_on_settings_change: boolean;
  sync_interval_minutes: number;
  sftp_chunk_size_kb: number;
  sftp_reconnect_delay_seconds: number;
  inactivity_lock_minutes: number;
  auto_reconnect_enabled: boolean;
  reconnect_delay_seconds: number;
  terminal_copy_on_select: boolean;
  terminal_right_click_paste: boolean;
  terminal_ctrl_shift_shortcuts: boolean;
  modified_files_upload_policy: ModifiedUploadPolicy;
  known_hosts_path: string;
  selected_auth_server_id?: string | null;
}

export interface SshSessionInfo {
  session_id: string;
  profile_id: string;
  connected_at: number;
  session_kind: "ssh" | "local";
}

export interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  permissions?: number | null;
  modified_at?: number | null;
}

export type BinaryPreviewResult =
  | {
      status: "ready";
      base64: string;
      size: number;
    }
  | {
      status: "too_large";
      size: number;
      limit: number;
    };

export interface SyncState {
  connected: boolean;
  status: "idle" | "running" | "ok" | "error" | "conflict";
  message: string;
  last_sync_at?: string | null;
  pending_user_code?: string | null;
  verification_url?: string | null;
}

export type SyncConflictKind = "host" | "keychain" | "profile";
export type SyncKeepSide = "client" | "server";

export interface SyncConflictItem {
  kind: SyncConflictKind;
  id: string;
  label: string;
  local_hash?: string | null;
  remote_hash?: string | null;
}

export interface SyncConflictPreview {
  conflicts: SyncConflictItem[];
}

export interface SyncConflictDecision {
  kind: SyncConflictKind;
  id: string;
  keep: SyncKeepSide;
}

export interface RecoveryProbeResult {
  found: boolean;
  message: string;
}

export interface ReleaseCheckResult {
  available: boolean;
  latest_version?: string | null;
  url?: string | null;
  message: string;
}

export interface KnownHostEntry {
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  line_raw: string;
  path: string;
}

export type SshConnectResult =
  | {
      status: "connected";
      session: SshSessionInfo;
    }
  | {
      status: "unknown_host_challenge";
      host: string;
      port: number;
      key_type: string;
      fingerprint: string;
      known_hosts_path: string;
      message: string;
    }
  | {
      status: "auth_required";
      message: string;
    }
  | {
      status: "error";
      message: string;
    };
