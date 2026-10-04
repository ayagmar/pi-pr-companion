import { Type } from "typebox";

/**
 * Output schemas for the data tools. Programmatic callers such as codemode
 * scripts receive the matching `structuredContent` (the full payload) instead
 * of the model-facing text, which may be truncated. Nested shapes are kept
 * loose where they are large or change often; extra properties are allowed.
 */

const OPTIONAL_STRING = Type.Optional(Type.String());

const PR_READINESS_OUTPUT = Type.Object({
  verdict: Type.String({ description: "ready, needs-changes, or blocked" }),
  blockers: Type.Array(Type.String()),
  warnings: Type.Array(Type.String()),
  recommendations: Type.Array(Type.String()),
});

const PR_SUMMARY_FIELDS = {
  iid: Type.Number(),
  ref: Type.String({ description: "Provider ref such as #42 or !7" }),
  title: Type.String(),
  url: Type.String(),
  sourceBranch: Type.String(),
  targetBranch: Type.String(),
  updatedAt: Type.String(),
  draft: Type.Optional(Type.Boolean()),
  fromFork: Type.Optional(
    Type.Boolean({ description: "The source branch lives in a fork, not in this repo" })
  ),
  state: Type.Optional(Type.String({ description: "open, closed, or merged" })),
  pipelineStatus: OPTIONAL_STRING,
  detailedMergeStatus: OPTIONAL_STRING,
  hasConflicts: Type.Optional(Type.Boolean()),
  diffStats: Type.Optional(Type.Object({ additions: Type.Number(), deletions: Type.Number() })),
  checkSummary: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  threadSummary: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  approvalSummary: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  readiness: Type.Optional(PR_READINESS_OUTPUT),
};

const PR_SUMMARY_OUTPUT = Type.Object(PR_SUMMARY_FIELDS);

const PR_DETAILS_OUTPUT = Type.Object({
  ...PR_SUMMARY_FIELDS,
  coverage: OPTIONAL_STRING,
  checkItems: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  threadItems: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
});

export const PR_CONTEXT_OUTPUT_SCHEMA = Type.Object({
  cwd: Type.String(),
  repoRoot: OPTIONAL_STRING,
  provider: Type.Optional(Type.String({ description: "github or gitlab" })),
  remote: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  reference: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  result: Type.Optional(
    Type.Object({
      kind: Type.String({ description: "active, none, auth-error, unsupported, or error" }),
      provider: OPTIONAL_STRING,
      message: OPTIONAL_STRING,
      pr: Type.Optional(PR_DETAILS_OUTPUT),
    })
  ),
  error: OPTIONAL_STRING,
  sharedReviewInstructions: OPTIONAL_STRING,
  reviewSessionMode: Type.Boolean(),
  projectReviewGuidelinesPath: OPTIONAL_STRING,
  projectReviewGuidelines: OPTIONAL_STRING,
});

export const LIST_REPO_PRS_OUTPUT_SCHEMA = Type.Object({
  cwd: Type.String(),
  repoRoot: OPTIONAL_STRING,
  provider: Type.Optional(Type.String({ description: "github or gitlab" })),
  prs: Type.Array(PR_SUMMARY_OUTPUT),
  error: OPTIONAL_STRING,
});
