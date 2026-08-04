---
name: project-map
description: Chart a large, uncertain effort as a local Markdown map of decision tickets, then resolve its frontier one ticket per session until it is ready for planning handoff. Use only through the /map workflow in a dedicated planning repository.
disable-model-invocation: true
license: MIT; adapted from Matt Pocock's Wayfinder skill
---

# Project Map

A loose idea has arrived that is too large for one agent session and wrapped in fog: the route from here to the **destination** is not visible yet. `/map` finds that route. It charts a shared, low-resolution **map**, then works its **decision tickets**—questions whose resolution is a decision, not slices of target implementation—until the way is clear.

The destination might be a spec to hand off, a decision to lock before `/plan`, or another explicit planning artifact. Naming it is the first act of charting because it fixes the scope of every ticket.

## Hard boundary: map here, inspect there

This workflow runs in a **dedicated planning repository**. `.map.json` identifies a separate target repository to inspect.

- Store every map, ticket, claim, answer, and handoff in the current planning repository.
- Treat the configured target as read-only. Read and search it for facts, but never use `edit` or `write` on a path inside it and never implement target code.
- Do not use shell commands to mutate the target. Shell mutation cannot be reliably policed, so warn and stop rather than attempting it.
- If `.map.json` is missing, do not silently initialize. Warn that mapping should happen in a dedicated repo, suggest creating or using an adjacent planning repo, and require explicit confirmation before `/map init <target>`.
- `/map init` records the target; it never creates a repository.
- `/map finish` writes a local `handoff.md`. It does not invoke `/plan`, create implementation tickets, or cross the target boundary.

The pull to implement is usually the signal that the edge of the map has been reached. Record the decision and leave execution for the later planning and implementation sessions.

## Refer by name

Every map and ticket has a human-readable name. In narration and **Decisions so far**, refer to a ticket by its linked title, never by a bare number or slug. Numbers remain stable local identities, but names are what humans can scan.

## Local Markdown tracker

Canonical state is local Markdown:

```text
.map.json
maps/<effort>/
├── map.md
├── handoff.md                 # only after /map finish
└── issues/
    ├── 01-<slug>.md
    ├── 02-<slug>.md
    └── ...
```

`map.md` is an index, not a store. Open tickets are discovered by scanning `issues/`; never duplicate their list in the map. A resolved decision's detail lives in exactly one ticket. The map contains only a linked one-line gist.

### Map body

Load this low-resolution view once at the start of a mapping session:

```markdown
# <Effort name>

## Destination

<One or two lines describing what reaching the end of this map means.>

## Notes

<Domain context, standing preferences, and relevant skills or constraints.>

## Decisions so far

- [<resolved ticket title>](issues/NN-slug.md) — <one-line gist>

## Not yet specified

<In-scope fog that cannot yet be phrased as precise tickets.>

## Out of scope

<Work consciously ruled beyond this destination, with linked closed tickets where relevant.>
```

### Decision tickets

A ticket is sized to one agent session and has one precise question:

```markdown
# <Ticket title>

Type: grilling
Status: open
Blocked by: none
Claimed by: none

## Question

<The decision or investigation this ticket resolves.>
```

`Type` is `research`, `prototype`, `grilling`, or `task`. `Status` is `open`, `claimed`, `resolved`, or `out-of-scope`. `Blocked by` contains ticket numbers or `none`. Claims identify the active session. Resolution appends one `## Answer` section to this same file; do not create a second detail artifact for the answer.

Use `/map`'s map tools for creation and mutation. They preserve numbering, claims, links, and atomic resolution; do not hand-edit tracker state when a matching map tool exists.

### Blocking, claims, and frontier

A ticket is unblocked when every ticket in `Blocked by` is resolved. The **frontier** is the numbered set of open, unblocked, unclaimed tickets—the edge of the known. Lowest ticket number wins when no ticket is requested.

Claim before any work. A claimed ticket is unavailable to concurrent sessions. Re-read map state before claiming and after resolving because another session may have advanced the frontier.

A session resolves at most **one non-research ticket**. Research tickets are the sole exception.

## Ticket types

Each ticket is either human-in-the-loop (HITL) or agent-driven (AFK):

