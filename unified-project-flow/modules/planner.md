# Planner Module

```text
MODULE: planner
PURPOSE: Produces build-ready written plans from user tasks and inspected context.
OWNS: plan drafting, blocker detection, assumption tracking, slice proposal.
DOES NOT OWN: lifecycle transitions, direct web tool access, implementation edits, external package behavior.
USED BY: core
DEPS: context-reader, grill, research-gateway, memory, persistence
```

## Planning Loop

1. Parse task intent.
2. Read memory indexes and `CONTEXT.md` if present.
3. Inspect local docs/code shallow-first.
4. Request research only for missing or current external evidence through `research-gateway`/`ResearchAdapter`.
5. Do not run implementation, test, build, check, validator, or auto-fix work in planning mode; define those checks as later validation steps.
6. Sketch the potential plan and sweep it for all identifiable build-readiness blockers.
7. Maintain a blocker queue, but ask one concise blocker question at a time; do not merge independent ambiguities into one question.
8. Ask related queued blockers sequentially before moving to farther-apart topics.
9. When multiple current-cycle blockers are known, submit the precomputed queue to the responsive grill-cycle UI; when only one blocker is known, ask the single concise question.
10. After the cycle, plug the collected answers back into the potential plan and re-sweep blockers.
11. If that re-sweep exposes new blockers, start another grill cycle; otherwise produce a plan that satisfies the plan contract, including a blocker-analysis summary and a grill-resolution summary when any grill questions were answered.
12. Plan-save validation may reject build-ready saves that omit grill answers, fail to reference answered grill rounds, or contain obvious unresolved language.
13. Propose `save_plan` and `approve_plan` to core.

Planner must never call `pi-web-access` directly, run validation/tests as a substitute for saving a plan, or let a research/backend worker decide plan readiness.

## Build Readiness

A plan is build-ready only when the potential-plan blocker sweep has no unresolved blockers, open blockers are resolved or explicitly assumed, answered grill rounds have been incorporated into decisions/assumptions, slices are small enough for fresh worker sessions, validation is defined but not executed in planning, and post-plan choices can be shown.
