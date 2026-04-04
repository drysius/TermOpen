import { Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FileText,
  Folder,
  HardDrive,
  Maximize2,
  Minimize2,
  Monitor,
  Plus,
  Search,
  Server,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { WorkspaceBlockController, type WorkspaceBlockLayout } from "@/components/workspace/workspace-block-controller";
import { AppDialog } from "@/components/ui/app-dialog";
import { baseName, getError, joinPath, joinRemotePath, normalizeRemotePath, supportsProtocol } from "@/functions/common";
import {
  detectEditorFileMeta,
  formatBytes,
} from "@/functions/editor-file-utils";
import { useT } from "@/langs";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import type {
  ClipboardLocalItem,
  ConnectionProfile,
  ConnectionProtocol,
  KeyActionsActiveTargetInput,
  KeyActionsStatusPayload,
  RemoteTransferEndpoint,
  RdpSessionControlEvent,
  SurfaceRect,
  SftpEntry,
} from "@/types/openptl";
import editorWorkspace from "@/pages/tabs/workspace/editor";
import rdpWorkspace from "@/pages/tabs/workspace/rdp";
import sftpWorkspace from "@/pages/tabs/workspace/sftp";
import terminalWorkspace from "@/pages/tabs/workspace/terminal";
import type {
  BlockTransferItem,
  DragPayload,
  EditorBlock,
  RdpBlock,
  SftpBlock,
  SftpContextAction,
  TerminalBlock,
  TransferItem,
  WorkspaceBlock,
  WorkspaceKind,
  WorkspaceLogEntry,
  WorkspaceLogLevel,
  WorkspaceMode,
  WorkspaceTabPageProps,
} from "@/pages/tabs/workspace/types";
import { snapLayoutToWorkspace, workspaceDefaultLayout } from "@/pages/tabs/workspace/natives/layout";
import { joinPathBySource, joinRelativePathBySource, normalizeAnyPath, parentDirectory, shellQuote } from "@/pages/tabs/workspace/natives/paths";
import {
  emitRdpAudio,
  emitRdpCursor,
  emitRdpVideoRects,
  parseRdpAudioPacket,
  parseRdpCursorPacket,
  parseRdpVideoRectsPacket,
} from "@/pages/tabs/workspace/natives/rdp-stream";
import { createSourceFile, createSourceFolder, decodeBase64Chunk, deleteSourceEntry, listSourceEntries, readSourceBinaryPreview, readSourceFile, readSourceTextChunk, renameSourceEntry, writeSourceFile } from "@/pages/tabs/workspace/natives/source-io";
import {
  createId,
  formatProfileSourceId,
  isTimeoutErrorMessage,
  MAX_CONNECT_RETRY_ATTEMPTS,
  parseProfileSourceId,
  parseProfileSourceRef,
} from "@/pages/tabs/workspace/natives/runtime";

const workspaceModules = {
  terminal: terminalWorkspace,
  sftp: sftpWorkspace,
  rdp: rdpWorkspace,
  editor: editorWorkspace,
} as const;
const SFTP_DROP_TARGET_SELECTOR = "[data-openptl-drop-target='sftp']";

type SftpCreateDialogMode = "mkdir" | "mkfile";

type SftpCreateDialogState = {
  mode: SftpCreateDialogMode;
  blockId: string;
  sourceId: string;
  basePath: string;
  value: string;
  busy: boolean;
};

type ExternalDropKind = "file" | "folder" | "mixed" | "unknown";

type ExternalDropPreview = {
  mode: "external" | "internal";
  blockId: string;
  targetPath: string;
  kind: ExternalDropKind;
  count: number;
};

type InternalEntryDragState = {
  payload: DragPayload;
  startX: number;
  startY: number;
  cursorX: number;
  cursorY: number;
  active: boolean;
  targetBlockId: string | null;
  targetPath: string | null;
};

type TerminalCaptureContext = {
  surface_rect: SurfaceRect;
  dpi_scale: number;
  cols: number;
  rows: number;
};

function areSurfaceRectsEqual(left: SurfaceRect | null | undefined, right: SurfaceRect | null | undefined): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function areTerminalCaptureContextsEqual(
  left: TerminalCaptureContext | null | undefined,
  right: TerminalCaptureContext | null | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    areSurfaceRectsEqual(left.surface_rect, right.surface_rect) &&
    left.dpi_scale === right.dpi_scale &&
    left.cols === right.cols &&
    left.rows === right.rows
  );
}

function areKeyActionStatusesEqual(
  left: KeyActionsStatusPayload | null,
  right: KeyActionsStatusPayload | null,
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.status === right.status &&
    left.reason === right.reason &&
    left.platform === right.platform &&
    left.details === right.details
  );
}

function profileProtocols(profile: { protocols?: string[]; kind?: string | null }): string[] {
  if (Array.isArray(profile.protocols) && profile.protocols.length > 0) {
    return profile.protocols;
  }
  if (profile.kind === "host") {
    return ["ssh"];
  }
  if (profile.kind === "sftp") {
    return ["sftp"];
  }
  if (profile.kind === "rdp") {
    return ["rdp"];
  }
  return ["ssh", "sftp"];
}

function supportsExactProfileProtocol(
  profile: { protocols?: string[]; kind?: string | null },
  protocol: "ssh" | "sftp" | "ftp" | "ftps" | "smb" | "rdp",
): boolean {
  return profileProtocols(profile).includes(protocol);
}

function primaryProfileProtocol(profile: { protocols?: string[]; kind?: string | null }): ConnectionProtocol {
  const protocols = profileProtocols(profile);
  if (protocols.includes("rdp")) {
    return "rdp";
  }
  if (protocols.includes("sftp")) {
    return "sftp";
  }
  if (protocols.includes("ftp")) {
    return "ftp";
  }
  if (protocols.includes("ftps")) {
    return "ftps";
  }
  if (protocols.includes("smb")) {
    return "smb";
  }
  return "ssh";
}

function resolveWorkspaceFileProtocol(
  profile: { protocols?: string[]; kind?: string | null },
): "sftp" | "ftp" | "ftps" | "smb" | null {
  const protocols = profileProtocols(profile);
  if (protocols.includes("sftp")) {
    return "sftp";
  }
  if (protocols.includes("ftp")) {
    return "ftp";
  }
  if (protocols.includes("ftps")) {
    return "ftps";
  }
  if (protocols.includes("smb")) {
    return "smb";
  }
  return null;
}

const connectionProtocolIcon: Record<ConnectionProtocol, typeof Monitor> = {
  ssh: Monitor,
  sftp: Server,
  ftp: Server,
  ftps: Server,
  smb: HardDrive,
  rdp: Monitor,
};

const connectionProtocolColor: Record<ConnectionProtocol, string> = {
  ssh: "bg-primary/15 text-primary",
  sftp: "bg-info/15 text-info",
  ftp: "bg-success/15 text-success",
  ftps: "bg-success/15 text-success",
  smb: "bg-warning/15 text-warning",
  rdp: "bg-destructive/15 text-destructive",
};

