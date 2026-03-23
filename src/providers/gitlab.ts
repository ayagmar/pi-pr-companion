import {
  buildCheckSummary,
  countPatchDiffStats,
  normalizeCheckStatus,
  sumDiffStats,
} from "../pr-normalize.js";
import { isHostEnabled } from "../config.js";
import type {
  PrApprovalSummary,
  PrCheckItem,
  PrDetails,
  PrLookupResult,
  PrSummary,
  ProviderConfig,
} from "../types.js";
import { isAuthErrorMessage, isCommandUnavailableMessage } from "./cli.js";
import type { ProviderAdapter } from "./types.js";

interface GitLabMrListItem {
  iid?: number;
  title?: string;
  web_url?: string;
  source_branch?: string;
  target_branch?: string;
  updated_at?: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  draft?: boolean;
}

interface GitLabMrViewItem extends GitLabMrListItem {
  head_pipeline?: {
    status?: string;
    coverage?: string;
  };
}

interface GitLabDiscussionNote {
  id?: number;
  body?: string;
  resolvable?: boolean;
  resolved?: boolean;
  author?: { username?: string; name?: string };
  position?: {
    new_path?: string;
    old_path?: string;
  };
}

interface GitLabDiscussion {
  id?: string;
  notes?: GitLabDiscussionNote[];
}

export const gitlabAdapter: ProviderAdapter = {
  async getPrByBranch(pi, repo, provider, branch) {
    if (!isHostEnabled(provider, repo.remote.host)) {
      return unsupported(provider, `GitLab host is disabled in config: ${repo.remote.host}`);
    }

    const listResult = await pi.exec("glab", [
      "-R",
      repo.remote.repoRef,
      "mr",
      "list",
      "--source-branch",
      branch,
      "--output",
      "json",
    ]);

    if (listResult.code !== 0) {
      return classifyFailure(
        provider,
        repo.remote.host,
        repo.remote.repoRef,
        listResult.stderr || listResult.stdout
      );
    }

    const activePr = parseMrList(listResult.stdout).sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    )[0];

    if (!activePr) {
      return { kind: "none", provider: provider.kind };
    }

    return getPrByIid(pi, provider, repo.remote.host, repo.remote.repoRef, activePr.iid);
  },

  async getPrByRef(pi, repo, provider, reference) {
    if (!isHostEnabled(provider, repo.remote.host)) {
      return unsupported(provider, `GitLab host is disabled in config: ${repo.remote.host}`);
    }

    return getPrByIid(pi, provider, repo.remote.host, repo.remote.repoRef, reference.iid);
  },

  async getPrByUrl(pi, provider, reference) {
    if (!isHostEnabled(provider, reference.remote.host)) {
      return unsupported(provider, `GitLab host is disabled in config: ${reference.remote.host}`);
    }

    return getPrByIid(pi, provider, reference.remote.host, reference.remote.repoRef, reference.iid);
  },

  async listRepoActivePrs(pi, repo, provider) {
    if (!isHostEnabled(provider, repo.remote.host)) {
      return unsupported(provider, `GitLab host is disabled in config: ${repo.remote.host}`);
    }

    const result = await pi.exec("glab", [
      "-R",
      repo.remote.repoRef,
      "mr",
      "list",
      "--output",
      "json",
    ]);
    if (result.code !== 0) {
      return classifyFailure(
        provider,
        repo.remote.host,
        repo.remote.repoRef,
        result.stderr || result.stdout
      );
    }

    return parseMrList(result.stdout).sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    );
  },
};

export function getGitLabPrSeverity(pr: PrDetails): "success" | "pending" | "blocked" {
  const pipelineStatus = pr.checkSummary?.status ?? normalizeCheckStatus(pr.pipelineStatus);
  const mergeStatus = pr.detailedMergeStatus?.toLowerCase();

  if (pr.hasConflicts) return "blocked";
  if (mergeStatus && isBlockedMergeStatus(mergeStatus)) return "blocked";
  if (pipelineStatus === "failure") {
    return "blocked";
  }
  if (pipelineStatus === "success") return "success";
  if (pipelineStatus === "pending") {
    return "pending";
  }

  return "pending";
}

