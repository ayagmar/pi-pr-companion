interface BranchSwitchSuccessMessageOptions {
  repoRoot: string;
  branch: string;
  prRef: string;
  fastForwarded: boolean;
  remoteName?: string | undefined;
  fastForwardCommitCount?: number | undefined;
}

export function formatBranchSwitchSuccessMessage(
  options: BranchSwitchSuccessMessageOptions
): string {
  const base = `Switched ${options.repoRoot} to ${options.branch} (${options.prRef})`;
  if (!options.fastForwarded) {
    return `${base} without remote update.`;
  }

  const remoteLabel = options.remoteName ?? "remote";
  const deltaSummary = formatCommitCountSummary(options.fastForwardCommitCount);
  return `${base} and fast-forwarded from ${remoteLabel}${deltaSummary}.`;
}

function formatCommitCountSummary(commitCount: number | undefined): string {
  if (!commitCount || commitCount < 1) {
    return "";
  }

  return ` (${commitCount} ${commitCount === 1 ? "commit" : "commits"})`;
}
