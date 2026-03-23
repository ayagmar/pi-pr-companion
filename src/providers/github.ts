import { buildCheckSummary, normalizeCheckStatus, sumDiffStats } from "../pr-normalize.js";
import { isHostEnabled } from "../config.js";
import type {
  PrApprovalSummary,
  PrDetails,
  PrLookupResult,
  PrSummary,
  ProviderConfig,
} from "../types.js";
import { isAuthErrorMessage, isCommandUnavailableMessage } from "./cli.js";
import type { ProviderAdapter } from "./types.js";

interface GitHubPullRequestItem {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
  updatedAt?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup?: unknown;
}

interface GitHubStatusCheckRollupItem {
  conclusion?: string;
  state?: string;
  status?: string;
  name?: string;
  context?: string;
  displayName?: string;
  workflowName?: string;
}

interface GitHubReviewThreadNode {
  isResolved?: boolean;
  path?: string;
  comments?: {
    nodes?: {
      body?: string;
      author?: { login?: string };
    }[];
  };
}

interface GitHubReviewNode {
  state?: string;
}

const GITHUB_PR_FIELDS =
  "number,title,url,headRefName,baseRefName,updatedAt,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup";

const GITHUB_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          path
          comments(first: 1) {
            nodes {
              body
              author {
                login
              }
            }
          }
        }
      }
      reviews(first: 100) {
        nodes {
          state
        }
      }
    }
  }
}`;

export const githubAdapter: ProviderAdapter = {
  async getPrByBranch(pi, repo, provider, branch) {
    if (!isHostEnabled(provider, repo.remote.host)) {
      return unsupported(provider, `GitHub host is disabled in config: ${repo.remote.host}`);
    }

    const listResult = await pi.exec("gh", [
      "pr",
      "list",
      "--repo",
      repo.remote.repoRef,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      GITHUB_PR_FIELDS,
    ]);
    if (listResult.code !== 0) {
      return classifyFailure(
        provider,
        repo.remote.host,
        repo.remote.repoRef,
        listResult.stderr || listResult.stdout
      );
    }

    const activePr = parsePrList(listResult.stdout).sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    )[0];
    if (!activePr) {
      return { kind: "none", provider: provider.kind };
    }

    return getPrByNumber(pi, provider, repo.remote.host, repo.remote.repoRef, activePr.iid);
  },

  async getPrByRef(pi, repo, provider, reference) {
    if (!isHostEnabled(provider, repo.remote.host)) {
      return unsupported(provider, `GitHub host is disabled in config: ${repo.remote.host}`);
    }

    return getPrByNumber(pi, provider, repo.remote.host, repo.remote.repoRef, reference.iid);
  },

  async getPrByUrl(pi, provider, reference) {
    if (!isHostEnabled(provider, reference.remote.host)) {
      return unsupported(provider, `GitHub host is disabled in config: ${reference.remote.host}`);
    }

    return getPrByNumber(
      pi,
      provider,
      reference.remote.host,
      reference.remote.repoRef,
      reference.iid
    );
  },

  async listRepoActivePrs(pi, repo, provider) {
    if (!isHostEnabled(provider, repo.remote.host)) {
      return unsupported(provider, `GitHub host is disabled in config: ${repo.remote.host}`);
    }

    const result = await pi.exec("gh", [
      "pr",
      "list",
      "--repo",
      repo.remote.repoRef,
      "--state",
      "open",
      "--json",
      GITHUB_PR_FIELDS,
    ]);
    if (result.code !== 0) {
      return classifyFailure(
        provider,
        repo.remote.host,
        repo.remote.repoRef,
        result.stderr || result.stdout
      );
    }

    return parsePrList(result.stdout).sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    );
  },
};

export function getGitHubPrSeverity(pr: PrDetails): "success" | "pending" | "blocked" {
  const mergeStatus = pr.detailedMergeStatus?.toLowerCase();
  const checkStatus = pr.checkSummary?.status ?? normalizeCheckStatus(pr.pipelineStatus);

  if (mergeStatus === "dirty" || mergeStatus === "blocked") return "blocked";
  if (checkStatus === "failure") return "blocked";
  if (mergeStatus === "clean" && (checkStatus === "success" || checkStatus === "none")) {
    return "success";
  }
  if (checkStatus === "pending") return "pending";
  if (mergeStatus === "clean") return "success";

  return "pending";
}

async function getPrByNumber(
  pi: {
    exec: (
      command: string,
      args: string[]
    ) =>
      | Promise<{ code: number; stdout: string; stderr: string }>
      | { code: number; stdout: string; stderr: string };
  },
  provider: ProviderConfig,
  host: string,
  repoRef: string,
  iid: number
): Promise<PrLookupResult> {
  const detailResult = await pi.exec("gh", [
    "pr",
    "view",
    String(iid),
    "--repo",
    repoRef,
    "--json",
    GITHUB_PR_FIELDS,
  ]);
  if (detailResult.code !== 0) {
    return classifyFailure(provider, host, repoRef, detailResult.stderr || detailResult.stdout);
  }

  const pr = parsePrView(detailResult.stdout);
  if (!pr) {
    return {
      kind: "error",
      provider: provider.kind,
      message: `GitHub returned an unexpected PR payload for ${repoRef}#${iid}`,
    };
  }

  const repoPath = getGitHubRepoPath(repoRef);
  const filesResult = await pi.exec("gh", ["api", `repos/${repoPath}/pulls/${iid}/files`]);
  if (filesResult.code !== 0) {
    return classifyFailure(provider, host, repoRef, filesResult.stderr || filesResult.stdout);
  }

  const threadsResult = await pi.exec("gh", [
    "api",
    "graphql",
    "-f",
    `query=${GITHUB_THREADS_QUERY}`,
    "-f",
    `owner=${getGitHubOwner(repoPath)}`,
    "-f",
    `name=${getGitHubName(repoPath)}`,
    "-F",
    `number=${iid}`,
  ]);
  if (threadsResult.code !== 0) {
    return classifyFailure(provider, host, repoRef, threadsResult.stderr || threadsResult.stdout);
  }

  const diffStats = parseGitHubFileDiffStats(filesResult.stdout);
  const threadData = parseGitHubThreadData(threadsResult.stdout);
  const approvalSummary = buildApprovalSummary(pr.approvalSummary, threadData.reviewStates);

  return {
    kind: "active",
    provider: provider.kind,
    pr: {
      ...pr,
      ...(diffStats ? { diffStats } : {}),
      ...(threadData.threadSummary ? { threadSummary: threadData.threadSummary } : {}),
      ...(threadData.threadItems.length > 0 ? { threadItems: threadData.threadItems } : {}),
      ...(approvalSummary ? { approvalSummary } : {}),
      ...(pr.detailedMergeStatus?.toLowerCase() === "behind"
        ? { behindTarget: "behind target" }
        : {}),
    },
  };
}

