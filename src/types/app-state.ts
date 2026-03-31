export interface PaneState {
  sourceId: string;
  path: string;
  entries: import("@/types/termopen").SftpEntry[];
  loading: boolean;
  selectedFile: string | null;
}

export interface EditorBuffer {
  sourceId: string;
  path: string;
  content: string;
  view: import("@/functions/editor-file-utils").EditorViewMode;
  language: string;
  mimeType: string | null;
  mediaBase64: string | null;
  previewError: string | null;
  sizeBytes: number | null;
  dirty: boolean;
}
