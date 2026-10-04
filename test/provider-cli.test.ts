import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CLI_TIMEOUT_MS,
  isAuthErrorMessage,
  parsePaginatedJsonArray,
  runCli,
} from "../src/providers/cli.js";
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

const gitlabRepo: RepoContext = {
  ...githubRepo,
  remoteUrl: "https://gitlab.example.com/g/r.git",
  remote: {
    host: "gitlab.example.com",
    fullPath: "g/r",
    repoRef: "gitlab.example.com/g/r",
    webUrl: "https://gitlab.example.com/g/r",
  },
};

void test("a GitLab server error for MR !404 is an error, not a missing MR", async () => {
  const pi = {
    exec: () =>
      Promise.resolve(
        fail(
          "GET https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests/404: 500 {message: 500 Internal Server Error}"
        )
      ),
  } as unknown as ExtensionAPI;

  const result = await gitlabAdapter.getPrByRef(pi, gitlabRepo, gitlabProvider, {
    kind: "ref",
    provider: "gitlab",
    iid: 404,
    ref: "!404",
  });
  assert.equal(result.kind, "error");
});

void test("a failed GitLab MR list for branch fix-404 is an error, not a missing MR", async () => {
  const pi = {
    exec: () =>
      Promise.resolve(
        fail(
          "GET https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests?source_branch=fix-404: 502 {message: 502 Bad Gateway}"
        )
      ),
  } as unknown as ExtensionAPI;

  const result = await gitlabAdapter.getPrByBranch(pi, gitlabRepo, gitlabProvider, "fix-404");
  assert.equal(result.kind, "error");
});

void test("a GitLab 404 status for a missing MR is still reported as none", async () => {
  for (const stderr of [
    "GET https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests/9999: 404 {message: 404 Not Found}",
    "ERROR: 404 Not Found",
  ]) {
    const pi = { exec: () => Promise.resolve(fail(stderr)) } as unknown as ExtensionAPI;
    const result = await gitlabAdapter.getPrByRef(pi, gitlabRepo, gitlabProvider, {
      kind: "ref",
      provider: "gitlab",
      iid: 9999,
      ref: "!9999",
    });
    assert.deepEqual(result, { kind: "none", provider: "gitlab" }, stderr);
  }
});

function fail(stderr: string) {
  return { code: 1, stdout: "", stderr, killed: false };
}

void test("parsePaginatedJsonArray accepts merged and back-to-back pages", () => {
  assert.deepEqual(parsePaginatedJsonArray('[{"a":"]["}]'), [{ a: "][" }]);
  assert.deepEqual(parsePaginatedJsonArray('[1,2]\n[3]  [{"s":"x\\"]"}]'), [1, 2, 3, { s: 'x"]' }]);
  assert.deepEqual(parsePaginatedJsonArray("[]"), []);
  assert.throws(() => parsePaginatedJsonArray('{"message":"404 Not Found"}'));
  assert.throws(() => parsePaginatedJsonArray("[1,"));
});
