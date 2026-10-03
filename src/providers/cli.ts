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

// gh reports HTTP failures as "HTTP 401: ..." or "(HTTP 403)". Bare 401/403
// substrings are not enough: they also match PR numbers and paths.
const HTTP_AUTH_STATUS_PATTERN = /\bhttp 40[13]\b/;

/**
 * Parse the output of a secondary lookup (threads, approvals, diff stats).
 * These only enrich a PR that was already found, so a failed call or an
 * unexpected payload leaves that part out instead of failing the lookup.
 */
export function parseOptionalCliOutput<T>(
  result: CliResult,
  parse: (stdout: string) => T
): T | undefined {
  if (result.code !== 0) {
    return undefined;
  }

  try {
    return parse(result.stdout);
  } catch {
    return undefined;
  }
}

export function isAuthErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    AUTH_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern)) ||
    HTTP_AUTH_STATUS_PATTERN.test(normalized)
  );
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

/**
 * Parse `--paginate` output that holds JSON arrays. Depending on the CLI
 * version, pages arrive as one merged array or as one array per page printed
 * back to back; both are flattened into a single list.
 */
export function parsePaginatedJsonArray(text: string): unknown[] {
  const items: unknown[] = [];
  for (const page of splitJsonValues(text)) {
    const value = JSON.parse(page) as unknown;
    if (!Array.isArray(value)) {
      throw new SyntaxError("Expected a JSON array page");
    }
    items.push(...value);
  }
  return items;
}

function splitJsonValues(text: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) values.push(text.slice(start, index + 1));
    } else if (depth === 0 && char !== undefined && char.trim()) {
      throw new SyntaxError(`Unexpected character outside JSON value: ${char}`);
    }
  }

  if (depth !== 0 || inString) {
    throw new SyntaxError("Unterminated JSON value");
  }
  return values;
}
