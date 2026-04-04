import type { WorkspaceBlockLayout } from "@/components/workspace/workspace-block-controller";
import type { EditorViewMode } from "@/functions/editor-file-utils";
import type { SftpEntry } from "@/types/openptl";

export type WorkspaceKind = "terminal" | "sftp" | "rdp" | "editor";
export type WorkspaceMode = "free";
export type SortKey = "name" | "size" | "permissions" | "modified_at";
export type SortDirection = "asc" | "desc";
export type ConnectStage = "ready" | "connecting" | "verifying_fingerprint" | "awaiting_password" | "error";

export interface WorkspaceTabPageProps {
  tabId: string;
  initialBlock?: "terminal" | "sftp" | "rdp";
  initialSourceId?: string;
  initialOpenFiles?: boolean;
}

interface BaseBlock {
  id: string;
  kind: WorkspaceKind;
  title: string;
  layout: WorkspaceBlockLayout;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
}

export interface PendingHostChallenge {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  message: string;
}

export interface TerminalBlock extends BaseBlock {
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

export interface SftpBlock extends BaseBlock {
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

export interface EditorBlock extends BaseBlock {
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

export interface RdpBlock extends BaseBlock {
  kind: "rdp";
  profileId: string;
  sessionId: string | null;
  connectStage: ConnectStage;
  connectMessage: string;
  connectError: string | null;
  passwordDraft: string;
  savePasswordChoice: boolean;
  retryAttempt: number;
  retryInSeconds: number | null;
  imageWidth: number;
  imageHeight: number;
  capturedAt: number | null;
}

export type WorkspaceBlock = TerminalBlock | SftpBlock | RdpBlock | EditorBlock;
export type WorkspaceLogLevel = "info" | "success" | "warn" | "error";
export type TransferStatus = "queued" | "running" | "completed" | "error";

export interface WorkspaceLogEntry {
  id: string;
  timestamp: number;
  level: WorkspaceLogLevel;
  message: string;
  details?: string;
}

export interface TransferItem {
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

export interface BlockTransferItem {
  transfer: TransferItem;
  direction: "outgoing" | "incoming";
}

export interface DragPayload {
  sourceBlockId: string;
  sourceId: string;
  path: string;
  isDir: boolean;
}

export type SftpContextAction =
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

export interface SftpContextMenuState {
  x: number;
  y: number;
  entry: SftpEntry | null;
  pointerX: number;
  pointerY: number;
}
