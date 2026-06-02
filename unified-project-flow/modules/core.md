# Core Module

```text
MODULE: core
PURPOSE: Owns the lifecycle state machine and applies proposed actions.
OWNS: command dispatch, lifecycle transitions, phase tool gates, post-plan choices, adapter capability policy.
DOES NOT OWN: code inspection details, web research implementation, slice implementation, docs content, backend package internals.
USED BY: all commands
DEPS: persistence, planner, scheduler, validator, docs, memory, subagents, adapters
```

## Responsibilities

- Maintain one active lifecycle state.
- Enforce command entry points.
- Apply or reject module proposals.
- Gate tools by phase.
- Decide when capability adapters may be used.
- Persist state after every meaningful transition.

## Proposed Actions Accepted

- `start_plan`
- `ask_question`
- `save_plan`
- `approve_plan`
- `start_build`
- `run_validation`
- `complete_workflow`
- `fail_workflow`
- `update_memory`
- `update_docs`

No module, subagent, or external package adapter besides core may apply these transitions directly.
