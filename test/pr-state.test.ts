import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getRepoStatusSnapshot, listActivePrsForCurrentRepo } from "../src/pr-state.js";

void test("listActivePrsForCurrentRepo works even when current branch is ignored", async () => {
  await withConfig(
    {
      providers: [
        {
          kind: "gitlab",
          ignoredBranches: ["main", "master"],
          showNoPrState: false,
          hosts: {},
        },
      ],
    },
    async () => {
      const pi = {
        exec: (command: string, args: string[]) => {
          if (command !== "git" && command !== "glab") {
            throw new Error(`Unexpected command: ${command}`);
          }

          if (command === "git") {
            const joined = args.join(" ");
            if (joined.includes("config --get branch.")) {
              return fail();
            }
            if (joined.includes("rev-parse --show-toplevel")) {
              return ok("/workspace/orange/customer-profile-service\n");
            }
            if (joined.includes("branch --show-current")) {
              return ok("main\n");
            }
            if (joined.includes("remote get-url origin")) {
              return ok("https://gitlab.example.com/group/customer-profile-service.git\n");
            }
          }

          if (command === "glab") {
            return ok(
              JSON.stringify([
                {
                  iid: 12,
                  title: "feat: add profile validation",
                  web_url:
                    "https://gitlab.example.com/group/customer-profile-service/-/merge_requests/12",
                  source_branch: "feat/profile-validation",
                  target_branch: "main",
                  updated_at: "2026-03-16T10:00:00Z",
                },
              ])
            );
          }

          throw new Error(`Unexpected invocation: ${command} ${args.join(" ")}`);
        },
      } as unknown as ExtensionAPI;

      const result = await listActivePrsForCurrentRepo(
        pi,
        "/workspace/orange/customer-profile-service"
      );
      assert.equal(result.snapshot.reason, "visible");
      assert.equal(result.prs?.length, 1);
      assert.equal(result.prs?.[0]?.sourceBranch, "feat/profile-validation");
    }
  );
});

void test("GitHub repos use gh without any repo root config", async () => {
  await withConfig(
    {
      providers: [
        {
          kind: "gitlab",
          ignoredBranches: ["main", "master"],
          showNoPrState: false,
          hosts: {},
        },
        {
          kind: "github",
          ignoredBranches: ["main", "master"],
          showNoPrState: false,
          hosts: {},
        },
      ],
    },
    async () => {
      const pi = {
        exec: (command: string, args: string[]) => {
          if (command === "glab") {
            throw new Error("glab should not be called for GitHub repos");
          }

          if (command === "git") {
            const joined = args.join(" ");
            if (joined.includes("config --get branch.")) {
              return fail();
            }
            if (joined.includes("rev-parse --show-toplevel")) {
              return ok("/workspace/repo\n");
            }
            if (joined.includes("branch --show-current")) {
              return ok("feature/test\n");
            }
            if (joined.includes("remote get-url origin")) {
              return ok("https://github.com/octo/repo.git\n");
            }
            if (joined.includes("diff --shortstat")) {
              return ok(" 1 file changed, 4 insertions(+), 2 deletions(-)\n");
            }
          }

          if (command === "gh") {
            const joined = args.join(" ");
            if (joined.includes("config --get branch.")) {
              return fail();
            }
            if (joined.includes("pr list") && joined.includes("--head feature/test")) {
              return ok(
                JSON.stringify([
                  {
                    number: 42,
                    title: "feat: add github support",
                    url: "https://github.com/octo/repo/pull/42",
                    headRefName: "feature/test",
                    baseRefName: "main",
                    updatedAt: "2026-03-16T10:00:00Z",
                    isDraft: false,
                    mergeStateStatus: "CLEAN",
                    statusCheckRollup: [{ conclusion: "SUCCESS" }],
                  },
                ])
              );
            }
            if (joined.includes("pr view 42")) {
              return ok(
                JSON.stringify({
                  number: 42,
                  title: "feat: add github support",
                  url: "https://github.com/octo/repo/pull/42",
                  headRefName: "feature/test",
                  baseRefName: "main",
                  updatedAt: "2026-03-16T10:00:00Z",
                  isDraft: false,
                  mergeStateStatus: "CLEAN",
                  reviewDecision: "APPROVED",
                  statusCheckRollup: {
                    contexts: {
                      nodes: [{ conclusion: "SUCCESS", name: "ci" }],
                    },
                  },
                })
              );
            }
            if (joined.includes("api repos/octo/repo/pulls/42/files")) {
              return ok(JSON.stringify([{ additions: 4, deletions: 2 }]));
            }
            if (joined.includes("api graphql")) {
              return ok(
                JSON.stringify({
                  data: {
                    repository: {
                      pullRequest: {
                        reviewThreads: { nodes: [] },
                        reviews: { nodes: [{ state: "APPROVED" }] },
                      },
                    },
                  },
                })
              );
            }
            if (joined.includes("pr list") && joined.includes("--state open")) {
              return ok(
                JSON.stringify([
                  {
                    number: 42,
                    title: "feat: add github support",
                    url: "https://github.com/octo/repo/pull/42",
                    headRefName: "feature/test",
                    baseRefName: "main",
                    updatedAt: "2026-03-16T10:00:00Z",
                    isDraft: false,
                    mergeStateStatus: "CLEAN",
                    statusCheckRollup: [{ conclusion: "SUCCESS" }],
                  },
                ])
              );
            }
          }

          throw new Error(`Unexpected invocation: ${command} ${args.join(" ")}`);
        },
      } as unknown as ExtensionAPI;

      const snapshot = await getRepoStatusSnapshot(pi, "/workspace/repo", { force: true });
      assert.equal(snapshot.reason, "visible");
      assert.equal(snapshot.result?.kind, "active");
      assert.equal(snapshot.result?.provider, "github");
      assert.equal(snapshot.result?.pr.ref, "#42");
      assert.deepEqual(snapshot.result?.pr.diffStats, { additions: 4, deletions: 2 });

      const listed = await listActivePrsForCurrentRepo(pi, "/workspace/repo");
      assert.equal(listed.snapshot.reason, "visible");
      assert.equal(listed.prs?.[0]?.ref, "#42");
    }
  );
});

