# Project Flow Specification

## Goal

Provide one project-local workflow owner where work normally starts with `/plan`, planning produces a reviewed written plan, and building starts only after the user chooses an explicit post-plan build option.

## Non-goals

- Do not expose `/build` as the normal user-facing entry point.
- Do not let independent modules or external capability packages mutate lifecycle state.
- Do not require live web or MCP access in the parent session.
- Do not require large startup prompts.
- Do not ask user questions before inspecting relevant local context.
- Do not write implementation files during planning.
- Do not let subagents silently fall back to parent execution when a fresh worker was requested.

## Core concepts

- **Core**: the only lifecycle owner.
- **Plan**: persisted markdown under `.pi/project-flow/plans/` with frontmatter, decisions, assumptions, slices, validation, and status.
- **Slice**: independently verifiable build work with declared ownership and validation.
- **Planning**: read-only context inspection, grilling, research if needed, and plan writing.
- **Grill question**: one concise blocking ambiguity asked after relevant inspection, with a recommendation, alternatives, default assumption, and additional-context capture.
- **Approval gate**: post-plan TUI choice that authorizes build or returns to planning.
- **Validation**: automatic/manual checks attached to the plan and build evidence.
- **Memory**: concise project-local files under `.pi/project-flow/memory/`, loaded shallow-first and searched on demand.
- **Capability adapter**: Project Flow-owned wrapper around external packages such as `pi-web-access` or `pi-subagents`.

## Commands

### `/plan <task>`

Starts a new lifecycle:

1. Creates active session state under `.pi/project-flow/sessions/`.
2. Loads only compact memory index/pointers.
3. Inspects local files shallow-first using Project Flow reading tools.
4. Uses web research only when current external facts materially affect the plan.
5. Uses `project_flow_grill_cycle` for multiple known current-cycle blockers, or `project_flow_grill_question` for one concise blocking ambiguity, queued rather than merged.
6. Saves blocked/draft plans when blockers remain; saves build-ready plans only when no blockers remain.
7. Shows the plan before post-plan choices.

### `/plan-continue`

Resumes active Project Flow session state. It must not infer a task from an unrelated latest plan. If no active session exists, it tells the user to start with `/plan <task>`.

### `/doc`

Runs documentation/memory reconciliation after build. It compares plan intent, implementation evidence, changed files, memory, and ADRs; it applies only warranted updates.

### `/pf-doctor`

Reports paths, lifecycle state, active/latest session, plan lookup, ResearchAdapter status, AgentAdapter status, old-package risks, and active tools.

### `/pf-self-validate` and `/pf-self-validate build`

Project-local validation helpers. Set `PI_PROJECT_FLOW_VALIDATION_CWD` to restrict them to a specific validation project; otherwise they validate the current project. They clean only `.pi/project-flow/self-test/`.

### `/pf-e2e`

Confined lifecycle E2E for the configured validation project (`PI_PROJECT_FLOW_VALIDATION_CWD`, or the current project if unset). It writes a test plan, starts a foreground worker through the AgentAdapter, validates artifact content, and records completion.

### `/reload-flow`

Temporary developer helper. Copies Project Flow extension/support files from `PI_PROJECT_FLOW_DEV_ROOT` (or the current project when unset) into the current project without touching `.pi/project-flow/memory/`, `.pi/project-flow/plans/`, or `.pi/project-flow/sessions/`.

## Lifecycle states

Current public states:

```text
idle
planning
blocked
plan_ready
build_requested
building
validating
docs
complete
failed
```

Only Project Flow core may change lifecycle state. Tools and adapters report evidence or blockers.

## Plan contract

A build-ready plan should include:

- YAML frontmatter with status, creation time, and title/task.
- Goal and scope.
- Local context evidence.
- Research notes if research was used.
- Decisions and assumptions.
- No unresolved blocking questions.
- Slices/milestones with file ownership.
- Automatic validation commands or reason none exist.
- Manual validation steps when automation cannot prove behavior.
- Risks and non-goals.

Plan statuses:

- `draft`: still planning.
- `blocked`: waiting on one or more answers/approvals.
- `build-ready`: ready for user review and build choice.
- `building`, `validating`, `complete`, `failed`: lifecycle/result statuses.

## Grill/question contract

Each blocking question must include:

- one concise question for one blocking ambiguity;
- why it blocks a build-ready plan;
- one recommended answer first;
- meaningful alternatives;
- a default assumption;
- a way to type additional context while choosing;
- persisted answer context plus deterministic blocker/cycle metadata for resume;
- an initial potential-plan blocker sweep that forms a blocker queue;
- one-at-a-time questioning from that queue, without merging independent ambiguities;
- responsive grill-cycle UI for multiple precomputed current-cycle blockers, avoiding a model turn between adjacent questions;
- related queued blockers asked sequentially before farther-apart topics;
- potential-plan re-sweep after the current grill cycle before saving;
- another grill cycle if the re-sweep exposes new blockers;
- an explicit blocker-analysis summary in every saved plan;
- an explicit grill-resolution summary in any saved plan after one or more grill answers, explaining how each answer was incorporated or why a remaining blocker is still unresolved;
- plan-save validation that rejects missing blocker analysis, missing/incomplete grill resolution summaries, unresolved questions masquerading as build-ready plans, and obvious unresolved build-ready language.

Blocking examples:

- choosing a major framework/engine not named by the user;
- creating a new project/crate at repo root;
- destructive restructuring;
- unclear target platform/runtime;
- unclear acceptance criteria for game feel;
- validation that cannot be run locally.

## Research contract

Research is gated. `pi-web-access` may be used when local context is insufficient or current external facts materially affect dependency/API choices. Research results should be distilled into findings, evidence/source, confidence, relevance, and follow-up risks. Raw web dumps should not become parent-session memory.

## Build contract

Build starts only from post-plan choices:

- read plan only / do not build yet;
- refine plan / answer questions;
- build now in this session;
- compact handoff / build after compact;
- build in fresh subagent worker;
- build with GSD subagent pipeline;
- cancel / mark blocked.

### GSD auto pipeline contract

`/gsd-continue [plan path] [target]` and its alias `/gsd [plan path] [target]` resume the active/latest Project Flow plan through the GSD subagent pipeline. They must reconcile existing `gsd/*.md` evidence first, write/update `gsd/resume-ledger.md`, avoid redoing completed milestones/slices, and continue only pending plan-approved work.

The GSD pipeline is automation-first, not slice-stop-first:

- continue through all plan-approved independent slices that can safely progress;
- auto-fix current-work bugs, missing critical correctness/security/validation, broken imports/types/config, and other blockers directly caused by implementation;
- allow at least three focused repair/finalization attempts before declaring a fixable issue blocked;
- defer a local issue and move to the next independent slice when the attempt budget is exhausted and progress is still possible;
- stop only for unavoidable user validation/action, secrets/auth, package-legitimacy checks, destructive operations, unapproved product/architecture decisions, or when no independent slice can progress.

Existing-context build en
