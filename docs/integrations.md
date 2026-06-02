# Integration Boundaries

## Core distinction

`pi-web-access` and `pi-subagents`/`pi-agents` are capability backends. They must not become workflow owners.

Project Flow owns:

- lifecycle state;
- plan readiness;
- blocking questions;
- research gating;
- subagent spawn timing;
- build approval;
- validation/docs/memory acceptance.

External packages answer capability questions only:

- Can web evidence be searched/fetched?
- Can a scoped worker be spawned?
- Can worker evidence be returned?

## ResearchAdapter role

Allowed:

- scoped search/fetch/library research;
- GitHub or docs investigation when local context is insufficient;
- distilled evidence returned to Project Flow.

Not allowed:

- deciding plan validity;
- writing memory/docs directly;
- lifecycle transitions;
- raw dump injection into parent context.

## AgentAdapter role

Allowed:

- spawn fresh/forked workers through public `pi-subagents` behavior;
- pass selected plan and scoped task envelope;
- return worker ids, status, evidence, and blockers.

Not allowed:

- owning build approval;
- mutating Project Flow lifecycle state;
- asking user questions outside Project Flow's grill gate;
- silently falling back to parent execution.

## Current implementation

The extension uses the public `pi-subagents` slash bridge events:

```text
subagent:slash:request
subagent:slash:response
subagent:slash:started
```

It intentionally avoids old private RPC events:

```text
subagents:rpc:spawn
subagents:rpc:ping
```

`/pf-doctor` reports capability availability and old-package risks.