export function WorkspaceTabPage({ tabId, initialBlock, initialSourceId, initialOpenFiles = false }: WorkspaceTabPageProps) {
  const t = useT();
  const sessions = useAppStore((state) => state.sessions);
  const connections = useAppStore((state) => state.connections);
  const settings = useAppStore((state) => state.settings);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const sshWrite = useAppStore((state) => state.sshWrite);
  const ensureSessionListeners = useAppStore((state) => state.ensureSessionListeners);
  const disconnectSession = useAppStore((state) => state.disconnectSession);
  const setWorkspaceSessions = useAppStore((state) => state.setWorkspaceSessions);
  const setWorkspaceBlockCount = useAppStore((state) => state.setWorkspaceBlockCount);
  const setWorkspaceSnapshot = useAppStore((state) => state.setWorkspaceSnapshot);
  const workspaceSnapshot = useAppStore((state) => state.workspaceSnapshotsByTab[tabId]);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const blocksRef = useRef<WorkspaceBlock[]>([]);
  const initialBlocks =
    workspaceSnapshot?.workspaceMode === "free" && Array.isArray(workspaceSnapshot.blocks)
      ? (workspaceSnapshot.blocks as WorkspaceBlock[])
          .filter((item) => (item as { kind?: string }).kind !== "logs")
          .map((item) => ({
            ...item,
            minimized: Boolean((item as { minimized?: boolean }).minimized),
          }))
      : [];
  const initialLogs = Array.isArray(workspaceSnapshot?.logs)
    ? (workspaceSnapshot.logs as WorkspaceLogEntry[])
    : [];
  const initializedRef = useRef(initialBlocks.length > 0);

  const [workspaceMode] = useState<WorkspaceMode>("free");
  const [workspaceSize, setWorkspaceSize] = useState({ width: 1200, height: 740 });
  const [blocks, setBlocks] = useState<WorkspaceBlock[]>(initialBlocks);
  const [workspaceLogs, setWorkspaceLogs] = useState<WorkspaceLogEntry[]>(initialLogs);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [createBlockModalOpen, setCreateBlockModalOpen] = useState(false);
  const [selectConnectionDialogOpen, setSelectConnectionDialogOpen] = useState(false);
  const [selectConnectionSearch, setSelectConnectionSearch] = useState("");
  const [createBlockKind, setCreateBlockKind] = useState<"terminal" | "sftp" | "rdp" | "editor">("terminal");
  const [createSourceDraft, setCreateSourceDraft] = useState("local");
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(
    initialBlocks.find((item) => !item.minimized)?.id ?? initialBlocks[0]?.id ?? null,
  );
  const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null);
  const [snapPreview, setSnapPreview] = useState<WorkspaceBlockLayout | null>(null);
  const [keyActionsStatus, setKeyActionsStatus] = useState<KeyActionsStatusPayload | null>(null);
  const [captureContextVersion, setCaptureContextVersion] = useState(0);
  const [sftpCreateDialog, setSftpCreateDialog] = useState<SftpCreateDialogState | null>(null);
  const [externalDropPreview, setExternalDropPreview] = useState<ExternalDropPreview | null>(null);
  const [internalEntryDrag, setInternalEntryDrag] = useState<InternalEntryDragState | null>(null);
  const connectRetryTimersRef = useRef<Record<string, { retryTimer: number; countdownTimer: number }>>({});
  const rdpStreamSessionByBlockRef = useRef<Map<string, string>>(new Map());
  const rdpStreamTokenByBlockRef = useRef<Map<string, string>>(new Map());
  const rdpLastFrameAtByBlockRef = useRef<Map<string, number>>(new Map());
  const rdpSurfaceRectByBlockRef = useRef<Map<string, SurfaceRect>>(new Map());
  const terminalCaptureByBlockRef = useRef<Map<string, TerminalCaptureContext>>(new Map());
  const lastPublishedKeyActionsTargetRef = useRef<string | null>(null);
  const lastExternalFileDropSignatureRef = useRef<{ signature: string; at: number } | null>(null);
  const lastExternalDropTargetRef = useRef<{ blockId: string; targetPath: string; at: number } | null>(null);
  const lastExternalDropPathsRef = useRef<string[]>([]);
  const lastExternalDropKindRef = useRef<{
    signature: string;
    kind: ExternalDropKind;
    count: number;
    at: number;
  } | null>(null);
  const internalEntryDragRef = useRef<InternalEntryDragState | null>(null);

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
      kind: "terminal" | "sftp" | "rdp";
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
    internalEntryDragRef.current = internalEntryDrag;
  }, [internalEntryDrag]);

  useEffect(() => {
    if (blocks.length === 0) {
      if (focusedBlockId !== null) {
        setFocusedBlockId(null);
      }
      return;
    }

    const focusedBlock = focusedBlockId ? blocks.find((block) => block.id === focusedBlockId) : null;
    if (focusedBlock && !focusedBlock.minimized) {
      return;
    }

    const topVisibleBlock = [...blocks]
      .filter((block) => !block.minimized)
      .sort((left, right) => right.zIndex - left.zIndex)[0];
    if (topVisibleBlock) {
      setFocusedBlockId(topVisibleBlock.id);
      return;
    }

    const topBlock = [...blocks].sort((left, right) => right.zIndex - left.zIndex)[0];
    setFocusedBlockId(topBlock?.id ?? null);
  }, [blocks, focusedBlockId]);

  useEffect(() => {
    setWorkspaceSnapshot(tabId, { blocks, workspaceMode, logs: workspaceLogs });
  }, [blocks, setWorkspaceSnapshot, tabId, workspaceLogs, workspaceMode]);

  useEffect(() => {
    const sessionIds = Array.from(
      new Set(
        blocks
          .flatMap((block) => {
            if (block.kind === "terminal" && block.sessionId) {
              return [block.sessionId];
            }
            if (block.kind === "sftp" && block.sourceId !== "local") {
              if (!parseProfileSourceRef(block.sourceId)) {
                return [block.sourceId];
              }
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

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<KeyActionsStatusPayload>("key_actions:status", (event) => {
      if (!disposed) {
        const next = event.payload ?? null;
        setKeyActionsStatus((current) => (areKeyActionStatusesEqual(current, next) ? current : next));
      }
    })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const captureUnavailableMessage = useMemo(() => {
    if (!keyActionsStatus || keyActionsStatus.status !== "disabled") {
      return null;
    }
    if (keyActionsStatus.reason === "wayland_not_supported") {
      return t.workspace.captureDisabledWayland;
    }
    if (keyActionsStatus.reason === "macos_accessibility_required") {
      return t.workspace.captureDisabledPermission;
    }
    return t.workspace.captureDisabledGeneric;
  }, [
    keyActionsStatus,
    t.workspace.captureDisabledGeneric,
    t.workspace.captureDisabledPermission,
    t.workspace.captureDisabledWayland,
  ]);

  const publishKeyActionsTarget = useCallback(() => {
    const isTabActive = activeTabId === tabId;
    if (!isTabActive) {
      if (activeTabId === null) {
        const serialized = "null";
        if (lastPublishedKeyActionsTargetRef.current !== serialized) {
          lastPublishedKeyActionsTargetRef.current = serialized;
          void api.keyActionsSetActiveWorkspace(null).catch(() => undefined);
        }
      }
      return;
    }

    let target: KeyActionsActiveTargetInput | null = null;
    const focused = focusedBlockId
      ? blocksRef.current.find((block) => block.id === focusedBlockId) ?? null
      : null;

    if (focused?.kind === "rdp" && focused.sessionId && focused.connectStage === "ready") {
      const surface = rdpSurfaceRectByBlockRef.current.get(focused.id);
      if (surface && focused.imageWidth > 0 && focused.imageHeight > 0) {
        const sessionId = rdpStreamSessionByBlockRef.current.get(focused.id) ?? focused.sessionId;
        if (sessionId) {
          target = {
            kind: "rdp",
            session_id: sessionId,
            tab_id: tabId,
            block_id: focused.id,
            surface_rect: surface,
            dpi_scale: window.devicePixelRatio || 1,
            remote_width: focused.imageWidth,
            remote_height: focused.imageHeight,
          };
        }
      }
    } else if (
      focused?.kind === "terminal" &&
      focused.sessionId &&
      focused.connectStage === "ready"
    ) {
      const hasLiveSession = sessions.some((item) => item.session_id === focused.sessionId);
      const capture = terminalCaptureByBlockRef.current.get(focused.id);
      if (hasLiveSession && capture && capture.cols > 0 && capture.rows > 0) {
        target = {
          kind: "ssh",
          session_id: focused.sessionId,
          tab_id: tabId,
          block_id: focused.id,
          surface_rect: capture.surface_rect,
          dpi_scale: capture.dpi_scale,
          cols: capture.cols,
          rows: capture.rows,
        };
      }
    }

    const serialized = JSON.stringify(target);
    if (lastPublishedKeyActionsTargetRef.current === serialized) {
      return;
    }
    lastPublishedKeyActionsTargetRef.current = serialized;
    void api.keyActionsSetActiveWorkspace(target).catch(() => undefined);
  }, [activeTabId, focusedBlockId, sessions, tabId]);

  useEffect(() => {
    publishKeyActionsTarget();
  }, [blocks, captureContextVersion, focusedBlockId, publishKeyActionsTarget]);

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
  const sessionProfileById = useMemo(() => {
    const map = new Map<string, string>();
    sessions.forEach((session) => {
      if (session.session_kind !== "local") {
        map.set(session.session_id, session.profile_id);
      }
    });
    return map;
  }, [sessions]);
  const localSessionIds = useMemo(
    () => new Set(sessions.filter((item) => item.session_kind === "local").map((item) => item.session_id)),
    [sessions],
  );

  const sshProfiles = useMemo(
    () => connections.filter((profile) => supportsProtocol(profile, "ssh")),
    [connections],
  );
  const sftpProfiles = useMemo(
    () => connections.filter((profile) => supportsExactProfileProtocol(profile, "sftp")),
    [connections],
  );
  const ftpProfiles = useMemo(
    () => connections.filter((profile) => supportsExactProfileProtocol(profile, "ftp")),
    [connections],
  );
  const ftpsProfiles = useMemo(
    () => connections.filter((profile) => supportsExactProfileProtocol(profile, "ftps")),
    [connections],
  );
  const smbProfiles = useMemo(
    () => connections.filter((profile) => supportsExactProfileProtocol(profile, "smb")),
    [connections],
  );
  const rdpProfiles = useMemo(
    () => connections.filter((profile) => supportsProtocol(profile, "rdp")),
    [connections],
  );
  const sftpProfileSourceOptions = useMemo(
    () =>
      sftpProfiles.map((profile) => ({
        id: formatProfileSourceId(profile.id, "sftp"),
        label: `${profile.host} (${profile.username}) · SFTP`,
      })),
    [sftpProfiles],
  );
  const terminalRemoteSourceOptions = useMemo(
    () =>
      sshProfiles.map((profile) => ({
        id: formatProfileSourceId(profile.id, "sftp"),
        label: `${profile.host} (${profile.username})`,
      })),
    [sshProfiles],
  );
  const rdpSourceOptions = useMemo(
    () =>
      rdpProfiles.map((profile) => ({
        id: formatProfileSourceId(profile.id, "sftp"),
        label: `${profile.host} (${profile.username})`,
      })),
    [rdpProfiles],
  );
  const externalFileProfileSourceOptions = useMemo(
    () => [
      ...ftpProfiles.map((profile) => ({
        id: formatProfileSourceId(profile.id, "ftp"),
        label: `${profile.host} (${profile.username}) · FTP`,
      })),
      ...ftpsProfiles.map((profile) => ({
        id: formatProfileSourceId(profile.id, "ftps"),
        label: `${profile.host} (${profile.username}) · FTPS`,
      })),
      ...smbProfiles.map((profile) => ({
        id: formatProfileSourceId(profile.id, "smb"),
        label: `${profile.host} (${profile.username}) · SMB`,
      })),
    ],
    [ftpProfiles, ftpsProfiles, smbProfiles],
  );
  const remoteFileSourceOptions = useMemo(
    () => [...sftpProfileSourceOptions, ...externalFileProfileSourceOptions],
    [externalFileProfileSourceOptions, sftpProfileSourceOptions],
  );
  const createSourceOptions = useMemo(() => {
    if (createBlockKind === "terminal") {
      return [
        { id: "local", label: "Local Terminal" },
        ...terminalRemoteSourceOptions,
      ];
    }
    if (createBlockKind === "sftp") {
      return [
        { id: "local", label: "Local File System" },
        ...remoteFileSourceOptions,
      ];
    }
    if (createBlockKind === "rdp") {
      return rdpSourceOptions;
    }
    return [];
  }, [createBlockKind, rdpSourceOptions, remoteFileSourceOptions, terminalRemoteSourceOptions]);
  const selectedCreateSourceOptions = useMemo(() => {
    if (createBlockKind === "rdp") {
      return rdpSourceOptions;
    }
    if (createBlockKind === "terminal" && createSourceDraft !== "local") {
      return terminalRemoteSourceOptions;
    }
    if (createBlockKind === "sftp" && createSourceDraft !== "local") {
      return remoteFileSourceOptions;
    }
    return [];
  }, [
    createBlockKind,
    createSourceDraft,
    rdpSourceOptions,
    remoteFileSourceOptions,
    terminalRemoteSourceOptions,
  ]);
  const selectableConnections = useMemo(() => {
    const query = selectConnectionSearch.trim().toLowerCase();
    if (!query) {
      return connections;
    }
    return connections.filter((profile) => {
      const protocols = profileProtocols(profile).join(" ");
      return (
        profile.name.toLowerCase().includes(query) ||
        profile.host.toLowerCase().includes(query) ||
        profile.username.toLowerCase().includes(query) ||
        protocols.includes(query)
      );
    });
  }, [connections, selectConnectionSearch]);
  const openCreateBlockModal = useCallback(
    () => {
      setCreateBlockKind("terminal");
      setCreateSourceDraft("local");
      setCreateBlockModalOpen(true);
    },
    [],
  );

  const sourceOptions = useMemo(
    () => [
      { id: "local", label: "Local" },
      ...sessions
        .filter((session) => session.session_kind !== "local")
        .map((session) => ({
          id: session.session_id,
          label: sessionLabelById.get(session.session_id) ?? session.session_id,
        })),
      ...externalFileProfileSourceOptions,
    ],
    [externalFileProfileSourceOptions, sessionLabelById, sessions],
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

  const notifyModuleNotFound = useCallback(
    (kind: WorkspaceKind, blockId: string, action: string) => {
      const message =
        workspaceModules[kind].onNotFound?.({ blockId, action }) ??
        `Bloco ${kind} não encontrado (${action}) [${blockId}]`;
      appendWorkspaceLog("warn", message);
    },
    [appendWorkspaceLog],
  );

  const notifyModuleFailure = useCallback(
    (kind: WorkspaceKind, blockId: string, action: string, error: unknown) => {
      const message =
        workspaceModules[kind].onFailureLoad?.({ blockId, action, error }) ??
        `Falha no bloco ${kind} (${action}) [${blockId}]`;
      appendWorkspaceLog("error", message, getError(error));
    },
    [appendWorkspaceLog],
  );

  const notifyModuleDropdownSelect = useCallback(
    (kind: WorkspaceKind, blockId: string, action: string, value: string) => {
      const message = workspaceModules[kind].onDropDownSelect?.({ blockId, action, value });
      if (typeof message === "string" && message.length > 0) {
        appendWorkspaceLog("info", message);
      }
    },
    [appendWorkspaceLog],
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
    setFocusedBlockId(id);
    setBlocks((current) => {
      const target = current.find((block) => block.id === id);
      if (!target) {
        return current;
      }
      const top = current.reduce((highest, item) => Math.max(highest, item.zIndex), 1);
      return current.map((block) =>
        block.id === id
          ? {
              ...block,
              zIndex: top + 1,
              minimized: false,
            }
          : block,
      );
    });
  }, []);

  const closeBlock = useCallback(
    (id: string) => {
      const targetBlock = blocksRef.current.find((block) => block.id === id);
      const remainingBlocks = blocksRef.current.filter((block) => block.id !== id);
      clearBlockRetryTimers(id);
      rdpStreamTokenByBlockRef.current.delete(id);
      rdpLastFrameAtByBlockRef.current.delete(id);
      rdpSurfaceRectByBlockRef.current.delete(id);
      terminalCaptureByBlockRef.current.delete(id);
      setCaptureContextVersion((value) => value + 1);

      if (targetBlock?.kind === "rdp") {
        const sessionId = rdpStreamSessionByBlockRef.current.get(id) ?? targetBlock.sessionId;
        if (sessionId) {
          void api.rdpSessionStop(sessionId).catch(() => undefined);
        }
      }

      rdpStreamSessionByBlockRef.current.delete(id);

      const resolveSessionInUse = (sessionId: string) =>
        remainingBlocks.some((block) => {
          if (block.kind === "terminal") {
            return block.sessionId === sessionId;
          }
          if (block.kind === "sftp") {
            return block.sourceId === sessionId;
          }
          return false;
        });

      if (targetBlock?.kind === "terminal" && targetBlock.sessionId) {
        if (!resolveSessionInUse(targetBlock.sessionId)) {
          void disconnectSession(targetBlock.sessionId).catch(() => undefined);
        }
      }

      if (
        targetBlock?.kind === "sftp" &&
        targetBlock.sourceId !== "local" &&
        !parseProfileSourceRef(targetBlock.sourceId)
      ) {
        if (!resolveSessionInUse(targetBlock.sourceId)) {
          void disconnectSession(targetBlock.sourceId).catch(() => undefined);
        }
      }

      setBlocks((current) => current.filter((block) => block.id !== id));
    },
    [clearBlockRetryTimers, disconnectSession],
  );

  const toggleMaximize = useCallback((id: string) => {
    setBlocks((current) =>
      current.map((block) =>
        block.id === id ? { ...block, maximized: !block.maximized, minimized: false } : block,
      ),
    );
    focusBlock(id);
  }, [focusBlock]);

  const toggleMinimize = useCallback(
    (id: string) => {
      const target = blocksRef.current.find((block) => block.id === id);
      if (!target) {
        return;
      }

      const nextMinimized = !target.minimized;
      setBlocks((current) =>
        current.map((block) =>
          block.id === id ? { ...block, minimized: nextMinimized, maximized: false } : block,
        ),
      );

      if (!nextMinimized) {
        setFocusedBlockId(id);
        return;
      }

      if (focusedBlockId === id) {
        const nextFocused = [...blocksRef.current]
          .filter((block) => block.id !== id && !block.minimized)
          .sort((left, right) => right.zIndex - left.zIndex)[0];
        setFocusedBlockId(nextFocused?.id ?? id);
      }
    },
    [focusedBlockId],
  );

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

  const onBlockDragStart = useCallback((id: string) => {
    setDraggingBlockId(id);
  }, []);

  const onBlockDragPreview = useCallback(
    (id: string, nextLayout: WorkspaceBlockLayout) => {
      const snapped = snapLayoutToWorkspace(nextLayout, workspaceSize);
      const changed =
        Math.round(snapped.x) !== Math.round(nextLayout.x) ||
        Math.round(snapped.y) !== Math.round(nextLayout.y) ||
        Math.round(snapped.width) !== Math.round(nextLayout.width) ||
        Math.round(snapped.height) !== Math.round(nextLayout.height);
      setDraggingBlockId(id);
      setSnapPreview(changed ? snapped : null);
    },
    [workspaceSize],
  );

  const onBlockDragEnd = useCallback(() => {
    setDraggingBlockId(null);
    setSnapPreview(null);
  }, []);

  const refreshSftpBlock = useCallback(
    async (blockId: string, pathOverride?: string, sourceOverride?: string) => {
      const target = blocksRef.current.find((block): block is SftpBlock => block.id === blockId && block.kind === "sftp");
      if (!target) {
        notifyModuleNotFound("sftp", blockId, "refresh");
        return;
      }

      const nextSourceId = sourceOverride ?? target.sourceId;
      const sourceChanged = nextSourceId !== target.sourceId;
      const profileSource = parseProfileSourceRef(nextSourceId);
      const sourceProfile =
        profileSource
          ? connections.find((item) => item.id === profileSource.profileId) ?? null
          : null;
      const defaultPathForSource =
        nextSourceId === "local"
          ? ""
          : sourceProfile?.remote_path?.trim()
            ? normalizeRemotePath(sourceProfile.remote_path)
            : normalizeRemotePath("/");
      const rawPath = sourceChanged ? defaultPathForSource : pathOverride ?? target.path;
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
        notifyModuleFailure("sftp", blockId, "refresh_directory", error);
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
    [connections, notifyModuleFailure, notifyModuleNotFound],
  );

  const saveEditorBlock = useCallback(
    async (blockId: string) => {
      const target = blocksRef.current.find((block): block is EditorBlock => block.id === blockId && block.kind === "editor");
      if (!target || target.view !== "text" || target.loading || !target.dirty || target.saving) {
        if (!target) {
          notifyModuleNotFound("editor", blockId, "save");
        }
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
        notifyModuleFailure("editor", blockId, "save", error);
        toast.error(getError(error));
        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "editor" ? { ...block, saving: false } : block,
          ),
        );
      }
    },
    [notifyModuleFailure, notifyModuleNotFound, settings.modified_files_upload_policy],
  );

  const openEditorBlockExternal = useCallback(
    async (blockId: string) => {
      const target = blocksRef.current.find((block): block is EditorBlock => block.id === blockId && block.kind === "editor");
      if (!target) {
        notifyModuleNotFound("editor", blockId, "open_external");
        return;
      }
      if (target.view !== "text") {
        toast.warning("Preview de midia/binario nao exporta para editor externo por texto.");
        return;
      }

      try {
        await api.openExternalEditor(baseName(target.path), target.content, settings.external_editor_command || null);
      } catch (error) {
        notifyModuleFailure("editor", blockId, "open_external", error);
        toast.error(getError(error));
      }
    },
    [notifyModuleFailure, notifyModuleNotFound, settings.external_editor_command],
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
          minimized: false,
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
          status: "queued",
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
      let stateUnlisten: UnlistenFn | null = null;
      try {
        stateUnlisten = await listen<string>(`transfer:state:${transferId}`, (event) => {
          const state = String(event.payload ?? "").trim().toLowerCase();
          if (!state) {
            return;
          }
          if (state !== "queued" && state !== "running" && state !== "completed" && state !== "error") {
            return;
          }
          setTransferSnapshot((current) =>
            current.map((item) =>
              item.id === transferId
                ? { ...item, status: state, updatedAt: Date.now() }
                : item,
            ),
          );
        });

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

        setTransferSnapshot((current) =>
          current.map((item) =>
            item.id === transferId
              ? { ...item, status: "running", updatedAt: Date.now() }
              : item,
          ),
        );

        const toEndpoint = (sourceId: string): RemoteTransferEndpoint => {
          if (sourceId === "local") {
            return { kind: "local" };
          }
          const profileSource = parseProfileSourceRef(sourceId);
          if (profileSource) {
            if (profileSource.protocol === "sftp") {
              throw new Error("Fonte SFTP por perfil requer sessao ativa antes de transferir.");
            }
            return {
              kind: "profile",
              profile_id: profileSource.profileId,
              protocol: profileSource.protocol,
            };
          }
          return {
            kind: "sftp_session",
            session_id: sourceId,
          };
        };

        await api.remoteTransfer(
          transferId,
          toEndpoint(fromSourceId),
          fromPath,
          toEndpoint(toSourceId),
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
        stateUnlisten?.();
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
      const sourceProfileId =
        payload.sourceId === "local"
          ? null
          : sessionProfileById.get(payload.sourceId) ?? null;
      const targetProfileId =
        target.sourceId === "local"
          ? null
          : sessionProfileById.get(target.sourceId) ?? null;
      const sameRemoteProfile =
        sourceProfileId !== null &&
        targetProfileId !== null &&
        sourceProfileId === targetProfileId;

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

        if (sameRemoteProfile) {
          await executeTransfer({
            fromSourceId: payload.sourceId,
            fromPath: payload.path,
            toSourceId: target.sourceId,
            toPath: destinationRoot,
            sourceBlockId: payload.sourceBlockId,
            targetBlockId,
            notifySuccess: false,
          });
          await refreshSftpBlock(targetBlockId, target.path, target.sourceId);
          toast.success("Pasta transferida por copia remota otimizada.");
          appendWorkspaceLog(
            "success",
            "Transferencia de pasta concluida",
            `${payload.path} -> ${destinationRoot} (copia remota otimizada)`,
          );
          return;
        }

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
      sessionProfileById,
    ],
  );

  const resolveSftpDropTargetFromElement = useCallback(
    (element: Element | null): { blockId: string; targetPath: string } | null => {
      const dropTarget = element?.closest<HTMLElement>(SFTP_DROP_TARGET_SELECTOR);
      const blockId = dropTarget?.dataset.openptlBlockId?.trim();
      if (!blockId) {
        return null;
      }
      return {
        blockId,
        targetPath: dropTarget?.dataset.openptlTargetPath ?? "",
      };
    },
    [],
  );

  const resolveSftpDropTargetFromPosition = useCallback(
    (position: { x: number; y: number } | null): { blockId: string; targetPath: string } | null => {
      if (!position) {
        return null;
      }
      const x = Number(position.x);
      const y = Number(position.y);
      const scale = window.devicePixelRatio || 1;
      const candidates: Array<[number, number]> = [
        [x, y],
        [x / scale, y / scale],
        [x - window.screenX, y - window.screenY],
        [(x - window.screenX) / scale, (y - window.screenY) / scale],
      ];
      for (const [cx, cy] of candidates) {
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
          continue;
        }
        const resolved = resolveSftpDropTargetFromElement(document.elementFromPoint(cx, cy));
        if (resolved) {
          return resolved;
        }
      }
      return null;
    },
    [resolveSftpDropTargetFromElement],
  );

  const resolveSftpDropTargetWithFallback = useCallback(
    (
      position: { x: number; y: number } | null,
      fallbackToFocused: boolean,
    ): { blockId: string; targetPath: string } | null => {
      const now = Date.now();
      const lastTarget = lastExternalDropTargetRef.current;
      if (lastTarget && now - lastTarget.at < 3000) {
        return { blockId: lastTarget.blockId, targetPath: lastTarget.targetPath };
      }

      const fromPosition = resolveSftpDropTargetFromPosition(position);
      if (fromPosition) {
        return fromPosition;
      }

      if (!fallbackToFocused) {
        return null;
      }

      if (focusedBlockId) {
        const focused = blocksRef.current.find(
          (item): item is SftpBlock =>
            item.id === focusedBlockId &&
            item.kind === "sftp" &&
            item.connectStage === "ready",
        );
        if (focused) {
          return { blockId: focused.id, targetPath: focused.path };
        }
      }

      const firstReady = blocksRef.current.find(
        (item): item is SftpBlock => item.kind === "sftp" && item.connectStage === "ready",
      );
      if (firstReady) {
        return { blockId: firstReady.id, targetPath: firstReady.path };
      }
      return null;
    },
    [focusedBlockId, resolveSftpDropTargetFromPosition],
  );

  const startInternalEntryDrag = useCallback(
    (payload: DragPayload, pointer: { x: number; y: number }) => {
      setInternalEntryDrag({
        payload,
        startX: pointer.x,
        startY: pointer.y,
        cursorX: pointer.x,
        cursorY: pointer.y,
        active: false,
        targetBlockId: null,
        targetPath: null,
      });
    },
    [],
  );

  const pasteClipboardFilesIntoSftpBlock = useCallback(
    async (targetBlockId: string) => {
      const target = blocksRef.current.find(
        (block): block is SftpBlock => block.id === targetBlockId && block.kind === "sftp",
      );
      if (!target || target.connectStage !== "ready") {
        return;
      }

      try {
        const clipboardItems = await api.clipboardLocalItems();
        const uniqueItems = new Map<string, ClipboardLocalItem>();
        for (const item of clipboardItems) {
          const normalizedPath = item.path.trim();
          if (!normalizedPath) {
            continue;
          }
          if (!uniqueItems.has(normalizedPath)) {
            uniqueItems.set(normalizedPath, { path: normalizedPath, is_dir: item.is_dir });
          }
        }

        if (uniqueItems.size === 0) {
          toast.error("Nenhum arquivo local copiado na area de transferencia.");
          return;
        }

        for (const item of uniqueItems.values()) {
          const payload: DragPayload = {
            sourceBlockId: "clipboard-local",
            sourceId: "local",
            path: item.path,
            isDir: item.is_dir,
          };
          await transferBetweenBlocks(payload, targetBlockId, target.path);
        }
      } catch (error) {
        toast.error(getError(error));
      }
    },
    [transferBetweenBlocks],
  );

  const dropLocalPathsIntoSftpBlock = useCallback(
    async (targetBlockId: string, targetPath: string, paths: string[]) => {
      if (paths.length === 0) {
        return;
      }

      const unique = Array.from(
        new Set(
          paths
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      );
      const signature = `${targetBlockId}|${targetPath}|${[...unique].sort().join("\n")}`;
      const now = Date.now();
      const last = lastExternalFileDropSignatureRef.current;
      if (last && last.signature === signature && now - last.at < 700) {
        return;
      }
      lastExternalFileDropSignatureRef.current = { signature, at: now };

      for (const localPath of unique) {
        try {
          const stat = await api.localStat(localPath);
          const payload: DragPayload = {
            sourceBlockId: "external-drop-local",
            sourceId: "local",
            path: localPath,
            isDir: stat.is_dir,
          };
          await transferBetweenBlocks(payload, targetBlockId, targetPath);
        } catch (error) {
          toast.error(getError(error));
        }
      }
    },
    [transferBetweenBlocks],
  );

  const inferExternalDropKind = useCallback(async (paths: string[]): Promise<{ kind: ExternalDropKind; count: number }> => {
    const unique = Array.from(
      new Set(
        paths
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    );
    const count = unique.length;
    if (count === 0) {
      return { kind: "unknown", count: 0 };
    }

    const signature = [...unique].sort().join("\n");
    const cached = lastExternalDropKindRef.current;
    if (cached && cached.signature === signature && Date.now() - cached.at < 5000) {
      return { kind: cached.kind, count: cached.count };
    }

    let folderCount = 0;
    let fileCount = 0;
    const inspect = unique.slice(0, 16);
    for (const path of inspect) {
      try {
        const stat = await api.localStat(path);
        if (stat.is_dir) {
          folderCount += 1;
        } else {
          fileCount += 1;
        }
      } catch {
        // Ignore invalid paths during drag preview resolution.
      }
    }

    let kind: ExternalDropKind = "unknown";
    if (folderCount > 0 && fileCount === 0) {
      kind = "folder";
    } else if (fileCount > 0 && folderCount === 0) {
      kind = "file";
    } else if (fileCount > 0 && folderCount > 0) {
      kind = "mixed";
    }

    lastExternalDropKindRef.current = {
      signature,
      kind,
      count,
      at: Date.now(),
    };
    return { kind, count };
  }, []);

  useEffect(() => {
    if (!internalEntryDrag) {
      return;
    }

    const DRAG_THRESHOLD = 6;
    const onMouseMove = (event: MouseEvent) => {
      const current = internalEntryDragRef.current;
      if (!current) {
        return;
      }

      const movedEnough =
        Math.abs(event.clientX - current.startX) >= DRAG_THRESHOLD ||
        Math.abs(event.clientY - current.startY) >= DRAG_THRESHOLD;
      const isActive = current.active || movedEnough;
      const target = isActive
        ? resolveSftpDropTargetFromPosition({ x: event.clientX, y: event.clientY })
        : null;

      if (target?.blockId) {
        setFocusedBlockId(target.blockId);
      }

      setInternalEntryDrag((previous) => {
        if (!previous) {
          return previous;
        }
        return {
          ...previous,
          active: isActive,
          cursorX: event.clientX,
          cursorY: event.clientY,
          targetBlockId: target?.blockId ?? null,
          targetPath: target?.targetPath ?? null,
        };
      });
    };

    const finishDrag = () => {
      const snapshot = internalEntryDragRef.current;
      setInternalEntryDrag(null);
      if (!snapshot || !snapshot.active || !snapshot.targetBlockId) {
        return;
      }
      const targetPath = snapshot.targetPath ?? "";
      void transferBetweenBlocks(snapshot.payload, snapshot.targetBlockId, targetPath);
    };

    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", finishDrag, true);
    window.addEventListener("blur", finishDrag);
    return () => {
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", finishDrag, true);
      window.removeEventListener("blur", finishDrag);
    };
  }, [internalEntryDrag, resolveSftpDropTargetFromPosition, transferBetweenBlocks]);

  useEffect(() => {
    const isExternalFileDrag = (event: DragEvent): boolean => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) {
        return false;
      }
      return Array.from(dataTransfer.types ?? []).includes("Files");
    };

    const onDragOverCapture = (event: DragEvent) => {
      if (!isExternalFileDrag(event)) {
        return;
      }
      event.preventDefault();

      const filePaths = Array.from(event.dataTransfer?.files ?? [])
        .map((file) => (file as File & { path?: string }).path?.trim() ?? "")
        .filter((value) => value.length > 0);
      if (filePaths.length > 0) {
        lastExternalDropPathsRef.current = filePaths;
      }

      const hovered = event.target as HTMLElement | null;
      const dropTarget = hovered?.closest<HTMLElement>(SFTP_DROP_TARGET_SELECTOR);
      const blockId = dropTarget?.dataset.openptlBlockId?.trim();
      if (!blockId) {
        return;
      }
      const targetPath = dropTarget?.dataset.openptlTargetPath ?? "";

      lastExternalDropTargetRef.current = {
        blockId,
        targetPath,
        at: Date.now(),
      };
    };

    const onDropCapture = (event: DragEvent) => {
      if (!isExternalFileDrag(event)) {
        return;
      }
      event.preventDefault();
    };

    window.addEventListener("dragover", onDragOverCapture, true);
    window.addEventListener("drop", onDropCapture, true);
    return () => {
      window.removeEventListener("dragover", onDragOverCapture, true);
      window.removeEventListener("drop", onDropCapture, true);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    const appWindow = getCurrentWindow();

    const updateDropPreview = (target: { blockId: string; targetPath: string }, paths: string[]) => {
      void inferExternalDropKind(paths).then((meta) => {
        if (disposed) {
          return;
        }
        setExternalDropPreview({
          mode: "external",
          blockId: target.blockId,
          targetPath: target.targetPath,
          kind: meta.kind,
          count: meta.count,
        });
      });
    };

    void appWindow
      .onDragDropEvent((event) => {
        if (disposed) {
          return;
        }

        const payload = event.payload;
        if (payload.type === "leave") {
          setExternalDropPreview(null);
          lastExternalDropPathsRef.current = [];
          return;
        }

        const payloadPaths =
          "paths" in payload
            ? payload.paths.map((value) => value.trim()).filter((value) => value.length > 0)
            : [];
        if (payloadPaths.length > 0) {
          lastExternalDropPathsRef.current = payloadPaths;
        }

        const paths = payloadPaths.length > 0 ? payloadPaths : lastExternalDropPathsRef.current;
        const position = "position" in payload ? payload.position : null;

        if (payload.type === "enter" || payload.type === "over") {
          const target = resolveSftpDropTargetWithFallback(position, false);
          if (!target) {
            setExternalDropPreview(null);
            return;
          }
          setFocusedBlockId(target.blockId);

          if (paths.length > 0) {
            updateDropPreview(target, paths);
          } else {
            setExternalDropPreview({
              mode: "external",
              blockId: target.blockId,
              targetPath: target.targetPath,
              kind: "unknown",
              count: 0,
            });
          }
          return;
        }

        if (payload.type !== "drop") {
          return;
        }

        if (paths.length === 0) {
          setExternalDropPreview(null);
          return;
        }

        const resolvedTarget = resolveSftpDropTargetWithFallback(position, true);
        if (!resolvedTarget) {
          toast.error("Abra um bloco de arquivos conectado para receber o drop.");
          setExternalDropPreview(null);
          return;
        }

        setFocusedBlockId(resolvedTarget.blockId);
        void dropLocalPathsIntoSftpBlock(resolvedTarget.blockId, resolvedTarget.targetPath, paths);
        setExternalDropPreview(null);
        lastExternalDropPathsRef.current = [];
      })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dropLocalPathsIntoSftpBlock, inferExternalDropKind, resolveSftpDropTargetWithFallback]);

  const addSftpBlock = useCallback(
    (sourceId?: string) => {
      const firstSession = sessions.find((item) => item.session_kind !== "local")?.session_id ?? sessions[0]?.session_id;
      const resolvedSource = sourceId ?? firstSession ?? "local";
      const profileSource = parseProfileSourceRef(resolvedSource);
      const profile =
        profileSource
          ? connections.find((item) => item.id === profileSource.profileId) ?? null
          : null;
      const host =
        resolvedSource === "local"
          ? "Local"
          : profile?.host ?? sessionHostById.get(resolvedSource) ?? resolvedSource.slice(0, 8);
      const label = profileSource ? profileSource.protocol.toUpperCase() : "SFTP";
      const baseTitle = `${label} - ${host}`;
      const count = blocksRef.current.filter((item) => item.kind === "sftp" && item.title.startsWith(baseTitle)).length;
      const initialPath =
        resolvedSource === "local"
          ? ""
          : profile?.remote_path?.trim()
            ? normalizeRemotePath(profile.remote_path)
            : normalizeRemotePath("/");
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
        minimized: false,
        maximized: false,
      };
      setBlocks((current) => [...current, block]);
      appendWorkspaceLog("info", "Bloco SFTP criado", `${block.title} @ ${block.path || "/"}`);
      window.setTimeout(() => {
        void refreshSftpBlock(id, block.path, block.sourceId);
      }, 0);
    },
    [
      appendWorkspaceLog,
      connections,
      refreshSftpBlock,
      sessions,
      sessionHostById,
      workspaceSize.height,
      workspaceSize.width,
    ],
  );

  const touchRdpFrameForBlock = useCallback(
    (blockId: string, width: number, height: number) => {
      const currentBlock = blocksRef.current.find(
        (item): item is RdpBlock => item.id === blockId && item.kind === "rdp",
      );
      if (!currentBlock) {
        return;
      }

      const nextWidth = width > 0 ? width : currentBlock.imageWidth;
      const nextHeight = height > 0 ? height : currentBlock.imageHeight;
      const dimensionsChanged = nextWidth !== currentBlock.imageWidth || nextHeight !== currentBlock.imageHeight;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const lastTouch = rdpLastFrameAtByBlockRef.current.get(blockId) ?? 0;
      const shouldUpdateTimestamp = nowSeconds > lastTouch;

      if (!dimensionsChanged && !shouldUpdateTimestamp) {
        return;
      }

      if (shouldUpdateTimestamp) {
        rdpLastFrameAtByBlockRef.current.set(blockId, nowSeconds);
      }

      setBlocks((current) =>
        current.map((block) =>
          block.id === blockId && block.kind === "rdp"
            ? {
                ...block,
                imageWidth: nextWidth,
                imageHeight: nextHeight,
                capturedAt: shouldUpdateTimestamp ? nowSeconds : block.capturedAt,
                connectStage: "ready",
                connectMessage: t.workspace.rdp.ready,
                connectError: null,
                retryAttempt: 0,
                retryInSeconds: null,
              }
            : block,
        ),
      );
    },
    [t.workspace.rdp.ready],
  );

  const resolvePendingRdpConnection = useCallback(
    async (
      blockId: string,
      options?: {
        passwordOverride?: string | null;
        saveAuthChoice?: boolean;
        retryAttempt?: number;
      },
    ) => {
      const target = blocksRef.current.find((item): item is RdpBlock => item.id === blockId && item.kind === "rdp");
      if (!target) {
        return;
      }

      const profile = connections.find((item) => item.id === target.profileId);
      if (!profile) {
        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "rdp"
              ? {
                  ...block,
                  connectStage: "error",
                  connectMessage: t.workspace.rdp.error,
                  connectError: "Perfil RDP nao encontrado.",
                  retryAttempt: 0,
                  retryInSeconds: null,
                  sessionId: null,
                }
              : block,
          ),
        );
        return;
      }

      const passwordOverride = options?.passwordOverride ?? null;
      const saveAuthChoice = options?.saveAuthChoice ?? false;
      const currentAttempt = Math.max(0, options?.retryAttempt ?? target.retryAttempt);
      const connectingMessage = passwordOverride ? "Logando..." : t.workspace.rdp.connecting;
      const previousSessionId = rdpStreamSessionByBlockRef.current.get(blockId) ?? target.sessionId;
      if (previousSessionId) {
        rdpStreamSessionByBlockRef.current.delete(blockId);
        void api.rdpSessionStop(previousSessionId).catch(() => undefined);
      }
      rdpLastFrameAtByBlockRef.current.delete(blockId);
      clearBlockRetryTimers(blockId);

      setBlocks((current) =>
        current.map((block) =>
          block.id === blockId && block.kind === "rdp"
            ? {
                ...block,
                connectStage: "connecting",
                connectMessage: connectingMessage,
                connectError: null,
                retryAttempt: currentAttempt,
                retryInSeconds: null,
                sessionId: null,
              }
            : block,
        ),
      );
      appendWorkspaceLog("info", "Conexao RDP em andamento", `${profile.username}@${profile.host}:${profile.port}`);

      const streamToken = createId("rdpstream");
      rdpStreamTokenByBlockRef.current.set(blockId, streamToken);

      const controlChannel = new Channel<RdpSessionControlEvent>((event) => {
        if (rdpStreamTokenByBlockRef.current.get(blockId) !== streamToken) {
          return;
        }

        if (event.event === "ready") {
          clearBlockRetryTimers(blockId);
          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "rdp"
                ? {
                    ...block,
                    sessionId: event.data.session_id,
                    connectStage: "ready",
                    connectMessage: t.workspace.rdp.ready,
                    connectError: null,
                    imageWidth: event.data.width,
                    imageHeight: event.data.height,
                    retryAttempt: 0,
                    retryInSeconds: null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog(
            "success",
            "Sessao RDP conectada",
            `${profile.host} ${event.data.width}x${event.data.height}`,
          );
          return;
        }

        if (event.event === "connecting") {
          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "rdp"
                ? {
                    ...block,
                    connectStage: "connecting",
                    connectMessage: event.data.message || t.workspace.rdp.connecting,
                    connectError: null,
                  }
                : block,
            ),
          );
          return;
        }

        if (event.event === "auth_required") {
          clearBlockRetryTimers(blockId);
          rdpStreamSessionByBlockRef.current.delete(blockId);
          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "rdp"
                ? {
                    ...block,
                    sessionId: null,
                    connectStage: "awaiting_password",
                    connectMessage: t.workspace.rdp.authRequired,
                    connectError: event.data.message,
                    retryAttempt: 0,
                    retryInSeconds: null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog("warn", "Autenticacao RDP pendente", `${profile.username}@${profile.host}:${profile.port}`);
          return;
        }

        if (event.event === "error") {
          rdpStreamSessionByBlockRef.current.delete(blockId);
          const timeoutDetected = isTimeoutErrorMessage(event.data.message);
          const nextAttempt = currentAttempt + 1;
          const delaySeconds = Math.max(1, settings.reconnect_delay_seconds);
          const canRetry = settings.auto_reconnect_enabled && nextAttempt <= MAX_CONNECT_RETRY_ATTEMPTS && timeoutDetected;
          const retryLabel = canRetry
            ? `Nova tentativa em ${delaySeconds}s (${nextAttempt}/${MAX_CONNECT_RETRY_ATTEMPTS}).`
            : `Limite de ${MAX_CONNECT_RETRY_ATTEMPTS} tentativas atingido.`;

          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "rdp"
                ? {
                    ...block,
                    sessionId: null,
                    connectStage: "error",
                    connectMessage: timeoutDetected ? "Timeout na conexao RDP." : t.workspace.rdp.error,
                    connectError: timeoutDetected ? `${event.data.message} ${retryLabel}`.trim() : event.data.message,
                    retryAttempt: timeoutDetected ? nextAttempt : 0,
                    retryInSeconds: canRetry ? delaySeconds : null,
                  }
                : block,
            ),
          );
          appendWorkspaceLog("error", "Falha no stream RDP", event.data.message);

          if (canRetry) {
            scheduleBlockAutoRetry({
              blockId,
              kind: "rdp",
              delaySeconds,
              attempt: nextAttempt,
              onRetry: () => {
                void resolvePendingRdpConnection(blockId, {
                  passwordOverride,
                  saveAuthChoice,
                  retryAttempt: nextAttempt,
                });
              },
            });
          }
          return;
        }

        if (event.event === "stopped") {
          const current = rdpStreamSessionByBlockRef.current.get(blockId);
          if (current === event.data.session_id) {
            rdpStreamSessionByBlockRef.current.delete(blockId);
          }
        }
      });

      const videoRectsChannel = new Channel<ArrayBuffer>((message) => {
        if (rdpStreamTokenByBlockRef.current.get(blockId) !== streamToken) {
          return;
        }
        if (!(message instanceof ArrayBuffer)) {
          return;
        }

        const packet = parseRdpVideoRectsPacket(message);
        if (!packet) {
          return;
        }
        touchRdpFrameForBlock(blockId, packet.width, packet.height);
        emitRdpVideoRects({ blockId, packet });
      });

      const cursorChannel = new Channel<ArrayBuffer>((message) => {
        if (rdpStreamTokenByBlockRef.current.get(blockId) !== streamToken) {
          return;
        }
        if (!(message instanceof ArrayBuffer)) {
          return;
        }
        const packet = parseRdpCursorPacket(message);
        if (!packet) {
          return;
        }
        emitRdpCursor({ blockId, packet });
      });

      const audioPcmChannel = new Channel<ArrayBuffer>((message) => {
        if (rdpStreamTokenByBlockRef.current.get(blockId) !== streamToken) {
          return;
        }
        if (!(message instanceof ArrayBuffer)) {
          return;
        }
        const packet = parseRdpAudioPacket(message);
        if (!packet) {
          return;
        }
        emitRdpAudio({ blockId, packet });
      });

      try {
        const result = await api.rdpSessionStart(
          profile.id,
          controlChannel,
          videoRectsChannel,
          cursorChannel,
          audioPcmChannel,
          {
          width: 1280,
          height: 720,
          passwordOverride,
          saveAuthChoice,
          },
        );

        if (rdpStreamTokenByBlockRef.current.get(blockId) !== streamToken) {
          return;
        }

        if (result.status === "started") {
          rdpStreamSessionByBlockRef.current.set(blockId, result.session_id);
          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "rdp"
                ? { ...block, sessionId: result.session_id, connectMessage: connectingMessage }
                : block,
            ),
          );
          return;
        }

        if (result.status === "auth_required") {
          setBlocks((current) =>
            current.map((block) =>
              block.id === blockId && block.kind === "rdp"
                ? {
                    ...block,
                    sessionId: null,
                    connectStage: "awaiting_password",
                    connectMessage: t.workspace.rdp.authRequired,
                    connectError: result.message,
                    retryAttempt: 0,
                    retryInSeconds: null,
                  }
                : block,
            ),
          );
          return;
        }

        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "rdp"
              ? {
                  ...block,
                  sessionId: null,
                  connectStage: "error",
                  connectMessage: t.workspace.rdp.error,
                  connectError: result.message,
                  retryAttempt: 0,
                  retryInSeconds: null,
                }
              : block,
          ),
        );
      } catch (error) {
        const message = getError(error);
        setBlocks((current) =>
          current.map((block) =>
            block.id === blockId && block.kind === "rdp"
              ? {
                  ...block,
                  sessionId: null,
                  connectStage: "error",
                  connectMessage: t.workspace.rdp.error,
                  connectError: message,
                  retryAttempt: 0,
                  retryInSeconds: null,
                }
              : block,
          ),
        );
        appendWorkspaceLog("error", "Erro ao iniciar stream RDP", message);
      }
    },
    [
      appendWorkspaceLog,
      clearBlockRetryTimers,
      connections,
      settings.auto_reconnect_enabled,
      settings.reconnect_delay_seconds,
      scheduleBlockAutoRetry,
      touchRdpFrameForBlock,
      t.workspace.rdp.authRequired,
      t.workspace.rdp.connecting,
      t.workspace.rdp.error,
      t.workspace.rdp.ready,
    ],
  );

  const addPendingRdpBlock = useCallback(
    (profileId: string) => {
      const profile = connections.find((item) => item.id === profileId);
      if (!profile) {
        toast.error("Perfil RDP nao encontrado.");
        return;
      }

      const host = profile.host || profileId.slice(0, 8);
      const baseTitle = `RDP - ${host}`;
      const count = blocksRef.current.filter((item) => item.kind === "rdp" && item.title.startsWith(baseTitle)).length;
      const blockId = createId("rdp");
      const block: RdpBlock = {
        id: blockId,
        kind: "rdp",
        title: count > 0 ? `${baseTitle} (${count + 1})` : baseTitle,
        profileId,
        sessionId: null,
        connectStage: "connecting",
        connectMessage: t.workspace.rdp.connecting,
        connectError: null,
        passwordDraft: "",
        savePasswordChoice: false,
        retryAttempt: 0,
        retryInSeconds: null,
        imageWidth: 0,
        imageHeight: 0,
        capturedAt: null,
        layout: workspaceDefaultLayout("rdp", blocksRef.current.length, workspaceSize.width, workspaceSize.height),
        zIndex: blocksRef.current.reduce((acc, item) => Math.max(acc, item.zIndex), 1) + 1,
        minimized: false,
        maximized: false,
      };
      setBlocks((current) => [...current, block]);
      appendWorkspaceLog("info", "Conexao RDP solicitada", `${profile.username}@${profile.host}:${profile.port}`);
      window.setTimeout(() => {
        void resolvePendingRdpConnection(blockId, { retryAttempt: 0 });
      }, 0);
    },
    [appendWorkspaceLog, connections, resolvePendingRdpConnection, t.workspace.rdp.connecting, workspaceSize.height, workspaceSize.width],
  );

  useEffect(() => {
    return () => {
      rdpStreamTokenByBlockRef.current.clear();
      rdpLastFrameAtByBlockRef.current.clear();
      rdpSurfaceRectByBlockRef.current.clear();
      terminalCaptureByBlockRef.current.clear();
      lastPublishedKeyActionsTargetRef.current = null;
      rdpStreamSessionByBlockRef.current.forEach((sessionId) => {
        void api.rdpSessionStop(sessionId).catch(() => undefined);
      });
      rdpStreamSessionByBlockRef.current.clear();
      void api.keyActionsSetActiveWorkspace(null).catch(() => undefined);
    };
  }, []);

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
        minimized: false,
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
          connectPurpose: "sftp",
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
        minimized: false,
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
        minimized: false,
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

  const openConnectionInWorkspace = useCallback(
    (profile: ConnectionProfile, options?: { openSftpWithSsh?: boolean }) => {
      const protocols = profileProtocols(profile);
      if (protocols.includes("rdp")) {
        addPendingRdpBlock(profile.id);
        return;
      }

      const hasSsh = protocols.includes("ssh");
      const fileProtocol = resolveWorkspaceFileProtocol(profile);

      if (hasSsh) {
        addPendingTerminalBlock(profile.id);
        if ((options?.openSftpWithSsh ?? false) && fileProtocol === "sftp") {
          addPendingSftpBlock(profile.id);
        }
        return;
      }

      if (fileProtocol === "sftp") {
        addPendingSftpBlock(profile.id);
        return;
      }
      if (fileProtocol) {
        addSftpBlock(formatProfileSourceId(profile.id, fileProtocol));
        return;
      }

      toast.error("Esta conexão não possui protocolo suportado para abrir no workspace.");
    },
    [addPendingRdpBlock, addPendingSftpBlock, addPendingTerminalBlock, addSftpBlock],
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
        if (initialOpenFiles) {
          const profile = connections.find((item) => item.id === profileId);
          if (profile && resolveWorkspaceFileProtocol(profile) === "sftp") {
            addPendingSftpBlock(profileId);
          }
        }
        return;
      }
      addTerminalBlock(initialSourceId);
      return;
    }
    if (initialBlock === "sftp") {
      const profileSource = parseProfileSourceRef(initialSourceId);
      if (profileSource?.protocol === "sftp") {
        addPendingSftpBlock(profileSource.profileId);
        return;
      }
      if (profileSource) {
        addSftpBlock(initialSourceId ?? "local");
        return;
      }
      addSftpBlock(initialSourceId ?? "local");
      return;
    }
    if (initialBlock === "rdp") {
      const profileId = parseProfileSourceId(initialSourceId) ?? initialSourceId ?? null;
      if (profileId) {
        addPendingRdpBlock(profileId);
      }
    }
  }, [
    addPendingRdpBlock,
    addPendingSftpBlock,
    addPendingTerminalBlock,
    addSftpBlock,
    addTerminalBlock,
    connections,
    initialBlock,
    initialOpenFiles,
    initialSourceId,
  ]);

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
      if (parseProfileSourceRef(sourceId)) {
        toast.warning("Esse tipo de origem nao possui terminal SSH associado.");
        return;
      }
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

  const closeSftpCreateDialog = useCallback(() => {
    setSftpCreateDialog((current) => (current?.busy ? current : null));
  }, []);

  const submitSftpCreateDialog = useCallback(async () => {
    const snapshot = sftpCreateDialog;
    if (!snapshot || snapshot.busy) {
      return;
    }

    const name = snapshot.value.trim();
    if (!name) {
      toast.error("Informe um nome valido.");
      return;
    }

    setSftpCreateDialog((current) => (current ? { ...current, busy: true } : current));
    try {
      const target =
        snapshot.sourceId === "local"
          ? joinPath(snapshot.basePath, name)
          : joinRemotePath(snapshot.basePath, name);

      if (snapshot.mode === "mkdir") {
        await createSourceFolder(snapshot.sourceId, target);
      } else {
        await createSourceFile(snapshot.sourceId, target);
      }

      const currentBlock = blocksRef.current.find(
        (item): item is SftpBlock => item.id === snapshot.blockId && item.kind === "sftp",
      );
      await refreshSftpBlock(
        snapshot.blockId,
        currentBlock?.path ?? snapshot.basePath,
        currentBlock?.sourceId ?? snapshot.sourceId,
      );
      setSftpCreateDialog(null);
    } catch (error) {
      toast.error(getError(error));
      setSftpCreateDialog((current) => (current ? { ...current, busy: false } : current));
    }
  }, [refreshSftpBlock, sftpCreateDialog]);

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
          setSftpCreateDialog({
            mode: "mkdir",
            blockId: block.id,
            sourceId: block.sourceId,
            basePath: block.path,
            value: "",
            busy: false,
          });
          return;
        }
        if (action === "mkfile") {
          setSftpCreateDialog({
            mode: "mkfile",
            blockId: block.id,
            sourceId: block.sourceId,
            basePath: block.path,
            value: "",
            busy: false,
          });
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
      if (createBlockKind === "rdp") {
        const profileSource = parseProfileSourceRef(createSourceDraft);
        if (!profileSource) {
          toast.error(t.workspace.rdp.selectProfile);
          return;
        }
        addPendingRdpBlock(profileSource.profileId);
        setCreateBlockModalOpen(false);
        return;
      }

      let sourceId = createSourceDraft;
      if (createSourceDraft === "local" && createBlockKind === "terminal") {
        sourceId = await connectLocalTerminal();
      } else if (createBlockKind === "terminal") {
        const profileSource = parseProfileSourceRef(createSourceDraft);
        if (profileSource) {
          addPendingTerminalBlock(profileSource.profileId);
          setCreateBlockModalOpen(false);
          return;
        }
      } else if (createBlockKind === "sftp") {
        const profileSource = parseProfileSourceRef(createSourceDraft);
        if (profileSource?.protocol === "sftp") {
          addPendingSftpBlock(profileSource.profileId);
          setCreateBlockModalOpen(false);
          return;
        }
        if (profileSource) {
          addSftpBlock(createSourceDraft);
          setCreateBlockModalOpen(false);
          return;
        }
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
    addPendingRdpBlock,
    addPendingSftpBlock,
    addPendingTerminalBlock,
    addSftpBlock,
    addTerminalBlock,
    connectLocalTerminal,
    createBlockKind,
    createSourceDraft,
    openFile,
    t.workspace.rdp.selectProfile,
  ]);

  useEffect(() => {
    if (!createBlockModalOpen) {
      return;
    }
    if (createBlockKind === "editor") {
      return;
    }
    if (!createSourceOptions.some((item) => item.id === createSourceDraft)) {
      setCreateSourceDraft(createSourceOptions[0]?.id ?? "local");
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
      blocks
        .filter((block) => !block.minimized)
        .map((block) => ({
          block,
          layout: block.maximized
            ? { x: 0, y: 0, width: workspaceSize.width, height: workspaceSize.height }
            : block.layout,
          interactive: !block.maximized,
        })),
    [blocks, workspaceSize.height, workspaceSize.width],
  );

  const activeTransfers = transfers.filter((item) => item.status === "running" || item.status === "queued").length;
  const draggingBlockZIndex = useMemo(() => {
    if (!draggingBlockId) {
      return 1;
    }
    const block = blocks.find((item) => item.id === draggingBlockId);
    return Math.max(1, (block?.zIndex ?? 2) - 1);
  }, [blocks, draggingBlockId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 items-center gap-2 border-b border-border/60 bg-card/60 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {blocks.map((block) => {
            const iconClass =
              block.kind === "terminal"
                ? "text-primary"
                : block.kind === "sftp"
                  ? "text-info"
                  : block.kind === "rdp"
                    ? "text-destructive"
                    : "text-warning";
            const Icon =
              block.kind === "terminal"
                ? TerminalSquare
                : block.kind === "sftp"
                  ? Folder
                  : block.kind === "rdp"
                    ? Monitor
                    : FileText;
            const active = focusedBlockId === block.id && !block.minimized;
            return (
              <button
                key={block.id}
                type="button"
                onClick={() => {
                  if (block.minimized) {
                    toggleMinimize(block.id);
                    focusBlock(block.id);
                    return;
                  }
                  if (focusedBlockId === block.id) {
                    toggleMinimize(block.id);
                    return;
                  }
                  focusBlock(block.id);
                }}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 rounded border px-2.5 text-[11px] transition-colors",
                  active
                    ? "border-primary/40 bg-primary/12 text-primary"
                    : block.minimized
                      ? "border-border/40 bg-secondary/35 text-muted-foreground"
                      : "border-border/50 bg-secondary/55 text-foreground hover:bg-secondary",
                )}
                title={block.title}
              >
                <Icon className={cn("h-3 w-3", iconClass)} />
                <span className="max-w-[180px] truncate">{block.title}</span>
                <X
                  className="ml-0.5 h-2.5 w-2.5 text-muted-foreground hover:text-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeBlock(block.id);
                  }}
                />
              </button>
            );
          })}

          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border/60 text-muted-foreground transition hover:border-primary/60 hover:bg-secondary hover:text-foreground"
            title={t.workspace.addBlock}
            onClick={() => openCreateBlockModal()}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {activeTransfers > 0 ? (
          <div className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] text-primary">
            <Folder className="h-3.5 w-3.5 animate-pulse" />
            <span>{activeTransfers} {t.workspace.transfer}</span>
          </div>
        ) : null}
      </div>

      <div ref={workspaceRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: "radial-gradient(circle, hsl(var(--foreground)) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />

        {blocks.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="w-full max-w-md rounded-2xl border border-border/50 bg-card/80 p-6 text-center shadow-xl">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-primary/25 bg-primary/10">
                <Monitor className="h-6 w-6 text-primary" />
              </div>
              <p className="text-sm font-semibold text-foreground">{t.workspace.newBlockTitle}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t.workspace.newBlockDescription}</p>
              <div className="mt-4 flex items-center justify-center">
                <button
                  type="button"
                  className="flex h-8 items-center gap-2 rounded-lg border border-border/60 px-3 text-xs text-foreground transition hover:bg-secondary"
                  onClick={() => setSelectConnectionDialogOpen(true)}
                >
                  <Monitor className="h-3.5 w-3.5" /> {t.workspace.accessConnection}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {blocks.length > 0 && renderedBlocks.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-xl border border-border/50 bg-card/70 px-4 py-3 text-xs text-muted-foreground">
              {t.workspace.allMinimizedHint}
            </div>
          </div>
        ) : null}

        {snapPreview ? (
          <div
            className="pointer-events-none absolute rounded-md border border-primary/70 bg-primary/12 shadow-[0_0_24px_hsl(var(--primary)/0.35)]"
            style={{
              left: snapPreview.x,
              top: snapPreview.y,
              width: snapPreview.width,
              height: snapPreview.height,
              zIndex: draggingBlockZIndex,
            }}
          />
        ) : null}

        {renderedBlocks.map(({ block, layout, interactive }) => (
          <WorkspaceBlockController
            key={block.id}
            id={block.id}
            title={block.title}
            layout={layout}
            zIndex={block.maximized ? 9999 : block.zIndex}
            active={focusedBlockId === block.id}
            interactive={interactive}
            onFocus={focusBlock}
            onDragStart={onBlockDragStart}
            onDragPreview={onBlockDragPreview}
            onDragEnd={onBlockDragEnd}
            onLayoutChange={onLayoutChange}
            minWidth={block.kind === "terminal" || block.kind === "rdp" ? 420 : 360}
            minHeight={block.kind === "terminal" || block.kind === "rdp" ? 260 : 240}
            headerRight={
              <>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                  onClick={() => toggleMinimize(block.id)}
                  title="Minimizar"
                >
                  <Minimize2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                  onClick={() => toggleMaximize(block.id)}
                >
                  {block.maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
                  onClick={() => closeBlock(block.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            }
          >
            {block.kind === "terminal"
              ? terminalWorkspace.render({
                  block,
                  sessionOptions: terminalOptions,
                  useBackendCaptureInput:
                    activeTabId === tabId &&
                    focusedBlockId === block.id &&
                    keyActionsStatus?.status === "ready",
                  captureUnavailableMessage:
                    focusedBlockId === block.id ? captureUnavailableMessage : null,
                  onCaptureContextChange: (context) => {
                    const current = terminalCaptureByBlockRef.current.get(block.id) ?? null;
                    const next = context ?? null;
                    if (areTerminalCaptureContextsEqual(current, next)) {
                      return;
                    }
                    if (next) {
                      terminalCaptureByBlockRef.current.set(block.id, next);
                    } else {
                      terminalCaptureByBlockRef.current.delete(block.id);
                    }
                    setCaptureContextVersion((value) => value + 1);
                  },
                  onSessionChange: (nextSessionId) => {
                    notifyModuleDropdownSelect("terminal", block.id, "session_select", nextSessionId);
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
                  },
                  ensureSessionListeners,
                  sshWrite,
                  onTrustHost: () => {
                    clearBlockRetryTimers(block.id);
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "terminal"
                          ? { ...item, acceptUnknownHost: true, retryAttempt: 0, retryInSeconds: null }
                          : item,
                      ),
                    );
                    void resolvePendingTerminalConnection(block.id, { acceptUnknownHost: true, retryAttempt: 0 });
                  },
                  onRetry: () => {
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
                  },
                  onPasswordDraftChange: (value) => {
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "terminal"
                          ? { ...item, passwordDraft: value }
                          : item,
                      ),
                    );
                  },
                  onSavePasswordChange: (checked) => {
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "terminal"
                          ? { ...item, savePasswordChoice: checked }
                          : item,
                      ),
                    );
                  },
                  onSubmitPassword: () => {
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
                  },
                })
              : null}

            {block.kind === "sftp"
              ? sftpWorkspace.render({
                  block,
                  sourceOptions,
                  transferItems: transferItemsByBlock.get(block.id) ?? [],
                  externalDropPreview:
                    externalDropPreview?.blockId === block.id
                      ? {
                          mode: "external" as const,
                          kind: externalDropPreview.kind,
                          count: externalDropPreview.count,
                          targetPath: externalDropPreview.targetPath,
                        }
                      : internalEntryDrag?.active &&
                          internalEntryDrag.targetBlockId === block.id
                        ? {
                            mode: "internal" as const,
                            kind: internalEntryDrag.payload.isDir ? "folder" : "file",
                            count: 1,
                            targetPath: internalEntryDrag.targetPath ?? block.path,
                          }
                      : null,
                  onFocus: () => focusBlock(block.id),
                  onPasteClipboardFiles: () => {
                    void pasteClipboardFilesIntoSftpBlock(block.id);
                  },
                  onEntryDragStart: (payload, pointer) => {
                    startInternalEntryDrag(payload, pointer);
                  },
                  onRefresh: (path, sourceId) => {
                    if (sourceId !== block.sourceId) {
                      notifyModuleDropdownSelect("sftp", block.id, "source_select", sourceId);
                    }
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
                  },
                  onSelectSort: (sortKey) =>
                    setBlocks((current) =>
                      current.map((item) => {
                        if (item.id !== block.id || item.kind !== "sftp") {
                          return item;
                        }
                        const direction =
                          item.sortKey === sortKey && item.sortDirection === "asc" ? "desc" : "asc";
                        return { ...item, sortKey, sortDirection: direction };
                      }),
                    ),
                  onSelectEntry: (entryPath) =>
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "sftp" ? { ...item, selectedPath: entryPath } : item,
                      ),
                    ),
                  onOpenEntry: (entry) => {
                    if (entry.is_dir) {
                      void refreshSftpBlock(block.id, entry.path, block.sourceId);
                      return;
                    }
                    void openFile(block.sourceId, entry.path);
                  },
                  onContextAction: (action, entry) => void handleSftpContextAction(block, action, entry),
                  onTrustHost: () => {
                    clearBlockRetryTimers(block.id);
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "sftp"
                          ? { ...item, acceptUnknownHost: true, retryAttempt: 0, retryInSeconds: null }
                          : item,
                      ),
                    );
                    void resolvePendingSftpConnection(block.id, { acceptUnknownHost: true, retryAttempt: 0 });
                  },
                  onRetry: () => {
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
                  },
                  onPasswordDraftChange: (value) => {
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "sftp"
                          ? { ...item, passwordDraft: value }
                          : item,
                      ),
                    );
                  },
                  onSavePasswordChange: (checked) => {
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "sftp"
                          ? { ...item, savePasswordChoice: checked }
                          : item,
                      ),
                    );
                  },
                  onSubmitPassword: () => {
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
                  },
                })
              : null}

            {block.kind === "rdp"
              ? rdpWorkspace.render({
                  block,
                  active: focusedBlockId === block.id,
                  profiles: rdpProfiles,
                  captureUnavailableMessage:
                    focusedBlockId === block.id ? captureUnavailableMessage : null,
                  onFocus: () => focusBlock(block.id),
                  onProfileChange: (profileId) => {
                    notifyModuleDropdownSelect("rdp", block.id, "profile_select", profileId);
                    clearBlockRetryTimers(block.id);
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "rdp"
                          ? {
                              ...item,
                              profileId,
                              sessionId: null,
                              connectStage: "connecting",
                              connectMessage: t.workspace.rdp.connecting,
                              connectError: null,
                              imageWidth: 0,
                              imageHeight: 0,
                              capturedAt: null,
                              retryAttempt: 0,
                              retryInSeconds: null,
                            }
                          : item,
                      ),
                    );
                    void resolvePendingRdpConnection(block.id, { retryAttempt: 0 });
                  },
                  onRetry: () => {
                    clearBlockRetryTimers(block.id);
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "rdp"
                          ? { ...item, retryAttempt: 0, retryInSeconds: null }
                          : item,
                      ),
                    );
                    void resolvePendingRdpConnection(block.id, { retryAttempt: 0 });
                  },
                  onFocusChange: (focus) => {
                    const currentRect = rdpSurfaceRectByBlockRef.current.get(block.id) ?? null;
                    const nextRect = focus.surface_rect ?? null;
                    if (!areSurfaceRectsEqual(currentRect, nextRect)) {
                      if (nextRect) {
                        rdpSurfaceRectByBlockRef.current.set(block.id, nextRect);
                      } else {
                        rdpSurfaceRectByBlockRef.current.delete(block.id);
                      }
                      setCaptureContextVersion((value) => value + 1);
                    }
                    const sessionId = rdpStreamSessionByBlockRef.current.get(block.id) ?? block.sessionId;
                    if (!sessionId) {
                      return;
                    }
                    void api.rdpSessionFocus(sessionId, focus).catch((error) => {
                      appendWorkspaceLog("warn", "Falha ao atualizar foco RDP", getError(error));
                    });
                  },
                  onPasswordDraftChange: (value) =>
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "rdp"
                          ? { ...item, passwordDraft: value }
                          : item,
                      ),
                    ),
                  onSavePasswordChange: (checked) =>
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "rdp"
                          ? { ...item, savePasswordChoice: checked }
                          : item,
                      ),
                    ),
                  onSubmitPassword: () => {
                    const password = block.passwordDraft.trim();
                    if (!password) {
                      setBlocks((current) =>
                        current.map((item) =>
                          item.id === block.id && item.kind === "rdp"
                            ? { ...item, connectError: "Informe a senha para continuar." }
                            : item,
                        ),
                      );
                      return;
                    }
                    clearBlockRetryTimers(block.id);
                    void resolvePendingRdpConnection(block.id, {
                      passwordOverride: password,
                      saveAuthChoice: block.savePasswordChoice,
                      retryAttempt: 0,
                    });
                  },
                })
              : null}

            {block.kind === "editor"
              ? editorWorkspace.render({
                  block,
                  onChange: (value) =>
                    setBlocks((current) =>
                      current.map((item) =>
                        item.id === block.id && item.kind === "editor" && item.view === "text"
                          ? { ...item, content: value, dirty: true }
                          : item,
                      ),
                    ),
                  onSave: () => void saveEditorBlock(block.id),
                  onOpenExternal: () => void openEditorBlockExternal(block.id),
                })
              : null}
          </WorkspaceBlockController>
        ))}
      </div>

      <AppDialog
        open={!!sftpCreateDialog}
        title={sftpCreateDialog?.mode === "mkdir" ? "Criar pasta" : "Criar arquivo"}
        description={
          sftpCreateDialog
            ? `Destino: ${sftpCreateDialog.basePath || (sftpCreateDialog.sourceId === "local" ? "." : "/")}`
            : undefined
        }
        onClose={closeSftpCreateDialog}
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-border/60 px-3 py-1.5 text-xs text-foreground/90 transition hover:bg-secondary disabled:opacity-60"
              disabled={!!sftpCreateDialog?.busy}
              onClick={closeSftpCreateDialog}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
              disabled={!!sftpCreateDialog?.busy}
              onClick={() => void submitSftpCreateDialog()}
            >
              {sftpCreateDialog?.mode === "mkdir" ? "Criar pasta" : "Criar arquivo"}
            </button>
          </div>
        }
      >
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {sftpCreateDialog?.mode === "mkdir"
              ? "Informe o nome da nova pasta."
              : "Informe o nome do novo arquivo."}
          </p>
          <input
            autoFocus
            value={sftpCreateDialog?.value ?? ""}
            onChange={(event) =>
              setSftpCreateDialog((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitSftpCreateDialog();
              }
            }}
            placeholder={sftpCreateDialog?.mode === "mkdir" ? "ex: docs" : "ex: notes.txt"}
            className="h-9 w-full rounded-lg border border-border/60 bg-secondary/50 px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </AppDialog>

      <AppDialog
        open={selectConnectionDialogOpen}
        title={t.workspace.selectConnectionTitle}
        description={t.workspace.selectConnectionDescription}
        onClose={() => {
          setSelectConnectionDialogOpen(false);
          setSelectConnectionSearch("");
        }}
      >
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={selectConnectionSearch}
              onChange={(event) => setSelectConnectionSearch(event.target.value)}
              placeholder={t.workspace.selectConnectionSearchPlaceholder}
              className="h-9 w-full rounded-lg border border-border/60 bg-secondary/50 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div className="max-h-[420px] overflow-auto rounded-xl border border-border/40">
            {selectableConnections.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                {t.workspace.selectConnectionEmpty}
              </div>
            ) : (
              selectableConnections.map((profile) => {
                const protocols = profileProtocols(profile);
                const primary = primaryProfileProtocol(profile);
                const Icon = connectionProtocolIcon[primary];
                const hasSsh = protocols.includes("ssh");
                const fileProtocol = resolveWorkspaceFileProtocol(profile);
                const quickLabel =
                  hasSsh && fileProtocol === "sftp"
                    ? t.home.connections.protocolBoth
                    : protocols.includes("rdp")
                      ? t.home.connections.protocolRdp
                      : fileProtocol === "sftp"
                        ? t.home.connections.protocolSftp
                        : fileProtocol === "ftp"
                          ? t.home.connections.protocolFtp
                          : fileProtocol === "ftps"
                            ? t.home.connections.protocolFtps
                            : fileProtocol === "smb"
                              ? t.home.connections.protocolSmb
                              : t.home.connections.protocolSsh;

                return (
                  <button
                    key={profile.id}
                    type="button"
                    className="flex w-full items-center gap-3 border-b border-border/15 px-4 py-3 text-left transition-colors hover:bg-accent/40 last:border-b-0"
                    onClick={() => {
                      openConnectionInWorkspace(profile, { openSftpWithSsh: true });
                      setSelectConnectionDialogOpen(false);
                      setSelectConnectionSearch("");
                    }}
                  >
                    <div
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                        connectionProtocolColor[primary],
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{profile.name}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {profile.host}:{profile.port} · {profile.username}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                          connectionProtocolColor[primary],
                        )}
                      >
                        {quickLabel}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {protocols.map((item) => item.toUpperCase()).join(" · ")}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={createBlockModalOpen}
        title={t.workspace.newBlockTitle}
        description={t.workspace.newBlockDescription}
        onClose={() => setCreateBlockModalOpen(false)}
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-border/60 px-3 py-1.5 text-xs text-foreground/90 transition hover:bg-secondary"
              onClick={() => setCreateBlockModalOpen(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90"
              onClick={() => void createBlock()}
            >
              Criar Bloco
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t.workspace.createLocalTitle}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                className={cn(
                  "rounded-lg border p-2 text-xs transition",
                  createBlockKind === "terminal" && createSourceDraft === "local"
                    ? "border-primary/60 bg-primary/15 text-primary"
                    : "border-border/50 bg-secondary/50 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
                onClick={() => {
                  setCreateBlockKind("terminal");
                  setCreateSourceDraft("local");
                }}
              >
                <TerminalSquare className="mx-auto h-4 w-4" />
                <p className="mt-1">{t.workspace.localTerminal}</p>
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-lg border p-2 text-xs transition",
                  createBlockKind === "sftp" && createSourceDraft === "local"
                    ? "border-primary/60 bg-primary/15 text-primary"
                    : "border-border/50 bg-secondary/50 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
                onClick={() => {
                  setCreateBlockKind("sftp");
                  setCreateSourceDraft("local");
                }}
              >
                <Folder className="mx-auto h-4 w-4" />
                <p className="mt-1">{t.workspace.localSftp}</p>
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-lg border p-2 text-xs transition",
                  createBlockKind === "editor"
                    ? "border-primary/60 bg-primary/15 text-primary"
                    : "border-border/50 bg-secondary/50 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
                onClick={() => {
                  setCreateBlockKind("editor");
                  setCreateSourceDraft("local");
                }}
              >
                <FileText className="mx-auto h-4 w-4" />
                <p className="mt-1">{t.workspace.localEditor}</p>
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t.workspace.createRemoteTitle}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={terminalRemoteSourceOptions.length === 0}
                className={cn(
                  "rounded-lg border p-2 text-xs transition disabled:cursor-not-allowed disabled:opacity-45",
                  createBlockKind === "terminal" && createSourceDraft !== "local"
                    ? "border-primary/60 bg-primary/15 text-primary"
                    : "border-border/50 bg-secondary/50 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
                onClick={() => {
                  const nextSource = terminalRemoteSourceOptions[0]?.id;
                  if (!nextSource) {
                    return;
                  }
                  setCreateBlockKind("terminal");
                  setCreateSourceDraft(nextSource);
                }}
              >
                <TerminalSquare className="mx-auto h-4 w-4" />
                <p className="mt-1">{t.workspace.remoteTerminal}</p>
              </button>
              <button
                type="button"
                disabled={remoteFileSourceOptions.length === 0}
                className={cn(
                  "rounded-lg border p-2 text-xs transition disabled:cursor-not-allowed disabled:opacity-45",
                  createBlockKind === "sftp" && createSourceDraft !== "local"
                    ? "border-primary/60 bg-primary/15 text-primary"
                    : "border-border/50 bg-secondary/50 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
                onClick={() => {
                  const nextSource = remoteFileSourceOptions[0]?.id;
                  if (!nextSource) {
                    return;
                  }
                  setCreateBlockKind("sftp");
                  setCreateSourceDraft(nextSource);
                }}
              >
                <Folder className="mx-auto h-4 w-4" />
                <p className="mt-1">{t.workspace.remoteFiles}</p>
              </button>
              <button
                type="button"
                disabled={rdpSourceOptions.length === 0}
                className={cn(
                  "rounded-lg border p-2 text-xs transition disabled:cursor-not-allowed disabled:opacity-45",
                  createBlockKind === "rdp"
                    ? "border-primary/60 bg-primary/15 text-primary"
                    : "border-border/50 bg-secondary/50 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
                onClick={() => {
                  const nextSource = rdpSourceOptions[0]?.id;
                  if (!nextSource) {
                    return;
                  }
                  setCreateBlockKind("rdp");
                  setCreateSourceDraft(nextSource);
                }}
              >
                <Monitor className="mx-auto h-4 w-4" />
                <p className="mt-1">{t.workspace.remoteRdp}</p>
              </button>
            </div>
          </div>

          {selectedCreateSourceOptions.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground/90">{t.workspace.sourceLabel}</p>
              <select
                className="h-9 w-full rounded-md border border-border/60 bg-secondary/40 px-2 text-xs text-foreground"
                value={createSourceDraft}
                onChange={(event) => setCreateSourceDraft(event.target.value)}
              >
                {selectedCreateSourceOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {createBlockKind === "terminal"
                  ? t.workspace.sourceHelpTerminal
                  : createBlockKind === "sftp"
                    ? t.workspace.sourceHelpFiles
                    : t.workspace.sourceHelpRdp}
              </p>
            </div>
          ) : null}
        </div>
      </AppDialog>
    </div>
  );
}


