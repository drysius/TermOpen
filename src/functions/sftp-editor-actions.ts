import { toast } from "sonner";

import { baseName, getError, joinPath, slug } from "@/functions/common";
import { detectEditorFileMeta, formatBytes } from "@/functions/editor-file-utils";
import { formatProfileSourceId } from "@/pages/tabs/workspace/natives/runtime";
import type { StoreGet, StoreSet } from "@/functions/store-types";
import { getT } from "@/langs";
import { api } from "@/lib/tauri";
import type { AppActions, PaneSide } from "@/store/app-store.types";
import type { ConnectionProfile, ConnectionProtocol, SftpEntry } from "@/types/termopen";

const PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024;

function resolveWorkspaceFileProtocol(profile: ConnectionProfile): "sftp" | "ftp" | "ftps" | "smb" {
  const ordered = profile.protocols?.length ? profile.protocols : (["sftp"] as ConnectionProtocol[]);
  for (const protocol of ordered) {
    if (protocol === "sftp" || protocol === "ftp" || protocol === "ftps" || protocol === "smb") {
      return protocol;
    }
  }
  return "sftp";
}

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

async function readBinaryPreview(sourceId: string, path: string) {
  if (sourceId === "local") {
    return api.localReadBinaryPreview(path, PREVIEW_LIMIT_BYTES);
  }
  return api.sftpReadBinaryPreview(sourceId, path, PREVIEW_LIMIT_BYTES);
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
        const protocol = resolveWorkspaceFileProtocol(profile);
        get().openTab({
          id: `workspace:${Date.now()}:${Math.random().toString(16).slice(2, 7)}`,
          type: "workspace",
          title: `Workspace - ${profile.name}`,
          closable: true,
          profileId: profile.id,
          initialBlock: "sftp",
          initialSourceId: formatProfileSourceId(profile.id, protocol),
        });
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
        const meta = detectEditorFileMeta(path);
        const preferredEditor = get().settings.preferred_editor;

        if (meta.view === "text" && preferredEditor !== "internal") {
          const content = await readFile(sourceId, path);
          await api.openExternalEditor(baseName(path), content, get().settings.external_editor_command || null);
          return;
        }

        let content = "";
        let mediaBase64: string | null = null;
        let previewError: string | null = null;
        let sizeBytes: number | null = null;

        if (meta.view === "text") {
          content = await readFile(sourceId, path);
        } else if (meta.view === "image" || meta.view === "video") {
          const preview = await readBinaryPreview(sourceId, path);
          if (preview.status === "ready") {
            mediaBase64 = preview.base64;
            sizeBytes = preview.size;
          } else {
            sizeBytes = preview.size;
            previewError = `Arquivo muito grande para preview (${formatBytes(preview.size)} > ${formatBytes(preview.limit)}).`;
          }
        }

        const tabId = `editor:${sourceId}:${slug(path)}`;
        set((state) => ({
          editorTabs: {
            ...state.editorTabs,
            [tabId]: {
              sourceId,
              path,
              content,
              view: meta.view,
              language: meta.language,
              mimeType: meta.mimeType,
              mediaBase64,
              previewError,
              sizeBytes,
              dirty: false,
            },
          },
        }));
        get().openTab({ id: tabId, type: "editor", title: `Editor - ${baseName(path)}`, closable: true });
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
        toast.error(getT().toasts.selectSourceFile);
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
      if (editor.view !== "text") {
        toast.warning(getT().toasts.textOnlyEditor);
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
        toast.success(getT().toasts.fileSaved);
      } catch (error) {
        toast.error(getError(error));
      }
    },

    openEditorExternal: async (tabId) => {
      const editor = get().editorTabs[tabId];
      if (!editor) {
        return;
      }
      if (editor.view !== "text") {
        toast.warning(getT().toasts.mediaCantExport);
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
