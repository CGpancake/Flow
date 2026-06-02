# Project Flow

Project Flow is a project-local Pi workflow extension for planning, build approval, validation, docs, and memory. The current implementation is intentionally local-first and copied into projects as:

```text
.pi/extensions/project-flow/index.ts
.pi/project-flow/
```

until the package is stable enough for global installation.

## Current status

Project Flow is now in active refinement of the clean implementation.

Implemented MVP capabilities:

- `/plan <task>` starts a read-only planning lifecycle.
- `project_flow_grill_question` asks one blocking question at a time with selectable options and inline additional context, persists the answer, and requires the planner to continue the blocker-sweep/grill/revision loop.
- `project_flow_save_plan` persists plans under `.pi/project-flow/plans/`, requires `blockerAnalysisSummary` for saved plans and `grillResolutionSummary` after answered grill rounds, and shows a plan review before build choices.
- Post-plan choices gate all builds.
- `/plan-continue` resumes only active Project Flow sessions and no longer infers unrelated work from arbitrary latest plans.
- `/doc` runs docs/memory reconciliation after build.
- `/pf-doctor`, `/pf-self-validate`, `/pf-e2e`, and `/reload-flow` support diagnosis and local development.
- `pi-web-access` and `pi-subagents` are capability backends only, accessed through Project Flow-owned adapter behavior.

## Core rule

Project Flow core is the only lifecycle owner. Modules, tools, subagents, and external capability packages may return findings, proposed actions, evidence, worker results, or blockers; only Project Flow core applies lifecycle state changes.

## Documentation map

- `INSTALLATION.md` — prerequisites, dependencies, setup, validation, and basic usage.
- `docs/spec.md` — canonical product/runtime specification.
- `docs/architecture.md` — architecture, module boundaries, and salvaged patterns.
- `docs/protocols/codebase-reading.md` — shallow-first reading and memory protocol.
- `docs/integrations.md` — `pi-web-access` and `pi-subagents` boundaries.
- `docs/validation.md` — validation strategy and evidence expectations.
- `docs/reference/references.md` — external reference repos/tools.
- `docs/adr/` — accepted architecture decisions.
- `unified-project-flow/` — implementation scaffold/module specs and templates.
- `.pi/project-flow/` — project-local runtime state, plans, memory, validation helper.

## Developer loop

When testing Project Flow in another project, run:

```text
/reload-flow
/reload
```

`/reload-flow` copies extension/support files from `PI_PROJECT_FLOW_DEV_ROOT` into the current project without touching project-local memory, plans, or sessions. If `PI_PROJECT_FLOW_DEV_ROOT` is unset, the current project is used as the source.
