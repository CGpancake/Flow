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

## Slices

### Slice 1: Name

- Goal:
- Owned files:
- Shared files:
- Dependencies:
- Parallel safe with:
- Steps:
- Automatic validation:
- Manual validation:
- Evidence required:

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
