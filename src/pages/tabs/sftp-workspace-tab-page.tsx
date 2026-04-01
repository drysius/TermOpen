import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Editor from "@monaco-editor/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Columns2,
  FileText,
  Folder,
  Grip,
  Maximize2,
  Minimize2,
  MonitorUp,
  Plus,
  RefreshCw,
  Rows3,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { toast } from "sonner";

import { WorkspaceBlockController, type WorkspaceBlockLayout } from "@/components/workspace/workspace-block-controller";
import { Dialog } from "@/components/ui/dialog";
import { baseName, getError, joinPath, joinRemotePath, normalizeRemotePath, supportsProtocol } from "@/functions/common";
import {
  detectEditorFileMeta,
  formatBytes,
  type EditorViewMode,
  toDataUrl,
} from "@/functions/editor-file-utils";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import type { SftpEntry } from "@/types/termopen";

type WorkspaceKind = "terminal" | "sftp" | "editor";
type WorkspaceMode = "free" | "grid";
type SortKey = "name" | "size" | "permissions" | "modified_at";
type SortDirection = "asc" | "desc";

interface SftpWorkspaceTabPageProps {
  tabId: string;
  initialBlock?: "terminal" | "sftp";
  initialSourceId?: string;
}

interface BaseBlock {
  id: string;
  kind: WorkspaceKind;
  title: string;
  layout: WorkspaceBlockLayout;
  zIndex: number;
  maximized: boolean;
}

type TerminalConnectStage = "ready" | "connecting" | "verifying_fingerprint" | "awaiting_password" | "error";

interface PendingHostChallenge {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  message: string;
}

interface TerminalBlock extends BaseBlock {
  kind: "terminal";
  sessionId: string | null;
  pendingProfileId: string | null;
  connectStage: TerminalConnectStage;
  connectMessage: string;
  connectError: string | null;
  hostChallenge: PendingHostChallenge | null;
  passwordDraft: string;
  savePasswordChoice: boolean;
  acceptUnknownHost: boolean;
}

interface SftpBlock extends BaseBlock {
  kind: "sftp";
  sourceId: string;
  path: string;
  entries: SftpEntry[];
  loading: boolean;
  selectedPath: string | null;
  sortKey: SortKey;
  sortDirection: SortDirection;
  pathHistory: string[];
}

interface EditorBlock extends BaseBlock {
  kind: "editor";
  sourceId: string;
  path: string;
  content: string;
  view: EditorViewMode;
  language: string;
  mimeType: string | null;
  mediaBase64: string | null;
  previewError: string | null;
  sizeBytes: number | null;
  dirty: boolean;
  saving: boolean;
}

type WorkspaceBlock = TerminalBlock | SftpBlock | EditorBlock;

interface TransferItem {
  id: string;
  from: string;
  to: string;
  progress: number;
}

interface DragPayload {
  sourceBlockId: string;
  sourceId: string;
  path: string;
  isDir: boolean;
}

type SftpContextAction =
  | "refresh"
  | "copy_path"
  | "open_terminal"
  | "rename"
  | "delete"
  | "move"
  | "mkdir"
  | "mkfile"
  | "open_editor"
  | "download";

interface SftpContextMenuState {
  x: number;
  y: number;
  entry: SftpEntry | null;
}

const workspaceCache = new Map<string, { blocks: WorkspaceBlock[]; workspaceMode: WorkspaceMode }>();
const PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024;
const DRAG_ENTRY_MIME = "application/x-termopen-entry";

function parseDragPayload(dataTransfer: DataTransfer): DragPayload | null {
  const raw = dataTransfer.getData(DRAG_ENTRY_MIME) || dataTransfer.getData("text/plain");
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<DragPayload>;
    if (
      typeof parsed.sourceBlockId === "string" &&
      typeof parsed.sourceId === "string" &&
      typeof parsed.path === "string" &&
      typeof parsed.isDir === "boolean"
    ) {
      return parsed as DragPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function writeDragPayload(dataTransfer: DataTransfer, payload: DragPayload): void {
  const raw = JSON.stringify(payload);
  dataTransfer.setData(DRAG_ENTRY_MIME, raw);
  dataTransfer.setData("text/plain", raw);
}

function createId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

function parseProfileSourceId(sourceId?: string): string | null {
  if (!sourceId || !sourceId.startsWith("profile:")) {
    return null;
  }
  const value = sourceId.slice("profile:".length).trim();
  return value.length > 0 ? value : null;
}

function terminalDisconnectedLabel(sessionId: string | null): string {
  if (!sessionId) {
    return "Sessao pendente";
  }
  return `${sessionId} (desconectada)`;
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let current = size;
  while (current >= 1024 && idx < units.length - 1) {
    current /= 1024;
    idx += 1;
  }
  return `${current.toFixed(current >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatModified(timestamp?: number | null): string {
  if (!timestamp) {
    return "-";
  }
  return new Date(timestamp * 1000).toLocaleString();
}

function formatPermissions(value?: number | null): string {
  if (!value) {
    return "-";
  }
  const bits = value & 0o777;
  const triplet = (segment: number) =>
    `${segment & 4 ? "r" : "-"}${segment & 2 ? "w" : "-"}${segment & 1 ? "x" : "-"}`;
  return `${triplet((bits >> 6) & 7)}${triplet((bits >> 3) & 7)}${triplet(bits & 7)}`;
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) {
    return normalized.startsWith("/") ? "/" : "";
  }
  return normalized.slice(0, idx);
}

function shellQuote(path: string): string {
  return `"${path.replace(/(["\\$])/g, "\\$1")}"`;
}

function sortSftpEntries(entries: SftpEntry[], sortKey: SortKey, sortDirection: SortDirection): SftpEntry[] {
  const direction = sortDirection === "asc" ? 1 : -1;
  const sorted = [...entries].sort((left, right) => {
    if (left.is_dir !== right.is_dir) {
      return left.is_dir ? -1 : 1;
    }

    if (sortKey === "name") {
      return left.name.localeCompare(right.name) * direction;
    }
    if (sortKey === "size") {
      return ((left.size ?? 0) - (right.size ?? 0)) * direction;
    }
    if (sortKey === "permissions") {
      return ((left.permissions ?? 0) - (right.permissions ?? 0)) * direction;
    }
    return ((left.modified_at ?? 0) - (right.modified_at ?? 0)) * direction;
  });
  return sorted;
}

function computeGridLayout(index: number, total: number, width: number, height: number): WorkspaceBlockLayout {
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const col = index % cols;
  const row = Math.floor(index / cols);
  const gap = 8;
  const cellWidth = Math.floor((width - gap * (cols + 1)) / cols);
  const cellHeight = Math.floor((height - gap * (rows + 1)) / rows);
  return {
    x: gap + col * (cellWidth + gap),
    y: gap + row * (cellHeight + gap),
    width: Math.max(320, cellWidth),
    height: Math.max(220, cellHeight),
  };
}

function workspaceDefaultLayout(
  kind: WorkspaceKind,
  index: number,
  workspaceWidth: number,
  workspaceHeight: number,
): WorkspaceBlockLayout {
  const safeWidth = Math.max(900, workspaceWidth);
  const safeHeight = Math.max(560, workspaceHeight);
  if (kind === "sftp" && index === 0) {
    return {
      x: 8,
      y: 8,
      width: Math.floor(safeWidth * 0.3) - 12,
      height: safeHeight - 16,
    };
  }
  if (kind === "terminal" && index === 1) {
    const leftWidth = Math.floor(safeWidth * 0.3);
    return {
      x: leftWidth + 4,
      y: 8,
      width: safeWidth - leftWidth - 12,
      height: safeHeight - 16,
    };
  }
  const span = 28 * index;
  return {
    x: 24 + span,
    y: 24 + span,
    width: Math.max(400, Math.floor(safeWidth * 0.56)),
    height: Math.max(280, Math.floor(safeHeight * 0.52)),
  };
}

async function listSourceEntries(sourceId: string, path: string): Promise<SftpEntry[]> {
  if (sourceId === "local") {
    return api.localList(path.trim() || null);
  }
  return api.sftpList(sourceId, normalizeRemotePath(path));
}

async function readSourceFile(sourceId: string, path: string): Promise<string> {
  if (sourceId === "local") {
    return api.localRead(path);
  }
  return api.sftpRead(sourceId, path);
}

async function writeSourceFile(sourceId: string, path: string, content: string): Promise<void> {
  if (sourceId === "local") {
    await api.localWrite(path, content);
    return;
  }
  await api.sftpWrite(sourceId, path, content);
}

