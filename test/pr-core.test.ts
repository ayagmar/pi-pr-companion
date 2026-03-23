import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultConfig,
  getConfigPath,
  getProviderConfig,
  normalizeConfig,
  saveConfig,
  setShowCoverageInStatusBar,
  setShowStatusBar,
  setStatusBarStyle,
} from "../src/config.js";
import { getDiffStats, parseGitRemote, resolveRepoContext, switchToBranch } from "../src/git.js";
import { detectProviderKind } from "../src/providers/index.js";
import { formatPickerEntry, formatUpdatedAge } from "../src/pr-display.js";
import { getGitHubPrSeverity } from "../src/providers/github.js";
import { getGitLabPrSeverity } from "../src/providers/gitlab.js";
import { formatStatusText } from "../src/pr-state.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

void test("defaultConfig uses generic provider settings", () => {
  const config = defaultConfig();
  assert.equal(config.showStatusBar, true);
  assert.equal(config.statusBarStyle, "diff-prefix");
  assert.equal(config.showCoverageInStatusBar, false);
  assert.equal(config.showBlockerHintInStatusBar, true);
  assert.equal(config.showUpdatedAgeInPickers, true);
  assert.equal(config.reviewSessionMode, false);
  assert.deepEqual(config.workspaceRoots, []);
  assert.equal(config.providers.length, 2);
});

