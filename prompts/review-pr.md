---
description: Deep-review the active PR or a provided PR URL/reference using pi-pr-companion tools
---

Deep-review the pull request.

Input:

- PR reference: $1
- Extra args: ${@:2}

Process:

1. Call `get_pr_context` first.
   - If `$1` is present, pass it as `reference`.
   - Otherwise resolve the current PR for the current repo/branch.
2. If the tool reports an error or no PR, stop and explain the issue clearly.
3. Use the returned PR context as the primary source of truth for:
   - provider and repo
   - PR metadata
   - checks
   - merge state
   - diff stats
   - coverage
   - unresolved threads
   - approvals
   - readiness
   - shared review instructions
   - project review guidelines
4. Treat shared review instructions and project review guidelines as active review constraints.
5. If local file inspection will materially improve the review and the PR belongs to the current repo, you may call `switch_pr_branch` to inspect the PR branch locally.
6. Before concluding, inspect impacted local files and nearby tests. After local switching when needed, use normal Pi tools to inspect the changed code and relevant coverage.
7. Focus on correctness, regressions, contract changes, missing validation, risky assumptions, data flow, auth/security, edge cases, and test coverage.
8. Prioritize findings by impact, not by file order.
9. Be concrete. Mention affected files, functions, endpoints, tests, or behaviors when possible.
10. If something is unclear, state it under Questions or Assumptions instead of guessing.
11. If no issues are found, explicitly write `- None.` under `Bad` and `Ugly`.
12. In `Tests`, distinguish:
    - checks or tests you observed
    - tests still missing or worth adding
13. In `Change summary`, start with merge readiness as:
    - `Ready`
    - `Needs changes`
    - `Blocked`
14. Use the structured review format below. Put concrete issues in `Bad`, subtle/high-blast-radius risks in `Ugly`, and keep both ordered by impact.

Output format per PR:

```text
PR: <url>
Changelog:
- Summarize the change set in a few bullets
Bad:
- Concrete bugs, regressions, missing validation, weak tests, or operational risks
- None.
Ugly:
- Subtle, architectural, high-blast-radius, or easy-to-miss problems
- None.
Good:
- Solid choices, simplifications, safeguards, or useful tests
Questions or Assumptions:
- Unknowns, assumptions, or clarifications needed
Change summary:
- Merge-readiness: <Ready | Needs changes | Blocked>
- Concise summary of what changed and what matters most
Tests:
- Observed:
  - ...
- Missing / recommended:
  - ...
```
