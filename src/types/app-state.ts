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
  dirty: boolean;
}
