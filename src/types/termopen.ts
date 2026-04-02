export type KeyMode = "password" | "keychain";
export type ConnectionKind = "host" | "sftp" | "rdp" | "both";
export type ConnectionProtocol = "ssh" | "sftp" | "ftp" | "ftps" | "smb" | "rdp";
export type KeychainEntryType = "password" | "ssh_key" | "secret";
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
  entry_type: KeychainEntryType;
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
  debug_logs_enabled: boolean;
  modified_files_upload_policy: ModifiedUploadPolicy;
  known_hosts_path: string;
  selected_auth_server_id?: string | null;
}

export interface DebugLogEntry {
  id: number;
  timestamp_ms: number;
  level: string;
  source: string;
  message: string;
  context?: string | null;
}

export interface SshSessionInfo {
  session_id: string;
  profile_id: string;
  connected_at: number;
  session_kind: "ssh" | "local";
}

export type RdpMouseButton = "left" | "right" | "middle";
export interface RdpViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RdpSessionFocusInput {
  focused: boolean;
  viewport_rect?: RdpViewportRect | null;
  dpi_scale?: number | null;
}

export interface RdpPathPoint {
  x: number;
  y: number;
  t_ms?: number | null;
}

export type RdpInputEvent =
  | {
      kind: "mouse_move";
      x: number;
      y: number;
      t_ms?: number | null;
    }
  | {
      kind: "mouse_button_down";
      x: number;
      y: number;
      button: RdpMouseButton;
    }
  | {
      kind: "mouse_button_up";
      x: number;
      y: number;
      button: RdpMouseButton;
    }
  | {
      kind: "mouse_path";
      points: RdpPathPoint[];
    }
  | {
      kind: "mouse_click";
      x: number;
      y: number;
      button: RdpMouseButton;
      double_click?: boolean;
    }
  | {
      kind: "mouse_scroll";
      x: number;
      y: number;
      delta_x?: number;
      delta_y?: number;
    }
  | {
      kind: "key_press";
      code: string;
      text?: string | null;
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
      meta?: boolean;
    };

export interface RdpInputBatch {
  events: RdpInputEvent[];
}

export type RdpSessionStartResult =
  | {
      status: "started";
      session_id: string;
    }
  | {
      status: "auth_required";
      message: string;
    }
  | {
      status: "error";
      message: string;
    };

export type RdpSessionControlEvent =
  | {
      event: "connecting";
      data: {
        session_id: string;
        message: string;
      };
    }
  | {
      event: "ready";
      data: {
        session_id: string;
        width: number;
        height: number;
      };
    }
  | {
      event: "auth_required";
      data: {
        session_id: string;
        message: string;
      };
    }
  | {
      event: "error";
      data: {
        session_id: string;
        message: string;
      };
    }
  | {
      event: "stopped";
      data: {
        session_id: string;
      };
    }
  | {
      event: "released_capture";
      data: {
        session_id: string;
        message: string;
      };
    };

export interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  permissions?: number | null;
  modified_at?: number | null;
}

export interface ClipboardLocalItem {
  path: string;
  is_dir: boolean;
}

export interface LocalPathStat {
  is_dir: boolean;
  size: number;
}

export type RemoteTransferEndpoint =
  | {
      kind: "local";
    }
  | {
      kind: "sftp_session";
      session_id: string;
    }
  | {
      kind: "profile";
      profile_id: string;
      protocol: ConnectionProtocol;
    };

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

export interface TextReadChunk {
  chunk_base64: string;
  bytes_read: number;
  total_bytes: number;
  eof: boolean;
}

export interface SyncState {
  connected: boolean;
  status: "idle" | "running" | "ok" | "error" | "conflict";
  message: string;
  last_sync_at?: string | null;
  pending_user_code?: string | null;
  verification_url?: string | null;
}

export interface SyncLoggedUser {
  name?: string | null;
  email?: string | null;
  picture_url?: string | null;
}

export interface SyncProgressState {
  percent: number;
  stage: string;
  current_file?: string | null;
  processed: number;
  total: number;
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
