import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { getError } from "@/functions/common";
import type { StoreGet, StoreSet } from "@/functions/store-types";
import { api } from "@/lib/tauri";
import type { AppActions } from "@/store/app-store.types";
import type { ConnectionProfile } from "@/types/termopen";
import type { WorkTab } from "@/types/workspace";

const listenersBySession: Record<string, UnlistenFn[]> = {};
const reconnectTimers: Record<string, number> = {};

export function createSessionActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppActions,
  | "appendSessionBuffer"
  | "openTab"
  | "closeTab"
  | "ensureSessionListeners"
  | "clearSessionListeners"
  | "getOrCreateSession"
  | "openSsh"
  | "sshWrite"
  | "disconnectSession"
> {
  const scheduleReconnect = (sessionId: string) => {
    const state = get();
    const session = state.sessions.find((item) => item.session_id === sessionId);
    if (!session || !state.settings.auto_reconnect_enabled) {
      return;
    }

    const delayMs = Math.max(1, state.settings.reconnect_delay_seconds) * 1000;
    toast.warning(`Sessao desconectada. Tentando reconectar em ${Math.floor(delayMs / 1000)}s...`);

    if (reconnectTimers[sessionId]) {
      window.clearTimeout(reconnectTimers[sessionId]);
    }

    reconnectTimers[sessionId] = window.setTimeout(async () => {
      try {
        const reconnectResult = await api.sshConnectEx(session.profile_id, {
          acceptUnknownHost: true,
        });
        if (reconnectResult.status !== "connected") {
          throw new Error(
            reconnectResult.status === "error" || reconnectResult.status === "auth_required"
              ? reconnectResult.message
              : reconnectResult.message,
          );
        }
        const reconnected = reconnectResult.session;
        await get().ensureSessionListeners(reconnected.session_id);
        get().clearSessionListeners(sessionId);

        set((current) => {
          const oldBuffer = current.sessionBuffers[sessionId] ?? "";
          const nextBuffers = { ...current.sessionBuffers };
          delete nextBuffers[sessionId];
          nextBuffers[reconnected.session_id] = oldBuffer;

          return {
            sessions: current.sessions.map((item) =>
              item.session_id === sessionId ? reconnected : item,
            ),
            tabs: current.tabs.map((tab) =>
              tab.sessionId === sessionId ? { ...tab, sessionId: reconnected.session_id } : tab,
            ),
            sessionBuffers: nextBuffers,
          };
        });

        toast.success("Sessao reconectada automaticamente.");
      } catch (error) {
        toast.error(getError(error));
      } finally {
        delete reconnectTimers[sessionId];
      }
    }, delayMs);
  };

  return {
    appendSessionBuffer: (sessionId, chunk) =>
      set((state) => ({
        sessionBuffers: {
          ...state.sessionBuffers,
          [sessionId]: `${state.sessionBuffers[sessionId] ?? ""}${chunk}`,
        },
      })),

    openTab: (tab: WorkTab) =>
      set((state) => ({
        tabs: state.tabs.some((item) => item.id === tab.id) ? state.tabs : [...state.tabs, tab],
        activeTabId: tab.id,
      })),

    closeTab: async (tabId) => {
      const state = get();
      const closing = state.tabs.find((tab) => tab.id === tabId);
      if (!closing) {
        return;
      }

      const sessionsFromTab = state.workspaceSessionsByTab[tabId] ?? [];
      const candidateSessionIds = new Set<string>([...sessionsFromTab, ...(closing.sessionId ? [closing.sessionId] : [])]);

      const remainingTabs = state.tabs.filter((tab) => tab.id !== tabId);
      const remainingSessionIds = new Set<string>();
      remainingTabs.forEach((tab) => {
        if (tab.sessionId) {
          remainingSessionIds.add(tab.sessionId);
        }
        (state.workspaceSessionsByTab[tab.id] ?? []).forEach((sessionId) => remainingSessionIds.add(sessionId));
      });

      for (const sessionId of candidateSessionIds) {
        if (!remainingSessionIds.has(sessionId)) {
          await get().disconnectSession(sessionId);
        }
      }

      set((nextState) => {
        const nextTabs = nextState.tabs.filter((item) => item.id !== tabId);
        const nextActive =
          nextState.activeTabId === tabId ? (nextTabs.length ? nextTabs[nextTabs.length - 1].id : null) : nextState.activeTabId;
        const nextEditors = { ...nextState.editorTabs };
        const nextWorkspaceSessions = { ...nextState.workspaceSessionsByTab };
        delete nextWorkspaceSessions[tabId];
        if (closing.type === "editor") {
          delete nextEditors[tabId];
        }
        return {
          tabs: nextTabs,
          activeTabId: nextActive,
          editorTabs: nextEditors,
          workspaceSessionsByTab: nextWorkspaceSessions,
        };
      });
    },

    ensureSessionListeners: async (sessionId) => {
      if (listenersBySession[sessionId]) {
        return;
      }

      const stopOut = await listen<string>(`terminal:output:${sessionId}`, (event) => {
        get().appendSessionBuffer(sessionId, event.payload ?? "");
      });

      const stopExit = await listen<string>(`terminal:exit:${sessionId}`, (event) => {
        get().appendSessionBuffer(sessionId, `\r\n[${sessionId}] ${event.payload}`);
        toast.warning(`Sessao ${sessionId.slice(0, 8)} desconectada.`);
      });

      listenersBySession[sessionId] = [stopOut, stopExit];
    },

    clearSessionListeners: (sessionId) => {
      if (sessionId) {
        listenersBySession[sessionId]?.forEach((stop) => stop());
        delete listenersBySession[sessionId];
        return;
      }

      Object.entries(listenersBySession).forEach(([id, stops]) => {
        stops.forEach((stop) => stop());
        delete listenersBySession[id];
      });
    },

    getOrCreateSession: async (profile: ConnectionProfile) => {
      const existing = get().sessions.find((item) => item.profile_id === profile.id);
      if (existing) {
        await get().ensureSessionListeners(existing.session_id);
        return existing;
      }

      let result = await api.sshConnectEx(profile.id, {
        acceptUnknownHost: false,
      });

      if (result.status === "unknown_host_challenge") {
        const accepted = window.confirm(
          `Host desconhecido: ${result.host}:${result.port}\n${result.key_type} ${result.fingerprint}\n\nDeseja confiar neste host e conectar?`,
        );
        if (!accepted) {
          throw new Error("Conexao cancelada pelo usuario (host desconhecido).");
        }
        result = await api.sshConnectEx(profile.id, {
          acceptUnknownHost: true,
        });
      }

      if (result.status === "auth_required") {
        const password = window.prompt(
          `${result.message}\n\nDigite a senha para tentar novamente:`,
        );
        if (!password) {
          throw new Error("Conexao cancelada: senha nao informada.");
        }
        const save = window.confirm("Deseja salvar a senha neste perfil?");
        result = await api.sshConnectEx(profile.id, {
          acceptUnknownHost: true,
          passwordOverride: password,
          saveAuthChoice: save,
        });
      }

      if (result.status === "error") {
        throw new Error(result.message);
      }

      if (result.status !== "connected") {
        throw new Error("Nao foi possivel conectar a sessao SSH.");
      }

      const session = result.session;
      await get().ensureSessionListeners(session.session_id);
      set((state) => ({ sessions: [...state.sessions, session] }));
      return session;
    },

    openSsh: async (profile: ConnectionProfile) => {
      try {
        const session = await get().getOrCreateSession(profile);
        get().openTab({
          id: `ssh:${session.session_id}`,
          type: "ssh",
          title: `SSH - ${profile.host}`,
          closable: true,
          sessionId: session.session_id,
          profileId: profile.id,
        });
        get().appendSessionBuffer(session.session_id, `\r\nConnected to ${profile.host}\r\n`);
      } catch (error) {
        toast.error(getError(error));
      }
    },

    sshWrite: async (sessionId, data) => {
      try {
        await api.sshWrite(sessionId, data);
      } catch (error) {
        if (data.length > 0) {
          toast.error(getError(error));
        }
        scheduleReconnect(sessionId);
      }
    },

    disconnectSession: async (sessionId) => {
      try {
        await api.sshDisconnect(sessionId);
      } catch (error) {
        toast.error(getError(error));
      }

      get().clearSessionListeners(sessionId);
      set((state) => {
        const nextBuffers = { ...state.sessionBuffers };
        delete nextBuffers[sessionId];
        const nextLeft =
          state.leftPane.sourceId === sessionId
            ? { ...state.leftPane, sourceId: "local", path: "", entries: [], selectedFile: null }
            : state.leftPane;
        const nextRight =
          state.rightPane.sourceId === sessionId
            ? { ...state.rightPane, sourceId: "local", path: "", entries: [], selectedFile: null }
            : state.rightPane;
        return {
          sessions: state.sessions.filter((item) => item.session_id !== sessionId),
          tabs: state.tabs.filter((tab) => tab.sessionId !== sessionId),
          sessionBuffers: nextBuffers,
          workspaceSessionsByTab: Object.fromEntries(
            Object.entries(state.workspaceSessionsByTab).map(([tabId, sessionIds]) => [
              tabId,
              sessionIds.filter((id) => id !== sessionId),
            ]),
          ),
          leftPane: nextLeft,
          rightPane: nextRight,
          activeTabId: state.activeTabId && state.activeTabId.includes(sessionId) ? null : state.activeTabId,
        };
      });
    },
  };
}
