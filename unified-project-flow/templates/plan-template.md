---
id: PLAN-YYYYMMDD-HHMMSS
status: draft
created: YYYY-MM-DDTHH:MM:SSZ
updated: YYYY-MM-DDTHH:MM:SSZ
task: ""
risk: low
validation_level: standard
build_option: null
---

# Plan: Title

## Goal

State the user-visible outcome.

## Local Context Inspected

| Path | Depth | Relevant finding |
|---|---|---|
|  | modules/headers/signatures/full |  |

## Research Notes

| Finding | Evidence | Confidence | Relevance |
|---|---|---|---|
|  |  |  |  |

## Blocking Questions

No unresolved blocking questions.

## Assumptions

- Assumption and why it is acceptable.

## Decisions

- Decision, rejected alternatives, why, failure mode prevented.

## GSD Work Breakdown

Each slice should be independently verifiable and small enough for one focused worker pass. Split further if it touches unrelated files, mixes unrelated behavior, cannot be validated independently, or would require more than one architectural decision.

### Milestone 1: Name

- Goal:
- Acceptance:
- Dependencies:
- Validation checkpoint:

#### Slice 1.1: Name

- Goal:
- User-visible outcome:
- Owned files:
- Shared files:
- Dependencies / must follow:
- Parallel safe with:
- Not parallel safe with / conflict reason:
- Stop / escalation triggers:
- Automatic validation:
- Manual validation:
- Evidence required:

##### Tasks

1. Task name
   - Type: auto | human-verify | decision | human-action
   - Files:
   - Change:
   - Done when:
   - Validation:
   - Auto-fix policy: fix scoped bugs/blockers up to 3 attempts; defer and continue independent tasks when possible.

## Validation Plan

- Automatic checks:
- Manual checks:
- Edge cases:
- Skipped checks:
- Cargo safety when applicable: heavy Cargo checks use an explicit job limit (`-j 2` by default); graphical/interactive `cargo run` is manual unless explicitly approved.

## Post-plan Choice

Pending user choice:

- Build with existing context.
- Compact and build.
- Build in new session using written plan.
- Continue planning.

## Completion Evidence

- Commands run:
- Results:
- Remaining risks:
