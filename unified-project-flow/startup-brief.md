# Startup Brief

Unified PI Project Flow owns plan, build, validate, docs, and memory lifecycle for this project.

Commands:

- `/plan <task>` starts read-first planning.
- `/plan-continue` resumes the latest active or written plan.
- `/doc` reconciles docs and memory after build.
- `/build` is internal only; users trigger build from post-plan choices.

States: `idle`, `planning`, `blocked`, `approved`, `building`, `validating`, `complete`, `failed`.

Core is the only lifecycle owner. Modules, subagents, and external package adapters propose actions/results; core applies state changes.

Planning is read-first and non-mutating. Inspect local docs/code before asking questions. Follow shallow-first reading: module list, headers, signatures, full files only when needed.

Ask one concise blocker question at a time; keep independent ambiguities in separate queued calls, with related blockers asked before farther-apart topics.

Research is gated through subagents using `pi-web-access` and scoped MCPs via adapters. Parent context receives distilled findings, not raw dumps.

`pi-web-access` and `pi-subagents`/`pi-agents` are capability backends, not workflow owners. They must not decide plan validity, lifecycle state, or build approval.

After a written plan is ready, present: build with existing context, compact and build, build in new session using written plan, or continue planning.

Lazy-load detailed specs from `docs/spec.md`, `docs/integrations.md`, `docs/protocols/codebase-reading.md`, and `unified-project-flow/modules/` only when relevant.
