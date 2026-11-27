# lean-flow

Lean pi workflow extension.

Includes:

- `/grill` and `grill_batch`
- `/plan` and `save_plan`; `/plan-add` extends the current plan and `/plan-clear` erases it
- `/work`, `/review`, and embedded worker/reviewer subagents via `lean_subagent_chain`
- `/handover`
- `/issue` and `record_issue` (stored in `cwd/.pi/issues`)

Project-local copy layout:

```text
lean-flow-plan.ts
tests/lean-flow.plan.test.ts
.pi/extensions/lean-flow.ts
.pi/extensions/issues.ts
.pi/extensions/herdr-lean.ts
```

Plan editing:

- `/plan-add <scope>` — adds steps to the existing plan while keeping current steps unchanged; falls back to `/plan` when no plan exists.
- `/plan-clear` — erases the branch plan (`plan.md` plus its progress snapshot); refuses while `/work` is running, so run `/work cancel` first.

## Herdr integration

`.pi/extensions/herdr-lean.ts` reports lean chain progress to Herdr panes only when `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` are all set; otherwise it stays inert.

That metadata is presentation-only (pane title, display agent, state labels, tokens). Herdr's `herdr:pi` integration keeps lifecycle authority — idle/working/blocked state and session restore. The herdr-managed `herdr-agent-state.ts` is never committed to this repo.

Git package install:

```bash
pi install git:github.com/CGpancake/Flow
```
