import { toast } from "sonner";

import { DEFAULT_PANE, INITIAL_SYNC_STATE } from "@/constants";
import { getError } from "@/functions/common";
import type { StoreGet, StoreSet } from "@/functions/store-types";
import { api } from "@/lib/tauri";
import type { AppActions } from "@/store/app-store.types";

export function createVaultActions(
  set: StoreSet,
  get: StoreGet,
): Pick<AppActions, "bootstrap" | "loadWorkspace" | "vaultInit" | "vaultUnlock" | "vaultLock"> {
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

      if (appSettings.sync_on_startup) {
        set((state) => ({
          syncState: { ...state.syncState, status: "running", message: "Sincronizando no startup..." },
        }));
        const sync = await api.syncPull().catch(() => INITIAL_SYNC_STATE);
        set({ syncState: sync });
      } else {
        set({ syncState: INITIAL_SYNC_STATE });
      }
    },

    vaultInit: async (password) => {
      set({ busy: true });
      try {
        const status = await api.vaultInit(password);
        set({ vaultStatus: status });
        await get().loadWorkspace();
        toast.success("Vault inicializado.");
      } catch (error) {
        toast.error(getError(error));
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
        toast.success("Vault desbloqueado.");
      } catch (error) {
        toast.error(getError(error));
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
          knownHosts: [],
          leftPane: DEFAULT_PANE,
          rightPane: { ...DEFAULT_PANE, path: "/" },
          syncState: INITIAL_SYNC_STATE,
        }));
        if (fromInactivity) {
          toast.warning("Aplicacao bloqueada por inatividade.");
        }
        await get().bootstrap();
      } catch (error) {
        toast.error(getError(error));
      }
    },
  };
}
