import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import prCompanionExtension from "../src/index.js";

interface RegisteredCommand {
  handler: (args: string, ctx: LoadingCommandContext) => Promise<void>;
}

interface LoadingCommandContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    custom: <T>(
      factory: (
        tui: { requestRender: () => void },
        theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
        _keybindings: unknown,
        done: (value: T) => void
      ) => { render: (width: number) => string[]; invalidate: () => void }
    ) => Promise<T>;
  };
}

void test("interactive status shows Pi loader before resolving PR status", async () => {
  const notifications: { message: string; level?: "info" | "warning" | "error" }[] = [];
  const renders: string[] = [];
  let command: RegisteredCommand | undefined;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as unknown as typeof clearInterval;

  const pi = {
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (_name: string, registered: RegisteredCommand) => {
      command = registered;
    },
    exec: (tool: string, args: string[]) => {
      const joined = args.join(" ");

      if (tool === "git") {
        if (joined.includes("rev-parse --show-toplevel")) return ok("/workspace/repo\n");
        if (joined.includes("branch --show-current")) return ok("feature/loading\n");
        if (joined.includes("config --get branch.feature/loading.remote")) return fail("");
        if (joined.includes("remote get-url origin")) {
          return ok("https://github.com/octo/repo.git\n");
        }
        if (joined.includes("diff --shortstat origin/main...HEAD")) {
          return ok(" 1 file changed, 3 insertions(+), 1 deletion(-)\n");
        }
      }

      if (tool === "gh") {
        if (joined.includes("pr list") && joined.includes("--head feature/loading")) {
          return ok(
            JSON.stringify([
              {
                number: 42,
                title: "feat: loading states",
                url: "https://github.com/octo/repo/pull/42",
                headRefName: "feature/loading",
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
              title: "feat: loading states",
              url: "https://github.com/octo/repo/pull/42",
              headRefName: "feature/loading",
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
          return ok(JSON.stringify([{ additions: 3, deletions: 1 }]));
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
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    return;
  }

  const ctx: LoadingCommandContext = {
    cwd: "/workspace/repo",
    hasUI: true,
    ui: {
      notify: (message, level) => {
        notifications.push(level ? { message, level } : { message });
      },
      custom: (factory) =>
        new Promise((resolve) => {
          let component:
            | {
                render: (width: number) => string[];
                invalidate: () => void;
                dispose?: () => void;
              }
            | undefined;

          component = factory(
            { requestRender: () => undefined },
            {
              fg: (_color, text) => text,
              bold: (text) => text,
            },
            undefined,
            (value) => {
              component?.dispose?.();
              resolve(value);
            }
          );
          renders.push(component.render(80).join("\n"));
          component.dispose?.();
        }),
    },
  };

  try {
    await command.handler("status", ctx);

    assert.match(renders[0] ?? "", /Loading PR status/);
    assert.match(notifications[0]?.message ?? "", /PR: #42/);
    assert.match(notifications[0]?.message ?? "", /Title: feat: loading states/);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
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
