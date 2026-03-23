import { AUTH_ERROR_PATTERNS } from "../constants.js";

export function isAuthErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function isCommandUnavailableMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("command not found") ||
    normalized.includes("not recognized as an internal or external command") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("executable file not found") ||
    normalized.includes("enoent")
  );
}
