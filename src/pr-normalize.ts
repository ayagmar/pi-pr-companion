import {
  type PrCheckItem,
  type PrCheckStatus,
  type PrCheckSummary,
  type RepoDiffStats,
} from "./types.js";

export function buildCheckSummary(items: PrCheckItem[]): PrCheckSummary {
  if (items.length === 0) {
    return {
      status: "none",
      total: 0,
      successful: 0,
      failed: 0,
      pending: 0,
    };
  }

  let successful = 0;
  let failed = 0;
  let pending = 0;

  for (const item of items) {
    if (item.status === "success") {
      successful += 1;
      continue;
    }

    if (item.status === "failure") {
      failed += 1;
      continue;
    }

    pending += 1;
  }

  return {
    status: failed > 0 ? "failure" : pending > 0 ? "pending" : successful > 0 ? "success" : "none",
    total: items.length,
    successful,
    failed,
    pending,
  };
}

export function sumDiffStats(chunks: RepoDiffStats[]): RepoDiffStats | undefined {
  if (chunks.length === 0) {
    return undefined;
  }

  return chunks.reduce(
    (total, chunk) => ({
      additions: total.additions + chunk.additions,
      deletions: total.deletions + chunk.deletions,
    }),
    { additions: 0, deletions: 0 }
  );
}

export function countPatchDiffStats(diff: string): RepoDiffStats {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }

    // "--- a/file" and "+++ b/file" headers only appear before the first hunk.
    // Inside a hunk, "--- x" is a removed line that starts with "-- ".
    if (!inHunk) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    } else if (line.startsWith("diff --git ")) {
      inHunk = false;
    }
  }

  return { additions, deletions };
}

export function normalizeCheckStatus(value: string | undefined): PrCheckStatus {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "none";

  if (["success", "successful", "passed", "pass", "neutral", "skipped"].includes(normalized)) {
    return "success";
  }

  if (
    [
      "failure",
      "failed",
      "error",
      "cancelled",
      "canceled",
      "timed_out",
      "action_required",
      "startup_failure",
      "manual",
    ].includes(normalized)
  ) {
    return "failure";
  }

  return "pending";
}
