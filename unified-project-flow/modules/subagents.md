# Subagents Module

```text
MODULE: subagents
PURPOSE: Provides the delegation substrate for research, scout, reviewer, validator, and builder workers through an AgentAdapter.
OWNS: subagent task envelopes, tool scopes, result collection.
DOES NOT OWN: lifecycle state, parent planning decisions, build approval, direct user prompts, backend package lifecycle behavior.
USED BY: core, planner, scheduler, validator, docs
DEPS: adapters, pi-subagents/pi-agents capability backend
```

## Worker Types

- `research`: external evidence and library/GitHub investigation.
- `scout`: local code/docs inspection with no mutation.
- `builder`: implementation slice execution.
- `reviewer`: focused code/design review.
- `validator`: checks and validation evidence.

## Task Envelope

Each subagent receives:

- objective;
- allowed tools;
- file ownership or read-only scope;
- dependencies;
- success criteria;
- required evidence format;
- escalation rules.

Subagents return results to core. They do not change lifecycle state.

`pi-subagents`/`pi-agents` are capability backends. They may spawn and isolate workers, but Project Flow core owns when workers run, whether their results are accepted, and which lifecycle transition follows.
