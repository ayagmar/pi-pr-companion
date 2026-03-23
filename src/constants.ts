export const COMMAND_NAME = "pr";
export const STATUS_KEY = "pr";
export const DEFAULT_CACHE_TTL_MS = 15_000;
export const DEFAULT_CONFIG_FILENAME = "pi-pr-companion-settings.json";

export const DEFAULT_IGNORED_BRANCHES = ["main", "master"] as const;

export const REVIEW_PROMPT_NAME = "review-pr";
export const REVIEW_SESSION_STATE_TYPE = "pr-review-session";
export const REVIEW_SESSION_ANCHOR_TYPE = "pr-review-anchor";
export const REVIEW_WIDGET_KEY = "pr-review";

export const GET_PR_CONTEXT_TOOL_NAME = "get_pr_context";
export const LIST_REPO_PRS_TOOL_NAME = "list_repo_prs";
export const SWITCH_PR_BRANCH_TOOL_NAME = "switch_pr_branch";

export const AUTH_ERROR_PATTERNS = [
  "gitlab_host",
  "gh auth login",
  "try authenticating",
  "authentication",
  "authentication required",
  "not logged in",
  "forbidden",
  "unauthorized",
  "401",
  "403",
] as const;

export const GITLAB_BLOCKED_PIPELINE_STATUSES = [
  "failed",
  "canceled",
  "skipped",
  "manual",
] as const;

export const GITLAB_PENDING_PIPELINE_STATUSES = ["pending", "running", "created"] as const;
