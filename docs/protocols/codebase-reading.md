# Codebase Reading Protocol

Project Flow uses shallow-first reading to minimize tokens and avoid duplicating existing responsibilities.

## Module headers

Module/spec files should declare ownership with a header such as:

```text
MODULE: planner
PURPOSE: Creates build-ready plans from task and context.
OWNS: plan structure, assumptions, local inspection summary.
DOES NOT OWN: lifecycle transitions, build approval, worker execution.
USED BY: core
DEPS: context-reader, grill, research-gateway, memory, persistence
```

Fields:

- `MODULE`: canonical module name.
- `PURPOSE`: one-sentence purpose.
- `OWNS`: exclusive responsibility.
- `DOES NOT OWN`: explicit boundaries.
- `USED BY`: dependents.
- `DEPS`: dependencies/config.

## Function comments

Exported functions should have one-line comments explaining why they exist when the name alone is insufficient.

## Reading sequence

Always start shallow and go deeper only when necessary:

1. `project_flow_list_modules` — discover existing modules/specs/memory.
2. `project_flow_read_headers` — decide relevance from ownership headers.
3. `project_flow_read_signatures` — inspect exported API/headings.
4. Full file `read` — last resort.

Before creating a module, tool, function, or system, check whether an existing `OWNS` field already covers it. If a `DOES NOT OWN` field excludes it, find the correct module instead of duplicating behavior.

## Memory reading

Long-term memory follows the same principle:

- Startup: load `.pi/project-flow/memory/index.md` only.
- On demand: use `project_flow_context` for specific memory files.
- Search: use `project_flow_memory_search` instead of loading large logs or all memory.

Current memory files:

```text
index.md          # startup map and lazy pointers
decisions.md      # durable decisions
learnings.md      # reusable lessons
validation.md     # validation history
model-policy.md   # model/cost routing policy
```
