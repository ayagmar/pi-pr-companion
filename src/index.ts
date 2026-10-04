import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BorderedLoader,
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getSelectListTheme,
  keyHint,
  rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatBranchSwitchSuccessMessage } from "./branch-switch.js";
import { buildArgumentCompletions, buildHelpText, parseSubcommand } from "./commands.js";
import {
  getConfigPath,
  getProviderConfig,
  loadConfig,
  normalizeConfig,
  normalizePath,
  saveConfig,
  serializeConfig,
  setShowBlockerHintInStatusBar,
  setShowCoverageInStatusBar,
  setShowStatusBar,
  setStatusBarStyle,
} from "./config.js";
import {
  COMMAND_NAME,
  GET_PR_CONTEXT_TOOL_NAME,
  LIST_REPO_PRS_TOOL_NAME,
  REVIEW_PROMPT_NAME,
  STATUS_KEY,
  SWITCH_PR_BRANCH_TOOL_NAME,
} from "./constants.js";
import { hasDirtyWorktree, switchToBranch } from "./git.js";
import { buildDashboardTitle, formatPickerEntry } from "./pr-display.js";
import { evaluatePrReadiness } from "./pr-readiness.js";
import { canSwitchResolvedPr, getResolvedPrErrorMessage, resolvePrContext } from "./pr-resolver.js";
import {
  clearRepoStatusCache,
  describePrActivity,
  formatStatusText,
  getRepoStatusSnapshot,
  listActivePrsForCurrentRepo,
} from "./pr-state.js";
import { findProjectReviewGuidelines } from "./review-guidelines.js";
import {
  applyReviewSessionState,
  endReviewSession,
  getReviewSessionState,
  startReviewSession,
} from "./review-session.js";
import { formatToolJson } from "./tool-output.js";
import {
  type ExecApi,
  type PrCompanionConfig,
  type PrDetails,
  type PrLookupResult,
  type PrSummary,
  type RepoStatusSnapshot,
  type ResolvedPrContext,
  type ReviewSessionState,
  type StatusBarStyle,
} from "./types.js";

type ConfigAction = "edit" | "show" | "statusbar" | "footer" | "coverage" | "blockers";

const FOOTER_STYLE_OPTIONS: Record<StatusBarStyle, string> = {
  minimal: "Minimal: PR !107 ✓",
  "diff-prefix": "Diff prefix: +12 -4 PR !107 ✓",
  "diff-suffix": "Diff suffix: PR !107 ✓ (+12/-4)",
};

const SETTINGS_VALUE_SHOWN = "shown";
const SETTINGS_VALUE_HIDDEN = "hidden";

const CWD_PARAM = Type.Optional(Type.String({ description: "Optional repo path override" }));

const OPTIONAL_CWD_SCHEMA = Type.Object({
  cwd: CWD_PARAM,
});

const PR_CONTEXT_SCHEMA = Type.Object({
  reference: Type.Optional(Type.String({ description: "Optional PR ref or URL" })),
  cwd: CWD_PARAM,
});

const SWITCH_PR_SCHEMA = Type.Object({
  reference: Type.String({ description: "PR ref or URL" }),
  cwd: CWD_PARAM,
});

export default function prCompanionExtension(pi: ExtensionAPI) {
  // Bumped on session_shutdown so refreshes still in flight from a replaced or
  // reloaded session never touch its stale ctx.
  let sessionGeneration = 0;

  const refreshStatus = async (
    ctx: ExtensionContext,
    options?: { force?: boolean }
  ): Promise<void> => {
    const generation = sessionGeneration;
    try {
      applyReviewSessionState(ctx);
      if (!ctx.hasUI) return;

      const snapshot = await getRepoStatusSnapshot(pi, ctx.cwd, options);
      if (generation !== sessionGeneration) return;
      applyStatusLine(ctx, snapshot);
    } catch (error) {
      if (generation !== sessionGeneration || ctx.mode === "tui") return;
      console.error("[pi-pr-companion] Failed to refresh status", error);
    }
  };

  // Footer refreshes call gh/glab over the network, so they run in the
  // background instead of holding up startup, reload, and tree navigation.
  pi.on("session_start", (_event, ctx) => {
    void refreshStatus(ctx, { force: true });
  });
  pi.on("session_tree", (_event, ctx) => {
    void refreshStatus(ctx, { force: true });
  });
  pi.on("agent_settled", (_event, ctx) => {
    void refreshStatus(ctx);
  });
  pi.on("session_shutdown", () => {
    sessionGeneration += 1;
  });

  registerTools(pi);

  pi.registerCommand(COMMAND_NAME, {
    description: "PR status, review, switching, readiness, dashboard, and config",
    getArgumentCompletions: buildArgumentCompletions,
    handler: async (args, ctx) => {
      const { name, rest } = parseSubcommand(args);

      if (!name) {
        if (ctx.hasUI) {
          await openPrMenu(pi, ctx);
          return;
        }

        notify(ctx, buildHelpText());
        return;
      }

      switch (name) {
        case "status":
          await handleStatus(pi, ctx, rest);
          return;
        case "refresh":
          await handleRefresh(pi, ctx);
          return;
        case "review":
          await handleReview(pi, ctx, rest);
          return;
        case "end-review":
          await handleEndReview(pi, ctx, rest);
          return;
        case "switch":
          await handleSwitch(pi, ctx, rest);
          return;
        case "ready":
          await handleReady(pi, ctx, rest);
          return;
        case "checks":
          await handleChecks(pi, ctx, rest);
          return;
        case "threads":
          await handleThreads(pi, ctx, rest);
          return;
        case "active":
          await handleActive(pi, ctx);
          return;
        case "dashboard":
          await handleDashboard(pi, ctx);
          return;
        case "workspace":
          await handleWorkspace(pi, ctx);
          return;
        case "config":
          await handleConfig(pi, ctx, rest);
          return;
        default:
          notify(ctx, buildHelpText());
      }
    },
  });
}

