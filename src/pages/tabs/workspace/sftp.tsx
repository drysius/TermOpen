import { ArrowDownAZ, ArrowUpAZ, FileText, Folder, MonitorUp, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import type { SftpEntry } from "@/types/termopen";

import type {
  BlockTransferItem,
  DragPayload,
  SftpBlock,
  SftpContextAction,
  SftpContextMenuState,
  SortDirection,
  SortKey,
} from "./types";
import type { WorkspaceBlockModule } from "./block-module";

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

function parseFileUriPath(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed || !trimmed.startsWith("file://")) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    let path = decodeURIComponent(parsed.pathname || "");
    if (!path) {
      return null;
    }
    // file:///C:/path -> C:/path on Windows.
    if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1);
    }
    return path;
  } catch {
    return null;
  }
}

function parseExternalLocalPaths(dataTransfer: DataTransfer): string[] {
  const paths = new Set<string>();

  const uriList = dataTransfer.getData("text/uri-list");
  if (uriList) {
    for (const line of uriList.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) {
        continue;
      }
      const parsed = parseFileUriPath(line);
      if (parsed) {
        paths.add(parsed);
      }
    }
  }

  for (const file of Array.from(dataTransfer.files ?? [])) {
    const candidate = (file as File & { path?: string }).path;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      paths.add(candidate.trim());
    }
  }

  return Array.from(paths);
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

  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/") || "/";
  if (normalized === "/") {
    return null;
  }
  const parent = parentDirectory(normalized);
  return parent || "/";
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
export interface SftpBlockViewProps {
  block: SftpBlock;
  sourceOptions: Array<{ id: string; label: string }>;
  transferItems: BlockTransferItem[];
  onFocus: () => void;
  onPasteClipboardFiles: () => void;
  onDropLocalPaths: (paths: string[], targetPath: string) => void;
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

export function SftpBlockView({
  block,
  sourceOptions,
  transferItems,
  onFocus,
  onPasteClipboardFiles,
  onDropLocalPaths,
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
    "inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground";
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
    const hasSessionBackedTerminal = block.sourceId === "local" || !block.sourceId.startsWith("profile:");
    return [
      { action: "refresh" as const, label: "Atualizar", disabled: false },
      { action: "copy_path" as const, label: "Copiar caminho", disabled: false },
      { action: "open_terminal" as const, label: "Abrir no terminal", disabled: !hasSessionBackedTerminal },
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
    () =>
      transferItems.filter(
        (item) => item.transfer.status === "running" || item.transfer.status === "queued",
      ).length,
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
      tabIndex={0}
      className="relative flex h-full min-h-0 flex-col outline-none"
      onMouseDown={(event) => {
        onFocus();
        const target = event.target as HTMLElement | null;
        if (!target) {
          return;
        }
        if (target.closest("input, textarea, select, button, [contenteditable='true']")) {
          return;
        }
        containerRef.current?.focus();
      }}
      onPaste={(event) => {
        if (!isConnected) {
          return;
        }
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable='true']")) {
          return;
        }
        event.preventDefault();
        onPasteClipboardFiles();
      }}
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
          return;
        }

