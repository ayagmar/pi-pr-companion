# pi-pr-companion

PR help inside Pi.

It gives you:

- `/pr` commands for common pull request work
- `/review-pr` for focused PR reviews
- a small PR footer for the current repo
- review sessions so you can inspect first and return later with a summary

Supports:

- GitHub via `gh`
- GitLab via `glab`
- configured self-hosted GitHub / GitLab hosts

## Requirements

- Pi
- `gh` for GitHub repos
- `glab` for GitLab repos
- authenticated CLI access to the host you want to use

## Install

After publishing:

```bash
pi install npm:pi-pr-companion
```

For local development:

```bash
pnpm install
pi -e ./src/index.ts --prompt-template ./prompts/review-pr.md
```

## Quick start

Inside a repo:

```text
/pr
```

Most useful commands:

```text
/pr status
/pr review
/pr review session
/pr end-review
/pr active
/pr dashboard
/pr switch <ref|url>
```

## Commands

```text
/pr
/pr status [ref|url]
/pr review [ref|url] [--extra <notes>]
/pr review session [ref|url] [--extra <notes>]
/pr end-review [return|summary|comments|queue]
/pr switch <ref|url>
/pr ready [ref|url]
/pr checks [ref|url]
/pr threads [ref|url]
/pr active
/pr dashboard
/pr workspace
/pr refresh
/pr config
```

## PR references

Commands accept:

- GitHub PR URL
- GitLab MR URL
- `#123`
- `!123`

Rules:

- `#123` resolves in the current GitHub repo
- `!123` resolves in the current GitLab repo
- URLs can point at another repo
- branch switching only works when the PR belongs to the current repo

## What each command is for

### `/pr status`

Shows the PR title, branches, checks, merge state, threads, diff size, coverage, approvals, and readiness.

### `/pr review`

Starts a PR review through `/review-pr`.

Use `--extra` when you want a custom focus:

```text
/pr review --extra focus on auth, migrations, and missing tests
```

### `/pr review session`

Starts a review session, keeps a visible reminder in Pi, and lets you return later.

### `/pr end-review`

Ends the current review session.

You can:

- return only
- return with a review summary
- return with ready-to-paste review comments
- return with a fix queue

### `/pr switch`

Switches to the PR branch.

Behavior:

- blocked when the PR is outside the current repo
- blocked on dirty worktrees in non-interactive use
- asks before switching in interactive use if the worktree is dirty

### `/pr ready`

Gives a simple verdict:

- `ready`
- `needs-changes`
- `blocked`

### `/pr checks`

Shows check status with failing and pending items.

### `/pr threads`

Shows unresolved discussion threads.

### `/pr active`

Shows active PRs for the current repo and lets you switch.

### `/pr dashboard`

Shows the current repo’s open PRs with quick actions.

### `/pr workspace`

Shows PRs across repos you listed in `workspaceRoots`.

## Review flow

`/review-pr` is tool-first.

That means it pulls PR data through this extension first, then uses normal Pi tools for local inspection when needed.

The review output uses this shape:

- `Changelog`
- `Bad`
- `Ugly`
- `Good`
- `Questions or Assumptions`
- `Change summary`
- `Tests`

## Footer

The footer shows the current PR for the current branch when it can be resolved.

Examples:

- `+12 -4 PR !53 ✓`
- `PR #42 … checks`
- `PR !19 ! conflicts`

You can change:

- shown / hidden
- footer format
- coverage shown / hidden
- blocker hints shown / hidden
- updated age shown / hidden
- stale PR threshold

## Config

Open settings in Pi:

```text
/pr config
```

Useful direct commands:

```text
/pr config show
/pr config edit
/pr config statusbar [shown|hidden]
/pr config footer [diff-prefix|diff-suffix|minimal]
/pr config coverage [shown|hidden]
/pr config blockers [shown|hidden]
```

Config file location:

```text
$PI_PR_COMPANION_CONFIG
# or:
$PI_CODING_AGENT_DIR/pi-pr-companion-settings.json
# or:
~/.pi/agent/pi-pr-companion-settings.json
```

Example:

```json
{
  "cacheTtlMs": 15000,
  "showStatusBar": true,
  "statusBarStyle": "diff-prefix",
  "showCoverageInStatusBar": false,
  "showBlockerHintInStatusBar": true,
  "showUpdatedAgeInPickers": true,
  "stalePrDays": 7,
  "workspaceRoots": ["~/Projects/service-a", "~/Projects/service-b"],
  "sharedReviewInstructions": "Focus on API contracts, migrations, and missing tests.",
  "reviewSessionMode": false,
  "providers": [
    {
      "kind": "gitlab",
      "ignoredBranches": ["main", "master"],
      "showNoPrState": false,
      "hosts": {
        "gitlab.example.com": { "enabled": true }
      }
    },
    {
      "kind": "github",
      "ignoredBranches": ["main", "master"],
      "showNoPrState": false,
      "hosts": {
        "github.com": { "enabled": true },
        "code.example.com": { "enabled": true }
      }
    }
  ]
}
```

## Self-hosted hosts

Enable hosts under the matching provider:

```json
{
  "providers": [
    {
      "kind": "github",
      "hosts": {
        "code.example.com": { "enabled": true }
      }
    }
  ]
}
```

or:

```json
{
  "providers": [
    {
      "kind": "gitlab",
      "hosts": {
        "gitlab.company.internal": { "enabled": true }
      }
    }
  ]
}
```

## Provider support

| Capability            | GitHub           | GitLab           |
| --------------------- | ---------------- | ---------------- |
| Current PR by branch  | Yes              | Yes              |
| PR by `#123` / `!123` | Yes              | Yes              |
| PR by URL             | Yes              | Yes              |
| Active PR listing     | Yes              | Yes              |
| Checks summary        | Yes              | Yes              |
| Thread summary        | Yes              | Yes              |
| Approval summary      | Yes              | Yes              |
| Non-`origin` remotes  | Yes              | Yes              |
| Self-hosted hosts     | Configured hosts | Configured hosts |

## Development

```bash
pnpm check
```

## Release

Local release commands:

```bash
pnpm run release:patch
pnpm run release:minor
pnpm run release:major
```

GitHub Actions also includes a manual `Release` workflow.

For npm publishing, set `NPM_TOKEN` in the repository secrets.
