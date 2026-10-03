import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface ProjectReviewGuidelines {
  path: string;
  /** Trimmed file content, or undefined when the file is empty or unreadable. */
  content?: string;
}

/**
 * Walk up from cwd to the nearest project root (the first directory holding
 * pi's config dir) and read REVIEW_GUIDELINES.md next to it.
 */
export async function findProjectReviewGuidelines(
  cwd: string
): Promise<ProjectReviewGuidelines | undefined> {
  let currentDir = path.resolve(cwd);

  while (true) {
    const piStats = await stat(path.join(currentDir, CONFIG_DIR_NAME)).catch(() => undefined);
    if (piStats?.isDirectory()) {
      const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");
      const guidelineStats = await stat(guidelinesPath).catch(() => undefined);
      if (!guidelineStats?.isFile()) {
        return undefined;
      }

      const content = (await readFile(guidelinesPath, "utf8").catch(() => undefined))?.trim();
      return content ? { path: guidelinesPath, content } : { path: guidelinesPath };
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}
