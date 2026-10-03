import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLI_TIMEOUT_MS, isAuthErrorMessage, runCli } from "../src/providers/cli.js";
import { githubAdapter } from "../src/providers/github.js";
import { gitlabAdapter } from "../src/providers/gitlab.js";
import { type ProviderConfig, type RepoContext } from "../src/types.js";

const githubProvider: ProviderConfig = {
  kind: "github",
  ignoredBranches: ["main"],
  showNoPrState: false,
  hosts: {},
};

const gitlabProvider: ProviderConfig = { ...githubProvider, kind: "gitlab" };

const githubRepo: RepoContext = {
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

void test("runCli passes a timeout to pi.exec", async () => {
  const seen: unknown[] = [];
  const pi = {
    exec: (_command: string, _args: string[], options: unknown) => {
      seen.push(options);
      return Promise.resolve({ code: 0, stdout: "[]", stderr: "", killed: false });
    },
  } as unknown as ExtensionAPI;

  const result = await runCli(pi, "gh", ["pr", "list"]);
  assert.deepEqual(result, { code: 0, stdout: "[]", stderr: "" });
  assert.deepEqual(seen, [{ timeout: CLI_TIMEOUT_MS }]);
});

void test("a timed-out gh call is reported as an error instead of an empty success", async () => {
  // pi.exec resolves a killed process with exit code 0 and killed: true.
  const pi = {
    exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "", killed: true }),
  } as unknown as ExtensionAPI;

  const result = await githubAdapter.getPrByBranch(pi, githubRepo, githubProvider, "feature/x");
  assert.equal(result.kind, "error");
  assert.match(result.kind === "error" ? result.message : "", /`gh pr list` timed out after 60s/);
});

void test("isAuthErrorMessage matches HTTP auth failures but not 401/403 inside other text", () => {
  assert.equal(
    isAuthErrorMessage("HTTP 401: Bad credentials (https://api.github.com/graphql)"),
    true
  );
  assert.equal(isAuthErrorMessage("Resource not accessible by integration (HTTP 403)"), true);
  assert.equal(
    isAuthErrorMessage("GET .../merge_requests/1: 401 {message: 401 Unauthorized}"),
    true
  );
  assert.equal(
    isAuthErrorMessage("To get started with GitHub CLI, please run:  gh auth login"),
    true
  );
  assert.equal(
    isAuthErrorMessage("GraphQL: Could not resolve to a PullRequest with the number of 401."),
    false
  );
  assert.equal(isAuthErrorMessage("no pull requests found for branch fix-403-page"), false);
});

void test("a missing GitHub PR whose number contains 401 is reported as none, not an auth error", async () => {
  const pi = {
    exec: () =>
      Promise.resolve(
        fail(
          "GraphQL: Could not resolve to a PullRequest with the number of 401. (repository.pullRequest)"
        )
      ),
  } as unknown as ExtensionAPI;

  const result = await githubAdapter.getPrByRef(pi, githubRepo, githubProvider, {
    kind: "ref",
    provider: "github",
    iid: 401,
    ref: "#401",
  });
  assert.deepEqual(result, { kind: "none", provider: "github" });
});

void test("a GitLab 404 for a missing project is an error, not a missing MR", async () => {
  const pi = {
    exec: () =>
      Promise.resolve(
        fail(
          "GET https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests/1: 404 {message: 404 Project Not Found}"
        )
      ),
  } as unknown as ExtensionAPI;

  const result = await gitlabAdapter.getPrByRef(pi, githubRepo, gitlabProvider, {
    kind: "ref",
    provider: "gitlab",
    iid: 1,
    ref: "!1",
  });
  assert.equal(result.kind, "error");
});

function fail(stderr: string) {
  return { code: 1, stdout: "", stderr, killed: false };
}
