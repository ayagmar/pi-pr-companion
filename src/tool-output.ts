import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

/**
 * Serialize a tool payload for the model, cut to pi's default tool output
 * limits. When it is cut, the full JSON goes to a temp file the model can read.
 */
export async function formatToolJson(payload: unknown, name: string): Promise<string> {
  const text = JSON.stringify(payload, null, 2);
  const truncation = truncateHead(text);
  if (!truncation.truncated) {
    return text;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-pr-companion-"));
  const fullPath = path.join(dir, `${name}.json`);
  await writeFile(fullPath, text, "utf8");

  return [
    truncation.content,
    "",
    `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
      `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
      `Full JSON: ${fullPath}]`,
  ].join("\n");
}
