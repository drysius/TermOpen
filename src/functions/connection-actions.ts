import { toast } from "sonner";

import { BLANK_KEYCHAIN_ENTRY, BLANK_PROFILE } from "@/constants";
import { getError } from "@/functions/common";
import type { StoreGet, StoreSet } from "@/functions/store-types";
import { getT } from "@/langs";
import { api } from "@/lib/tauri";
import type { AppActions } from "@/store/app-store.types";
import type { SidebarSection } from "@/types/workspace";
import type {
  AuthServer,
  AppSettings,
  ConnectionProfile,
  ConnectionProtocol,
  KeychainEntry,
  SyncLoggedUser,
  SyncProgressState,
} from "@/types/openptl";

function normalizeProtocols(protocols: ConnectionProtocol[]): ConnectionProtocol[] {
  const next = Array.from(new Set(protocols));
  if (next.includes("rdp")) {
    return ["rdp"];
  }
  if (next.length === 0) {
    return ["ssh"];
  }
  return next;
}

export function createConnectionActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppActions,
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
  | "setPanePath"
  | "setPaneSelectedFile"
  | "setEditorContent"
  | "setWorkspaceSessions"
  | "setWorkspaceBlockCount"
  | "setWorkspaceSnapshot"
  | "clearWorkspaceSnapshot"
  | "setSettingsUnsavedDraft"
  | "setActiveTab"
  | "setCommandInput"
  | "setBusy"
  | "setBooting"
  | "setBootMessage"
  | "setIsWindowMaximized"
  | "setLoggedUser"
  | "setSyncProgress"
  | "setHeaderSyncBusy"
  | "setPendingCloseTabId"
  | "setClosingWorkspace"
  | "setPendingSettingsNavigation"
  | "setLeavingSettingsBusy"
  | "setPendingDeepLinks"
  | "setLoginServerModalOpen"
  | "setLoginServerLoading"
  | "setLoginServerBusy"
  | "setLoginServers"
  | "setLoginServerPings"
  | "setSelectedLoginServerId"
