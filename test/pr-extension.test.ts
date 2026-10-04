import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TSchema } from "typebox";
import { Value } from "typebox/value";
import { COMMAND_NAME } from "../src/constants.js";
import prCompanionExtension from "../src/index.js";

interface CapturedTool {
  name: string;
  promptSnippet?: string;
  parameters: TSchema;
  annotations?: { readOnlyHint?: boolean };
}

interface CapturedExtension {
  commandName?: string;
  eventNames: string[];
  tools: CapturedTool[];
}

function createMockPi(captured: CapturedExtension): ExtensionAPI {
  return {
    on: (eventName: string) => {
      captured.eventNames.push(eventName);
    },
    registerCommand: (name: string) => {
      captured.commandName = name;
    },
    registerTool: (tool: CapturedTool) => {
      captured.tools.push(tool);
    },
  } as unknown as ExtensionAPI;
}

void test("extension registers pr command, tools, and lifecycle refresh hooks", () => {
  const captured: CapturedExtension = { eventNames: [], tools: [] };
  prCompanionExtension(createMockPi(captured));

  assert.equal(captured.commandName, COMMAND_NAME);
  assert.deepEqual(
    captured.tools.map((tool) => tool.name),
    ["get_pr_context", "list_repo_prs", "switch_pr_branch"]
  );
  assert.deepEqual(captured.eventNames, [
    "session_start",
    "session_tree",
    "agent_settled",
    "session_shutdown",
  ]);
  for (const tool of captured.tools) {
    assert.ok(tool.promptSnippet, `${tool.name} should expose a promptSnippet for Pi >=0.59`);
  }
});

void test("tool parameters are TypeBox object schemas that validate their inputs", () => {
  const captured: CapturedExtension = { eventNames: [], tools: [] };
  prCompanionExtension(createMockPi(captured));
  const byName = new Map(captured.tools.map((tool) => [tool.name, tool]));

  const getPrContext = byName.get("get_pr_context");
  const listRepoPrs = byName.get("list_repo_prs");
  const switchPrBranch = byName.get("switch_pr_branch");
  assert.ok(getPrContext && listRepoPrs && switchPrBranch);

  for (const tool of captured.tools) {
    assert.equal(
      (tool.parameters as { type?: unknown }).type,
      "object",
      `${tool.name} needs an object schema`
    );
  }

  assert.equal(Value.Check(getPrContext.parameters, {}), true);
  assert.equal(Value.Check(getPrContext.parameters, { reference: "#42", cwd: "." }), true);
  assert.equal(Value.Check(getPrContext.parameters, { reference: 42 }), false);
  assert.equal(Value.Check(listRepoPrs.parameters, { cwd: "/repo" }), true);
  assert.equal(Value.Check(switchPrBranch.parameters, {}), false);
  assert.equal(Value.Check(switchPrBranch.parameters, { reference: "!12" }), true);

  assert.equal(getPrContext.annotations?.readOnlyHint, true);
  assert.equal(listRepoPrs.annotations?.readOnlyHint, true);
  assert.equal(switchPrBranch.annotations?.readOnlyHint, false);
});

type LifecycleHandler = (event: unknown, ctx: unknown) => unknown;

function createLifecycleHarness() {
  const handlers = new Map<string, LifecycleHandler>();
  const pendingExecs: (() => void)[] = [];
  const statusUpdates: unknown[] = [];

  const pi = {
    on: (eventName: string, handler: LifecycleHandler) => {
      handlers.set(eventName, handler);
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    // Every git call stays pending until the test releases it, then reports "not a repo".
    exec: () =>
      new Promise((resolve) => {
        pendingExecs.push(() => resolve({ code: 128, stdout: "", stderr: "not a git repo" }));
      }),
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: "/workspace/not-a-repo",
    hasUI: true,
    mode: "tui",
    sessionManager: { getBranch: () => [] },
    ui: {
      setStatus: (_key: string, text: string | undefined) => statusUpdates.push(text),
      setWidget: () => undefined,
      theme: { fg: (_color: string, text: string) => text },
    },
  };

  const releaseExecs = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      while (pendingExecs.length > 0) pendingExecs.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  return { pi, ctx, handlers, statusUpdates, releaseExecs };
}

void test("session_start refreshes the footer without blocking startup", async () => {
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  process.env.PI_PR_COMPANION_CONFIG = "/nonexistent/pi-pr-companion-settings.json";
  try {
    const harness = createLifecycleHarness();
    prCompanionExtension(harness.pi);

    const returned = harness.handlers.get("session_start")?.(
      { type: "session_start" },
      harness.ctx
    );
    assert.equal(returned, undefined, "session_start must not wait for gh/glab lookups");

    await harness.releaseExecs();
    assert.deepEqual(harness.statusUpdates, [undefined]);
  } finally {
    restoreEnv("PI_PR_COMPANION_CONFIG", previousConfigPath);
  }
});

void test("refreshes that finish after session_shutdown leave the stale ctx alone", async () => {
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  process.env.PI_PR_COMPANION_CONFIG = "/nonexistent/pi-pr-companion-settings.json";
  try {
    const harness = createLifecycleHarness();
    prCompanionExtension(harness.pi);

    harness.handlers.get("agent_settled")?.({ type: "agent_settled" }, harness.ctx);
    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, harness.ctx);

    await harness.releaseExecs();
    assert.deepEqual(harness.statusUpdates, []);
  } finally {
    restoreEnv("PI_PR_COMPANION_CONFIG", previousConfigPath);
  }
});

