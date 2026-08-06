#!/usr/bin/env node
// Shared /map CLI over map-tracker.ts, so any agent (pi's map.ts, a Claude Code
// skill, a human) reads/writes the exact same maps/ state through one engine.
// Usage: node --experimental-strip-types map-cli.ts <planning-root> <action> ['<json-params>']
// Prints one JSON object to stdout on success, exits 0. On error, prints
// {"error": "..."} to stderr and exits 1.

import {
	addOutOfScope,
	checkCompletion,
	claimTicket,
	createMap,
	createTicket,
	frontier,
	initConfig,
	listEfforts,
	listTickets,
	markOutOfScope,
	readConfig,
	readMap,
	releaseClaim,
	resolveTicket,
	setBlockers,
	setFog,
	writeHandoff,
	type TicketDocument,
} from "../.pi/extensions/map-tracker.ts";

async function effortStatus(root: string, effort: string) {
	const map = await readMap(root, effort);
	const tickets = await listTickets(root, effort);
	return { effort, map, tickets, frontier: frontier(tickets) };
}

function requireEffort(params: Record<string, unknown>): string {
	const effort = params.effort;
	if (typeof effort !== "string" || !effort.trim()) throw new Error("params.effort is required");
	return effort;
}

function requireNumber(params: Record<string, unknown>): number {
	const number = params.number;
	if (!Number.isInteger(number) || (number as number) < 1) throw new Error("params.number must be a positive integer");
	return number as number;
}

async function dispatch(root: string, action: string, params: Record<string, unknown>): Promise<unknown> {
	switch (action) {
		case "init":
			return initConfig(root, String(params.target ?? ""));
		case "config":
			return readConfig(root);
		case "list":
			return listEfforts(root);
		case "status": {
			if (params.effort) return effortStatus(root, requireEffort(params));
			const efforts = await listEfforts(root);
			return Promise.all(efforts.map((effort) => effortStatus(root, effort)));
		}
		case "map":
			return readMap(root, requireEffort(params));
		case "ticket": {
			const tickets = await listTickets(root, requireEffort(params));
			const ticket = tickets.find((item) => item.number === requireNumber(params));
			if (!ticket) throw new Error(`Ticket ${params.number} does not exist`);
			return ticket;
		}
		case "create-map":
			return createMap(root, requireEffort(params), {
				name: String(params.name ?? ""),
				destination: String(params.destination ?? ""),
				notes: String(params.notes ?? "None."),
				fog: String(params.fog ?? "None."),
				outOfScope: String(params.outOfScope ?? "None."),
			});
		case "create-ticket":
			return createTicket(root, requireEffort(params), {
				title: String(params.title ?? ""),
				type: params.type as TicketDocument["type"],
				question: String(params.question ?? ""),
			});
		case "blockers":
			return setBlockers(root, requireEffort(params), requireNumber(params), (params.blockedBy as number[]) ?? []);
		case "claim":
			return claimTicket(root, requireEffort(params), requireNumber(params), String(params.claimant ?? ""));
		case "release":
			return releaseClaim(root, requireEffort(params), requireNumber(params), String(params.claimant ?? ""));
		case "resolve":
			return resolveTicket(root, requireEffort(params), requireNumber(params), String(params.claimant ?? ""), String(params.answer ?? ""), String(params.gist ?? ""));
		case "fog":
			return setFog(root, requireEffort(params), String(params.text ?? "None."));
		case "add-out-of-scope":
			return addOutOfScope(root, requireEffort(params), String(params.text ?? ""));
		case "mark-out-of-scope":
			return markOutOfScope(root, requireEffort(params), requireNumber(params), String(params.text ?? ""), params.claimant as string | undefined);
		case "finish": {
			const effort = requireEffort(params);
			const status = await effortStatus(root, effort);
			const completion = checkCompletion(status.map, status.tickets);
			if (!completion.complete) throw new Error(`Cannot finish ${effort}: ${completion.reasons.join("; ")}`);
			return { handoff: await writeHandoff(root, effort) };
		}
		default:
			throw new Error(`Unknown action: ${action}. Actions: init, config, list, status, map, ticket, create-map, create-ticket, blockers, claim, release, resolve, fog, add-out-of-scope, mark-out-of-scope, finish`);
	}
}

const [root, action, rawParams] = process.argv.slice(2);
if (!root || !action) {
	console.error(JSON.stringify({ error: "Usage: map-cli.ts <planning-root> <action> ['<json-params>']" }));
	process.exit(1);
}
let params: Record<string, unknown> = {};
if (rawParams) {
	try {
		params = JSON.parse(rawParams);
	} catch (error) {
		console.error(JSON.stringify({ error: `Invalid JSON params: ${error instanceof Error ? error.message : String(error)}` }));
		process.exit(1);
	}
}
try {
	const result = await dispatch(root, action, params);
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	process.exit(1);
}