void test("custom hosts can select a provider without repo root config", async () => {
  await withConfig(
    {
      providers: [
        {
          kind: "gitlab",
          ignoredBranches: ["main", "master"],
          showNoPrState: false,
          hosts: {},
        },
        {
          kind: "github",
          ignoredBranches: ["main", "master"],
          showNoPrState: false,
          hosts: { "code.example.com": { enabled: true } },
        },
      ],
    },
    async () => {
      const pi = {
        exec: (command: string, args: string[]) => {
          if (command === "glab") {
            throw new Error("glab should not be called for custom GitHub hosts");
          }

          if (command === "git") {
            const joined = args.join(" ");
            if (joined.includes("config --get branch.")) {
              return fail();
            }
            if (joined.includes("rev-parse --show-toplevel")) {
              return ok("/workspace/repo\n");
            }
            if (joined.includes("branch --show-current")) {
              return ok("feature/test\n");
            }
            if (joined.includes("remote get-url origin")) {
              return ok("git@code.example.com:octo/repo.git\n");
            }
            if (joined.includes("diff --shortstat")) {
              return ok("");
            }
          }

          if (command === "gh") {
            const joined = args.join(" ");
            if (joined.includes("config --get branch.")) {
              return fail();
            }
            if (joined.includes("pr list") && joined.includes("--head feature/test")) {
              return ok(
                JSON.stringify([
                  {
                    number: 7,
                    title: "feat: custom host detection",
                    url: "https://code.example.com/octo/repo/pull/7",
                    headRefName: "feature/test",
                    baseRefName: "main",
                    updatedAt: "2026-03-16T10:00:00Z",
                    isDraft: false,
                    mergeStateStatus: "CLEAN",
                    statusCheckRollup: [{ conclusion: "SUCCESS" }],
                  },
                ])
              );
            }
            if (joined.includes("pr view 7")) {
              return ok(
                JSON.stringify({
                  number: 7,
                  title: "feat: custom host detection",
                  url: "https://code.example.com/octo/repo/pull/7",
                  headRefName: "feature/test",
                  baseRefName: "main",
                  updatedAt: "2026-03-16T10:00:00Z",
                  isDraft: false,
                  mergeStateStatus: "CLEAN",
                  reviewDecision: "APPROVED",
                  statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                })
              );
            }
            if (joined.includes("api repos/octo/repo/pulls/7/files")) {
              return ok(JSON.stringify([{ additions: 0, deletions: 0 }]));
            }
            if (joined.includes("api graphql")) {
              return ok(
                JSON.stringify({
                  data: {
                    repository: {
                      pullRequest: {
                        reviewThreads: { nodes: [] },
                        reviews: { nodes: [{ state: "APPROVED" }] },
                      },
                    },
                  },
                })
              );
            }
          }

          throw new Error(`Unexpected invocation: ${command} ${args.join(" ")}`);
        },
      } as unknown as ExtensionAPI;

      const snapshot = await getRepoStatusSnapshot(pi, "/workspace/repo", { force: true });
      assert.equal(snapshot.reason, "visible");
      assert.equal(snapshot.result?.provider, "github");
      assert.equal(snapshot.provider?.kind, "github");
    }
  );
});