        const localPaths = parseExternalLocalPaths(event.dataTransfer);
        if (localPaths.length > 0) {
          onDropLocalPaths(localPaths, block.path);
        }
      }}
    >
      <div className="grid grid-cols-[minmax(140px,0.9fr)_minmax(0,1.7fr)_auto] gap-2 border-b border-border/50 px-2 py-1.5">
        <select
          className="h-8 rounded border border-border/50 bg-background px-2 text-xs text-foreground"
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
            className="h-8 min-w-0 w-full rounded border border-border/50 bg-background px-2 text-xs text-foreground outline-none focus:border-primary/70"
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
            className="inline-flex h-8 w-8 items-center justify-center rounded border border-border/50 text-foreground/90 hover:border-primary/60 hover:bg-secondary"
            onClick={() => onRefresh(pathDraft, block.sourceId)}
            disabled={!isConnected}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", block.loading ? "animate-spin" : undefined)} />
          </button>
          <button
            ref={transferToggleRef}
            type="button"
            className={cn(
              "relative inline-flex h-8 w-8 items-center justify-center rounded border text-foreground/90",
              runningTransfers > 0
                ? "border-primary/50 bg-primary/10 text-primary hover:bg-primary/20"
                : "border-border/50 hover:border-primary/60 hover:bg-secondary",
            )}
            onClick={() => setTransferMenuOpen((current) => !current)}
            title="Transferencias deste bloco"
            disabled={!isConnected}
          >
            <MonitorUp className={cn("h-3.5 w-3.5", runningTransfers > 0 ? "animate-pulse" : undefined)} />
            {runningTransfers > 0 ? (
              <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
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
              className="fixed z-[12000] w-96 max-w-[78vw] rounded border border-border/60 bg-background/95 p-2 shadow-2xl shadow-black/40 backdrop-blur"
              style={{ left: transferMenuRect.left, top: transferMenuRect.top }}
            >
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Transferencias do bloco
              </p>
              {transferItems.length === 0 ? (
                <p className="rounded border border-border/50 bg-secondary/60 px-2 py-2 text-xs text-muted-foreground">
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
                          : item.transfer.status === "queued"
                            ? "text-amber-200"
                          : "text-primary";
                    const barColor =
                      item.transfer.status === "error"
                        ? "bg-red-500/70"
                        : item.transfer.status === "completed"
                          ? "bg-emerald-500/80"
                          : item.transfer.status === "queued"
                            ? "bg-amber-500/70"
                          : "bg-primary/80";

                    return (
                      <div key={`${item.direction}:${item.transfer.id}`} className="rounded border border-border/50 bg-secondary/60 p-2">
                        <div className="flex items-center gap-2">
                          {item.direction === "outgoing" ? (
                            <ArrowUpAZ className="h-3.5 w-3.5 text-primary" />
                          ) : (
                            <ArrowDownAZ className="h-3.5 w-3.5 text-emerald-300" />
                          )}
                          <p className="min-w-0 flex-1 truncate text-xs text-foreground">{item.transfer.label}</p>
                          <span className={cn("text-[11px] font-medium", statusColor)}>
                            {item.transfer.status === "running"
                              ? `${item.transfer.progress}%`
                              : item.transfer.status === "completed"
                                ? "Concluido"
                                : item.transfer.status === "queued"
                                  ? "Na fila"
                                : "Erro"}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
                          <div
                            className={cn("h-full transition-all", barColor)}
                            style={{ width: `${Math.max(2, Math.min(100, item.transfer.progress))}%` }}
                          />
                        </div>
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">{item.transfer.from}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{item.transfer.to}</p>
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
          <thead className="sticky top-0 z-10 bg-background/95">
            <tr className="border-b border-border/50">
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
                    "border-b border-border/30 text-foreground transition hover:bg-secondary/70",
                    "cursor-grab active:cursor-grabbing",
                    selected ? "bg-primary/10" : undefined,
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
                      return;
                    }

                    const localPaths = parseExternalLocalPaths(event.dataTransfer);
                    if (localPaths.length > 0) {
                      onDropLocalPaths(localPaths, entry.path);
                    }
                  }}
                >
                  <td className="px-2 py-1.5">
                    <span
                      data-entry-drag="true"
                      className="inline-flex items-center gap-2"
                    >
                      {entry.name === ".." ? (
                        <Folder className="h-3.5 w-3.5 text-primary" />
                      ) : entry.is_dir ? (
                        <Folder className="h-3.5 w-3.5 text-primary" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="truncate">{entry.name}</span>
                    </span>
                  </td>
                  {showPermissions ? (
                    <td className="px-2 py-1.5 text-muted-foreground">{formatPermissions(entry.permissions)}</td>
                  ) : null}
                  {showSize ? (
                    <td className="px-2 py-1.5 text-right text-muted-foreground">{entry.is_dir ? "-" : formatSize(entry.size)}</td>
                  ) : null}
                  {showModified ? (
                    <td className="px-2 py-1.5 text-muted-foreground">{formatModified(entry.modified_at)}</td>
                  ) : null}
                </tr>
              );
            })}
            {displayEntries.length === 0 ? (
              <tr>
                <td
                  className="px-2 py-6 text-center text-muted-foreground"
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
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 p-3">
          <div className="w-full max-w-md rounded-lg border border-border/60 bg-background/95 p-4 shadow-2xl shadow-black/20">
            <div className="inline-flex items-center gap-2 text-sm text-foreground">
              {block.connectStage === "connecting" ? (
                <RefreshCw className="h-4 w-4 animate-spin text-primary" />
              ) : (
                <Folder className="h-4 w-4 text-primary" />
              )}
              <span>{block.connectMessage}</span>
            </div>
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              <p className={cn(block.connectStage === "connecting" ? "text-primary" : undefined)}>1. Conectando...</p>
              <p className={cn(block.connectStage === "verifying_fingerprint" ? "text-primary" : undefined)}>
                2. Verificando fingerprint...
              </p>
              <p
                className={cn(
                  block.connectStage === "awaiting_password" || block.connectStage === "error"
                    ? "text-primary"
                    : undefined,
                )}
              >
                3. Logando...
              </p>
            </div>

            {block.connectStage === "verifying_fingerprint" && block.hostChallenge ? (
              <div className="mt-3 rounded border border-border/50 bg-secondary/70 p-3 text-xs text-foreground/90">
                <p className="font-medium text-foreground">{block.hostChallenge.message}</p>
                <p className="mt-1">
                  {block.hostChallenge.host}:{block.hostChallenge.port}
                </p>
                <p className="mt-1 break-all text-muted-foreground">
                  {block.hostChallenge.keyType} {block.hostChallenge.fingerprint}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded border border-primary/50 bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                    onClick={onTrustHost}
                  >
                    Confiar e continuar
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border/70 px-2 py-1 text-xs text-foreground/90 hover:bg-secondary"
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
                  className="h-9 w-full rounded border border-border/60 bg-secondary/70 px-2 text-sm text-foreground outline-none focus:border-primary/60"
                  placeholder="Senha SSH/SFTP"
                  onChange={(event) => onPasswordDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      onSubmitPassword();
                    }
                  }}
                />
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
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
                    className="rounded border border-primary/50 bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                    onClick={onSubmitPassword}
                  >
                    Logar
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border/70 px-2 py-1 text-xs text-foreground/90 hover:bg-secondary"
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
                className="absolute z-[12001] w-56 rounded border border-border/60 bg-background/95 p-1 shadow-2xl shadow-black/40 backdrop-blur"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                {menuItems.map((item) => (
                  <button
                    key={item.action}
                    type="button"
                    className={cn(
                      "flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-foreground transition",
                      item.disabled ? "cursor-not-allowed opacity-40" : "hover:bg-secondary",
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

const sftpWorkspaceModule: WorkspaceBlockModule<SftpBlockViewProps> = {
  name: "sftp",
  description: "Bloco de navegador SFTP/local com transferências e menu contextual.",
  render: (props) => <SftpBlockView {...props} />,
  onNotFound: ({ blockId, action }) => `SFTP não encontrado (${action}) [${blockId}]`,
  onFailureLoad: ({ blockId, action }) => `Falha no SFTP (${action}) [${blockId}]`,
  onDropDownSelect: ({ blockId, action, value }) => `SFTP dropdown (${action}) [${blockId}] => ${value}`,
  onStatusChange: ({ blockId, action, status }) =>
    `Estado do SFTP atualizado (${action}) [${blockId}] => ${status}`,
};

export default sftpWorkspaceModule;