void test("an older footer refresh that finishes last does not overwrite a newer one", async () => {
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  process.env.PI_PR_COMPANION_CONFIG = "/nonexistent/pi-pr-companion-settings.json";
  try {
    const handlers = new Map<string, LifecycleHandler>();
    const statusUpdates: (string | undefined)[] = [];
    const heldGhCalls: (() => void)[] = [];
    let branch = "feature/a";
    let holdGh = true;
    const prFor = (number: number, headRefName: string) => ({
      number,
      title: `feat: ${headRefName}`,
      url: `https://github.com/octo/repo/pull/${number}`,
      headRefName,
      baseRefName: "main",
      updatedAt: "2026-03-20T10:00:00Z",
      isDraft: false,
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
    });
    const ghResponse = (joined: string) => {
      if (joined.includes("--head feature/a")) return ok(JSON.stringify([prFor(1, "feature/a")]));
      if (joined.includes("--head feature/b")) return ok(JSON.stringify([prFor(2, "feature/b")]));
      if (joined.includes("pr view 1")) return ok(JSON.stringify(prFor(1, "feature/a")));
      if (joined.includes("pr view 2")) return ok(JSON.stringify(prFor(2, "feature/b")));
      if (joined.includes("api graphql")) {
        return ok(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { nodes: [] },
                  latestOpinionatedReviews: { nodes: [] },
                },
              },
            },
          })
        );
      }
      throw new Error(`Unexpected invocation: gh ${joined}`);
    };

    const pi = {
      on: (eventName: string, handler: LifecycleHandler) => {
        handlers.set(eventName, handler);
      },
      registerCommand: () => undefined,
      registerTool: () => undefined,
      exec: (command: string, args: string[]) => {
        const joined = args.join(" ");
        if (command === "git") {
          if (joined.includes("rev-parse --show-toplevel")) {
            return Promise.resolve(ok("/workspace/footer-order\n"));
          }
          if (joined.includes("branch --show-current")) {
            return Promise.resolve(ok(`${branch}\n`));
          }
          if (joined.includes("remote get-url origin")) {
            return Promise.resolve(ok("https://github.com/octo/repo.git\n"));
          }
          return Promise.resolve({ code: 1, stdout: "", stderr: "", killed: false });
        }
        if (holdGh) {
          return new Promise((resolve) => heldGhCalls.push(() => resolve(ghResponse(joined))));
        }
        return Promise.resolve(ghResponse(joined));
      },
    } as unknown as ExtensionAPI;

    const ctx = {
      cwd: "/workspace/footer-order",
      hasUI: true,
      mode: "tui",
      sessionManager: { getBranch: () => [] },
      ui: {
        setStatus: (_key: string, text: string | undefined) => statusUpdates.push(text),
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    };
    const settle = async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    prCompanionExtension(pi);
    // The startup refresh reads branch A, then waits on gh.
    handlers.get("session_start")?.({ type: "session_start" }, ctx);
    await settle();
    assert.ok(heldGhCalls.length > 0, "the startup refresh is waiting on gh");

    // The branch moves to B and a later refresh finishes first.
    branch = "feature/b";
    holdGh = false;
    handlers.get("session_tree")?.({ type: "session_tree" }, ctx);
    await settle();
    assert.match(statusUpdates.at(-1) ?? "", /PR #2/);

    // The older refresh for branch A finishes last and must be dropped.
    while (heldGhCalls.length > 0) {
      heldGhCalls.shift()?.();
      await settle();
    }
    assert.ok(
      statusUpdates.every((text) => !/PR #1/.test(text ?? "")),
      `stale footer written: ${JSON.stringify(statusUpdates)}`
    );
    assert.match(statusUpdates.at(-1) ?? "", /PR #2/);
  } finally {
    restoreEnv("PI_PR_COMPANION_CONFIG", previousConfigPath);
  }
});

function ok(stdout: string) {
  return { code: 0, stdout, stderr: "", killed: false };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

void test("headless output stays off stdout in json mode", async () => {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  prCompanionExtension({
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    },
  } as unknown as ExtensionAPI);
  assert.ok(handler);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message: string) => stdout.push(message);
  console.error = (message: string) => stderr.push(message);
  try {
    await handler("", { cwd: "/tmp", hasUI: false, mode: "json", ui: {} });
    await handler("", { cwd: "/tmp", hasUI: false, mode: "print", ui: {} });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(stderr.length, 1, "json mode writes help to stderr");
  assert.equal(stdout.length, 1, "print mode writes help to stdout");
  assert.match(stderr[0] ?? "", /\/pr status/);
});
