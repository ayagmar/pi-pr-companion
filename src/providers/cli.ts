import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AUTH_ERROR_PATTERNS } from "../constants.js";

/** Upper bound for a single gh/glab call, so a stalled network call cannot hang the UI. */
export const CLI_TIMEOUT_MS = 60_000;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a provider CLI with a timeout. pi.exec reports a killed process with
 * `killed: true` and exit code 0, so a timeout is turned into a failure here.
 */
export async function runCli(
  pi: Pick<ExtensionAPI, "exec">,
  command: "gh" | "glab",
  args: string[]
): Promise<CliResult> {
  const result = await pi.exec(command, args, { timeout: CLI_TIMEOUT_MS });
  if (result.killed) {
    return {
      code: 124,
      stdout: "",
      stderr: `\`${command} ${args.slice(0, 2).join(" ")}\` timed out after ${CLI_TIMEOUT_MS / 1000}s`,
    };
  }

  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

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
