# ADR 0001: Unified Lifecycle Owner

## Status

Accepted.

## Context

Previous project-flow experiments had overlapping systems for planning, validation, memory, docs, and build orchestration. That creates conflicting readiness states and unclear blockers. Capability packages such as `pi-web-access` and `pi-subagents`/`pi-agents` are useful, but become fragile if allowed to decide Project Flow lifecycle state.

## Decision

Build one project-local workflow extension where core is the only lifecycle owner. Planner, validator, docs, memory, research, scheduler, subagent modules, and capability adapters return proposed actions and evidence. Core applies lifecycle state changes.

`pi-web-access` and `pi-subagents`/`pi-agents` integrate as adapter backends. They provide search/fetch/spawn/result capabilities; they do not decide plan readiness, build approval, user questions, memory updates, or docs updates.

## Consequences

- One state machine controls plan, build, validation, docs, and memory.
- Modules remain testable because they return proposals rather than mutating global state.
- Runtime startup context can stay compact because detailed behavior is lazy-loaded from module specs.
- Future integrations such as `context-mode` must wrap or support core, not replace lifecycle ownership.
- Web and agent packages remain capability backends rather than workflow owners.
