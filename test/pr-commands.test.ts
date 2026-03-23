import test from "node:test";
import assert from "node:assert/strict";
import { buildArgumentCompletions, buildHelpText, parseSubcommand } from "../src/commands.js";
import { COMMAND_NAME } from "../src/constants.js";

void test("parseSubcommand splits name and rest", () => {
  assert.deepEqual(parseSubcommand("review now"), {
    name: "review",
    rest: "now",
  });
});

void test("parseSubcommand handles empty input", () => {
  assert.deepEqual(parseSubcommand(""), { name: "", rest: "" });
  assert.deepEqual(parseSubcommand("   "), { name: "", rest: "" });
});

void test("buildArgumentCompletions supports top-level, review, end-review, config subcommands, and direct config values", () => {
  assert.deepEqual(buildArgumentCompletions("re"), [
    { value: "refresh", label: "refresh" },
    { value: "review", label: "review" },
    { value: "ready", label: "ready" },
  ]);

  assert.deepEqual(buildArgumentCompletions("config s"), [
    { value: "config show", label: "config show" },
    { value: "config statusbar", label: "config statusbar" },
  ]);

  assert.deepEqual(buildArgumentCompletions("config c"), [
    { value: "config coverage", label: "config coverage" },
  ]);

  assert.deepEqual(buildArgumentCompletions("review s"), [
    { value: "review session", label: "review session" },
  ]);

  assert.deepEqual(buildArgumentCompletions("end-review "), [
    { value: "end-review return", label: "end-review return" },
    { value: "end-review summary", label: "end-review summary" },
    { value: "end-review comments", label: "end-review comments" },
    { value: "end-review queue", label: "end-review queue" },
  ]);

  assert.deepEqual(buildArgumentCompletions("config "), [
    { value: "config edit", label: "config edit" },
    { value: "config show", label: "config show" },
    { value: "config statusbar", label: "config statusbar" },
    { value: "config footer", label: "config footer" },
    { value: "config coverage", label: "config coverage" },
    { value: "config blockers", label: "config blockers" },
  ]);

  assert.deepEqual(buildArgumentCompletions("config footer "), [
    { value: "config footer diff-prefix", label: "config footer diff-prefix" },
    { value: "config footer diff-suffix", label: "config footer diff-suffix" },
    { value: "config footer minimal", label: "config footer minimal" },
  ]);

  assert.deepEqual(buildArgumentCompletions("config coverage h"), [
    { value: "config coverage hidden", label: "config coverage hidden" },
  ]);

  assert.equal(buildArgumentCompletions("config show "), null);
});

void test("buildHelpText includes pr commands", () => {
  const help = buildHelpText();
  assert.match(help, new RegExp(`/${COMMAND_NAME}\\s+Open the PR menu`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} status`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} refresh`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} review`));
  assert.match(
    help,
    new RegExp(`/${COMMAND_NAME} end-review \\[return\\|summary\\|comments\\|queue\\]`)
  );
  assert.match(help, new RegExp(`/${COMMAND_NAME} switch`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} ready`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} checks`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} threads`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} active`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} dashboard`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} config show`));
  assert.doesNotMatch(help, new RegExp(`/${COMMAND_NAME} config add \\[path\\]`));
  assert.doesNotMatch(help, new RegExp(`/${COMMAND_NAME} config remove \\[path\\]`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} config edit`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} config statusbar \\[shown\\|hidden\\]`));
  assert.match(
    help,
    new RegExp(`/${COMMAND_NAME} config footer \\[diff-prefix\\|diff-suffix\\|minimal\\]`)
  );
  assert.match(help, new RegExp(`/${COMMAND_NAME} config coverage \\[shown\\|hidden\\]`));
  assert.match(help, new RegExp(`/${COMMAND_NAME} config blockers \\[shown\\|hidden\\]`));
});
