export const MAX_CONNECT_RETRY_ATTEMPTS = 3;

export type FileSourceProtocol = "sftp" | "ftp" | "ftps" | "smb";

export interface ProfileSourceRef {
  profileId: string;
  protocol: FileSourceProtocol;
}

export function isTimeoutErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("time out") ||
    normalized.includes("etimedout") ||
    normalized.includes("tempo esgotado")
  );
}

export function createId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

export function formatProfileSourceId(profileId: string, protocol: FileSourceProtocol = "sftp"): string {
  return `profile:${protocol}:${profileId}`;
}

export function parseProfileSourceRef(sourceId?: string): ProfileSourceRef | null {
  if (!sourceId || !sourceId.startsWith("profile:")) {
    return null;
  }

  const payload = sourceId.slice("profile:".length).trim();
  if (!payload) {
    return null;
  }

  const parts = payload.split(":").filter((item) => item.length > 0);
  if (parts.length === 1) {
    return {
      profileId: parts[0],
      protocol: "sftp",
    };
  }

  const [rawProtocol, ...rest] = parts;
  const profileId = rest.join(":").trim();
  if (!profileId) {
    return null;
  }

  if (rawProtocol === "sftp" || rawProtocol === "ftp" || rawProtocol === "ftps" || rawProtocol === "smb") {
    return {
      profileId,
      protocol: rawProtocol,
    };
  }

  return null;
}

export function parseProfileSourceId(sourceId?: string): string | null {
  return parseProfileSourceRef(sourceId)?.profileId ?? null;
}
