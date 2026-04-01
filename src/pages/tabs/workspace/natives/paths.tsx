import { joinPath, joinRemotePath } from "@/functions/common";

export function normalizeAnyPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function joinPathBySource(sourceId: string, base: string, name: string): string {
  if (sourceId === "local") {
    return joinPath(base, name);
  }
  return joinRemotePath(base, name);
}

export function joinRelativePathBySource(sourceId: string, base: string, relativePath: string): string {
  const segments = relativePath.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return base;
  }
  return segments.reduce((current, segment) => joinPathBySource(sourceId, current, segment), base);
}

export function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) {
    return normalized.startsWith("/") ? "/" : "";
  }
  return normalized.slice(0, idx);
}

export function shellQuote(path: string): string {
  return `"${path.replace(/(["\\$])/g, "\\$1")}"`;
}
