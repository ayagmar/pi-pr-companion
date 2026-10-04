import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluatePrReadiness, getReadinessHint } from "../src/pr-readiness.js";
import { githubAdapter } from "../src/providers/github.js";
import { type ProviderConfig, type RepoContext } from "../src/types.js";

const provider: ProviderConfig = {
  kind: "github",
  ignoredBranches: ["main"],
  showNoPrState: false,
  hosts: {},
};

const repo: RepoContext = {
  cwd: "/workspace/repo",
  repoRoot: "/workspace/repo",
  branch: "feature/x",
  remoteName: "origin",
  remoteUrl: "https://github.com/octo/repo.git",
  remote: {
    host: "github.com",
    fullPath: "octo/repo",
    repoRef: "github.com/octo/repo",
    webUrl: "https://github.com/octo/repo",
  },
};

const PR_VIEW = {
  number: 42,
  title: "feat: x",
  url: "https://github.com/octo/repo/pull/42",
  headRefName: "feature/x",
  baseRefName: "main",
  updatedAt: "2026-03-20T10:00:00Z",
  isDraft: false,
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  statusCheckRollup: [],
  additions: 1,
  deletions: 1,
};

function mockGh(graphql: () => { code: number; stdout: string; stderr: string }): ExtensionAPI {
  return {
    exec: (_command: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve({ code: 0, stdout: JSON.stringify(PR_VIEW), stderr: "" });
      }
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(graphql());
      }
      throw new Error(`Unexpected: gh ${args.join(" ")}`);
    },
  } as unknown as ExtensionAPI;
}

const byRef = { kind: "ref", provider: "github", iid: 42, ref: "#42" } as const;

void test("approvals are counted once per reviewer from their latest opinionated review", async () => {
  const pi = mockGh(() => ({
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [] },
            // Every review event: one reviewer approved twice, another requested
            // changes and later approved. The per-reviewer view below is what counts.
            reviews: {
              nodes: [
                { state: "APPROVED" },
                { state: "APPROVED" },
                { state: "CHANGES_REQUESTED" },
                { state: "APPROVED" },
                { state: "COMMENTED" },
              ],
            },
            latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }, { state: "APPROVED" }] },
          },
        },
      },
    }),
  }));

  const result = await githubAdapter.getPrByRef(pi, repo, provider, byRef);
  assert.equal(result.kind, "active");
  assert.deepEqual(result.kind === "active" ? result.pr.approvalSummary : undefined, {
    decision: "APPROVED",
    approvedCount: 2,
  });
});

void test("a failed review threads query keeps the PR instead of failing the lookup", async () => {
  const pi = mockGh(() => ({
    code: 1,
    stdout: "",
    stderr: "HTTP 403: Resource not accessible by integration (https://api.github.com/graphql)",
  }));

  const result = await githubAdapter.getPrByRef(pi, repo, provider, byRef);
  assert.equal(result.kind, "active");
  if (result.kind !== "active") return;
  assert.equal(result.pr.ref, "#42");
  assert.deepEqual(result.pr.diffStats, { additions: 1, deletions: 1 });
  assert.deepEqual(result.pr.approvalSummary, { decision: "APPROVED" });
  assert.equal(result.pr.threadSummary, undefined);
});

void test("a merged PR looked up by reference is reported as merged and not ready", async () => {
  const pi = {
    exec: (_command: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ ...PR_VIEW, state: "MERGED" }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
  } as unknown as ExtensionAPI;

  const result = await githubAdapter.getPrByRef(pi, repo, provider, byRef);
  assert.equal(result.kind, "active");
  if (result.kind !== "active") return;
  assert.equal(result.pr.state, "merged");
  const readiness = evaluatePrReadiness(result.pr);
  assert.equal(readiness.verdict, "blocked");
  assert.deepEqual(readiness.blockers, ["merged"]);
  assert.equal(getReadinessHint(result.pr), "merged");
});

void test("listing open PRs asks for more than gh's default 30", async () => {
  const calls: string[][] = [];
  const pi = {
    exec: (_command: string, args: string[]) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
    },
  } as unknown as ExtensionAPI;

  assert.deepEqual(await githubAdapter.listRepoActivePrs(pi, repo, provider), []);
  assert.equal(calls[0]?.[calls[0].indexOf("--limit") + 1], "100");
});

void test("a fork PR is flagged and ignored by the branch lookup", async () => {
  const forkPr = {
    ...PR_VIEW,
    number: 43,
    url: "https://github.com/octo/repo/pull/43",
    headRefName: "main",
    isCrossRepository: true,
  };
  const calls: string[] = [];
  const pi = {
    exec: (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve({ code: 0, stdout: JSON.stringify([forkPr]), stderr: "" });
      }
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve({ code: 0, stdout: JSON.stringify(forkPr), stderr: "" });
      }
      if (args[0] === "api") return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      throw new Error(`Unexpected: gh ${args.join(" ")}`);
    },
  } as unknown as ExtensionAPI;

  const byBranch = await githubAdapter.getPrByBranch(
    pi,
    { ...repo, branch: "main" },
    provider,
    "main"
  );
  assert.equal(byBranch.kind, "none", "a fork's main is not this repo's main");
  assert.ok(calls.some((call) => call.includes("isCrossRepository")));

  const byNumber = await githubAdapter.getPrByRef(pi, repo, provider, {
    kind: "ref",
    provider: "github",
    iid: 43,
    ref: "#43",
  });
  assert.equal(byNumber.kind === "active" ? byNumber.pr.fromFork : undefined, true);

  const listed = await githubAdapter.listRepoActivePrs(pi, repo, provider);
  assert.ok(Array.isArray(listed));
  assert.equal(Array.isArray(listed) ? listed[0]?.fromFork : undefined, true);
});
