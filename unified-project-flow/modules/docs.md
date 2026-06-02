# Docs Module

```text
MODULE: docs
PURPOSE: Reconciles implementation, plans, CONTEXT.md, ADRs, and memory after build.
OWNS: feature-drift detection, docs update proposals, ADR creation criteria.
DOES NOT OWN: lifecycle transitions, build execution, raw memory logging.
USED BY: core, /doc
DEPS: context-reader, validator, memory
```

## Update Criteria

Update docs only for:

- stable project vocabulary;
- behavior that drifted from the written plan;
- hard-to-reverse architectural decisions;
- validation findings future agents need;
- surprising tradeoffs.

## Outputs

- drift report;
- proposed `CONTEXT.md` changes;
- proposed ADRs;
- memory updates;
- unresolved documentation questions.
