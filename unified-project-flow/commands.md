# Command Contracts

## `/plan <task>`

Starts a new planning lifecycle.

Required behavior:

- create active session state;
- load memory indexes and stable context only;
- inspect project files using the shallow-first protocol;
- delegate gated research only when needed through the ResearchAdapter; capability backends such as `pi-web-access` do not own planning decisions;
- ask one concise blocker question at a time, with independent ambiguities queued rather than merged;
- persist a written plan only when build-ready or explicitly blocked;
- show post-plan build choices when ready.

## `/plan-continue`

Resumes the latest active workflow.

Resolution order:

1. latest active session under `.pi/project-flow/sessions/`;
2. if no active session exists, stop and ask the user to start `/plan <task>` or explicitly select a plan.

It must not infer work from an unrelated latest saved plan. When a session exists, restore unanswered questions, assumptions, research notes, validation notes, and slice status.

## `/doc`

Runs documentation reconciliation after build.

Inputs:

- written plan;
- changed files;
- validation evidence;
- `CONTEXT.md`;
- `docs/adr/`;
- `.pi/project-flow/memory/`.

Outputs:

- feature drift report;
- warranted docs/memory updates;
- unresolved documentation risks.

## `/pf-doctor`

Diagnoses Project Flow setup and capability backends.

Must report:

- `.pi/project-flow/` path status;
- active/latest session and plan lookup status;
- ResearchAdapter availability, including `pi-web-access` capability status;
- AgentAdapter availability, including `pi-subagents`/`pi-agents` capability status;
- fresh/forked worker support;
- explicit degraded modes or blockers.

## Internal Build Event

Build starts only from post-plan choices:

- read plan only / do not build yet;
- refine plan / answer questions;
- build now in this session;
- compact handoff / build after compact;
- build in fresh subagent worker;
- cancel / mark blocked.

If a selected build option requires an unavailable AgentAdapter capability, core blocks with a clear reason instead of silently falling back to parent execution.

Rust/Cargo safety policy:

- heavy Cargo commands (`cargo build`, `cargo check`, `cargo clippy`, `cargo test`, `cargo install`, `cargo bench`) must include an explicit job limit at or below the configured Project Flow maximum, default `-j 2`;
- automated validation should prefer `cargo fmt --check` and `cargo check -j 2`;
- graphical or interactive `cargo run` is manual by default and requires explicit user approval/override before Project Flow runs it.
