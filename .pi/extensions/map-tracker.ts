// Markdown-backed state for the /map workflow.
// Entry points: init/read config, create/load maps and tickets, claim/resolve, completion/handoff.
// Split only if the Markdown format or concurrency protocol grows independently.

import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CONFIG_FILE = ".map.json";
export const MAPS_DIR = "maps";

export type TicketType = "research" | "prototype" | "grilling" | "task";
export type TicketStatus = "open" | "claimed" | "resolved" | "out-of-scope";

export interface MapConfig {
	target: string;
}

export interface MapDecision {
	title: string;
	path: string;
	gist: string;
}

export interface MapDocument {
	name: string;
	destination: string;
	notes: string;
	decisions: MapDecision[];
	fog: string;
	outOfScope: string;
}

export interface TicketDocument {
	number: number;
	slug: string;
	filename: string;
	title: string;
	type: TicketType;
	status: TicketStatus;
	blockedBy: number[];
	claimedBy?: string;
	question: string;
	answer?: string;
}

export interface CompletionCheck {
	complete: boolean;
	open: TicketDocument[];
	claimed: TicketDocument[];
	unresolvedBlockers: { ticket: TicketDocument; blockers: number[] }[];
	danglingBlockers: { ticket: TicketDocument; blockers: number[] }[];
	fog: string;
	reasons: string[];
}

export class TrackerConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TrackerConflictError";
	}
}

const TYPES = new Set<TicketType>(["research", "prototype", "grilling", "task"]);
const STATUSES = new Set<TicketStatus>(["open", "claimed", "resolved", "out-of-scope"]);

function required(value: string, label: string): string {
	const clean = value.trim();
	if (!clean) throw new Error(`${label} must not be empty`);
	return clean;
}

function section(markdown: string, heading: string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const start = new RegExp(`^## ${escaped}\\s*$`, "m").exec(markdown);
	if (!start) return "";
	const contentStart = start.index + start[0].length;
	const rest = markdown.slice(contentStart);
	const next = /^##\s+/m.exec(rest);
	return rest.slice(0, next?.index ?? rest.length).trim();
}

function emptyText(value: string): boolean {
	return !value.trim() || /^(?:none|n\/a|nothing|not yet specified)[.!]?$/i.test(value.trim());
}

function assertSimpleName(value: string, label: string): string {
	const name = required(value, label);
	if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
		throw new Error(`${label} must be a single path component`);
	}
	return name;
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
	try {
		await writeFile(temporary, content, "utf8");
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function withEffortLock<T>(effortDir: string, action: () => Promise<T>): Promise<T> {
	const lock = join(effortDir, ".tracker.lock");
	try {
		await mkdir(lock);
	} catch (error: any) {
		if (error?.code === "EEXIST") throw new TrackerConflictError(`Map is being changed by another session: ${effortDir}`);
		throw error;
	}
	try {
		return await action();
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
}

export function configPath(root: string): string {
	return join(resolve(root), CONFIG_FILE);
}

export async function readConfig(root: string): Promise<MapConfig> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(configPath(root), "utf8"));
	} catch (error: any) {
		if (error?.code === "ENOENT") throw new Error(`Missing ${CONFIG_FILE}; run /map init <target> first`);
		if (error instanceof SyntaxError) throw new Error(`Invalid ${CONFIG_FILE}: ${error.message}`);
		throw error;
	}
	if (!parsed || typeof parsed !== "object" || typeof (parsed as MapConfig).target !== "string") {
		throw new Error(`Invalid ${CONFIG_FILE}: expected { "target": "<path>" }`);
	}
	const configured = required((parsed as MapConfig).target, "Config target");
	return { target: resolve(root, configured) };
}

export async function initConfig(root: string, target: string): Promise<MapConfig> {
	const planningRoot = resolve(root);
	const targetPath = resolve(planningRoot, required(target, "Target path"));
	if (targetPath === planningRoot) throw new Error("Planning repository and target repository must be different");
	let targetStat;
	try {
		targetStat = await stat(targetPath);
	} catch (error: any) {
		if (error?.code === "ENOENT") throw new Error(`Target does not exist: ${targetPath}`);
		throw error;
	}
	if (!targetStat.isDirectory()) throw new Error(`Target is not a directory: ${targetPath}`);

	const stored = relative(planningRoot, targetPath) || ".";
	await atomicWrite(configPath(planningRoot), `${JSON.stringify({ target: stored }, null, 2)}\n`);
	return { target: targetPath };
}

