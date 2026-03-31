import { toast } from "sonner";

import { BLANK_KEYCHAIN_ENTRY, BLANK_PROFILE } from "@/constants";
import { getError } from "@/functions/common";
import type { StoreGet, StoreSet } from "@/functions/store-types";
import { api } from "@/lib/tauri";
import type { AppActions } from "@/store/app-store.types";
import type {
  AppSettings,
  ConnectionProfile,
  ConnectionProtocol,
  KeychainEntry,
} from "@/types/termopen";

function normalizeProtocols(protocols: ConnectionProtocol[]): ConnectionProtocol[] {
  const next = Array.from(new Set(protocols));
  if (next.length === 0) {
    return ["ssh", "sftp"];
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
  | "refreshKnownHosts"
  | "removeKnownHost"
  | "ensureKnownHosts"
  | "setPanePath"
  | "setPaneSelectedFile"
  | "setEditorContent"
  | "setWorkspaceSessions"
  | "setActiveTab"
  | "setCommandInput"
  | "setBusy"
> {
  return {
    setBusy: (busy) => set({ busy }),

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

    openHostDrawer: (profile, protocol: ConnectionProtocol = "ssh") => {
      const draft: ConnectionProfile = profile
        ? {
            ...profile,
            protocols: normalizeProtocols(profile.protocols ?? []),
          }
        : {
            ...BLANK_PROFILE,
            protocols: protocol === "ssh" ? ["ssh"] : ["sftp"],
            remote_path: protocol === "sftp" ? "/" : BLANK_PROFILE.remote_path,
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
        toast.success("Conexao salva.");
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
        toast.success("Conexao removida.");
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
        toast.success("Keychain salva.");
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
        toast.success("Entrada removida.");
      } catch (error) {
        toast.error(getError(error));
      }
    },

    saveSettings: async (next: AppSettings) => {
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
        toast.success("Configuracoes salvas.");
      } catch (error) {
        toast.error(getError(error));
      } finally {
        set({ busy: false });
      }
    },

    changeMasterPassword: async (oldPassword, newPassword, confirmPassword) => {
      if (!newPassword) {
        toast.error("Informe a nova senha.");
        return;
      }
      if (newPassword !== confirmPassword) {
        toast.error("A confirmacao da senha nova nao confere.");
        return;
      }

      try {
        await api.vaultChangeMasterPassword(oldPassword || null, newPassword);
        toast.success("Senha mestre atualizada.");
      } catch (error) {
        toast.error(getError(error));
      }
    },

    runSync: async (action) => {
      try {
        set((state) => ({
          syncState: { ...state.syncState, status: "running", message: "Sincronizando..." },
        }));
        const nextState =
          action === "login"
            ? await api.syncGoogleLogin()
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
        toast.success("Known host removido.");
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
