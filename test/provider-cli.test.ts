import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLI_TIMEOUT_MS, runCli } from "../src/providers/cli.js";
import { githubAdapter } from "../src/providers/github.js";
import { type ProviderConfig, type RepoContext } from "../src/types.js";

const githubProvider: ProviderConfig = {
  kind: "github",
  ignoredBranches: ["main"],
  showNoPrState: false,
  hosts: {},
};

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
