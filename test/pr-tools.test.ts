import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import prCompanionExtension from "../src/index.js";

interface RegisteredTool {
  name: string;
  executionMode?: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string }
  ) => Promise<{
    content: { type: string; text: string }[];
    details: unknown;
    isError?: boolean;
  }>;
}

interface PrContextToolPayload {
  provider?: string;
  result?: {
    pr?: {
      ref?: string;
    };
  };
  sharedReviewInstructions?: string;
  projectReviewGuidelines?: string;
}

interface ListRepoPrsToolPayload {
  prs?: {
    ref?: string;
  }[];
}

void test("get_pr_context and list_repo_prs expose provider-backed PR data", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-pr-companion-tools-"));
  const repoRoot = path.join(tempDir, "repo");
  const piDir = path.join(repoRoot, ".pi");
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  const configPath = path.join(tempDir, "config.json");

  try {
    await mkdir(piDir, { recursive: true });
    await writeFile(path.join(repoRoot, "REVIEW_GUIDELINES.md"), "Always review migrations.");
    await writeFile(
      configPath,
      JSON.stringify({
        sharedReviewInstructions: "Focus on missing tests.",
        providers: [{ kind: "github", ignoredBranches: ["main"], showNoPrState: false, hosts: {} }],
      })
    );
    process.env.PI_PR_COMPANION_CONFIG = configPath;

    const tools = new Map<string, RegisteredTool>();
    const pi = {
      on: () => undefined,
      registerCommand: () => undefined,
      registerTool: (tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      },
      exec: (command: string, args: string[]) => {
        const joined = args.join(" ");

        if (command === "git") {
          if (joined.includes("rev-parse --show-toplevel")) return ok(`${repoRoot}\n`);
          if (joined.includes("branch --show-current")) return ok("feature/tools\n");
          if (joined.includes("config --get branch.feature/tools.remote")) return fail("");
          if (joined.includes("remote get-url origin")) {
            return ok("https://github.com/octo/repo.git\n");
          }
          if (joined.includes("diff --shortstat origin/main...HEAD")) {
            return ok(" 1 file changed, 3 insertions(+), 1 deletion(-)\n");
          }
        }

        if (command === "gh") {
          if (joined.includes("pr list") && joined.includes("--head feature/tools")) {
            return ok(
              JSON.stringify([
                {
                  number: 42,
                  title: "feat: add tool support",
                  url: "https://github.com/octo/repo/pull/42",
                  headRefName: "feature/tools",
                  baseRefName: "main",
                  updatedAt: "2026-03-20T10:00:00Z",
                  isDraft: false,
                  mergeStateStatus: "CLEAN",
                  reviewDecision: "APPROVED",
                  statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                },
              ])
            );
          }

          if (joined.includes("pr view 42")) {
            return ok(
              JSON.stringify({
                number: 42,
                title: "feat: add tool support",
                url: "https://github.com/octo/repo/pull/42",
                headRefName: "feature/tools",
                baseRefName: "main",
                updatedAt: "2026-03-20T10:00:00Z",
                isDraft: false,
                mergeStateStatus: "CLEAN",
                reviewDecision: "APPROVED",
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
              })
            );
          }

          if (joined.includes("api graphql")) {
            return ok(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: { nodes: [] },
                      latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] },
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
                  title: "feat: add tool support",
                  url: "https://github.com/octo/repo/pull/42",
                  headRefName: "feature/tools",
                  baseRefName: "main",
                  updatedAt: "2026-03-20T10:00:00Z",
                  isDraft: false,
                  mergeStateStatus: "CLEAN",
                  reviewDecision: "APPROVED",
                  statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                },
              ])
            );
          }
        }

        throw new Error(`Unexpected invocation: ${command} ${joined}`);
      },
    } as unknown as ExtensionAPI;

    prCompanionExtension(pi);

    const getPrContext = tools.get("get_pr_context");
    const listRepoPrs = tools.get("list_repo_prs");
    assert.ok(getPrContext);
    assert.ok(listRepoPrs);
    if (!getPrContext || !listRepoPrs) {
      return;
    }

    const prContextResult = await getPrContext.execute("tool-1", {}, undefined, undefined, {
      cwd: repoRoot,
    });
    const prContext = parseJsonText<PrContextToolPayload>(prContextResult.content[0]?.text);
    assert.equal(prContext.provider, "github");
    assert.equal(prContext.result?.pr?.ref, "#42");
    assert.equal(prContext.sharedReviewInstructions, "Focus on missing tests.");
    assert.equal(prContext.projectReviewGuidelines, "Always review migrations.");

    const listResult = await listRepoPrs.execute("tool-2", {}, undefined, undefined, {
      cwd: repoRoot,
    });
    const listed = parseJsonText<ListRepoPrsToolPayload>(listResult.content[0]?.text);
    assert.equal(listed.prs?.length, 1);
    assert.equal(listed.prs?.[0]?.ref, "#42");
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PI_PR_COMPANION_CONFIG;
    } else {
      process.env.PI_PR_COMPANION_CONFIG = previousConfigPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

void test("get_pr_context resolves a relative cwd against the tool context cwd", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-pr-companion-tools-relative-"));
  const repoRoot = path.join(tempDir, "repo");
  const piDir = path.join(repoRoot, ".pi");
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  const configPath = path.join(tempDir, "config.json");

  try {
    await mkdir(piDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        providers: [{ kind: "github", ignoredBranches: ["main"], showNoPrState: false, hosts: {} }],
      })
    );
    process.env.PI_PR_COMPANION_CONFIG = configPath;

    const tools = new Map<string, RegisteredTool>();
    const pi = {
      on: () => undefined,
      registerCommand: () => undefined,
      registerTool: (tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      },
      exec: (command: string, args: string[]) => {
        const joined = args.join(" ");

        if (command === "git") {
          if (joined.includes("rev-parse --show-toplevel")) return ok(`${repoRoot}\n`);
          if (joined.includes("branch --show-current")) return ok("feature/tools\n");
          if (joined.includes("config --get branch.feature/tools.remote")) return fail("");
          if (joined.includes("remote get-url origin")) {
            return ok("https://github.com/octo/repo.git\n");
          }
          if (joined.includes("diff --shortstat origin/main...HEAD")) {
            return ok(" 1 file changed, 3 insertions(+), 1 deletion(-)\n");
          }
        }

        if (command === "gh") {
          if (joined.includes("pr list") && joined.includes("--head feature/tools")) {
            return ok(
              JSON.stringify([
                {
                  number: 42,
                  title: "feat: add tool support",
                  url: "https://github.com/octo/repo/pull/42",
                  headRefName: "feature/tools",
                  baseRefName: "main",
                  updatedAt: "2026-03-20T10:00:00Z",
                  isDraft: false,
                  mergeStateStatus: "CLEAN",
                  reviewDecision: "APPROVED",
                  statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
                },
              ])
            );
          }

          if (joined.includes("pr view 42")) {
            return ok(
              JSON.stringify({
                number: 42,
                title: "feat: add tool support",
                url: "https://github.com/octo/repo/pull/42",
                headRefName: "feature/tools",
                baseRefName: "main",
                updatedAt: "2026-03-20T10:00:00Z",
                isDraft: false,
                mergeStateStatus: "CLEAN",
                reviewDecision: "APPROVED",
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
              })
            );
          }

          if (joined.includes("api graphql")) {
            return ok(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: { nodes: [] },
                      latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] },
                    },
                  },
                },
              })
            );
          }
        }

        throw new Error(`Unexpected invocation: ${command} ${joined}`);
      },
    } as unknown as ExtensionAPI;

    prCompanionExtension(pi);
    const getPrContext = tools.get("get_pr_context");
    assert.ok(getPrContext);
    if (!getPrContext) {
      return;
    }

    const result = await getPrContext.execute(
      "tool-relative",
      { cwd: "repo" },
      undefined,
      undefined,
      { cwd: tempDir }
    );
    const payload = parseJsonText<PrContextToolPayload>(result.content[0]?.text);
    assert.equal(payload.provider, "github");
    assert.equal(payload.result?.pr?.ref, "#42");
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PI_PR_COMPANION_CONFIG;
    } else {
      process.env.PI_PR_COMPANION_CONFIG = previousConfigPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

void test("get_pr_context does not leak local review guidelines into an external PR review", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-pr-companion-tools-external-"));
  const repoRoot = path.join(tempDir, "repo");
  const piDir = path.join(repoRoot, ".pi");
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  const configPath = path.join(tempDir, "config.json");

  try {
    await mkdir(piDir, { recursive: true });
    await writeFile(path.join(repoRoot, "REVIEW_GUIDELINES.md"), "Only for the local repo.");
    await writeFile(
      configPath,
      JSON.stringify({
        providers: [{ kind: "github", ignoredBranches: ["main"], showNoPrState: false, hosts: {} }],
      })
    );
    process.env.PI_PR_COMPANION_CONFIG = configPath;

    const tools = new Map<string, RegisteredTool>();
    const pi = {
      on: () => undefined,
      registerCommand: () => undefined,
      registerTool: (tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      },
      exec: (command: string, args: string[]) => {
        const joined = args.join(" ");

        if (command === "git") {
          if (joined.includes("rev-parse --show-toplevel")) return ok(`${repoRoot}\n`);
          if (joined.includes("branch --show-current")) return ok("feature/tools\n");
          if (joined.includes("config --get branch.feature/tools.remote")) return fail("");
          if (joined.includes("remote get-url origin")) {
            return ok("https://github.com/octo/repo.git\n");
          }
        }

        if (command === "gh") {
          if (joined.includes("pr view 7") && joined.includes("github.com/octo/other")) {
            return ok(
              JSON.stringify({
                number: 7,
                title: "feat: external review",
                url: "https://github.com/octo/other/pull/7",
                headRefName: "feature/external",
                baseRefName: "main",
                updatedAt: "2026-03-20T10:00:00Z",
                isDraft: false,
                mergeStateStatus: "CLEAN",
                reviewDecision: "APPROVED",
                statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
              })
            );
          }

          if (joined.includes("api graphql") && joined.includes("number=7")) {
            return ok(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: { nodes: [] },
                      latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] },
                    },
                  },
                },
              })
            );
          }
        }

        throw new Error(`Unexpected invocation: ${command} ${joined}`);
      },
    } as unknown as ExtensionAPI;

    prCompanionExtension(pi);
    const getPrContext = tools.get("get_pr_context");
    assert.ok(getPrContext);
    if (!getPrContext) {
      return;
    }

    const result = await getPrContext.execute(
      "tool-external",
      { reference: "https://github.com/octo/other/pull/7" },
      undefined,
      undefined,
      { cwd: repoRoot }
    );
    const payload = parseJsonText<PrContextToolPayload & { projectReviewGuidelines?: string }>(
      result.content[0]?.text
    );
    assert.equal(payload.result?.pr?.ref, "#7");
    assert.equal(payload.projectReviewGuidelines, undefined);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PI_PR_COMPANION_CONFIG;
    } else {
      process.env.PI_PR_COMPANION_CONFIG = previousConfigPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

void test("switch_pr_branch uses the shared switch path and blocks on dirty worktrees", async () => {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    exec: (command: string, args: string[]) => {
      const joined = args.join(" ");

      if (command === "git") {
        if (joined.includes("rev-parse --show-toplevel")) return ok("/workspace/repo\n");
        if (joined.includes("branch --show-current")) return ok("feature/tools\n");
        if (joined.includes("config --get branch.feature/tools.remote")) return fail("");
        if (joined.includes("remote get-url origin"))
          return ok("https://github.com/octo/repo.git\n");
        if (joined === "-C /workspace/repo diff --shortstat origin/main...HEAD") {
          return ok(" 1 file changed, 1 insertion(+)\n");
        }
        if (joined === "-C /workspace/repo status --porcelain") return ok(" M src/index.ts\n");
      }

      if (command === "gh") {
        if (joined.includes("pr view 42")) {
          return ok(
            JSON.stringify({
              number: 42,
              title: "feat: add tool support",
              url: "https://github.com/octo/repo/pull/42",
              headRefName: "feature/tools",
              baseRefName: "main",
              updatedAt: "2026-03-20T10:00:00Z",
              isDraft: false,
              mergeStateStatus: "CLEAN",
              reviewDecision: "APPROVED",
              statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
            })
          );
        }
        if (joined.includes("api graphql")) {
          return ok(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: { nodes: [] },
                    latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] },
                  },
                },
              },
            })
          );
        }
      }

      throw new Error(`Unexpected invocation: ${command} ${joined}`);
    },
  } as unknown as ExtensionAPI;

  prCompanionExtension(pi);
  const switchPrBranch = tools.get("switch_pr_branch");
  assert.ok(switchPrBranch);
  if (!switchPrBranch) {
    return;
  }

  const result = await switchPrBranch.execute(
    "tool-3",
    { reference: "#42", cwd: "/workspace/repo" },
    undefined,
    undefined,
    { cwd: "/workspace/repo" }
  );
  assert.match(result.content[0]?.text ?? "", /Dirty worktree/i);
  assert.equal(result.isError, true, "failed switches must be reported as tool errors");
});