> {
  return {
    setBusy: (busy) => set({ busy }),
    setBooting: (booting) => set({ booting }),
    setBootMessage: (message) => set({ bootMessage: message }),
    setIsWindowMaximized: (value) => set({ isWindowMaximized: value }),
    setLoggedUser: (user: SyncLoggedUser | null) => set({ loggedUser: user }),
    setSyncProgress: (progress: SyncProgressState | null) => set({ syncProgress: progress }),
    setHeaderSyncBusy: (busy) => set({ headerSyncBusy: busy }),
    setPendingCloseTabId: (tabId) => set({ pendingCloseTabId: tabId }),
    setClosingWorkspace: (closing) => set({ closingWorkspace: closing }),
    setPendingSettingsNavigation: (section: SidebarSection | null) => set({ pendingSettingsNavigation: section }),
    setLeavingSettingsBusy: (busy) => set({ leavingSettingsBusy: busy }),
    setPendingDeepLinks: (items) => set({ pendingDeepLinks: items }),
    setLoginServerModalOpen: (open) => set({ loginServerModalOpen: open }),
    setLoginServerLoading: (loading) => set({ loginServerLoading: loading }),
    setLoginServerBusy: (busy) => set({ loginServerBusy: busy }),
    setLoginServers: (servers: AuthServer[]) => set({ loginServers: servers }),
    setLoginServerPings: (pings) => set({ loginServerPings: pings }),
    setSelectedLoginServerId: (id) => set({ selectedLoginServerId: id }),

    setActiveTab: (id) => set({ activeTabId: id }),

    setCommandInput: (value) => set({ commandInput: value }),

    setPanePath: (side, path) =>
      set((state) =>
        side === "left"
          ? { leftPane: { ...state.leftPane, path } }
          : { rightPane: { ...state.rightPane, path } },
      ),

    setPaneSelectedFile: (side, path) =>
      set((state) =>
        side === "left"
          ? { leftPane: { ...state.leftPane, selectedFile: path } }
          : { rightPane: { ...state.rightPane, selectedFile: path } },
      ),

    setEditorContent: (tabId, value) =>
      set((state) => {
        const editor = state.editorTabs[tabId];
        if (!editor || editor.view !== "text") {
          return {};
        }
        return {
          editorTabs: {
            ...state.editorTabs,
            [tabId]: {
              ...editor,
              content: value,
              dirty: true,
            },
          },
        };
      }),

    setWorkspaceSessions: (tabId, sessionIds) =>
      set((state) => ({
        workspaceSessionsByTab: {
          ...state.workspaceSessionsByTab,
          [tabId]: Array.from(new Set(sessionIds)),
        },
      })),

    setWorkspaceBlockCount: (tabId, count) =>
      set((state) => ({
        workspaceBlockCountByTab: {
          ...state.workspaceBlockCountByTab,
          [tabId]: Math.max(0, count),
        },
      })),

    setWorkspaceSnapshot: (tabId, snapshot) =>
      set((state) => ({
        workspaceSnapshotsByTab: {
          ...state.workspaceSnapshotsByTab,
          [tabId]: snapshot,
        },
      })),

    clearWorkspaceSnapshot: (tabId) =>
      set((state) => {
        const next = { ...state.workspaceSnapshotsByTab };
        delete next[tabId];
        return { workspaceSnapshotsByTab: next };
      }),

    setSettingsUnsavedDraft: (draft) =>
      set({
        settingsUnsavedDraft: draft,
      }),

    openHostDrawer: (profile, protocol: ConnectionProtocol = "ssh") => {
      const initialProtocols = protocol === "rdp" ? (["rdp"] as ConnectionProtocol[]) : ([protocol] as ConnectionProtocol[]);
      const isFileProtocol =
        protocol === "sftp" || protocol === "ftp" || protocol === "ftps" || protocol === "smb";
      const defaultPort =
        protocol === "rdp"
          ? 3389
          : protocol === "smb"
            ? 445
            : protocol === "ftp" || protocol === "ftps"
              ? 21
              : BLANK_PROFILE.port;
      const draft: ConnectionProfile = profile
        ? {
            ...profile,
            protocols: normalizeProtocols(profile.protocols ?? []),
          }
        : {
            ...BLANK_PROFILE,
            protocols: initialProtocols,
            port: defaultPort,
            remote_path: isFileProtocol ? "/" : BLANK_PROFILE.remote_path,
          };
      set({
        hostDrawerOpen: true,
        hostDraft: draft,
      });
    },

    closeHostDrawer: () => set({ hostDrawerOpen: false }),

    saveHost: async (profile) => {
      set({ busy: true });
      try {
        const saved = await api.connectionSave({
          ...profile,
          protocols: normalizeProtocols(profile.protocols ?? []),
        });
        const connections = get().connections;
        set({
          hostDrawerOpen: false,
          connections: [...connections.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        });
        toast.success(getT().toasts.connectionSaved);
      } catch (error) {
        toast.error(getError(error));
      } finally {
        set({ busy: false });
      }
    },

    deleteHost: async (id) => {
      try {
        await api.connectionDelete(id);
        set((state) => ({
          connections: state.connections.filter((item) => item.id !== id),
        }));
        toast.success(getT().toasts.connectionRemoved);
      } catch (error) {
        toast.error(getError(error));
      }
    },

    openKeychainDrawer: (entry) => {
      const draft: KeychainEntry = entry ? { ...entry } : { ...BLANK_KEYCHAIN_ENTRY };
      set({
        keychainDrawerOpen: true,
        keychainDraft: draft,
      });
    },

    closeKeychainDrawer: () => set({ keychainDrawerOpen: false }),

    saveKeychain: async (entry) => {
      set({ busy: true });
      try {
        const saved = await api.keychainSave({ ...entry });
        const keychainEntries = get().keychainEntries;
        set({
          keychainDrawerOpen: false,
          keychainEntries: [...keychainEntries.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        });
        toast.success(getT().toasts.keychainSaved);
      } catch (error) {
        toast.error(getError(error));
      } finally {
        set({ busy: false });
      }
    },

    deleteKeychain: async (id) => {
      try {
        await api.keychainDelete(id);
        set((state) => ({
          keychainEntries: state.keychainEntries.filter((item) => item.id !== id),
        }));
        toast.success(getT().toasts.keychainRemoved);
      } catch (error) {
        toast.error(getError(error));
      }
    },

    saveSettings: async (next: AppSettings, options?: { silent?: boolean }) => {
      set({ busy: true });
      try {
        const saved = await api.settingsUpdate(next);
        set({ settings: saved });
        if (saved.sync_on_settings_change && get().syncState.connected) {
          set((state) => ({
            syncState: { ...state.syncState, status: "running", message: "Sincronizando configuracoes..." },
          }));
          const synced = await api.syncPush();
          set({ syncState: synced });
        }
        if (!options?.silent) {
          toast.success(getT().toasts.settingsSaved);
        }
      } catch (error) {
        toast.error(getError(error));
      } finally {
        set({ busy: false });
      }
    },

    changeMasterPassword: async (oldPassword, newPassword, confirmPassword) => {
      if (!newPassword) {
        toast.error(getT().toasts.enterNewPassword);
        return;
      }
      if (newPassword !== confirmPassword) {
        toast.error(getT().toasts.passwordMismatch);
        return;
      }

      try {
        await api.vaultChangeMasterPassword(oldPassword || null, newPassword);
        toast.success(getT().toasts.passwordUpdated);
      } catch (error) {
        toast.error(getError(error));
      }
    },

    runSync: async (action, serverAddress) => {
      try {
        set((state) => ({
          syncState: { ...state.syncState, status: "running", message: "Sincronizando..." },
        }));
        const nextState =
          action === "login"
            ? await api.syncGoogleLogin(serverAddress ?? null)
            : action === "push"
              ? await api.syncPush()
              : await api.syncPull();
        set({ syncState: nextState });
        toast.message(nextState.message);
      } catch (error) {
        toast.error(getError(error));
        set((state) => ({
          syncState: { ...state.syncState, status: "error", message: getError(error) },
        }));
      }
    },

    syncCancel: async () => {
      try {
        const next = await api.syncCancel();
        set({ syncState: next });
        toast.message(next.message);
      } catch (error) {
        toast.error(getError(error));
      }
    },

    refreshKnownHosts: async (path) => {
      try {
        const entries = await api.knownHostsList(path ?? null);
        set({ knownHosts: entries });
      } catch (error) {
        toast.error(getError(error));
      }
    },

    removeKnownHost: async (lineRaw, path) => {
      try {
        await api.knownHostsRemove(lineRaw, path ?? null);
        const entries = await api.knownHostsList(path ?? null);
        set({ knownHosts: entries });
        toast.success(getT().toasts.knownHostRemoved);
      } catch (error) {
        toast.error(getError(error));
      }
    },

    ensureKnownHosts: async (path) => {
      try {
        const resolved = await api.knownHostsEnsure(path ?? null);
        const entries = await api.knownHostsList(path ?? null);
        set({ knownHosts: entries });
        return resolved;
      } catch (error) {
        toast.error(getError(error));
        return null;
      }
    },
  };
}