void test("getConfigPath defaults to global pi agent settings file", () => {
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_PR_COMPANION_CONFIG;
  delete process.env.PI_CODING_AGENT_DIR;

  try {
    assert.match(getConfigPath(), /\.pi\/agent\/pi-pr-companion-settings\.json$/);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PI_PR_COMPANION_CONFIG;
    } else {
      process.env.PI_PR_COMPANION_CONFIG = previousConfigPath;
    }

    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

void test("getConfigPath respects PI_CODING_AGENT_DIR", () => {
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_PR_COMPANION_CONFIG;
  process.env.PI_CODING_AGENT_DIR = "~/custom-pi-agent";

  try {
    assert.match(getConfigPath(), /custom-pi-agent\/pi-pr-companion-settings\.json$/);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PI_PR_COMPANION_CONFIG;
    } else {
      process.env.PI_PR_COMPANION_CONFIG = previousConfigPath;
    }

    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

void test("normalizeConfig trims branch names and keeps supported providers", () => {
  const config = normalizeConfig({
    showStatusBar: false,
    statusBarStyle: "minimal",
    showCoverageInStatusBar: true,
    providers: [
      {
        kind: "gitlab",
        ignoredBranches: [" main ", " master "],
        showNoPrState: false,
        hosts: { " gitlab.example.com ": { enabled: true } },
      },
      {
        kind: "github",
        ignoredBranches: [" main "],
        showNoPrState: false,
        hosts: { " github.com ": { enabled: true } },
      },
      {
        kind: "unsupported",
      },
    ],
  });

  assert.equal(config.showStatusBar, false);
  assert.equal(config.statusBarStyle, "minimal");
  assert.equal(config.showCoverageInStatusBar, true);
  assert.equal(config.providers.length, 2);
  assert.deepEqual(
    config.providers.find((provider) => provider.kind === "gitlab")?.ignoredBranches,
    ["main", "master"]
  );
  assert.equal(
    config.providers.find((provider) => provider.kind === "gitlab")?.hosts["gitlab.example.com"]
      ?.enabled,
    true
  );
});

void test("getProviderConfig returns configured provider settings by kind", () => {
  const config = normalizeConfig({
    providers: [
      {
        kind: "gitlab",
        ignoredBranches: ["main", "release"],
        showNoPrState: true,
        hosts: { "gitlab.example.com": { enabled: false } },
      },
    ],
  });

  assert.deepEqual(getProviderConfig(config, "gitlab"), {
    kind: "gitlab",
    ignoredBranches: ["main", "release"],
    showNoPrState: true,
    hosts: { "gitlab.example.com": { enabled: false } },
  });
  assert.equal(getProviderConfig(config, "github")?.kind, "github");
});

void test("detectProviderKind falls back to explicit host config for custom domains", () => {
  const config = normalizeConfig({
    providers: [
      {
        kind: "github",
        ignoredBranches: ["main"],
        showNoPrState: false,
        hosts: { "code.example.com": { enabled: true } },
      },
      {
        kind: "gitlab",
        ignoredBranches: ["main"],
        showNoPrState: false,
        hosts: {},
      },
    ],
  });

  assert.equal(
    detectProviderKind(config, {
      cwd: "/workspace/repo",
      repoRoot: "/workspace/repo",
      branch: "feature/test",
      remoteName: "origin",
      remoteUrl: "git@code.example.com:team/repo.git",
      remote: {
        host: "code.example.com",
        fullPath: "team/repo",
        repoRef: "code.example.com/team/repo",
        webUrl: "https://code.example.com/team/repo",
      },
    }),
    "github"
  );
});

void test("status bar config helpers update footer preferences", () => {
  const initial = defaultConfig();

  const hidden = setShowStatusBar(initial, false);
  assert.equal(hidden.changed, true);
  assert.equal(hidden.config.showStatusBar, false);

  const style = setStatusBarStyle(hidden.config, "diff-suffix");
  assert.equal(style.changed, true);
  assert.equal(style.config.statusBarStyle, "diff-suffix");

  const coverage = setShowCoverageInStatusBar(style.config, true);
  assert.equal(coverage.changed, true);
  assert.equal(coverage.config.showCoverageInStatusBar, true);
});

void test("saveConfig persists normalized config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-pr-config-"));
  const configPath = path.join(tempDir, "config.json");
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  process.env.PI_PR_COMPANION_CONFIG = configPath;

  try {
    await saveConfig(
      normalizeConfig({
        statusBarStyle: "diff-suffix",
        showCoverageInStatusBar: true,
        providers: [
          {
            kind: "gitlab",
            ignoredBranches: ["main"],
            showNoPrState: false,
            hosts: {},
          },
        ],
      })
    );

    const saved = await readFile(configPath, "utf8");
    assert.match(saved, /"gitlab"/);
    assert.match(saved, /"diff-suffix"/);
    assert.match(saved, /"showCoverageInStatusBar": true/);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PI_PR_COMPANION_CONFIG;
    } else {
      process.env.PI_PR_COMPANION_CONFIG = previousConfigPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

void test("parseGitRemote supports https and ssh remotes", () => {
  assert.deepEqual(parseGitRemote("https://gitlab.example.com/group/project.git"), {
    host: "gitlab.example.com",
    fullPath: "group/project",
    repoRef: "gitlab.example.com/group/project",
    webUrl: "https://gitlab.example.com/group/project",
  });

  assert.deepEqual(parseGitRemote("git@gitlab.example.com:group/project.git"), {
    host: "gitlab.example.com",
    fullPath: "group/project",
    repoRef: "gitlab.example.com/group/project",
    webUrl: "https://gitlab.example.com/group/project",
  });

  assert.deepEqual(parseGitRemote("ssh://git@gitlab.example.com:2222/group/project.git"), {
    host: "gitlab.example.com",
    fullPath: "group/project",
    repoRef: "gitlab.example.com/group/project",
    webUrl: "https://gitlab.example.com/group/project",
  });
});

void test("getDiffStats parses shortstat output", async () => {
  const pi = {
    exec: () => ({
      code: 0,
      stdout: " 3 files changed, 12 insertions(+), 4 deletions(-)\n",
      stderr: "",
      killed: false,
    }),
  } as unknown as ExtensionAPI;

  const stats = await getDiffStats(pi, "/workspace/orange/customer-profile-service", "main");
  assert.deepEqual(stats, { additions: 12, deletions: 4 });
});

void test("picker formatting marks stale PRs and handles invalid timestamps", () => {
  const config = normalizeConfig({ stalePrDays: 7 });
  const now = Date.parse("2026-03-22T12:00:00Z");
  const entry = formatPickerEntry(
    {
      iid: 12,
      ref: "!12",
      title: "feat: stale PR",
      url: "https://gitlab.example.com/group/project/-/merge_requests/12",
      sourceBranch: "feat/stale",
      targetBranch: "main",
      updatedAt: "2026-03-01T12:00:00Z",
    },
    config,
    now
  );

  assert.match(entry, /stale/);
  assert.equal(formatUpdatedAge("not-a-date", now), "?");
});

void test("resolveRepoContext prefers the branch upstream remote before origin", async () => {
  const calls: string[] = [];
  const pi = {
    exec: (command: string, args: string[]) => {
      const invocation = `${command} ${args.join(" ")}`;
      calls.push(invocation);

      if (command !== "git") {
        throw new Error(`Unexpected command: ${invocation}`);
      }

      if (args.join(" ") === "-C /workspace/repo rev-parse --show-toplevel") {
        return ok("/workspace/repo\n");
      }

      if (args.join(" ") === "-C /workspace/repo branch --show-current") {
        return ok("feature/fork-pr\n");
      }

      if (args.join(" ") === "-C /workspace/repo config --get branch.feature/fork-pr.remote") {
        return ok("upstream\n");
      }

      if (args.join(" ") === "-C /workspace/repo remote get-url upstream") {
        return ok("git@github.com:octo/repo.git\n");
      }

      throw new Error(`Unexpected command: ${invocation}`);
    },
  } as unknown as ExtensionAPI;

  const repo = await resolveRepoContext(pi, "/workspace/repo");

  assert.deepEqual(calls, [
    "git -C /workspace/repo rev-parse --show-toplevel",
    "git -C /workspace/repo branch --show-current",
    "git -C /workspace/repo config --get branch.feature/fork-pr.remote",
    "git -C /workspace/repo remote get-url upstream",
  ]);
  assert.deepEqual(repo, {
    cwd: "/workspace/repo",
    repoRoot: "/workspace/repo",
    branch: "feature/fork-pr",
    remoteName: "upstream",
    remoteUrl: "git@github.com:octo/repo.git",
    remote: {
      host: "github.com",
      fullPath: "octo/repo",
      repoRef: "github.com/octo/repo",
      webUrl: "https://github.com/octo/repo",
    },
  });
});

void test("getDiffStats and switchToBranch honor a non-origin remote", async () => {
  const calls: string[] = [];
  const pi = {
    exec: (command: string, args: string[]) => {
      const invocation = `${command} ${args.join(" ")}`;
      calls.push(invocation);

      if (command !== "git") {
        throw new Error(`Unexpected command: ${invocation}`);
      }

      if (args.join(" ") === "-C /workspace/repo diff --shortstat upstream/main...HEAD") {
        return ok(" 2 files changed, 9 insertions(+), 1 deletion(-)\n");
      }

      if (args.join(" ") === "-C /workspace/repo switch feature/fork-pr") {
        return ok("Switched to branch 'feature/fork-pr'\n");
      }

      if (
        args.join(" ") ===
        "-C /workspace/repo fetch upstream refs/heads/feature/fork-pr:refs/remotes/upstream/feature/fork-pr"
      ) {
        return ok("");
      }

      if (args.join(" ") === "-C /workspace/repo rev-list --count HEAD..upstream/feature/fork-pr") {
        return ok("2\n");
      }

      if (args.join(" ") === "-C /workspace/repo merge --ff-only upstream/feature/fork-pr") {
        return ok("Updating 123..456\nFast-forward\n");
      }

      throw new Error(`Unexpected command: ${invocation}`);
    },
  } as unknown as ExtensionAPI;

  const stats = await getDiffStats(pi, "/workspace/repo", "main", { remoteName: "upstream" });
  const switched = await switchToBranch(pi, "/workspace/repo", "feature/fork-pr", {
    remoteName: "upstream",
  });

  assert.deepEqual(stats, { additions: 9, deletions: 1 });
  assert.equal(switched.ok, true);
  if (switched.ok) {
    assert.equal(switched.remoteName, "upstream");
    assert.equal(switched.fastForwardCommitCount, 2);
  }
  assert.deepEqual(calls, [
    "git -C /workspace/repo diff --shortstat upstream/main...HEAD",
    "git -C /workspace/repo switch feature/fork-pr",
    "git -C /workspace/repo fetch upstream refs/heads/feature/fork-pr:refs/remotes/upstream/feature/fork-pr",
    "git -C /workspace/repo rev-list --count HEAD..upstream/feature/fork-pr",
    "git -C /workspace/repo merge --ff-only upstream/feature/fork-pr",
  ]);
});

void test("switchToBranch keeps switched-without-update distinct from fast-forwarded", async () => {
  const pi = {
    exec: (command: string, args: string[]) => {
      const invocation = `${command} ${args.join(" ")}`;

      if (command !== "git") {
        throw new Error(`Unexpected command: ${invocation}`);
      }

      if (args.join(" ") === "-C /workspace/repo switch feat/observability-tweak") {
        return {
          code: 0,
          stdout: "Switched to branch 'feat/observability-tweak'\n",
          stderr: "",
          killed: false,
        };
      }

      if (
        args.join(" ") ===
        "-C /workspace/repo fetch origin refs/heads/feat/observability-tweak:refs/remotes/origin/feat/observability-tweak"
      ) {
        return {
          code: 0,
          stdout: "",
          stderr: "",
          killed: false,
        };
      }

      if (
        args.join(" ") ===
        "-C /workspace/repo rev-list --count HEAD..origin/feat/observability-tweak"
      ) {
        return {
          code: 0,
          stdout: "0\n",
          stderr: "",
          killed: false,
        };
      }

      if (args.join(" ") === "-C /workspace/repo merge --ff-only origin/feat/observability-tweak") {
        return {
          code: 0,
          stdout: "Already up to date.\n",
          stderr: "",
          killed: false,
        };
      }

      throw new Error(`Unexpected command: ${invocation}`);
    },
  } as unknown as ExtensionAPI;

  const result = await switchToBranch(pi, "/workspace/repo", "feat/observability-tweak");

  assert.equal(result.ok, true);
  assert.equal(result.fastForwarded, false);
  assert.equal(result.remoteName, undefined);
  assert.equal(result.fastForwardCommitCount, undefined);
  assert.match(result.message, /Switched to branch/);
});

void test("switchToBranch fast-forwards an existing local branch after switching", async () => {
  const calls: string[] = [];
  const pi = {
    exec: (command: string, args: string[]) => {
      const invocation = `${command} ${args.join(" ")}`;
      calls.push(invocation);

      if (command !== "git") {
        throw new Error(`Unexpected command: ${invocation}`);
      }

      if (args.join(" ") === "-C /workspace/repo switch feat/observability-tweak") {
        return {
          code: 0,
          stdout: "Switched to branch 'feat/observability-tweak'\n",
          stderr: "",
          killed: false,
        };
      }

      if (
        args.join(" ") ===
        "-C /workspace/repo fetch origin refs/heads/feat/observability-tweak:refs/remotes/origin/feat/observability-tweak"
      ) {
        return {
          code: 0,
          stdout: "",
          stderr: "",
          killed: false,
        };
      }

      if (
        args.join(" ") ===
        "-C /workspace/repo rev-list --count HEAD..origin/feat/observability-tweak"
      ) {
        return {
          code: 0,
          stdout: "3\n",
          stderr: "",
          killed: false,
        };
      }

      if (args.join(" ") === "-C /workspace/repo merge --ff-only origin/feat/observability-tweak") {
        return {
          code: 0,
          stdout: "Updating 123..456\nFast-forward\n",
          stderr: "",
          killed: false,
        };
      }

      throw new Error(`Unexpected command: ${invocation}`);
    },
  } as unknown as ExtensionAPI;

  const result = await switchToBranch(pi, "/workspace/repo", "feat/observability-tweak");

  assert.equal(result.ok, true);
  assert.equal(result.fastForwarded, true);
  assert.equal(result.remoteName, "origin");
  assert.equal(result.fastForwardCommitCount, 3);
  assert.match(result.message, /Switched to branch/);
  assert.deepEqual(calls, [
    "git -C /workspace/repo switch feat/observability-tweak",
    "git -C /workspace/repo fetch origin refs/heads/feat/observability-tweak:refs/remotes/origin/feat/observability-tweak",
    "git -C /workspace/repo rev-list --count HEAD..origin/feat/observability-tweak",
    "git -C /workspace/repo merge --ff-only origin/feat/observability-tweak",
  ]);
});

void test("switchToBranch fetches the remote branch when local refs are stale", async () => {
  const calls: string[] = [];
  const pi = {
    exec: (command: string, args: string[]) => {
      const invocation = `${command} ${args.join(" ")}`;
      calls.push(invocation);

      if (command !== "git") {
        throw new Error(`Unexpected command: ${invocation}`);
      }

      if (args.join(" ") === "-C /workspace/repo switch feat/observability-tweak") {
        return {
          code: 128,
          stdout: "",
          stderr: "fatal: invalid reference: feat/observability-tweak\n",
          killed: false,
        };
      }

      if (
        args.join(" ") ===
        "-C /workspace/repo switch -c feat/observability-tweak --track origin/feat/observability-tweak"
      ) {
        const attempts = calls.filter((call) =>
          call.includes("switch -c feat/observability-tweak")
        ).length;
        return attempts === 1
          ? {
              code: 128,
              stdout: "",
              stderr: "fatal: invalid reference: origin/feat/observability-tweak\n",
              killed: false,
            }
          : {
              code: 0,
              stdout:
                "branch 'feat/observability-tweak' set up to track 'origin/feat/observability-tweak'.\n",
              stderr: "",
              killed: false,
            };
      }

      if (
        args.join(" ") ===
        "-C /workspace/repo fetch origin refs/heads/feat/observability-tweak:refs/remotes/origin/feat/observability-tweak"
      ) {
        return {
          code: 0,
          stdout: "",
          stderr: "",
          killed: false,
        };
      }

      throw new Error(`Unexpected command: ${invocation}`);
    },
  } as unknown as ExtensionAPI;

  const result = await switchToBranch(pi, "/workspace/repo", "feat/observability-tweak");

  assert.equal(result.ok, true);
  assert.equal(result.fastForwarded, false);
  assert.match(result.message, /set up to track/);
  assert.deepEqual(calls, [
    "git -C /workspace/repo switch feat/observability-tweak",
    "git -C /workspace/repo switch -c feat/observability-tweak --track origin/feat/observability-tweak",
    "git -C /workspace/repo fetch origin refs/heads/feat/observability-tweak:refs/remotes/origin/feat/observability-tweak",
    "git -C /workspace/repo switch -c feat/observability-tweak --track origin/feat/observability-tweak",
  ]);
});

void test("gitlab severity and status text map to footer states", () => {
  const blocked = getGitLabPrSeverity({
    iid: 53,
    ref: "!53",
    title: "Example",
    url: "https://gitlab.example.com/group/project/-/merge_requests/53",
    sourceBranch: "feat/example",
    targetBranch: "main",
    updatedAt: "2026-03-16T00:00:00Z",
    pipelineStatus: "success",
    detailedMergeStatus: "need_rebase",
  });
  assert.equal(blocked, "blocked");

  const github = getGitHubPrSeverity({
    iid: 42,
    ref: "#42",
    title: "Example",
    url: "https://github.com/octo/repo/pull/42",
    sourceBranch: "feat/example",
    targetBranch: "main",
    updatedAt: "2026-03-16T00:00:00Z",
    pipelineStatus: "success",
    detailedMergeStatus: "CLEAN",
  });
  assert.equal(github, "success");

  const pr = {
    iid: 53,
    ref: "!53",
    title: "Example",
    url: "https://gitlab.example.com/group/project/-/merge_requests/53",
    sourceBranch: "feat/example",
    targetBranch: "main",
    updatedAt: "2026-03-16T00:00:00Z",
    pipelineStatus: "success",
    detailedMergeStatus: "need_rebase",
    diffStats: { additions: 12, deletions: 4 },
    coverage: "97.36",
  };

  assert.equal(formatStatusText({ kind: "active", provider: "gitlab", pr }), "+12 -4 PR !53 !");
  assert.equal(
    formatStatusText(
      {
        kind: "active",
        provider: "gitlab",
        pr: {
          ...pr,
          threadSummary: { total: 1, unresolved: 1 },
          readiness: {
            verdict: "blocked",
            blockers: ["rebase"],
            warnings: ["1 unresolved thread"],
            recommendations: [],
          },
        },
      },
      { showBlockerHint: true }
    ),
    "+12 -4 PR !53 ! rebase"
  );
  assert.equal(
    formatStatusText(
      { kind: "active", provider: "gitlab", pr },
      { style: "minimal", showCoverage: true }
    ),
    "PR !53 cov97.36% !"
  );
  assert.equal(
    formatStatusText(
      { kind: "active", provider: "gitlab", pr },
      { style: "diff-suffix", showCoverage: true }
    ),
    "PR !53 cov97.36% ! (+12/-4)"
  );
  assert.equal(formatStatusText({ kind: "none", provider: "gitlab" }), "PR —");
  assert.equal(
    formatStatusText({ kind: "auth-error", provider: "gitlab", message: "auth failed" }),
    "PR auth?"
  );
  assert.equal(
    formatStatusText({ kind: "error", provider: "gitlab", message: "request failed" }),
    "PR error!"
  );
  assert.equal(
    formatStatusText({
      kind: "active",
      provider: "github",
      pr: { ...pr, ref: "#53", detailedMergeStatus: "CLEAN" },
    }),
    "+12 -4 PR #53 ✓"
  );
});

function ok(stdout: string) {
  return {
    code: 0,
    stdout,
    stderr: "",
    killed: false,
  };
}
