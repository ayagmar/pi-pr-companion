import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import prCompanionExtension from "../src/index.js";

interface RegisteredCommand {
  handler: (args: string, ctx: ReviewCommandContext) => Promise<void>;
}

interface ReviewCommandContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    select: (title: string, items: string[]) => Promise<string | undefined>;
    setWidget: (_key: string, _value: unknown) => void;
  };
  sessionManager: {
    getBranch: () => SessionEntry[];
    getEntries: () => SessionEntry[];
    getLeafId: () => string | undefined;
  };
  navigateTree: (
    targetId: string,
    options: {
      summarize: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
    }
  ) => Promise<{ cancelled: boolean }>;
}

interface SessionEntry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
}

void test("review session stores an origin and end-review returns with a summary", async () => {
  const entries: SessionEntry[] = [{ id: "leaf-1", type: "message" }];
  const sentMessages: { message: string; options?: unknown }[] = [];
  const navigations: {
    targetId: string;
    options: {
      summarize: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
    };
  }[] = [];
  const notifications: { message: string; level?: "info" | "warning" | "error" }[] = [];
  let leafId = "leaf-1";
  let command: RegisteredCommand | undefined;
  let entryCounter = 1;
  let nextSelectChoice: string | undefined;

  const pi = {
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (_name: string, registered: RegisteredCommand) => {
      command = registered;
    },
    appendEntry: (customType: string, data: unknown) => {
      entryCounter += 1;
      leafId = `entry-${entryCounter}`;
      entries.push({ id: leafId, type: "custom", customType, data });
    },
    sendUserMessage: (message: string, options?: unknown) => {
      sentMessages.push({ message, options });
    },
    exec: (tool: string, args: string[]) => {
      const joined = args.join(" ");

      if (tool === "git") {
        if (joined.includes("rev-parse --show-toplevel")) return ok("/workspace/repo\n");
        if (joined.includes("branch --show-current")) return ok("feature/review\n");
        if (joined.includes("config --get branch.feature/review.remote")) return fail("");
        if (joined.includes("remote get-url origin"))
          return ok("https://github.com/octo/repo.git\n");
        if (joined.includes("diff --shortstat origin/main...HEAD")) {
          return ok(" 1 file changed, 2 insertions(+), 1 deletion(-)\n");
        }
      }

      if (tool === "gh") {
        if (joined.includes("pr view 42")) {
          return ok(
            JSON.stringify({
              number: 42,
              title: "feat: review session",
              url: "https://github.com/octo/repo/pull/42",
              headRefName: "feature/review",
              baseRefName: "main",
              updatedAt: "2026-03-20T10:00:00Z",
              isDraft: false,
              mergeStateStatus: "CLEAN",
              reviewDecision: "APPROVED",
              statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
            })
          );
        }

        if (joined.includes("api repos/octo/repo/pulls/42/files")) {
          return ok(JSON.stringify([{ additions: 2, deletions: 1 }]));
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

      throw new Error(`Unexpected invocation: ${tool} ${joined}`);
    },
  } as unknown as ExtensionAPI;

  prCompanionExtension(pi);
  assert.ok(command);
  if (!command) {
    return;
  }

  const ctx: ReviewCommandContext = {
    cwd: "/workspace/repo",
    hasUI: true,
    ui: {
      notify: (message, level) => {
        notifications.push(level ? { message, level } : { message });
      },
      select: () => Promise.resolve(nextSelectChoice),
      setWidget: () => undefined,
    },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => leafId,
    },
    navigateTree: (targetId, options) => {
      navigations.push({ targetId, options });
      return Promise.resolve({ cancelled: false });
    },
  };

  await command.handler("review session #42", ctx);

  assert.equal(sentMessages[0]?.message, "/review-pr https://github.com/octo/repo/pull/42");
  const activeState = entries[entries.length - 1]?.data as { active?: boolean; originId?: string };
  assert.equal(activeState.active, true);
  assert.equal(activeState.originId, "leaf-1");

  nextSelectChoice = "Return with review summary";
  await command.handler("end-review", ctx);

  assert.deepEqual(navigations, [
    {
      targetId: "leaf-1",
      options: {
        summarize: true,
        customInstructions:
          "Summarize the completed review session for #42.\nKeep Bad and Ugly ordered by impact. Mention files, functions, tests, or behaviors when possible.\nUse this structure:\nPR: https://github.com/octo/repo/pull/42\nChangelog:\n- Summarize the change set in a few bullets\nBad:\n- Concrete bugs, regressions, missing validation, weak tests, or operational risks\n- None.\nUgly:\n- Subtle, architectural, high-blast-radius, or easy-to-miss problems\n- None.\nGood:\n- Solid choices, simplifications, safeguards, or useful tests\nQuestions or Assumptions:\n- Unknowns, assumptions, or clarifications needed\nChange summary:\n- Merge-readiness: <Ready | Needs changes | Blocked>\n- Concise summary of what changed and what matters most\nTests:\n- Observed:\n  - ...\n- Missing / recommended:\n  - ...",
        replaceInstructions: true,
      },
    },
  ]);
  const endedState = entries[entries.length - 1]?.data as { active?: boolean };
  assert.equal(endedState.active, false);
  assert.match(
    notifications[notifications.length - 1]?.message ?? "",
    /Ended review session with a summary/
  );
});

void test("end-review can return with a structured fix queue", async () => {
  const entries: SessionEntry[] = [
    { id: "leaf-1", type: "message" },
    {
      id: "entry-2",
      type: "custom",
      customType: "pr-review-session",
      data: {
        active: true,
        startedAt: "2026-03-20T10:00:00Z",
        originId: "leaf-1",
        pr: {
          ref: "#42",
          url: "https://github.com/octo/repo/pull/42",
          title: "feat: review session",
        },
      },
    },
  ];
  const sentMessages: { message: string; options?: unknown }[] = [];
  const navigations: {
    targetId: string;
    options: { summarize: boolean; customInstructions?: string; replaceInstructions?: boolean };
  }[] = [];
  let command: RegisteredCommand | undefined;
  let nextSelectChoice: string | undefined = "Return with fix queue";
  let leafId = "entry-2";
  let entryCounter = 2;

  const pi = {
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (_name: string, registered: RegisteredCommand) => {
      command = registered;
    },
    appendEntry: (customType: string, data: unknown) => {
      entryCounter += 1;
      leafId = `entry-${entryCounter}`;
      entries.push({ id: leafId, type: "custom", customType, data });
    },
    sendUserMessage: (message: string, options?: unknown) => {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  prCompanionExtension(pi);
  assert.ok(command);
  if (!command) {
    return;
  }

  const ctx: ReviewCommandContext = {
    cwd: "/workspace/repo",
    hasUI: true,
    ui: {
      notify: () => undefined,
      select: () => Promise.resolve(nextSelectChoice),
      setWidget: () => undefined,
    },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => leafId,
    },
    navigateTree: (targetId, options) => {
      navigations.push({ targetId, options });
      return Promise.resolve({ cancelled: false });
    },
  };

  await command.handler("end-review", ctx);

  assert.deepEqual(navigations, [
    {
      targetId: "leaf-1",
      options: {
        summarize: true,
        customInstructions:
          "Turn the completed review session for #42 into an actionable fix plan.\nKeep the review format first, then add a fix queue.\nUse this structure:\nPR: https://github.com/octo/repo/pull/42\nChangelog:\n- Summarize the change set in a few bullets\nBad:\n- Concrete bugs, regressions, missing validation, weak tests, or operational risks\n- None.\nUgly:\n- Subtle, architectural, high-blast-radius, or easy-to-miss problems\n- None.\nGood:\n- Solid choices, simplifications, safeguards, or useful tests\nQuestions or Assumptions:\n- Unknowns, assumptions, or clarifications needed\nChange summary:\n- Merge-readiness: <Ready | Needs changes | Blocked>\n- Concise summary of what changed and what matters most\nTests:\n- Observed:\n  - ...\n- Missing / recommended:\n  - ...\nFix queue:\n- One concrete task per item\nSuggested execution order:\n- 1. ...",
        replaceInstructions: true,
      },
    },
  ]);
  assert.deepEqual(sentMessages, []);
});

void test("end-review supports explicit PR comment drafting", async () => {
  const entries: SessionEntry[] = [
    { id: "leaf-1", type: "message" },
    {
      id: "entry-2",
      type: "custom",
      customType: "pr-review-session",
      data: {
        active: true,
        startedAt: "2026-03-20T10:00:00Z",
        originId: "leaf-1",
        pr: {
          ref: "#42",
          url: "https://github.com/octo/repo/pull/42",
          title: "feat: review session",
        },
      },
    },
  ];
  const navigations: {
    targetId: string;
    options: { summarize: boolean; customInstructions?: string; replaceInstructions?: boolean };
  }[] = [];
  const notifications: { message: string; level?: "info" | "warning" | "error" }[] = [];
  let command: RegisteredCommand | undefined;
  let leafId = "entry-2";
  let entryCounter = 2;

  const pi = {
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (_name: string, registered: RegisteredCommand) => {
      command = registered;
    },
    appendEntry: (customType: string, data: unknown) => {
      entryCounter += 1;
      leafId = `entry-${entryCounter}`;
      entries.push({ id: leafId, type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;

  prCompanionExtension(pi);
  assert.ok(command);
  if (!command) {
    return;
  }

  const ctx: ReviewCommandContext = {
    cwd: "/workspace/repo",
    hasUI: true,
    ui: {
      notify: (message, level) => {
        notifications.push(level ? { message, level } : { message });
      },
      select: () => Promise.resolve(undefined),
      setWidget: () => undefined,
    },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => leafId,
    },
    navigateTree: (targetId, options) => {
      navigations.push({ targetId, options });
      return Promise.resolve({ cancelled: false });
    },
  };

  await command.handler("end-review comments", ctx);

  assert.deepEqual(navigations, [
    {
      targetId: "leaf-1",
      options: {
        summarize: true,
        customInstructions:
          "Draft PR review comments for #42 that I can paste into someone else's PR.\nUse this structure:\nSuggested review verdict:\n- <Approve | Request changes | Comment only>\nOverall PR comment:\n- A short ready-to-paste summary comment for the main PR conversation\nInline review comments:\n- One ready-to-paste comment per concrete issue or risk\n- None.\nQuestions / clarifications:\n- Open questions worth asking on the PR\n- None.\nNotes:\n- Base comments on the strongest Bad and Ugly findings first\n- Keep each comment concrete, polite, and easy to paste as-is\n- Mention files, functions, endpoints, tests, or behaviors when possible\n- Do not claim you authored changes or ran commands",
        replaceInstructions: true,
      },
    },
  ]);
  const endedState = entries[entries.length - 1]?.data as { active?: boolean };
  assert.equal(endedState.active, false);
  assert.match(
    notifications[notifications.length - 1]?.message ?? "",
    /Ended review session with PR review comments/
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

function fail(stderr: string) {
  return {
    code: 1,
    stdout: "",
    stderr,
    killed: false,
  };
}
