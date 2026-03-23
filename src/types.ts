export type ProviderKind = "gitlab" | "github";
export type StatusBarStyle = "minimal" | "diff-prefix" | "diff-suffix";
export type PrCheckStatus = "success" | "failure" | "pending" | "none";
export type PrReadinessVerdict = "ready" | "needs-changes" | "blocked";

export interface ProviderHostConfig {
  enabled?: boolean;
}

export interface ProviderConfig {
  kind: ProviderKind;
  ignoredBranches: string[];
  showNoPrState: boolean;
  hosts: Record<string, ProviderHostConfig>;
}

export interface PrCompanionConfig {
  cacheTtlMs: number;
  showStatusBar: boolean;
  statusBarStyle: StatusBarStyle;
  showCoverageInStatusBar: boolean;
  showBlockerHintInStatusBar: boolean;
  showUpdatedAgeInPickers: boolean;
  stalePrDays: number;
  workspaceRoots: string[];
  sharedReviewInstructions: string;
  reviewSessionMode: boolean;
  providers: ProviderConfig[];
}

export interface RepoContext {
  cwd: string;
  repoRoot: string;
  branch: string;
  remoteName: string;
  remoteUrl: string;
  remote: ParsedGitRemote;
}

export interface ParsedGitRemote {
  host: string;
  fullPath: string;
  repoRef: string;
  webUrl: string;
}

export interface ConfigActionResult {
  config: PrCompanionConfig;
  changed: boolean;
}

export interface RepoDiffStats {
  additions: number;
  deletions: number;
}

export interface PrCheckItem {
  name: string;
  status: PrCheckStatus;
  details?: string;
}

export interface PrCheckSummary {
  status: PrCheckStatus;
  total: number;
  successful: number;
  failed: number;
  pending: number;
}

export interface PrThreadItem {
  id: string;
  body: string;
  resolved: boolean;
  path?: string;
  author?: string;
}

export interface PrThreadSummary {
  total: number;
  unresolved: number;
}

export interface PrApprovalSummary {
  decision?: string;
  approvedCount?: number;
  requestedChangesCount?: number;
  commentCount?: number;
}

export interface PrReadiness {
  verdict: PrReadinessVerdict;
  blockers: string[];
  warnings: string[];
  recommendations: string[];
}

export interface PrSummary {
  iid: number;
  ref: string;
  title: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  updatedAt: string;
  diffStats?: RepoDiffStats;
  detailedMergeStatus?: string;
  hasConflicts?: boolean;
  draft?: boolean;
  pipelineStatus?: string;
  checkSummary?: PrCheckSummary;
  threadSummary?: PrThreadSummary;
  approvalSummary?: PrApprovalSummary;
  behindTarget?: string;
  readiness?: PrReadiness;
}

export interface PrDetails extends PrSummary {
  coverage?: string;
  checkItems?: PrCheckItem[];
  threadItems?: PrThreadItem[];
}

export interface PrRefReference {
  kind: "ref";
  provider: ProviderKind;
  iid: number;
  ref: string;
}

export interface PrUrlReference {
  kind: "url";
  provider: ProviderKind;
  iid: number;
  ref: string;
  url: string;
  remote: ParsedGitRemote;
}

export type ParsedPrReference = PrRefReference | PrUrlReference;

export interface ActivePrLookup {
  kind: "active";
  provider: ProviderKind;
  pr: PrDetails;
}

export interface NoPrLookup {
  kind: "none";
  provider: ProviderKind;
}

export interface AuthErrorLookup {
  kind: "auth-error";
  provider: ProviderKind;
  message: string;
}

export interface UnsupportedLookup {
  kind: "unsupported";
  provider?: ProviderKind;
  message: string;
}

export interface ErrorLookup {
  kind: "error";
  provider: ProviderKind;
  message: string;
}

export type PrLookupResult =
  | ActivePrLookup
  | NoPrLookup
  | AuthErrorLookup
  | UnsupportedLookup
  | ErrorLookup;

export interface RepoStatusSnapshot {
  config: PrCompanionConfig;
  provider?: ProviderConfig;
  repo?: RepoContext;
  result?: PrLookupResult;
  hidden: boolean;
  reason:
    | "not-git"
    | "unsupported-remote"
    | "ignored-branch"
    | "unsupported"
    | "no-pr-hidden"
    | "visible";
}

export interface ResolvedPrContext {
  config: PrCompanionConfig;
  provider?: ProviderConfig;
  repo?: RepoContext;
  reference?: ParsedPrReference;
  result?: PrLookupResult;
  hidden: boolean;
  reason:
    | "not-git"
    | "unsupported-remote"
    | "invalid-reference"
    | "provider-mismatch"
    | "ignored-branch"
    | "unsupported"
    | "visible";
  errorMessage?: string;
}

export interface ReviewSessionPr {
  ref: string;
  url: string;
  title: string;
}

export interface ReviewSessionState {
  active: boolean;
  startedAt: string;
  originId?: string;
  pr?: ReviewSessionPr;
}
