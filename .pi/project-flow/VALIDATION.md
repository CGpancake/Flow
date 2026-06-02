# Clean Project Flow Base Validation

After copying `.pi/extensions/` and `.pi/project-flow/` into a target project, run:

```txt
/reload
/pf-doctor
```

Expected base commands:

- `/plan <task>`
- `/plan-continue`
- `/doc`
- `/pf-doctor`
- `/pf-self-validate`
- `/pf-self-validate build`
- `/pf-e2e`

Expected project theme:

- `.pi/themes/relay-concrete-dim.json` mirrors Relay native Concrete Dim tokens (`#222120`, `#E8E6E2`, `#F5C400`) using Pi theme color tokens and terminal-safe hex colors.
- `.pi/settings.json` selects `"theme": "relay-concrete-dim"`; `/reload-flow` must copy the theme and update this project setting in target projects.

Expected base tools:

- `project_flow_context`
- `project_flow_list_modules`
- `project_flow_read_headers`
- `project_flow_read_signatures`
- `project_flow_memory_search`
- `project_flow_grill_question`
- `project_flow_grill_cycle`
- `project_flow_save_plan`
- `project_flow_finish`

Expected capability packages to appear in `/pf-doctor`:

- ResearchAdapter: `web_search`, `code_search`, `fetch_content`, `get_search_content`
- AgentAdapter: `subagent`

Self-validation flow:

1. `/pf-doctor`
2. `/pf-self-validate`
3. Optional deeper adapter/build check: `/pf-self-validate build`
4. Confined lifecycle E2E: `/pf-e2e`

`/pf-e2e` runs in the configured validation project (`PI_PROJECT_FLOW_VALIDATION_CWD`, or the current project if unset), cleans `.pi/project-flow/self-test/`, writes a confined test plan, transitions through plan/build/validate/finish, uses the AgentAdapter foreground worker, verifies `.pi/project-flow/self-test/e2e.txt`, and writes an E2E report under `.pi/project-flow/sessions/`.

Post-plan selection options expected:

- `Build now in this session` - enables edit/write and requires `project_flow_finish` after validation.
- `Compact handoff / build after compact` - writes handoff instructions and starts no build.
- `Build in fresh subagent worker` - uses AgentAdapter public bridge and does not let parent silently build.
- `Stop process / no build` - starts no build and leaves the saved plan resumable with `/plan-continue`.

`/plan-continue` from a `plan_ready` session should reopen the same native post-plan selector instead of asking for a text-only choice.

Headless loop validation, optionally restricted by `PI_PROJECT_FLOW_VALIDATION_CWD` and cleaned each run:

```bash
node .pi/project-flow/self-validate.mjs
```

The script cleans `.pi/project-flow/self-test/`, checks source/runtime invariants including Codebase Reading Protocol tools, writes a smoke plan, writes a self-test artifact, and stores a report under `.pi/project-flow/sessions/`.

Smoke flow:

1. `/pf-doctor`
2. `/plan create a tiny validation plan only`
3. Assistant should stay read-only and call `project_flow_save_plan`.
4. Post-plan choice UI should appear.
5. Choose `Stop process / no build` first.
6. Confirm a markdown plan exists under `.pi/project-flow/plans/`.

Grill loop smoke:

1. Run a deliberately ambiguous `/plan` that requires multiple blocking product/technical choices.
2. Assistant should privately sketch the potential plan, sweep for all identifiable blockers, form a blocker queue, and call `project_flow_grill_cycle` when multiple current-cycle blockers are known or `project_flow_grill_question` when only one is known.
3. Answer the grill question(s); a precomputed grill cycle should advance immediately between adjacent questions without an agent turn.
4. Assistant should keep related queued blockers sequential before farther-apart topics, without merging independent ambiguities into one question.
5. Assistant should then plug collected answers back into the potential plan, re-sweep because answers may resolve or create blockers, and start another grill cycle if needed.
6. Only after the blocker queue is cleared should it call `project_flow_save_plan` with `blockerAnalysisSummary` and, if any grill questions occurred, `grillResolutionSummary`.
7. If either required summary is omitted, incomplete, or a build-ready plan contains obvious unresolved language, `project_flow_save_plan` should reject the save and return captured grill/session context for revision.

Subagent build smoke:

1. Run `/plan create a tiny browser hello world page`.
2. Choose `Build in fresh subagent worker`.
3. Expected: Project Flow reports `Project Flow worker started via AgentAdapter`.
4. Expected: widget phase becomes `building`.
5. When the async worker result is delivered, confirm changed files and validation evidence.
6. The parent should record completion with `project_flow_finish` so the widget clears and a result note is written under `.pi/project-flow/sessions/`.

Do not validate by selecting build until the plan UX looks right.
