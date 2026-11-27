// Pure lean-flow plan/run contracts. Entry point: node --test tests/*.test.ts.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	appendPlanStep,
	branchSlug,
	completedTracks,
	doneTickets,
	filterTickets,
	INBOX_DIR,
	migrateTracksMd,
	mintTicketId,
	parseTicketFile,
	parseTicketFilters,
	parseTracks,
	pathRefs,
	planGoal,
	planImplementation,
	planStepCount,
	planStepsFromText,
	planTrack,
	readTracksTree,
	reviewVerdict,
	rewriteTicketStatus,
	serializeTicketFile,
	shortPath,
	runId,
	slugify,
	staleRunIds,
	taskFileName,
	taskLabel,
	tasksFromPlanText,
	ticketCounts,
	ticketFileName,
	ticketIndexLines,
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

test("plan steps keep track and ticket refs with detail lines intact", () => {
	const trackSteps = `# Plan

Track: widget-api

## Implementation

1. Add route [parallel]
   Track: widget-api
   Ticket: Add route
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
	assert.equal(tasks[0]!.task, "Implement plan step 1: Add route\n   Track: widget-api\n   Ticket: Add route\n   Route detail line.\n\nExtra instruction: keep it lazy");
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

test("readTracksTree parses nested folders and issue files", () => {
	const root = mkdtempSync(join(tmpdir(), "lean-tracks-"));
	try {
		mkdirSync(join(root, "area", "sub"), { recursive: true });
		writeFileSync(join(root, "area", "sub", "bug-a1b2c3-fix-route.md"), "---\nstatus: started\n---\n\n# Fix route\n\nRoute detail.\n");
		writeFileSync(join(root, "area", "sub", "feature-d4e5f6-no-heading.md"), "---\nstatus: done\n---\n\nBody without heading.\n");
		writeFileSync(join(root, "area", "notes.txt"), "not an issue");
		writeFileSync(join(root, "rnd-abc123-solo.md"), "# Solo issue\n");

		const tree = readTracksTree(root);
		assert.deepEqual(tree.children.map((child) => child.name), ["area"]);
		assert.deepEqual(tree.issues.map((issue) => issue.path), ["rnd-abc123-solo.md"]);

		const area = tree.children[0]!;
		assert.equal(area.path, "area");
		assert.deepEqual(area.issues, []);
		assert.deepEqual(area.children.map((child) => child.name), ["sub"]);

		const sub = area.children[0]!;
		assert.equal(sub.path, "area/sub");
		assert.deepEqual(sub.issues.map((issue) => [issue.id, issue.type, issue.title, issue.status, issue.body, issue.track, issue.path]), [
			["a1b2c3", "bug", "Fix route", "started", "Route detail.", "area/sub", "area/sub/bug-a1b2c3-fix-route.md"],
			["d4e5f6", "feature", "no-heading", "done", "Body without heading.", "area/sub", "area/sub/feature-d4e5f6-no-heading.md"],
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ticket file frontmatter status round-trips", () => {
	for (const status of ["todo", "started", "done"] as const) {
		const path = "area/feature-abc123-round-trip.md";
		const text = serializeTicketFile({ type: "feature", title: "Round trip", status, body: "First line.\n\nSecond line." });
		const parsed = parseTicketFile(text, path);
		assert.deepEqual(parsed, { id: "abc123", type: "feature", status, title: "Round trip", body: "First line.\n\nSecond line.", track: "area", path });
		assert.equal(serializeTicketFile(parsed), text);
	}

	assert.deepEqual(parseTicketFile("# Title only\n", "bug-a1b2c3-title-only.md"), { id: "a1b2c3", type: "bug", status: "todo", title: "Title only", body: "", track: "", path: "bug-a1b2c3-title-only.md" });
	assert.deepEqual(parseTicketFile("plain body\n", "feature-0a0b0c-fallback.md"), { id: "0a0b0c", type: "feature", status: "todo", title: "fallback", body: "plain body", track: "", path: "feature-0a0b0c-fallback.md" });
	assert.equal(parseTicketFile("---\nstatus: blocked\n---\n# X\n", "rnd-ffffff-x.md").status, "todo");
});

test("ticket filenames mint and parse round-trip", () => {
	const id = mintTicketId();
	assert.match(id, /^[0-9a-f]{6}$/);

	const name = ticketFileName({ type: "bug", id, title: "Fix the route: now!" });
	assert.equal(name, `bug-${id}-fix-the-route-now.md`);
	const text = serializeTicketFile({ type: "bug", status: "started", title: "Fix the route: now!", body: "Route body." });
	assert.deepEqual(parseTicketFile(text, `area/${name}`), {
		id,
		type: "bug",
		status: "started",
		title: "Fix the route: now!",
		body: "Route body.",
		track: "area",
		path: `area/${name}`,
	});

	const used = { name: "", path: "", children: [], issues: [parseTicketFile(text, name)] };
	assert.match(mintTicketId(used), /^[0-9a-f]{6}$/);
	assert.equal(new Set(Array.from({ length: 100 }, () => mintTicketId())).size, 100);
});

test("rewriteTicketStatus keeps extra frontmatter keys, CRLF, and body bytes", () => {
	const text = "---\r\nstatus: todo\r\ntype: bug\r\n---\r\n\r\n# Fix route\r\n\r\nBody line.\r\n";
	const rewritten = rewriteTicketStatus(text, "done");
	assert.equal(rewritten, "---\r\nstatus: done\r\ntype: bug\r\n---\r\n\r\n# Fix route\r\n\r\nBody line.\r\n");
	assert.equal(parseTicketFile(rewritten, "bug-a1b2c3-fix-route.md").status, "done");
	assert.equal(parseTicketFile(rewritten, "bug-a1b2c3-fix-route.md").body, "Body line.");

	assert.equal(rewriteTicketStatus("---\ntype: feature\n---\n\n# A\n", "started"), "---\nstatus: started\ntype: feature\n---\n\n# A\n");
	assert.equal(rewriteTicketStatus("# A\n", "todo"), "---\nstatus: todo\n---\n# A\n");
});

test("parseTicketFilters lifts only validated values and leaves the rest as guidance", () => {
	assert.deepEqual(parseTicketFilters("track area type:bug status started #abc release notes"), {
		filters: { track: "area", type: "bug", status: "started", idPrefix: "abc" },
		rest: ["release", "notes"],
	});
	assert.deepEqual(parseTicketFilters("type:bug"), { filters: { type: "bug" }, rest: [] });
	assert.deepEqual(parseTicketFilters("type:location status nearby"), { filters: {}, rest: ["type:location", "status", "nearby"] });
});

test("filterTickets combines track prefixes with type, status, and id prefixes", () => {
	const ticket = (path: string, title: string, status: "todo" | "started" | "done") => parseTicketFile(`---\nstatus: ${status}\n---\n\n# ${title}\n`, path, path.split("/").slice(0, -1).join("/"));
	const tree = {
		name: "",
		path: "",
		issues: [ticket("feature-aaa111-root.md", "Root", "todo")],
		children: [{
			name: "area",
			path: "area",
		issues: [ticket("area/bug-bbb222-area.md", "Area bug", "started"), ticket("area/rnd-ccc333-done.md", "Area rnd", "done")],
			children: [{ name: "sub", path: "area/sub", issues: [ticket("area/sub/feature-ddd444-sub.md", "Sub", "todo")], children: [] }],
		}],
	};
	const paths = (filters: Parameters<typeof filterTickets>[1]) => filterTickets(tree, filters).map((ticket) => ticket.path);

	assert.deepEqual(paths({}), ["feature-aaa111-root.md", "area/bug-bbb222-area.md", "area/rnd-ccc333-done.md", "area/sub/feature-ddd444-sub.md"]);
	assert.deepEqual(paths({ track: "area" }), ["area/bug-bbb222-area.md", "area/rnd-ccc333-done.md", "area/sub/feature-ddd444-sub.md"]);
	assert.deepEqual(paths({ track: "/area/sub/" }), ["area/sub/feature-ddd444-sub.md"]);
	assert.deepEqual(paths({ type: "bug" }), ["area/bug-bbb222-area.md"]);
	assert.deepEqual(paths({ status: "todo" }), ["feature-aaa111-root.md", "area/sub/feature-ddd444-sub.md"]);
	assert.deepEqual(paths({ idPrefix: "#ccc" }), ["area/rnd-ccc333-done.md"]);
	assert.deepEqual(paths({ idPrefix: "ddd", track: "area/sub", type: "feature" }), ["area/sub/feature-ddd444-sub.md"]);
	assert.deepEqual(paths({ track: "area", type: "rnd" }), ["area/rnd-ccc333-done.md"]);
	assert.deepEqual(paths({ type: "bug", status: "todo" }), []);

	const all = filterTickets(tree);
	assert.equal(ticketIndexLines(all, 2), "feature aaa111 todo (root) Root\nbug bbb222 started area Area bug\n…2 more");
	assert.equal(ticketIndexLines([all[0]!], 5), "feature aaa111 todo (root) Root");
	assert.equal(ticketIndexLines(all, 0), "…4 more");
});