function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: GET_PR_CONTEXT_TOOL_NAME,
    label: "Get PR Context",
    description:
      "Resolve the current PR or a provided PR ref/URL and return metadata, checks, merge state, threads, approvals, readiness, shared review instructions, and project review guidelines.",
    promptSnippet:
      "Resolve the active PR or a provided PR URL/reference and return review-ready PR context.",
    promptGuidelines: [
      "Use this tool first when you need PR metadata, checks, merge state, readiness, shared review instructions, or project review guidelines.",
      "Prefer this tool over raw gh/glab commands for PR context.",
    ],
    parameters: PR_CONTEXT_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const exec = bindAbortSignal(pi, signal);
      const cwd = resolveToolCwd(ctx.cwd, params.cwd);
      const resolved = await resolvePrContext(exec, cwd, params.reference);
      const payload = await buildToolPrContextPayload(cwd, resolved);
      return {
        content: [{ type: "text", text: await formatToolJson(payload, GET_PR_CONTEXT_TOOL_NAME) }],
        details: payload,
      };
    },
  });

  pi.registerTool({
    name: LIST_REPO_PRS_TOOL_NAME,
    label: "List Repo PRs",
    description: "List active PRs for the current repo or an optional repo path.",
    promptSnippet: "List active PRs for the current repo.",
    promptGuidelines: [
      "Use this tool when you need a compact list of active PRs for the current repository before choosing one to inspect.",
    ],
    parameters: OPTIONAL_CWD_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const exec = bindAbortSignal(pi, signal);
      const cwd = resolveToolCwd(ctx.cwd, params.cwd);
      const listed = await listActivePrsForCurrentRepo(exec, cwd);
      const payload = {
        cwd,
        repoRoot: listed.snapshot.repo?.repoRoot,
        provider: listed.snapshot.provider?.kind,
        prs: listed.prs ?? [],
        error: listed.lookupError?.kind === "error" ? listed.lookupError.message : undefined,
      };
      return {
        content: [{ type: "text", text: await formatToolJson(payload, LIST_REPO_PRS_TOOL_NAME) }],
        details: payload,
      };
    },
  });

  pi.registerTool({
    name: SWITCH_PR_BRANCH_TOOL_NAME,
    label: "Switch PR Branch",
    description:
      "Switch to a PR source branch by ref or URL. Fails if the worktree is dirty or the target PR is outside the current repo.",
    promptSnippet: "Switch to a PR source branch when local inspection is useful and safe.",
    promptGuidelines: [
      "Only use this tool when local inspection will materially improve the answer.",
      "Do not use this tool for PRs outside the current repo.",
      "Expect this tool to fail on dirty worktrees instead of forcing a branch switch.",
    ],
    parameters: SWITCH_PR_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const exec = bindAbortSignal(pi, signal);
      const cwd = resolveToolCwd(ctx.cwd, params.cwd);
      const resolved = await resolvePrContext(exec, cwd, params.reference);
      if (!resolved.repo || !resolved.result || resolved.result.kind !== "active") {
        const message = getResolvedPrErrorMessage(resolved) ?? "PR lookup failed";
        return {
          content: [{ type: "text", text: message }],
          details: { ok: false, message },
          isError: true,
        };
      }

      if (!canSwitchResolvedPr(resolved)) {
        const message = "Cannot switch branches for a PR outside the current repo.";
        return {
          content: [{ type: "text", text: message }],
          details: { ok: false, message },
          isError: true,
        };
      }

      if (await hasDirtyWorktree(exec, resolved.repo.repoRoot)) {
        const message = `Dirty worktree: ${resolved.repo.repoRoot}`;
        return {
          content: [{ type: "text", text: message }],
          details: { ok: false, message },
          isError: true,
        };
      }

      const repoRoot = resolved.repo.repoRoot;
      // A cancelled switch may still have changed the branch.
      const result = await switchToBranch(exec, repoRoot, resolved.result.pr.sourceBranch, {
        remoteName: resolved.repo.remoteName,
      }).finally(() => clearRepoStatusCache(repoRoot));
      return {
        content: [{ type: "text", text: result.message }],
        details: result,
        ...(result.ok ? {} : { isError: true }),
      };
    },
  });
}

async function openPrMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const choice = await ctx.ui.select("PR Companion", [
    "Status",
    "Review",
    "Review session",
    "Switch active PR",
    "Dashboard",
    "Workspace",
    "Settings",
    "Help",
  ]);
  if (!choice) {
    return;
  }

  if (choice === "Status") {
    await handleStatus(pi, ctx, "");
    return;
  }

  if (choice === "Review") {
    await handleReview(pi, ctx, "");
    return;
  }

  if (choice === "Review session") {
    await handleReview(pi, ctx, "session");
    return;
  }

  if (choice === "Switch active PR") {
    await handleActive(pi, ctx);
    return;
  }

  if (choice === "Dashboard") {
    await handleDashboard(pi, ctx);
    return;
  }

  if (choice === "Workspace") {
    await handleWorkspace(pi, ctx);
    return;
  }

  if (choice === "Settings") {
    await handleConfig(pi, ctx, "");
    return;
  }

  notify(ctx, buildHelpText());
}

async function handleStatus(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string,
  cwd = ctx.cwd
): Promise<void> {
  try {
    const resolved = await runWithLoader(ctx, "Loading PR status...", () =>
      resolvePrContext(pi, cwd, rawArgs || undefined)
    );
    notify(ctx, buildResolvedPrStatusMessage(cwd, resolved));
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to resolve PR status"), "error");
  }
}

async function handleRefresh(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  try {
    const message = await runWithLoader(ctx, "Refreshing PR status...", async () => {
      clearRepoStatusCache();
      // One forced lookup feeds both the footer and the status message.
      const refreshed = await getRepoStatusSnapshot(pi, ctx.cwd, { force: true });
      applyStatusLine(ctx, refreshed);
      const resolved = snapshotToResolvedContext(refreshed);
      return `Refreshed PR status.\n\n${buildResolvedPrStatusMessage(ctx.cwd, resolved)}`;
    });
    notify(ctx, message);
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to refresh PR status"), "error");
  }
}

async function handleReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string
): Promise<void> {
  try {
    const parsed = parseReviewRequest(rawArgs);
    const { config, resolved } = await runWithLoader(ctx, "Preparing PR review...", async () => ({
      config: await loadConfig(),
      resolved: await resolvePrContext(pi, ctx.cwd, parsed.reference),
    }));
    const startSession = parsed.startSession || config.reviewSessionMode;
    const result = requireActivePrResult(resolved);
    if (result.kind !== "active") {
      notify(ctx, getResolvedPrErrorMessage(resolved) ?? "PR lookup failed", "error");
      return;
    }

    if (startSession && getReviewSessionState(ctx)?.active) {
      notify(ctx, "A review session is already active. Use /pr end-review first.", "warning");
      return;
    }

    // A review session anchors its return point at the current leaf. While a run
    // is in progress that leaf is mid-run (possibly a tool call without results),
    // and the rest of the run would land inside the review branch, so
    // /pr end-review would drop it from the restored context.
    if (startSession && !ctx.isIdle()) {
      notify(
        ctx,
        "Wait for the current run to finish before starting a review session.",
        "warning"
      );
      return;
    }

    if (startSession) {
      const session = startReviewSession(pi, ctx, {
        active: true,
        startedAt: new Date().toISOString(),
        pr: {
          ref: result.pr.ref,
          url: result.pr.url,
          title: result.pr.title,
        },
      });
      if (!session) {
        notify(ctx, "Failed to start review session.", "error");
        return;
      }
    }

    const reviewCommand = [
      `/${REVIEW_PROMPT_NAME}`,
      result.pr.url,
      parsed.extra ? `--extra ${parsed.extra}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    // Expand the /review-pr prompt template (sendUserMessage sends text literally
    // by default) and queue it as a follow-up while the agent is busy, instead of
    // letting pi reject the message. Only a plain review gets here while busy;
    // review sessions require an idle agent (see above).
    const idle = ctx.isIdle();
    pi.sendUserMessage(reviewCommand, {
      expandPromptTemplates: true,
      ...(idle ? {} : { deliverAs: "followUp" as const }),
    });
    const queuedSuffix = idle ? "" : " (queued until the current run finishes)";
    notify(
      ctx,
      startSession
        ? `Started review session for ${result.pr.ref}${queuedSuffix}`
        : `Triggered /${REVIEW_PROMPT_NAME} for ${result.pr.ref}${queuedSuffix}`
    );
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to start PR review"), "error");
  }
}

type EndReviewAction = "return" | "summary" | "comments" | "queue";

const END_REVIEW_CHOICES: { label: string; action: EndReviewAction }[] = [
  { label: "Return only", action: "return" },
  { label: "Return with review summary", action: "summary" },
  { label: "Return with PR review comments draft", action: "comments" },
  { label: "Return with fix queue", action: "queue" },
];

async function handleEndReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string
): Promise<void> {
  const state = getReviewSessionState(ctx);
  if (!state?.active) {
    notify(ctx, "No review session is active.", "warning");
    return;
  }

  if (!state.originId) {
    endReviewSession(pi, ctx);
    notify(ctx, "Review session was missing its return point. Ended session.", "warning");
    return;
  }

  const requestedAction = parseEndReviewAction(rawArgs);
  if (requestedAction === "invalid") {
    notify(ctx, "Usage: /pr end-review [return|summary|comments|queue]", "error");
    return;
  }

  const action = requestedAction ?? (await selectEndReviewAction(ctx));
  if (!action) {
    notify(ctx, "Cancelled. Use /pr end-review to try again.", "info");
    return;
  }

  const returned = await returnToReviewOrigin(
    ctx,
    state.originId,
    buildEndReviewPrompt(action, state)
  );
  if (!returned) {
    return;
  }

  endReviewSession(pi, ctx);
  notify(ctx, buildEndReviewSuccessMessage(action));
}

async function handleSwitch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string
): Promise<void> {
  const reference = rawArgs.trim();
  if (!reference) {
    notify(ctx, "Usage: /pr switch <ref|url>", "error");
    return;
  }

  try {
    const resolved = await runWithLoader(ctx, "Loading PR branch...", () =>
      resolvePrContext(pi, ctx.cwd, reference)
    );
    const result = requireActivePrResult(resolved);
    if (result.kind !== "active" || !resolved.repo) {
      notify(ctx, getResolvedPrErrorMessage(resolved) ?? "PR lookup failed", "error");
      return;
    }

    const repo = resolved.repo;
    if (!canSwitchResolvedPr(resolved)) {
      notify(ctx, "Cannot switch branches for a PR outside the current repo.", "error");
      return;
    }

    const switchAllowed = await ensureSwitchAllowed(pi, ctx, repo.repoRoot);
    if (!switchAllowed) {
      return;
    }

    const switchResult = await runWithLoader(ctx, `Switching to ${result.pr.ref}...`, () =>
      switchToBranch(pi, repo.repoRoot, result.pr.sourceBranch, {
        remoteName: repo.remoteName,
      })
    );
    if (!switchResult.ok) {
      notify(ctx, switchResult.message, "error");
      return;
    }

    clearRepoStatusCache(repo.repoRoot);
    const refreshed = await runWithLoader(ctx, "Refreshing PR footer...", () =>
      getRepoStatusSnapshot(pi, ctx.cwd, { force: true })
    );
    applyStatusLine(ctx, refreshed);
    notify(
      ctx,
      formatBranchSwitchSuccessMessage({
        repoRoot: repo.repoRoot,
        branch: result.pr.sourceBranch,
        prRef: result.pr.ref,
        fastForwarded: switchResult.fastForwarded,
        remoteName: switchResult.remoteName,
        fastForwardCommitCount: switchResult.fastForwardCommitCount,
      })
    );
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to switch PR branch"), "error");
  }
}

async function handleReady(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string,
  cwd = ctx.cwd
): Promise<void> {
  try {
    const resolved = await runWithLoader(ctx, "Checking PR readiness...", () =>
      resolvePrContext(pi, cwd, rawArgs || undefined)
    );
    const result = requireActivePrResult(resolved);
    if (result.kind !== "active") {
      notify(ctx, getResolvedPrErrorMessage(resolved) ?? "PR lookup failed", "error");
      return;
    }

    notify(ctx, buildReadinessMessage(result.pr));
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to resolve PR readiness"), "error");
  }
}

async function handleChecks(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string,
  cwd = ctx.cwd
): Promise<void> {
  try {
    const resolved = await runWithLoader(ctx, "Loading PR checks...", () =>
      resolvePrContext(pi, cwd, rawArgs || undefined)
    );
    const result = requireActivePrResult(resolved);
    if (result.kind !== "active") {
      notify(ctx, getResolvedPrErrorMessage(resolved) ?? "PR lookup failed", "error");
      return;
    }

    notify(ctx, buildChecksMessage(result.pr));
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to resolve PR checks"), "error");
  }
}

async function handleThreads(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string,
  cwd = ctx.cwd
): Promise<void> {
  try {
    const resolved = await runWithLoader(ctx, "Loading PR threads...", () =>
      resolvePrContext(pi, cwd, rawArgs || undefined)
    );
    const result = requireActivePrResult(resolved);
    if (result.kind !== "active") {
      notify(ctx, getResolvedPrErrorMessage(resolved) ?? "PR lookup failed", "error");
      return;
    }

    notify(ctx, buildThreadsMessage(result.pr));
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to resolve PR threads"), "error");
  }
}

async function handleActive(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "`/pr active` requires interactive mode");
    return;
  }

  try {
    const { snapshot, prs, lookupError } = await runWithLoader(ctx, "Loading active PRs...", () =>
      listActivePrsForCurrentRepo(pi, ctx.cwd)
    );
    const guardMessage = getActionGuardMessage(snapshot, lookupError);
    if (guardMessage) {
      notify(ctx, guardMessage);
      return;
    }

    if (!prs || prs.length === 0) {
      notify(ctx, "No active PRs found for the current repo");
      return;
    }

    const selectedRef = await openPrSelector(
      ctx,
      buildPrSelectorTitle("Active PRs for current repo", prs.length),
      prs,
      snapshot.config
    );
    if (!selectedRef) {
      return;
    }

    await handleSwitch(pi, ctx, selectedRef);
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to list active PRs"), "error");
  }
}

async function handleDashboard(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "`/pr dashboard` requires interactive mode");
    return;
  }

  try {
    const { snapshot, prs, lookupError } = await runWithLoader(ctx, "Loading PR dashboard...", () =>
      listActivePrsForCurrentRepo(pi, ctx.cwd)
    );
    const guardMessage = getActionGuardMessage(snapshot, lookupError);
    if (guardMessage) {
      notify(ctx, guardMessage);
      return;
    }

    if (!snapshot.repo || !prs || prs.length === 0) {
      notify(ctx, "No active PRs found for the current repo");
      return;
    }

    const selectedRef = await openPrSelector(
      ctx,
      buildPrSelectorTitle(buildDashboardTitle(snapshot.repo.repoRoot), prs.length),
      prs,
      snapshot.config
    );
    if (!selectedRef) {
      return;
    }

    const action = await ctx.ui.select(`PR action · ${selectedRef}`, [
      "Status",
      "Ready",
      "Checks",
      "Threads",
      "Review",
      "Review session",
      "Switch",
    ]);
    if (!action) {
      return;
    }

    if (action === "Status") {
      await handleStatus(pi, ctx, selectedRef);
      return;
    }

    if (action === "Ready") {
      await handleReady(pi, ctx, selectedRef);
      return;
    }

    if (action === "Checks") {
      await handleChecks(pi, ctx, selectedRef);
      return;
    }

    if (action === "Threads") {
      await handleThreads(pi, ctx, selectedRef);
      return;
    }

    if (action === "Review") {
      await handleReview(pi, ctx, selectedRef);
      return;
    }

    if (action === "Review session") {
      await handleReview(pi, ctx, `session ${selectedRef}`);
      return;
    }

    await handleSwitch(pi, ctx, selectedRef);
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to open PR dashboard"), "error");
  }
}

async function handleWorkspace(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  try {
    const { config, lines } = await runWithLoader(ctx, "Loading workspace PRs...", async () => {
      const config = await loadConfig();
      if (config.workspaceRoots.length === 0) {
        return { config, lines: [] };
      }

      const lines: string[] = [
        `Workspace PRs · ${config.workspaceRoots.length} root${config.workspaceRoots.length === 1 ? "" : "s"}`,
        "",
      ];

      for (const root of config.workspaceRoots) {
        const listed = await listActivePrsForCurrentRepo(pi, root);
        const repoRoot = listed.snapshot.repo?.repoRoot ?? root;
        if (listed.snapshot.reason === "not-git") {
          lines.push(`${repoRoot} · not a git repository`);
          continue;
        }

        if (listed.snapshot.reason === "unsupported-remote") {
          lines.push(`${repoRoot} · unsupported remote`);
          continue;
        }

        if (listed.lookupError) {
          lines.push(`${repoRoot} · ${describeLookupError(listed.lookupError)}`);
          continue;
        }

        if (!listed.prs || listed.prs.length === 0) {
          lines.push(`${repoRoot} · no active PRs`);
          continue;
        }

        lines.push(
          `${repoRoot} · ${listed.prs.length} active PR${listed.prs.length === 1 ? "" : "s"}`
        );
        for (const pr of listed.prs) {
          const suffix = describePrActivity(pr, config);
          lines.push(`- ${pr.ref} ${pr.title}${suffix ? ` (${suffix})` : ""}`);
        }
        lines.push("");
      }

      return { config, lines };
    });

    if (config.workspaceRoots.length === 0) {
      notify(ctx, "No workspace roots are configured. Add `workspaceRoots` in /pr config edit.");
      return;
    }

    notify(ctx, lines.join("\n").trim());
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to load workspace PRs"), "error");
  }
}

async function handleConfig(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string
): Promise<void> {
  try {
    const request = parseConfigRequest(rawArgs);

    if (request) {
      await runConfigAction(pi, ctx, request.action, request.value);
      return;
    }

    if (!ctx.hasUI) {
      notify(ctx, buildConfigSummary(await loadConfig()));
      return;
    }

    await openConfigScreen(pi, ctx);
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to manage PR config"), "error");
  }
}

async function runConfigAction(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: ConfigAction,
  value?: string
): Promise<void> {
  switch (action) {
    case "edit":
      if (!ctx.hasUI) {
        notify(ctx, "`/pr config edit` requires interactive mode");
        return;
      }
      await editRawConfig(pi, ctx);
      return;
    case "show":
      notify(ctx, buildConfigSummary(await loadConfig()));
      return;
    case "statusbar":
      await setStatusBarVisibility(pi, ctx, value);
      return;
    case "footer":
      await setFooterStyle(pi, ctx, value);
      return;
    case "coverage":
      await setCoverageVisibility(pi, ctx, value);
      return;
    case "blockers":
      await setBlockerVisibility(pi, ctx, value);
  }
}

async function openConfigScreen(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  let currentConfig = await loadConfig();

  while (true) {
    const choice = await ctx.ui.select("PR settings", [
      `Footer · ${describeFooterSettings(currentConfig)}`,
      `Display · ${describeDisplaySettings(currentConfig)}`,
      `Review · ${describeReviewSettings(currentConfig)}`,
      `Workspace · ${describeWorkspaceSettings(currentConfig)}`,
      `Advanced · ${describeAdvancedSettings(currentConfig)}`,
      `GitHub provider · ${describeProviderSettings(currentConfig, "github")}`,
      `GitLab provider · ${describeProviderSettings(currentConfig, "gitlab")}`,
      "Show raw config",
      "Edit raw config",
    ]);
    if (!choice) {
      return;
    }

    if (choice.startsWith("Footer")) {
      currentConfig = await openFooterSettings(pi, ctx, currentConfig);
      continue;
    }

    if (choice.startsWith("Display")) {
      currentConfig = await openDisplaySettings(pi, ctx, currentConfig);
      continue;
    }

    if (choice.startsWith("Review")) {
      currentConfig = await openReviewSettings(pi, ctx, currentConfig);
      continue;
    }

    if (choice.startsWith("Workspace")) {
      currentConfig = await openWorkspaceSettings(pi, ctx, currentConfig);
      continue;
    }

    if (choice.startsWith("Advanced")) {
      currentConfig = await openAdvancedSettings(pi, ctx, currentConfig);
      continue;
    }

    if (choice.startsWith("GitHub provider")) {
      currentConfig = await openProviderSettings(pi, ctx, currentConfig, "github");
      continue;
    }

    if (choice.startsWith("GitLab provider")) {
      currentConfig = await openProviderSettings(pi, ctx, currentConfig, "gitlab");
      continue;
    }

    if (choice === "Show raw config") {
      notify(ctx, buildConfigSummary(currentConfig));
      continue;
    }

    await editRawConfig(pi, ctx);
    currentConfig = await loadConfig();
  }
}

async function openFooterSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: PrCompanionConfig
): Promise<PrCompanionConfig> {
  while (true) {
    const choice = await ctx.ui.select("Footer settings", [
      `Footer status · ${config.showStatusBar ? "shown" : "hidden"}`,
      `Footer format · ${config.statusBarStyle}`,
      `Coverage · ${config.showCoverageInStatusBar ? "shown" : "hidden"}`,
      `Blocker hints · ${config.showBlockerHintInStatusBar ? "shown" : "hidden"}`,
    ]);
    if (!choice) {
      return config;
    }

    if (choice.startsWith("Footer status")) {
      config = await saveConfigChange(
        pi,
        ctx,
        { ...config, showStatusBar: !config.showStatusBar },
        `Footer status ${!config.showStatusBar ? "shown" : "hidden"}.`
      );
      continue;
    }

    if (choice.startsWith("Footer format")) {
      const selected = await ctx.ui.select("Footer format", Object.values(FOOTER_STYLE_OPTIONS));
      if (!selected) {
        continue;
      }

      const nextStyle = getFooterStyleFromLabel(selected);
      if (!nextStyle) {
        continue;
      }

      config = await saveConfigChange(
        pi,
        ctx,
        { ...config, statusBarStyle: nextStyle },
        `Footer format set to ${nextStyle}.`
      );
      continue;
    }

    if (choice.startsWith("Coverage")) {
      config = await saveConfigChange(
        pi,
        ctx,
        { ...config, showCoverageInStatusBar: !config.showCoverageInStatusBar },
        `Coverage in footer ${!config.showCoverageInStatusBar ? "shown" : "hidden"}.`
      );
      continue;
    }

    config = await saveConfigChange(
      pi,
      ctx,
      { ...config, showBlockerHintInStatusBar: !config.showBlockerHintInStatusBar },
      `Footer blocker hints ${!config.showBlockerHintInStatusBar ? "shown" : "hidden"}.`
    );
  }
}

async function openDisplaySettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: PrCompanionConfig
): Promise<PrCompanionConfig> {
  while (true) {
    const choice = await ctx.ui.select("Display settings", [
      `Picker updated age · ${config.showUpdatedAgeInPickers ? "shown" : "hidden"}`,
      `Stale PR threshold · ${config.stalePrDays} day${config.stalePrDays === 1 ? "" : "s"}`,
    ]);
    if (!choice) {
      return config;
    }

    if (choice.startsWith("Picker updated age")) {
      config = await saveConfigChange(
        pi,
        ctx,
        { ...config, showUpdatedAgeInPickers: !config.showUpdatedAgeInPickers },
        `Picker updated age ${!config.showUpdatedAgeInPickers ? "shown" : "hidden"}.`
      );
      continue;
    }

    const stalePrDays = await promptPositiveInteger(
      ctx,
      "Stale PR threshold (days)",
      config.stalePrDays
    );
    if (stalePrDays === undefined) {
      continue;
    }
    if (stalePrDays === "invalid") {
      notify(ctx, "Stale PR threshold must be a positive number.", "error");
      continue;
    }

    config = await saveConfigChange(
      pi,
      ctx,
      { ...config, stalePrDays },
      `Stale PR threshold set to ${stalePrDays} day${stalePrDays === 1 ? "" : "s"}.`
    );
  }
}

/**
 * Ask for a positive integer. pi's TUI input does not render the placeholder,
 * so the current value goes in the title and an empty answer keeps it.
 * Returns undefined when cancelled or left empty.
 */
async function promptPositiveInteger(
  ctx: ExtensionCommandContext,
  title: string,
  current: number
): Promise<number | "invalid" | undefined> {
  const value = await ctx.ui.input(
    `${title} · current ${current} (empty keeps it)`,
    String(current)
  );
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return "invalid";
  }

  return parsed;
}

async function openReviewSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: PrCompanionConfig
): Promise<PrCompanionConfig> {
  while (true) {
    const choice = await ctx.ui.select("Review settings", [
      `Shared review instructions · ${config.sharedReviewInstructions ? "set" : "empty"}`,
      `Default review session mode · ${config.reviewSessionMode ? "on" : "off"}`,
    ]);
    if (!choice) {
      return config;
    }

    if (choice.startsWith("Shared review instructions")) {
      const edited = await ctx.ui.editor(
        "Shared review instructions",
        config.sharedReviewInstructions
      );
      if (edited === undefined) {
        continue;
      }

      config = await saveConfigChange(
        pi,
        ctx,
        { ...config, sharedReviewInstructions: edited.trim() },
        edited.trim() ? "Saved shared review instructions." : "Cleared shared review instructions."
      );
      continue;
    }

    config = await saveConfigChange(
      pi,
      ctx,
      { ...config, reviewSessionMode: !config.reviewSessionMode },
      `Default review session mode ${!config.reviewSessionMode ? "enabled" : "disabled"}.`
    );
  }
}

async function openWorkspaceSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: PrCompanionConfig
): Promise<PrCompanionConfig> {
  const edited = await ctx.ui.editor(
    "Workspace roots (one path per line)",
    config.workspaceRoots.join("\n")
  );
  if (edited === undefined) {
    return config;
  }

  const workspaceRoots = parseLineList(edited).map((item) => normalizePath(item));
  return saveConfigChange(
    pi,
    ctx,
    { ...config, workspaceRoots },
    `Saved ${workspaceRoots.length} workspace root${workspaceRoots.length === 1 ? "" : "s"}.`
  );
}

async function openAdvancedSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: PrCompanionConfig
): Promise<PrCompanionConfig> {
  const cacheTtlMs = await promptPositiveInteger(
    ctx,
    "Status cache TTL in milliseconds",
    config.cacheTtlMs
  );
  if (cacheTtlMs === undefined) {
    return config;
  }
  if (cacheTtlMs === "invalid") {
    notify(ctx, "Status cache TTL must be a positive number.", "error");
    return config;
  }

  return saveConfigChange(
    pi,
    ctx,
    { ...config, cacheTtlMs },
    `Status cache TTL set to ${cacheTtlMs}ms.`
  );
}

async function openProviderSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: PrCompanionConfig,
  kind: "github" | "gitlab"
): Promise<PrCompanionConfig> {
  while (true) {
    const provider = getProviderConfig(config, kind);
    if (!provider) {
      return config;
    }

    const choice = await ctx.ui.select(`${kind} provider settings`, [
      `Ignored branches · ${provider.ignoredBranches.join(", ") || "(none)"}`,
      `Show no-PR state · ${provider.showNoPrState ? "shown" : "hidden"}`,
      `Hosts · ${describeHosts(provider.hosts)}`,
    ]);
    if (!choice) {
      return config;
    }

    if (choice.startsWith("Ignored branches")) {
      const edited = await ctx.ui.editor(
        `${kind} ignored branches (one per line)`,
        provider.ignoredBranches.join("\n")
      );
      if (edited === undefined) {
        continue;
      }

      const ignoredBranches = parseLineList(edited);
      config = await saveConfigChange(
        pi,
        ctx,
        updateProviderConfig(config, kind, { ...provider, ignoredBranches }),
        `Saved ${kind} ignored branches.`
      );
      continue;
    }

    if (choice.startsWith("Show no-PR state")) {
      config = await saveConfigChange(
        pi,
        ctx,
        updateProviderConfig(config, kind, { ...provider, showNoPrState: !provider.showNoPrState }),
        `${kind} no-PR footer state ${!provider.showNoPrState ? "shown" : "hidden"}.`
      );
      continue;
    }

    const hosts = await editJsonObject(
      ctx,
      `${kind} hosts JSON`,
      JSON.stringify(provider.hosts, null, 2)
    );
    if (hosts === undefined) {
      continue;
    }

    config = await saveConfigChange(
      pi,
      ctx,
      normalizeConfig({
        ...config,
        providers: config.providers.map((item) => (item.kind === kind ? { ...item, hosts } : item)),
      } as Record<string, unknown>),
      `Saved ${kind} hosts.`
    );
  }
}

async function saveConfigChange(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: PrCompanionConfig,
  message: string
): Promise<PrCompanionConfig> {
  await saveConfigAndRefresh(pi, ctx, config);
  notify(ctx, `${message}\nConfig: ${getConfigPath()}`);
  return config;
}

function updateProviderConfig(
  config: PrCompanionConfig,
  kind: "github" | "gitlab",
  provider: ReturnType<typeof getProviderConfig>
): PrCompanionConfig {
  if (!provider) {
    return config;
  }

  return {
    ...config,
    providers: config.providers.map((item) => (item.kind === kind ? provider : item)),
  };
}

function parseLineList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function describeFooterSettings(config: PrCompanionConfig): string {
  return [
    config.showStatusBar ? "shown" : "hidden",
    config.statusBarStyle,
    config.showCoverageInStatusBar ? "coverage" : undefined,
    config.showBlockerHintInStatusBar ? "hints" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function describeDisplaySettings(config: PrCompanionConfig): string {
  return [
    config.showUpdatedAgeInPickers ? "age shown" : "age hidden",
    `stale ${config.stalePrDays}d`,
  ].join(" · ");
}

function describeReviewSettings(config: PrCompanionConfig): string {
  return [
    config.sharedReviewInstructions ? "instructions set" : "no instructions",
    config.reviewSessionMode ? "session default on" : "session default off",
  ].join(" · ");
}

function describeWorkspaceSettings(config: PrCompanionConfig): string {
  return `${config.workspaceRoots.length} root${config.workspaceRoots.length === 1 ? "" : "s"}`;
}

function describeAdvancedSettings(config: PrCompanionConfig): string {
  return `cache ${config.cacheTtlMs}ms`;
}

function describeProviderSettings(config: PrCompanionConfig, kind: "github" | "gitlab"): string {
  const provider = getProviderConfig(config, kind);
  if (!provider) {
    return "missing";
  }

  return [
    `${provider.ignoredBranches.length} ignored`,
    provider.showNoPrState ? "no-PR shown" : "no-PR hidden",
    describeHosts(provider.hosts),
  ].join(" · ");
}

function describeHosts(hosts: Record<string, { enabled?: boolean }>): string {
  const enabledHosts = Object.entries(hosts)
    .filter(([, value]) => value.enabled !== false)
    .map(([host]) => host);
  if (enabledHosts.length === 0) {
    return "all hosts";
  }

  return enabledHosts.join(", ");
}

async function editRawConfig(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const edited = await editJsonObject(
    ctx,
    "Edit pi-pr-companion config",
    await readEditableConfig()
  );
  if (edited === undefined) return;

  await saveConfigAndRefresh(pi, ctx, normalizeConfig(edited));
  notify(ctx, `Saved config to ${getConfigPath()}`);
}

/**
 * The config as editable JSON. When the file holds invalid JSON, edit its raw
 * text instead, so `/pr config edit` can repair it.
 */
async function readEditableConfig(): Promise<string> {
  try {
    return serializeConfig(await loadConfig());
  } catch (error) {
    const raw = await readFile(getConfigPath(), "utf8").catch(() => undefined);
    if (raw === undefined) throw error;
    return raw;
  }
}

/**
 * Open an editor until it holds a JSON object or is cancelled. Invalid input
 * is reported and shown again for fixing instead of aborting the settings flow.
 */
async function editJsonObject(
  ctx: ExtensionCommandContext,
  title: string,
  initialText: string
): Promise<Record<string, unknown> | undefined> {
  let text = initialText;
  while (true) {
    const edited = await ctx.ui.editor(title, text);
    if (edited === undefined) return undefined;

    try {
      const value = JSON.parse(edited) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
      notify(ctx, `${title}: expected a JSON object.`, "error");
    } catch (error) {
      notify(ctx, toErrorMessage(error, `${title}: invalid JSON`), "error");
    }
    text = edited;
  }
}

async function setStatusBarVisibility(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  value?: string
): Promise<void> {
  const config = await loadConfig();
  const nextValue = parseShownHiddenValue(value);
  if (value && !nextValue) {
    notify(ctx, "Footer status must be shown or hidden.", "error");
    return;
  }

  const result = setShowStatusBar(
    config,
    nextValue ? nextValue === SETTINGS_VALUE_SHOWN : !config.showStatusBar
  );
  await saveConfigAndRefresh(pi, ctx, result.config);
  notify(
    ctx,
    `Footer status ${result.config.showStatusBar ? "shown" : "hidden"}.\nConfig: ${getConfigPath()}`
  );
}

async function setFooterStyle(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  value?: string
): Promise<void> {
  const config = await loadConfig();

  if (!value) {
    if (!ctx.hasUI) {
      notify(
        ctx,
        [
          `Footer format: ${config.statusBarStyle}`,
          "Use `/pr config footer diff-prefix|diff-suffix|minimal` to change it.",
        ].join("\n")
      );
      return;
    }

    const selected = await ctx.ui.select("Footer format", Object.values(FOOTER_STYLE_OPTIONS));
    if (!selected) return;

    value = getFooterStyleFromLabel(selected);
  }

  if (!isStatusBarStyle(value)) {
    notify(ctx, "Footer format must be diff-prefix, diff-suffix, or minimal.", "error");
    return;
  }

  const result = setStatusBarStyle(config, value);
  await saveConfigAndRefresh(pi, ctx, result.config);
  notify(ctx, `Footer format set to ${value}.\nConfig: ${getConfigPath()}`);
}

async function setCoverageVisibility(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  value?: string
): Promise<void> {
  const config = await loadConfig();
  const nextValue = parseShownHiddenValue(value);
  if (value && !nextValue) {
    notify(ctx, "Coverage visibility must be shown or hidden.", "error");
    return;
  }

  const result = setShowCoverageInStatusBar(
    config,
    nextValue ? nextValue === SETTINGS_VALUE_SHOWN : !config.showCoverageInStatusBar
  );
  await saveConfigAndRefresh(pi, ctx, result.config);
  notify(
    ctx,
    `Coverage in footer ${result.config.showCoverageInStatusBar ? "shown" : "hidden"}.\nConfig: ${getConfigPath()}`
  );
}

async function setBlockerVisibility(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  value?: string
): Promise<void> {
  const config = await loadConfig();
  const nextValue = parseShownHiddenValue(value);
  if (value && !nextValue) {
    notify(ctx, "Footer blocker hints must be shown or hidden.", "error");
    return;
  }

  const result = setShowBlockerHintInStatusBar(
    config,
    nextValue ? nextValue === SETTINGS_VALUE_SHOWN : !config.showBlockerHintInStatusBar
  );
  await saveConfigAndRefresh(pi, ctx, result.config);
  notify(
    ctx,
    `Footer blocker hints ${result.config.showBlockerHintInStatusBar ? "shown" : "hidden"}.\nConfig: ${getConfigPath()}`
  );
}

async function saveConfigAndRefresh(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: PrCompanionConfig
): Promise<void> {
  await runWithLoader(ctx, "Saving PR settings...", async () => {
    await saveConfig(config);
    clearRepoStatusCache();
    const refreshed = await getRepoStatusSnapshot(pi, ctx.cwd, { force: true });
    applyStatusLine(ctx, refreshed);
  });
}

function applyStatusLine(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  snapshot: RepoStatusSnapshot
): void {
  if (!ctx.hasUI) return;

  if (!snapshot.config.showStatusBar) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const statusText = snapshot.result
    ? formatStatusText(snapshot.result, {
        theme: ctx.ui.theme,
        style: snapshot.config.statusBarStyle,
        showCoverage: snapshot.config.showCoverageInStatusBar,
        showBlockerHint: snapshot.config.showBlockerHintInStatusBar,
      })
    : undefined;
  ctx.ui.setStatus(STATUS_KEY, snapshot.hidden ? undefined : statusText);
}

function snapshotToResolvedContext(snapshot: RepoStatusSnapshot): ResolvedPrContext {
  const { reason, ...rest } = snapshot;
  // The footer hides "no PR"; the status message reports it.
  return { ...rest, reason: reason === "no-pr-hidden" ? "visible" : reason };
}

function buildResolvedPrStatusMessage(cwd: string, resolved: ResolvedPrContext): string {
  if (resolved.errorMessage) {
    return resolved.errorMessage;
  }

  if (!resolved.repo && !resolved.reference) {
    return "Current directory is not inside a git repository";
  }

  if (!resolved.provider) {
    if (resolved.reference?.kind === "url") {
      return `PR URL host is not recognized: ${resolved.reference.remote.host}`;
    }

    return [
      "Current repo remote is not recognized as GitHub or GitLab",
      resolved.repo ? `Repo: ${resolved.repo.repoRoot}` : `Cwd: ${cwd}`,
      `Config: ${getConfigPath()}`,
    ].join("\n");
  }

  if (!resolved.result) {
    return [
      resolved.repo ? `Repo: ${resolved.repo.repoRoot}` : `Cwd: ${cwd}`,
      `Provider: ${resolved.provider.kind}`,
      "PR: unavailable",
    ].join("\n");
  }

  if (resolved.result.kind !== "active") {
    return buildLookupResultMessage(resolved, resolved.result);
  }

  const pr = resolved.result.pr;
  return [
    resolved.repo ? `Repo: ${resolved.repo.repoRoot}` : undefined,
    `Provider: ${resolved.provider.kind}`,
    `PR: ${pr.ref}`,
    `Title: ${pr.title}`,
    `URL: ${pr.url}`,
    pr.state && pr.state !== "open" ? `State: ${pr.state}` : undefined,
    `Source branch: ${pr.sourceBranch}`,
    `Target branch: ${pr.targetBranch}`,
    `Draft: ${pr.draft ? "yes" : "no"}`,
    `Updated: ${pr.updatedAt}`,
    `Checks: ${formatCheckSummary(pr)}`,
    `Merge state: ${pr.detailedMergeStatus ?? "unknown"}`,
    `Threads: ${pr.threadSummary ? `${pr.threadSummary.unresolved} unresolved` : "unknown"}`,
    `Diff: ${pr.diffStats ? `+${pr.diffStats.additions} -${pr.diffStats.deletions}` : "unknown"}`,
    `Coverage: ${pr.coverage ?? "unknown"}`,
    `Approvals: ${formatApprovalSummary(pr)}`,
    buildReadinessMessage(pr),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildLookupResultMessage(resolved: ResolvedPrContext, result: PrLookupResult): string {
  switch (result.kind) {
    case "none":
      return resolved.reference
        ? `No PR found for ${resolved.reference.ref}`
        : "No active PR found";
    case "auth-error":
      return `${result.provider} auth/host issue:\n${result.message}`;
    case "unsupported":
      return result.message;
    case "error":
      return result.message;
    default:
      return "PR is unavailable";
  }
}

function buildReadinessMessage(pr: PrDetails): string {
  const readiness = pr.readiness ?? evaluatePrReadiness(pr);
  const lines = [`Readiness: ${readiness.verdict}`];

  if (readiness.blockers.length > 0) {
    lines.push(`Blockers: ${readiness.blockers.join(", ")}`);
  }
  if (readiness.warnings.length > 0) {
    lines.push(`Warnings: ${readiness.warnings.join(", ")}`);
  }
  if (readiness.recommendations.length > 0) {
    lines.push(`Recommendations: ${readiness.recommendations.join(" ")}`);
  }

  return lines.join("\n");
}

function buildChecksMessage(pr: PrDetails): string {
  const lines = [`PR: ${pr.ref}`, `Checks: ${formatCheckSummary(pr)}`];
  for (const item of pr.checkItems ?? []) {
    lines.push(`- ${item.status}: ${item.name}${item.details ? ` (${item.details})` : ""}`);
  }
  if ((pr.checkItems?.length ?? 0) === 0) {
    lines.push("- No detailed checks reported.");
  }
  return lines.join("\n");
}

function buildThreadsMessage(pr: PrDetails): string {
  const unresolved = pr.threadSummary?.unresolved ?? 0;
  const lines = [`PR: ${pr.ref}`, `Unresolved threads: ${unresolved}`];
  const threadItems = (pr.threadItems ?? []).filter((item) => !item.resolved);
  for (const item of threadItems) {
    lines.push(`- ${item.path ? `${item.path}: ` : ""}${item.body}`);
  }
  if (threadItems.length === 0) {
    lines.push("- None.");
  }
  return lines.join("\n");
}

function formatCheckSummary(pr: PrDetails): string {
  const summary = pr.checkSummary;
  if (!summary) {
    return pr.pipelineStatus ?? "unknown";
  }

  return `${summary.status} (${summary.successful} passed, ${summary.pending} pending, ${summary.failed} failed)`;
}

function formatApprovalSummary(pr: PrDetails): string {
  const summary = pr.approvalSummary;
  if (!summary) {
    return "unknown";
  }

  const parts = [summary.decision];
  if (typeof summary.approvedCount === "number") {
    parts.push(`${summary.approvedCount} approved`);
  }
  if (typeof summary.requestedChangesCount === "number") {
    parts.push(`${summary.requestedChangesCount} requested changes`);
  }
  return parts.filter(Boolean).join(", ") || "unknown";
}

function buildConfigSummary(config: PrCompanionConfig): string {
  return [`Config: ${getConfigPath()}`, "", serializeConfig(config)].join("\n");
}

function getActionGuardMessage(
  snapshot: RepoStatusSnapshot,
  result: PrLookupResult | undefined
): string | undefined {
  if (!snapshot.repo) {
    return "Current directory is not inside a git repository";
  }

  if (!snapshot.provider) {
    return "Current repo remote is not recognized as GitHub or GitLab.";
  }

  if (snapshot.reason === "ignored-branch") {
    return `Branch is ignored for PR status/active: ${snapshot.repo.branch}`;
  }

  if (!result) return undefined;

  switch (result.kind) {
    case "auth-error":
      return `${result.provider} auth/host issue:\n${result.message}`;
    case "unsupported":
      return result.message;
    case "error":
      return result.message;
    default:
      return undefined;
  }
}

function parseConfigRequest(rawArgs: string): { action: ConfigAction; value?: string } | undefined {
  const { name, rest } = parseSubcommand(rawArgs);
  if (!isConfigAction(name)) return undefined;
  return rest ? { action: name, value: rest.toLowerCase() } : { action: name };
}

function parseReviewRequest(rawArgs: string): {
  startSession: boolean;
  reference?: string;
  extra?: string;
} {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { startSession: false };
  }

  const startSession = trimmed === "session" || trimmed.startsWith("session ");
  const withoutMode = startSession ? trimmed.slice("session".length).trim() : trimmed;
  const extraIndex = withoutMode.indexOf("--extra");
  const reference = extraIndex >= 0 ? withoutMode.slice(0, extraIndex).trim() : withoutMode.trim();
  const extra =
    extraIndex >= 0 ? withoutMode.slice(extraIndex + "--extra".length).trim() : undefined;

  return {
    startSession,
    ...(reference ? { reference } : {}),
    ...(extra ? { extra } : {}),
  };
}

function getFooterStyleFromLabel(label: string): StatusBarStyle | undefined {
  const entry = Object.entries(FOOTER_STYLE_OPTIONS).find(([, value]) => value === label);
  const key = entry?.[0];
  return isStatusBarStyle(key) ? key : undefined;
}

function parseShownHiddenValue(
  value: string | undefined
): typeof SETTINGS_VALUE_SHOWN | typeof SETTINGS_VALUE_HIDDEN | undefined {
  if (value === SETTINGS_VALUE_SHOWN || value === SETTINGS_VALUE_HIDDEN) {
    return value;
  }

  return undefined;
}

function isConfigAction(value: string | undefined): value is ConfigAction {
  return (
    value === "edit" ||
    value === "show" ||
    value === "statusbar" ||
    value === "footer" ||
    value === "coverage" ||
    value === "blockers"
  );
}

function isStatusBarStyle(value: string | undefined): value is StatusBarStyle {
  return value === "minimal" || value === "diff-prefix" || value === "diff-suffix";
}

async function ensureSwitchAllowed(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repoRoot: string
): Promise<boolean> {
  if (!(await hasDirtyWorktree(pi, repoRoot))) {
    return true;
  }

  if (!ctx.hasUI) {
    notify(ctx, `Dirty worktree: ${repoRoot}`, "error");
    return false;
  }

  const confirmed = await ctx.ui.confirm(
    "Dirty worktree",
    `You have uncommitted changes in ${repoRoot}. Switch branches anyway?`
  );
  if (!confirmed) {
    notify(ctx, "Branch switch cancelled.", "info");
    return false;
  }

  return true;
}

function requireActivePrResult(resolved: ResolvedPrContext): PrLookupResult {
  return (
    resolved.result ?? {
      kind: "error",
      provider: resolved.provider?.kind ?? "gitlab",
      message: resolved.errorMessage ?? "PR lookup failed",
    }
  );
}

async function buildToolPrContextPayload(cwd: string, resolved: ResolvedPrContext) {
  const config = resolved.config;
  const guidelinesCwd = getLocalReviewGuidelinesCwd(resolved);
  const guidelines = guidelinesCwd ? await findProjectReviewGuidelines(guidelinesCwd) : undefined;

  return {
    cwd,
    repoRoot: resolved.repo?.repoRoot,
    provider: resolved.provider?.kind,
    remote: resolved.repo?.remote,
    reference: resolved.reference,
    result: resolved.result,
    error: getResolvedPrErrorMessage(resolved),
    sharedReviewInstructions: config.sharedReviewInstructions || undefined,
    reviewSessionMode: config.reviewSessionMode,
    projectReviewGuidelinesPath: guidelines?.path,
    projectReviewGuidelines: guidelines?.content,
  };
}

function getLocalReviewGuidelinesCwd(resolved: ResolvedPrContext): string | undefined {
  if (!resolved.repo) {
    return undefined;
  }

  if (!resolved.reference || resolved.reference.kind === "ref") {
    return resolved.repo.cwd;
  }

  return resolved.repo.remote.repoRef === resolved.reference.remote.repoRef
    ? resolved.repo.cwd
    : undefined;
}

function buildPrSelectorTitle(title: string, count: number): string {
  return `${title} · ${count} open PR${count === 1 ? "" : "s"}`;
}

async function openPrSelector(
  ctx: ExtensionCommandContext,
  title: string,
  prs: PrSummary[],
  config: PrCompanionConfig
): Promise<string | undefined> {
  const items: SelectItem[] = prs.map((pr) => ({
    value: pr.ref,
    label: formatPickerEntry(pr, config),
    description: describePrActivity(pr, config),
  }));

  // Custom components only render in the TUI. RPC clients get the standard
  // select dialog, which they can forward.
  if (ctx.mode !== "tui") {
    const labels = items.map((item) =>
      item.description ? `${item.label} · ${item.description}` : item.label
    );
    const choice = await ctx.ui.select(title, labels);
    return choice === undefined ? undefined : items[labels.indexOf(choice)]?.value;
  }

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(undefined);
    container.addChild(selectList);
    container.addChild(
      new Text(
        [
          rawKeyHint("↑↓", "navigate"),
          keyHint("tui.select.confirm", "select"),
          keyHint("tui.select.cancel", "cancel"),
        ].join("  "),
        1,
        0
      )
    );
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render(width: number): string[] {
        return container.render(width);
      },
      invalidate(): void {
        container.invalidate();
      },
      handleInput(data: string): void {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

async function returnToReviewOrigin(
  ctx: ExtensionCommandContext,
  originId: string,
  customInstructions?: string
): Promise<boolean> {
  try {
    const result = await ctx.navigateTree(originId, {
      summarize: Boolean(customInstructions),
      ...(customInstructions
        ? {
            customInstructions,
            replaceInstructions: true,
          }
        : {}),
    });
    if (result.cancelled) {
      notify(ctx, "Navigation cancelled. Use /pr end-review to try again.", "info");
      return false;
    }

    return true;
  } catch (error) {
    notify(ctx, toErrorMessage(error, "Failed to return from review session"), "error");
    return false;
  }
}

async function selectEndReviewAction(
  ctx: ExtensionCommandContext
): Promise<EndReviewAction | undefined> {
  if (!ctx.hasUI) {
    return "return";
  }

  const choice = await ctx.ui.select(
    "End review session",
    END_REVIEW_CHOICES.map((item) => item.label)
  );
  return END_REVIEW_CHOICES.find((item) => item.label === choice)?.action;
}

function parseEndReviewAction(rawArgs: string): EndReviewAction | "invalid" | undefined {
  const normalized = rawArgs.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "return":
    case "back":
      return "return";
    case "summary":
    case "summarize":
      return "summary";
    case "comments":
    case "comment":
    case "review-comments":
      return "comments";
    case "queue":
    case "fixes":
    case "fix-queue":
      return "queue";
    default:
      return "invalid";
  }
}

function buildEndReviewPrompt(
  action: EndReviewAction,
  state: ReviewSessionState
): string | undefined {
  switch (action) {
    case "return":
      return undefined;
    case "summary":
      return buildReviewSummaryPrompt(state);
    case "comments":
      return buildReviewCommentsPrompt(state);
    case "queue":
      return buildReviewQueuePrompt(state);
  }
}

function buildEndReviewSuccessMessage(action: EndReviewAction): string {
  switch (action) {
    case "return":
      return "Ended review session.";
    case "summary":
      return "Ended review session with a summary.";
    case "comments":
      return "Ended review session with PR review comments.";
    case "queue":
      return "Ended review session with a fix queue.";
  }
}

function buildStructuredReviewFormatLines(state: ReviewSessionState): string[] {
  return [
    `PR: ${state.pr?.url ?? "<url>"}`,
    "Changelog:",
    "- Summarize the change set in a few bullets",
    "Bad:",
    "- Concrete bugs, regressions, missing validation, weak tests, or operational risks",
    "- None.",
    "Ugly:",
    "- Subtle, architectural, high-blast-radius, or easy-to-miss problems",
    "- None.",
    "Good:",
    "- Solid choices, simplifications, safeguards, or useful tests",
    "Questions or Assumptions:",
    "- Unknowns, assumptions, or clarifications needed",
    "Change summary:",
    "- Merge-readiness: <Ready | Needs changes | Blocked>",
    "- Concise summary of what changed and what matters most",
    "Tests:",
    "- Observed:",
    "  - ...",
    "- Missing / recommended:",
    "  - ...",
  ];
}

function buildReviewSummaryPrompt(state: ReviewSessionState): string {
  return [
    `Summarize the completed review session for ${state.pr?.ref ?? "the PR"}.`,
    "Keep Bad and Ugly ordered by impact. Mention files, functions, tests, or behaviors when possible.",
    "Use this structure:",
    ...buildStructuredReviewFormatLines(state),
  ].join("\n");
}

function buildReviewCommentsPrompt(state: ReviewSessionState): string {
  return [
    `Draft PR review comments for ${state.pr?.ref ?? "the PR"} that I can paste into someone else's PR.`,
    "Use this structure:",
    "Suggested review verdict:",
    "- <Approve | Request changes | Comment only>",
    "Overall PR comment:",
    "- A short ready-to-paste summary comment for the main PR conversation",
    "Inline review comments:",
    "- One ready-to-paste comment per concrete issue or risk",
    "- None.",
    "Questions / clarifications:",
    "- Open questions worth asking on the PR",
    "- None.",
    "Notes:",
    "- Base comments on the strongest Bad and Ugly findings first",
    "- Keep each comment concrete, polite, and easy to paste as-is",
    "- Mention files, functions, endpoints, tests, or behaviors when possible",
    "- Do not claim you authored changes or ran commands",
  ].join("\n");
}

function buildReviewQueuePrompt(state: ReviewSessionState): string {
  return [
    `Turn the completed review session for ${state.pr?.ref ?? "the PR"} into an actionable fix plan.`,
    "Keep the review format first, then add a fix queue.",
    "Use this structure:",
    ...buildStructuredReviewFormatLines(state),
    "Fix queue:",
    "- One concrete task per item",
    "Suggested execution order:",
    "- 1. ...",
  ].join("\n");
}

function describeLookupError(result: PrLookupResult): string {
  switch (result.kind) {
    case "auth-error":
    case "unsupported":
    case "error":
      return result.message;
    case "none":
      return "no active PRs";
    case "active":
      return result.pr.ref;
  }
}

/**
 * Run a tool's git/gh/glab calls with its abort signal, so cancelling the
 * tool stops them instead of waiting for each call to finish or time out.
 */
function bindAbortSignal(pi: ExecApi, signal: AbortSignal | undefined): ExecApi {
  if (!signal) return pi;

  return {
    exec: async (command, args, options) => {
      signal.throwIfAborted();
      const result = await pi.exec(command, args, { ...options, signal });
      signal.throwIfAborted();
      return result;
    },
  };
}

function resolveToolCwd(baseCwd: string, value: string | undefined): string {
  if (!value?.trim()) {
    return baseCwd;
  }

  const normalized = value.startsWith("@") ? value.slice(1).trim() : value.trim();
  return path.resolve(baseCwd, normalized);
}

type LoaderResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function runWithLoader<T>(
  ctx: Pick<ExtensionCommandContext, "mode" | "ui">,
  message: string,
  task: () => Promise<T>
): Promise<T> {
  // ctx.ui.custom() resolves to undefined without rendering outside the TUI
  // (RPC included), so only show the loader there.
  if (ctx.mode !== "tui") {
    return task();
  }

  const result = await ctx.ui.custom<LoaderResult<T> | undefined>(
    (tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, message, { cancellable: false });
      void task()
        .then((value) => done({ ok: true, value }))
        .catch((error: unknown) => done({ ok: false, error }));
      return loader;
    }
  );

  if (!result) {
    throw new Error(`${message} did not complete`);
  }

  if (!result.ok) {
    throw result.error;
  }

  return result.value;
}

function notify(
  ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">,
  message: string,
  level: "info" | "warning" | "error" = "info"
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else if (ctx.mode === "json") {
    // stdout carries the JSON event stream in json mode.
    console.error(message);
  } else {
    console.log(message);
  }
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}: ${error.message}` : fallback;
}
