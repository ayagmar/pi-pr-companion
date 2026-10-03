import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gitlabAdapter } from "../src/providers/gitlab.js";
import { type ProviderConfig, type RepoContext } from "../src/types.js";

const provider: ProviderConfig = {
  kind: "gitlab",
  ignoredBranches: ["main"],
  showNoPrState: false,
  hosts: {},
};

const repo: RepoContext = {
  cwd: "/workspace/repo",
  repoRoot: "/workspace/repo",
  branch: "feature/x",
  remoteName: "origin",
  remoteUrl: "https://gitlab.example.com/group/repo.git",
  remote: {
    host: "gitlab.example.com",
    fullPath: "group/repo",
    repoRef: "gitlab.example.com/group/repo",
    webUrl: "https://gitlab.example.com/group/repo",
  },
};

const MR_VIEW = {
  iid: 7,
  title: "feat: x",
  web_url: "https://gitlab.example.com/group/repo/-/merge_requests/7",
  source_branch: "feature/x",
  target_branch: "main",
  updated_at: "2026-03-20T10:00:00Z",
  detailed_merge_status: "mergeable",
  has_conflicts: false,
  draft: false,
  head_pipeline: { status: "success" },
};

type CliResponse = { code: number; stdout: string; stderr: string };

const ok = (value: unknown): CliResponse => ({
  code: 0,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
});

function mockGlab(api: (endpoint: string, args: string[]) => CliResponse): ExtensionAPI {
  return {
    exec: (_command: string, args: string[]) => {
      if (args.includes("mr") && args.includes("view")) {
        return Promise.resolve(ok(MR_VIEW));
      }
      const apiIndex = args.indexOf("api");
      if (apiIndex >= 0) {
        const endpoint = args.find((arg) => arg.startsWith("projects/")) ?? "";
        return Promise.resolve(api(endpoint, args));
      }
      throw new Error(`Unexpected: glab ${args.join(" ")}`);
    },
  } as unknown as ExtensionAPI;
}

const byRef = { kind: "ref", provider: "gitlab", iid: 7, ref: "!7" } as const;

void test("a failed approvals or changes call keeps the MR instead of reporting an auth error", async () => {
  const pi = mockGlab((endpoint) => {
    if (endpoint.includes("/discussions")) return ok([]);
    return { code: 1, stdout: "", stderr: "403 {message: 403 Forbidden}" };
  });

  const result = await gitlabAdapter.getPrByRef(pi, repo, provider, byRef);
  assert.equal(result.kind, "active");
  if (result.kind !== "active") return;
  assert.equal(result.pr.ref, "!7");
  assert.equal(result.pr.approvalSummary, undefined);
  assert.equal(result.pr.diffStats, undefined);
  assert.deepEqual(result.pr.threadSummary, { total: 0, unresolved: 0 });
});
