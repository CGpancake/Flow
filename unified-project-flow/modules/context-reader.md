# Context Reader Module

```text
MODULE: context-reader
PURPOSE: Enforces shallow-first local codebase and docs inspection.
OWNS: module discovery, header reads, signature reads, selective full-file reads.
DOES NOT OWN: plan decisions, implementation changes, memory persistence.
USED BY: planner, docs, validator, scout subagents
DEPS: local filesystem search/read tools
```

## Protocol

Follow `docs/protocols/codebase-reading.md`:

1. `listModules()`.
2. `readHeaders(filepath)`.
3. `readSignatures(filepath)`.
4. `readFile(filepath)` only when needed.

If a project lacks wrapper functions, emulate the order with file listing, targeted header reads, exported symbol searches, and full reads as a last resort.

## Evidence

Return concise evidence:

- files inspected;
- depth used;
- relevant ownership fields;
- unresolved context gaps.