void test("unsupported remotes stay hidden", async () => {
  await withConfig({}, async () => {
    const pi = {
      exec: (command: string, args: string[]) => {
        if (command === "gh" || command === "glab") {
          throw new Error("provider CLI should not be called for unsupported remotes");
        }

        if (command === "git") {
          const joined = args.join(" ");
          if (joined.includes("config --get branch.")) {
            return fail();
          }
          if (joined.includes("rev-parse --show-toplevel")) {
            return ok("/workspace/repo\n");
          }
          if (joined.includes("branch --show-current")) {
            return ok("feature/test\n");
          }
          if (joined.includes("remote get-url origin")) {
            return ok("https://code.example.com/octo/repo.git\n");
          }
        }

        throw new Error(`Unexpected invocation: ${command} ${args.join(" ")}`);
      },
    } as unknown as ExtensionAPI;

    const snapshot = await getRepoStatusSnapshot(pi, "/workspace/repo", { force: true });
    assert.equal(snapshot.reason, "unsupported-remote");
    assert.equal(snapshot.hidden, true);
  });
});

void test("missing gh is reported as unsupported", async () => {
  await withConfig(
    {
      providers: [
        {
          kind: "gitlab",
          ignoredBranches: ["main", "master"],
          showNoPrState: false,
          hosts: {},
        },
        {
          kind: "github",
          ignoredBranches: ["main", "master"],
          showNoPrState: false,
          hosts: {},
        },
      ],
    },
    async () => {
      const pi = {
        exec: (command: string, args: string[]) => {
          if (command === "git") {
            const joined = args.join(" ");
            if (joined.includes("config --get branch.")) {
              return fail();
            }
            if (joined.includes("rev-parse --show-toplevel")) {
              return ok("/workspace/repo\n");
            }
            if (joined.includes("branch --show-current")) {
              return ok("feature/test\n");
            }
            if (joined.includes("remote get-url origin")) {
              return ok("https://github.com/octo/repo.git\n");
            }
            if (joined.includes("diff --shortstat")) {
              return ok("");
            }
          }

          if (command === "gh") {
            return {
              code: 1,
              stdout: "",
              stderr: "",
              killed: false,
            };
          }

          throw new Error(`Unexpected invocation: ${command} ${args.join(" ")}`);
        },
      } as unknown as ExtensionAPI;

      const snapshot = await getRepoStatusSnapshot(pi, "/workspace/repo", { force: true });
      assert.equal(snapshot.reason, "unsupported");
      assert.equal(snapshot.result?.kind, "unsupported");
      assert.match(snapshot.result?.message ?? "", /gh.*unavailable/i);
    }
  );
});

void test("missing glab is reported as unsupported", async () => {
  await withConfig(
    {
      providers: [
        {
          kind: "gitlab",
          ignoredBranches: ["main", "master"],
          showNoPrState: false,
          hosts: {},
        },
      ],
    },
    async () => {
      const pi = {
        exec: (command: string, args: string[]) => {
          if (command === "git") {
            const joined = args.join(" ");
            if (joined.includes("config --get branch.")) {
              return fail();
            }
            if (joined.includes("rev-parse --show-toplevel")) {
              return ok("/workspace/repo\n");
            }
            if (joined.includes("branch --show-current")) {
              return ok("feature/test\n");
            }
            if (joined.includes("remote get-url origin")) {
              return ok("https://gitlab.example.com/group/repo.git\n");
            }
            if (joined.includes("diff --shortstat")) {
              return ok("");
            }
          }

          if (command === "glab") {
            return {
              code: 1,
              stdout: "",
              stderr: "",
              killed: false,
            };
          }

          throw new Error(`Unexpected invocation: ${command} ${args.join(" ")}`);
        },
      } as unknown as ExtensionAPI;

      const snapshot = await getRepoStatusSnapshot(pi, "/workspace/repo", { force: true });
      assert.equal(snapshot.reason, "unsupported");
      assert.equal(snapshot.result?.kind, "unsupported");
      assert.match(snapshot.result?.message ?? "", /glab.*unavailable/i);
    }
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

function fail(stderr = "") {
  return {
    code: 1,
    stdout: "",
    stderr,
    killed: false,
  };
}

async function withConfig(config: unknown, run: () => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-pr-companion-"));
  const configPath = path.join(tempDir, "config.json");
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;

  await writeFile(configPath, JSON.stringify(config));
  process.env.PI_PR_COMPANION_CONFIG = configPath;

  try {
    await run();
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PI_PR_COMPANION_CONFIG;
    } else {
      process.env.PI_PR_COMPANION_CONFIG = previousConfigPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}
