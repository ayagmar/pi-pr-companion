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

void test("MR discussions are fetched across all pages", async () => {
  const discussion = (id: string, resolved: boolean) => ({
    id,
    notes: [{ id: 1, body: `note ${id}`, resolvable: true, resolved }],
  });
  const calls: string[][] = [];
  const pi = mockGlab((endpoint, args) => {
    calls.push(args);
    if (endpoint.includes("/discussions")) {
      // Older glab prints one array per page back to back.
      const page1 = Array.from({ length: 20 }, (_, i) => discussion(`a${i}`, true));
      const page2 = [discussion("b0", false), discussion("b1", false)];
      return ok(`${JSON.stringify(page1)}\n${JSON.stringify(page2)}`);
    }
    return ok({});
  });

  const result = await gitlabAdapter.getPrByRef(pi, repo, provider, byRef);
  assert.equal(result.kind, "active");
  if (result.kind !== "active") return;
  assert.deepEqual(result.pr.threadSummary, { total: 22, unresolved: 2 });
  const discussionsCall = calls.find((args) => args.some((arg) => arg.includes("/discussions")));
  assert.ok(discussionsCall?.includes("--paginate"));
  assert.ok(discussionsCall?.some((arg) => arg.endsWith("/discussions?per_page=100")));
});

void test("diff stats count changed lines that look like file headers", async () => {
  const diff = [
    "@@ -1,3 +1,3 @@",
    " SELECT 1;",
    "--- old SQL comment",
    "+++ counter++ on a new line",
    "-plain removal",
    "+plain addition",
    "\\ No newline at end of file",
  ].join("\n");
  const pi = mockGlab((endpoint) => {
    if (endpoint.includes("/changes")) {
      return ok({ changes: [{ diff }, { diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n" }] });
    }
    return ok(endpoint.includes("/discussions") ? [] : {});
  });

  const result = await gitlabAdapter.getPrByRef(pi, repo, provider, byRef);
  assert.equal(result.kind, "active");
  assert.deepEqual(result.kind === "active" ? result.pr.diffStats : undefined, {
    additions: 3,
    deletions: 3,
  });
});

void test("a closed MR keeps its state", async () => {
  const pi = {
    exec: (_command: string, args: string[]) =>
      Promise.resolve(
        args.includes("view")
          ? ok({ ...MR_VIEW, state: "closed" })
          : ok(args.some((a) => a.includes("/discussions")) ? [] : {})
      ),
  } as unknown as ExtensionAPI;

  const result = await gitlabAdapter.getPrByRef(pi, repo, provider, byRef);
  assert.equal(result.kind === "active" ? result.pr.state : undefined, "closed");
});

void test("listing open MRs asks for more than glab's default 30", async () => {
  const calls: string[][] = [];
  const pi = {
    exec: (_command: string, args: string[]) => {
      calls.push(args);
      return Promise.resolve(ok([]));
    },
  } as unknown as ExtensionAPI;

  assert.deepEqual(await gitlabAdapter.listRepoActivePrs(pi, repo, provider), []);
  assert.equal(calls[0]?.[calls[0].indexOf("--per-page") + 1], "100");
});

void test("a fork MR is flagged and ignored by the branch lookup", async () => {
  const forkMr = {
    ...MR_VIEW,
    source_branch: "main",
    source_project_id: 99,
    target_project_id: 1,
  };
  const pi = {
    exec: (_command: string, args: string[]) => {
      if (args.includes("mr") && args.includes("list")) return Promise.resolve(ok([forkMr]));
      if (args.includes("mr") && args.includes("view")) return Promise.resolve(ok(forkMr));
      if (args.includes("api")) return Promise.resolve(ok([]));
      throw new Error(`Unexpected: glab ${args.join(" ")}`);
    },
  } as unknown as ExtensionAPI;

  const byBranch = await gitlabAdapter.getPrByBranch(
    pi,
    { ...repo, branch: "main" },
    provider,
    "main"
  );
  assert.equal(byBranch.kind, "none", "a fork's main is not this project's main");

  const byIid = await gitlabAdapter.getPrByRef(pi, repo, provider, byRef);
  assert.equal(byIid.kind === "active" ? byIid.pr.fromFork : undefined, true);

  const sameProject = { ...MR_VIEW, source_project_id: 1, target_project_id: 1 };
  const listed = await gitlabAdapter.listRepoActivePrs(
    {
      exec: () => Promise.resolve(ok([sameProject])),
    } as unknown as ExtensionAPI,
    repo,
    provider
  );
  assert.equal(Array.isArray(listed) ? listed[0]?.fromFork : "not a list", undefined);
});
