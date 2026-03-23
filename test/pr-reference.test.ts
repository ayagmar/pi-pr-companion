import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parsePrReference } from "../src/pr-reference.js";
import { githubAdapter } from "../src/providers/github.js";
import { gitlabAdapter } from "../src/providers/gitlab.js";
import type { ProviderConfig, RepoContext } from "../src/types.js";

const githubProvider: ProviderConfig = {
  kind: "github",
  ignoredBranches: ["main"],
  showNoPrState: false,
  hosts: {},
};

const gitlabProvider: ProviderConfig = {
  kind: "gitlab",
  ignoredBranches: ["main"],
  showNoPrState: false,
  hosts: {},
};

const githubRepo: RepoContext = {
  cwd: "/workspace/repo",
  repoRoot: "/workspace/repo",
  branch: "feature/ref-support",
  remoteName: "origin",
  remoteUrl: "https://github.com/octo/repo.git",
  remote: {
    host: "github.com",
    fullPath: "octo/repo",
    repoRef: "github.com/octo/repo",
    webUrl: "https://github.com/octo/repo",
  },
};

const gitlabRepo: RepoContext = {
  cwd: "/workspace/repo",
  repoRoot: "/workspace/repo",
  branch: "feature/ref-support",
  remoteName: "origin",
  remoteUrl: "https://gitlab.example.com/group/repo.git",
  remote: {
    host: "gitlab.example.com",
    fullPath: "group/repo",
    repoRef: "gitlab.example.com/group/repo",
    webUrl: "https://gitlab.example.com/group/repo",
  },
};

void test("parsePrReference supports refs and provider URLs", () => {
  assert.deepEqual(parsePrReference("#42"), {
    kind: "ref",
    provider: "github",
    iid: 42,
    ref: "#42",
  });

  assert.deepEqual(parsePrReference("!53"), {
    kind: "ref",
    provider: "gitlab",
    iid: 53,
    ref: "!53",
  });

  assert.deepEqual(parsePrReference("https://github.com/octo/repo/pull/42?tab=files#diff"), {
    kind: "url",
    provider: "github",
    iid: 42,
    ref: "#42",
    url: "https://github.com/octo/repo/pull/42",
    remote: {
      host: "github.com",
      fullPath: "octo/repo",
      repoRef: "github.com/octo/repo",
      webUrl: "https://github.com/octo/repo",
    },
  });

  assert.deepEqual(
    parsePrReference("https://gitlab.example.com/group/subgroup/repo/-/merge_requests/53"),
    {
      kind: "url",
      provider: "gitlab",
      iid: 53,
      ref: "!53",
      url: "https://gitlab.example.com/group/subgroup/repo/-/merge_requests/53",
      remote: {
        host: "gitlab.example.com",
        fullPath: "group/subgroup/repo",
        repoRef: "gitlab.example.com/group/subgroup/repo",
        webUrl: "https://gitlab.example.com/group/subgroup/repo",
      },
    }
  );

  assert.equal(parsePrReference("feature/test"), undefined);
});

void test("githubAdapter resolves a PR by ref in the current repo", async () => {
  const calls: string[] = [];
  const pi = {
    exec: (command: string, args: string[]) => {
      const invocation = `${command} ${args.join(" ")}`;
      calls.push(invocation);

      if (command !== "gh") {
        throw new Error(`Unexpected command: ${invocation}`);
      }

      if (
        args.join(" ") ===
        "pr view 42 --repo github.com/octo/repo --json number,title,url,headRefName,baseRefName,updatedAt,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup"
      ) {
        return ok(
          JSON.stringify({
            number: 42,
            title: "feat: add ref lookup",
            url: "https://github.com/octo/repo/pull/42",
            headRefName: "feature/ref-support",
            baseRefName: "main",
            updatedAt: "2026-03-20T10:00:00Z",
            isDraft: false,
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
          })
        );
      }

      if (args.join(" ") === "api repos/octo/repo/pulls/42/files") {
        return ok(JSON.stringify([{ additions: 5, deletions: 2 }]));
      }

      if (
        args.join(" ") ===
        "api graphql -f query=query($owner: String!, $name: String!, $number: Int!) {\n  repository(owner: $owner, name: $name) {\n    pullRequest(number: $number) {\n      reviewThreads(first: 100) {\n        nodes {\n          isResolved\n          path\n          comments(first: 1) {\n            nodes {\n              body\n              author {\n                login\n              }\n            }\n          }\n        }\n      }\n      reviews(first: 100) {\n        nodes {\n          state\n        }\n      }\n    }\n  }\n} -f owner=octo -f name=repo -F number=42"
      ) {
        return ok(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        isResolved: false,
                        path: "src/index.ts",
                        comments: {
                          nodes: [{ body: "Please fix this.", author: { login: "octocat" } }],
                        },
                      },
                    ],
                  },
                  reviews: {
                    nodes: [{ state: "APPROVED" }],
                  },
                },
              },
            },
          })
        );
      }

      throw new Error(`Unexpected command: ${invocation}`);
    },
  } as unknown as ExtensionAPI;

  const result = await githubAdapter.getPrByRef(pi, githubRepo, githubProvider, {
    kind: "ref",
    provider: "github",
    iid: 42,
    ref: "#42",
  });

  assert.deepEqual(calls, [
    "gh pr view 42 --repo github.com/octo/repo --json number,title,url,headRefName,baseRefName,updatedAt,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup",
    "gh api repos/octo/repo/pulls/42/files",
    "gh api graphql -f query=query($owner: String!, $name: String!, $number: Int!) {\n  repository(owner: $owner, name: $name) {\n    pullRequest(number: $number) {\n      reviewThreads(first: 100) {\n        nodes {\n          isResolved\n          path\n          comments(first: 1) {\n            nodes {\n              body\n              author {\n                login\n              }\n            }\n          }\n        }\n      }\n      reviews(first: 100) {\n        nodes {\n          state\n        }\n      }\n    }\n  }\n} -f owner=octo -f name=repo -F number=42",
  ]);
  assert.equal(result.kind, "active");
  if (result.kind !== "active") {
    return;
  }
  assert.equal(result.pr.ref, "#42");
  assert.equal(result.pr.sourceBranch, "feature/ref-support");
  assert.equal(result.pr.pipelineStatus, "success");
  assert.deepEqual(result.pr.diffStats, { additions: 5, deletions: 2 });
  assert.equal(result.pr.threadSummary?.unresolved, 1);
  assert.equal(result.pr.approvalSummary?.approvedCount, 1);
});

