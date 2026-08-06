// Lean-flow wiring checks. Entry point: node .pi/extensions/lean-flow.test.mjs. Split only for real behavioral harnesses.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./lean-flow.ts", import.meta.url), "utf8");
const has = (text, label) => assert.ok(source.includes(text), label);

has('import { Editor,', "grill uses Pi Editor");
has("editor.disableSubmit = true", "Enter remains grill submit");
has("editor.getExpandedText()", "multiline editor text is saved verbatim");
has('Key.shift("left")', "Shift+Left changes grill question");
has('Key.shift("right")', "Shift+Right changes grill question");
has("editor.handleInput(data)", "plain arrows are routed to the editor");
has("PONYTAIL FULL RULES (explicitly injected; skills remain isolated)", "children receive Ponytail rules");
has("noSkills: true", "children remain skill-isolated");
has("void runLeanChain(ctx, params.tasks as LeanTask[]", "child chain starts in the background");
has('text: `Started lean background job ${id}.`', "parent gets an immediate continuation result");
has("triggerTurn: false", "child status messages do not trigger parent turns");
has('event.type === "message_update"', "child stream updates are published");
has("const onAbort = () => session.abort()", "cancellation aborts child sessions");
has('task.status = "cancelled"', "cancelled tasks render explicitly");
has('pi.on("tool_call", (event, ctx) => {', "parent write guard is registered");
has("ownedPaths.get(resolvedToolPath(ctx.cwd, path))", "write guard checks child-owned paths");
has("releaseTaskPaths(task)", "write ownership is released after child completion");

console.log("lean-flow wiring checks passed\n\nManual TUI repro after /reload:\n1. Run one grill with two questions; paste two lines in Notes, use Left to move its cursor, Shift+Right to switch questions, then return and submit.\n2. Start a two-task [parallel] /work chain. Immediately run /work-status, observe streamed Lean job updates, try edit/write on a child-owned path (blocked), then /work-cancel and confirm red cancelled tasks plus no surviving child activity.");
