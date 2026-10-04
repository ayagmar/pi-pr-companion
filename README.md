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

- Pi 1.0.1 or newer (`@earendil-works/pi-coding-agent`)
- Node.js 22.19.0 or newer
- `gh` for GitHub repos
- `glab` for GitLab repos
- authenticated CLI access to the host you want to use

## Install

```bash
pi install npm:pi-pr-companion
```

Or straight from GitHub:

```bash
pi install git:github.com/ayagmar/pi-pr-companion
```

Update later with `pi update npm:pi-pr-companion` (or `pi update --extensions` for all packages); a bare `pi update` only updates pi itself.

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
- URLs copied from a PR tab (`/files`, `/commits`, `/checks`, `/diffs`) work too
- `#123`, `!123` and URLs also work on a detached HEAD
- branch switching only works when the PR belongs to the current repo and its branch is not in a fork

## What each command is for

### `/pr status`

Shows the PR title, branches, checks, merge state, threads, diff size, coverage, approvals, and readiness. Merged and closed PRs show their state and are never reported as ready. If threads, approvals or diff stats cannot be fetched, they show as unknown and the rest of the status is still shown.

### `/pr review`

Starts a PR review through `/review-pr`.

Use `--extra` when you want a custom focus:

```text
/pr review --extra focus on auth, migrations, and missing tests
```

If Pi is still working on something, the review is queued as a follow-up and starts when the current run finishes.

### `/pr review session`

Starts a review session, keeps a visible reminder in Pi, and lets you return later.

A review session starts from where the conversation is now, so wait for Pi to finish its current run first. `/pr review session` asks you to wait instead of starting while Pi is busy.

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
- blocked when the PR comes from a fork, since its branch is not on this remote
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

## Modes

Everything works in Pi's interactive TUI. In RPC mode, `/pr` commands use the standard dialogs (select, confirm, input, editor), so the PR pickers become plain select lists and there is no loading spinner. In print and JSON modes, commands that need a picker or editor ask you to use interactive mode, and the others print their result (to stderr in JSON mode).

The footer refreshes in the background when a session starts and after each agent run settles, so slow `gh`/`glab` calls never delay startup.

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

Enable hosts under the matching provider. Host names are matched case-insensitively. A host listed under one provider takes precedence over the `github`/`gitlab` name guess:

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

## Releasing

Releases are cut from GitHub Actions — never from a laptop.

1. Merge Conventional Commits (`feat:`, `fix:`, `feat!:` …) into `master`.
2. Run **Actions → Release → Run workflow** (or `gh workflow run release.yml -f increment=auto`).
   `auto` derives the bump from the commits; pick `patch`/`minor`/`major` to override. Tick `dry_run` to preview.
3. The workflow runs `pnpm run check`, then release-it bumps `package.json`, updates `CHANGELOG.md`,
   tags `vX.Y.Z`, pushes and creates the GitHub release, and finally `npm publish` publishes with
   provenance through npm trusted publishing (OIDC — no npm token stored in the repo).

Preview locally with `pnpm release:dry`.

The first publish of a new package cannot use trusted publishing yet (the package must exist on npm
first): run the workflow once with `bootstrap: true` and a short-lived, publish-only `NPM_TOKEN`
repository secret, then configure trusted publishing on npmjs.com (GitHub Actions · repo · workflow
`release.yml`) and delete the secret. If a run already tagged and created the GitHub release but
failed at `npm publish`, re-run it with `publish_only: true` (plus `bootstrap: true` for that first
publish) instead of cutting a new version.

With no release tag yet, `auto` treats the whole history as unreleased, so the `feat!` commit makes
the first release 1.0.0. Pick `minor` instead to start at 0.2.0.
