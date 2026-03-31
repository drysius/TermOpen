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
  inactivity_lock_minutes: number;
  auto_reconnect_enabled: boolean;
  reconnect_delay_seconds: number;
  modified_files_upload_policy: ModifiedUploadPolicy;
  known_hosts_path: string;
  selected_auth_server_id?: string | null;
}

export interface SshSessionInfo {
  session_id: string;
  profile_id: string;
  connected_at: number;
}

export interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  permissions?: number | null;
  modified_at?: number | null;
}

export interface SyncState {
  connected: boolean;
  status: "idle" | "running" | "ok" | "error" | "conflict";
  message: string;
  last_sync_at?: string | null;
  pending_user_code?: string | null;
  verification_url?: string | null;
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
