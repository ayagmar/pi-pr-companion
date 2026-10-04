import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import prCompanionExtension from "../src/index.js";

interface ConfigCommandContext {
  cwd: string;
  hasUI: boolean;
  mode: "rpc";
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    input?: (title: string, placeholder?: string) => Promise<string | undefined>;
    editor?: (title: string, prefill?: string) => Promise<string | undefined>;
    setStatus: (key: string, text: string | undefined) => void;
  };
}

void test("number settings show the current value and keep it on empty input", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-pr-companion-config-"));
  const configPath = path.join(tempDir, "config.json");
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  process.env.PI_PR_COMPANION_CONFIG = configPath;

  try {
    let handler: ((args: string, ctx: ConfigCommandContext) => Promise<void>) | undefined;
    prCompanionExtension({
      on: () => undefined,
      registerTool: () => undefined,
      registerCommand: (_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      },
      exec: () => Promise.resolve({ code: 128, stdout: "", stderr: "not a git repo" }),
    } as unknown as ExtensionAPI);
    assert.ok(handler);

    // pi's TUI ignores the input placeholder, so an empty submit must not be an error.
    // "15s" used to be read as 15 by parseInt.
    const inputAnswers = ["", "15s", "250"];
    const inputTitles: string[] = [];
    let advancedVisits = 0;
    const notifications: { message: string; level?: string }[] = [];

    await handler("config", {
      cwd: tempDir,
      hasUI: true,
      mode: "rpc",
      ui: {
        notify: (message, level) => notifications.push(level ? { message, level } : { message }),
        select: (_title, options) => {
          if (advancedVisits >= 3) return Promise.resolve(undefined);
          advancedVisits += 1;
          return Promise.resolve(options.find((option) => option.startsWith("Advanced")));
        },
        input: (title) => {
          inputTitles.push(title);
          return Promise.resolve(inputAnswers.shift());
        },
        setStatus: () => undefined,
      },
    });

    assert.match(inputTitles[0] ?? "", /current 15000/);
    assert.match(inputTitles[2] ?? "", /current 15000/);
    assert.deepEqual(
      notifications.filter((item) => item.level === "error"),
      [{ message: "Status cache TTL must be a positive whole number.", level: "error" }],
      "empty input keeps the current value; only the malformed value is rejected"
    );
    assert.equal(notifications.length, 2);
    assert.match(notifications[1]?.message ?? "", /Status cache TTL set to 250ms/);

    const saved = JSON.parse(await readFile(configPath, "utf8")) as { cacheTtlMs?: number };
    assert.equal(saved.cacheTtlMs, 250);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PI_PR_COMPANION_CONFIG;
    } else {
      process.env.PI_PR_COMPANION_CONFIG = previousConfigPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

void test("config edit reports invalid JSON and reopens the editor with the text", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-pr-companion-config-"));
  const configPath = path.join(tempDir, "config.json");
  const previousConfigPath = process.env.PI_PR_COMPANION_CONFIG;
  process.env.PI_PR_COMPANION_CONFIG = configPath;

  try {
    let handler: ((args: string, ctx: ConfigCommandContext) => Promise<void>) | undefined;
    prCompanionExtension({
      on: () => undefined,
      registerTool: () => undefined,
      registerCommand: (_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      },
      exec: () => Promise.resolve({ code: 128, stdout: "", stderr: "not a git repo" }),
    } as unknown as ExtensionAPI);
    assert.ok(handler);

    // A config file that is already broken can still be opened and repaired.
    await writeFile(configPath, '{ "cacheTtlMs": 5000, }');

    const answers = ['{ "cacheTtlMs": 9000, ', "[]", '{ "cacheTtlMs": 9000 }'];
    const prefills: (string | undefined)[] = [];
    const notifications: { message: string; level?: string }[] = [];
    await handler("config edit", {
      cwd: tempDir,
      hasUI: true,
      mode: "rpc",
      ui: {
        notify: (message, level) => notifications.push(level ? { message, level } : { message }),
        select: () => Promise.resolve(undefined),
        editor: (_title, prefill) => {
          prefills.push(prefill);
          return Promise.resolve(answers.shift());
        },
        setStatus: () => undefined,
      },
    });

    assert.deepEqual(prefills, ['{ "cacheTtlMs": 5000, }', '{ "cacheTtlMs": 9000, ', "[]"]);
    const errors = notifications.filter((item) => item.level === "error");
    assert.equal(errors.length, 2);
    assert.match(errors[0]?.message ?? "", /invalid JSON/);
    assert.match(errors[1]?.message ?? "", /expected a JSON object/);
    assert.match(notifications.at(-1)?.message ?? "", /Saved config/);

    const saved = JSON.parse(await readFile(configPath, "utf8")) as { cacheTtlMs?: number };
    assert.equal(saved.cacheTtlMs, 9000);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.PI_PR_COMPANION_CONFIG;
    } else {
      process.env.PI_PR_COMPANION_CONFIG = previousConfigPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