void test("switch_pr_branch runs its tool batch sequentially; read-only tools stay parallel", () => {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;

  prCompanionExtension(pi);
  // pi runs a whole batch sequentially when any tool in it asks for it, so
  // read/edit/bash calls never run while the checkout rewrites the worktree.
  assert.equal(tools.get("switch_pr_branch")?.executionMode, "sequential");
  assert.equal(tools.get("get_pr_context")?.executionMode, undefined);
  assert.equal(tools.get("list_repo_prs")?.executionMode, undefined);
});

void test("get_pr_context forwards its abort signal and stops once cancelled", async () => {
  const tools = new Map<string, RegisteredTool>();
  const controller = new AbortController();
  const calls: { command: string; signal?: AbortSignal }[] = [];
  const pi = {
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    exec: (command: string, _args: string[], options?: { signal?: AbortSignal }) => {
      calls.push(options?.signal ? { command, signal: options.signal } : { command });
      // The user cancels while the first git call runs; pi kills the process.
      controller.abort();
      return Promise.resolve({ code: 1, stdout: "", stderr: "", killed: true });
    },
  } as unknown as ExtensionAPI;

  prCompanionExtension(pi);
  const getPrContext = tools.get("get_pr_context");
  assert.ok(getPrContext);
  if (!getPrContext) {
    return;
  }

  await assert.rejects(
    getPrContext.execute("tool-4", {}, controller.signal, undefined, { cwd: "/workspace/repo" }),
    { name: "AbortError" }
  );
  assert.equal(calls.length, 1, "no further git/gh calls run after the abort");
  assert.equal(calls[0]?.signal, controller.signal);
});

