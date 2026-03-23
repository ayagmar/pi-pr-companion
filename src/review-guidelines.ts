import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export async function loadProjectReviewGuidelines(cwd: string): Promise<string | undefined> {
  let currentDir = path.resolve(cwd);

  while (true) {
    const piDir = path.join(currentDir, ".pi");
    const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

    const piStats = await stat(piDir).catch(() => undefined);
    if (piStats?.isDirectory()) {
      const guidelineStats = await stat(guidelinesPath).catch(() => undefined);
      if (!guidelineStats?.isFile()) {
        return undefined;
      }

      const content = await readFile(guidelinesPath, "utf8").catch(() => undefined);
      const trimmed = content?.trim();
      return trimmed || undefined;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

export async function findProjectReviewGuidelinesPath(cwd: string): Promise<string | undefined> {
  let currentDir = path.resolve(cwd);

  while (true) {
    const piDir = path.join(currentDir, ".pi");
    const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

    const piStats = await stat(piDir).catch(() => undefined);
    if (piStats?.isDirectory()) {
      const guidelineStats = await stat(guidelinesPath).catch(() => undefined);
      return guidelineStats?.isFile() ? guidelinesPath : undefined;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}
