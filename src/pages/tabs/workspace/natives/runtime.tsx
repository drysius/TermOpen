export const MAX_CONNECT_RETRY_ATTEMPTS = 3;

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

export function parseProfileSourceId(sourceId?: string): string | null {
  if (!sourceId || !sourceId.startsWith("profile:")) {
    return null;
  }
  const value = sourceId.slice("profile:".length).trim();
  return value.length > 0 ? value : null;
}
