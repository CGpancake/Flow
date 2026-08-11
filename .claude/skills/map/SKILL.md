---
name: map
description: >
  Wayfinder-style multi-session planning for work that is genuinely bigger
  than one session and where the route to the destination is foggy: charts a
  map of small decision tickets in a dedicated planning repo, resolves them
  one at a time (claim, answer, resolve), and tracks a frontier of what can be
  decided right now. Shares its on-disk state and engine (maps/<effort>/) with
  pi's /map command via the same map-tracker.ts logic, through a small CLI at
  bin/map-cli.ts in the Flow package repo. Use when the user says "/map",
  "map this out", "chart a plan for X", "this is too big for one session", or
  asks to continue/resume/check status on an existing effort. Do NOT use for
  small single-session tasks - use ordinary planning/TodoWrite for those.
argument-hint: "init <target> | new <idea> | status [effort] | <effort> | finish <effort>"
license: MIT
---

# /map

Multi-session planning tool. A **planning repo** (where `maps/` state lives)
is always a **separate, non-nested directory** from the **target** (the
codebase being planned). Never point a planning repo at itself.

The engine is one shared file, `map-tracker.ts`, used identically by this
skill and by the `pi` agent's own `/map` command — both read/write the exact
same `maps/<effort>/` files, so an effort can be worked from either agent
across sessions. All state lives on disk as plain Markdown; there is no
separate database.

## Running the CLI

The engine lives in the Flow package repo. Locate it (it's one of several
synced checkouts; any one is equivalent) - a good default is:

```
CLI=/home/domantas/src/Flow/bin/map-cli.ts
node --experimental-strip-types "$CLI" <planning-root> <action> ['<json-params>']
```

If that path doesn't exist, `find / -maxdepth 6 -path "*/Flow/bin/map-cli.ts"`
to locate it before doing anything else, and don't proceed without it - do
not reimplement the ticket logic by hand.

Run every command with `<planning-root>` set to the **planning repo's**
directory (usually `.` if already cd'd there). Output is one JSON object on
stdout; errors go to stderr with a non-zero exit code - check the exit code,
not just stdout.

## Actions

- `init` `{"target": "<path>"}` — one-time setup. Fails if target is nested
  inside the planning root or vice versa (by design).
- `config` — show the configured target.
- `list` — effort names.
- `status` `{"effort"?: "<name>"}` — one effort's map/tickets/frontier, or all
  efforts compactly if `effort` is omitted.
- `map` `{"effort": "<name>"}` — read one effort's map.md as JSON.
- `ticket` `{"effort": "<name>", "number": <n>}` — read one ticket.
- `create-map` `{"effort", "name", "destination", "notes"?, "fog"?, "outOfScope"?}`
  — start a new effort. `destination` is the one thing that must be true when
  done; write it as a concrete outcome, not a vague goal.
- `create-ticket` `{"effort", "title", "type": "research"|"prototype"|"grilling"|"task", "question"}`
  — one ticket = one decision to resolve. Keep tickets small and atomic.
- `blockers` `{"effort", "number", "blockedBy": [<n>, ...]}` — wire
  dependencies after ticket numbers exist.
- `claim` `{"effort", "number", "claimant"}` — claim an open, unblocked
  ticket for this session before working it.
- `resolve` `{"effort", "number", "claimant", "answer", "gist"}` — close a
  claimed ticket with its answer and a one-line decision summary; this also
  appends the decision to the map.
- `release` `{"effort", "number", "claimant"}` — give up a claim without
  resolving.
- `fog` `{"effort", "text"}` — update what's genuinely not yet decided.
- `add-out-of-scope` / `mark-out-of-scope` `{"effort", "number"?, "text"}` —
  record a deliberate boundary.
- `finish` `{"effort"}` — only succeeds when every ticket is resolved or
  out-of-scope, all blockers exist and resolve, and fog is empty; writes
  `maps/<effort>/handoff.md`.

## Workflow

1. If no `.map.json` yet, run `init` with the target repo (read-only during
   planning - do not edit target files from inside a /map session).
2. New effort: `create-map`, then create the initial small set of tickets
   that are decidable *right now* (the frontier). Don't front-load every
   conceivable question - more tickets get added as fog clears.
3. Resuming: `status` to see the frontier (open, unblocked, unclaimed
   tickets). Pick one, `claim` it, investigate, `resolve` it with a real
   answer and gist. One ticket per resolution is the norm; don't rush
   through several in one turn just because you can.
2. When `status` shows no open tickets, no fog, and a filled-in destination,
   `finish` to write the handoff for whoever (person or fresh session) picks
   up the actual implementation next.

Keep tickets and answers evidence-backed (cite files/paths/commands you
actually ran), not speculative. This mirrors the reviewer discipline lean-flow
uses on the pi side - the two tools are meant to feel the same.
