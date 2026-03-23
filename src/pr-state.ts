import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isIgnoredBranch, loadConfig } from "./config.js";
import { formatUpdatedAge, isStalePr, sortPrsForActionability } from "./pr-display.js";
import { getDiffStats, resolveRepoContext } from "./git.js";
import { evaluatePrReadiness, getReadinessHint } from "./pr-readiness.js";
import {
  getDetectedProviderConfig,
  getProviderAdapter,
  getProviderSeverity,
} from "./providers/index.js";
import type {
  PrCompanionConfig,
  PrLookupResult,
  PrSummary,
  ProviderConfig,
  RepoContext,
  RepoStatusSnapshot,
  StatusBarStyle,
} from "./types.js";

interface CacheEntry {
  expiresAt: number;
  result: PrLookupResult;
}

interface ProviderRepoContext {
  config: PrCompanionConfig;
  repo?: RepoContext;
  provider?: ProviderConfig;
}

interface StatusTheme {
  fg(color: string, text: string): string;
}

interface StatusTextOptions {
  theme?: StatusTheme;
  style?: StatusBarStyle;
  showCoverage?: boolean;
  showBlockerHint?: boolean;
}

const cache = new Map<string, CacheEntry>();

export async function getRepoStatusSnapshot(
  pi: ExtensionAPI,
  cwd: string,
  options?: { force?: boolean }
): Promise<RepoStatusSnapshot> {
  const providerRepo = await resolveProviderRepoContext(pi, cwd);
  if (!providerRepo.repo) {
    return { config: providerRepo.config, hidden: true, reason: "not-git" };
  }
  if (!providerRepo.provider) {
    return {
      config: providerRepo.config,
      repo: providerRepo.repo,
      hidden: true,
      reason: "unsupported-remote",
    };
  }

  const { config, repo, provider } = providerRepo;

  if (isIgnoredBranch(provider, repo.branch)) {
    return { config, provider, repo, hidden: true, reason: "ignored-branch" };
  }

  const result = await detectForRepo(
    repo.repoRoot,
    repo.branch,
    provider.kind,
    options?.force,
    async () =>
      enrichLookupResult(
        pi,
        repo,
        await getProviderAdapter(provider.kind).getPrByBranch(pi, repo, provider, repo.branch)
      ),
    config.cacheTtlMs
  );

  if (result.kind === "none" && !provider.showNoPrState) {
    return { config, provider, repo, result, hidden: true, reason: "no-pr-hidden" };
  }

  if (result.kind === "unsupported") {
    return { config, provider, repo, result, hidden: true, reason: "unsupported" };
  }

  return { config, provider, repo, result, hidden: false, reason: "visible" };
}

export function clearRepoStatusCache(repoRoot?: string): void {
  if (!repoRoot) {
    cache.clear();
    return;
  }

  for (const key of cache.keys()) {
    if (key.startsWith(`${repoRoot}::`)) {
      cache.delete(key);
    }
  }
}

export function formatStatusText(
  result: PrLookupResult,
  options: StatusTextOptions = {}
): string | undefined {
  switch (result.kind) {
    case "active": {
      const severity = getProviderSeverity(result);
      const suffix = severity === "success" ? "✓" : severity === "blocked" ? "!" : "…";
      const style = options.style ?? "diff-prefix";
      const diffText = formatDiffStats(result.pr.diffStats, style, options.theme);
      const coverageText = formatCoverage(result.pr.coverage, options.showCoverage, options.theme);
      const blockerHint = options.showBlockerHint ? getReadinessHint(result.pr) : undefined;

      if (style === "diff-suffix") {
        return [`PR ${result.pr.ref}`, coverageText, suffix, blockerHint, diffText]
          .filter(Boolean)
          .join(" ");
      }

      return [diffText, `PR ${result.pr.ref}`, coverageText, suffix, blockerHint]
        .filter(Boolean)
        .join(" ");
    }
    case "none":
      return "PR —";
    case "auth-error":
      return "PR auth?";
    case "error":
      return "PR error!";
    default:
      return undefined;
  }
}

