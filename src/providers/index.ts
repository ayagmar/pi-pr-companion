import { getProviderConfig } from "../config.js";
import { isGitHubHost, isGitLabHost } from "../git.js";
import {
  type ActivePrLookup,
  type ParsedGitRemote,
  type PrCompanionConfig,
  type ProviderKind,
  type RepoContext,
} from "../types.js";
import { getGitHubPrSeverity, githubAdapter } from "./github.js";
import { getGitLabPrSeverity, gitlabAdapter } from "./gitlab.js";
import { type ProviderAdapter } from "./types.js";

const providerAdapters: Record<ProviderKind, ProviderAdapter> = {
  gitlab: gitlabAdapter,
  github: githubAdapter,
};

export function getProviderAdapter(kind: ProviderKind): ProviderAdapter {
  return providerAdapters[kind];
}

export function getProviderSeverity(pr: ActivePrLookup): "success" | "pending" | "blocked" {
  return pr.provider === "github" ? getGitHubPrSeverity(pr.pr) : getGitLabPrSeverity(pr.pr);
}

export function detectProviderKind(
  config: PrCompanionConfig,
  repo: RepoContext | { remote: ParsedGitRemote }
): ProviderKind | undefined {
  if (isGitHubHost(repo.remote.host)) {
    return "github";
  }

  if (isGitLabHost(repo.remote.host)) {
    return "gitlab";
  }

  const explicitMatches = config.providers.filter((provider) =>
    Object.hasOwn(provider.hosts, repo.remote.host)
  );
  if (explicitMatches.length !== 1) {
    return undefined;
  }

  return explicitMatches[0]?.kind;
}

export function getDetectedProviderConfig(config: PrCompanionConfig, repo: RepoContext) {
  const kind = detectProviderKind(config, repo);
  return kind ? getProviderConfig(config, kind) : undefined;
}

export function getProviderConfigForRemote(config: PrCompanionConfig, remote: ParsedGitRemote) {
  const kind = detectProviderKind(config, { remote });
  return kind ? getProviderConfig(config, kind) : undefined;
}
