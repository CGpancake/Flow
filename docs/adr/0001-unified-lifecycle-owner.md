# ADR 0001: Unified Lifecycle Owner

## Status

Accepted.

## Context

Earlier Project Flow experiments identified fragmented lifecycle ownership as the main failure mode. Independent planning, validation, memory, docs, and build components can disagree about readiness and blockers. Capability packages such as `pi-web-access` and `pi-subagents`/`pi-agents` are useful, but become fragile if they also decide Project Flow lifecycle state.

## Decision

The rebuilt Project Flow uses one core lifecycle controller. Internal modules, subagents, and capability adapters may propose actions and return evidence, but only core applies lifecycle state changes.

`pi-web-access` and `pi-subagents`/`pi-agents` integrate as adapter backends. They provide search/fetch/spawn/result capabilities; they do not decide plan readiness, build approval, user questions, memory updates, or docs updates.

## Consequences

- Planning, build, validation, docs, and memory share one state machine.
- Build can be gated behind the post-plan choice without a separate normal `/build` command.
- Subagents remain scoped workers rather than workflow owners.
- Web and agent packages remain capability backends rather than workflow owners.
- Future features must integrate through core or adapters rather than mutating workflow state independently.
