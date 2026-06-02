# Project Flow State

This directory is the project-local persistence root for Unified PI Project Flow.

## Directories

- `sessions/` - active lifecycle state.
- `plans/` - written plans.
- `memory/` - concise startup-loadable and searchable workflow memory.

Runtime code should persist state here and lazy-load details as needed.

Capability packages such as `pi-web-access` and `pi-subagents`/`pi-agents` must integrate through Project Flow adapters. They provide search/fetch/spawn/result capabilities but do not write lifecycle state here directly.
