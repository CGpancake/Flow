# Persistence Module

```text
MODULE: persistence
PURPOSE: Stores sessions, plans, answers, research notes, slice state, and validation evidence.
OWNS: file paths, serialization, latest-plan/session lookup.
DOES NOT OWN: lifecycle decisions, plan content policy, docs policy.
USED BY: core, planner, grill, validator, memory
DEPS: local filesystem
```

## Paths

- `.pi/project-flow/sessions/`
- `.pi/project-flow/plans/`
- `.pi/project-flow/memory/`

## Resume Lookup

1. Latest active session.
2. Latest written plan.
3. Explicit user selection only if neither can be inferred.

Persist after every meaningful lifecycle transition.
