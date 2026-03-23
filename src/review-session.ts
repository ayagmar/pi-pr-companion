import {
  REVIEW_SESSION_ANCHOR_TYPE,
  REVIEW_SESSION_STATE_TYPE,
  REVIEW_WIDGET_KEY,
} from "./constants.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { ReviewSessionState } from "./types.js";

export function getReviewSessionState(ctx: ExtensionContext): ReviewSessionState | undefined {
  let state: ReviewSessionState | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === REVIEW_SESSION_STATE_TYPE) {
      state = entry.data as ReviewSessionState | undefined;
    }
  }

  return state;
}

export function applyReviewSessionState(ctx: ExtensionContext): void {
  const state = getReviewSessionState(ctx);
  setReviewWidget(ctx, state?.active === true ? state : undefined);
}

export function startReviewSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: Omit<ReviewSessionState, "originId">
): ReviewSessionState | undefined {
  let originId = ctx.sessionManager.getLeafId() ?? undefined;
  if (!originId) {
    pi.appendEntry(REVIEW_SESSION_ANCHOR_TYPE, {
      createdAt: new Date().toISOString(),
    });
    originId = ctx.sessionManager.getLeafId() ?? undefined;
  }

  if (!originId) {
    return undefined;
  }

  const nextState = { ...state, originId };
  pi.appendEntry(REVIEW_SESSION_STATE_TYPE, nextState);
  setReviewWidget(ctx, nextState);
  return nextState;
}

export function endReviewSession(pi: ExtensionAPI, ctx: ExtensionContext): void {
  pi.appendEntry(REVIEW_SESSION_STATE_TYPE, {
    active: false,
    startedAt: new Date().toISOString(),
  });
  setReviewWidget(ctx, undefined);
}

function setReviewWidget(ctx: ExtensionContext, state: ReviewSessionState | undefined): void {
  if (!ctx.hasUI) return;

  if (!state?.active || !state.pr) {
    ctx.ui.setWidget(REVIEW_WIDGET_KEY, undefined);
    return;
  }

  const reviewPr = state.pr;
  ctx.ui.setWidget(REVIEW_WIDGET_KEY, (_tui, theme) => ({
    render(width: number): string[] {
      const message = `Review session active · ${reviewPr.ref} · /pr end-review`;
      return [truncateToWidth(theme.fg("warning", message), width)];
    },
    invalidate: () => undefined,
  }));
}
