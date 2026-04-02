import { normalizeRemotePath } from "@/functions/common";
import { api } from "@/lib/tauri";
import { parseProfileSourceRef } from "@/pages/tabs/workspace/natives/runtime";
import type { SftpEntry } from "@/types/termopen";

const PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024;

type RemoteProfileProtocol = "ftp" | "ftps" | "smb";

interface RemoteProfileSourceRef {
  profileId: string;
  protocol: RemoteProfileProtocol;
}

function resolveRemoteProfileSource(sourceId: string): RemoteProfileSourceRef | null {
  const profile = parseProfileSourceRef(sourceId);
  if (!profile) {
    return null;
  }
  if (profile.protocol !== "ftp" && profile.protocol !== "ftps" && profile.protocol !== "smb") {
    return null;
  }
  return {
    profileId: profile.profileId,
    protocol: profile.protocol,
  };
}

export async function listSourceEntries(sourceId: string, path: string): Promise<SftpEntry[]> {
  if (sourceId === "local") {
    return api.localList(path.trim() || null);
  }
  const remoteProfileSource = resolveRemoteProfileSource(sourceId);
  if (remoteProfileSource) {
    return api.remoteProfileList(
      remoteProfileSource.profileId,
      remoteProfileSource.protocol,
      normalizeRemotePath(path),
    );
  }
  return api.sftpList(sourceId, normalizeRemotePath(path));
}

export async function readSourceFile(sourceId: string, path: string): Promise<string> {
  if (sourceId === "local") {
    return api.localRead(path);
  }
  const remoteProfileSource = resolveRemoteProfileSource(sourceId);
  if (remoteProfileSource) {
    return api.remoteProfileRead(
      remoteProfileSource.profileId,
      remoteProfileSource.protocol,
      normalizeRemotePath(path),
    );
  }
  return api.sftpRead(sourceId, path);
}

export async function readSourceTextChunk(sourceId: string, path: string, offset: number) {
  if (sourceId === "local") {
    return api.localReadChunk(path, offset);
  }
  const remoteProfileSource = resolveRemoteProfileSource(sourceId);
  if (remoteProfileSource) {
    return api.remoteProfileReadChunk(
      remoteProfileSource.profileId,
      remoteProfileSource.protocol,
      normalizeRemotePath(path),
      offset,
    );
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
  const remoteProfileSource = resolveRemoteProfileSource(sourceId);
  if (remoteProfileSource) {
    await api.remoteProfileWrite(
      remoteProfileSource.profileId,
      remoteProfileSource.protocol,
      normalizeRemotePath(path),
      content,
    );
    return;
  }
  await api.sftpWrite(sourceId, path, content);
}

export async function renameSourceEntry(sourceId: string, fromPath: string, toPath: string): Promise<void> {
  if (sourceId === "local") {
    await api.localRename(fromPath, toPath);
    return;
  }
  const remoteProfileSource = resolveRemoteProfileSource(sourceId);
  if (remoteProfileSource) {
    await api.remoteProfileRename(
      remoteProfileSource.profileId,
      remoteProfileSource.protocol,
      normalizeRemotePath(fromPath),
      normalizeRemotePath(toPath),
    );
    return;
  }
  await api.sftpRename(sourceId, fromPath, toPath);
}

export async function deleteSourceEntry(sourceId: string, path: string, isDir: boolean): Promise<void> {
  if (sourceId === "local") {
    await api.localDelete(path, isDir);
    return;
  }
  const remoteProfileSource = resolveRemoteProfileSource(sourceId);
  if (remoteProfileSource) {
    await api.remoteProfileDelete(
      remoteProfileSource.profileId,
      remoteProfileSource.protocol,
      normalizeRemotePath(path),
      isDir,
    );
    return;
  }
  await api.sftpDelete(sourceId, path, isDir);
}

export async function createSourceFolder(sourceId: string, path: string): Promise<void> {
  if (sourceId === "local") {
    await api.localMkdir(path);
    return;
  }
  const remoteProfileSource = resolveRemoteProfileSource(sourceId);
  if (remoteProfileSource) {
    await api.remoteProfileMkdir(
      remoteProfileSource.profileId,
      remoteProfileSource.protocol,
      normalizeRemotePath(path),
    );
    return;
  }
  await api.sftpMkdir(sourceId, path);
}

export async function createSourceFile(sourceId: string, path: string): Promise<void> {
  if (sourceId === "local") {
    await api.localCreateFile(path);
    return;
  }
  const remoteProfileSource = resolveRemoteProfileSource(sourceId);
  if (remoteProfileSource) {
    await api.remoteProfileCreateFile(
      remoteProfileSource.profileId,
      remoteProfileSource.protocol,
      normalizeRemotePath(path),
    );
    return;
  }
  await api.sftpCreateFile(sourceId, path);
}

export async function readSourceBinaryPreview(sourceId: string, path: string) {
  if (sourceId === "local") {
    return api.localReadBinaryPreview(path, PREVIEW_LIMIT_BYTES);
  }
  const remoteProfileSource = resolveRemoteProfileSource(sourceId);
  if (remoteProfileSource) {
    return api.remoteProfileReadBinaryPreview(
      remoteProfileSource.profileId,
      remoteProfileSource.protocol,
      normalizeRemotePath(path),
      PREVIEW_LIMIT_BYTES,
    );
  }
  return api.sftpReadBinaryPreview(sourceId, path, PREVIEW_LIMIT_BYTES);
}