test("completedTracks selects all-done and empty tracks, skipping a parent with one started child", () => {
	const done = (path: string) => parseTicketFile("---\nstatus: done\n---\n\n# Done\n", path, path.split("/").slice(0, -1).join("/"));
	const allDone = {
		name: "",
		path: "",
		issues: [],
		children: [{
			name: "area",
			path: "area",
			issues: [done("area/feature-aaa111-a.md")],
			children: [{ name: "nested", path: "area/nested", issues: [done("area/nested/bug-bbb222-b.md")], children: [] }],
		}],
	};
	assert.deepEqual(completedTracks(allDone).map((track) => track.path), ["area", "area/nested"]);

	const empty = {
		name: "",
		path: "",
		issues: [],
		children: [{ name: "empty", path: "empty", issues: [], children: [{ name: "nested-empty", path: "empty/nested-empty", issues: [], children: [] }] }],
	};
	assert.deepEqual(completedTracks(empty).map((track) => track.path), ["empty", "empty/nested-empty"]);

	const startedChild = {
		name: "",
		path: "",
		issues: [],
		children: [{
			name: "pending",
			path: "pending",
			issues: [done("pending/feature-ccc333-c.md")],
			children: [{ name: "child", path: "pending/child", issues: [parseTicketFile("---\nstatus: started\n---\n\n# Started\n", "pending/child/bug-ddd444-d.md")], children: [] }],
		}],
	};
	assert.deepEqual(completedTracks(startedChild).map((track) => track.path), []);
});

