# Validator Module

```text
MODULE: validator
PURPOSE: Attaches evidence that plans, slices, builds, and docs satisfy their contracts.
OWNS: contract checks, command result summaries, validation evidence.
DOES NOT OWN: lifecycle transitions, implementation edits, documentation policy, backend package lifecycle behavior.
USED BY: core, planner, scheduler, docs
DEPS: context-reader, subagents, persistence, adapters
```

## Validation Targets

- Plan contract.
- Slice completion.
- Build behavior.
- Documentation drift.
- Memory update relevance.

## Evidence

Record:

- checks run;
- pass/fail result;
- skipped checks and reason;
- manual validation still needed;
- unresolved risks;
- reviewer findings;
- whether validation evidence came from parent checks or adapter-backed worker results.

Validator may request reviewer/validator workers through the subagents module, but it returns validation proposals to core rather than changing state itself.
