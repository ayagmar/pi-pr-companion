import type { PrCheckStatus, PrDetails, PrReadiness, PrSummary } from "./types.js";

export function evaluatePrReadiness(pr: PrSummary | PrDetails): PrReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const recommendations: string[] = [];

  if (pr.draft) {
    blockers.push("draft");
    recommendations.push("Mark the PR ready for review before merging.");
  }

  if (pr.hasConflicts || hasConflictMergeStatus(pr.detailedMergeStatus)) {
    blockers.push("conflicts");
    recommendations.push("Resolve merge conflicts against the target branch.");
  }

  if (needsRebase(pr.detailedMergeStatus, pr.behindTarget)) {
    blockers.push("rebase");
    recommendations.push("Rebase or merge the target branch before merging.");
  }

  const checkStatus = pr.checkSummary?.status ?? summarizeCheckStatus(pr.pipelineStatus);
  if (checkStatus === "failure") {
    blockers.push("checks");
    recommendations.push("Fix the failing checks before merging.");
  }

  if (checkStatus === "pending") {
    warnings.push("checks pending");
    recommendations.push("Wait for the pending checks to finish.");
  }

  const unresolvedThreads = pr.threadSummary?.unresolved ?? 0;
  if (unresolvedThreads > 0) {
    warnings.push(`${unresolvedThreads} unresolved thread${unresolvedThreads === 1 ? "" : "s"}`);
    recommendations.push("Resolve the remaining review threads.");
  }

  if (blockers.length > 0) {
    return {
      verdict: "blocked",
      blockers,
      warnings,
      recommendations,
    };
  }

  if (warnings.length > 0) {
    return {
      verdict: "needs-changes",
      blockers,
      warnings,
      recommendations,
    };
  }

  return {
    verdict: "ready",
    blockers,
    warnings,
    recommendations,
  };
}

export function summarizeCheckStatus(status: string | undefined): PrCheckStatus {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return "none";

  if (["failure", "failed", "error", "errors", "cancelled", "canceled"].includes(normalized)) {
    return "failure";
  }

  if (
    ["pending", "running", "created", "queued", "in_progress", "requested", "waiting"].includes(
      normalized
    )
  ) {
    return "pending";
  }

  if (["success", "successful", "passed", "pass"].includes(normalized)) {
    return "success";
  }

  return "pending";
}

export function getReadinessHint(pr: PrDetails): string | undefined {
  const readiness = pr.readiness ?? evaluatePrReadiness(pr);

  if (readiness.blockers.includes("rebase")) return "rebase";
  if (readiness.blockers.includes("conflicts")) return "conflicts";
  if (readiness.blockers.includes("draft")) return "draft";
  if (readiness.blockers.includes("checks")) return "checks";
  if (readiness.warnings.some((warning) => warning.startsWith("checks"))) return "checks";
  if (readiness.warnings.some((warning) => warning.includes("thread"))) return "threads";
  return undefined;
}

function hasConflictMergeStatus(status: string | undefined): boolean {
  const normalized = status?.toLowerCase();
  if (!normalized) return false;

  return normalized.includes("conflict") || normalized === "dirty";
}

function needsRebase(
  detailedMergeStatus: string | undefined,
  behindTarget: string | undefined
): boolean {
  const normalizedMergeStatus = detailedMergeStatus?.toLowerCase();
  const normalizedBehindTarget = behindTarget?.toLowerCase();

  return (
    Boolean(
      normalizedMergeStatus &&
      (normalizedMergeStatus.includes("rebase") || normalizedMergeStatus === "behind")
    ) || Boolean(normalizedBehindTarget && normalizedBehindTarget.includes("behind"))
  );
}
