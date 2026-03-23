import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

void test("review prompt preserves the structured review format", async () => {
  const prompt = await readFile(new URL("../prompts/review-pr.md", import.meta.url), "utf8");

  assert.match(prompt, /Before concluding, inspect impacted local files and nearby tests\./);
  assert.match(prompt, /Bad:/);
  assert.match(prompt, /Ugly:/);
  assert.match(prompt, /Good:/);
  assert.match(prompt, /Questions or Assumptions:/);
  assert.match(prompt, /- Merge-readiness: <Ready \| Needs changes \| Blocked>/);
  assert.match(
    prompt,
    /If no issues are found, explicitly write `- None\.` under `Bad` and `Ugly`\./
  );

  const badIndex = prompt.indexOf("Bad:");
  const uglyIndex = prompt.indexOf("Ugly:");
  const goodIndex = prompt.indexOf("Good:");

  assert.ok(badIndex !== -1);
  assert.ok(uglyIndex !== -1);
  assert.ok(goodIndex !== -1);
  assert.ok(badIndex < goodIndex, "review findings should appear before positives");
  assert.ok(uglyIndex < goodIndex, "review risks should appear before positives");
});
