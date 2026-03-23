import path from "node:path";
import { evaluatePrReadiness, getReadinessHint } from "./pr-readiness.js";
import type { PrCompanionConfig, PrSummary } from "./types.js";

export function formatPickerEntry(
  pr: PrSummary,
  config: PrCompanionConfig,
  now = Date.now()
): string {
  const readiness = pr.readiness ?? evaluatePrReadiness(pr);
  const hint = getReadinessHint({ ...pr, readiness });
  const badges = [
    pr.draft ? "draft" : undefined,
    hint,
    isStalePr(pr.updatedAt, config, now) ? "stale" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const target = `→ ${pr.targetBranch}`;
  const updated = config.showUpdatedAgeInPickers ? formatUpdatedAge(pr.updatedAt, now) : undefined;
  const right = [badges || undefined, updated].filter(Boolean).join(" • ");

  return [
    `${pr.ref}`,
    `${pr.title}`,
    `(${pr.sourceBranch} ${target}${right ? ` • ${right}` : ""})`,
  ].join(" | ");
}

export function formatUpdatedAge(updatedAt: string, now = Date.now()): string {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return "?";

  const deltaMs = Math.max(0, now - updatedAtMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function sortPrsForActionability(prs: PrSummary[]): PrSummary[] {
  return [...prs].sort((left, right) => {
    const leftRank = getVerdictRank(left.readiness?.verdict ?? evaluatePrReadiness(left).verdict);
    const rightRank = getVerdictRank(
      right.readiness?.verdict ?? evaluatePrReadiness(right).verdict
    );
    if (leftRank !== rightRank) {
      return rightRank - leftRank;
    }

    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

export function buildDashboardTitle(repoRoot: string): string {
  return `PR dashboard · ${path.basename(repoRoot)}`;
}

export function isStalePr(updatedAt: string, config: PrCompanionConfig, now = Date.now()): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false;

  const staleAfterMs = config.stalePrDays * 24 * 60 * 60 * 1000;
  return now - updatedAtMs >= staleAfterMs;
}

function getVerdictRank(verdict: "ready" | "needs-changes" | "blocked"): number {
  if (verdict === "blocked") return 2;
  if (verdict === "needs-changes") return 1;
  return 0;
}