void test("gitlabAdapter resolves a PR by URL without current repo context", async () => {
  const reference = parsePrReference(
    "https://gitlab.example.com/group/subgroup/repo/-/merge_requests/53"
  );
  assert.ok(reference && reference.kind === "url" && reference.provider === "gitlab");

  const calls: string[] = [];
  const pi = {
    exec: (command: string, args: string[]) => {
      const invocation = `${command} ${args.join(" ")}`;
      calls.push(invocation);

      if (command !== "glab") {
        throw new Error(`Unexpected command: ${invocation}`);
      }

      if (args.join(" ") === "-R gitlab.example.com/group/subgroup/repo mr view 53 --output json") {
        return ok(
          JSON.stringify({
            iid: 53,
            title: "feat: add url lookup",
            web_url: "https://gitlab.example.com/group/subgroup/repo/-/merge_requests/53",
            source_branch: "feature/url-support",
            target_branch: "main",
            updated_at: "2026-03-20T10:00:00Z",
            detailed_merge_status: "can_be_merged",
            draft: false,
            head_pipeline: {
              status: "running",
              coverage: "91.4",
            },
          })
        );
      }

      if (
        args.join(" ") ===
        "-R gitlab.example.com/group/subgroup/repo api projects/group%2Fsubgroup%2Frepo/merge_requests/53/discussions"
      ) {
        return ok(
          JSON.stringify([
            {
              id: "discussion-1",
              notes: [
                {
                  id: 1,
                  body: "Please tighten validation.",
                  resolvable: true,
                  resolved: false,
                  author: { username: "reviewer" },
                  position: { new_path: "src/handler.ts" },
                },
              ],
            },
          ])
        );
      }

      if (
        args.join(" ") ===
        "-R gitlab.example.com/group/subgroup/repo api projects/group%2Fsubgroup%2Frepo/merge_requests/53/approvals"
      ) {
        return ok(
          JSON.stringify({
            approved: true,
            approved_by: [{ user: { username: "reviewer" } }],
            approvals_required: 1,
          })
        );
      }

      if (
        args.join(" ") ===
        "-R gitlab.example.com/group/subgroup/repo api projects/group%2Fsubgroup%2Frepo/merge_requests/53/changes"
      ) {
        return ok(
          JSON.stringify({
            changes: [
              {
                diff: "@@\n+const next = value + 1;\n-if (value) {}\n",
              },
            ],
          })
        );
      }

      throw new Error(`Unexpected command: ${invocation}`);
    },
  } as unknown as ExtensionAPI;

  const result = await gitlabAdapter.getPrByUrl(pi, gitlabProvider, reference);

  assert.deepEqual(calls, [
    "glab -R gitlab.example.com/group/subgroup/repo mr view 53 --output json",
    "glab -R gitlab.example.com/group/subgroup/repo api projects/group%2Fsubgroup%2Frepo/merge_requests/53/discussions",
    "glab -R gitlab.example.com/group/subgroup/repo api projects/group%2Fsubgroup%2Frepo/merge_requests/53/approvals",
    "glab -R gitlab.example.com/group/subgroup/repo api projects/group%2Fsubgroup%2Frepo/merge_requests/53/changes",
  ]);
  assert.equal(result.kind, "active");
  if (result.kind !== "active") {
    return;
  }
  assert.equal(result.pr.ref, "!53");
  assert.equal(result.pr.sourceBranch, "feature/url-support");
  assert.equal(result.pr.coverage, "91.4");
  assert.equal(result.pr.pipelineStatus, "running");
  assert.equal(result.pr.threadSummary?.unresolved, 1);
  assert.deepEqual(result.pr.diffStats, { additions: 1, deletions: 1 });
  assert.equal(result.pr.approvalSummary?.approvedCount, 1);
});

void test("gitlabAdapter returns none when a referenced MR does not exist", async () => {
  const pi = {
    exec: () => fail("404 merge request not found\n"),
  } as unknown as ExtensionAPI;

  const result = await gitlabAdapter.getPrByRef(pi, gitlabRepo, gitlabProvider, {
    kind: "ref",
    provider: "gitlab",
    iid: 999,
    ref: "!999",
  });

  assert.deepEqual(result, { kind: "none", provider: "gitlab" });
});

function ok(stdout: string) {
  return {
    code: 0,
    stdout,
    stderr: "",
    killed: false,
  };
}

function fail(stderr: string) {
  return {
    code: 1,
    stdout: "",
    stderr,
    killed: false,
  };
}
