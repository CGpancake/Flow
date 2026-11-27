// Pure lean-flow plan/run contracts. Entry point: node --test tests/*.test.ts.

import assert from "node:assert/strict";
import test from "node:test";

import {
	appendIssue,
	appendPlanStep,
	branchSlug,
	clearCompleted,
	planGoal,
	planImplementation,
	planStepCount,
	planStepsFromText,
	planTrack,
	parseTracks,
	pathRefs,
	setIssueStatus,
	reviewVerdict,
	shortPath,
	runId,
	slugify,
	staleRunIds,
	taskFileName,
	taskLabel,
	tasksFromPlanText,
} from "../lean-flow-plan.ts";

const plan = `# Ship the widget

Keep this intro out of the step list.

## Notes

1. Not an implementation step.

## Implementation

1. Set up the widget project
2. Build the widget API [parallel]
3. Build the widget UI [parallel]
4. Document the widget

## Validation

1. Human checks the widget in a browser.
`;

test("branch slug resolves branches and detached HEAD", () => {
	assert.equal(branchSlug("feature/Widget API"), "feature-widget-api");
	assert.equal(branchSlug("release/2026.01"), "release-2026-01");
	assert.equal(branchSlug("unknown"), "_detached");
	assert.equal(branchSlug("HEAD"), "_detached");
	assert.equal(slugify("!!!"), "task");
	assert.equal(slugify("a".repeat(80), 10), "a".repeat(10));
	assert.equal(slugify("trailing---"), "trailing");
});

test("plan parsing reads only the implementation section", () => {
	assert.match(planImplementation(plan).trim(), /^1\. Set up the widget project/);
	assert.doesNotMatch(planImplementation(plan), /Human checks/);
	assert.equal(planStepCount(plan), 4);
	assert.equal(planGoal(plan), "# Ship the widget");

	const parsed = planStepsFromText(plan);
	assert.equal(parsed.goal, "Ship the widget");
	assert.deepEqual(parsed.steps.map((step) => step.step), ["1", "2", "3", "4"]);
	assert.deepEqual(parsed.steps.map((step) => step.body), [
		"Set up the widget project",
		"Build the widget API",
		"Build the widget UI",
		"Document the widget",
	]);
	assert.deepEqual(parsed.steps.map((step) => Boolean(step.parallel)), [false, true, true, false]);
});

test("plan parsing marks only members of a parallel batch", () => {
	const tasks = tasksFromPlanText(plan, "");
	assert.equal(tasks.length, 4);
	assert.deepEqual(tasks.map((task) => task.parallel), [undefined, true, true, undefined]);
	assert.equal(tasks[0]!.task, "Implement plan step 1: Set up the widget project");
	assert.equal(tasks[0]!.label, "Set up widget project");

	const lone = `## Implementation\n\n1. Solo step [parallel]\n2. Separate step\n`;
	const loneTasks = tasksFromPlanText(lone, "");
	assert.equal(loneTasks[0]!.parallel, undefined);

	// Step bodies that merely mention `[parallel]` in inline code are not marked.
	const mentions = `## Implementation\n\n1. Honor \`[parallel]\` when appending\n2. Keep \`[parallel]\` in the note\n`;
	assert.deepEqual(tasksFromPlanText(mentions, "").map((task) => task.parallel), [undefined, undefined]);
});

