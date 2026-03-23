import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import prCompanionExtension from "../src/index.js";
import { COMMAND_NAME } from "../src/constants.js";

interface CapturedTool {
  name: string;
  promptSnippet?: string;
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
    "session_switch",
    "session_tree",
    "session_fork",
    "agent_end",
  ]);
  for (const tool of captured.tools) {
    assert.ok(tool.promptSnippet, `${tool.name} should expose a promptSnippet for Pi >=0.59`);
  }
});
