// End-to-end contract tests for the Markdown-backed /map tracker.
// Uses only Node's test runner and temporary directories.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	checkCompletion,
	claimTicket,
	createMap,
	createTicket,
	frontier,
	initConfig,
	listTickets,
	parseMap,
	parseTicket,
	readConfig,
	readMap,
	renderMap,
	renderTicket,
	resolveTicket,
	setBlockers,
	setFog,
	writeHandoff,
	type MapDocument,
	type TicketDocument,
} from "../.pi/extensions/map-tracker.ts";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "lean-flow-map-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

const mapDocument: MapDocument = {
	name: "Launch map",
	destination: "A launch decision ready for planning.",
	notes: "Keep the first release small.",
	decisions: [{ title: "Choose runtime", path: "issues/01-choose-runtime.md", gist: "Use Node." }],
	fog: "Distribution details remain unclear.",
	outOfScope: "Mobile clients.",
};

const ticketDocument: TicketDocument = {
	number: 1,
	slug: "choose-runtime",
	filename: "01-choose-runtime.md",
	title: "Choose runtime",
	type: "research",
	status: "resolved",
	blockedBy: [2, 4],
	claimedBy: undefined,
	question: "Which runtime fits?",
	answer: "Node fits the host.\n\nIt requires no added runtime dependency.",
};

test("initialization stores an adjacent target and rejects missing setup", async (t) => {
	const sandbox = await temporaryDirectory(t);
	const planning = join(sandbox, "planning");
	const target = join(sandbox, "target");
	await Promise.all([mkdir(planning), mkdir(target)]);

	await assert.rejects(readConfig(planning), /run \/map init <target> first/);
	assert.deepEqual(await initConfig(planning, "../target"), { target });
	assert.deepEqual(await readConfig(planning), { target });
	assert.deepEqual(JSON.parse(await readFile(join(planning, ".map.json"), "utf8")), { target: "../target" });
	await assert.rejects(initConfig(planning, "."), /must be different/);
});

test("map and ticket Markdown round-trip without losing canonical fields", () => {
	assert.deepEqual(parseMap(renderMap(mapDocument)), mapDocument);
	assert.deepEqual(parseTicket(renderTicket(ticketDocument), ticketDocument.filename), ticketDocument);
});

test("tickets stay numbered and blocked or claimed work is excluded from the frontier", async (t) => {
	const root = await temporaryDirectory(t);
	await createMap(root, "launch", { ...mapDocument, decisions: [] });
	const first = await createTicket(root, "launch", { title: "First", type: "grilling", question: "First choice?" });
	const second = await createTicket(root, "launch", { title: "Second", type: "task", question: "Second choice?" });
	const third = await createTicket(root, "launch", { title: "Third", type: "prototype", question: "Third choice?" });
	await setBlockers(root, "launch", second.number, [first.number]);
	await claimTicket(root, "launch", third.number, "session-a");

	const tickets = await listTickets(root, "launch");
	assert.deepEqual(tickets.map((ticket) => ticket.number), [1, 2, 3]);
	assert.deepEqual(frontier(tickets).map((ticket) => ticket.number), [1]);
});

test("resolution adds decision pointers, fog graduates to a ticket, completion gates handoff", async (t) => {
	const root = await temporaryDirectory(t);
	await createMap(root, "launch", { ...mapDocument, decisions: [], fog: "Choose a support model once runtime is settled." });
	const runtime = await createTicket(root, "launch", { title: "Choose runtime", type: "research", question: "Which runtime?" });
	const packaging = await createTicket(root, "launch", { title: "Choose packaging", type: "grilling", question: "How is it packaged?" });
	await setBlockers(root, "launch", packaging.number, [runtime.number]);

	let gate = checkCompletion(await readMap(root, "launch"), await listTickets(root, "launch"));
	assert.equal(gate.complete, false);
	assert.match(gate.reasons.join("; "), /open ticket.*Unresolved blockers.*fog remains/);
	await assert.rejects(writeHandoff(root, "launch"), /Map is not complete/);

	await claimTicket(root, "launch", runtime.number, "session-a");
	await resolveTicket(root, "launch", runtime.number, "session-a", "Use Node's built-in facilities.", "Use Node.");
	let map = await readMap(root, "launch");
	assert.deepEqual(map.decisions, [{
		title: "Choose runtime",
		path: "issues/01-choose-runtime.md",
		gist: "Use Node.",
	}]);
	assert.match((await listTickets(root, "launch"))[0].answer ?? "", /built-in facilities/);
	assert.deepEqual(frontier(await listTickets(root, "launch")).map((ticket) => ticket.number), [2]);

	await claimTicket(root, "launch", packaging.number, "session-b");
	await resolveTicket(root, "launch", packaging.number, "session-b", "Ship Markdown files.", "Use Markdown storage.");
	const support = await createTicket(root, "launch", { title: "Choose support model", type: "grilling", question: "Who supports launch?" });
	await setFog(root, "launch", "None.");
	map = await readMap(root, "launch");
	gate = checkCompletion(map, await listTickets(root, "launch"));
	assert.equal(gate.fog, "");
	assert.equal(gate.complete, false);
	assert.deepEqual(gate.open.map((ticket) => ticket.number), [support.number]);

	await claimTicket(root, "launch", support.number, "session-c");
	await resolveTicket(root, "launch", support.number, "session-c", "The platform team owns support.", "Platform owns support.");
	const tickets = await listTickets(root, "launch");
	assert.equal(checkCompletion(await readMap(root, "launch"), tickets).complete, true);

	const handoff = await writeHandoff(root, "launch");
	assert.match(handoff, /^# Launch map — Handoff/m);
	assert.match(handoff, /### \[Choose runtime]\(issues\/01-choose-runtime\.md\)/);
	assert.match(handoff, /Use Node\.\n\nUse Node's built-in facilities\./);
	assert.match(handoff, /### \[Choose support model]\(issues\/03-choose-support-model\.md\)/);
	assert.equal(await readFile(join(root, "maps", "launch", "handoff.md"), "utf8"), handoff);
});
