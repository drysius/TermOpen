import { toast } from "sonner";

import { baseName, getError, joinPath, slug } from "@/functions/common";
import type { StoreGet, StoreSet } from "@/functions/store-types";
import { api } from "@/lib/tauri";
import type { AppActions, PaneSide } from "@/store/app-store.types";
import type { ConnectionProfile, SftpEntry } from "@/types/termopen";

async function listEntries(sourceId: string, path: string): Promise<SftpEntry[]> {
  if (sourceId === "local") {
    return api.localList(path || null);
  }
  return api.sftpList(sourceId, path || "/");
}

async function readFile(sourceId: string, path: string): Promise<string> {
  if (sourceId === "local") {
    return api.localRead(path);
  }
  return api.sftpRead(sourceId, path);
}

async function writeFile(sourceId: string, path: string, content: string): Promise<void> {
  if (sourceId === "local") {
    await api.localWrite(path, content);
    return;
  }
  await api.sftpWrite(sourceId, path, content);
}

export function createSftpEditorActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppActions,
  | "refreshPane"
  | "openSftpWorkspace"
  | "onPaneOpenEntry"
  | "openFileFromSource"
  | "copyBetween"
  | "saveEditor"
  | "openEditorExternal"
> {
  const updatePane = (side: PaneSide, partial: Partial<ReturnType<StoreGet>["leftPane"]>) => {
    set((state) =>
      side === "left"
        ? { leftPane: { ...state.leftPane, ...partial } }
        : { rightPane: { ...state.rightPane, ...partial } },
    );
  };

  return {
    refreshPane: async (side, sourceId, path) => {
      const pane = side === "left" ? get().leftPane : get().rightPane;
      const nextSource = sourceId ?? pane.sourceId;
      const nextPath = path ?? pane.path;

      updatePane(side, { loading: true, sourceId: nextSource, path: nextPath });
      try {
        const entries = await listEntries(nextSource, nextPath);
        updatePane(side, { sourceId: nextSource, path: nextPath, entries, loading: false });
      } catch (error) {
        toast.error(getError(error));
        updatePane(side, { loading: false });
      }
    },

    openSftpWorkspace: async (profile: ConnectionProfile) => {
      try {
        const session = await get().getOrCreateSession(profile);
        get().openTab({
          id: `sftp:workspace:${session.session_id}:${Date.now()}`,
          type: "sftp_workspace",
          title: `SFTP - ${profile.name}`,
          closable: true,
          sessionId: session.session_id,
          profileId: profile.id,
        });

        const state = get();
        const nextLeft =
          state.leftPane.sourceId === "local"
            ? { ...state.leftPane, sourceId: session.session_id, path: profile.remote_path || "/" }
            : state.leftPane;
        const nextRight =
          state.rightPane.sourceId === "local"
            ? { ...state.rightPane, sourceId: "local", path: state.rightPane.path || "" }
            : state.rightPane;

        set({
          leftPane: nextLeft,
          rightPane: nextRight,
        });

        await Promise.all([
          get().refreshPane("left", nextLeft.sourceId, nextLeft.path),
          get().refreshPane("right", nextRight.sourceId, nextRight.path),
        ]);
      } catch (error) {
        toast.error(getError(error));
      }
    },

    onPaneOpenEntry: async (side, entry) => {
      const pane = side === "left" ? get().leftPane : get().rightPane;
      if (entry.is_dir) {
        await get().refreshPane(side, pane.sourceId, entry.path);
        return;
      }
      await get().openFileFromSource(pane.sourceId, entry.path);
    },

    openFileFromSource: async (sourceId, path) => {
      try {
        const content = await readFile(sourceId, path);
        if (get().settings.preferred_editor === "internal") {
          const tabId = `editor:${sourceId}:${slug(path)}`;
          set((state) => ({
            editorTabs: {
              ...state.editorTabs,
              [tabId]: {
                sourceId,
                path,
                content,
                dirty: false,
              },
            },
          }));
          get().openTab({ id: tabId, type: "editor", title: `Editor - ${baseName(path)}`, closable: true });
          return;
        }
        await api.openExternalEditor(baseName(path), content, get().settings.external_editor_command || null);
      } catch (error) {
        toast.error(getError(error));
      }
    },

    copyBetween: async (direction) => {
      const state = get();
      const source = direction === "left_to_right" ? state.leftPane : state.rightPane;
      const target = direction === "left_to_right" ? state.rightPane : state.leftPane;
      const targetSide: PaneSide = direction === "left_to_right" ? "right" : "left";

      if (!source.selectedFile) {
        toast.error("Selecione um arquivo de origem.");
        return;
      }

      try {
        const content = await readFile(source.sourceId, source.selectedFile);
        const targetFile = joinPath(target.path, baseName(source.selectedFile));
        await writeFile(target.sourceId, targetFile, content);
        await get().refreshPane(targetSide, target.sourceId, target.path);
        toast.success(`Arquivo copiado para ${targetFile}`);
      } catch (error) {
        toast.error(getError(error));
      }
    },

    saveEditor: async (tabId) => {
      const editor = get().editorTabs[tabId];
      if (!editor) {
        return;
      }
      try {
        await writeFile(editor.sourceId, editor.path, editor.content);
        set((state) => ({
          editorTabs: {
            ...state.editorTabs,
            [tabId]: { ...state.editorTabs[tabId], dirty: false },
          },
        }));
        toast.success("Arquivo salvo.");
      } catch (error) {
        toast.error(getError(error));
      }
    },

    openEditorExternal: async (tabId) => {
      const editor = get().editorTabs[tabId];
      if (!editor) {
        return;
      }
      try {
        await api.openExternalEditor(
          baseName(editor.path),
          editor.content,
          get().settings.external_editor_command || null,
        );
      } catch (error) {
        toast.error(getError(error));
      }
    },
  };
}