test("doneTickets selects plain and nested done tickets and none when every ticket is open", () => {
	const ticket = (path: string, status: "todo" | "started" | "done") => parseTicketFile(`---\nstatus: ${status}\n---\n\n# Ticket\n`, path, path.split("/").slice(0, -1).join("/"));
	const tree = {
		name: "",
		path: "",
		issues: [ticket("bug-aaa111-root-done.md", "done"), ticket("feature-bbb222-root-open.md", "todo")],
		children: [{
			name: "area",
			path: "area",
			issues: [ticket("area/rnd-ccc333-area-done.md", "done")],
			children: [{
				name: "sub",
				path: "area/sub",
				issues: [ticket("area/sub/feature-ddd444-sub-done.md", "done"), ticket("area/sub/bug-eee555-sub-started.md", "started")],
				children: [],
			}],
		}],
	};
	assert.deepEqual(doneTickets(tree).map((item) => item.path), [
		"bug-aaa111-root-done.md",
		"area/rnd-ccc333-area-done.md",
		"area/sub/feature-ddd444-sub-done.md",
	]);

	const open = {
		name: "",
		path: "",
		issues: [ticket("feature-fff666-open.md", "todo")],
		children: [{ name: "busy", path: "busy", issues: [ticket("busy/bug-111aaa-started.md", "started")], children: [] }],
	};
	assert.deepEqual(doneTickets(open), []);
});

