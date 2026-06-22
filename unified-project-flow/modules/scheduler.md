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

## GSD Atomicity

GSD scheduling prefers many small fresh-worker tasks over oversized sessions:

- split large slices until each worker has one clear change, owned files, done condition, and validation evidence;
- continue scheduling as many dependency-ordered plan-approved auto tasks as are safe before human validation/action is truly required;
- default continuation cap is 15 worker tasks per `/gsd-continue` run, configurable lower/higher by environment but clamped by implementation safety;
- human verification that does not block later automation is recorded as deferred/manual evidence, not used to stop early.

## Output

Scheduler proposes:

- next sequential slice;
- parallel batch;
- serialization reason;
- blocked dependency;
- validation checkpoint.
