# Research Gateway Module

```text
MODULE: research-gateway
PURPOSE: Delegates external research through scoped subagents and research adapters.
OWNS: research request framing, allowed research tools, distilled evidence contract.
DOES NOT OWN: parent-session MCP access, raw content dumps, lifecycle transitions, backend package lifecycle behavior.
USED BY: planner, validator, docs
DEPS: adapters, pi-subagents/pi-agents capability backend, pi-web-access capability backend
```

## Allowed Research Backend

Research subagents may use `pi-web-access` capabilities through `ResearchAdapter`:

- `librarian`;
- `web_search`;
- `fetch_content`;
- stored search/content flow;
- GitHub cloning/research;
- curator-style review.

Scoped MCPs are allowed only inside research subagents when the research assignment requires them.

`pi-web-access` is a backend, not an owner. It must not decide plan validity, write Project Flow memory/docs directly, ask users questions, or change lifecycle state.

## Output Contract

Research returns:

- finding;
- source/evidence;
- confidence;
- relevance to plan;
- follow-up risk;
- whether local docs should capture the finding.
