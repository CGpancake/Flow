# Validation Strategy

## Local validation first

Project Flow is validated project-locally before global installation. Set `PI_PROJECT_FLOW_VALIDATION_CWD` when you want validation commands to refuse running outside a dedicated test project; otherwise they validate the current project.

## Commands

- `/pf-doctor` — capability/state diagnosis.
- `/pf-self-validate` — non-mutating Project Flow checks.
- `/pf-self-validate build` — confined worker write test under `.pi/project-flow/self-test/`.
- `/pf-e2e` — confined lifecycle E2E through plan, worker, validation, and completion.
- `node .pi/project-flow/self-validate.mjs` — headless invariant loop.

## Safety boundaries

Self-validation cleans only:

```text
.pi/project-flow/self-test/
```

It must not delete project memory, plans, sessions, or implementation files.

## Evidence expected before user acceptance

- No old private Project Flow package dependency/reference.
- No vendored subagents.
- No private `subagents:rpc:*` events.
- `.pi/project-flow/*` paths are used consistently.
- `/plan` creates/resumes Project Flow state.
- Planning is read-only until build approval.
- Grill questions appear for true blockers.
- The planner performs a potential-plan blocker sweep, asks queued blockers one concise ambiguity at a time without merging independent blockers, and re-sweeps after each grill cycle.
- Answered grill rounds are persisted, reconsidered before plan save, and summarized via `blockerAnalysisSummary` and `grillResolutionSummary`.
- Plan review appears before build choices.
- Build uses AgentAdapter or blocks clearly.
- `/doc` can produce a docs/memory reconciliation report.

## Runtime evidence

Validation history is kept in:

```text
.pi/project-flow/memory/validation.md
.pi/project-flow/sessions/*self-validation*.md
.pi/project-flow/sessions/*e2e*.md
```

## Future validation work

The current validation route is local/headless through `/pf-self-validate`, `/pf-e2e`, and `self-validate.mjs`, optionally restricted by `PI_PROJECT_FLOW_VALIDATION_CWD`. A more robust headless harness should eventually replace ad-hoc live project validation.