- **Research (AFK):** inspect primary sources—official docs, source, specifications, APIs, or local knowledge—to surface a fact a later decision needs. Do the research in the **parent mapping session**, not a subagent, branch, or target-repo note. Cite sources in the ticket's answer. Multiple ready research tickets may be resolved in one parent session.
- **Prototype (HITL):** raise discussion fidelity with a cheap, rough artifact to react to. Invoke the project prototype skill where available, but keep artifacts in the planning repo and never modify the target. Link the artifact from the ticket answer.
- **Grilling (HITL):** resolve product or engineering choices with Project Flow's `grill_batch` tool. This is the default ticket type.
- **Task (HITL or AFK):** prerequisite work needed before a decision can be made, such as obtaining access or collecting a sample. It belongs only when it unblocks a decision; it must not implement the destination.

Never impersonate the human side of a HITL ticket.

## Batched Project Flow grilling

Do not use upstream Wayfinder's one-question-at-a-time `/grilling` workflow. Use Project Flow's batched grill:

1. Inspect facts first; do not ask the user what the repositories can answer.
2. Gather all current independent, decision-blocking questions for the ticket.
3. Call `grill_batch` once with the whole batch. Give each question a reason, recommendation, alternatives where useful, and a default assumption.
4. Evaluate the returned answers together because one answer may settle or reshape another.
5. If material ambiguity remains, submit a new batch. Otherwise state the shared resolution and record it.

Keep one ticket's question as the boundary. A batch may explore branches of that question; it must not resolve sibling tickets by accident.

## Fog of war

The map is deliberately incomplete. Beyond live tickets lies **fog of war**: decisions and investigations that are visibly coming but cannot yet be pinned down because they depend on open questions.

Write this dim view in **Not yet specified**. Fog is in scope but coarser than a ticket.

- Create a **ticket** when its question can be stated precisely now, even if blocked.
- Keep **fog** when the question cannot yet be stated precisely. Do not pre-slice it; one patch may later graduate into several tickets or none.

Fog excludes settled decisions, live tickets, and out-of-scope work. When a resolution makes fog precise, create its ticket and remove the graduated text so it has one canonical home.

## Out of scope

The destination fixes scope. Work beyond it is **out of scope**, not fog, and never graduates unless the destination is explicitly redrawn.

If an existing ticket proves to lie beyond the destination, close it as out-of-scope and add one linked line to the map explaining why. Do not add it to **Decisions so far**; a scope boundary is not a decision on the route.

## Invocation

### Chart a map: `/map new <idea>`

1. Verify `.map.json` and the planning/target boundary.
2. **Name the destination.** Inspect relevant target facts, then use `grill_batch` to settle what this effort is finding its way to.
3. **Map the frontier.** Grill breadth-first: fan across the space, surfacing precise open decisions, dependencies, and the first takeable steps rather than drilling deeply into one branch.
4. If no fog appears and the whole route fits one session, stop and tell the user a project map is unnecessary; ask how they want to proceed.
5. Create `maps/<effort>/map.md` with Destination and Notes filled, Decisions so far empty, fog under Not yet specified, and explicit out-of-scope boundaries.
6. Create every ticket that is precise now. Wire blockers only after all initial ticket numbers exist.
7. Resolve any ready research tickets in the parent session, updating the frontier after each. Hand-resolve no other ticket while charting.
8. Stop. Charting is one session's work.

### Work a map: `/map <effort-or-ticket>`

1. Load the effort's `map.md`, then derive open state by scanning child ticket files. Do not eagerly read every ticket body.
2. If the user named a ticket, validate that it is open, unblocked, and unclaimed. Otherwise choose the first frontier ticket.
3. Claim it atomically before reading deeply or working.
4. Resolve it, zooming into related ticket answers and target files only as needed. Follow its type workflow.
5. Record the answer and resolve atomically. Append only a linked gist to **Decisions so far**.
6. Re-evaluate the map: create newly surfaced precise tickets, wire blockers, graduate cleared fog, move newly excluded work out of scope, and invalidate or update affected open tickets.
7. Re-read and report the new frontier. Stop after one non-research resolution.

Concurrent sessions may edit local map state. Never rely on stale status or overwrite another claim.

### Reach the destination: `/map finish <effort>`

Finish only when all of these are true:

- no open or claimed in-scope tickets remain;
- no unresolved blockers remain;
- **Not yet specified** contains no in-scope fog;
- the destination is still satisfied by the recorded route.

If any check fails, refuse completion and report what remains. Otherwise write `maps/<effort>/handoff.md`, synthesizing Destination, Notes, and Decisions so far. Follow links into ticket answers for necessary detail and honor later decisions that supersede earlier ones.

The handoff is the explicit boundary artifact for a future `/plan` session. Write it locally and stop—do not run `/plan`, manufacture implementation tickets, or modify the configured target.