async function renameSourceEntry(sourceId: string, fromPath: string, toPath: string): Promise<void> {
  if (sourceId === "local") {
    await api.localRename(fromPath, toPath);
    return;
  }
  await api.sftpRename(sourceId, fromPath, toPath);
}

async function deleteSourceEntry(sourceId: string, path: string, isDir: boolean): Promise<void> {
  if (sourceId === "local") {
    await api.localDelete(path, isDir);
    return;
  }
  await api.sftpDelete(sourceId, path, isDir);
}

async function createSourceFolder(sourceId: string, path: string): Promise<void> {
  if (sourceId === "local") {
    await api.localMkdir(path);
    return;
  }
  await api.sftpMkdir(sourceId, path);
}

async function createSourceFile(sourceId: string, path: string): Promise<void> {
  if (sourceId === "local") {
    await api.localCreateFile(path);
    return;
  }
  await api.sftpCreateFile(sourceId, path);
}

async function readSourceBinaryPreview(sourceId: string, path: string) {
  if (sourceId === "local") {
    return api.localReadBinaryPreview(path, PREVIEW_LIMIT_BYTES);
  }
  return api.sftpReadBinaryPreview(sourceId, path, PREVIEW_LIMIT_BYTES);
}

export function SftpWorkspaceTabPage({ tabId, initialBlock, initialSourceId }: SftpWorkspaceTabPageProps) {
  const sessions = useAppStore((state) => state.sessions);
  const connections = useAppStore((state) => state.connections);
  const settings = useAppStore((state) => state.settings);
  const sshWrite = useAppStore((state) => state.sshWrite);
  const appendSessionBuffer = useAppStore((state) => state.appendSessionBuffer);
  const ensureSessionListeners = useAppStore((state) => state.ensureSessionListeners);
  const getOrCreateSession = useAppStore((state) => state.getOrCreateSession);
  const setWorkspaceSessions = useAppStore((state) => state.setWorkspaceSessions);
  const setWorkspaceBlockCount = useAppStore((state) => state.setWorkspaceBlockCount);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const blocksRef = useRef<WorkspaceBlock[]>([]);
  const cached = workspaceCache.get(tabId);
  const initializedRef = useRef(Boolean(cached && cached.blocks.length > 0));

  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(
    cached?.workspaceMode ?? "free",
  );
  const [workspaceSize, setWorkspaceSize] = useState({ width: 1200, height: 740 });
  const [blocks, setBlocks] = useState<WorkspaceBlock[]>(cached?.blocks ?? []);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [createBlockModalOpen, setCreateBlockModalOpen] = useState(false);
  const [createBlockKind, setCreateBlockKind] = useState<"terminal" | "sftp" | "editor">("terminal");
  const [createSourceDraft, setCreateSourceDraft] = useState("local");

  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  useEffect(() => {
    workspaceCache.set(tabId, { blocks, workspaceMode });
  }, [blocks, tabId, workspaceMode]);

  useEffect(() => {
    const sessionIds = Array.from(
      new Set(
        blocks
          .flatMap((block) => {
            if (block.kind === "terminal" && block.sessionId) {
              return [block.sessionId];
            }
            if (block.kind === "sftp" && block.sourceId !== "local") {
              return [block.sourceId];
            }
            return [];
          })
          .filter((value) => value.length > 0),
      ),
    );
    setWorkspaceSessions(tabId, sessionIds);
  }, [blocks, setWorkspaceSessions, tabId]);

  useEffect(() => {
    setWorkspaceBlockCount(tabId, blocks.length);
  }, [blocks.length, setWorkspaceBlockCount, tabId]);

  useEffect(() => {
    const container = workspaceRef.current;
    if (!container) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) {
        return;
      }
      setWorkspaceSize({
        width: Math.max(620, Math.floor(rect.width)),
        height: Math.max(420, Math.floor(rect.height)),
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const sessionLabelById = useMemo(() => {
    const map = new Map<string, string>();
    sessions.forEach((session) => {
      if (session.session_kind === "local") {
        map.set(session.session_id, "Local Terminal");
        return;
      }
      const profile = connections.find((item) => item.id === session.profile_id);
      if (profile) {
        map.set(session.session_id, `${profile.name} (${profile.host})`);
      } else {
        map.set(session.session_id, session.session_id);
      }
    });
    return map;
  }, [connections, sessions]);

  const sessionHostById = useMemo(() => {
    const map = new Map<string, string>();
    sessions.forEach((session) => {
      if (session.session_kind === "local") {
        map.set(session.session_id, "Local");
        return;
      }
      const profile = connections.find((item) => item.id === session.profile_id);
      map.set(session.session_id, profile?.host ?? session.session_id.slice(0, 8));
    });
    return map;
  }, [connections, sessions]);
  const localSessionIds = useMemo(
    () => new Set(sessions.filter((item) => item.session_kind === "local").map((item) => item.session_id)),
    [sessions],
  );

  const sshProfiles = useMemo(
    () => connections.filter((profile) => supportsProtocol(profile, "ssh")),
    [connections],
  );
  const sftpProfiles = useMemo(
    () => connections.filter((profile) => supportsProtocol(profile, "sftp")),
    [connections],
  );
  const createSourceOptions = useMemo(() => {
    if (createBlockKind === "terminal") {
      return [
        { id: "local", label: "Local Terminal" },
        ...sshProfiles.map((profile) => ({
          id: `profile:${profile.id}`,
          label: `${profile.host} (${profile.username})`,
        })),
      ];
    }
    if (createBlockKind === "sftp") {
      return [
        { id: "local", label: "Local File System" },
        ...sftpProfiles.map((profile) => ({
          id: `profile:${profile.id}`,
          label: `${profile.host} (${profile.username})`,
        })),
      ];
    }
    return [];
  }, [createBlockKind, sftpProfiles, sshProfiles]);

  const sourceOptions = useMemo(
    () => [
      { id: "local", label: "Local" },
      ...sessions
        .filter((session) => session.session_kind !== "local")
        .map((session) => ({
          id: session.session_id,
          label: sessionLabelById.get(session.session_id) ?? session.session_id,
        })),
    ],
    [sessionLabelById, sessions],
  );
  const terminalOptions = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.session_id,
        label: sessionLabelById.get(session.session_id) ?? session.session_id,
      })),
    [sessionLabelById, sessions],
  );

  const focusBlock = useCallback((id: string) => {
    setBlocks((current) => {
      const target = current.find((block) => block.id === id);
      if (!target) {
        return current;
      }
      const top = current.reduce((highest, item) => Math.max(highest, item.zIndex), 1);
      return current.map((block) => (block.id === id ? { ...block, zIndex: top + 1 } : block));
    });
  }, []);

  const closeBlock = useCallback((id: string) => {
    setBlocks((current) => current.filter((block) => block.id !== id));
  }, []);

  const toggleMaximize = useCallback((id: string) => {
    setBlocks((current) =>
      current.map((block) => (block.id === id ? { ...block, maximized: !block.maximized } : block)),
    );
    focusBlock(id);
  }, [focusBlock]);

  const onLayoutChange = useCallback((id: string, nextLayout: WorkspaceBlockLayout) => {
    setBlocks((current) =>
      current.map((block) => (block.id === id ? { ...block, layout: nextLayout } : block)),
    );
  }, []);

  const refreshSftpBlock = useCallback(
    async (blockId: string, pathOverride?: string, sourceOverride?: string) => {
      const target = blocksRef.current.find((block): block is SftpBlock => block.id === blockId && block.kind === "sftp");
      if (!target) {
        return;
      }

      const nextSourceId = sourceOverride ?? target.sourceId;
      const rawPath = pathOverride ?? target.path;
      const normalizedPath = nextSourceId === "local" ? rawPath.trim() : normalizeRemotePath(rawPath);

      setBlocks((current) =>
        current.map((block) =>
          block.id === blockId && block.kind === "sftp"
            ? { ...block, sourceId: nextSourceId, path: normalizedPath, loading: true, selectedPath: null }
            : block,
        ),
      );

      try {
        const entries = await listSourceEntries(nextSourceId, normalizedPath);
        setBlocks((current) =>
          current.map((block) => {
            if (block.id !== blockId || block.kind !== "sftp") {
              return block;
            }
            const history = [normalizedPath, ...block.pathHistory.filter((item) => item !== normalizedPath)].slice(0, 20);
            return {
              ...block,
              sourceId: nextSourceId,
              path: normalizedPath,
              entries,
              loading: false,
              pathHistory: history,
            };
          }),
        );
      } catch (error) {
        const message = getError(error);
        toast.error(message);
        if (nextSourceId !== "local") {
          toast.warning(`Bloco SFTP desconectado (${nextSourceId.slice(0, 8)}).`);
        }
        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "sftp" ? { ...block, loading: false } : block,
          ),
        );
      }
    },
    [],
  );

  const saveEditorBlock = useCallback(
    async (blockId: string) => {
      const target = blocksRef.current.find((block): block is EditorBlock => block.id === blockId && block.kind === "editor");
      if (!target || target.view !== "text" || !target.dirty || target.saving) {
        if (target && target.view !== "text") {
          toast.warning("Somente arquivos texto podem ser salvos no editor interno.");
        }
        return;
      }

      if (settings.modified_files_upload_policy === "ask") {
        const confirmUpload = window.confirm(`Enviar alteracoes de ${baseName(target.path)} agora?`);
        if (!confirmUpload) {
          return;
        }
      }

      setBlocks((current) =>
        current.map((block) => (block.id === blockId && block.kind === "editor" ? { ...block, saving: true } : block)),
      );
      try {
        await writeSourceFile(target.sourceId, target.path, target.content);
        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "editor"
              ? { ...block, dirty: false, saving: false }
              : block,
          ),
        );
        toast.success(`Arquivo salvo: ${baseName(target.path)}`);
      } catch (error) {
        toast.error(getError(error));
        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "editor" ? { ...block, saving: false } : block,
          ),
        );
      }
    },
    [settings.modified_files_upload_policy],
  );

  const openEditorBlockExternal = useCallback(
    async (blockId: string) => {
      const target = blocksRef.current.find((block): block is EditorBlock => block.id === blockId && block.kind === "editor");
      if (!target) {
        return;
      }
      if (target.view !== "text") {
        toast.warning("Preview de midia/binario nao exporta para editor externo por texto.");
        return;
      }

      try {
        await api.openExternalEditor(baseName(target.path), target.content, settings.external_editor_command || null);
      } catch (error) {
        toast.error(getError(error));
      }
    },
    [settings.external_editor_command],
  );

  useEffect(() => {
    if (settings.modified_files_upload_policy !== "auto") {
      return;
    }
    const pending = blocks.filter((block): block is EditorBlock => block.kind === "editor" && block.dirty && !block.saving);
    if (pending.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      pending.forEach((item) => {
        void saveEditorBlock(item.id);
      });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [blocks, saveEditorBlock, settings.modified_files_upload_policy]);

  const openFile = useCallback(
    async (sourceId: string, path: string) => {
      try {
        const meta = detectEditorFileMeta(path);
        if (meta.view === "text" && settings.preferred_editor !== "internal") {
          const content = await readSourceFile(sourceId, path);
          await api.openExternalEditor(baseName(path), content, settings.external_editor_command || null);
          return;
        }

        let content = "";
        let mediaBase64: string | null = null;
        let previewError: string | null = null;
        let sizeBytes: number | null = null;

        if (meta.view === "text") {
          content = await readSourceFile(sourceId, path);
        } else if (meta.view === "image" || meta.view === "video") {
          const preview = await readSourceBinaryPreview(sourceId, path);
          if (preview.status === "ready") {
            mediaBase64 = preview.base64;
            sizeBytes = preview.size;
          } else {
            sizeBytes = preview.size;
            previewError = `Arquivo muito grande para preview (${formatBytes(preview.size)} > ${formatBytes(preview.limit)}).`;
          }
        }

        const editorBlock: EditorBlock = {
          id: createId("editor"),
          kind: "editor",
          title: `Editor - ${baseName(path)}`,
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
          saving: false,
          layout: workspaceDefaultLayout("editor", blocksRef.current.length + 1, workspaceSize.width, workspaceSize.height),
          zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
          maximized: false,
        };
        setBlocks((current) => [...current, editorBlock]);
      } catch (error) {
        toast.error(getError(error));
      }
    },
    [settings.external_editor_command, settings.preferred_editor, workspaceSize.height, workspaceSize.width],
  );

  const executeTransfer = useCallback(
    async (fromSourceId: string, fromPath: string, toSourceId: string, toPath: string) => {
      const transferId = createId("transfer");
      setTransfers((current) => [...current, { id: transferId, from: fromPath, to: toPath, progress: 0 }]);

      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<number>(`transfer:progress:${transferId}`, (event) => {
          const progress = Number(event.payload ?? 0);
          setTransfers((current) =>
            current.map((item) => (item.id === transferId ? { ...item, progress } : item)),
          );
        });

        await api.sftpTransfer(
          transferId,
          fromSourceId === "local" ? null : fromSourceId,
          fromPath,
          toSourceId === "local" ? null : toSourceId,
          toPath,
        );
        toast.success(`Transferido para ${toPath}`);
      } catch (error) {
        toast.error(getError(error));
        throw error;
      } finally {
        unlisten?.();
        setTransfers((current) => current.filter((item) => item.id !== transferId));
      }
    },
    [],
  );

  const transferBetweenBlocks = useCallback(
    async (payload: DragPayload, targetBlockId: string, targetDirectory: string) => {
      if (payload.sourceBlockId === targetBlockId) {
        return;
      }
      const target = blocksRef.current.find((block): block is SftpBlock => block.id === targetBlockId && block.kind === "sftp");
      if (!target) {
        return;
      }

      if (payload.isDir) {
        toast.warning("Transferencia de pastas ainda esta em rollout. Por enquanto mova arquivos.");
        return;
      }

      const destination =
        target.sourceId === "local"
          ? joinPath(targetDirectory || target.path, baseName(payload.path))
          : joinRemotePath(targetDirectory || target.path, baseName(payload.path));
      try {
        await executeTransfer(payload.sourceId, payload.path, target.sourceId, destination);
        await refreshSftpBlock(targetBlockId, target.path, target.sourceId);
      } catch (error) {
        // handled by executeTransfer
      }
    },
    [executeTransfer, refreshSftpBlock],
  );

  const addSftpBlock = useCallback(
    (sourceId?: string) => {
      const firstSession = sessions.find((item) => item.session_kind !== "local")?.session_id ?? sessions[0]?.session_id;
      const resolvedSource = sourceId ?? firstSession ?? "local";
      const host = resolvedSource === "local" ? "Local" : sessionHostById.get(resolvedSource) ?? resolvedSource.slice(0, 8);
      const baseTitle = `SFTP - ${host}`;
      const count = blocksRef.current.filter((item) => item.kind === "sftp" && item.title.startsWith(baseTitle)).length;
      const initialPath = resolvedSource === "local" ? "" : normalizeRemotePath("/");
      const id = createId("sftp");
      const block: SftpBlock = {
        id,
        kind: "sftp",
        title: count > 0 ? `${baseTitle} (${count + 1})` : baseTitle,
        sourceId: resolvedSource,
        path: initialPath,
        entries: [],
        loading: false,
        selectedPath: null,
        sortKey: "name",
        sortDirection: "asc",
        pathHistory: [initialPath],
        layout: workspaceDefaultLayout("sftp", blocksRef.current.length, workspaceSize.width, workspaceSize.height),
        zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
        maximized: false,
      };
      setBlocks((current) => [...current, block]);
      window.setTimeout(() => {
        void refreshSftpBlock(id, block.path, block.sourceId);
      }, 0);
    },
    [refreshSftpBlock, sessions, sessionHostById, workspaceSize.height, workspaceSize.width],
  );

  const resolvePendingTerminalConnection = useCallback(
    async (
      blockId: string,
      options?: {
        acceptUnknownHost?: boolean;
        passwordOverride?: string | null;
        saveAuthChoice?: boolean;
      },
    ) => {
      const target = blocksRef.current.find(
        (item): item is TerminalBlock => item.id === blockId && item.kind === "terminal",
      );
      if (!target || !target.pendingProfileId) {
        return;
      }

      const profile = connections.find((item) => item.id === target.pendingProfileId);
      if (!profile) {
        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "terminal"
              ? {
                  ...block,
                  connectStage: "error",
                  connectMessage: "Host nao encontrado.",
                  connectError: "Host nao encontrado para concluir conexao.",
                }
              : block,
          ),
        );
        return;
      }

      const acceptUnknownHost = options?.acceptUnknownHost ?? target.acceptUnknownHost;
      const passwordOverride = options?.passwordOverride ?? null;
      const saveAuthChoice = options?.saveAuthChoice ?? false;
      const connectingMessage = passwordOverride
        ? "Logando..."
        : acceptUnknownHost
          ? "Verificando fingerprint..."
          : "Conectando...";

      setBlocks((current) =>
        current.map((block) =>
          block.id === blockId && block.kind === "terminal"
            ? {
                ...block,
                connectStage: "connecting",
                connectMessage: connectingMessage,
                connectError: null,
                hostChallenge: null,
              }
            : block,
        ),
      );

      try {
        const result = await api.sshConnectEx(profile.id, {
          acceptUnknownHost,
          passwordOverride,
          saveAuthChoice,
        });

        if (result.status === "connected") {
          const session = result.session;
          useAppStore.setState((state) => ({
            sessions: state.sessions.some((item) => item.session_id === session.session_id)
              ? state.sessions
              : [...state.sessions, session],
          }));
          await ensureSessionListeners(session.session_id);

          const prefix = "SSH";
          const host = profile.host || session.session_id.slice(0, 8);
          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "terminal"
                ? {
                    ...block,
                    title: `${prefix} - ${host}`,
                    sessionId: session.session_id,
                    pendingProfileId: null,
                    connectStage: "ready",
                    connectMessage: "Logado",
                    connectError: null,
                    hostChallenge: null,
                    acceptUnknownHost: false,
                  }
                : block,
            ),
          );
          appendSessionBuffer(session.session_id, `\r\nConnected to ${profile.host}\r\n`);
          return;
        }

        if (result.status === "unknown_host_challenge") {
          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "terminal"
                ? {
                    ...block,
                    connectStage: "verifying_fingerprint",
                    connectMessage: "Fingerprint do host precisa ser confirmada.",
                    connectError: null,
                    hostChallenge: {
                      host: result.host,
                      port: result.port,
                      keyType: result.key_type,
                      fingerprint: result.fingerprint,
                      message: result.message,
                    },
                  }
                : block,
            ),
          );
          return;
        }

        if (result.status === "auth_required") {
          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "terminal"
                ? {
                    ...block,
                    connectStage: "awaiting_password",
                    connectMessage: "Login pendente.",
                    connectError: result.message,
                    hostChallenge: null,
                  }
                : block,
            ),
          );
          return;
        }

        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "terminal"
              ? {
                  ...block,
                  connectStage: "error",
                  connectMessage: "Falha ao conectar.",
                  connectError: result.message,
                }
              : block,
          ),
        );
      } catch (error) {
        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "terminal"
              ? {
                  ...block,
                  connectStage: "error",
                  connectMessage: "Falha ao conectar.",
                  connectError: getError(error),
                  hostChallenge: null,
                }
              : block,
          ),
        );
      }
    },
    [appendSessionBuffer, connections, ensureSessionListeners],
  );

  const addTerminalBlock = useCallback(
    (sessionId?: string) => {
      const resolved = sessionId ?? sessions[0]?.session_id ?? null;
      if (!resolved) {
        toast.error("Nenhuma sessao disponivel para abrir terminal.");
        return;
      }

      const host = sessionHostById.get(resolved) ?? resolved.slice(0, 8);
      const prefix = localSessionIds.has(resolved) ? "Local" : "SSH";
      const baseTitle = `${prefix} - ${host}`;
      const count = blocksRef.current.filter((item) => item.kind === "terminal" && item.title.startsWith(baseTitle)).length;
      const block: TerminalBlock = {
        id: createId("terminal"),
        kind: "terminal",
        title: count > 0 ? `${baseTitle} (${count + 1})` : baseTitle,
        sessionId: resolved,
        pendingProfileId: null,
        connectStage: "ready",
        connectMessage: "Logado",
        connectError: null,
        hostChallenge: null,
        passwordDraft: "",
        savePasswordChoice: false,
        acceptUnknownHost: false,
        layout: workspaceDefaultLayout("terminal", blocksRef.current.length, workspaceSize.width, workspaceSize.height),
        zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
        maximized: false,
      };
      setBlocks((current) => [...current, block]);
      void ensureSessionListeners(resolved);
    },
    [ensureSessionListeners, localSessionIds, sessionHostById, sessions, workspaceSize.height, workspaceSize.width],
  );

  const addPendingTerminalBlock = useCallback(
    (profileId: string) => {
      const profile = connections.find((item) => item.id === profileId);
      if (!profile) {
        toast.error("Host nao encontrado para abrir o terminal.");
        return;
      }

      const host = profile.host || profileId.slice(0, 8);
      const baseTitle = `SSH - ${host}`;
      const count = blocksRef.current.filter((item) => item.kind === "terminal" && item.title.startsWith(baseTitle)).length;
      const blockId = createId("terminal");
      const block: TerminalBlock = {
        id: blockId,
        kind: "terminal",
        title: count > 0 ? `${baseTitle} (${count + 1})` : baseTitle,
        sessionId: null,
        pendingProfileId: profileId,
        connectStage: "connecting",
        connectMessage: "Conectando...",
        connectError: null,
        hostChallenge: null,
        passwordDraft: "",
        savePasswordChoice: false,
        acceptUnknownHost: false,
        layout: workspaceDefaultLayout("terminal", blocksRef.current.length, workspaceSize.width, workspaceSize.height),
        zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
        maximized: false,
      };
      setBlocks((current) => [...current, block]);
      window.setTimeout(() => {
        void resolvePendingTerminalConnection(blockId);
      }, 0);
    },
    [connections, resolvePendingTerminalConnection, workspaceSize.height, workspaceSize.width],
  );

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;
    if (initialBlock === "terminal" && initialSourceId) {
      const profileId = parseProfileSourceId(initialSourceId);
      if (profileId) {
        addPendingTerminalBlock(profileId);
        return;
      }
      addTerminalBlock(initialSourceId);
      return;
    }
    if (initialBlock === "sftp") {
      addSftpBlock(initialSourceId ?? "local");
    }
  }, [addPendingTerminalBlock, addSftpBlock, addTerminalBlock, initialBlock, initialSourceId]);

  const connectLocalTerminal = useCallback(async (): Promise<string> => {
    const session = await api.localTerminalConnect(null);
    useAppStore.setState((state) => ({
      sessions: state.sessions.some((item) => item.session_id === session.session_id)
        ? state.sessions
        : [...state.sessions, session],
    }));
    await ensureSessionListeners(session.session_id);
    return session.session_id;
  }, [ensureSessionListeners]);

  const connectProfileSession = useCallback(
    async (profileId: string): Promise<string> => {
      const profile = connections.find((item) => item.id === profileId);
      if (!profile) {
        throw new Error("Host nao encontrado para criar sessao.");
      }
      const session = await getOrCreateSession(profile);
      return session.session_id;
    },
    [connections, getOrCreateSession],
  );

  const openPathInTerminal = useCallback(
    async (sourceId: string, path: string) => {
      const targetPath = path || (sourceId === "local" ? "." : "/");
      let sessionId: string;

      if (sourceId === "local") {
        const existing = blocksRef.current.find(
          (item): item is TerminalBlock =>
            item.kind === "terminal" && !!item.sessionId && localSessionIds.has(item.sessionId),
        );
        if (existing?.sessionId) {
          sessionId = existing.sessionId;
        } else {
          sessionId = await connectLocalTerminal();
          addTerminalBlock(sessionId);
        }
      } else {
        const existing = blocksRef.current.find(
          (item): item is TerminalBlock =>
            item.kind === "terminal" && item.sessionId === sourceId,
        );
        sessionId = existing?.sessionId ?? sourceId;
        if (!existing) {
          addTerminalBlock(sourceId);
        }
      }

      await ensureSessionListeners(sessionId);
      await sshWrite(sessionId, `cd ${shellQuote(targetPath)}\n`);
    },
    [addTerminalBlock, connectLocalTerminal, ensureSessionListeners, localSessionIds, sshWrite],
  );

  const handleSftpContextAction = useCallback(
    async (block: SftpBlock, action: SftpContextAction, entry: SftpEntry | null) => {
      try {
        if (action === "refresh") {
          await refreshSftpBlock(block.id, block.path, block.sourceId);
          return;
        }
        if (action === "copy_path") {
          const text = entry?.path ?? block.path;
          await navigator.clipboard.writeText(text);
          toast.success("Caminho copiado.");
          return;
        }
        if (action === "open_terminal") {
          const terminalPath = entry ? (entry.is_dir ? entry.path : parentDirectory(entry.path)) : block.path;
          await openPathInTerminal(block.sourceId, terminalPath);
          return;
        }
        if (action === "open_editor") {
          if (!entry || entry.is_dir) {
            return;
          }
          await openFile(block.sourceId, entry.path);
          return;
        }
        if (action === "download") {
          if (!entry || entry.is_dir || block.sourceId === "local") {
            return;
          }
          const selected = await open({
            title: "Selecionar pasta de destino",
            multiple: false,
            directory: true,
          });
          if (typeof selected !== "string") {
            return;
          }
          const destination = joinPath(selected, baseName(entry.path));
          await executeTransfer(block.sourceId, entry.path, "local", destination);
          return;
        }
        if (action === "mkdir") {
          const folderName = window.prompt("Nome da pasta:", "");
          if (!folderName?.trim()) {
            return;
          }
          const target =
            block.sourceId === "local"
              ? joinPath(block.path, folderName.trim())
              : joinRemotePath(block.path, folderName.trim());
          await createSourceFolder(block.sourceId, target);
          await refreshSftpBlock(block.id, block.path, block.sourceId);
          return;
        }
        if (action === "mkfile") {
          const fileName = window.prompt("Nome do arquivo:", "");
          if (!fileName?.trim()) {
            return;
          }
          const target =
            block.sourceId === "local"
              ? joinPath(block.path, fileName.trim())
              : joinRemotePath(block.path, fileName.trim());
          await createSourceFile(block.sourceId, target);
          await refreshSftpBlock(block.id, block.path, block.sourceId);
          return;
        }
        if (!entry) {
          return;
        }
        if (action === "rename") {
          const nextPath = window.prompt("Novo caminho:", entry.path);
          if (!nextPath || nextPath.trim() === entry.path) {
            return;
          }
          await renameSourceEntry(block.sourceId, entry.path, nextPath.trim());
          await refreshSftpBlock(block.id, block.path, block.sourceId);
          return;
        }
        if (action === "move") {
          const suggested =
            block.sourceId === "local"
              ? joinPath(block.path, baseName(entry.path))
              : joinRemotePath(block.path, baseName(entry.path));
          const nextPath = window.prompt("Mover para:", suggested);
          if (!nextPath || nextPath.trim() === entry.path) {
            return;
          }
          await renameSourceEntry(block.sourceId, entry.path, nextPath.trim());
          await refreshSftpBlock(block.id, block.path, block.sourceId);
          return;
        }
        if (action === "delete") {
          const confirmed = window.confirm(`Remover ${entry.name}?`);
          if (!confirmed) {
            return;
          }
          await deleteSourceEntry(block.sourceId, entry.path, entry.is_dir);
          await refreshSftpBlock(block.id, block.path, block.sourceId);
        }
      } catch (error) {
        toast.error(getError(error));
      }
    },
    [executeTransfer, openFile, openPathInTerminal, refreshSftpBlock],
  );

  const createBlock = useCallback(async () => {
    try {
      if (createBlockKind === "editor") {
        const selected = await open({
          title: "Selecionar arquivo para editar",
          multiple: false,
          directory: false,
        });
        if (typeof selected === "string") {
          await openFile("local", selected);
        }
        setCreateBlockModalOpen(false);
        return;
      }

      let sourceId = createSourceDraft;
      if (createSourceDraft === "local" && createBlockKind === "terminal") {
        sourceId = await connectLocalTerminal();
      } else if (createSourceDraft.startsWith("profile:") && createBlockKind === "terminal") {
        const profileId = createSourceDraft.replace("profile:", "");
        addPendingTerminalBlock(profileId);
        setCreateBlockModalOpen(false);
        return;
      } else if (createSourceDraft.startsWith("profile:")) {
        const profileId = createSourceDraft.replace("profile:", "");
        sourceId = await connectProfileSession(profileId);
      }

      if (createBlockKind === "terminal") {
        addTerminalBlock(sourceId);
      } else {
        addSftpBlock(sourceId === "local" ? "local" : sourceId);
      }
      setCreateBlockModalOpen(false);
    } catch (error) {
      toast.error(getError(error));
    }
  }, [
    addPendingTerminalBlock,
    addSftpBlock,
    addTerminalBlock,
    connectLocalTerminal,
    connectProfileSession,
    createBlockKind,
    createSourceDraft,
    openFile,
  ]);

  useEffect(() => {
    if (!createBlockModalOpen) {
      return;
    }
    if (createBlockKind === "editor") {
      return;
    }
    if (!createSourceOptions.some((item) => item.id === createSourceDraft)) {
      setCreateSourceDraft("local");
    }
  }, [createBlockKind, createBlockModalOpen, createSourceDraft, createSourceOptions]);

  const renderedBlocks = useMemo(() => {
    if (workspaceMode === "free") {
      return blocks.map((block) => ({
        block,
        layout: block.maximized
          ? { x: 0, y: 0, width: workspaceSize.width, height: workspaceSize.height }
          : block.layout,
        interactive: !block.maximized,
      }));
    }

    return blocks.map((block, index) => ({
      block,
      layout: block.maximized
        ? { x: 0, y: 0, width: workspaceSize.width, height: workspaceSize.height }
        : computeGridLayout(index, blocks.length, workspaceSize.width, workspaceSize.height),
      interactive: false,
    }));
  }, [blocks, workspaceMode, workspaceSize.height, workspaceSize.width]);

  const activeTransfers = transfers.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 items-center gap-1 border-b border-white/10 px-2">
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded border border-white/15 text-zinc-300 transition hover:border-purple-400/60 hover:bg-zinc-900"
          onClick={() => {
            setCreateBlockKind("terminal");
            setCreateSourceDraft("local");
            setCreateBlockModalOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
        </button>

        <button
          type="button"
          className={cn(
            "flex h-7 items-center gap-1 rounded border px-2 text-xs transition",
            workspaceMode === "free"
              ? "border-purple-400/60 bg-purple-600/20 text-purple-200"
              : "border-white/10 text-zinc-300 hover:border-white/20 hover:bg-zinc-900",
          )}
          onClick={() => setWorkspaceMode("free")}
        >
          <Columns2 className="h-3.5 w-3.5" /> Livre
        </button>
        <button
          type="button"
          className={cn(
            "flex h-7 items-center gap-1 rounded border px-2 text-xs transition",
            workspaceMode === "grid"
              ? "border-purple-400/60 bg-purple-600/20 text-purple-200"
              : "border-white/10 text-zinc-300 hover:border-white/20 hover:bg-zinc-900",
          )}
          onClick={() => setWorkspaceMode("grid")}
        >
          <Rows3 className="h-3.5 w-3.5" /> Grid
        </button>

        <div className="ml-auto flex items-center gap-2 text-xs text-zinc-300">
          {activeTransfers > 0 ? (
            <div className="flex items-center gap-2 rounded border border-purple-400/40 bg-purple-600/10 px-2 py-1 text-purple-200">
              <MonitorUp className="h-3.5 w-3.5 animate-pulse" />
              <span>{activeTransfers} transferencia(s)</span>
            </div>
          ) : null}
        </div>
      </div>

      <div ref={workspaceRef} className="relative min-h-0 flex-1 overflow-hidden bg-zinc-950">
        {renderedBlocks.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-sm font-semibold text-zinc-200">Workspace vazio</p>
              <p className="mt-1 text-xs text-zinc-500">Adicione blocos de terminal e SFTP para comecar.</p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <button
                  type="button"
                  className="flex h-8 items-center gap-2 rounded border border-white/15 px-3 text-xs text-zinc-200 hover:bg-zinc-900"
                  onClick={() => {
                    setCreateBlockKind("sftp");
                    setCreateSourceDraft("local");
                    setCreateBlockModalOpen(true);
                  }}
                >
                  <Folder className="h-3.5 w-3.5" /> SFTP
                </button>
                <button
                  type="button"
                  className="flex h-8 items-center gap-2 rounded border border-white/15 px-3 text-xs text-zinc-200 hover:bg-zinc-900"
                  onClick={() => {
                    setCreateBlockKind("terminal");
                    setCreateSourceDraft("local");
                    setCreateBlockModalOpen(true);
                  }}
                >
                  <TerminalSquare className="h-3.5 w-3.5" /> Terminal
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {renderedBlocks.map(({ block, layout, interactive }) => (
          <WorkspaceBlockController
            key={block.id}
            id={block.id}
            title={block.title}
            layout={layout}
            zIndex={block.maximized ? 9999 : block.zIndex}
            interactive={interactive}
            onFocus={focusBlock}
            onLayoutChange={onLayoutChange}
            minWidth={block.kind === "terminal" ? 420 : 360}
            minHeight={block.kind === "terminal" ? 260 : 240}
            headerRight={
              <>
                <button
                  type="button"
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  onClick={() => toggleMaximize(block.id)}
                >
                  {block.maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  onClick={() => closeBlock(block.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            }
          >
            {block.kind === "terminal" ? (
              <TerminalBlockView
                block={block}
                sessionOptions={terminalOptions}
                onSessionChange={(nextSessionId) => {
                  const nextHost = sessionHostById.get(nextSessionId) ?? nextSessionId.slice(0, 8);
                  const nextPrefix = localSessionIds.has(nextSessionId) ? "Local" : "SSH";
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "terminal"
                        ? {
                            ...item,
                            sessionId: nextSessionId,
                            title: `${nextPrefix} - ${nextHost}`,
                            pendingProfileId: null,
                            connectStage: "ready",
                            connectMessage: "Logado",
                            connectError: null,
                            hostChallenge: null,
                            acceptUnknownHost: false,
                          }
                        : item,
                    ),
                  );
                  void ensureSessionListeners(nextSessionId);
                }}
                ensureSessionListeners={ensureSessionListeners}
                sshWrite={sshWrite}
                onTrustHost={() => {
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "terminal"
                        ? { ...item, acceptUnknownHost: true }
                        : item,
                    ),
                  );
                  void resolvePendingTerminalConnection(block.id, { acceptUnknownHost: true });
                }}
                onRetry={() => {
                  if (!block.pendingProfileId) {
                    return;
                  }
                  void resolvePendingTerminalConnection(block.id, {
                    acceptUnknownHost: block.acceptUnknownHost,
                  });
                }}
                onPasswordDraftChange={(value) => {
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "terminal"
                        ? { ...item, passwordDraft: value }
                        : item,
                    ),
                  );
                }}
                onSavePasswordChange={(checked) => {
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "terminal"
                        ? { ...item, savePasswordChoice: checked }
                        : item,
                    ),
                  );
                }}
                onSubmitPassword={() => {
                  const password = block.passwordDraft.trim();
                  if (!password) {
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "terminal"
                          ? { ...item, connectError: "Informe a senha para continuar." }
                          : item,
                      ),
                    );
                    return;
                  }
                  void resolvePendingTerminalConnection(block.id, {
                    acceptUnknownHost: block.acceptUnknownHost,
                    passwordOverride: password,
                    saveAuthChoice: block.savePasswordChoice,
                  });
                }}
              />
            ) : null}

            {block.kind === "sftp" ? (
              <SftpBlockView
                block={block}
                sourceOptions={sourceOptions}
                onFocus={() => focusBlock(block.id)}
                onRefresh={(path, sourceId) => void refreshSftpBlock(block.id, path, sourceId)}
                onSelectSort={(sortKey) =>
                  setBlocks((current) =>
                    current.map((item) => {
                      if (item.id !== block.id || item.kind !== "sftp") {
                        return item;
                      }
                      const direction =
                        item.sortKey === sortKey && item.sortDirection === "asc" ? "desc" : "asc";
                      return { ...item, sortKey, sortDirection: direction };
                    }),
                  )
                }
                onSelectEntry={(entryPath) =>
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "sftp" ? { ...item, selectedPath: entryPath } : item,
                    ),
                  )
                }
                onOpenEntry={(entry) => {
                  if (entry.is_dir) {
                    void refreshSftpBlock(block.id, entry.path, block.sourceId);
                    return;
                  }
                  void openFile(block.sourceId, entry.path);
                }}
                onDropTransfer={(payload, targetPath) => void transferBetweenBlocks(payload, block.id, targetPath)}
                onContextAction={(action, entry) => void handleSftpContextAction(block, action, entry)}
              />
            ) : null}

            {block.kind === "editor" ? (
              <EditorBlockView
                block={block}
                onChange={(value) =>
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "editor" && item.view === "text"
                        ? { ...item, content: value, dirty: true }
                        : item,
                    ),
                  )
                }
                onSave={() => void saveEditorBlock(block.id)}
                onOpenExternal={() => void openEditorBlockExternal(block.id)}
              />
            ) : null}
          </WorkspaceBlockController>
        ))}
      </div>

      <Dialog
        open={createBlockModalOpen}
        title="Novo Bloco"
        description="Escolha qual bloco deseja abrir neste workspace."
        onClose={() => setCreateBlockModalOpen(false)}
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded border border-white/20 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
              onClick={() => setCreateBlockModalOpen(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="rounded bg-purple-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-600"
              onClick={() => void createBlock()}
            >
              Criar Bloco
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className={cn(
                "rounded border p-2 text-xs transition",
                createBlockKind === "terminal"
                  ? "border-purple-400/60 bg-purple-600/20 text-purple-100"
                  : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-purple-400/40",
              )}
              onClick={() => setCreateBlockKind("terminal")}
            >
              <TerminalSquare className="mx-auto h-4 w-4" />
              <p className="mt-1">Terminal</p>
            </button>
            <button
              type="button"
              className={cn(
                "rounded border p-2 text-xs transition",
                createBlockKind === "sftp"
                  ? "border-purple-400/60 bg-purple-600/20 text-purple-100"
                  : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-purple-400/40",
              )}
              onClick={() => setCreateBlockKind("sftp")}
            >
              <Folder className="mx-auto h-4 w-4" />
              <p className="mt-1">SFTP</p>
            </button>
            <button
              type="button"
              className={cn(
                "rounded border p-2 text-xs transition",
                createBlockKind === "editor"
                  ? "border-purple-400/60 bg-purple-600/20 text-purple-100"
                  : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-purple-400/40",
              )}
              onClick={() => setCreateBlockKind("editor")}
            >
              <FileText className="mx-auto h-4 w-4" />
              <p className="mt-1">Editor</p>
            </button>
          </div>

          {createBlockKind !== "editor" ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-zinc-300">Origem</p>
              <select
                className="h-9 w-full rounded border border-white/10 bg-zinc-950 px-2 text-xs text-zinc-100"
                value={createSourceDraft}
                onChange={(event) => setCreateSourceDraft(event.target.value)}
              >
                {createSourceOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-zinc-500">
                {createBlockKind === "terminal"
                  ? "Escolha terminal local ou um host remoto para criar nova sessao."
                  : "Escolha local ou host remoto para abrir o explorador SFTP."}
              </p>
            </div>
          ) : (
            <p className="text-xs text-zinc-500">O editor abre arquivo local selecionado pelo sistema.</p>
          )}
        </div>
      </Dialog>
    </div>
  );
}

