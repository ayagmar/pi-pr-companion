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
  assert.deepEqual(captured.eventNames, ["session_start", "session_tree", "agent_end"]);
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
