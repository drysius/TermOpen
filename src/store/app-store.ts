import { create } from "zustand";

import { BLANK_KEYCHAIN_ENTRY, BLANK_PROFILE, DEFAULT_PANE, DEFAULT_SETTINGS, INITIAL_SYNC_STATE } from "@/constants";
import { createConnectionActions } from "@/functions/connection-actions";
import { createSessionActions } from "@/functions/session-actions";
import { createSftpEditorActions } from "@/functions/sftp-editor-actions";
import { createVaultActions } from "@/functions/vault-actions";
import type { AppStore } from "@/store/app-store.types";

const initialState: Omit<
  AppStore,
  | "setBusy"
  | "setActiveTab"
  | "setCommandInput"
  | "setPanePath"
  | "setPaneSelectedFile"
  | "setEditorContent"
  | "appendSessionBuffer"
  | "setWorkspaceSessions"
  | "setWorkspaceBlockCount"
  | "bootstrap"
  | "loadWorkspace"
  | "vaultInit"
  | "vaultUnlock"
  | "vaultLock"
  | "openHostDrawer"
  | "closeHostDrawer"
  | "saveHost"
  | "deleteHost"
  | "openKeychainDrawer"
  | "closeKeychainDrawer"
  | "saveKeychain"
  | "deleteKeychain"
  | "saveSettings"
  | "changeMasterPassword"
  | "runSync"
  | "refreshKnownHosts"
  | "removeKnownHost"
  | "ensureKnownHosts"
  | "openTab"
  | "closeTab"
  | "ensureSessionListeners"
  | "clearSessionListeners"
  | "getOrCreateSession"
  | "openSsh"
  | "sshWrite"
  | "disconnectSession"
  | "refreshPane"
  | "openSftpWorkspace"
  | "onPaneOpenEntry"
  | "openFileFromSource"
  | "copyBetween"
  | "saveEditor"
  | "openEditorExternal"
> = {
  vaultStatus: null,
  connections: [],
  keychainEntries: [],
  settings: DEFAULT_SETTINGS,
  syncState: INITIAL_SYNC_STATE,
  knownHosts: [],
  sessions: [],
  tabs: [],
  activeTabId: null,
  hostDrawerOpen: false,
  hostDraft: BLANK_PROFILE,
  keychainDrawerOpen: false,
  keychainDraft: BLANK_KEYCHAIN_ENTRY,
  leftPane: DEFAULT_PANE,
  rightPane: { ...DEFAULT_PANE, path: "/" },
  editorTabs: {},
  sessionBuffers: {},
  workspaceSessionsByTab: {},
  workspaceBlockCountByTab: {},
  commandInput: "whoami",
  busy: false,
};

export const useAppStore = create<AppStore>((set, get) => {
  const setPartial = (partial: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>)) => {
    set(partial as never);
  };

  return {
    ...initialState,
    ...createConnectionActions(setPartial, get),
    ...createSessionActions(setPartial, get),
    ...createSftpEditorActions(setPartial, get),
    ...createVaultActions(setPartial, get),
  };
});
