export type EditorViewMode = "text" | "image" | "video" | "binary";

export interface EditorFileMeta {
  view: EditorViewMode;
  language: string;
  mimeType: string | null;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
};

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  sql: "sql",
  log: "plaintext",
  txt: "plaintext",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  xml: "xml",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
};

function getExtension(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() || normalized;
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) {
    return "";
  }
  return filename.slice(dot + 1).toLowerCase();
}

export function detectEditorFileMeta(path: string): EditorFileMeta {
  const extension = getExtension(path);

  const imageMime = IMAGE_MIME_BY_EXT[extension];
  if (imageMime) {
    return { view: "image", language: "plaintext", mimeType: imageMime };
  }

  const videoMime = VIDEO_MIME_BY_EXT[extension];
  if (videoMime) {
    return { view: "video", language: "plaintext", mimeType: videoMime };
  }

  const language = LANGUAGE_BY_EXT[extension];
  if (language) {
    return { view: "text", language, mimeType: "text/plain" };
  }

  if (!extension) {
    return { view: "text", language: "plaintext", mimeType: "text/plain" };
  }

  return { view: "binary", language: "plaintext", mimeType: null };
}

export function toDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