function parsePrList(jsonText: string): PrSummary[] {
  const payload = JSON.parse(jsonText) as unknown;
  if (!Array.isArray(payload)) return [];

  return payload
    .map((item) => toPrSummary(item as GitHubPullRequestItem))
    .filter((item): item is PrSummary => item !== undefined);
}

function parsePrView(jsonText: string): PrDetails | undefined {
  const payload = JSON.parse(jsonText) as GitHubPullRequestItem;
  const summary = toPrSummary(payload);
  if (!summary) return undefined;
  return parsePrDetails(payload, summary);
}

function parsePrDetails(payload: GitHubPullRequestItem, fallback: PrSummary): PrDetails {
  const mergeStateStatus =
    typeof payload.mergeStateStatus === "string"
      ? payload.mergeStateStatus
      : fallback.detailedMergeStatus;
  const draft = typeof payload.isDraft === "boolean" ? payload.isDraft : fallback.draft;
  const reviewDecision =
    typeof payload.reviewDecision === "string"
      ? payload.reviewDecision
      : fallback.approvalSummary?.decision;
  const checkItems = collectStatusCheckItems(payload.statusCheckRollup).map((item, index) => {
    const details = item.conclusion ?? item.state ?? item.status;
    return {
      name:
        item.name || item.context || item.displayName || item.workflowName || `check-${index + 1}`,
      status: normalizeCheckStatus(details),
      ...(details ? { details } : {}),
    };
  });
  const checkSummary = buildCheckSummary(checkItems);
  const pipelineStatus = checkSummary.status === "none" ? undefined : checkSummary.status;

  return {
    ...fallback,
    title: typeof payload.title === "string" && payload.title ? payload.title : fallback.title,
    url: typeof payload.url === "string" && payload.url ? payload.url : fallback.url,
    ...(mergeStateStatus ? { detailedMergeStatus: mergeStateStatus } : {}),
    ...(typeof draft === "boolean" ? { draft } : {}),
    ...(pipelineStatus ? { pipelineStatus } : {}),
    ...(checkItems.length > 0 ? { checkItems } : {}),
    ...(checkSummary.total > 0 ? { checkSummary } : {}),
    ...(reviewDecision ? { approvalSummary: { decision: reviewDecision } } : {}),
  };
}

function toPrSummary(item: GitHubPullRequestItem): PrSummary | undefined {
  if (typeof item.number !== "number") return undefined;
  if (typeof item.title !== "string") return undefined;
  if (typeof item.url !== "string") return undefined;
  if (typeof item.headRefName !== "string") return undefined;
  if (typeof item.baseRefName !== "string") return undefined;
  if (typeof item.updatedAt !== "string") return undefined;

  const mergeStateStatus =
    typeof item.mergeStateStatus === "string" ? item.mergeStateStatus : undefined;
  const draft = typeof item.isDraft === "boolean" ? item.isDraft : undefined;
  const reviewDecision = typeof item.reviewDecision === "string" ? item.reviewDecision : undefined;
  const checkItems = collectStatusCheckItems(item.statusCheckRollup).map((rollup, index) => ({
    name:
      rollup.name ||
      rollup.context ||
      rollup.displayName ||
      rollup.workflowName ||
      `check-${index + 1}`,
    status: normalizeCheckStatus(rollup.conclusion ?? rollup.state ?? rollup.status),
  }));
  const checkSummary = buildCheckSummary(checkItems);
  const pipelineStatus = checkSummary.status === "none" ? undefined : checkSummary.status;

  return {
    iid: item.number,
    ref: `#${item.number}`,
    title: item.title,
    url: item.url,
    sourceBranch: item.headRefName,
    targetBranch: item.baseRefName,
    updatedAt: item.updatedAt,
    ...(mergeStateStatus ? { detailedMergeStatus: mergeStateStatus } : {}),
    ...(typeof draft === "boolean" ? { draft } : {}),
    ...(pipelineStatus ? { pipelineStatus } : {}),
    ...(checkSummary.total > 0 ? { checkSummary } : {}),
    ...(reviewDecision ? { approvalSummary: { decision: reviewDecision } } : {}),
  };
}