void test("list_repo_prs truncates a long PR list and saves the full JSON", async () => {
  const tools = new Map<string, RegisteredTool>();
  const prs = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    title: `feat: change number ${index + 1}`,
    url: `https://github.com/octo/repo/pull/${index + 1}`,
    headRefName: `feature/${index + 1}`,
    baseRefName: "main",
    updatedAt: "2026-03-20T10:00:00Z",
    isDraft: false,
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: [{ conclusion: "FAILURE", name: "ci" }],
  }));
  const pi = {
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    exec: (command: string, args: string[]) => {
      const joined = args.join(" ");
      if (command === "git") {
        if (joined.includes("rev-parse --show-toplevel")) return ok("/workspace/repo\n");
        if (joined.includes("branch --show-current")) return ok("main\n");
        if (joined.includes("config --get branch.main.remote")) return fail("");
        if (joined.includes("remote get-url origin")) return ok("git@github.com:octo/repo.git\n");
      }
      if (command === "gh" && joined.includes("pr list")) return ok(JSON.stringify(prs));
      throw new Error(`Unexpected invocation: ${command} ${joined}`);
    },
  } as unknown as ExtensionAPI;

  prCompanionExtension(pi);
  const listRepoPrs = tools.get("list_repo_prs");
  assert.ok(listRepoPrs);
  if (!listRepoPrs) {
    return;
  }

  const result = await listRepoPrs.execute("tool-5", {}, undefined, undefined, {
    cwd: "/workspace/repo",
  });
  const text = result.content[0]?.text ?? "";
  assert.ok(text.split("\n").length <= 2002, "model-facing output stays within pi's line limit");
  const fullPath = text.match(/Full JSON: (.+\.json)\]$/)?.[1];
  assert.ok(fullPath, "truncated output names the file with the full JSON");
  if (!fullPath) {
    return;
  }

  try {
    const full = JSON.parse(await readFile(fullPath, "utf8")) as ListRepoPrsToolPayload;
    assert.equal(full.prs?.length, 100);
    assert.equal((result.details as ListRepoPrsToolPayload).prs?.length, 100);
  } finally {
    await rm(path.dirname(fullPath), { recursive: true, force: true });
  }
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

function parseJsonText<T>(text: string | undefined): T {
  return JSON.parse(text ?? "{}") as T;
}
