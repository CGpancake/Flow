---
name: map_plan
description: >
  Bridges a /map effort straight into pi's lean-flow /work, skipping pi's own
  /plan turn. Reconciles the effort's map.md/tickets against anything this
  session actually settled that the map doesn't yet reflect (drift), folds in
  the prompt given after /map_plan plus concepts referenced earlier in the
  session, then writes .pi/lean-flow/plan.md into wherever the user's pi
  session actually runs (verified, not assumed to be the effort's configured
  target - those can differ) so pi can run /work immediately on switching
  over. Use when the user says "/map_plan", "turn the map into a
  plan", "write the lean plan so pi can just /work", "skip /plan and write
  the plan file", or asks to hand a resolved map straight to pi without an
  extra planning prompt. Requires an existing /map effort (.map.json plus
  maps/<effort>/) - do not use for work that never went through /map, and do
  not use for the ordinary /map ticket workflow itself (that's still /map).
argument-hint: "<effort> [extra scope/instructions]"
license: MIT
---

# /map_plan

`/map` charts and resolves decisions in a **planning repo**; separately, the
user's **pi** agent turns an approved plan into code in the **target** repo
via `/plan` (which prompts pi's own LLM to research and call
`save_lean_plan`) then `/work` (which reads that plan back and runs it).
`/map_plan` collapses the gap between those two tools: once a `/map` effort
is decided (or decided enough), it writes the plan pi's `/work` expects
*directly* into the target - no separate `/plan` turn in pi required.

This only makes sense downstream of a real `/map` effort. If the user hasn't
run `/map` for this work, say so and suggest `/map <idea>` first, or fall
back to an ordinary in-session plan if the work is genuinely small.

## Hard boundary: one deliberate exception

Everywhere else, `/map`-style work is read-only against the target and
writes only inside the planning repo's `maps/<effort>/`. `/map_plan` is the
one explicit exception: it also writes exactly one file in the target -
`.pi/lean-flow/plan.md` - because that file *is* the planning artifact pi's
own `/plan` would have written there anyway. Never touch any other file in
the target from this skill, and never implement target code here.

## Running the CLI

Same engine and CLI as `/map` - do not reimplement ticket logic by hand.

```
CLI=/home/domantas/src/Flow/bin/map-cli.ts
node --experimental-strip-types "$CLI" <planning-root> <action> ['<json-params>']
```

If that path doesn't exist, `find / -maxdepth 6 -path "*/Flow/bin/map-cli.ts"`
first. Run every command with `<planning-root>` set to the planning repo
(the directory holding `.map.json`), check the exit code, and parse the JSON
on stdout. See `map`'s own SKILL.md for the full action list (`status`,
`map`, `ticket`, `resolve`, `fog`, `mark-out-of-scope`, `create-ticket`,
`config`, `finish`, ...); this skill only adds one new artifact, it doesn't
add new tracker actions.

## Workflow

1. **Locate the effort.** Find `.map.json` (walk up from cwd, same as
   `/map`). If the user named an effort, use it. Otherwise `list` efforts and
   `status` each to find the one this session has actually been discussing;
   if more than one is plausible, ask which.

2. **Load recorded state.** `status {"effort"}` and read `map.md` for
   Destination, Decisions so far, Not yet specified (fog), and Out of scope.
   Skim ticket files only as needed - don't eagerly read every one.

3. **Reconcile drift before planning.** The point of this step is that the
   session may have settled things the on-disk map doesn't know about yet.
   Compare recorded state against what this conversation actually
   established, and fix only what the conversation genuinely supports -
   never invent a resolution just to unblock a plan:
   - A ticket effectively decided in conversation but still `open`/`claimed`
     on disk: `claim` (if needed) then `resolve` it with the real answer and
     a one-line gist, citing what in this session settled it.
   - Something ruled out during the session: `mark-out-of-scope` /
     `add-out-of-scope` with a one-line reason.
   - A genuinely new decidable question surfaced but wasn't a ticket yet:
     `create-ticket` (+ `blockers` if it depends on something else) instead
     of silently baking an unresolved fork into the plan.
   - Understanding that shifted but still can't be pinned to a precise
     question: update **fog** via `fog`.
   Re-run `status` after mutating so the frontier reflects the updates.