interface TerminalBlockViewProps {
  block: TerminalBlock;
  sessionOptions: Array<{ id: string; label: string }>;
  onSessionChange: (sessionId: string) => void;
  ensureSessionListeners: (sessionId: string) => Promise<void>;
  sshWrite: (sessionId: string, data: string) => Promise<void>;
  onTrustHost: () => void;
  onRetry: () => void;
  onPasswordDraftChange: (value: string) => void;
  onSavePasswordChange: (checked: boolean) => void;
  onSubmitPassword: () => void;
}

function TerminalBlockView({
  block,
  sessionOptions,
  onSessionChange,
  ensureSessionListeners,
  sshWrite,
  onTrustHost,
  onRetry,
  onPasswordDraftChange,
  onSavePasswordChange,
  onSubmitPassword,
}: TerminalBlockViewProps) {
  const { sessionId } = block;
  const settings = useAppStore((state) => state.settings);
  const selectableSessions = useMemo(() => {
    if (!sessionId) {
      return [{ id: "", label: terminalDisconnectedLabel(null) }, ...sessionOptions];
    }
    if (sessionOptions.some((option) => option.id === sessionId)) {
      return sessionOptions;
    }
    return [{ id: sessionId, label: terminalDisconnectedLabel(sessionId) }, ...sessionOptions];
  }, [sessionId, sessionOptions]);
  const buffer = useAppStore((state) => (sessionId ? state.sessionBuffers[sessionId] ?? "" : ""));
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);
  const isConnected = block.connectStage === "ready" && !!sessionId;

  const safeResize = useCallback(() => {
    if (!sessionId) {
      return;
    }
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) {
      return;
    }
    fit.fit();
    void api.sshResize(sessionId, term.cols, term.rows).catch(() => undefined);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }
    void ensureSessionListeners(sessionId);
  }, [ensureSessionListeners, isConnected, sessionId]);

  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#a855f7",
        black: "#09090b",
        red: "#f43f5e",
        green: "#4ade80",
        yellow: "#f59e0b",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#fb7185",
        brightGreen: "#86efac",
        brightYellow: "#fcd34d",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();

    const selectionDisposable = settings.terminal_copy_on_select
      ? terminal.onSelectionChange(() => {
          const selection = terminal.getSelection();
          if (selection) {
            void navigator.clipboard.writeText(selection).catch(() => undefined);
          }
        })
      : null;

    const onContextMenu = (event: globalThis.MouseEvent) => {
      if (!settings.terminal_right_click_paste) {
        return;
      }
      event.preventDefault();
      void navigator.clipboard.readText().then((value) => {
        if (value) {
          void sshWrite(sessionId, value);
        }
      });
    };
    host.addEventListener("contextmenu", onContextMenu);

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      if (!settings.terminal_ctrl_shift_shortcuts) {
        return true;
      }
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === "c") {
        const selection = terminal.getSelection();
        if (selection) {
          void navigator.clipboard.writeText(selection);
        }
        return false;
      }
      if (event.ctrlKey && event.shiftKey && key === "v") {
        void navigator.clipboard.readText().then((value) => {
          if (value) {
            void sshWrite(sessionId, value);
          }
        });
        return false;
      }
      return true;
    });

    const disposable = terminal.onData((data) => {
      void sshWrite(sessionId, data);
    });

    termRef.current = terminal;
    fitRef.current = fitAddon;
    writtenRef.current = 0;

    void api.sshResize(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
    void sshWrite(sessionId, "\n");

    return () => {
      disposable.dispose();
      selectionDisposable?.dispose();
      host.removeEventListener("contextmenu", onContextMenu);
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = 0;
    };
  }, [
    isConnected,
    sessionId,
    settings.terminal_copy_on_select,
    settings.terminal_ctrl_shift_shortcuts,
    settings.terminal_right_click_paste,
    sshWrite,
  ]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }
    const term = termRef.current;
    if (!term) {
      return;
    }
    if (buffer.length < writtenRef.current) {
      writtenRef.current = 0;
    }
    const delta = buffer.slice(writtenRef.current);
    if (delta.length > 0) {
      term.write(delta);
      writtenRef.current = buffer.length;
    }
  }, [buffer]);

  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }
    const timer = window.setInterval(() => {
      void sshWrite(sessionId, "");
    }, 180);
    return () => window.clearInterval(timer);
  }, [isConnected, sessionId, sshWrite]);

  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const observer = new ResizeObserver(() => safeResize());
    observer.observe(host);
    return () => observer.disconnect();
  }, [isConnected, safeResize, sessionId]);

  return (
    <div className="h-full min-h-0 overflow-hidden bg-zinc-950 p-1.5">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-white/10 bg-zinc-950">
        <div className="flex h-9 items-center gap-2 border-b border-white/10 px-2">
          <TerminalSquare className="h-4 w-4 text-purple-300" />
          <select
            className="h-7 min-w-[220px] rounded border border-white/10 bg-zinc-950 px-2 text-xs text-zinc-100"
            value={sessionId ?? ""}
            onChange={(event) => {
              if (event.target.value) {
                onSessionChange(event.target.value);
              }
            }}
          >
            {selectableSessions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden px-1 py-1">
          <div ref={hostRef} className={cn("h-full w-full overflow-hidden", !isConnected ? "opacity-40" : "")} />
          {!isConnected ? (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 p-3">
              <div className="w-full max-w-md rounded-lg border border-white/15 bg-zinc-950/95 p-4 shadow-2xl shadow-black/50">
                <div className="inline-flex items-center gap-2 text-sm text-zinc-100">
                  {block.connectStage === "connecting" ? (
                    <RefreshCw className="h-4 w-4 animate-spin text-cyan-300" />
                  ) : (
                    <TerminalSquare className="h-4 w-4 text-cyan-300" />
                  )}
                  <span>{block.connectMessage}</span>
                </div>
                <div className="mt-3 space-y-1 text-xs text-zinc-400">
                  <p className={cn(block.connectStage === "connecting" ? "text-cyan-300" : undefined)}>1. Conectando...</p>
                  <p className={cn(block.connectStage === "verifying_fingerprint" ? "text-cyan-300" : undefined)}>
                    2. Verificando fingerprint...
                  </p>
                  <p
                    className={cn(
                      block.connectStage === "awaiting_password" || block.connectStage === "error"
                        ? "text-cyan-300"
                        : undefined,
                    )}
                  >
                    3. Logando...
                  </p>
                </div>

                {block.connectStage === "verifying_fingerprint" && block.hostChallenge ? (
                  <div className="mt-3 rounded border border-white/10 bg-zinc-900/70 p-3 text-xs text-zinc-300">
                    <p className="font-medium text-zinc-100">{block.hostChallenge.message}</p>
                    <p className="mt-1">
                      {block.hostChallenge.host}:{block.hostChallenge.port}
                    </p>
                    <p className="mt-1 break-all text-zinc-400">
                      {block.hostChallenge.keyType} {block.hostChallenge.fingerprint}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded border border-cyan-400/50 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/20"
                        onClick={onTrustHost}
                      >
                        Confiar e continuar
                      </button>
                      <button
                        type="button"
                        className="rounded border border-white/20 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                        onClick={onRetry}
                      >
                        Tentar novamente
                      </button>
                    </div>
                  </div>
                ) : null}

                {(block.connectStage === "awaiting_password" || block.connectStage === "error") &&
                block.pendingProfileId ? (
                  <div className="mt-3 space-y-2">
                    <input
                      type="password"
                      value={block.passwordDraft}
                      className="h-9 w-full rounded border border-white/15 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none focus:border-cyan-400/60"
                      placeholder="Senha SSH"
                      onChange={(event) => onPasswordDraftChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          onSubmitPassword();
                        }
                      }}
                    />
                    <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
                      <input
                        type="checkbox"
                        checked={block.savePasswordChoice}
                        onChange={(event) => onSavePasswordChange(event.target.checked)}
                      />
                      Salvar senha no perfil
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded border border-cyan-400/50 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/20"
                        onClick={onSubmitPassword}
                      >
                        Logar
                      </button>
                      <button
                        type="button"
                        className="rounded border border-white/20 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                        onClick={onRetry}
                      >
                        Repetir conexao
                      </button>
                    </div>
                  </div>
                ) : null}

                {block.connectError ? (
                  <p className="mt-3 text-xs text-red-300">{block.connectError}</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface SftpBlockViewProps {
  block: SftpBlock;
  sourceOptions: Array<{ id: string; label: string }>;
  onFocus: () => void;
  onRefresh: (path: string, sourceId: string) => void;
  onSelectSort: (sortKey: SortKey) => void;
  onSelectEntry: (path: string) => void;
  onOpenEntry: (entry: SftpEntry) => void;
  onDropTransfer: (payload: DragPayload, targetPath: string) => void;
  onContextAction: (action: SftpContextAction, entry: SftpEntry | null) => void;
}

function SftpBlockView({
  block,
  sourceOptions,
  onFocus,
  onRefresh,
  onSelectSort,
  onSelectEntry,
  onOpenEntry,
  onDropTransfer,
  onContextAction,
}: SftpBlockViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(1200);
  const [contextMenu, setContextMenu] = useState<SftpContextMenuState | null>(null);
  const sortedEntries = useMemo(
    () => sortSftpEntries(block.entries, block.sortKey, block.sortDirection),
    [block.entries, block.sortDirection, block.sortKey],
  );
  const pathListId = useMemo(() => `path-history-${block.id}`, [block.id]);
  const showPermissions = containerWidth >= 860;
  const showSize = containerWidth >= 640;
  const showModified = containerWidth >= 1040;

  const [pathDraft, setPathDraft] = useState(block.path);
  useEffect(() => {
    setPathDraft(block.path);
  }, [block.path]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handlePointerDown = (event: globalThis.MouseEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) {
        setContainerWidth(width);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const columnButtonClass =
    "inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-zinc-400 hover:text-zinc-100";
  const handleEntryDragStart = useCallback(
    (event: DragEvent<HTMLElement>, entry: SftpEntry) => {
      if (entry.is_dir) {
        event.preventDefault();
        return;
      }
      const payload: DragPayload = {
        sourceBlockId: block.id,
        sourceId: block.sourceId,
        path: entry.path,
        isDir: false,
      };
      writeDragPayload(event.dataTransfer, payload);
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.dropEffect = "copy";
      event.stopPropagation();
    },
    [block.id, block.sourceId],
  );

  const openContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>, entry: SftpEntry | null) => {
      event.preventDefault();
      event.stopPropagation();
      if (entry) {
        onSelectEntry(entry.path);
      }
      const width = 224;
      const x = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8));
      const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 320));
      setContextMenu({ x, y, entry });
    },
    [onSelectEntry],
  );

  const menuItems = useMemo(() => {
    const entry = contextMenu?.entry ?? null;
    return [
      { action: "refresh" as const, label: "Atualizar", disabled: false },
      { action: "copy_path" as const, label: "Copiar caminho", disabled: false },
      { action: "open_terminal" as const, label: "Abrir no terminal", disabled: false },
      { action: "open_editor" as const, label: "Abrir no editor", disabled: !entry || entry.is_dir },
      { action: "rename" as const, label: "Renomear", disabled: !entry },
      { action: "move" as const, label: "Mover", disabled: !entry },
      { action: "delete" as const, label: "Deletar", disabled: !entry },
      { action: "mkdir" as const, label: "Nova pasta", disabled: false },
      { action: "mkfile" as const, label: "Novo arquivo", disabled: false },
      {
        action: "download" as const,
        label: "Baixar",
        disabled: !entry || entry.is_dir || block.sourceId === "local",
      },
    ];
  }, [block.sourceId, contextMenu?.entry]);

  const runContextAction = useCallback(
    (action: SftpContextAction) => {
      const entry = contextMenu?.entry ?? null;
      setContextMenu(null);
      void onContextAction(action, entry);
    },
    [contextMenu?.entry, onContextAction],
  );

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 flex-col"
      onMouseDown={onFocus}
      onContextMenu={(event) => openContextMenu(event, null)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const payload = parseDragPayload(event.dataTransfer);
        if (payload) {
          onDropTransfer(payload, block.path);
        }
      }}
    >
      <div className="grid grid-cols-[minmax(140px,0.9fr)_minmax(0,1.7fr)_auto] gap-2 border-b border-white/10 px-2 py-1.5">
        <select
          className="h-8 rounded border border-white/10 bg-zinc-950 px-2 text-xs text-zinc-100"
          value={block.sourceId}
          onChange={(event) => onRefresh(block.path, event.target.value)}
        >
          {sourceOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>

        <div className="flex min-w-0 items-center gap-1">
          <input
            className="h-8 min-w-0 w-full rounded border border-white/10 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-purple-400/70"
            value={pathDraft}
            list={pathListId}
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onRefresh(pathDraft, block.sourceId);
              }
            }}
          />
          <datalist id={pathListId}>
            {block.pathHistory.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
        </div>

        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded border border-white/10 text-zinc-300 hover:border-purple-400/60 hover:bg-zinc-900"
          onClick={() => onRefresh(pathDraft, block.sourceId)}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", block.loading ? "animate-spin" : undefined)} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full select-none border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-950/95">
            <tr className="border-b border-white/10">
              <th className="px-2 py-1.5 text-left">
                <button type="button" className={columnButtonClass} onClick={() => onSelectSort("name")}>
                  Nome{" "}
                  {block.sortKey === "name" ? (
                    block.sortDirection === "asc" ? (
                      <ArrowDownAZ className="h-3.5 w-3.5" />
                    ) : (
                      <ArrowUpAZ className="h-3.5 w-3.5" />
                    )
                  ) : null}
                </button>
              </th>
              {showPermissions ? (
                <th className="w-[140px] px-2 py-1.5 text-left">
                  <button type="button" className={columnButtonClass} onClick={() => onSelectSort("permissions")}>
                    Permissao
                  </button>
                </th>
              ) : null}
              {showSize ? (
                <th className="w-[120px] px-2 py-1.5 text-right">
                  <button type="button" className={cn(columnButtonClass, "ml-auto")} onClick={() => onSelectSort("size")}>
                    Tamanho
                  </button>
                </th>
              ) : null}
              {showModified ? (
                <th className="w-[190px] px-2 py-1.5 text-left">
                  <button type="button" className={columnButtonClass} onClick={() => onSelectSort("modified_at")}>
                    Modificado
                  </button>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => {
              const selected = block.selectedPath === entry.path;
              return (
                <tr
                  key={entry.path}
                  className={cn(
                    "border-b border-white/5 text-zinc-200 transition hover:bg-zinc-900/70",
                    entry.is_dir ? "cursor-default" : "cursor-grab active:cursor-grabbing",
                    selected ? "bg-purple-600/10" : undefined,
                  )}
                  draggable={!entry.is_dir}
                  onClick={() => onSelectEntry(entry.path)}
                  onDoubleClick={() => onOpenEntry(entry)}
                  onContextMenu={(event) => openContextMenu(event, entry)}
                  onDragStart={(event) => handleEntryDragStart(event, entry)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                  }}
                  onDrop={(event) => {
                    if (!entry.is_dir) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const payload = parseDragPayload(event.dataTransfer);
                    if (payload) {
                      onDropTransfer(payload, entry.path);
                    }
                  }}
                >
                  <td className="px-2 py-1.5">
                    <span
                      data-entry-drag="true"
                      className="inline-flex items-center gap-2"
                    >
                      {entry.is_dir ? (
                        <Folder className="h-3.5 w-3.5 text-purple-300" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 text-zinc-400" />
                      )}
                      <span className="truncate">{entry.name}</span>
                    </span>
                  </td>
                  {showPermissions ? (
                    <td className="px-2 py-1.5 text-zinc-400">{formatPermissions(entry.permissions)}</td>
                  ) : null}
                  {showSize ? (
                    <td className="px-2 py-1.5 text-right text-zinc-400">{entry.is_dir ? "-" : formatSize(entry.size)}</td>
                  ) : null}
                  {showModified ? (
                    <td className="px-2 py-1.5 text-zinc-400">{formatModified(entry.modified_at)}</td>
                  ) : null}
                </tr>
              );
            })}
            {sortedEntries.length === 0 ? (
              <tr>
                <td
                  className="px-2 py-6 text-center text-zinc-500"
                  colSpan={1 + Number(showPermissions) + Number(showSize) + Number(showModified)}
                >
                  {block.loading ? "Carregando..." : "Sem arquivos"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {contextMenu ? (
        <div
          className="fixed inset-0 z-50"
          onMouseDown={() => setContextMenu(null)}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            ref={contextMenuRef}
            className="absolute z-50 w-56 rounded border border-white/15 bg-zinc-950/95 p-1 shadow-2xl shadow-black/40 backdrop-blur"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {menuItems.map((item) => (
              <button
                key={item.action}
                type="button"
                className={cn(
                  "flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-zinc-100 transition",
                  item.disabled ? "cursor-not-allowed opacity-40" : "hover:bg-zinc-800",
                )}
                disabled={item.disabled}
                onClick={() => runContextAction(item.action)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface EditorBlockViewProps {
  block: EditorBlock;
  onChange: (value: string) => void;
  onSave: () => void;
  onOpenExternal: () => void;
}

function EditorBlockView({ block, onChange, onSave, onOpenExternal }: EditorBlockViewProps) {
  const canSave = block.view === "text";
  const previewUrl = block.mimeType && block.mediaBase64 ? toDataUrl(block.mimeType, block.mediaBase64) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 items-center justify-between border-b border-white/10 px-2">
        <div className="inline-flex items-center gap-2 text-xs text-zinc-400">
          <Grip className="h-3.5 w-3.5" />
          <span className="truncate">{block.path}</span>
          {block.dirty ? <span className="text-purple-300">*</span> : null}
        </div>
        <div className="inline-flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded border border-white/10 px-2 text-[11px] text-zinc-100 hover:border-purple-400/60 hover:bg-zinc-900"
            onClick={onSave}
            disabled={!canSave || block.saving}
          >
            {block.saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            Salvar
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded border border-white/10 px-2 text-[11px] text-zinc-100 hover:border-purple-400/60 hover:bg-zinc-900"
            onClick={onOpenExternal}
          >
            Externo
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {block.view === "text" ? (
          <Editor
            height="100%"
            theme="vs-dark"
            language={block.language || "plaintext"}
            value={block.content}
            onChange={(value) => onChange(value ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              smoothScrolling: true,
              automaticLayout: true,
            }}
          />
        ) : null}
        {block.view === "image" ? (
          <div className="flex h-full items-center justify-center bg-zinc-950 p-3">
            {previewUrl && !block.previewError ? (
              <img src={previewUrl} alt={block.path} className="max-h-full max-w-full object-contain" />
            ) : (
              <p className="text-sm text-zinc-400">
                {block.previewError ?? "Nao foi possivel carregar o preview da imagem."}
              </p>
            )}
          </div>
        ) : null}
        {block.view === "video" ? (
          <div className="flex h-full items-center justify-center bg-zinc-950 p-3">
            {previewUrl && !block.previewError ? (
              <video controls className="max-h-full max-w-full" src={previewUrl} />
            ) : (
              <p className="text-sm text-zinc-400">
                {block.previewError ?? "Nao foi possivel carregar o preview do video."}
              </p>
            )}
          </div>
        ) : null}
        {block.view === "binary" ? (
          <div className="flex h-full items-center justify-center bg-zinc-950 p-3">
            <p className="text-center text-sm text-zinc-400">
              Arquivo binario sem preview interno.
              {block.sizeBytes ? ` Tamanho: ${formatBytes(block.sizeBytes)}.` : ""}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
