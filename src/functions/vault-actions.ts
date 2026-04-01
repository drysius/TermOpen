import { toast } from "sonner";

import { DEFAULT_PANE, INITIAL_SYNC_STATE } from "@/constants";
import { getError } from "@/functions/common";
import type { StoreGet, StoreSet } from "@/functions/store-types";
import { getT } from "@/langs";
import { api } from "@/lib/tauri";
import type { AppActions } from "@/store/app-store.types";
import type { SyncConflictDecision } from "@/types/termopen";

export function createVaultActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppActions,
  "bootstrap" | "loadWorkspace" | "vaultInit" | "vaultUnlock" | "vaultLock" | "resolveStartupConflicts"
> {
  async function hydrateWorkspace() {
    const [profiles, keychain, appSettings, connectedSessions] = await Promise.all([
      api.connectionsList(),
      api.keychainList(),
      api.settingsGet(),
      api.sshSessions(),
    ]);
    const knownHosts = await api.knownHostsList(appSettings.known_hosts_path || null).catch(() => []);

    set({
      connections: profiles,
      keychainEntries: keychain,
      settings: appSettings,
      knownHosts,
      sessions: connectedSessions,
    });

    for (const session of connectedSessions) {
      await get().ensureSessionListeners(session.session_id);
    }

    return appSettings;
  }

  return {
    bootstrap: async () => {
      set({ busy: true });
      try {
        const status = await api.vaultStatus();
        set({ vaultStatus: status });
        if (status.initialized && !status.locked) {
          await get().loadWorkspace();
        }
      } catch (error) {
        toast.error(getError(error));
      } finally {
        set({ busy: false });
      }
    },

    loadWorkspace: async () => {
      const appSettings = await hydrateWorkspace();

      if (appSettings.sync_on_startup) {
        const loggedUser = await api.syncLoggedUser().catch(() => null);
        if (!loggedUser) {
          set({ syncState: INITIAL_SYNC_STATE, startupSyncBusy: false, startupConflicts: [] });
          await api.windowStateRestore().catch(() => undefined);
          return;
        }

        set((state) => ({
          syncState: { ...state.syncState, status: "running", message: "Sincronizando no startup..." },
          startupSyncBusy: true,
        }));

        const preview = await api.syncStartupPreview().catch(() => ({ conflicts: [] }));
        if ((preview.conflicts?.length ?? 0) > 0) {
          set({
            startupConflicts: preview.conflicts,
            startupSyncBusy: false,
            syncState: {
              ...INITIAL_SYNC_STATE,
              status: "conflict",
              message: "Conflitos de sincronizacao detectados no startup.",
              connected: true,
            },
          });
          return;
        }

        const sync = await api.syncPull().catch(() => INITIAL_SYNC_STATE);
        set({ syncState: sync, startupSyncBusy: false });
      } else {
        set({ syncState: INITIAL_SYNC_STATE, startupSyncBusy: false, startupConflicts: [] });
      }

      await api.windowStateRestore().catch(() => undefined);
    },

    resolveStartupConflicts: async (decisions: SyncConflictDecision[]) => {
      set({ startupSyncBusy: true, busy: true });
      try {
        const syncState = await api.syncStartupResolve(decisions);
        set({ startupConflicts: [], syncState });
        await hydrateWorkspace();
        await api.windowStateRestore().catch(() => undefined);
        toast.success(getT().vault.toasts.conflictsResolved);
      } catch (error) {
        toast.error(getError(error));
      } finally {
        set({ startupSyncBusy: false, busy: false });
      }
    },

    vaultInit: async (password) => {
      set({ busy: true });
      try {
        const status = await api.vaultInit(password);
        set({ vaultStatus: status });
        await get().loadWorkspace();
        toast.success(getT().vault.toasts.initialized);
      } catch (error) {
        toast.error(getError(error));
        await get().bootstrap().catch(() => undefined);
      } finally {
        set({ busy: false });
      }
    },

    vaultUnlock: async (password) => {
      set({ busy: true });
      try {
        const status = await api.vaultUnlock(password);
        set({ vaultStatus: status });
        await get().loadWorkspace();
        toast.success(getT().vault.toasts.unlocked);
      } catch (error) {
        toast.error(getError(error));
        await get().bootstrap().catch(() => undefined);
      } finally {
        set({ busy: false });
      }
    },

    vaultLock: async (fromInactivity = false) => {
      try {
        await api.vaultLock();
        get().clearSessionListeners();
        set((state) => ({
          vaultStatus: state.vaultStatus ? { ...state.vaultStatus, locked: true } : state.vaultStatus,
          tabs: [],
          activeTabId: null,
          sessions: [],
          editorTabs: {},
          sessionBuffers: {},
          workspaceSessionsByTab: {},
          workspaceBlockCountByTab: {},
          workspaceSnapshotsByTab: {},
          knownHosts: [],
          settingsUnsavedDraft: null,
          leftPane: DEFAULT_PANE,
          rightPane: { ...DEFAULT_PANE, path: "/" },
          syncState: INITIAL_SYNC_STATE,
          startupConflicts: [],
          startupSyncBusy: false,
        }));
        if (fromInactivity) {
          toast.warning(getT().vault.toasts.lockedInactivity);
        }
        await get().bootstrap();
      } catch (error) {
        toast.error(getError(error));
      }
    },
  };
}