test("resume and only scope plan steps", () => {
	const resumed = tasksFromPlanText(plan, "resume from step 2");
	assert.deepEqual(resumed.map((task) => task.label), ["Build widget API", "Build widget UI", "Document widget"]);
	assert.ok(resumed[0]!.task.startsWith("Implement plan step 2:"));

	const only = tasksFromPlanText(plan, "only step 3");
	assert.equal(only.length, 1);
	assert.ok(only[0]!.task.startsWith("Implement plan step 3:"));
	assert.equal(only[0]!.parallel, undefined);

	const guided = tasksFromPlanText(plan, "continue at item #4 keep it lazy");
	assert.equal(guided.length, 1);
	assert.match(guided[0]!.task, /^Implement plan step 4:/);
	assert.match(guided[0]!.task, /Extra instruction: continue at item #4 keep it lazy$/);
});

test("saved resume step scopes a bare /work without becoming child guidance", () => {
	const resumed = tasksFromPlanText(plan, "", "3");
	assert.deepEqual(resumed.map((task) => task.label), ["Build widget UI", "Document widget"]);
	assert.match(resumed[0]!.task, /^Implement plan step 3:/);
	assert.doesNotMatch(resumed[0]!.task, /Extra instruction/);

	// Steps already done beyond the interrupted one are skipped, not re-run.
	assert.deepEqual(tasksFromPlanText(plan, "", "2", ["3"]).map((task) => task.label), ["Build widget API", "Document widget"]);

	// Explicit text still wins over the saved step.
	assert.equal(tasksFromPlanText(plan, "resume from step 2", "4").length, 3);
	assert.deepEqual(tasksFromPlanText(plan, "only step 1", "3").map((task) => task.label), ["Set up widget project"]);
});

test("plan steps keep track and issue refs with detail lines intact", () => {
	const trackSteps = `# Plan

Track: widget-api

## Implementation

1. Add route [parallel]
   Track: widget-api
   Issue: Add route
   Route detail line.
2. Render list
   - Track: widget-ui
   - Issue: Render list

## Validation

1. Human check
`;
	const tasks = tasksFromPlanText(trackSteps, "keep it lazy");
	assert.deepEqual(tasks.map((task) => [task.track, task.issue]), [["widget-api", "Add route"], ["widget-ui", "Render list"]]);
	assert.equal(tasks[0]!.label, "Add route");
	assert.equal(tasks[0]!.task, "Implement plan step 1: Add route\n   Track: widget-api\n   Issue: Add route\n   Route detail line.\n\nExtra instruction: keep it lazy");
});

test("plan parsing falls back when no numbered steps exist", () => {
	const fallback = tasksFromPlanText("# Goal\n\nJust prose.\n", "do the next chunk");
	assert.equal(fallback.length, 1);
	assert.equal(fallback[0]!.label, "Lean work");
	assert.match(fallback[0]!.task, /do the next chunk/);
	assert.match(fallback[0]!.task, /Plan:\n# Goal/);

	const noPlan = tasksFromPlanText(undefined, "");
	assert.deepEqual(noPlan, [{ agent: "worker", label: "Lean work", task: "Implement the next approved chunk." }]);
});

test("path refs find file references, not commands or URLs", () => {
	assert.deepEqual(pathRefs("Touch `src/flow.ts:12` and README.md, not /work-add or https://example.dev/a.ts."), ["src/flow.ts", "README.md"]);
	assert.deepEqual(pathRefs("Update `/home/me/repo/file.md`, keep docs"), ["/home/me/repo/file.md"]);
	assert.deepEqual(pathRefs("Run /work-add and /plan"), []);
});

test("plan track reads the Track line", () => {
	assert.equal(planTrack("# Plan\n\nTrack: widget-ui\n"), "widget-ui");
	assert.equal(planTrack("Track:   spaced name  "), "spaced name");
	assert.equal(planTrack("no track here"), undefined);
	assert.equal(planTrack("Track:\n"), undefined);
});

const trackPlan = `# Plan

Intro.

## widget-api

- [ ] Add route
  Route detail line.
- [-] Add test
\tTest detail.
- [x] Ship docs
  Docs detail.

## widget-ui

- [ ] Render list
- [x] Wire button

## done-track

- [x] All done
  Old detail.
`;

test("parseTracks reads three statuses, text, and indented detail", () => {
	const tracks = parseTracks(trackPlan);
	assert.deepEqual(tracks.map((track) => track.name), ["widget-api", "widget-ui", "done-track"]);
	assert.deepEqual(tracks[0]!.issues, [
		{ text: "Add route", status: "pending", detail: "Route detail line." },
		{ text: "Add test", status: "started", detail: "Test detail." },
		{ text: "Ship docs", status: "completed", detail: "Docs detail." },
	]);
	assert.deepEqual(tracks[1]!.issues, [
		{ text: "Render list", status: "pending", detail: "" },
		{ text: "Wire button", status: "completed", detail: "" },
	]);
	assert.deepEqual(tracks[2]!.issues, [{ text: "All done", status: "completed", detail: "Old detail." }]);
	assert.deepEqual(parseTracks("- [ ] orphan before any track\n"), []);
});

test("indented issue-looking detail stays with its open issue", () => {
	const text = "## widget-api\n\n- [ ] Add route\n  - [ ] note looks like an issue\n  - [-] another note\n- [ ] Next issue\n";
	assert.deepEqual(parseTracks(text)[0]!.issues, [
		{ text: "Add route", status: "pending", detail: "- [ ] note looks like an issue\n- [-] another note" },
		{ text: "Next issue", status: "pending", detail: "" },
	]);
});

test("setIssueStatus flips one marker and keeps detail", () => {
	const flipped = setIssueStatus(trackPlan, "widget-api", "Add test", "completed");
	assert.deepEqual(
		parseTracks(flipped)[0]!.issues.map((issue) => [issue.text, issue.status, issue.detail]),
		[
			["Add route", "pending", "Route detail line."],
			["Add test", "completed", "Test detail."],
			["Ship docs", "completed", "Docs detail."],
		],
	);
	assert.equal(setIssueStatus(trackPlan, "missing", "Add test", "completed"), trackPlan);
});

test("appendIssue adds a pending issue under an existing track", () => {
	const appended = appendIssue(trackPlan, "widget-ui", "Add tooltip", "Tooltip detail.\nSecond line.");
	const ui = parseTracks(appended)[1]!;
	assert.deepEqual(ui.issues.at(-1), { text: "Add tooltip", status: "pending", detail: "Tooltip detail.\nSecond line." });
	assert.match(appended, /- \[x\] Wire button\n- \[ \] Add tooltip\n  Tooltip detail.\n  Second line.\n\n## done-track/);
	assert.equal(appendIssue(trackPlan, "missing", "Nope"), trackPlan);
});

test("clearCompleted drops done issues plus detail and fully done tracks", () => {
	assert.equal(clearCompleted(trackPlan), `# Plan

Intro.

## widget-api

- [ ] Add route
  Route detail line.
- [-] Add test
\tTest detail.

## widget-ui

- [ ] Render list
`);
});

test("clearCompleted keeps lookalike-checkbox detail under a pending issue but drops it with a completed one", () => {
	const plan = `## t

- [ ] Keep me
  - [x] Nested note
  - [ ] Another note
- [x] Drop me
  - [x] Nested done
`;
	assert.equal(clearCompleted(plan), `## t

- [ ] Keep me
  - [x] Nested note
  - [ ] Another note
`);
	assert.deepEqual(parseTracks(clearCompleted(plan))[0]!.issues, [
		{ text: "Keep me", status: "pending", detail: "- [x] Nested note\n- [ ] Another note" },
	]);
});

test("clearCompleted review repros and fully done tracks agree with parseTracks", () => {
	// Repro: a completed issue above an open-looking detail drops both, not just the issue.
	const completedAboveOpen = `## t

- [x] Done
  - [ ] open-looking detail
- [ ] Next
`;
	assert.equal(clearCompleted(completedAboveOpen), `## t

- [ ] Next
`);

	// Repro: a pending issue above a completed-looking detail keeps both.
	const pendingAboveCompleted = `## t

- [ ] Pending
  - [x] done-looking detail
`;
	assert.equal(clearCompleted(pendingAboveCompleted), pendingAboveCompleted);

	// A fully done track is dropped whole, even when its detail looks like an open issue.
	const fullyDone = `## t

- [x] Done
  - [ ] open-looking detail

## u

- [ ] Keep
`;
	assert.equal(clearCompleted(fullyDone), `## u

- [ ] Keep
`);
	assert.deepEqual(parseTracks(clearCompleted(fullyDone)).map((track) => track.name), ["u"]);
});

test("task labels strip markers and stopwords", () => {
	assert.equal(taskLabel("Build the API [parallel]"), "Build API");
	assert.equal(taskLabel("`wire` the **UI** [parallel:ui]"), "wire UI");
	assert.equal(taskLabel("☆ Swap pi cyan: in `~/.pi/agent/themes/gruvbox.json` set both vars"), "Swap pi cyan");
	assert.equal(taskLabel("Fix /home/domantas/src/Flow/README.md"), "Fix README");
	assert.equal(taskLabel("/home/domantas/src/Flow/README.md: add the copy layout"), "README");
	assert.equal(taskLabel("Update src/flow.ts and tests"), "Update flow");
	assert.equal(taskLabel("`/home/domantas/src/Flow/lean-flow-plan.ts`"), "lean-flow-plan.ts");
	assert.equal(taskLabel("`/home/domantas/src/Flow/README.md`: add `lean-flow-plan.ts`"), "README.md");
	assert.equal(shortPath("/home/domantas/src/Flow/README.md:"), "README.md");
	assert.equal(shortPath("C:\\repo\\src\\flow.ts"), "flow.ts");
	assert.equal(shortPath("plain"), "plain");
	// A leading-slash command is not a path, so it is never reduced to a basename.
	assert.equal(taskLabel("`/work-add <text>` writes plan.md"), "work-add text writes plan.md");
	assert.equal(shortPath("/work-add"), "/work-add");
	assert.equal(taskLabel("Build the widget API with validation support"), "Build widget API validation support");
	assert.equal(taskLabel("Ship the widget [parallel:ui]"), "Ship widget");
	assert.equal(taskLabel(""), "Lean work");
	// A step whose leading phrase is only a stopword names its file instead.
	assert.equal(taskLabel("In `~/src/Flow/lean-flow-plan.ts` change TrackIssue"), "lean-flow-plan.ts");
	assert.equal(taskLabel("In `~/.config/herdr-app/layouts/main.json` move the tracks block"), "main.json");
});

test("task labels cut at paths and fall back for code-only text", () => {
	// Path-first step: the leading path contributes its basename without the extension.
	assert.equal(taskLabel("src/flow.ts: add the route"), "flow");
	// Backticked path mid-sentence: the leading phrase before the code span wins.
	assert.equal(taskLabel("Update `src/flow.ts` and the tests"), "Update");
	// Repo-rooted path: same cut, without a leading slash.
	assert.equal(taskLabel("README.md: add the copy layout"), "README");
	// Code-only text leaves no leading phrase, so the legacy label behavior applies.
	assert.equal(taskLabel("`/home/domantas/src/Flow/README.md`"), "README.md");
});

test("artifact names encode timestamp, branch, index, and label", () => {
	const date = new Date("2026-01-02T03:04:05.678Z");
	assert.equal(runId("feature/widget", date), "20260102T030405-feature-widget");
	assert.equal(runId("HEAD", date), "20260102T030405-_detached");
	assert.equal(runId("unknown", date), "20260102T030405-_detached");
	assert.equal(taskFileName(0, "feature-widget", "Build the API"), "01-feature-widget-build-the-api.md");
	assert.equal(taskFileName(9, "main", "Ship it"), "10-main-ship-it.md");
	assert.equal(taskFileName(0, "unknown", "Detached"), "01-_detached-detached.md");
	assert.equal(taskFileName(1, "feature/Widget API", "Ship it"), "02-feature-widget-api-ship-it.md");
});

test("retention keeps the newest run ids", () => {
	const ids = ["20260101T000000-main", "20260103T000000-main", "20260102T000000-main", "20260104T000000-main"];
	assert.deepEqual(staleRunIds(ids), ["20260101T000000-main"]);
	assert.deepEqual(staleRunIds(ids, 1), [
		"20260103T000000-main",
		"20260102T000000-main",
		"20260101T000000-main",
	]);
	assert.deepEqual(staleRunIds(ids, 0), [...ids].sort().reverse());
	assert.deepEqual(staleRunIds(ids, 10), []);
});

test("appendPlanStep numbers the next step and stays inside Implementation", () => {
	const next = appendPlanStep("# Goal\n\n## Implementation\n\n1. First\n2. Second\n\n## Not tasks\n\n- Human check\n", "Fix harness [parallel]");
	assert.equal(next.step, "3");
	assert.equal(next.text, "# Goal\n\n## Implementation\n\n1. First\n2. Second\n3. Fix harness [parallel]\n## Not tasks\n\n- Human check\n");
	assert.equal(planStepsFromText(next.text).steps.at(-1)?.parallel, true);
	const appended = appendPlanStep(next.text, "Add tail");
	assert.match(appended.text, /4\. Add tail\n## Not tasks/);
});

test("REVIEW verdict parses only the final line", () => {
	assert.equal(reviewVerdict("finding one\n\nREVIEW: clean"), "clean");
	assert.equal(reviewVerdict("REVIEW: blocking\n"), "blocking");
	assert.equal(reviewVerdict("review:  CLEAN"), "clean");
	assert.equal(reviewVerdict("REVIEW: blocking\none more note"), undefined);
	assert.equal(reviewVerdict("no verdict here"), undefined);
	assert.equal(reviewVerdict(""), undefined);
});
