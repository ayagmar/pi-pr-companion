import type { ParsedGitRemote, ParsedPrReference } from "./types.js";

export function parsePrReference(raw: string): ParsedPrReference | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  const refReference = parsePrNumberReference(value);
  if (refReference) {
    return refReference;
  }

  return parsePrUrlReference(value);
}

function parsePrNumberReference(value: string): ParsedPrReference | undefined {
  const githubMatch = value.match(/^#(\d+)$/);
  if (githubMatch) {
    const iid = Number.parseInt(githubMatch[1] ?? "", 10);
    return Number.isFinite(iid)
      ? { kind: "ref", provider: "github", iid, ref: `#${iid}` }
      : undefined;
  }

  const gitlabMatch = value.match(/^!(\d+)$/);
  if (gitlabMatch) {
    const iid = Number.parseInt(gitlabMatch[1] ?? "", 10);
    return Number.isFinite(iid)
      ? { kind: "ref", provider: "gitlab", iid, ref: `!${iid}` }
      : undefined;
  }

  return undefined;
}

function parsePrUrlReference(value: string): ParsedPrReference | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const githubMatch = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/);
  if (githubMatch) {
    const fullPath = githubMatch[1];
    const iid = Number.parseInt(githubMatch[2] ?? "", 10);
    if (!fullPath || !Number.isFinite(iid)) return undefined;

    return {
      kind: "url",
      provider: "github",
      iid,
      ref: `#${iid}`,
      url: normalizeUrl(url),
      remote: buildRemote(url, fullPath),
    };
  }

  const gitlabMatch = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
  if (gitlabMatch) {
    const fullPath = gitlabMatch[1];
    const iid = Number.parseInt(gitlabMatch[2] ?? "", 10);
    if (!fullPath || !Number.isFinite(iid)) return undefined;

    return {
      kind: "url",
      provider: "gitlab",
      iid,
      ref: `!${iid}`,
      url: normalizeUrl(url),
      remote: buildRemote(url, fullPath),
    };
  }

  return undefined;
}

function buildRemote(url: URL, fullPath: string): ParsedGitRemote {
  const normalizedFullPath = stripSlashes(stripGitSuffix(fullPath));
  return {
    host: url.host,
    fullPath: normalizedFullPath,
    repoRef: `${url.host}/${normalizedFullPath}`,
    webUrl: `${url.protocol}//${url.host}/${normalizedFullPath}`,
  };
}

function normalizeUrl(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.search = "";
  normalized.hash = "";
  return normalized.toString().replace(/\/$/, "");
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function stripSlashes(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}
