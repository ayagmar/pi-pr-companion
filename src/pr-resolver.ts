import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isIgnoredBranch, loadConfig } from "./config.js";
import { getDiffStats, resolveRepoContext } from "./git.js";
import { evaluatePrReadiness } from "./pr-readiness.js";
import { parsePrReference } from "./pr-reference.js";
import { getProviderAdapter, getProviderConfigForRemote } from "./providers/index.js";
import type { PrLookupResult, RepoContext, ResolvedPrContext } from "./types.js";

export async function resolvePrContext(
  pi: ExtensionAPI,
  cwd: string,
  rawReference?: string
): Promise<ResolvedPrContext> {
  const config = await loadConfig();
  const repo = await resolveRepoContext(pi, cwd);

  if (!rawReference?.trim()) {
    if (!repo) {
      return { config, hidden: true, reason: "not-git" };
    }

    const provider = getProviderConfigForRemote(config, repo.remote);
    if (!provider) {
      return { config, repo, hidden: true, reason: "unsupported-remote" };
    }

    if (isIgnoredBranch(provider, repo.branch)) {
      return { config, provider, repo, hidden: true, reason: "ignored-branch" };
    }

    const result = await enrichResult(
      pi,
      repo,
      await getProviderAdapter(provider.kind).getPrByBranch(pi, repo, provider, repo.branch)
    );

    return {
      config,
      provider,
      repo,
      result,
      hidden: result.kind === "unsupported",
      reason: result.kind === "unsupported" ? "unsupported" : "visible",
    };
  }

  const reference = parsePrReference(rawReference);
  if (!reference) {
    return repo
      ? {
          config,
          repo,
          hidden: true,
          reason: "invalid-reference",
          errorMessage: `Unsupported PR reference: ${rawReference}`,
        }
      : {
          config,
          hidden: true,
          reason: "invalid-reference",
          errorMessage: `Unsupported PR reference: ${rawReference}`,
        };
  }

  if (reference.kind === "ref") {
    if (!repo) {
      return {
        config,
        reference,
        hidden: true,
        reason: "not-git",
        errorMessage: `A current repo is required to resolve ${reference.ref}`,
      };
    }

    const provider = getProviderConfigForRemote(config, repo.remote);
    if (!provider) {
      return {
        config,
        repo,
        reference,
        hidden: true,
        reason: "unsupported-remote",
        errorMessage: `Current repo remote is not recognized for ${reference.ref}`,
      };
    }

    if (provider.kind !== reference.provider) {
      return {
        config,
        provider,
        repo,
        reference,
        hidden: true,
        reason: "provider-mismatch",
        errorMessage: `${reference.ref} does not match the current repo provider (${provider.kind})`,
      };
    }

    const result = await enrichResult(
      pi,
      repo,
      await getProviderAdapter(provider.kind).getPrByRef(pi, repo, provider, reference),
      { requireCurrentBranchMatch: false }
    );

    return {
      config,
      provider,
      repo,
      reference,
      result,
      hidden: result.kind === "unsupported",
      reason: result.kind === "unsupported" ? "unsupported" : "visible",
    };
  }

  const provider = getProviderConfigForRemote(config, reference.remote);
  if (!provider) {
    return repo
      ? {
          config,
          repo,
          reference,
          hidden: true,
          reason: "unsupported-remote",
          errorMessage: `PR URL host is not recognized: ${reference.remote.host}`,
        }
      : {
          config,
          reference,
          hidden: true,
          reason: "unsupported-remote",
          errorMessage: `PR URL host is not recognized: ${reference.remote.host}`,
        };
  }

  const result = await enrichResult(
    pi,
    repo,
    await getProviderAdapter(provider.kind).getPrByUrl(pi, provider, reference),
    {
      requireCurrentBranchMatch: true,
      allowedRepoRef: reference.remote.repoRef,
    }
  );

  return repo
    ? {
        config,
        provider,
        repo,
        reference,
        result,
        hidden: result.kind === "unsupported",
        reason: result.kind === "unsupported" ? "unsupported" : "visible",
      }
    : {
        config,
        provider,
        reference,
        result,
        hidden: result.kind === "unsupported",
        reason: result.kind === "unsupported" ? "unsupported" : "visible",
      };
}

async function enrichResult(
  pi: ExtensionAPI,
  repo: RepoContext | undefined,
  result: PrLookupResult,
  options?: { requireCurrentBranchMatch?: boolean; allowedRepoRef?: string }
): Promise<PrLookupResult> {
  if (result.kind !== "active") {
    return result;
  }

  let pr = result.pr;
  if (
    repo &&
    (!options?.requireCurrentBranchMatch || repo.branch === result.pr.sourceBranch) &&
    (!options?.allowedRepoRef || repo.remote.repoRef === options.allowedRepoRef)
  ) {
    const diffStats = await getDiffStats(pi, repo.repoRoot, result.pr.targetBranch, {
      remoteName: repo.remoteName,
    });
    if (diffStats) {
      pr = { ...pr, diffStats };
    }
  }

  const readiness = evaluatePrReadiness(pr);
  return { ...result, pr: { ...pr, readiness } };
}

export function getResolvedPrErrorMessage(context: ResolvedPrContext): string | undefined {
  if (context.errorMessage) {
    return context.errorMessage;
  }

  const result = context.result;
  if (result) {
    switch (result.kind) {
      case "auth-error":
      case "unsupported":
      case "error":
        return result.message;
      case "none":
        return context.reference
          ? `No PR found for ${context.reference.ref}`
          : "No active PR found";
      default:
        return undefined;
    }
  }

  switch (context.reason) {
    case "not-git":
      return "Current directory is not inside a git repository";
    case "unsupported-remote":
      return context.reference?.kind === "url"
        ? `PR URL host is not recognized: ${context.reference.remote.host}`
        : "Current repo remote is not recognized as GitHub or GitLab";
    case "ignored-branch":
      return context.repo ? `Branch is ignored: ${context.repo.branch}` : "Branch is ignored";
    case "provider-mismatch":
    case "invalid-reference":
      return context.errorMessage;
    default:
      return undefined;
  }
}

export function canSwitchResolvedPr(context: ResolvedPrContext): boolean {
  if (!context.repo || !context.result || context.result.kind !== "active") {
    return false;
  }

  if (!context.reference || context.reference.kind === "ref") {
    return true;
  }

  return context.repo.remote.repoRef === context.reference.remote.repoRef;
}
