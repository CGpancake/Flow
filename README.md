# lean-flow

Lean pi workflow extension.

Includes:

- `/grill` and `grill_batch`
- `/plan` and `save_lean_plan`
- `/work`, `/review`, and embedded worker/reviewer subagents via `lean_subagent_chain`
- `/handover`
- `/issue` and `record_issue`
- `/map` and Markdown-backed decision maps adapted from Matt Pocock's Wayfinder skill

Project-local copy layout:

```text
.pi/extensions/lean-flow.ts
.pi/extensions/issues.ts
.pi/extensions/map.ts
.pi/extensions/map-tracker.ts
skills/engineering/project-map/SKILL.md
```

`/map` keeps planning state in a dedicated repository and treats its configured target repository as read-only. The package includes its tracker, tools, workflow skill, prototype support, tests, and upstream MIT attribution; no Crucible files are required.

See [the upstream attribution and license](skills/MATTHEW-POCOCK-LICENSE.md).

Git package install:

```bash
pi install git:github.com/CGpancake/Flow
```
