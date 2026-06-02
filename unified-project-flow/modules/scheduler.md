# Slice Scheduler Module

```text
MODULE: scheduler
PURPOSE: Turns approved plan slices into safe execution order.
OWNS: dependency graph, parallel-safety checks, file ownership conflict detection.
DOES NOT OWN: slice implementation, validation semantics, lifecycle transitions.
USED BY: core, builder subagents
DEPS: subagents, validator
```

## Parallel Safety

Slices may run in parallel only when:

- dependencies are complete;
- owned file sets do not overlap;
- shared files are read-only or serialized;
- failure attribution remains clear;
- validation can run per slice or after a known milestone.

## Output

Scheduler proposes:

- next sequential slice;
- parallel batch;
- serialization reason;
- blocked dependency;
- validation checkpoint.
