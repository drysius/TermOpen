import { Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FileText,
  Folder,
  Maximize2,
  Minimize2,
  Monitor,
  Plus,
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
import { Dialog } from "@/components/ui/dialog";
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
  RemoteTransferEndpoint,
  RdpInputBatch,
  RdpInputEvent,
  RdpSessionControlEvent,
  SftpEntry,
} from "@/types/termopen";
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

export function WorkspaceTabPage({ tabId, initialBlock, initialSourceId }: WorkspaceTabPageProps) {
  const t = useT();
  const sessions = useAppStore((state) => state.sessions);
  const connections = useAppStore((state) => state.connections);
  const settings = useAppStore((state) => state.settings);
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
      ? (workspaceSnapshot.blocks as WorkspaceBlock[]).filter(
          (item) => (item as { kind?: string }).kind !== "logs",
        )
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
  const [createBlockKind, setCreateBlockKind] = useState<"terminal" | "sftp" | "rdp" | "editor">("terminal");
  const [createSourceDraft, setCreateSourceDraft] = useState("local");
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(initialBlocks[0]?.id ?? null);
  const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null);
  const [snapPreview, setSnapPreview] = useState<WorkspaceBlockLayout | null>(null);
  const connectRetryTimersRef = useRef<Record<string, { retryTimer: number; countdownTimer: number }>>({});
  const rdpStreamSessionByBlockRef = useRef<Map<string, string>>(new Map());
  const rdpStreamTokenByBlockRef = useRef<Map<string, string>>(new Map());
  const rdpInputQueueByBlockRef = useRef<Map<string, RdpInputEvent[]>>(new Map());
  const rdpInputFlushTimerByBlockRef = useRef<Map<string, number>>(new Map());
  const rdpLastFrameAtByBlockRef = useRef<Map<string, number>>(new Map());

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
    if (blocks.length === 0) {
      if (focusedBlockId !== null) {
        setFocusedBlockId(null);
      }
      return;
    }

    const stillExists = focusedBlockId ? blocks.some((block) => block.id === focusedBlockId) : false;
    if (stillExists) {
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
  const createSourceOptions = useMemo(() => {
    if (createBlockKind === "terminal") {
      return [
        { id: "local", label: "Local Terminal" },
        ...sshProfiles.map((profile) => ({
          id: formatProfileSourceId(profile.id, "sftp"),
          label: `${profile.host} (${profile.username})`,
        })),
      ];
    }
    if (createBlockKind === "sftp") {
      return [
        { id: "local", label: "Local File System" },
        ...sftpProfileSourceOptions,
        ...externalFileProfileSourceOptions,
      ];
    }
    if (createBlockKind === "rdp") {
      return rdpProfiles.map((profile) => ({
        id: formatProfileSourceId(profile.id, "sftp"),
        label: `${profile.host} (${profile.username})`,
      }));
    }
    return [];
  }, [createBlockKind, externalFileProfileSourceOptions, rdpProfiles, sftpProfileSourceOptions, sshProfiles]);

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
      return current.map((block) => (block.id === id ? { ...block, zIndex: top + 1 } : block));
    });
  }, []);

  const closeBlock = useCallback(
    (id: string) => {
      const targetBlock = blocksRef.current.find((block) => block.id === id);
      const remainingBlocks = blocksRef.current.filter((block) => block.id !== id);
      clearBlockRetryTimers(id);
      rdpStreamTokenByBlockRef.current.delete(id);
      rdpLastFrameAtByBlockRef.current.delete(id);

      if (targetBlock?.kind === "rdp") {
        const sessionId = rdpStreamSessionByBlockRef.current.get(id) ?? targetBlock.sessionId;
        if (sessionId) {
          void api.rdpSessionStop(sessionId).catch(() => undefined);
        }
      }

      const flushTimer = rdpInputFlushTimerByBlockRef.current.get(id);
      if (flushTimer) {
        window.clearTimeout(flushTimer);
      }
      rdpInputFlushTimerByBlockRef.current.delete(id);
      rdpInputQueueByBlockRef.current.delete(id);
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
        inputEvents?: RdpInputEvent[];
      },
    ) => {
      const target = blocksRef.current.find((item): item is RdpBlock => item.id === blockId && item.kind === "rdp");
      if (!target) {
        return;
      }

      const inputEvents = options?.inputEvents ?? [];
      if (inputEvents.length > 0) {
        const sessionId = rdpStreamSessionByBlockRef.current.get(blockId);
        if (!sessionId) {
          return;
        }

        const queue = rdpInputQueueByBlockRef.current.get(blockId) ?? [];
        queue.push(...inputEvents.slice(0, 32));
        if (queue.length > 96) {
          queue.splice(0, queue.length - 96);
        }
        rdpInputQueueByBlockRef.current.set(blockId, queue);

        if (!rdpInputFlushTimerByBlockRef.current.has(blockId)) {
          const timer = window.setTimeout(() => {
            rdpInputFlushTimerByBlockRef.current.delete(blockId);
            const pending = rdpInputQueueByBlockRef.current.get(blockId) ?? [];
            rdpInputQueueByBlockRef.current.set(blockId, []);
            const currentSessionId = rdpStreamSessionByBlockRef.current.get(blockId);
            if (!currentSessionId || pending.length === 0) {
              return;
            }
            const batch: RdpInputBatch = { events: pending };
            void api.rdpInputBatch(currentSessionId, batch).catch((error) => {
              appendWorkspaceLog("warn", "Falha ao enviar input RDP", getError(error));
            });
          }, 14);
          rdpInputFlushTimerByBlockRef.current.set(blockId, timer);
        }
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
      const pendingFlush = rdpInputFlushTimerByBlockRef.current.get(blockId);
      if (pendingFlush) {
        window.clearTimeout(pendingFlush);
        rdpInputFlushTimerByBlockRef.current.delete(blockId);
      }
      rdpLastFrameAtByBlockRef.current.delete(blockId);
      rdpInputQueueByBlockRef.current.set(blockId, []);
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
      rdpInputFlushTimerByBlockRef.current.forEach((timer) => {
        window.clearTimeout(timer);
      });
      rdpInputFlushTimerByBlockRef.current.clear();
      rdpInputQueueByBlockRef.current.clear();
      rdpStreamTokenByBlockRef.current.clear();
      rdpLastFrameAtByBlockRef.current.clear();
      rdpStreamSessionByBlockRef.current.forEach((sessionId) => {
        void api.rdpSessionStop(sessionId).catch(() => undefined);
      });
      rdpStreamSessionByBlockRef.current.clear();
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
    initialBlock,
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
      blocks.map((block) => ({
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
      <div className="flex h-10 items-center gap-1 border-b border-white/10 px-2">
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded border border-white/15 text-zinc-300 transition hover:border-cyan-400/60 hover:bg-zinc-900"
          onClick={() => {
            setCreateBlockKind("terminal");
            setCreateSourceDraft("local");
            setCreateBlockModalOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
        </button>

        <div className="ml-auto flex items-center gap-2 text-xs text-zinc-300">
          {activeTransfers > 0 ? (
            <div className="flex items-center gap-2 rounded border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-cyan-200">
              <Folder className="h-3.5 w-3.5 animate-pulse" />
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

        {snapPreview ? (
          <div
            className="pointer-events-none absolute rounded-md border border-cyan-400/70 bg-cyan-500/12 shadow-[0_0_24px_rgba(34,211,238,0.35)]"
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
            {block.kind === "terminal"
              ? terminalWorkspace.render({
                  block,
                  sessionOptions: terminalOptions,
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
                  onFocus: () => focusBlock(block.id),
                  onPasteClipboardFiles: () => {
                    void pasteClipboardFilesIntoSftpBlock(block.id);
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
                  onDropTransfer: (payload, targetPath) => void transferBetweenBlocks(payload, block.id, targetPath),
                  onDropLocalPaths: (paths, targetPath) => {
                    void dropLocalPathsIntoSftpBlock(block.id, targetPath, paths);
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
                  onInteract: (inputEvents) => {
                    if (inputEvents.length === 0) {
                      return;
                    }
                    clearBlockRetryTimers(block.id);
                    void resolvePendingRdpConnection(block.id, {
                      retryAttempt: 0,
                      inputEvents,
                    });
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
              className="rounded bg-cyan-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-600"
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
                  ? "border-cyan-400/60 bg-cyan-600/20 text-cyan-100"
                  : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-cyan-400/40",
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
                  ? "border-cyan-400/60 bg-cyan-600/20 text-cyan-100"
                  : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-cyan-400/40",
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
                createBlockKind === "rdp"
                  ? "border-cyan-400/60 bg-cyan-600/20 text-cyan-100"
                  : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-cyan-400/40",
              )}
              onClick={() => setCreateBlockKind("rdp")}
            >
              <Monitor className="mx-auto h-4 w-4" />
              <p className="mt-1">RDP</p>
            </button>
            <button
              type="button"
              className={cn(
                "rounded border p-2 text-xs transition",
                createBlockKind === "editor"
                  ? "border-cyan-400/60 bg-cyan-600/20 text-cyan-100"
                  : "border-white/10 bg-zinc-900/60 text-zinc-300 hover:border-cyan-400/40",
              )}
              onClick={() => setCreateBlockKind("editor")}
            >
              <FileText className="mx-auto h-4 w-4" />
              <p className="mt-1">Editor</p>
            </button>
          </div>

          {createBlockKind === "terminal" || createBlockKind === "sftp" || createBlockKind === "rdp" ? (
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
                  : createBlockKind === "sftp"
                    ? "Escolha local ou host remoto para abrir o explorador SFTP."
                    : "Escolha um perfil remoto para abrir o bloco RDP."}
              </p>
            </div>
          ) : createBlockKind === "editor" ? (
            <p className="text-xs text-zinc-500">O editor abre arquivo local selecionado pelo sistema.</p>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
