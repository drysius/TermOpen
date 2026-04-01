import { normalizeRemotePath } from "@/functions/common";
import { api } from "@/lib/tauri";
import type { SftpEntry } from "@/types/termopen";

const PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024;

export async function listSourceEntries(sourceId: string, path: string): Promise<SftpEntry[]> {
  if (sourceId === "local") {
    return api.localList(path.trim() || null);
  }
  return api.sftpList(sourceId, normalizeRemotePath(path));
}

export async function readSourceFile(sourceId: string, path: string): Promise<string> {
  if (sourceId === "local") {
    return api.localRead(path);
  }
  return api.sftpRead(sourceId, path);
}

export async function readSourceTextChunk(sourceId: string, path: string, offset: number) {
  if (sourceId === "local") {
    return api.localReadChunk(path, offset);
  }
  return api.sftpReadChunk(sourceId, path, offset);
}

export function decodeBase64Chunk(value: string): Uint8Array {
  const raw = atob(value);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}

export async function writeSourceFile(sourceId: string, path: string, content: string): Promise<void> {
  if (sourceId === "local") {
    await api.localWrite(path, content);
    return;
  }
  await api.sftpWrite(sourceId, path, content);
}

export async function renameSourceEntry(sourceId: string, fromPath: string, toPath: string): Promise<void> {
  if (sourceId === "local") {
    await api.localRename(fromPath, toPath);
    return;
  }
  await api.sftpRename(sourceId, fromPath, toPath);
}

export async function deleteSourceEntry(sourceId: string, path: string, isDir: boolean): Promise<void> {
  if (sourceId === "local") {
    await api.localDelete(path, isDir);
    return;
  }
  await api.sftpDelete(sourceId, path, isDir);
}

export async function createSourceFolder(sourceId: string, path: string): Promise<void> {
  if (sourceId === "local") {
    await api.localMkdir(path);
    return;
  }
  await api.sftpMkdir(sourceId, path);
}

export async function createSourceFile(sourceId: string, path: string): Promise<void> {
  if (sourceId === "local") {
    await api.localCreateFile(path);
    return;
  }
  await api.sftpCreateFile(sourceId, path);
}

export async function readSourceBinaryPreview(sourceId: string, path: string) {
  if (sourceId === "local") {
    return api.localReadBinaryPreview(path, PREVIEW_LIMIT_BYTES);
  }
  return api.sftpReadBinaryPreview(sourceId, path, PREVIEW_LIMIT_BYTES);
}
