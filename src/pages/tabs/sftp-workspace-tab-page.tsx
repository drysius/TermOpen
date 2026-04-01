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
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
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

type WorkspaceKind = "terminal" | "sftp" | "editor" | "logs";
type WorkspaceMode = "free";
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

type ConnectStage = "ready" | "connecting" | "verifying_fingerprint" | "awaiting_password" | "error";

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
  connectStage: ConnectStage;
  connectMessage: string;
  connectError: string | null;
  hostChallenge: PendingHostChallenge | null;
  passwordDraft: string;
  savePasswordChoice: boolean;
  acceptUnknownHost: boolean;
  retryAttempt: number;
  retryInSeconds: number | null;
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
  pendingProfileId: string | null;
  connectStage: ConnectStage;
  connectMessage: string;
  connectError: string | null;
  hostChallenge: PendingHostChallenge | null;
  passwordDraft: string;
  savePasswordChoice: boolean;
  acceptUnknownHost: boolean;
  retryAttempt: number;
  retryInSeconds: number | null;
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
  loading: boolean;
  loadProgress: number;
  loadError: string | null;
  dirty: boolean;
  saving: boolean;
}

interface LogsBlock extends BaseBlock {
  kind: "logs";
}

type WorkspaceBlock = TerminalBlock | SftpBlock | EditorBlock | LogsBlock;

type WorkspaceLogLevel = "info" | "success" | "warn" | "error";

interface WorkspaceLogEntry {
  id: string;
  timestamp: number;
  level: WorkspaceLogLevel;
  message: string;
  details?: string;
}

type TransferStatus = "running" | "completed" | "error";

interface TransferItem {
  id: string;
  sourceId: string;
  targetId: string;
  from: string;
  to: string;
  label: string;
  status: TransferStatus;
  errorMessage: string | null;
  sourceBlockId: string | null;
  targetBlockId: string | null;
  progress: number;
  createdAt: number;
  updatedAt: number;
}

interface BlockTransferItem {
  transfer: TransferItem;
  direction: "outgoing" | "incoming";
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
  pointerX: number;
  pointerY: number;
}

const workspaceCache = new Map<
  string,
  { blocks: WorkspaceBlock[]; workspaceMode: WorkspaceMode; logs: WorkspaceLogEntry[] }
>();
const PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024;
const DRAG_ENTRY_MIME = "application/x-termopen-entry";
const MAX_CONNECT_RETRY_ATTEMPTS = 3;

function isTimeoutErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("time out") ||
    normalized.includes("etimedout") ||
    normalized.includes("tempo esgotado")
  );
}

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

function normalizeAnyPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinPathBySource(sourceId: string, base: string, name: string): string {
  if (sourceId === "local") {
    return joinPath(base, name);
  }
  return joinRemotePath(base, name);
}

function joinRelativePathBySource(sourceId: string, base: string, relativePath: string): string {
  const segments = relativePath.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return base;
  }
  return segments.reduce((current, segment) => joinPathBySource(sourceId, current, segment), base);
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

