# Project Flow Architecture

## Architecture rule

Use one workflow-owning Project Flow extension with internal modules. Do not glue together multiple workflow-owning extensions.

External packages may be installed globally or project-locally as capability providers, but they do not own Project Flow lifecycle decisions.

## Why unified ownership

Earlier experiments risked fragmented responsibility: one component said ready, another said blocked, another wrote state, and another asked new questions. Project Flow avoids that by making core the only lifecycle owner.

Modules and adapters may propose actions; core applies or rejects them.

## Internal module shape

```text
Project Flow core
  planner
  grill/question gate
  persistence
  context-reader
  research-gateway
  agent-adapter
  validator
  docs
  memory
  TUI/status
```

## Salvaged patterns

- Single lifecycle state machine.
- Explicit plan contract.
- One blocking question at a time.
- Read-only planning.
- Lazy docs and memory.
- Validation as first-class workflow.
- Local-first research capture.
- Capability adapters for web and workers.

## Current implementation notes

The current MVP is implemented as a project-local extension:

```text
.pi/extensions/project-flow/index.ts
```

It intentionally remains a single file while behavior is being validated. The scaffold in `unified-project-flow/modules/` documents the intended module boundaries for later extraction.

## Model and subagent isolation

Project Flow-spawned workers default to:

```text
context: fresh
reads: [selected plan]
skill: false
```

This prevents parent context/skill bleed. Model routing is configurable through environment variables:

```text
PI_PROJECT_FLOW_CHEAP_MODEL
PI_PROJECT_FLOW_WORKER_MODEL
PI_PROJECT_FLOW_EXPENSIVE_MODEL
PI_PROJECT_FLOW_REVIEW_MODEL
PI_PROJECT_FLOW_GSD_THINKING
PI_PROJECT_FLOW_GSD_SCOUT_MODEL
PI_PROJECT_FLOW_GSD_SCOUT_THINKING
PI_PROJECT_FLOW_GSD_WORKER_THINKING
PI_PROJECT_FLOW_GSD_REVIEW_THINKING
```

If unset, Pi/subagents use their configured defaults.
