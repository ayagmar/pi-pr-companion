import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePrContext } from "../src/pr-resolver.js";

const PR_VIEW = {
  number: 42,
  title: "feat: other branch",
  url: "https://github.com/octo/repo/pull/42",
  headRefName: "feature/other",
  baseRefName: "main",
  updatedAt: "2026-03-20T10:00:00Z",
  isDraft: false,
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [],
  additions: 120,
  deletions: 30,
};

function createPi(currentBranch: string, calls: string[]): ExtensionAPI {
  const ok = (stdout: string) => Promise.resolve({ code: 0, stdout, stderr: "" });
  return {
    exec: (command: string, args: string[]) => {
      const joined = args.join(" ");
      calls.push(`${command} ${joined}`);
      if (command === "git") {
        if (joined.includes("rev-parse --show-toplevel")) return ok("/workspace/repo\n");
        if (joined.includes("branch --show-current")) return ok(`${currentBranch}\n`);
        if (joined.includes("config --get branch.")) {
          return Promise.resolve({ code: 1, stdout: "", stderr: "" });
        }
        if (joined.includes("remote get-url origin"))
          return ok("https://github.com/octo/repo.git\n");
        if (joined.includes("diff --shortstat")) {
          return ok(" 2 files changed, 3 insertions(+), 1 deletion(-)\n");
        }
      }
      if (command === "gh" && joined.startsWith("pr view 42")) return ok(JSON.stringify(PR_VIEW));
      if (command === "gh" && joined.startsWith("api graphql")) return ok("{}");
      throw new Error(`Unexpected: ${command} ${joined}`);
    },
  } as unknown as ExtensionAPI;
}

void test("/pr status #ref keeps the PR's diff stats when another branch is checked out", async () => {
  const previous = process.env.PI_PR_COMPANION_CONFIG;
  process.env.PI_PR_COMPANION_CONFIG = "/nonexistent/pi-pr-companion-settings.json";
  try {
    const calls: string[] = [];
    const resolved = await resolvePrContext(
      createPi("feature/mine", calls),
      "/workspace/repo",
      "#42"
    );
    assert.equal(resolved.result?.kind, "active");
    assert.deepEqual(
      resolved.result?.kind === "active" ? resolved.result.pr.diffStats : undefined,
      { additions: 120, deletions: 30 }
    );
    assert.equal(calls.filter((call) => call.includes("diff --shortstat")).length, 0);

    const onBranch = await resolvePrContext(
      createPi("feature/other", []),
      "/workspace/repo",
      "#42"
    );
    assert.deepEqual(
      onBranch.result?.kind === "active" ? onBranch.result.pr.diffStats : undefined,
      { additions: 3, deletions: 1 },
      "the local diff is used when the PR branch is checked out"
    );
  } finally {
    if (previous === undefined) delete process.env.PI_PR_COMPANION_CONFIG;
    else process.env.PI_PR_COMPANION_CONFIG = previous;
  }
});

void test("a detached HEAD still resolves the repo for PR refs", async () => {
  const previous = process.env.PI_PR_COMPANION_CONFIG;
  process.env.PI_PR_COMPANION_CONFIG = "/nonexistent/pi-pr-companion-settings.json";
  try {
    const calls: string[] = [];
    const current = await resolvePrContext(createPi("", calls), "/workspace/repo");
    assert.equal(current.reason, "detached-head");
    assert.equal(current.repo?.repoRoot, "/workspace/repo");
    assert.match(current.errorMessage ?? "", /HEAD is detached/);
    assert.equal(calls.filter((call) => call.startsWith("gh ")).length, 0);
    assert.equal(calls.filter((call) => call.includes("config --get branch.")).length, 0);

    const byRef = await resolvePrContext(createPi("", []), "/workspace/repo", "#42");
    assert.equal(byRef.result?.kind, "active");
  } finally {
    if (previous === undefined) delete process.env.PI_PR_COMPANION_CONFIG;
    else process.env.PI_PR_COMPANION_CONFIG = previous;
  }
});
