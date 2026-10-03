import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findProjectReviewGuidelines } from "../src/review-guidelines.js";

void test("findProjectReviewGuidelines reads REVIEW_GUIDELINES.md at the nearest project root", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-pr-companion-guidelines-"));
  try {
    const repoRoot = path.join(tempDir, "repo");
    const nested = path.join(repoRoot, "src", "deep");
    await mkdir(path.join(repoRoot, ".pi"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const guidelinesPath = path.join(repoRoot, "REVIEW_GUIDELINES.md");
    await writeFile(guidelinesPath, "\n  Check migrations.  \n");

    assert.deepEqual(await findProjectReviewGuidelines(nested), {
      path: guidelinesPath,
      content: "Check migrations.",
    });

    await writeFile(guidelinesPath, "   \n");
    assert.deepEqual(await findProjectReviewGuidelines(nested), { path: guidelinesPath });

    await rm(guidelinesPath);
    assert.equal(await findProjectReviewGuidelines(nested), undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