4. **Check the frontier is actually plan-safe.** If real, in-scope,
   blocking questions are still open after step 3 - things whose answer
   would change the shape of the implementation - stop and report exactly
   what's still undecided. Do not synthesize a plan around an unresolved
   fork; send the user back to `/map` (or answer it now if it's a quick
   grill) instead of guessing. This is a lighter bar than `/map_finish`
   (fog and cosmetic tickets don't have to be zero), but shape-changing
   ambiguity does.

5. **Resolve pi's actual working directory - do not assume it equals the
   map's target.** `config` on the planning root gives the map's configured
   target, but pi's `/work` and `/plan` resolve the plan path from **pi's own
   live session `ctx.cwd`** (see `tasksFromPlan`/`save_lean_plan` in
   lean-flow's extension source, e.g. `.pi/extensions/lean-flow.ts` in the
   Flow package repo) - a value this skill has no direct access to and that
   has no structural connection to the map config. Treating them as the same
   directory is a real, silent failure mode, not a hypothetical: if
   `plan.md` lands somewhere pi isn't looking, `existsSync` just returns
   false and pi falls back to a single generic `"Lean work"` task with none
   of the plan's content - no error, no warning, easy to mistake for "the
   plan only had one step."
   - Gather real evidence before writing, don't guess from the target alone:
     an existing `.pi/` (especially `.pi/lean-flow/`) directory already
     present at a candidate location is real evidence pi has run there
     before; a bare `config` target is not.
   - If the map's target and the planning root are the *same* directory,
     there's nothing to reconcile - proceed.
   - If they differ (e.g. the target is a subdirectory scoped for `/map`'s
     own research, as is common in monorepos), check both for existing `.pi/`
     state, and prefer whichever one already shows real pi history. If both
     or neither show evidence, ask the user directly which directory they
     launch pi from - do not silently pick one.
   - Use the confirmed directory (call it `<pi-root>` below), not
     necessarily the map's `target`, for steps 6 and 8.

6. **Check for an in-flight plan.** If `<pi-root>/.pi/lean-flow/plan.md`
   already exists, read it first and confirm with the user before
   overwriting - pi's `/work` may be actively running against it.

7. **Synthesize the plan.** Combine three sources: the prompt text given
   after `/map_plan` (the scope for *this* plan, same role as `/plan`'s
   `<args>`), the map's Decisions so far / handoff-worthy facts, and
   concepts and grounding facts this session actually referenced (files,
   line numbers, decisions) - the same "cite, don't re-derive" discipline
   `/map` itself uses. Produce:
   - a short title (first line, `# <title>`);
   - a flat numbered list of atomic implementation steps, each independently
     actionable by one lean-flow worker child (mirrors how `/work` slices
     plan steps 1:1 into worker tasks - keep steps that granular, not vague
     phases);
   - a trailing `[parallel]` on consecutive steps that are genuinely
     independent and won't touch the same files (mirrors lean-flow's own
     `[parallel]` marker convention - see below).
   Keep it as short and temporary as `/plan` itself would; no essays, no
   restating decisions at length when a citation will do.

8. **Write the file.** `mkdir -p <pi-root>/.pi/lean-flow`, then write
   `<pi-root>/.pi/lean-flow/plan.md` with exactly:

   ```
   # <title>

   1. <first atomic step>
   2. <second atomic step> [parallel]
   3. <third atomic step> [parallel]
   ...
   ```

   This matches what pi's own `save_lean_plan` tool writes (`# <title>\n\n<markdown>\n`).

9. **Report.** Summarize any drift reconciled in step 3 (ticket
   resolutions/out-of-scope/fog changes), confirm the plan file's path, and
   tell the user to switch to pi in `<target>` and run `/work` - no `/plan`
   turn needed.

## The plan format pi's `/work` actually reads

Don't over-format this file; pi's `tasksFromPlan` parser is intentionally
simple: it looks for a `## Implementation` section, but falls back to
scanning the *whole file* for lines matching `^\s*\d+\.\s+...` if that
header is absent. A bare numbered list under the title (no header at all) is
exactly what real plans in this project use and is the safest, simplest
choice - don't add an `## Implementation` heading unless there's other prose
in the file that would otherwise get mistaken for steps. Each numbered line
becomes one worker task; a trailing `[parallel](:optional-note)?` on
consecutive lines is stripped from the task text and marks those tasks to
run concurrently. Task labels are auto-derived from the step text, so keep
each step's first few words meaningful (they become the label pi's TUI
shows).

Do not call pi's own tools (`grill_batch`, `save_lean_plan`,
`lean_subagent_chain`) - those are extension tools inside the pi agent
process and aren't reachable from here. Write the file directly with the
Write tool instead, matching the format above by hand.