test("readTracksTree keeps empty folders as tracks", () => {
	const root = mkdtempSync(join(tmpdir(), "lean-empty-"));
	try {
		mkdirSync(join(root, "empty", "nested-empty"), { recursive: true });
		const tree = readTracksTree(root);
		assert.deepEqual(tree.children.map((child) => [child.name, child.path, child.issues, child.children.map((nested) => nested.name)]), [
			["empty", "empty", [], ["nested-empty"]],
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("migrateTracksMd writes folders and issue files with detail", async () => {
	const root = mkdtempSync(join(tmpdir(), "lean-migrate-"));
	try {
		const tracksMd = join(root, "tracks.md");
		const tracksDir = join(root, ".pi", "tracks");
		writeFileSync(tracksMd, `# Tracks

## widget-api

- [ ] Add route
  Route detail line.
  Second route line.
- [-] Add test
\tTabbed detail.
- [x] Ship docs

## area/sub

- [ ] Nested issue
  Nested detail.
`);

		assert.equal(await migrateTracksMd(tracksMd, tracksDir), 4);
		assert.ok(existsSync(tracksMd), "tracks.md stays for humans to compare");
		assert.equal(await migrateTracksMd(tracksMd, tracksDir), 0, "second run is a no-op");

		const tree = readTracksTree(tracksDir);
		assert.deepEqual(tree.children.map((child) => child.name), ["area", "widget-api"]);
		assert.deepEqual(tree.children[0]!.children[0]!.issues.map((issue) => [issue.type, issue.title, issue.status, issue.body]), [
			["feature", "Nested issue", "todo", "Nested detail."],
		]);
		const issues = new Map(tree.children[1]!.issues.map((issue) => [issue.title, issue]));
		assert.deepEqual([...issues.values()].sort((a, b) => a.title.localeCompare(b.title)).map((issue) => [issue.type, issue.title, issue.status, issue.body]), [
			["feature", "Add route", "todo", "Route detail line.\nSecond route line."],
			["feature", "Add test", "started", "Tabbed detail."],
			["feature", "Ship docs", "done", ""],
		]);
		assert.match(issues.get("Add route")!.path, /^widget-api\/feature-[0-9a-f]{6}-add-route\.md$/);
		assert.match(issues.get("Add test")!.path, /^widget-api\/feature-[0-9a-f]{6}-add-test\.md$/);
		assert.match(issues.get("Ship docs")!.path, /^widget-api\/feature-[0-9a-f]{6}-ship-docs\.md$/);
		assert.match(readFileSync(join(tracksDir, issues.get("Add route")!.path), "utf8"), /^---\nstatus: todo\ntype: feature\n---\n\n# Add route\n\nRoute detail line\.\nSecond route line\.\n$/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("migrateTracksMd skips the ledger once the .migrated marker exists", async () => {
	const root = mkdtempSync(join(tmpdir(), "lean-marker-"));
	try {
		const tracksMd = join(root, "tracks.md");
		const tracksDir = join(root, ".pi", "tracks");
		writeFileSync(tracksMd, `## widget-api\n\n- [ ] Keep me\n- [ ] Delete me\n`);

		assert.equal(await migrateTracksMd(tracksMd, tracksDir), 2);
		assert.ok(existsSync(join(tracksDir, ".migrated")), "a completed import writes the marker");
		rmSync(join(tracksDir, "widget-api"), { recursive: true });
		assert.deepEqual(readTracksTree(tracksDir).children, [], "the tree is empty");

		assert.equal(await migrateTracksMd(tracksMd, tracksDir), 0, "the marker skips re-importing the ledger");
		assert.deepEqual(readTracksTree(tracksDir).children, [], "deleted tickets and tracks stay deleted");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("migrateTracksMd merges only missing ledger issues into a populated tree", async () => {
	const root = mkdtempSync(join(tmpdir(), "lean-merge-"));
	try {
		const tracksMd = join(root, "tracks.md");
		const tracksDir = join(root, ".pi", "tracks");
		mkdirSync(join(tracksDir, "widget-api"), { recursive: true });
		writeFileSync(join(tracksDir, "widget-api", "feature-aaaaaa-keep-me.md"), "---\nstatus: started\ntype: feature\n---\n\n# Keep me\n\nOld body.\n");

		writeFileSync(tracksMd, `## widget-api\n\n- [ ] Keep me\n- [ ] Add me\n  New detail.\n`);
		assert.equal(await migrateTracksMd(tracksMd, tracksDir), 1, "only the missing issue is added");
		const tickets = filterTickets(readTracksTree(tracksDir), { track: "widget-api" });
		assert.deepEqual(tickets.map((ticket) => ticket.title).sort(), ["Add me", "Keep me"]);
		const kept = tickets.find((ticket) => ticket.title === "Keep me")!;
		assert.deepEqual([kept.id, kept.path, kept.status, kept.body], ["aaaaaa", "widget-api/feature-aaaaaa-keep-me.md", "started", "Old body."]);
		assert.deepEqual(tickets.find((ticket) => ticket.title === "Add me")!.body, "New detail.");
		assert.equal(await migrateTracksMd(tracksMd, tracksDir), 0, "second run is a no-op");
		assert.deepEqual(filterTickets(readTracksTree(tracksDir), { track: "widget-api" }), tickets, "existing ids and bodies are unchanged");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("migrateTracksMd moves root tickets into inbox and filterTickets loses (root)", async () => {
	const root = mkdtempSync(join(tmpdir(), "lean-inbox-"));
	try {
		const tracksDir = join(root, ".pi", "tracks");
		mkdirSync(tracksDir, { recursive: true });
		const typed = "feature-abcdef-root-note.md";
		writeFileSync(join(tracksDir, typed), "---\nstatus: started\ntype: feature\n---\n\n# Root note\n\nBody.\n");
		writeFileSync(join(tracksDir, "loose-note.md"), "---\nstatus: todo\n---\n\n# Loose note\n");

		await migrateTracksMd(join(root, "tracks.md"), tracksDir);
		assert.deepEqual(readdirSync(tracksDir).filter((name) => /\.md$/i.test(name)), []);
		const inboxNames = readdirSync(join(tracksDir, INBOX_DIR)).sort();
		assert.equal(inboxNames.length, 2);
		assert.ok(inboxNames.includes(typed));
		const renamed = inboxNames.find((name) => name !== typed)!;
		assert.match(renamed, /^feature-[0-9a-f]{6}-loose-note\.md$/);

		const tree = readTracksTree(tracksDir);
		const tickets = filterTickets(tree);
		assert.deepEqual(tickets.map((ticket) => ticket.track), [INBOX_DIR, INBOX_DIR]);
		assert.deepEqual(filterTickets(tree, { track: INBOX_DIR }).map((ticket) => ticket.title).sort(), ["Loose note", "Root note"]);
		assert.doesNotMatch(ticketIndexLines(tickets), /\(root\)/);
		assert.deepEqual(ticketCounts(tree), { [INBOX_DIR]: 2 });

		const moved = readFileSync(join(tracksDir, INBOX_DIR, typed), "utf8");
		assert.equal(serializeTicketFile(parseTicketFile(moved, `${INBOX_DIR}/${typed}`)), moved);
		assert.equal(await migrateTracksMd(join(root, "tracks.md"), tracksDir), 0, "second run is a no-op");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("migrateTracksMd renames legacy slug tickets once and keeps typed files", async () => {
	const root = mkdtempSync(join(tmpdir(), "lean-rename-"));
	try {
		const tracksDir = join(root, ".pi", "tracks");
		mkdirSync(join(tracksDir, "area"), { recursive: true });
		writeFileSync(join(tracksDir, "area", "old-note.md"), "---\nstatus: started\n---\n\n# Old note\n\nLegacy body.\n");
		writeFileSync(join(tracksDir, "area", "feature-abcdef-keep.md"), "# Keep\n");

		await migrateTracksMd(join(root, "tracks.md"), tracksDir);
		const names = readdirSync(join(tracksDir, "area")).sort();
		assert.equal(names.length, 2);
		assert.ok(names.includes("feature-abcdef-keep.md"));
		const renamed = names.find((name) => name !== "feature-abcdef-keep.md")!;
		assert.match(renamed, /^feature-[0-9a-f]{6}-old-note\.md$/);
		assert.deepEqual(readTracksTree(tracksDir).children[0]!.issues.find((issue) => issue.id !== "abcdef"), {
			id: renamed.slice(8, 14),
			type: "feature",
			status: "started",
			title: "Old note",
			body: "Legacy body.",
			track: "area",
			path: `area/${renamed}`,
		});
		assert.equal(await migrateTracksMd(join(root, "tracks.md"), tracksDir), 0, "second run is a no-op");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
