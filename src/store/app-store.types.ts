import type { EditorBuffer, PaneState } from "@/types/app-state";
import type {
  AppSettings,
  ConnectionProtocol,
  ConnectionProfile,
  KnownHostEntry,
  KeychainEntry,
  SftpEntry,
  SshSessionInfo,
  SyncState,
  VaultStatus,
} from "@/types/termopen";
import type { WorkTab } from "@/types/workspace";

export type PaneSide = "left" | "right";
export type SyncAction = "login" | "push" | "pull";
export type CopyDirection = "left_to_right" | "right_to_left";

export interface AppState {
  vaultStatus: VaultStatus | null;
  connections: ConnectionProfile[];
  keychainEntries: KeychainEntry[];
  settings: AppSettings;
  syncState: SyncState;
  knownHosts: KnownHostEntry[];
  sessions: SshSessionInfo[];
  tabs: WorkTab[];
  activeTabId: string | null;
  hostDrawerOpen: boolean;
  hostDraft: ConnectionProfile;
  keychainDrawerOpen: boolean;
  keychainDraft: KeychainEntry;
  leftPane: PaneState;
  rightPane: PaneState;
  editorTabs: Record<string, EditorBuffer>;
  sessionBuffers: Record<string, string>;
  workspaceSessionsByTab: Record<string, string[]>;
  workspaceBlockCountByTab: Record<string, number>;
  commandInput: string;
  busy: boolean;
}

export interface AppActions {
  setBusy: (busy: boolean) => void;
  setActiveTab: (id: string | null) => void;
  setCommandInput: (value: string) => void;
  setPanePath: (side: PaneSide, path: string) => void;
  setPaneSelectedFile: (side: PaneSide, path: string) => void;
  setEditorContent: (tabId: string, value: string) => void;
  appendSessionBuffer: (sessionId: string, chunk: string) => void;
  setWorkspaceSessions: (tabId: string, sessionIds: string[]) => void;
  setWorkspaceBlockCount: (tabId: string, count: number) => void;

  bootstrap: () => Promise<void>;
  loadWorkspace: () => Promise<void>;
  vaultInit: (password: string | null) => Promise<void>;
  vaultUnlock: (password: string | null) => Promise<void>;
  vaultLock: (fromInactivity?: boolean) => Promise<void>;

  openHostDrawer: (profile?: ConnectionProfile, protocol?: ConnectionProtocol) => void;
  closeHostDrawer: () => void;
  saveHost: (profile: ConnectionProfile) => Promise<void>;
  deleteHost: (id: string) => Promise<void>;

  openKeychainDrawer: (entry?: KeychainEntry) => void;
  closeKeychainDrawer: () => void;
  saveKeychain: (entry: KeychainEntry) => Promise<void>;
  deleteKeychain: (id: string) => Promise<void>;

  saveSettings: (next: AppSettings) => Promise<void>;
  changeMasterPassword: (oldPassword: string, newPassword: string, confirmPassword: string) => Promise<void>;
  runSync: (action: SyncAction) => Promise<void>;
  refreshKnownHosts: (path?: string | null) => Promise<void>;
  removeKnownHost: (lineRaw: string, path?: string | null) => Promise<void>;
  ensureKnownHosts: (path?: string | null) => Promise<string | null>;

  openTab: (tab: WorkTab) => void;
  closeTab: (tabId: string) => Promise<void>;

  ensureSessionListeners: (sessionId: string) => Promise<void>;
  clearSessionListeners: (sessionId?: string) => void;
  getOrCreateSession: (profile: ConnectionProfile) => Promise<SshSessionInfo>;
  openSsh: (profile: ConnectionProfile) => Promise<void>;
  sshWrite: (sessionId: string, data: string) => Promise<void>;
  disconnectSession: (sessionId: string) => Promise<void>;

  refreshPane: (side: PaneSide, sourceId?: string, path?: string) => Promise<void>;
  openSftpWorkspace: (profile: ConnectionProfile) => Promise<void>;
  onPaneOpenEntry: (side: PaneSide, entry: SftpEntry) => Promise<void>;
  openFileFromSource: (sourceId: string, path: string) => Promise<void>;
  copyBetween: (direction: CopyDirection) => Promise<void>;

  saveEditor: (tabId: string) => Promise<void>;
  openEditorExternal: (tabId: string) => Promise<void>;
}

export type AppStore = AppState & AppActions;
