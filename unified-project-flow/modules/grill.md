# Grill Module

```text
MODULE: grill
PURPOSE: Formats and tracks one blocking question at a time.
OWNS: question wording, recommended option, alternatives, answer capture.
DOES NOT OWN: deciding lifecycle state, asking non-blocking preference questions.
USED BY: planner, core
DEPS: persistence
```

## Question Shape

Each question includes:

- question;
- reason it blocks planning;
- recommended answer;
- alternatives;
- optional free-form extra context;
- default assumption if the user declines to answer.

Each captured answer is persisted with the session and must be surfaced on resume.

## Rules

- Ask after inspecting relevant docs/context.
- The planner should first sweep the potential plan for all identifiable build-readiness blockers and maintain a blocker queue.
- Project Flow session state records answered blocker items, current grill cycle status, and merge warnings so resume/save paths do not rely only on agent memory.
- Ask one concise blocker question at a time from that queue; do not merge independent ambiguities into one question just because they are related.
- When multiple current-cycle blockers are known, precompute the ordered question queue and use a single responsive grill-cycle UI so answers advance immediately without a model turn between questions.
- Order related blockers next to each other in the queue before moving to farther-apart topics.
- Persist every answered grill question and its deterministic blocker/cycle metadata in session state.
- During a grill cycle, collect answers for the precomputed queue; if only one blocker is known, the single-question path is acceptable.
- After the current grill cycle is answered, require the planner to plug the collected answers back into the potential plan and re-sweep blockers before saving a plan.
- If that re-sweep exposes new blockers, start another grill cycle with the next concise blocker question.
- Require a blocker-analysis summary in saved plans, and a grill-resolution summary after any grill answer.
- Prefer assumptions only for reversible details.
- Do not bury product intent, acceptance criteria, irreversible tradeoffs, destructive actions, dependency/framework choices, or locally impossible validation as silent assumptions; ask them through the grill queue.
- Ask the user for product intent, irreversible tradeoffs, destructive actions, or locally impossible validation.