function collectStatusCheckItems(value: unknown): GitHubStatusCheckRollupItem[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStatusCheckItems(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const candidate = value as GitHubStatusCheckRollupItem;
  if (
    typeof candidate.conclusion === "string" ||
    typeof candidate.state === "string" ||
    typeof candidate.status === "string"
  ) {
    return [candidate];
  }

  return Object.values(value as Record<string, unknown>).flatMap((item) =>
    collectStatusCheckItems(item)
  );
}

function parseGitHubFileDiffStats(jsonText: string) {
  const payload = JSON.parse(jsonText) as { additions?: number; deletions?: number }[];
  if (!Array.isArray(payload)) return undefined;

  const chunks = payload.map((item) => ({
    additions: typeof item.additions === "number" ? item.additions : 0,
    deletions: typeof item.deletions === "number" ? item.deletions : 0,
  }));
  return sumDiffStats(chunks);
}

function parseGitHubThreadData(jsonText: string): {
  threadSummary?: PrDetails["threadSummary"];
  threadItems: NonNullable<PrDetails["threadItems"]>;
  reviewStates: string[];
} {
  const payload = JSON.parse(jsonText) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: { nodes?: GitHubReviewThreadNode[] };
          reviews?: { nodes?: GitHubReviewNode[] };
        };
      };
    };
  };

  const threadNodes = payload.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const reviewStates = (payload.data?.repository?.pullRequest?.reviews?.nodes ?? [])
    .map((item) => item.state)
    .filter((item): item is string => typeof item === "string");

  const threadItems = threadNodes.map((thread, index) => ({
    id: `gh-thread-${index + 1}`,
    body: thread.comments?.nodes?.[0]?.body?.trim() || "Review thread",
    resolved: thread.isResolved === true,
    ...(thread.path ? { path: thread.path } : {}),
    ...(thread.comments?.nodes?.[0]?.author?.login
      ? { author: thread.comments.nodes[0].author.login }
      : {}),
  }));

  return {
    threadSummary: {
      total: threadItems.length,
      unresolved: threadItems.filter((item) => !item.resolved).length,
    },
    threadItems,
    reviewStates,
  };
}

function buildApprovalSummary(
  current: PrApprovalSummary | undefined,
  reviewStates: string[]
): PrApprovalSummary | undefined {
  const approvedCount = reviewStates.filter((state) => state === "APPROVED").length;
  const requestedChangesCount = reviewStates.filter(
    (state) => state === "CHANGES_REQUESTED"
  ).length;

  if (!current?.decision && approvedCount === 0 && requestedChangesCount === 0) {
    return undefined;
  }

  return {
    ...current,
    ...(approvedCount > 0 ? { approvedCount } : {}),
    ...(requestedChangesCount > 0 ? { requestedChangesCount } : {}),
    commentCount: reviewStates.length,
  };
}

function classifyFailure(
  provider: ProviderConfig,
  host: string,
  repoRef: string,
  message: string
): PrLookupResult {
  const trimmedMessage = message.trim();
  if (!trimmedMessage || isCommandUnavailableMessage(trimmedMessage)) {
    return unsupported(
      provider,
      "GitHub CLI `gh` is unavailable. Install `gh` and authenticate it to use PR features."
    );
  }

  if (isAuthErrorMessage(trimmedMessage)) {
    return {
      kind: "auth-error",
      provider: provider.kind,
      message: trimmedMessage || `GitHub authentication failed for ${host}`,
    };
  }

  if (isPrNotFoundMessage(trimmedMessage)) {
    return { kind: "none", provider: provider.kind };
  }

  return {
    kind: "error",
    provider: provider.kind,
    message: trimmedMessage || `GitHub command failed for ${repoRef}`,
  };
}

function unsupported(provider: ProviderConfig, message: string): PrLookupResult {
  return {
    kind: "unsupported",
    provider: provider.kind,
    message,
  };
}

function isPrNotFoundMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no pull requests found") ||
    normalized.includes("could not resolve to a pullrequest") ||
    normalized.includes("pull request was not found")
  );
}

function getGitHubRepoPath(repoRef: string): string {
  return repoRef.split("/").slice(1).join("/");
}

function getGitHubOwner(repoPath: string): string {
  return repoPath.split("/")[0] ?? "";
}

function getGitHubName(repoPath: string): string {
  return repoPath.split("/")[1] ?? "";
}