export function isInsidePath(parent: string, candidate: string): boolean {
	const rel = relative(resolve(parent), resolve(candidate));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function effortPath(root: string, effort: string): string {
	return join(resolve(root), MAPS_DIR, assertSimpleName(effort, "Effort name"));
}

export function mapPath(root: string, effort: string): string {
	return join(effortPath(root, effort), "map.md");
}

export function issuesPath(root: string, effort: string): string {
	return join(effortPath(root, effort), "issues");
}

export async function listEfforts(root: string): Promise<string[]> {
	try {
		const entries = await readdir(resolve(root, MAPS_DIR), { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	} catch (error: any) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

export function slugify(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80) || "ticket";
}

export function ticketFilename(number: number, title: string): string {
	if (!Number.isInteger(number) || number < 1) throw new Error("Ticket number must be a positive integer");
	return `${String(number).padStart(2, "0")}-${slugify(title)}.md`;
}

export function parseMap(markdown: string): MapDocument {
	const title = markdown.match(/^#\s+(.+)\s*$/m)?.[1];
	if (!title) throw new Error("Invalid map: missing title");
	const decisionsText = section(markdown, "Decisions so far");
	const decisions: MapDecision[] = [];
	for (const line of decisionsText.split("\n")) {
		if (!line.trim() || /^none[.!]?$/i.test(line.trim())) continue;
		const match = line.match(/^\s*-\s+\[([^\]]+)]\(([^)]+)\)\s+(?:—|-)\s+(.+?)\s*$/);
		if (!match) throw new Error(`Invalid decision line: ${line}`);
		decisions.push({ title: match[1], path: match[2], gist: match[3] });
	}
	return {
		name: title.trim(),
		destination: section(markdown, "Destination"),
		notes: section(markdown, "Notes"),
		decisions,
		fog: section(markdown, "Not yet specified"),
		outOfScope: section(markdown, "Out of scope"),
	};
}

export function renderMap(map: MapDocument): string {
	const decisions = map.decisions.length
		? map.decisions.map((decision) => `- [${decision.title}](${decision.path}) — ${decision.gist}`).join("\n")
		: "None.";
	return `# ${required(map.name, "Map name")}\n\n## Destination\n\n${map.destination.trim()}\n\n## Notes\n\n${map.notes.trim()}\n\n## Decisions so far\n\n${decisions}\n\n## Not yet specified\n\n${map.fog.trim() || "None."}\n\n## Out of scope\n\n${map.outOfScope.trim() || "None."}\n`;
}

export async function readMap(root: string, effort: string): Promise<MapDocument> {
	return parseMap(await readFile(mapPath(root, effort), "utf8"));
}

export async function writeMap(root: string, effort: string, map: MapDocument): Promise<void> {
	await atomicWrite(mapPath(root, effort), renderMap(map));
}

export async function createMap(root: string, effort: string, map: Omit<MapDocument, "decisions"> & { decisions?: MapDecision[] }): Promise<MapDocument> {
	const dir = effortPath(root, effort);
	await mkdir(join(dir, "issues"), { recursive: true });
	const document: MapDocument = { ...map, decisions: map.decisions ?? [] };
	const handle = await open(join(dir, "map.md"), "wx");
	try {
		await handle.writeFile(renderMap(document), "utf8");
	} finally {
		await handle.close();
	}
	return document;
}

function parseBlockers(value: string): number[] {
	if (/^none[.!]?$/i.test(value.trim())) return [];
	const blockers = [...value.matchAll(/\d+/g)].map((match) => Number(match[0]));
	if (!blockers.length) throw new Error(`Invalid Blocked by value: ${value}`);
	return [...new Set(blockers)].sort((a, b) => a - b);
}

export function parseTicket(markdown: string, source: string | number = ""): TicketDocument {
	const title = markdown.match(/^#\s+(.+)\s*$/m)?.[1]?.trim();
	if (!title) throw new Error("Invalid ticket: missing title");
	const metadata: Record<string, string> = {};
	for (const match of markdown.matchAll(/^(Type|Status|Blocked by|Claimed by):\s*(.*?)\s*$/gm)) metadata[match[1]] = match[2];
	const type = metadata.Type as TicketType;
	const status = metadata.Status as TicketStatus;
	if (!TYPES.has(type)) throw new Error(`Invalid ticket type: ${metadata.Type ?? "missing"}`);
	if (!STATUSES.has(status)) throw new Error(`Invalid ticket status: ${metadata.Status ?? "missing"}`);
	if (metadata["Blocked by"] === undefined) throw new Error("Invalid ticket: missing Blocked by");
	if (metadata["Claimed by"] === undefined) throw new Error("Invalid ticket: missing Claimed by");

	const filename = typeof source === "string" ? basename(source) : ticketFilename(source, title);
	const fromFilename = filename.match(/^(\d+)-(.+)\.md$/);
	const number = typeof source === "number" ? source : Number(fromFilename?.[1] ?? 0);
	if (!number) throw new Error(`Invalid ticket filename: ${filename || "missing"}`);
	const claimed = metadata["Claimed by"].trim();
	return {
		number,
		slug: fromFilename?.[2] ?? slugify(title),
		filename,
		title,
		type,
		status,
		blockedBy: parseBlockers(metadata["Blocked by"]),
		claimedBy: /^none[.!]?$/i.test(claimed) ? undefined : claimed,
		question: section(markdown, "Question"),
		answer: section(markdown, "Answer") || undefined,
	};
}

export function renderTicket(ticket: TicketDocument): string {
	const blockers = ticket.blockedBy.length ? [...new Set(ticket.blockedBy)].sort((a, b) => a - b).map(String).join(", ") : "none";
	const answer = ticket.answer?.trim() ? `\n\n## Answer\n\n${ticket.answer.trim()}` : "";
	return `# ${required(ticket.title, "Ticket title")}\n\nType: ${ticket.type}\nStatus: ${ticket.status}\nBlocked by: ${blockers}\nClaimed by: ${ticket.claimedBy?.trim() || "none"}\n\n## Question\n\n${ticket.question.trim()}${answer}\n`;
}

export async function listTickets(root: string, effort: string): Promise<TicketDocument[]> {
	let names: string[];
	try {
		names = await readdir(issuesPath(root, effort));
	} catch (error: any) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const tickets: TicketDocument[] = [];
	for (const name of names.filter((value) => /^\d+-.+\.md$/.test(value))) {
		tickets.push(parseTicket(await readFile(join(issuesPath(root, effort), name), "utf8"), name));
	}
	tickets.sort((a, b) => a.number - b.number || a.filename.localeCompare(b.filename));
	const seen = new Set<number>();
	for (const ticket of tickets) {
		if (seen.has(ticket.number)) throw new Error(`Duplicate ticket number: ${ticket.number}`);
		seen.add(ticket.number);
	}
	return tickets;
}

export function nextTicketNumber(tickets: readonly Pick<TicketDocument, "number">[]): number {
	return tickets.reduce((highest, ticket) => Math.max(highest, ticket.number), 0) + 1;
}

export async function createTicket(
	root: string,
	effort: string,
	input: Pick<TicketDocument, "title" | "type" | "question"> & Partial<Pick<TicketDocument, "blockedBy">>,
): Promise<TicketDocument> {
	const dir = effortPath(root, effort);
	return withEffortLock(dir, async () => {
		const number = nextTicketNumber(await listTickets(root, effort));
		const filename = ticketFilename(number, input.title);
		const ticket: TicketDocument = {
			number,
			slug: slugify(input.title),
			filename,
			title: required(input.title, "Ticket title"),
			type: input.type,
			status: "open",
			blockedBy: [...new Set(input.blockedBy ?? [])].sort((a, b) => a - b),
			question: required(input.question, "Ticket question"),
		};
		if (!TYPES.has(ticket.type)) throw new Error(`Invalid ticket type: ${ticket.type}`);
		await atomicWrite(join(issuesPath(root, effort), filename), renderTicket(ticket));
		return ticket;
	});
}

export function blockerNumbers(ticket: TicketDocument, tickets: readonly TicketDocument[]): number[] {
	const resolved = new Set(tickets.filter((value) => value.status === "resolved").map((value) => value.number));
	return ticket.blockedBy.filter((number) => !resolved.has(number));
}

export function frontier(tickets: readonly TicketDocument[]): TicketDocument[] {
	return tickets
		.filter((ticket) => ticket.status === "open" && !ticket.claimedBy && blockerNumbers(ticket, tickets).length === 0)
		.sort((a, b) => a.number - b.number);
}

function findTicket(tickets: TicketDocument[], number: number): TicketDocument {
	const ticket = tickets.find((value) => value.number === number);
	if (!ticket) throw new Error(`Ticket ${number} does not exist`);
	return ticket;
}

export async function writeTicket(root: string, effort: string, ticket: TicketDocument): Promise<void> {
	await atomicWrite(join(issuesPath(root, effort), ticket.filename), renderTicket(ticket));
}

export async function setBlockers(root: string, effort: string, number: number, blockedBy: number[]): Promise<TicketDocument> {
	return withEffortLock(effortPath(root, effort), async () => {
		const tickets = await listTickets(root, effort);
		const ticket = findTicket(tickets, number);
		if (ticket.status !== "open") throw new TrackerConflictError(`Ticket ${number} is not open`);
		const blockers = [...new Set(blockedBy)].sort((a, b) => a - b);
		if (blockers.includes(number)) throw new Error(`Ticket ${number} cannot block itself`);
		const known = new Set(tickets.map((value) => value.number));
		const unknown = blockers.filter((value) => !known.has(value));
		if (unknown.length) throw new Error(`Unknown blocker ticket(s): ${unknown.join(", ")}`);
		ticket.blockedBy = blockers;
		await writeTicket(root, effort, ticket);
		return ticket;
	});
}

export async function claimTicket(root: string, effort: string, number: number, claimant: string): Promise<TicketDocument> {
	return withEffortLock(effortPath(root, effort), async () => {
		const tickets = await listTickets(root, effort);
		const ticket = findTicket(tickets, number);
		if (ticket.status !== "open" || ticket.claimedBy) throw new TrackerConflictError(`Ticket ${number} is not open and unclaimed`);
		const blockers = blockerNumbers(ticket, tickets);
		if (blockers.length) throw new Error(`Ticket ${number} is blocked by ${blockers.join(", ")}`);
		ticket.status = "claimed";
		ticket.claimedBy = required(claimant, "Claimant");
		await writeTicket(root, effort, ticket);
		return ticket;
	});
}

export async function releaseClaim(root: string, effort: string, number: number, claimant: string): Promise<TicketDocument> {
	return withEffortLock(effortPath(root, effort), async () => {
		const ticket = findTicket(await listTickets(root, effort), number);
		if (ticket.status !== "claimed" || ticket.claimedBy !== claimant) throw new TrackerConflictError(`Ticket ${number} is not claimed by ${claimant}`);
		ticket.status = "open";
		ticket.claimedBy = undefined;
		await writeTicket(root, effort, ticket);
		return ticket;
	});
}

export async function resolveTicket(
	root: string,
	effort: string,
	number: number,
	claimant: string,
	answer: string,
	gist: string,
): Promise<TicketDocument> {
	return withEffortLock(effortPath(root, effort), async () => {
		const ticket = findTicket(await listTickets(root, effort), number);
		if (ticket.status !== "claimed" || ticket.claimedBy !== claimant) throw new TrackerConflictError(`Ticket ${number} is not claimed by ${claimant}`);
		if (ticket.answer) throw new TrackerConflictError(`Ticket ${number} already has an answer`);
		const map = await readMap(root, effort);
		if (map.decisions.some((decision) => decision.path === `issues/${ticket.filename}`)) {
			throw new TrackerConflictError(`Ticket ${number} already has a decision pointer`);
		}
		ticket.answer = required(answer, "Answer");
		ticket.status = "resolved";
		ticket.claimedBy = undefined;
		map.decisions.push({ title: ticket.title, path: `issues/${ticket.filename}`, gist: required(gist, "Decision gist") });
		await writeTicket(root, effort, ticket);
		await atomicWrite(mapPath(root, effort), renderMap(map));
		return ticket;
	});
}

export async function setFog(root: string, effort: string, fog: string): Promise<MapDocument> {
	return withEffortLock(effortPath(root, effort), async () => {
		const map = await readMap(root, effort);
		map.fog = fog.trim();
		await atomicWrite(mapPath(root, effort), renderMap(map));
		return map;
	});
}

export async function addOutOfScope(root: string, effort: string, text: string): Promise<MapDocument> {
	return withEffortLock(effortPath(root, effort), async () => {
		const map = await readMap(root, effort);
		const line = required(text, "Out-of-scope entry");
		map.outOfScope = emptyText(map.outOfScope) ? line : `${map.outOfScope.trim()}\n${line}`;
		await atomicWrite(mapPath(root, effort), renderMap(map));
		return map;
	});
}

export async function markOutOfScope(root: string, effort: string, number: number, reason: string, claimant?: string): Promise<TicketDocument> {
	return withEffortLock(effortPath(root, effort), async () => {
		const ticket = findTicket(await listTickets(root, effort), number);
		if (ticket.status === "resolved" || ticket.status === "out-of-scope") throw new TrackerConflictError(`Ticket ${number} is already closed`);
		if (ticket.status === "claimed" && ticket.claimedBy !== claimant) {
			throw new TrackerConflictError(`Ticket ${number} is claimed by another session`);
		}
		const map = await readMap(root, effort);
		ticket.status = "out-of-scope";
		ticket.claimedBy = undefined;
		const entry = `- [${ticket.title}](issues/${ticket.filename}) — ${required(reason, "Out-of-scope reason")}`;
		map.outOfScope = emptyText(map.outOfScope) ? entry : `${map.outOfScope.trim()}\n${entry}`;
		await writeTicket(root, effort, ticket);
		await atomicWrite(mapPath(root, effort), renderMap(map));
		return ticket;
	});
}

export function checkCompletion(map: MapDocument, tickets: readonly TicketDocument[]): CompletionCheck {
	const open = tickets.filter((ticket) => ticket.status === "open");
	const claimed = tickets.filter((ticket) => ticket.status === "claimed");
	const known = new Set(tickets.map((ticket) => ticket.number));
	const unresolvedBlockers = tickets
		.filter((ticket) => ticket.status === "open" || ticket.status === "claimed")
		.map((ticket) => ({ ticket, blockers: blockerNumbers(ticket, tickets).filter((number) => known.has(number)) }))
		.filter((entry) => entry.blockers.length);
	const danglingBlockers = tickets
		.map((ticket) => ({ ticket, blockers: ticket.blockedBy.filter((number) => !known.has(number)) }))
		.filter((entry) => entry.blockers.length);
	const fog = emptyText(map.fog) ? "" : map.fog.trim();
	const reasons: string[] = [];
	if (open.length) reasons.push(`${open.length} open ticket(s) remain`);
	if (claimed.length) reasons.push(`${claimed.length} claimed ticket(s) remain`);
	if (unresolvedBlockers.length) reasons.push("Unresolved blockers remain");
	if (danglingBlockers.length) reasons.push("Unknown blocker references remain");
	if (fog) reasons.push("In-scope fog remains under Not yet specified");
	if (!map.destination.trim()) reasons.push("Destination is empty");
	return { complete: reasons.length === 0, open, claimed, unresolvedBlockers, danglingBlockers, fog, reasons };
}

export function renderHandoff(map: MapDocument, tickets: readonly TicketDocument[]): string {
	const check = checkCompletion(map, tickets);
	if (!check.complete) throw new Error(`Map is not complete: ${check.reasons.join("; ")}`);
	const byPath = new Map(tickets.map((ticket) => [`issues/${ticket.filename}`, ticket]));
	const decisions = map.decisions.length
		? map.decisions.map((decision) => {
			const answer = byPath.get(decision.path)?.answer?.trim();
			return `### [${decision.title}](${decision.path})\n\n${decision.gist}${answer ? `\n\n${answer}` : ""}`;
		}).join("\n\n")
		: "None.";
	return `# ${map.name} — Handoff\n\n## Destination\n\n${map.destination.trim()}\n\n## Notes\n\n${map.notes.trim() || "None."}\n\n## Decisions\n\n${decisions}\n`;
}

export async function writeHandoff(root: string, effort: string): Promise<string> {
	return withEffortLock(effortPath(root, effort), async () => {
		const content = renderHandoff(await readMap(root, effort), await listTickets(root, effort));
		await atomicWrite(join(effortPath(root, effort), "handoff.md"), content);
		return content;
	});
}

// This support module lives in the auto-discovered extensions directory.
export default function mapTrackerModule(): void {}
