import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

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
  | "setWorkspaceSnapshot"
  | "clearWorkspaceSnapshot"
  | "bootstrap"
  | "loadWorkspace"
  | "vaultInit"
  | "vaultUnlock"
  | "vaultLock"
  | "resolveStartupConflicts"
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
  | "syncCancel"
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
  workspaceSnapshotsByTab: {},
  commandInput: "whoami",
  busy: false,
  startupConflicts: [],
  startupSyncBusy: false,
};

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => {
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
    },
    {
      name: "termopen.app.session",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        workspaceSessionsByTab: state.workspaceSessionsByTab,
        workspaceBlockCountByTab: state.workspaceBlockCountByTab,
        workspaceSnapshotsByTab: state.workspaceSnapshotsByTab,
      }),
    },
  ),
);
