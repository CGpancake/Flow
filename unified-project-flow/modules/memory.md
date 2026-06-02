# Memory Module

```text
MODULE: memory
PURPOSE: Maintains concise project-local workflow memory.
OWNS: memory index, decisions, learnings, validation history, active workflow summaries.
DOES NOT OWN: verbose logs as startup context, architectural docs, lifecycle transitions.
USED BY: planner, docs, validator, core
DEPS: persistence
```

## Files

- `.pi/project-flow/memory/index.md`
- `.pi/project-flow/memory/decisions.md`
- `.pi/project-flow/memory/learnings.md`
- `.pi/project-flow/memory/validation.md`

## Write Rules

Write only evidence-backed, reusable facts. Do not store raw tool output or long session transcripts in startup-loaded files.
