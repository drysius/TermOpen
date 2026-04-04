import type { ConnectionProfile, ConnectionProtocol } from "@/types/openptl";
import { logFrontendDebug } from "@/lib/debug-logs";

export function getError(error: unknown): string {
  if (error instanceof Error) {
    logFrontendDebug("error", error.message || "Erro desconhecido", {
      source: "frontend.catch",
      context: error.stack ?? null,
    });
    return error.message;
  }
  if (typeof error === "string") {
    logFrontendDebug("error", error, { source: "frontend.catch" });
    return error;
  }
  logFrontendDebug("error", "Erro desconhecido", { source: "frontend.catch" });
  return "Erro desconhecido";
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