async function getPrByIid(
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
  const projectPath = getGitLabProjectPath(repoRef);
  const detailResult = await pi.exec("glab", [
    "-R",
    repoRef,
    "mr",
    "view",
    String(iid),
    "--output",
    "json",
  ]);
  if (detailResult.code !== 0) {
    return classifyFailure(provider, host, repoRef, detailResult.stderr || detailResult.stdout);
  }

  const pr = parseMrView(detailResult.stdout);
  if (!pr) {
    return {
      kind: "error",
      provider: provider.kind,
      message: `GitLab returned an unexpected MR payload for ${repoRef}!${iid}`,
    };
  }

  const discussionsResult = await pi.exec("glab", [
    "-R",
    repoRef,
    "api",
    `projects/${projectPath}/merge_requests/${iid}/discussions`,
  ]);
  if (discussionsResult.code !== 0) {
    return classifyFailure(
      provider,
      host,
      repoRef,
      discussionsResult.stderr || discussionsResult.stdout
    );
  }

  const approvalsResult = await pi.exec("glab", [
    "-R",
    repoRef,
    "api",
    `projects/${projectPath}/merge_requests/${iid}/approvals`,
  ]);
  if (approvalsResult.code !== 0) {
    return classifyFailure(
      provider,
      host,
      repoRef,
      approvalsResult.stderr || approvalsResult.stdout
    );
  }

  const changesResult = await pi.exec("glab", [
    "-R",
    repoRef,
    "api",
    `projects/${projectPath}/merge_requests/${iid}/changes`,
  ]);
  if (changesResult.code !== 0) {
    return classifyFailure(provider, host, repoRef, changesResult.stderr || changesResult.stdout);
  }

  const threadData = parseGitLabDiscussionData(discussionsResult.stdout);
  const approvalSummary = parseGitLabApprovalSummary(approvalsResult.stdout, pr.approvalSummary);
  const diffStats = parseGitLabDiffStats(changesResult.stdout);

  return {
    kind: "active",
    provider: provider.kind,
    pr: {
      ...pr,
      ...(threadData.threadSummary ? { threadSummary: threadData.threadSummary } : {}),
      ...(threadData.threadItems.length > 0 ? { threadItems: threadData.threadItems } : {}),
      ...(approvalSummary ? { approvalSummary } : {}),
      ...(diffStats ? { diffStats } : {}),
      ...(pr.detailedMergeStatus?.toLowerCase().includes("rebase")
        ? { behindTarget: "behind target" }
        : {}),
    },
  };
}

function parseMrList(jsonText: string): PrSummary[] {
  const payload = JSON.parse(jsonText) as unknown;
  if (!Array.isArray(payload)) return [];

  return payload
    .map((item) => toPrSummary(item as GitLabMrListItem))
    .filter((item): item is PrSummary => item !== undefined);
}

function parseMrView(jsonText: string): PrDetails | undefined {
  const payload = JSON.parse(jsonText) as GitLabMrViewItem;
  const summary = toPrSummary(payload);
  if (!summary) return undefined;
  return parseMrDetails(payload, summary);
}

function parseMrDetails(payload: GitLabMrViewItem, fallback: PrSummary): PrDetails {
  const detailedMergeStatus =
    typeof payload.detailed_merge_status === "string"
      ? payload.detailed_merge_status
      : fallback.detailedMergeStatus;
  const hasConflicts =
    typeof payload.has_conflicts === "boolean" ? payload.has_conflicts : fallback.hasConflicts;
  const draft = typeof payload.draft === "boolean" ? payload.draft : fallback.draft;
  const pipelineStatus = payload.head_pipeline?.status;
  const coverage =
    typeof payload.head_pipeline?.coverage === "string" && payload.head_pipeline.coverage.trim()
      ? payload.head_pipeline.coverage.trim()
      : undefined;
  const checkItems: PrCheckItem[] = pipelineStatus
    ? [
        {
          name: "pipeline",
          status: normalizeCheckStatus(pipelineStatus),
          details: pipelineStatus,
        },
      ]
    : [];
  const checkSummary = buildCheckSummary(checkItems);

  return {
    ...fallback,
    title: typeof payload.title === "string" && payload.title ? payload.title : fallback.title,
    url: typeof payload.web_url === "string" && payload.web_url ? payload.web_url : fallback.url,
    ...(detailedMergeStatus ? { detailedMergeStatus } : {}),
    ...(typeof hasConflicts === "boolean" ? { hasConflicts } : {}),
    ...(typeof draft === "boolean" ? { draft } : {}),
    ...(pipelineStatus ? { pipelineStatus } : {}),
    ...(coverage ? { coverage } : {}),
    ...(checkItems.length > 0 ? { checkItems } : {}),
    ...(checkSummary.total > 0 ? { checkSummary } : {}),
  };
}

