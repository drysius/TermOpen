import type { ConnectionProfile, ConnectionProtocol } from "@/types/openptl";
import { logFrontendDebug } from "@/lib/debug-logs";
import { resolveBackendMessage } from "@/functions/backend-message";

export function getError(error: unknown): string {
  if (error instanceof Error) {
    const resolved = resolveBackendMessage(error.message || "backend_error");
    logFrontendDebug("error", resolved, {
      source: "frontend.catch",
      context: error.stack ?? null,
    });
    return resolved;
  }
  if (typeof error === "string") {
    const resolved = resolveBackendMessage(error);
    logFrontendDebug("error", resolved, { source: "frontend.catch" });
    return resolved;
  }
  if (error && typeof error === "object" && "message" in error) {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string") {
      const resolved = resolveBackendMessage(maybeMessage);
      logFrontendDebug("error", resolved, { source: "frontend.catch" });
      return resolved;
    }
  }
  const resolved = resolveBackendMessage("backend_error");
  logFrontendDebug("error", resolved, { source: "frontend.catch" });
  return resolved;
}

export function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || "file";
}

export function joinPath(base: string, name: string): string {
  if (!base) {
    return name;
  }
  if (base.includes("\\")) {
    return `${base.replace(/[\\/]$/, "")}\\${name}`;
  }
  return `${base.replace(/\/$/, "")}/${name}`;
}

export function joinRemotePath(base: string, name: string): string {
  const normalizedBase = normalizeRemotePath(base);
  const cleanName = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalizedBase === "/") {
    return `/${cleanName}`;
  }
  return `${normalizedBase.replace(/\/$/, "")}/${cleanName}`;
}

export function normalizeRemotePath(path: string): string {
  const normalized = (path || "").trim().replace(/\\/g, "/");
  if (!normalized) {
    return "/";
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function supportsProtocol(profile: ConnectionProfile, protocol: ConnectionProtocol): boolean {
  const rawProtocols = profile.protocols?.length
    ? profile.protocols
    : profile.kind === "host"
      ? ["ssh"]
      : profile.kind === "sftp"
        ? ["sftp"]
        : profile.kind === "rdp"
          ? ["rdp"]
        : ["ssh", "sftp"];
  const protocols = rawProtocols.includes("rdp") ? (["rdp"] as ConnectionProtocol[]) : rawProtocols;
  if (protocol === "sftp") {
    return protocols.some(
      (item) => item === "sftp" || item === "ftp" || item === "ftps" || item === "smb",
    );
  }
  return protocols.includes(protocol);
}

export function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 90);
}
