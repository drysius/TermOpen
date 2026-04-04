import { getT } from "@/langs";
import type { BackendMessage } from "@/types/openptl";

type MessageInput = string | BackendMessage | null | undefined;

function isBackendMessage(value: unknown): value is BackendMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<BackendMessage>;
  return typeof candidate.message === "string";
}

function interpolate(template: string, params?: Record<string, string>): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => params[key] ?? `{${key}}`);
}

function resolveKey(key: string, params?: Record<string, string>): string {
  const template = getT().backendMessages[key] ?? key;
  return interpolate(template, params);
}

export function backendMessageKey(input: MessageInput): string | null {
  if (!input) {
    return null;
  }
  if (typeof input === "string") {
    return input;
  }
  if (isBackendMessage(input)) {
    return input.message;
  }
  return null;
}

export function resolveBackendMessage(input: MessageInput): string {
  if (!input) {
    return resolveKey("backend_error");
  }
  if (typeof input === "string") {
    return resolveKey(input);
  }
  if (isBackendMessage(input)) {
    return resolveKey(input.message, input.params);
  }
  return resolveKey("backend_error");
}

export function matchesBackendMessage(input: MessageInput, ...keys: string[]): boolean {
  const key = backendMessageKey(input);
  if (!key) {
    return false;
  }
  return keys.includes(key);
}
