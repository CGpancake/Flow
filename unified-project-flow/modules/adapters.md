# Capability Adapters Module

```text
MODULE: adapters
PURPOSE: Wrap external capability packages behind Project Flow-owned ports.
OWNS: capability detection, backend-specific calls, typed availability/error results.
DOES NOT OWN: lifecycle state, command UX, plan validity, user questions, memory/docs policy.
USED BY: research-gateway, subagents, core diagnostics
DEPS: optional pi-web-access, optional pi-subagents/pi-agents
```

## Boundary

`pi-web-access` and `pi-subagents`/`pi-agents` are core architecture dependencies only as capability backends. They must not become workflow owners.

Core decides what happens next. Adapters only answer whether a capability is available and execute a scoped request.

## Ports

```text
ResearchAdapter
  available() -> capability status
  search/fetch/research(request) -> distilled findings or explicit unavailable error

AgentAdapter
  available() -> capability status
  spawn(taskEnvelope) -> worker id/result handle or explicit unavailable error
  collect(worker id) -> structured evidence/result
```

## Rules

- Detect availability explicitly; never assume packages loaded successfully.
- Return clear degraded-mode reasons when unavailable.
- Do not register Project Flow lifecycle commands from adapters.
- Do not mutate `.pi/project-flow/sessions/` or plan status directly.
- Do not ask the user directly; return blockers to core.
- Do not silently fall back from required fresh/forked worker execution to parent execution.

## `/pf-doctor` Signals

Diagnostics must include:

- web research adapter availability;
- subagent/agent adapter availability;
- fresh worker support;
- forked/inherited worker support;
- structured result collection support;
- detected duplicate or competing workflow packages when possible.