function parentPathBySource(sourceId: string, path: string): string | null {
  if (sourceId === "local") {
    const originalHasBackslash = path.includes("\\");
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized) {
      return null;
    }
    if (/^[A-Za-z]:$/.test(normalized) || normalized === "/") {
      return null;
    }
    const idx = normalized.lastIndexOf("/");
    if (idx < 0) {
      return null;
    }
    const parentRaw = normalized.slice(0, idx);
    let parent = parentRaw;
    if (/^[A-Za-z]:$/.test(parentRaw)) {
      parent = `${parentRaw}/`;
    }
    if (!parent) {
      return null;
    }
    return originalHasBackslash ? parent.replace(/\//g, "\\") : parent;
  }

  const normalized = normalizeRemotePath(path);
  if (normalized === "/") {
    return null;
  }
  const parent = parentDirectory(normalized);
  return parent || "/";
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

function snapLayoutToWorkspace(layout: WorkspaceBlockLayout, workspace: { width: number; height: number }): WorkspaceBlockLayout {
  const gap = 8;
  const threshold = 32;
  const maxX = Math.max(gap, workspace.width - layout.width - gap);
  const maxY = Math.max(gap, workspace.height - layout.height - gap);
  const x = Math.max(gap, Math.min(layout.x, maxX));
  const y = Math.max(gap, Math.min(layout.y, maxY));
  const nearLeft = x <= threshold;
  const nearTop = y <= threshold;
  const nearRight = x + layout.width >= workspace.width - threshold;
  const nearBottom = y + layout.height >= workspace.height - threshold;

  const halfWidth = Math.max(320, Math.floor((workspace.width - gap * 3) / 2));
  const halfHeight = Math.max(220, Math.floor((workspace.height - gap * 3) / 2));
  const fullWidth = Math.max(320, workspace.width - gap * 2);
  const fullHeight = Math.max(220, workspace.height - gap * 2);

  if (nearLeft && nearTop) {
    return { x: gap, y: gap, width: halfWidth, height: halfHeight };
  }
  if (nearRight && nearTop) {
    return { x: workspace.width - gap - halfWidth, y: gap, width: halfWidth, height: halfHeight };
  }
  if (nearLeft && nearBottom) {
    return { x: gap, y: workspace.height - gap - halfHeight, width: halfWidth, height: halfHeight };
  }
  if (nearRight && nearBottom) {
    return {
      x: workspace.width - gap - halfWidth,
      y: workspace.height - gap - halfHeight,
      width: halfWidth,
      height: halfHeight,
    };
  }
  if (nearLeft) {
    return { x: gap, y: gap, width: halfWidth, height: fullHeight };
  }
  if (nearRight) {
    return { x: workspace.width - gap - halfWidth, y: gap, width: halfWidth, height: fullHeight };
  }
  if (nearTop) {
    return { x: gap, y: gap, width: fullWidth, height: halfHeight };
  }
  if (nearBottom) {
    return { x: gap, y: workspace.height - gap - halfHeight, width: fullWidth, height: halfHeight };
  }

  return { ...layout, x, y };
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

async function readSourceTextChunk(sourceId: string, path: string, offset: number) {
  if (sourceId === "local") {
    return api.localReadChunk(path, offset);
  }
  return api.sftpReadChunk(sourceId, path, offset);
}

function decodeBase64Chunk(value: string): Uint8Array {
  const raw = atob(value);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
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
  const ensureSessionListeners = useAppStore((state) => state.ensureSessionListeners);
  const disconnectSession = useAppStore((state) => state.disconnectSession);
  const setWorkspaceSessions = useAppStore((state) => state.setWorkspaceSessions);
  const setWorkspaceBlockCount = useAppStore((state) => state.setWorkspaceBlockCount);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const blocksRef = useRef<WorkspaceBlock[]>([]);
  const cached = workspaceCache.get(tabId);
  const initializedRef = useRef(Boolean(cached && cached.blocks.length > 0));

  const [workspaceMode] = useState<WorkspaceMode>("free");
  const [workspaceSize, setWorkspaceSize] = useState({ width: 1200, height: 740 });
  const [blocks, setBlocks] = useState<WorkspaceBlock[]>(cached?.blocks ?? []);
  const [workspaceLogs, setWorkspaceLogs] = useState<WorkspaceLogEntry[]>(cached?.logs ?? []);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [createBlockModalOpen, setCreateBlockModalOpen] = useState(false);
  const [createBlockKind, setCreateBlockKind] = useState<"terminal" | "sftp" | "editor" | "logs">("terminal");
  const [createSourceDraft, setCreateSourceDraft] = useState("local");
  const connectRetryTimersRef = useRef<Record<string, { retryTimer: number; countdownTimer: number }>>({});

  const clearBlockRetryTimers = useCallback((blockId: string) => {
    const active = connectRetryTimersRef.current[blockId];
    if (active) {
      window.clearTimeout(active.retryTimer);
      window.clearInterval(active.countdownTimer);
      delete connectRetryTimersRef.current[blockId];
    }
  }, []);

  const scheduleBlockAutoRetry = useCallback(
    (params: {
      blockId: string;
      kind: "terminal" | "sftp";
      delaySeconds: number;
      attempt: number;
      onRetry: () => void;
    }) => {
      clearBlockRetryTimers(params.blockId);
      let remaining = Math.max(1, params.delaySeconds);

      setBlocks((current) =>
        current.map((item) => {
          if (item.id !== params.blockId || item.kind !== params.kind) {
            return item;
          }
          return {
            ...item,
            retryAttempt: params.attempt,
            retryInSeconds: remaining,
          };
        }),
      );

      const countdownTimer = window.setInterval(() => {
        remaining -= 1;
        setBlocks((current) =>
          current.map((item) => {
            if (item.id !== params.blockId || item.kind !== params.kind) {
              return item;
            }
            return {
              ...item,
              retryInSeconds: Math.max(0, remaining),
            };
          }),
        );
        if (remaining <= 0) {
          const active = connectRetryTimersRef.current[params.blockId];
          if (active) {
            window.clearInterval(active.countdownTimer);
          }
        }
      }, 1000);

      const retryTimer = window.setTimeout(() => {
        clearBlockRetryTimers(params.blockId);
        setBlocks((current) =>
          current.map((item) => {
            if (item.id !== params.blockId || item.kind !== params.kind) {
              return item;
            }
            return {
              ...item,
              retryInSeconds: null,
            };
          }),
        );
        params.onRetry();
      }, remaining * 1000);

      connectRetryTimersRef.current[params.blockId] = {
        retryTimer,
        countdownTimer,
      };
    },
    [clearBlockRetryTimers],
  );

  useEffect(
    () => () => {
      Object.keys(connectRetryTimersRef.current).forEach((blockId) => clearBlockRetryTimers(blockId));
    },
    [clearBlockRetryTimers],
  );

  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  useEffect(() => {
    workspaceCache.set(tabId, { blocks, workspaceMode, logs: workspaceLogs });
  }, [blocks, tabId, workspaceLogs, workspaceMode]);

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

  const appendWorkspaceLog = useCallback(
    (level: WorkspaceLogLevel, message: string, details?: string) => {
      const entry: WorkspaceLogEntry = {
        id: createId("log"),
        timestamp: Date.now(),
        level,
        message,
        details,
      };
      setWorkspaceLogs((current) => {
        const next = [...current, entry];
        if (next.length > 800) {
          return next.slice(next.length - 800);
        }
        return next;
      });
    },
    [],
  );

  const setTransferSnapshot = useCallback(
    (updater: (current: TransferItem[]) => TransferItem[]) => {
      setTransfers((current) => {
        const next = updater(current)
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, 400);
        return next;
      });
    },
    [],
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

  const closeBlock = useCallback(
    (id: string) => {
      clearBlockRetryTimers(id);
      setBlocks((current) => current.filter((block) => block.id !== id));
    },
    [clearBlockRetryTimers],
  );

  const toggleMaximize = useCallback((id: string) => {
    setBlocks((current) =>
      current.map((block) => (block.id === id ? { ...block, maximized: !block.maximized } : block)),
    );
    focusBlock(id);
  }, [focusBlock]);

  const onLayoutChange = useCallback((id: string, nextLayout: WorkspaceBlockLayout) => {
    setBlocks((current) =>
      current.map((block) => {
        if (block.id !== id) {
          return block;
        }
        // Drag updates keep width/height; use this to apply edge/corner snap assist.
        const dragged =
          Math.round(block.layout.width) === Math.round(nextLayout.width) &&
          Math.round(block.layout.height) === Math.round(nextLayout.height);
        const snapped = dragged
          ? snapLayoutToWorkspace(nextLayout, workspaceSize)
          : {
              ...nextLayout,
              x: Math.max(8, Math.min(nextLayout.x, Math.max(8, workspaceSize.width - nextLayout.width - 8))),
              y: Math.max(8, Math.min(nextLayout.y, Math.max(8, workspaceSize.height - nextLayout.height - 8))),
            };
        return { ...block, layout: snapped };
      }),
    );
  }, [workspaceSize]);

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
        appendWorkspaceLog("error", "Falha ao listar diretorio SFTP", `${normalizedPath} | ${message}`);
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
      if (!target || target.view !== "text" || target.loading || !target.dirty || target.saving) {
        if (target && target.view !== "text") {
          toast.warning("Somente arquivos texto podem ser salvos no editor interno.");
        } else if (target?.loading) {
          toast.warning("Aguarde o fim do carregamento para salvar.");
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
      let streamingEditorId: string | null = null;
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
        let loading = false;
        let loadProgress = 100;
        let loadError: string | null = null;

        if (meta.view === "image" || meta.view === "video") {
          const preview = await readSourceBinaryPreview(sourceId, path);
          if (preview.status === "ready") {
            mediaBase64 = preview.base64;
            sizeBytes = preview.size;
          } else {
            sizeBytes = preview.size;
            previewError = `Arquivo muito grande para preview (${formatBytes(preview.size)} > ${formatBytes(preview.limit)}).`;
          }
        }

        if (meta.view === "text") {
          loading = true;
          loadProgress = 0;
        }

        const editorId = createId("editor");
        streamingEditorId = meta.view === "text" ? editorId : null;
        const editorBlock: EditorBlock = {
          id: editorId,
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
          loading,
          loadProgress,
          loadError,
          dirty: false,
          saving: false,
          layout: workspaceDefaultLayout("editor", blocksRef.current.length + 1, workspaceSize.width, workspaceSize.height),
          zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
          maximized: false,
        };
        setBlocks((current) => [...current, editorBlock]);

        if (meta.view !== "text") {
          return;
        }

        const decoder = new TextDecoder("utf-8");
        let offset = 0;
        let aggregated = "";

        while (true) {
          const chunk = await readSourceTextChunk(sourceId, path, offset);
          const bytes = decodeBase64Chunk(chunk.chunk_base64);
          aggregated += decoder.decode(bytes, { stream: !chunk.eof });
          offset = chunk.bytes_read;
          const progress =
            chunk.total_bytes > 0
              ? Math.max(0, Math.min(100, Math.round((chunk.bytes_read / chunk.total_bytes) * 100)))
              : chunk.eof
                ? 100
                : 0;

          setBlocks((current) =>
            current.map((item) =>
              item.id === editorId && item.kind === "editor"
                ? {
                    ...item,
                    content: aggregated,
                    loadProgress: progress,
                  }
                : item,
            ),
          );

          if (chunk.eof) {
            aggregated += decoder.decode();
            break;
          }
        }

        setBlocks((current) =>
          current.map((item) =>
            item.id === editorId && item.kind === "editor"
              ? {
                  ...item,
                  content: aggregated,
                  loading: false,
                  loadProgress: 100,
                  loadError: null,
                }
              : item,
          ),
        );
      } catch (error) {
        const message = getError(error);
        toast.error(message);
        if (streamingEditorId) {
          setBlocks((current) =>
            current.map((item) =>
              item.id === streamingEditorId && item.kind === "editor"
                ? {
                    ...item,
                    loading: false,
                    loadError: message,
                  }
                : item,
            ),
          );
        }
      }
    },
    [settings.external_editor_command, settings.preferred_editor, workspaceSize.height, workspaceSize.width],
  );

  const executeTransfer = useCallback(
    async (params: {
      fromSourceId: string;
      fromPath: string;
      toSourceId: string;
      toPath: string;
      label?: string;
      sourceBlockId?: string | null;
      targetBlockId?: string | null;
      notifySuccess?: boolean;
    }) => {
      const {
        fromSourceId,
        fromPath,
        toSourceId,
        toPath,
        label,
        sourceBlockId = null,
        targetBlockId = null,
        notifySuccess = true,
      } = params;
      const transferId = createId("transfer");
      const now = Date.now();

      setTransferSnapshot((current) => [
        {
          id: transferId,
          sourceId: fromSourceId,
          targetId: toSourceId,
          from: fromPath,
          to: toPath,
          label: label ?? baseName(fromPath),
          status: "running",
          errorMessage: null,
          sourceBlockId,
          targetBlockId,
          progress: 0,
          createdAt: now,
          updatedAt: now,
        },
        ...current,
      ]);
      appendWorkspaceLog("info", "Transferencia iniciada", `${fromPath} -> ${toPath}`);

      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<number>(`transfer:progress:${transferId}`, (event) => {
          const progress = Number(event.payload ?? 0);
          setTransferSnapshot((current) =>
            current.map((item) =>
              item.id === transferId
                ? { ...item, progress, status: "running", updatedAt: Date.now() }
                : item,
            ),
          );
        });

        await api.sftpTransfer(
          transferId,
          fromSourceId === "local" ? null : fromSourceId,
          fromPath,
          toSourceId === "local" ? null : toSourceId,
          toPath,
        );

        setTransferSnapshot((current) =>
          current.map((item) =>
            item.id === transferId
              ? {
                  ...item,
                  progress: 100,
                  status: "completed",
                  errorMessage: null,
                  updatedAt: Date.now(),
                }
              : item,
          ),
        );
        appendWorkspaceLog("success", "Transferencia concluida", `${fromPath} -> ${toPath}`);
        if (notifySuccess) {
          toast.success(`Transferido para ${toPath}`);
        }
      } catch (error) {
        const message = getError(error);
        setTransferSnapshot((current) =>
          current.map((item) =>
            item.id === transferId
              ? {
                  ...item,
                  status: "error",
                  errorMessage: message,
                  updatedAt: Date.now(),
                }
              : item,
          ),
        );
        appendWorkspaceLog("error", "Falha em transferencia", `${fromPath} -> ${toPath} | ${message}`);
        toast.error(message);
        throw error;
      } finally {
        unlisten?.();
      }
    },
    [appendWorkspaceLog, setTransferSnapshot],
  );

  const ensureTargetFolderExists = useCallback(
    async (targetSourceId: string, targetPath: string) => {
      try {
        await createSourceFolder(targetSourceId, targetPath);
      } catch (error) {
        const message = getError(error).toLowerCase();
        if (
          message.includes("exist") ||
          message.includes("already") ||
          message.includes("ja existe")
        ) {
          return;
        }
        throw error;
      }
    },
    [appendWorkspaceLog],
  );

  const buildDirectoryTransferPlan = useCallback(
    async (sourceId: string, rootPath: string) => {
      const directories: string[] = [];
      const files: Array<{ path: string; relativePath: string }> = [];
      const stack: Array<{ path: string; relativeRoot: string }> = [{ path: rootPath, relativeRoot: "" }];
      const visited = new Set<string>();

      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
          continue;
        }

        const visitKey = `${sourceId}:${normalizeAnyPath(current.path)}`;
        if (visited.has(visitKey)) {
          continue;
        }
        visited.add(visitKey);

        const entries = await listSourceEntries(sourceId, current.path);
        for (const entry of entries) {
          if (entry.name === "." || entry.name === "..") {
            continue;
          }

          const relativePath = current.relativeRoot
            ? `${current.relativeRoot}/${entry.name}`
            : entry.name;
          if (entry.is_dir) {
            directories.push(relativePath);
            stack.push({ path: entry.path, relativeRoot: relativePath });
          } else {
            files.push({ path: entry.path, relativePath });
          }
        }
      }

      directories.sort(
        (left, right) =>
          left.split("/").filter((part) => part.length > 0).length -
          right.split("/").filter((part) => part.length > 0).length,
      );
      return { directories, files };
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

      const targetBasePath = targetDirectory || target.path;
      const droppedName = baseName(payload.path);

      try {
        if (!payload.isDir) {
          const destination = joinPathBySource(target.sourceId, targetBasePath, droppedName);
          if (
            payload.sourceId === target.sourceId &&
            normalizeAnyPath(destination) === normalizeAnyPath(payload.path)
          ) {
            return;
          }
          await executeTransfer({
            fromSourceId: payload.sourceId,
            fromPath: payload.path,
            toSourceId: target.sourceId,
            toPath: destination,
            sourceBlockId: payload.sourceBlockId,
            targetBlockId,
          });
          await refreshSftpBlock(targetBlockId, target.path, target.sourceId);
          return;
        }

        const destinationRoot = joinPathBySource(target.sourceId, targetBasePath, droppedName);
        const normalizedSourceRoot = normalizeAnyPath(payload.path);
        const normalizedDestinationRoot = normalizeAnyPath(destinationRoot);
        if (
          payload.sourceId === target.sourceId &&
          (normalizedDestinationRoot === normalizedSourceRoot ||
            normalizedDestinationRoot.startsWith(`${normalizedSourceRoot}/`))
        ) {
          toast.error("Nao e possivel copiar uma pasta para dentro dela mesma.");
          appendWorkspaceLog("warn", "Copia de pasta bloqueada", `${payload.path} -> ${destinationRoot}`);
          return;
        }

        appendWorkspaceLog("info", "Preparando transferencia de pasta", `${payload.path} -> ${destinationRoot}`);
        const plan = await buildDirectoryTransferPlan(payload.sourceId, payload.path);
        await ensureTargetFolderExists(target.sourceId, destinationRoot);
        for (const relativeDir of plan.directories) {
          const targetPath = joinRelativePathBySource(target.sourceId, destinationRoot, relativeDir);
          await ensureTargetFolderExists(target.sourceId, targetPath);
        }

        let completedFiles = 0;
        for (const file of plan.files) {
          const targetFilePath = joinRelativePathBySource(target.sourceId, destinationRoot, file.relativePath);
          await executeTransfer({
            fromSourceId: payload.sourceId,
            fromPath: file.path,
            toSourceId: target.sourceId,
            toPath: targetFilePath,
            label: file.relativePath,
            sourceBlockId: payload.sourceBlockId,
            targetBlockId,
            notifySuccess: false,
          });
          completedFiles += 1;
        }

        await refreshSftpBlock(targetBlockId, target.path, target.sourceId);
        toast.success(`Pasta transferida: ${completedFiles} arquivo(s).`);
        appendWorkspaceLog(
          "success",
          "Transferencia de pasta concluida",
          `${payload.path} -> ${destinationRoot} (${completedFiles} arquivo(s))`,
        );
      } catch (error) {
        // handled by executeTransfer
      }
    },
    [
      appendWorkspaceLog,
      buildDirectoryTransferPlan,
      ensureTargetFolderExists,
      executeTransfer,
      refreshSftpBlock,
    ],
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
        pendingProfileId: null,
        connectStage: "ready",
        connectMessage: "Logado",
        connectError: null,
        hostChallenge: null,
        passwordDraft: "",
        savePasswordChoice: false,
        acceptUnknownHost: false,
        retryAttempt: 0,
        retryInSeconds: null,
        layout: workspaceDefaultLayout("sftp", blocksRef.current.length, workspaceSize.width, workspaceSize.height),
        zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
        maximized: false,
      };
      setBlocks((current) => [...current, block]);
      appendWorkspaceLog("info", "Bloco SFTP criado", `${block.title} @ ${block.path || "/"}`);
      window.setTimeout(() => {
        void refreshSftpBlock(id, block.path, block.sourceId);
      }, 0);
    },
    [appendWorkspaceLog, refreshSftpBlock, sessions, sessionHostById, workspaceSize.height, workspaceSize.width],
  );

  const addLogsBlock = useCallback(() => {
    const existing = blocksRef.current.find((item): item is LogsBlock => item.kind === "logs");
    if (existing) {
      focusBlock(existing.id);
      return;
    }

    const block: LogsBlock = {
      id: createId("logs"),
      kind: "logs",
      title: "Workspace Logs",
      layout: workspaceDefaultLayout("logs", blocksRef.current.length, workspaceSize.width, workspaceSize.height),
      zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
      maximized: false,
    };
    setBlocks((current) => [...current, block]);
    appendWorkspaceLog("info", "Bloco de logs aberto");
  }, [appendWorkspaceLog, focusBlock, workspaceSize.height, workspaceSize.width]);

  const resolvePendingTerminalConnection = useCallback(
    async (
      blockId: string,
      options?: {
        acceptUnknownHost?: boolean;
        passwordOverride?: string | null;
        saveAuthChoice?: boolean;
        retryAttempt?: number;
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
      const currentAttempt = Math.max(0, options?.retryAttempt ?? target.retryAttempt);
      const connectingMessage = passwordOverride
        ? "Logando..."
        : acceptUnknownHost
          ? "Verificando fingerprint..."
          : "Conectando...";
      clearBlockRetryTimers(blockId);
      appendWorkspaceLog(
        "info",
        "Conexao SSH em andamento",
        `${profile.username}@${profile.host}:${profile.port}`,
      );

      setBlocks((current) =>
        current.map((block) =>
          block.id === blockId && block.kind === "terminal"
            ? {
                ...block,
                connectStage: "connecting",
                connectMessage: connectingMessage,
                connectError: null,
                hostChallenge: null,
                retryAttempt: currentAttempt,
                retryInSeconds: null,
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
          await sshWrite(session.session_id, "").catch(() => undefined);

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
                    retryAttempt: 0,
                    retryInSeconds: null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog(
            "success",
            "Sessao SSH conectada",
            `${profile.username}@${profile.host}:${profile.port}`,
          );
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
                    retryAttempt: 0,
                    retryInSeconds: null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog(
            "warn",
            "Fingerprint SSH requer confirmacao",
            `${result.host}:${result.port} ${result.fingerprint}`,
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
                    retryAttempt: 0,
                    retryInSeconds: null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog(
            "warn",
            "Autenticacao SSH pendente",
            `${profile.username}@${profile.host}:${profile.port}`,
          );
          return;
        }

        const timeoutDetected = isTimeoutErrorMessage(result.message);
        if (timeoutDetected) {
          const nextAttempt = currentAttempt + 1;
          const delaySeconds = Math.max(1, settings.reconnect_delay_seconds);
          const canRetry =
            settings.auto_reconnect_enabled && nextAttempt <= MAX_CONNECT_RETRY_ATTEMPTS;
          const retryLabel = canRetry
            ? `Nova tentativa em ${delaySeconds}s (${nextAttempt}/${MAX_CONNECT_RETRY_ATTEMPTS}).`
            : `Limite de ${MAX_CONNECT_RETRY_ATTEMPTS} tentativas atingido.`;

          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "terminal"
                ? {
                    ...block,
                    connectStage: "error",
                    connectMessage: "Timeout na conexao SSH.",
                    connectError: `${result.message} ${retryLabel}`.trim(),
                    hostChallenge: null,
                    retryAttempt: nextAttempt,
                    retryInSeconds: canRetry ? delaySeconds : null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog(
            "warn",
            "Timeout ao conectar sessao SSH",
            `${profile.username}@${profile.host}:${profile.port} | ${retryLabel}`,
          );

          if (canRetry) {
            scheduleBlockAutoRetry({
              blockId,
              kind: "terminal",
              delaySeconds,
              attempt: nextAttempt,
              onRetry: () => {
                void resolvePendingTerminalConnection(blockId, {
                  acceptUnknownHost,
                  passwordOverride,
                  saveAuthChoice,
                  retryAttempt: nextAttempt,
                });
              },
            });
          }
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
                  retryAttempt: 0,
                  retryInSeconds: null,
                }
              : block,
          ),
        );
        appendWorkspaceLog("error", "Falha ao conectar sessao SSH", result.message);
      } catch (error) {
        const message = getError(error);
        const timeoutDetected = isTimeoutErrorMessage(message);
        if (timeoutDetected) {
          const nextAttempt = currentAttempt + 1;
          const delaySeconds = Math.max(1, settings.reconnect_delay_seconds);
          const canRetry =
            settings.auto_reconnect_enabled && nextAttempt <= MAX_CONNECT_RETRY_ATTEMPTS;
          const retryLabel = canRetry
            ? `Nova tentativa em ${delaySeconds}s (${nextAttempt}/${MAX_CONNECT_RETRY_ATTEMPTS}).`
            : `Limite de ${MAX_CONNECT_RETRY_ATTEMPTS} tentativas atingido.`;

          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "terminal"
                ? {
                    ...block,
                    connectStage: "error",
                    connectMessage: "Timeout na conexao SSH.",
                    connectError: `${message} ${retryLabel}`.trim(),
                    hostChallenge: null,
                    retryAttempt: nextAttempt,
                    retryInSeconds: canRetry ? delaySeconds : null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog(
            "warn",
            "Timeout ao conectar sessao SSH",
            `${profile.username}@${profile.host}:${profile.port} | ${retryLabel}`,
          );

          if (canRetry) {
            scheduleBlockAutoRetry({
              blockId,
              kind: "terminal",
              delaySeconds,
              attempt: nextAttempt,
              onRetry: () => {
                void resolvePendingTerminalConnection(blockId, {
                  acceptUnknownHost,
                  passwordOverride,
                  saveAuthChoice,
                  retryAttempt: nextAttempt,
                });
              },
            });
          }
          return;
        }

        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "terminal"
              ? {
                  ...block,
                  connectStage: "error",
                  connectMessage: "Falha ao conectar.",
                  connectError: message,
                  hostChallenge: null,
                  retryAttempt: 0,
                  retryInSeconds: null,
                }
              : block,
          ),
        );
        appendWorkspaceLog("error", "Erro ao conectar sessao SSH", message);
      }
    },
    [
      appendWorkspaceLog,
      clearBlockRetryTimers,
      connections,
      ensureSessionListeners,
      scheduleBlockAutoRetry,
      settings.auto_reconnect_enabled,
      settings.reconnect_delay_seconds,
      sshWrite,
    ],
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
        retryAttempt: 0,
        retryInSeconds: null,
        layout: workspaceDefaultLayout("terminal", blocksRef.current.length, workspaceSize.width, workspaceSize.height),
        zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
        maximized: false,
      };
      setBlocks((current) => [...current, block]);
      appendWorkspaceLog("info", "Bloco de terminal criado", block.title);
      void ensureSessionListeners(resolved);
    },
    [
      appendWorkspaceLog,
      ensureSessionListeners,
      localSessionIds,
      sessionHostById,
      sessions,
      workspaceSize.height,
      workspaceSize.width,
    ],
  );

  const resolvePendingSftpConnection = useCallback(
    async (
      blockId: string,
      options?: {
        acceptUnknownHost?: boolean;
        passwordOverride?: string | null;
        saveAuthChoice?: boolean;
        retryAttempt?: number;
      },
    ) => {
      const target = blocksRef.current.find(
        (item): item is SftpBlock => item.id === blockId && item.kind === "sftp",
      );
      if (!target || !target.pendingProfileId) {
        return;
      }

      const profile = connections.find((item) => item.id === target.pendingProfileId);
      if (!profile) {
        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "sftp"
              ? {
                  ...block,
                  connectStage: "error",
                  connectMessage: "Host nao encontrado.",
                  connectError: "Host nao encontrado para concluir conexao SFTP.",
                  loading: false,
                  retryAttempt: 0,
                  retryInSeconds: null,
                }
              : block,
          ),
        );
        return;
      }

      const acceptUnknownHost = options?.acceptUnknownHost ?? target.acceptUnknownHost;
      const passwordOverride = options?.passwordOverride ?? null;
      const saveAuthChoice = options?.saveAuthChoice ?? false;
      const currentAttempt = Math.max(0, options?.retryAttempt ?? target.retryAttempt);
      const connectingMessage = passwordOverride
        ? "Logando..."
        : acceptUnknownHost
          ? "Verificando fingerprint..."
          : "Conectando...";

      clearBlockRetryTimers(blockId);
      appendWorkspaceLog(
        "info",
        "Conexao SFTP em andamento",
        `${profile.username}@${profile.host}:${profile.port}`,
      );

      setBlocks((current) =>
        current.map((block) =>
          block.id === blockId && block.kind === "sftp"
            ? {
                ...block,
                connectStage: "connecting",
                connectMessage: connectingMessage,
                connectError: null,
                hostChallenge: null,
                loading: true,
                retryAttempt: currentAttempt,
                retryInSeconds: null,
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

          const preferredPath = profile.remote_path?.trim()
            ? normalizeRemotePath(profile.remote_path)
            : normalizeRemotePath(target.path || "/");

          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "sftp"
                ? {
                    ...block,
                    sourceId: session.session_id,
                    path: preferredPath,
                    loading: true,
                    connectStage: "connecting",
                    connectMessage: "Carregando diretorio inicial...",
                    connectError: null,
                    hostChallenge: null,
                    retryAttempt: currentAttempt,
                    retryInSeconds: null,
                  }
                : block,
            ),
          );

          try {
            const entries = await listSourceEntries(session.session_id, preferredPath);
            setBlocks((current) =>
              current.map((block) => {
                if (block.id !== blockId || block.kind !== "sftp") {
                  return block;
                }
                const history = [preferredPath, ...block.pathHistory.filter((item) => item !== preferredPath)].slice(0, 20);
                return {
                  ...block,
                  sourceId: session.session_id,
                  path: preferredPath,
                  entries,
                  loading: false,
                  pathHistory: history,
                  pendingProfileId: null,
                  connectStage: "ready",
                  connectMessage: "Logado",
                  connectError: null,
                  hostChallenge: null,
                  acceptUnknownHost: false,
                  retryAttempt: 0,
                  retryInSeconds: null,
                };
              }),
            );
            appendWorkspaceLog(
              "success",
              "Sessao SFTP conectada",
              `${profile.username}@${profile.host}:${profile.port}`,
            );
            return;
          } catch (error) {
            const message = getError(error);
            await disconnectSession(session.session_id).catch(() => undefined);
            const timeoutDetected = isTimeoutErrorMessage(message);
            const nextAttempt = currentAttempt + 1;
            const delaySeconds = Math.max(1, settings.sftp_reconnect_delay_seconds);
            const canRetry =
              timeoutDetected &&
              settings.auto_reconnect_enabled &&
              nextAttempt <= MAX_CONNECT_RETRY_ATTEMPTS;
            const retryLabel = canRetry
              ? `Nova tentativa em ${delaySeconds}s (${nextAttempt}/${MAX_CONNECT_RETRY_ATTEMPTS}).`
              : timeoutDetected
                ? `Limite de ${MAX_CONNECT_RETRY_ATTEMPTS} tentativas atingido.`
                : "Falha ao carregar diretorio inicial.";

            setBlocks((current) =>
              current.map((block) =>
                block.id === blockId && block.kind === "sftp"
                  ? {
                      ...block,
                      sourceId: "local",
                      entries: [],
                      loading: false,
                      pendingProfileId: profile.id,
                      connectStage: "error",
                      connectMessage: timeoutDetected
                        ? "Timeout na listagem inicial SFTP."
                        : "Falha ao carregar diretorio inicial.",
                      connectError: `${message} ${retryLabel}`.trim(),
                      hostChallenge: null,
                      retryAttempt: timeoutDetected ? nextAttempt : 0,
                      retryInSeconds: canRetry ? delaySeconds : null,
                    }
                  : block,
              ),
            );

            appendWorkspaceLog(
              timeoutDetected ? "warn" : "error",
              "Falha na listagem inicial SFTP",
              `${profile.username}@${profile.host}:${profile.port} | ${retryLabel}`,
            );

            if (canRetry) {
              scheduleBlockAutoRetry({
                blockId,
                kind: "sftp",
                delaySeconds,
                attempt: nextAttempt,
                onRetry: () => {
                  void resolvePendingSftpConnection(blockId, {
                    acceptUnknownHost,
                    passwordOverride,
                    saveAuthChoice,
                    retryAttempt: nextAttempt,
                  });
                },
              });
            }
            return;
          }
        }

        if (result.status === "unknown_host_challenge") {
          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "sftp"
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
                    loading: false,
                    retryAttempt: 0,
                    retryInSeconds: null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog(
            "warn",
            "Fingerprint SFTP requer confirmacao",
            `${result.host}:${result.port} ${result.fingerprint}`,
          );
          return;
        }

        if (result.status === "auth_required") {
          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "sftp"
                ? {
                    ...block,
                    connectStage: "awaiting_password",
                    connectMessage: "Login pendente.",
                    connectError: result.message,
                    hostChallenge: null,
                    loading: false,
                    retryAttempt: 0,
                    retryInSeconds: null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog(
            "warn",
            "Autenticacao SFTP pendente",
            `${profile.username}@${profile.host}:${profile.port}`,
          );
          return;
        }

        const timeoutDetected = isTimeoutErrorMessage(result.message);
        if (timeoutDetected) {
          const nextAttempt = currentAttempt + 1;
          const delaySeconds = Math.max(1, settings.sftp_reconnect_delay_seconds);
          const canRetry =
            settings.auto_reconnect_enabled && nextAttempt <= MAX_CONNECT_RETRY_ATTEMPTS;
          const retryLabel = canRetry
            ? `Nova tentativa em ${delaySeconds}s (${nextAttempt}/${MAX_CONNECT_RETRY_ATTEMPTS}).`
            : `Limite de ${MAX_CONNECT_RETRY_ATTEMPTS} tentativas atingido.`;

          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "sftp"
                ? {
                    ...block,
                    connectStage: "error",
                    connectMessage: "Timeout na conexao SFTP.",
                    connectError: `${result.message} ${retryLabel}`.trim(),
                    hostChallenge: null,
                    loading: false,
                    retryAttempt: nextAttempt,
                    retryInSeconds: canRetry ? delaySeconds : null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog(
            "warn",
            "Timeout ao conectar SFTP",
            `${profile.username}@${profile.host}:${profile.port} | ${retryLabel}`,
          );

          if (canRetry) {
            scheduleBlockAutoRetry({
              blockId,
              kind: "sftp",
              delaySeconds,
              attempt: nextAttempt,
              onRetry: () => {
                void resolvePendingSftpConnection(blockId, {
                  acceptUnknownHost,
                  passwordOverride,
                  saveAuthChoice,
                  retryAttempt: nextAttempt,
                });
              },
            });
          }
          return;
        }

        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "sftp"
              ? {
                  ...block,
                  connectStage: "error",
                  connectMessage: "Falha ao conectar SFTP.",
                  connectError: result.message,
                  hostChallenge: null,
                  loading: false,
                  retryAttempt: 0,
                  retryInSeconds: null,
                }
              : block,
          ),
        );
        appendWorkspaceLog("error", "Falha ao conectar SFTP", result.message);
      } catch (error) {
        const message = getError(error);
        const timeoutDetected = isTimeoutErrorMessage(message);
        if (timeoutDetected) {
          const nextAttempt = currentAttempt + 1;
          const delaySeconds = Math.max(1, settings.sftp_reconnect_delay_seconds);
          const canRetry =
            settings.auto_reconnect_enabled && nextAttempt <= MAX_CONNECT_RETRY_ATTEMPTS;
          const retryLabel = canRetry
            ? `Nova tentativa em ${delaySeconds}s (${nextAttempt}/${MAX_CONNECT_RETRY_ATTEMPTS}).`
            : `Limite de ${MAX_CONNECT_RETRY_ATTEMPTS} tentativas atingido.`;

          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "sftp"
                ? {
                    ...block,
                    connectStage: "error",
                    connectMessage: "Timeout na conexao SFTP.",
                    connectError: `${message} ${retryLabel}`.trim(),
                    hostChallenge: null,
                    loading: false,
                    retryAttempt: nextAttempt,
                    retryInSeconds: canRetry ? delaySeconds : null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog(
            "warn",
            "Timeout ao conectar SFTP",
            `${profile.username}@${profile.host}:${profile.port} | ${retryLabel}`,
          );

          if (canRetry) {
            scheduleBlockAutoRetry({
              blockId,
              kind: "sftp",
              delaySeconds,
              attempt: nextAttempt,
              onRetry: () => {
                void resolvePendingSftpConnection(blockId, {
                  acceptUnknownHost,
                  passwordOverride,
                  saveAuthChoice,
                  retryAttempt: nextAttempt,
                });
              },
            });
          }
          return;
        }

        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "sftp"
              ? {
                  ...block,
                  connectStage: "error",
                  connectMessage: "Falha ao conectar SFTP.",
                  connectError: message,
                  hostChallenge: null,
                  loading: false,
                  retryAttempt: 0,
                  retryInSeconds: null,
                }
              : block,
          ),
        );
        appendWorkspaceLog("error", "Erro ao conectar SFTP", message);
      }
    },
    [
      appendWorkspaceLog,
      clearBlockRetryTimers,
      connections,
      disconnectSession,
      scheduleBlockAutoRetry,
      settings.auto_reconnect_enabled,
      settings.sftp_reconnect_delay_seconds,
    ],
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
        retryAttempt: 0,
        retryInSeconds: null,
        layout: workspaceDefaultLayout("terminal", blocksRef.current.length, workspaceSize.width, workspaceSize.height),
        zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
        maximized: false,
      };
      setBlocks((current) => [...current, block]);
      appendWorkspaceLog("info", "Conexao SSH solicitada", `${profile.username}@${profile.host}:${profile.port}`);
      window.setTimeout(() => {
        void resolvePendingTerminalConnection(blockId);
      }, 0);
    },
    [appendWorkspaceLog, connections, resolvePendingTerminalConnection, workspaceSize.height, workspaceSize.width],
  );

  const addPendingSftpBlock = useCallback(
    (profileId: string) => {
      const profile = connections.find((item) => item.id === profileId);
      if (!profile) {
        toast.error("Host nao encontrado para abrir o SFTP.");
        return;
      }

      const host = profile.host || profileId.slice(0, 8);
      const baseTitle = `SFTP - ${host}`;
      const count = blocksRef.current.filter((item) => item.kind === "sftp" && item.title.startsWith(baseTitle)).length;
      const blockId = createId("sftp");
      const initialPath = profile.remote_path?.trim()
        ? normalizeRemotePath(profile.remote_path)
        : normalizeRemotePath("/");

      const block: SftpBlock = {
        id: blockId,
        kind: "sftp",
        title: count > 0 ? `${baseTitle} (${count + 1})` : baseTitle,
        sourceId: "local",
        path: initialPath,
        entries: [],
        loading: false,
        selectedPath: null,
        sortKey: "name",
        sortDirection: "asc",
        pathHistory: [initialPath],
        pendingProfileId: profileId,
        connectStage: "connecting",
        connectMessage: "Conectando...",
        connectError: null,
        hostChallenge: null,
        passwordDraft: "",
        savePasswordChoice: false,
        acceptUnknownHost: false,
        retryAttempt: 0,
        retryInSeconds: null,
        layout: workspaceDefaultLayout("sftp", blocksRef.current.length, workspaceSize.width, workspaceSize.height),
        zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
        maximized: false,
      };
      setBlocks((current) => [...current, block]);
      appendWorkspaceLog("info", "Conexao SFTP solicitada", `${profile.username}@${profile.host}:${profile.port}`);
      window.setTimeout(() => {
        void resolvePendingSftpConnection(blockId);
      }, 0);
    },
    [appendWorkspaceLog, connections, resolvePendingSftpConnection, workspaceSize.height, workspaceSize.width],
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
      const profileId = parseProfileSourceId(initialSourceId);
      if (profileId) {
        addPendingSftpBlock(profileId);
        return;
      }
      addSftpBlock(initialSourceId ?? "local");
    }
  }, [addPendingSftpBlock, addPendingTerminalBlock, addSftpBlock, addTerminalBlock, initialBlock, initialSourceId]);

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
          await executeTransfer({
            fromSourceId: block.sourceId,
            fromPath: entry.path,
            toSourceId: "local",
            toPath: destination,
            sourceBlockId: block.id,
            targetBlockId: null,
          });
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
      if (createBlockKind === "logs") {
        addLogsBlock();
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
      } else if (createSourceDraft.startsWith("profile:") && createBlockKind === "sftp") {
        const profileId = createSourceDraft.replace("profile:", "");
        addPendingSftpBlock(profileId);
        setCreateBlockModalOpen(false);
        return;
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
    addLogsBlock,
    addPendingSftpBlock,
    addPendingTerminalBlock,
    addSftpBlock,
    addTerminalBlock,
    connectLocalTerminal,
    createBlockKind,
    createSourceDraft,
    openFile,
  ]);

  useEffect(() => {
    if (!createBlockModalOpen) {
      return;
    }
    if (createBlockKind === "editor" || createBlockKind === "logs") {
      return;
    }
    if (!createSourceOptions.some((item) => item.id === createSourceDraft)) {
      setCreateSourceDraft("local");
    }
  }, [createBlockKind, createBlockModalOpen, createSourceDraft, createSourceOptions]);

  const transferItemsByBlock = useMemo(() => {
    const map = new Map<string, BlockTransferItem[]>();
    for (const transfer of transfers) {
      if (transfer.sourceBlockId) {
        const list = map.get(transfer.sourceBlockId) ?? [];
        list.push({ transfer, direction: "outgoing" });
        map.set(transfer.sourceBlockId, list);
      }
      if (transfer.targetBlockId) {
        const list = map.get(transfer.targetBlockId) ?? [];
        list.push({ transfer, direction: "incoming" });
        map.set(transfer.targetBlockId, list);
      }
    }
    map.forEach((items, key) => {
      map.set(
        key,
        items.sort((left, right) => right.transfer.updatedAt - left.transfer.updatedAt).slice(0, 40),
      );
    });
    return map;
  }, [transfers]);

  const renderedBlocks = useMemo(
    () =>
      blocks.map((block) => ({
        block,
        layout: block.maximized
          ? { x: 0, y: 0, width: workspaceSize.width, height: workspaceSize.height }
          : block.layout,
        interactive: !block.maximized,
      })),
    [blocks, workspaceSize.height, workspaceSize.width],
  );

  const activeTransfers = transfers.filter((item) => item.status === "running").length;

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

        <div className="flex h-7 items-center gap-1 rounded border border-purple-400/60 bg-purple-600/20 px-2 text-xs text-purple-200">
          <Columns2 className="h-3.5 w-3.5" /> Livre
        </div>
        <button
          type="button"
          className="flex h-7 items-center gap-1 rounded border border-white/10 px-2 text-xs text-zinc-300 transition hover:border-white/20 hover:bg-zinc-900"
          onClick={() => addLogsBlock()}
        >
          <FileText className="h-3.5 w-3.5" /> Logs
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
                <button
                  type="button"
                  className="flex h-8 items-center gap-2 rounded border border-white/15 px-3 text-xs text-zinc-200 hover:bg-zinc-900"
                  onClick={() => addLogsBlock()}
                >
                  <MonitorUp className="h-3.5 w-3.5" /> Logs
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
            minWidth={block.kind === "terminal" ? 420 : block.kind === "logs" ? 460 : 360}
            minHeight={block.kind === "terminal" ? 260 : block.kind === "logs" ? 220 : 240}
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
                            retryAttempt: 0,
                            retryInSeconds: null,
                          }
                        : item,
                    ),
                  );
                  void ensureSessionListeners(nextSessionId);
                }}
                ensureSessionListeners={ensureSessionListeners}
                sshWrite={sshWrite}
                onTrustHost={() => {
                  clearBlockRetryTimers(block.id);
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "terminal"
                        ? { ...item, acceptUnknownHost: true, retryAttempt: 0, retryInSeconds: null }
                        : item,
                    ),
                  );
                  void resolvePendingTerminalConnection(block.id, { acceptUnknownHost: true, retryAttempt: 0 });
                }}
                onRetry={() => {
                  if (!block.pendingProfileId) {
                    return;
                  }
                  clearBlockRetryTimers(block.id);
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "terminal"
                        ? { ...item, retryAttempt: 0, retryInSeconds: null }
                        : item,
                    ),
                  );
                  void resolvePendingTerminalConnection(block.id, {
                    acceptUnknownHost: block.acceptUnknownHost,
                    retryAttempt: 0,
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
                    retryAttempt: 0,
                  });
                }}
              />
            ) : null}

            {block.kind === "sftp" ? (
              <SftpBlockView
                block={block}
                sourceOptions={sourceOptions}
                transferItems={transferItemsByBlock.get(block.id) ?? []}
                onFocus={() => focusBlock(block.id)}
                onRefresh={(path, sourceId) => {
                  if (block.pendingProfileId) {
                    clearBlockRetryTimers(block.id);
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "sftp"
                          ? { ...item, retryAttempt: 0, retryInSeconds: null, path }
                          : item,
                      ),
                    );
                    void resolvePendingSftpConnection(block.id, { retryAttempt: 0 });
                    return;
                  }
                  void refreshSftpBlock(block.id, path, sourceId);
                }}
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
                onTrustHost={() => {
                  clearBlockRetryTimers(block.id);
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "sftp"
                        ? { ...item, acceptUnknownHost: true, retryAttempt: 0, retryInSeconds: null }
                        : item,
                    ),
                  );
                  void resolvePendingSftpConnection(block.id, { acceptUnknownHost: true, retryAttempt: 0 });
                }}
                onRetry={() => {
                  if (!block.pendingProfileId) {
                    return;
                  }
                  clearBlockRetryTimers(block.id);
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "sftp"
                        ? { ...item, retryAttempt: 0, retryInSeconds: null }
                        : item,
                    ),
                  );
                  void resolvePendingSftpConnection(block.id, {
                    acceptUnknownHost: block.acceptUnknownHost,
                    retryAttempt: 0,
                  });
                }}
                onPasswordDraftChange={(value) => {
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "sftp"
                        ? { ...item, passwordDraft: value }
                        : item,
                    ),
                  );
                }}
                onSavePasswordChange={(checked) => {
                  setBlocks((current) =>
                    current.map((item) =>
                      item.id === block.id && item.kind === "sftp"
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
                        item.id === block.id && item.kind === "sftp"
                          ? { ...item, connectError: "Informe a senha para continuar." }
                          : item,
                      ),
                    );
                    return;
                  }
                  clearBlockRetryTimers(block.id);
                  void resolvePendingSftpConnection(block.id, {
                    acceptUnknownHost: block.acceptUnknownHost,
                    passwordOverride: password,
                    saveAuthChoice: block.savePasswordChoice,
                    retryAttempt: 0,
                  });
                }}
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

            {block.kind === "logs" ? (
              <LogsBlockView
                entries={workspaceLogs}
                onClear={() => setWorkspaceLogs([])}
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
          <div className="grid grid-cols-4 gap-2">
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
            <button
              type="button"
              className={cn(
                "rounded border p-2 text-xs transition",
                createBlockKind === "logs"
                  ? "border-purple-400/60 bg-purple-600/20 text-purple-100"
                  : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-purple-400/40",
              )}
              onClick={() => setCreateBlockKind("logs")}
            >
              <MonitorUp className="mx-auto h-4 w-4" />
              <p className="mt-1">Logs</p>
            </button>
          </div>

          {createBlockKind === "terminal" || createBlockKind === "sftp" ? (
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
          ) : createBlockKind === "editor" ? (
            <p className="text-xs text-zinc-500">O editor abre arquivo local selecionado pelo sistema.</p>
          ) : (
            <p className="text-xs text-zinc-500">O bloco de logs mostra eventos e progresso do workspace.</p>
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
    void sshWrite(sessionId, "");

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

                {block.retryInSeconds !== null ? (
                  <p className="mt-3 text-xs text-amber-300">Timeout detectado. Nova tentativa em {block.retryInSeconds}s...</p>
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
  transferItems: BlockTransferItem[];
  onFocus: () => void;
  onRefresh: (path: string, sourceId: string) => void;
  onSelectSort: (sortKey: SortKey) => void;
  onSelectEntry: (path: string) => void;
  onOpenEntry: (entry: SftpEntry) => void;
  onDropTransfer: (payload: DragPayload, targetPath: string) => void;
  onContextAction: (action: SftpContextAction, entry: SftpEntry | null) => void;
  onTrustHost: () => void;
  onRetry: () => void;
  onPasswordDraftChange: (value: string) => void;
  onSavePasswordChange: (checked: boolean) => void;
  onSubmitPassword: () => void;
}

function SftpBlockView({
  block,
  sourceOptions,
  transferItems,
  onFocus,
  onRefresh,
  onSelectSort,
  onSelectEntry,
  onOpenEntry,
  onDropTransfer,
  onContextAction,
  onTrustHost,
  onRetry,
  onPasswordDraftChange,
  onSavePasswordChange,
  onSubmitPassword,
}: SftpBlockViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const transferMenuRef = useRef<HTMLDivElement | null>(null);
  const transferToggleRef = useRef<HTMLButtonElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(1200);
  const [contextMenu, setContextMenu] = useState<SftpContextMenuState | null>(null);
  const [transferMenuOpen, setTransferMenuOpen] = useState(false);
  const [transferMenuRect, setTransferMenuRect] = useState<{ left: number; top: number } | null>(null);
  const sortedEntries = useMemo(
    () => sortSftpEntries(block.entries, block.sortKey, block.sortDirection),
    [block.entries, block.sortDirection, block.sortKey],
  );
  const parentEntry = useMemo(() => {
    const parentPath = parentPathBySource(block.sourceId, block.path);
    if (!parentPath) {
      return null;
    }
    const entry: SftpEntry = {
      name: "..",
      path: parentPath,
      is_dir: true,
      size: 0,
      permissions: null,
      modified_at: null,
    };
    return entry;
  }, [block.path, block.sourceId]);
  const displayEntries = useMemo(
    () => (parentEntry ? [parentEntry, ...sortedEntries] : sortedEntries),
    [parentEntry, sortedEntries],
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
    if (!contextMenu || !contextMenuRef.current) {
      return;
    }
    const menu = contextMenuRef.current;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const clampedX = Math.max(margin, Math.min(contextMenu.pointerX, window.innerWidth - rect.width - margin));
    const clampedY = Math.max(margin, Math.min(contextMenu.pointerY, window.innerHeight - rect.height - margin));
    if (Math.round(clampedX) === Math.round(contextMenu.x) && Math.round(clampedY) === Math.round(contextMenu.y)) {
      return;
    }
    setContextMenu((current) => {
      if (!current) {
        return current;
      }
      return { ...current, x: clampedX, y: clampedY };
    });
  }, [contextMenu]);

  useEffect(() => {
    if (!transferMenuOpen) {
      return;
    }

    const handlePointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (transferMenuRef.current?.contains(target) || transferToggleRef.current?.contains(target)) {
        return;
      }
      setTransferMenuOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTransferMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [transferMenuOpen]);

  useEffect(() => {
    if (!transferMenuOpen) {
      setTransferMenuRect(null);
      return;
    }

    const updatePosition = () => {
      const anchor = transferToggleRef.current;
      if (!anchor) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const width = 384;
      const margin = 8;
      const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
      const top = Math.min(rect.bottom + 8, window.innerHeight - 220);
      setTransferMenuRect({ left, top });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [transferMenuOpen]);

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
      const payload: DragPayload = {
        sourceBlockId: block.id,
        sourceId: block.sourceId,
        path: entry.path,
        isDir: entry.is_dir,
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
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        pointerX: event.clientX,
        pointerY: event.clientY,
        entry,
      });
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

  const runningTransfers = useMemo(
    () => transferItems.filter((item) => item.transfer.status === "running").length,
    [transferItems],
  );
  const isConnected = block.connectStage === "ready" && !block.pendingProfileId;

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
      className="relative flex h-full min-h-0 flex-col"
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
          disabled={!isConnected}
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
            disabled={!isConnected}
          />
          <datalist id={pathListId}>
            {block.pathHistory.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
        </div>

        <div className="relative flex items-center justify-end gap-1">
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded border border-white/10 text-zinc-300 hover:border-purple-400/60 hover:bg-zinc-900"
            onClick={() => onRefresh(pathDraft, block.sourceId)}
            disabled={!isConnected}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", block.loading ? "animate-spin" : undefined)} />
          </button>
          <button
            ref={transferToggleRef}
            type="button"
            className={cn(
              "relative inline-flex h-8 w-8 items-center justify-center rounded border text-zinc-300",
              runningTransfers > 0
                ? "border-cyan-400/50 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
                : "border-white/10 hover:border-purple-400/60 hover:bg-zinc-900",
            )}
            onClick={() => setTransferMenuOpen((current) => !current)}
            title="Transferencias deste bloco"
            disabled={!isConnected}
          >
            <MonitorUp className={cn("h-3.5 w-3.5", runningTransfers > 0 ? "animate-pulse" : undefined)} />
            {runningTransfers > 0 ? (
              <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500 px-1 text-[10px] font-semibold text-zinc-950">
                {runningTransfers}
              </span>
            ) : null}
          </button>
        </div>
      </div>
      {transferMenuOpen && transferMenuRect
        ? createPortal(
            <div
              ref={transferMenuRef}
              className="fixed z-[12000] w-96 max-w-[78vw] rounded border border-white/15 bg-zinc-950/95 p-2 shadow-2xl shadow-black/40 backdrop-blur"
              style={{ left: transferMenuRect.left, top: transferMenuRect.top }}
            >
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                Transferencias do bloco
              </p>
              {transferItems.length === 0 ? (
                <p className="rounded border border-white/10 bg-zinc-900/60 px-2 py-2 text-xs text-zinc-500">
                  Nenhuma transferencia registrada neste bloco.
                </p>
              ) : (
                <div className="max-h-64 space-y-1 overflow-auto pr-1">
                  {transferItems.map((item) => {
                    const statusColor =
                      item.transfer.status === "error"
                        ? "text-red-300"
                        : item.transfer.status === "completed"
                          ? "text-emerald-300"
                          : "text-cyan-200";
                    const barColor =
                      item.transfer.status === "error"
                        ? "bg-red-500/70"
                        : item.transfer.status === "completed"
                          ? "bg-emerald-500/80"
                          : "bg-cyan-500/80";

                    return (
                      <div key={`${item.direction}:${item.transfer.id}`} className="rounded border border-white/10 bg-zinc-900/60 p-2">
                        <div className="flex items-center gap-2">
                          {item.direction === "outgoing" ? (
                            <ArrowUpAZ className="h-3.5 w-3.5 text-cyan-300" />
                          ) : (
                            <ArrowDownAZ className="h-3.5 w-3.5 text-emerald-300" />
                          )}
                          <p className="min-w-0 flex-1 truncate text-xs text-zinc-100">{item.transfer.label}</p>
                          <span className={cn("text-[11px] font-medium", statusColor)}>
                            {item.transfer.status === "running"
                              ? `${item.transfer.progress}%`
                              : item.transfer.status === "completed"
                                ? "Concluido"
                                : "Erro"}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded bg-white/10">
                          <div
                            className={cn("h-full transition-all", barColor)}
                            style={{ width: `${Math.max(2, Math.min(100, item.transfer.progress))}%` }}
                          />
                        </div>
                        <p className="mt-1 truncate text-[11px] text-zinc-500">{item.transfer.from}</p>
                        <p className="truncate text-[11px] text-zinc-500">{item.transfer.to}</p>
                        {item.transfer.errorMessage ? (
                          <p className="mt-1 text-[11px] text-red-300">{item.transfer.errorMessage}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}

      <div className={cn("min-h-0 flex-1 overflow-auto", !isConnected ? "opacity-40" : undefined)}>
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
            {displayEntries.map((entry) => {
              const selected = block.selectedPath === entry.path;
              return (
                <tr
                  key={entry.path}
                  className={cn(
                    "border-b border-white/5 text-zinc-200 transition hover:bg-zinc-900/70",
                    "cursor-grab active:cursor-grabbing",
                    selected ? "bg-purple-600/10" : undefined,
                  )}
                  draggable
                  onClick={() => onSelectEntry(entry.path)}
                  onDoubleClick={() => onOpenEntry(entry)}
                  onContextMenu={(event) => {
                    if (entry.name === "..") {
                      return;
                    }
                    openContextMenu(event, entry);
                  }}
                  onDragStart={(event) => {
                    if (entry.name === "..") {
                      event.preventDefault();
                      return;
                    }
                    handleEntryDragStart(event, entry);
                  }}
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
                      {entry.name === ".." ? (
                        <Folder className="h-3.5 w-3.5 text-cyan-300" />
                      ) : entry.is_dir ? (
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
            {displayEntries.length === 0 ? (
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
      {!isConnected ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/80 p-3">
          <div className="w-full max-w-md rounded-lg border border-white/15 bg-zinc-950/95 p-4 shadow-2xl shadow-black/50">
            <div className="inline-flex items-center gap-2 text-sm text-zinc-100">
              {block.connectStage === "connecting" ? (
                <RefreshCw className="h-4 w-4 animate-spin text-cyan-300" />
              ) : (
                <Folder className="h-4 w-4 text-cyan-300" />
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
                  placeholder="Senha SSH/SFTP"
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

            {block.retryInSeconds !== null ? (
              <p className="mt-3 text-xs text-amber-300">Timeout detectado. Nova tentativa em {block.retryInSeconds}s...</p>
            ) : null}

            {block.connectError ? (
              <p className="mt-3 text-xs text-red-300">{block.connectError}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {contextMenu
        ? createPortal(
            <div
              className="fixed inset-0 z-[12000]"
              onMouseDown={() => setContextMenu(null)}
              onContextMenu={(event) => event.preventDefault()}
            >
              <div
                ref={contextMenuRef}
                className="absolute z-[12001] w-56 rounded border border-white/15 bg-zinc-950/95 p-1 shadow-2xl shadow-black/40 backdrop-blur"
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

interface EditorBlockViewProps {
  block: EditorBlock;
  onChange: (value: string) => void;
  onSave: () => void;
  onOpenExternal: () => void;
}

interface LogsBlockViewProps {
  entries: WorkspaceLogEntry[];
  onClear: () => void;
}

function LogsBlockView({ entries, onClear }: LogsBlockViewProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [followTail, setFollowTail] = useState(true);

  useEffect(() => {
    if (!followTail) {
      return;
    }
    const host = listRef.current;
    if (!host) {
      return;
    }
    host.scrollTop = host.scrollHeight;
  }, [entries, followTail]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex h-9 items-center justify-between border-b border-white/10 px-2">
        <p className="text-xs text-zinc-300">Eventos do workspace ({entries.length})</p>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
            <input type="checkbox" checked={followTail} onChange={(event) => setFollowTail(event.target.checked)} />
            Seguir
          </label>
          <button
            type="button"
            className="rounded border border-white/15 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
            onClick={onClear}
          >
            Limpar
          </button>
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px]">
        {entries.length === 0 ? (
          <p className="text-zinc-500">Nenhum log registrado neste workspace.</p>
        ) : (
          <div className="space-y-1">
            {entries.map((entry) => (
              <div key={entry.id} className="rounded border border-white/10 bg-zinc-900/60 px-2 py-1">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    className={cn(
                      "uppercase",
                      entry.level === "error"
                        ? "text-red-300"
                        : entry.level === "warn"
                          ? "text-amber-300"
                          : entry.level === "success"
                            ? "text-emerald-300"
                            : "text-cyan-300",
                    )}
                  >
                    [{entry.level}]
                  </span>
                  <span className="truncate text-zinc-100">{entry.message}</span>
                </div>
                {entry.details ? <p className="mt-0.5 break-all text-zinc-400">{entry.details}</p> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EditorBlockView({ block, onChange, onSave, onOpenExternal }: EditorBlockViewProps) {
  const canSave = block.view === "text" && !block.loading;
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
      {block.view === "text" && (block.loading || block.loadError) ? (
        <div className="border-b border-white/10 px-3 py-2">
          {block.loading ? (
            <>
              <p className="text-[11px] text-cyan-200">Carregando arquivo por streaming... {block.loadProgress}%</p>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-white/10">
                <div
                  className="h-full bg-cyan-500/80 transition-all"
                  style={{ width: `${Math.max(2, Math.min(100, block.loadProgress))}%` }}
                />
              </div>
            </>
          ) : null}
          {block.loadError ? <p className="text-[11px] text-red-300">{block.loadError}</p> : null}
        </div>
      ) : null}
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
              readOnly: block.loading,
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
