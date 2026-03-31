import type { AppSettings, ConnectionProfile, KeychainEntry, SyncState } from "@/types/termopen";
import type { PaneState } from "@/types/app-state";

export const BLANK_PROFILE: ConnectionProfile = {
  id: "",
  name: "",
  host: "",
  port: 22,
  username: "",
  password: "",
  private_key: "",
  keychain_id: null,
  remote_path: "/",
  protocols: ["ssh"],
  kind: undefined,
};

export const BLANK_KEYCHAIN_ENTRY: KeychainEntry = {
  id: "",
  name: "",
  private_key: "",
  public_key: "",
  passphrase: "",
  created_at: 0,
};

export const DEFAULT_SETTINGS: AppSettings = {
  preferred_editor: "internal",
  external_editor_command: "",
  sync_auto_enabled: true,
  sync_on_startup: true,
  sync_on_settings_change: false,
  sync_interval_minutes: 5,
  inactivity_lock_minutes: 10,
  auto_reconnect_enabled: true,
  reconnect_delay_seconds: 5,
  modified_files_upload_policy: "ask",
  known_hosts_path: "",
  selected_auth_server_id: null,
};

export const INITIAL_SYNC_STATE: SyncState = {
  connected: false,
  status: "idle",
  message: "Sincronizacao ainda nao iniciada.",
  last_sync_at: null,
  pending_user_code: null,
  verification_url: null,
};

export const DEFAULT_PANE: PaneState = {
  sourceId: "local",
  path: "",
  entries: [],
  loading: false,
  selectedFile: null,
};