function toPrSummary(item: GitLabMrListItem): PrSummary | undefined {
  if (typeof item.iid !== "number") return undefined;
  if (typeof item.title !== "string") return undefined;
  if (typeof item.web_url !== "string") return undefined;
  if (typeof item.source_branch !== "string") return undefined;
  if (typeof item.target_branch !== "string") return undefined;
  if (typeof item.updated_at !== "string") return undefined;

  const detailedMergeStatus =
    typeof item.detailed_merge_status === "string" ? item.detailed_merge_status : undefined;
  const hasConflicts = typeof item.has_conflicts === "boolean" ? item.has_conflicts : undefined;
  const draft = typeof item.draft === "boolean" ? item.draft : undefined;

  return {
    iid: item.iid,
    ref: `!${item.iid}`,
    title: item.title,
    url: item.web_url,
    sourceBranch: item.source_branch,
    targetBranch: item.target_branch,
    updatedAt: item.updated_at,
    ...(detailedMergeStatus ? { detailedMergeStatus } : {}),
    ...(typeof hasConflicts === "boolean" ? { hasConflicts } : {}),
    ...(typeof draft === "boolean" ? { draft } : {}),
  };
}

function parseGitLabDiscussionData(jsonText: string): {
  threadSummary?: PrDetails["threadSummary"];
  threadItems: NonNullable<PrDetails["threadItems"]>;
} {
  const payload = JSON.parse(jsonText) as unknown;
  if (!Array.isArray(payload)) {
    return { threadItems: [] };
  }

  const threadItems = payload.flatMap((discussion) => {
    const item = discussion as GitLabDiscussion;
    const notes = Array.isArray(item.notes) ? item.notes : [];
    const unresolvedNote = notes.find((note) => note.resolvable && !note.resolved) ?? notes[0];
    if (!unresolvedNote) {
      return [];
    }

    return [
      {
        id: item.id || String(unresolvedNote.id || "discussion"),
        body: unresolvedNote.body?.trim() || "Discussion",
        resolved: !notes.some((note) => note.resolvable && !note.resolved),
        ...(unresolvedNote.position?.new_path || unresolvedNote.position?.old_path
          ? { path: unresolvedNote.position?.new_path || unresolvedNote.position?.old_path }
          : {}),
        ...(unresolvedNote.author?.username || unresolvedNote.author?.name
          ? { author: unresolvedNote.author?.username || unresolvedNote.author?.name }
          : {}),
      },
    ];
  });

  return {
    threadSummary: {
      total: threadItems.length,
      unresolved: threadItems.filter((item) => !item.resolved).length,
    },
    threadItems,
  };
}

function parseGitLabApprovalSummary(
  jsonText: string,
  current: PrApprovalSummary | undefined
): PrApprovalSummary | undefined {
  const payload = JSON.parse(jsonText) as {
    approved?: boolean;
    approved_by?: { user?: { username?: string } }[];
    approvals_required?: number;
  };

  const approvedCount = Array.isArray(payload.approved_by) ? payload.approved_by.length : 0;
  const decision = payload.approved ? "approved" : current?.decision;

  if (!decision && approvedCount === 0 && typeof payload.approvals_required !== "number") {
    return current;
  }

  return {
    ...current,
    ...(decision ? { decision } : {}),
    ...(approvedCount > 0 ? { approvedCount } : {}),
  };
}

function parseGitLabDiffStats(jsonText: string) {
  const payload = JSON.parse(jsonText) as { changes?: { diff?: string }[] };
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  return sumDiffStats(
    changes
      .filter((item): item is { diff: string } => typeof item.diff === "string")
      .map((item) => countPatchDiffStats(item.diff))
  );
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
      "GitLab CLI `glab` is unavailable. Install `glab` and authenticate it to use PR features."
    );
  }

  if (isAuthErrorMessage(trimmedMessage)) {
    return {
      kind: "auth-error",
      provider: provider.kind,
      message: trimmedMessage || `GitLab authentication failed for ${host}`,
    };
  }

  if (isPrNotFoundMessage(trimmedMessage)) {
    return { kind: "none", provider: provider.kind };
  }

  return {
    kind: "error",
    provider: provider.kind,
    message: trimmedMessage || `GitLab command failed for ${repoRef}`,
  };
}

function unsupported(provider: ProviderConfig, message: string): PrLookupResult {
  return {
    kind: "unsupported",
    provider: provider.kind,
    message,
  };
}

function isBlockedMergeStatus(status: string): boolean {
  return status.includes("rebase") || status.includes("conflict") || status === "cannot_be_merged";
}

function isPrNotFoundMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("merge request not found") ||
    normalized.includes("no merge requests found") ||
    normalized.includes("404")
  );
}

function getGitLabProjectPath(repoRef: string): string {
  return encodeURIComponent(repoRef.split("/").slice(1).join("/"));
}
