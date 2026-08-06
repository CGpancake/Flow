// Lean-flow wiring checks. Entry point: node .pi/extensions/lean-flow.test.mjs. Split only for real behavioral harnesses.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./lean-flow.ts", import.meta.url), "utf8");
const has = (text, label) => assert.ok(source.includes(text), label);

has('import { Editor,', "grill uses Pi Editor");
has("editor.disableSubmit = true", "Enter remains grill submit");
has("editor.getExpandedText()", "multiline editor text is saved verbatim");
has('Key.shift("tab")', "Shift+Tab moves to the previous grill question");
has("matchesKey(data, Key.tab)", "Tab moves to the next grill question");
has("matchesKey(data, Key.up)", "plain Up selects the previous grill answer");
has("matchesKey(data, Key.down)", "plain Down selects the next grill answer");
assert.ok(!source.includes('Key.shift("left")') && !source.includes('Key.shift("right")') && !source.includes('Key.shift("up")') && !source.includes('Key.shift("down")'), "grill no longer binds shift+arrow, which many terminals intercept for native selection before it reaches the app");
has("editor.handleInput(data)", "plain left/right still edit the notes field");
has("PONYTAIL FULL RULES (explicitly injected; skills remain isolated)", "children receive Ponytail rules");
has("noSkills: true", "children remain skill-isolated");
has("void runLeanChain(ctx, params.tasks as LeanTask[]", "child chain starts in the background");
has('text: `Started lean background job ${id}.`', "parent gets an immediate continuation result");
has("triggerTurn: false", "child status messages do not trigger parent turns");
has("ctx.ui.setWidget(widgetKey", "background job progress redraws an in-place widget, not chat messages");
assert.ok(!source.includes('emit("progress")'), "background job progress no longer sends a chat message per tick");
assert.ok(!source.includes('emit("started")'), "background job start no longer sends a chat message");
has('event.type === "message_update"', "child stream updates are published");
has("const onAbort = () => session.abort()", "cancellation aborts child sessions");
has('task.status = "cancelled"', "cancelled tasks render explicitly");
has('pi.on("tool_call", (event, ctx) => {', "parent write guard is registered");
has("ownedPaths.get(resolvedToolPath(ctx.cwd, path))", "write guard checks child-owned paths");
has("releaseTaskPaths(task)", "write ownership is released after child completion");

console.log("lean-flow wiring checks passed\n\nManual TUI repro after /reload:\n1. Run one grill with two questions; paste two lines in Notes, use Left/Right to move its cursor, Up/Down to change the highlighted option, Tab/Shift+Tab to switch questions, then Enter to submit.\n2. Start a two-task [parallel] /work chain. Confirm progress renders as one live-updating widget above the editor (no repeated chat messages), try edit/write on a child-owned path (blocked), then /work-cancel and confirm red cancelled tasks plus no surviving child activity.\n3. Have the parent agent call lean_subagent_chain directly (not /work) and confirm only one concise summary message appears once the job finishes, with no per-tick chat spam while it runs.");
