import test from "node:test";
import assert from "node:assert/strict";
import { formatBranchSwitchSuccessMessage } from "../src/branch-switch.js";

void test("formatBranchSwitchSuccessMessage distinguishes switched without update", () => {
  assert.equal(
    formatBranchSwitchSuccessMessage({
      repoRoot: "/workspace/repo",
      branch: "feat/example",
      prRef: "!75",
      fastForwarded: false,
    }),
    "Switched /workspace/repo to feat/example (!75) without remote update."
  );
});

void test("formatBranchSwitchSuccessMessage includes remote name and commit count for fast-forward", () => {
  assert.equal(
    formatBranchSwitchSuccessMessage({
      repoRoot: "/workspace/repo",
      branch: "feat/example",
      prRef: "!75",
      fastForwarded: true,
      remoteName: "origin",
      fastForwardCommitCount: 3,
    }),
    "Switched /workspace/repo to feat/example (!75) and fast-forwarded from origin (3 commits)."
  );
});

void test("formatBranchSwitchSuccessMessage handles singular commit count", () => {
  assert.equal(
    formatBranchSwitchSuccessMessage({
      repoRoot: "/workspace/repo",
      branch: "feat/example",
      prRef: "!75",
      fastForwarded: true,
      remoteName: "origin",
      fastForwardCommitCount: 1,
    }),
    "Switched /workspace/repo to feat/example (!75) and fast-forwarded from origin (1 commit)."
  );
});

void test("formatBranchSwitchSuccessMessage falls back cleanly when count is unavailable", () => {
  assert.equal(
    formatBranchSwitchSuccessMessage({
      repoRoot: "/workspace/repo",
      branch: "feat/example",
      prRef: "!75",
      fastForwarded: true,
      remoteName: "origin",
    }),
    "Switched /workspace/repo to feat/example (!75) and fast-forwarded from origin."
  );
});
