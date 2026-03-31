import type { ConnectionProfile, ConnectionProtocol } from "@/types/termopen";

export function getError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
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
  const protocols = profile.protocols?.length
    ? profile.protocols
    : profile.kind === "host"
      ? ["ssh"]
      : profile.kind === "sftp"
        ? ["sftp"]
        : ["ssh", "sftp"];
  return protocols.includes(protocol);
}

export function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 90);
}
