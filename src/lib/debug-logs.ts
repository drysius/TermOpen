import { api } from "@/lib/tauri";

export type FrontendDebugLevel = "debug" | "info" | "warn" | "error";

export function logFrontendDebug(
  level: FrontendDebugLevel,
  message: string,
  options?: {
    source?: string;
    context?: string | null;
  },
) {
  const normalizedMessage = message.trim();
  if (!normalizedMessage) {
    return;
  }

  void api
    .debugLogFrontend(level, normalizedMessage, {
      source: options?.source,
      context: options?.context ?? null,
    })
    .catch(() => undefined);
}

export function logFrontendError(error: unknown, source = "frontend") {
  if (error instanceof Error) {
    logFrontendDebug("error", error.message || "Erro no frontend", {
      source,
      context: error.stack ?? null,
    });
    return;
  }

  if (typeof error === "string") {
    logFrontendDebug("error", error, { source });
    return;
  }

  let context: string | null = null;
  try {
    context = error ? JSON.stringify(error) : null;
  } catch {
    context = null;
  }

  logFrontendDebug("error", "Erro no frontend", {
    source,
    context,
  });
}
