import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ParsedGitRemote, RepoContext, RepoDiffStats } from "./types.js";

const DEFAULT_REMOTE_NAME = "origin";

export async function resolveRepoContext(
  pi: ExtensionAPI,
  cwd: string
): Promise<RepoContext | undefined> {
  const repoRoot = await runGitString(pi, cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return undefined;

  const branch = await runGitString(pi, repoRoot, ["branch", "--show-current"]);
  if (!branch) return undefined;

  const remoteSelection = await resolveEffectiveRemote(pi, repoRoot, branch);
  if (!remoteSelection) return undefined;

  const remote = parseGitRemote(remoteSelection.remoteUrl);
  if (!remote) return undefined;

  return {
    cwd: path.resolve(cwd),
    repoRoot: path.resolve(repoRoot),
    branch,
    remoteName: remoteSelection.remoteName,
    remoteUrl: remoteSelection.remoteUrl,
    remote,
  };
}

export async function switchToBranch(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string,
  options?: { remoteName?: string }
): Promise<
  | {
      ok: true;
      message: string;
      fastForwarded: boolean;
      remoteName?: string;
      fastForwardCommitCount?: number;
    }
  | { ok: false; message: string }
> {
  const remoteName = options?.remoteName ?? DEFAULT_REMOTE_NAME;
  const direct = await pi.exec("git", ["-C", repoRoot, "switch", branch]);
  if (direct.code === 0) {
    const fastForward = await tryFastForwardBranch(pi, repoRoot, branch, remoteName);
    return {
      ok: true,
      message: direct.stdout.trim() || `Switched to ${branch}`,
      fastForwarded: fastForward !== undefined,
      ...(fastForward
        ? {
            remoteName: fastForward.remoteName,
            fastForwardCommitCount: fastForward.commitCount,
          }
        : {}),
    };
  }

  const tracked = await trySwitchToTrackedRemoteBranch(pi, repoRoot, branch, remoteName);
  if (tracked.code === 0) {
    return {
      ok: true,
      message: tracked.stdout.trim() || `Switched to ${branch}`,
      fastForwarded: false,
    };
  }

  if (!shouldFetchBranchBeforeRetry(direct.stderr, tracked.stderr)) {
    const message = [direct.stderr.trim(), tracked.stderr.trim()].filter(Boolean).join("\n");
    return { ok: false, message: message || `Failed to switch to ${branch}` };
  }

  const fetched = await fetchRemoteBranch(pi, repoRoot, branch, remoteName);
  const fetchedTracked =
    fetched.code === 0
      ? await trySwitchToTrackedRemoteBranch(pi, repoRoot, branch, remoteName)
      : undefined;
  if (fetchedTracked?.code === 0) {
    return {
      ok: true,
      message: fetchedTracked.stdout.trim() || `Switched to ${branch}`,
      fastForwarded: false,
    };
  }

  const message = [
    direct.stderr.trim(),
    tracked.stderr.trim(),
    fetched.stderr.trim(),
    fetchedTracked?.stderr.trim(),
  ]
    .filter(Boolean)
    .join("\n");
  return { ok: false, message: message || `Failed to switch to ${branch}` };
}

export async function getDiffStats(
  pi: ExtensionAPI,
  repoRoot: string,
  targetBranch: string,
  options?: { remoteName?: string }
): Promise<RepoDiffStats | undefined> {
  const remoteName = options?.remoteName ?? DEFAULT_REMOTE_NAME;
  const candidates = [`${remoteName}/${targetBranch}...HEAD`, `${targetBranch}...HEAD`];

  for (const range of candidates) {
    const result = await pi.exec("git", ["-C", repoRoot, "diff", "--shortstat", range]);
    if (result.code !== 0) continue;
    return parseShortStat(result.stdout);
  }

  return undefined;
}

export async function hasDirtyWorktree(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec("git", ["-C", repoRoot, "status", "--porcelain"]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

export function isGitHubHost(host: string): boolean {
  return host.toLowerCase().includes("github");
}

export function isGitLabHost(host: string): boolean {
  return host.toLowerCase().includes("gitlab");
}

export function parseGitRemote(remoteUrl: string): ParsedGitRemote | undefined {
  const httpsMatch = remoteUrl.match(/^(https?):\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    const protocol = httpsMatch[1];
    const host = httpsMatch[2];
    const rawPath = httpsMatch[3];
    if (!protocol || !host || !rawPath) return undefined;

    const fullPath = stripGitSuffix(rawPath);
    return {
      host,
      fullPath,
      repoRef: `${host}/${fullPath}`,
      webUrl: `${protocol}://${host}/${fullPath}`,
    };
  }

  const sshUrlMatch = remoteUrl.match(/^ssh:\/\/git@([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i);
  if (sshUrlMatch) {
    const host = sshUrlMatch[1];
    const rawPath = sshUrlMatch[2];
    if (!host || !rawPath) return undefined;

    const fullPath = stripGitSuffix(rawPath);
    return {
      host,
      fullPath,
      repoRef: `${host}/${fullPath}`,
      webUrl: `https://${host}/${fullPath}`,
    };
  }

  const sshMatch = remoteUrl.match(/^git@([^:/]+):([^\s]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    const host = sshMatch[1];
    const rawPath = sshMatch[2];
    if (!host || !rawPath) return undefined;

    const fullPath = stripGitSuffix(rawPath);
    return {
      host,
      fullPath,
      repoRef: `${host}/${fullPath}`,
      webUrl: `https://${host}/${fullPath}`,
    };
  }

  return undefined;
}

async function resolveEffectiveRemote(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string
): Promise<{ remoteName: string; remoteUrl: string } | undefined> {
  const upstreamRemoteName = await runGitString(pi, repoRoot, [
    "config",
    "--get",
    `branch.${branch}.remote`,
  ]);
  if (upstreamRemoteName) {
    const upstreamRemoteUrl = await runGitString(pi, repoRoot, [
      "remote",
      "get-url",
      upstreamRemoteName,
    ]);
    if (upstreamRemoteUrl) {
      return {
        remoteName: upstreamRemoteName,
        remoteUrl: upstreamRemoteUrl,
      };
    }
  }

  const originUrl = await runGitString(pi, repoRoot, ["remote", "get-url", DEFAULT_REMOTE_NAME]);
  if (originUrl) {
    return {
      remoteName: DEFAULT_REMOTE_NAME,
      remoteUrl: originUrl,
    };
  }

  const remotes = await runGitLines(pi, repoRoot, ["remote"]);
  if (remotes.length !== 1) {
    return undefined;
  }

  const [remoteName] = remotes;
  if (!remoteName) {
    return undefined;
  }

  const remoteUrl = await runGitString(pi, repoRoot, ["remote", "get-url", remoteName]);
  if (!remoteUrl) {
    return undefined;
  }

  return { remoteName, remoteUrl };
}

async function trySwitchToTrackedRemoteBranch(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string,
  remoteName: string
) {
  return pi.exec("git", [
    "-C",
    repoRoot,
    "switch",
    "-c",
    branch,
    "--track",
    `${remoteName}/${branch}`,
  ]);
}

async function tryFastForwardBranch(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string,
  remoteName: string
): Promise<{ remoteName: string; commitCount?: number } | undefined> {
  const fetched = await fetchRemoteBranch(pi, repoRoot, branch, remoteName);
  if (fetched.code !== 0) {
    return undefined;
  }

  const commitCount = await countFastForwardCommits(pi, repoRoot, branch, remoteName);
  const merged = await pi.exec("git", [
    "-C",
    repoRoot,
    "merge",
    "--ff-only",
    `${remoteName}/${branch}`,
  ]);
  if (merged.code !== 0 || !wasFastForwarded(merged.stdout, merged.stderr)) {
    return undefined;
  }

  return {
    remoteName,
    ...(commitCount !== undefined ? { commitCount } : {}),
  };
}

async function countFastForwardCommits(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string,
  remoteName: string
): Promise<number | undefined> {
  const result = await pi.exec("git", [
    "-C",
    repoRoot,
    "rev-list",
    "--count",
    `HEAD..${remoteName}/${branch}`,
  ]);
  if (result.code !== 0) {
    return undefined;
  }

  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function fetchRemoteBranch(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string,
  remoteName: string
) {
  return pi.exec("git", [
    "-C",
    repoRoot,
    "fetch",
    remoteName,
    `refs/heads/${branch}:refs/remotes/${remoteName}/${branch}`,
  ]);
}

function wasFastForwarded(...messages: string[]): boolean {
  return messages.some((message) => /fast-forward/i.test(message));
}

function shouldFetchBranchBeforeRetry(...messages: string[]): boolean {
  return messages.some((message) => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("invalid reference") ||
      normalized.includes("did not match any file") ||
      normalized.includes("not a commit")
    );
  });
}

function parseShortStat(output: string): RepoDiffStats | undefined {
  const additionsMatch = output.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = output.match(/(\d+) deletions?\(-\)/);
  const additions = additionsMatch ? Number(additionsMatch[1]) : 0;
  const deletions = deletionsMatch ? Number(deletionsMatch[1]) : 0;

  if (additions === 0 && deletions === 0 && !output.trim()) {
    return undefined;
  }

  return { additions, deletions };
}

async function runGitString(
  pi: ExtensionAPI,
  cwd: string,
  args: string[]
): Promise<string | undefined> {
  const result = await pi.exec("git", ["-C", cwd, ...args]);
  if (result.code !== 0) return undefined;

  const value = result.stdout.trim();
  return value || undefined;
}

async function runGitLines(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string[]> {
  const value = await runGitString(pi, cwd, args);
  return value
    ? value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "").replace(/^\/+/, "");
}