export async function listActivePrsForCurrentRepo(
  pi: ExtensionAPI,
  cwd: string
): Promise<{
  snapshot: RepoStatusSnapshot;
  prs: PrSummary[] | undefined;
  lookupError?: PrLookupResult;
}> {
  const providerRepo = await resolveProviderRepoContext(pi, cwd);
  if (!providerRepo.repo) {
    return {
      snapshot: { config: providerRepo.config, hidden: true, reason: "not-git" },
      prs: undefined,
    };
  }
  if (!providerRepo.provider) {
    return {
      snapshot: {
        config: providerRepo.config,
        repo: providerRepo.repo,
        hidden: true,
        reason: "unsupported-remote",
      },
      prs: undefined,
    };
  }

  const { config, repo, provider } = providerRepo;
  const listed = await getProviderAdapter(provider.kind).listRepoActivePrs(pi, repo, provider);
  if (Array.isArray(listed)) {
    const prs = sortPrsForActionability(listed.map((pr) => withSummaryReadiness(pr)));
    return {
      snapshot: { config, provider, repo, hidden: false, reason: "visible" },
      prs,
    };
  }

  return {
    snapshot: {
      config,
      provider,
      repo,
      result: listed,
      hidden: listed.kind === "unsupported",
      reason: listed.kind === "unsupported" ? "unsupported" : "visible",
    },
    prs: undefined,
    lookupError: listed,
  };
}

export function describePrActivity(
  pr: PrSummary,
  config: PrCompanionConfig,
  now = Date.now()
): string {
  const readiness = pr.readiness ?? evaluatePrReadiness(pr);
  const hint = getReadinessHint({ ...pr, readiness });
  const age = config.showUpdatedAgeInPickers ? formatUpdatedAge(pr.updatedAt, now) : undefined;
  const stale = isStalePr(pr.updatedAt, config, now) ? "stale" : undefined;
  return [hint, stale, age].filter(Boolean).join(" • ");
}

async function resolveProviderRepoContext(
  pi: ExtensionAPI,
  cwd: string
): Promise<ProviderRepoContext> {
  const config = await loadConfig();
  const repo = await resolveRepoContext(pi, cwd);
  if (!repo) {
    return { config };
  }

  const provider = getDetectedProviderConfig(config, repo);
  return provider ? { config, repo, provider } : { config, repo };
}

async function detectForRepo(
  repoRoot: string,
  branch: string,
  providerKind: ProviderConfig["kind"],
  force: boolean | undefined,
  load: () => Promise<PrLookupResult>,
  ttlMs: number
): Promise<PrLookupResult> {
  const key = `${repoRoot}::${branch}::${providerKind}`;
  const cached = cache.get(key);
  const now = Date.now();

  if (!force && cached && cached.expiresAt > now) {
    return cached.result;
  }

  const result = await load();
  cache.set(key, { result, expiresAt: now + ttlMs });
  return result;
}

async function enrichLookupResult(
  pi: ExtensionAPI,
  repo: RepoContext,
  result: PrLookupResult
): Promise<PrLookupResult> {
  if (result.kind !== "active") return result;

  let pr = result.pr;
  if (repo.branch === result.pr.sourceBranch) {
    const diffStats = await getDiffStats(pi, repo.repoRoot, result.pr.targetBranch, {
      remoteName: repo.remoteName,
    });
    if (diffStats) {
      pr = { ...pr, diffStats };
    }
  }

  return { ...result, pr: withSummaryReadiness(pr) };
}

function withSummaryReadiness<T extends PrSummary>(pr: T): T {
  const readiness = pr.readiness ?? evaluatePrReadiness(pr);
  return { ...pr, readiness };
}

function formatDiffStats(
  diffStats: PrSummary["diffStats"],
  style: StatusBarStyle,
  theme?: StatusTheme
): string {
  if (!diffStats || style === "minimal") return "";

  const additionsText = `+${diffStats.additions}`;
  const deletionsText = `-${diffStats.deletions}`;
  const additions = theme ? theme.fg("success", additionsText) : additionsText;
  const deletions = theme ? theme.fg("error", deletionsText) : deletionsText;

  return style === "diff-suffix" ? `(${additions}/${deletions})` : `${additions} ${deletions}`;
}

function formatCoverage(
  coverage: string | undefined,
  showCoverage: boolean | undefined,
  theme?: StatusTheme
): string {
  if (!showCoverage || !coverage) return "";

  const value = `cov${coverage.endsWith("%") ? coverage : `${coverage}%`}`;
  return theme ? theme.fg("accent", value) : value;
}
