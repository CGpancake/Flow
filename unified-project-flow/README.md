# Unified Project Flow Scaffold

This directory is the project-local implementation scaffold for Project Flow. It is intentionally small and file-backed so the runtime extension can lazy-load details instead of carrying a large startup prompt.

## Layout

- `startup-brief.md` - compact prompt loaded at startup.
- `commands.md` - user-facing command contracts.
- `modules/` - internal module boundary specs with ownership headers, including capability adapters for external packages.
- `templates/plan-template.md` - persisted plan format.
- `memory/` - seed files for `.pi/project-flow/memory/`.
- `docs/adr/0001-unified-lifecycle-owner.md` - initial ADR.

## Implementation Rule

Core is the only lifecycle owner. Modules, subagents, and external package adapters return proposed actions/evidence; core applies or rejects state changes.

`pi-web-access` and `pi-subagents`/`pi-agents` are architecture backends only through adapters. They provide capabilities such as search, fetch, spawn, and result collection; they do not decide workflow state, plan readiness, or build approval.

## Deferred

`context-mode` is not part of the initial memory system. It can be added later as an output containment or retrieval layer if evidence shows file-backed memory is insufficient.
