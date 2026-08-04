// Pi command, model tools, and target-write guard for the /map workflow.
// Entry points: /map, map_read/map_create/map_update, and edit/write interception.
// Split only if command UI or tool schemas grow beyond the tracker workflow.

import { realpath, readdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CONFIG_FILE,
	MAPS_DIR,
	addOutOfScope,
	checkCompletion,
	claimTicket,
	createMap,
	createTicket,
	frontier,
	initConfig,
	isInsidePath,
	listTickets,
	markOutOfScope,
	readConfig,
	readMap,
	releaseClaim,
	resolveTicket,
	setBlockers,
	setFog,
	writeHandoff,
	type MapDocument,
	type TicketDocument,
	type TicketType,
} from "./map-tracker.ts";

const STATUS_KEY = "project-map";
const SKILL_COMMAND = "skill:project-map";
const SKILL_PATH = "skills/engineering/project-map/SKILL.md";

interface EffortStatus {
	effort: string;
	map: MapDocument;
	tickets: TicketDocument[];
	frontier: TicketDocument[];
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function cleanRequired(value: string | undefined, label: string): string {
	const clean = value?.trim();
	if (!clean) throw new Error(`${label} is required`);
	return clean;
}

function numberRequired(value: number | undefined): number {
	if (!Number.isInteger(value) || value! < 1) throw new Error("A positive ticket number is required");
	return value!;
}

async function listEfforts(root: string): Promise<string[]> {
	try {
		const entries = await readdir(resolve(root, MAPS_DIR), { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	} catch (error: any) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

async function effortStatus(root: string, effort: string): Promise<EffortStatus> {
	const map = await readMap(root, effort);
	const tickets = await listTickets(root, effort);
	return { effort, map, tickets, frontier: frontier(tickets) };
}

function compactStatus(status: EffortStatus): string {
	const counts = { open: 0, claimed: 0, resolved: 0, scope: 0 };
	for (const ticket of status.tickets) {
		if (ticket.status === "out-of-scope") counts.scope++;
		else counts[ticket.status]++;
	}
	const edge = status.frontier.length
		? status.frontier.map((ticket) => `#${ticket.number} ${ticket.title}`).join(" · ")
		: "none";
	return `${status.effort}: ${counts.open} open, ${counts.claimed} claimed, ${counts.resolved} resolved${counts.scope ? `, ${counts.scope} out` : ""} | frontier ${edge}`;
}

function detailedStatus(status: EffortStatus): string {
	const lines = [compactStatus(status), `Destination: ${status.map.destination || "(empty)"}`];
	const blocked = status.tickets.filter((ticket) => ticket.status === "open" && !status.frontier.includes(ticket));
	if (blocked.length) lines.push(`Waiting: ${blocked.map((ticket) => `#${ticket.number} ${ticket.title}`).join(" · ")}`);
	return lines.join("\n");
}

async function updateStatusUi(ctx: ExtensionContext, effort?: string): Promise<void> {
	if (!effort) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	try {
		const status = await effortStatus(ctx.cwd, effort);
		const edge = status.frontier[0];
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg("accent", `map ${effort} · ${status.tickets.filter((ticket) => ticket.status === "open").length} open${edge ? ` · #${edge.number}` : ""}`),
		);
	} catch {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function resolveWorkTarget(root: string, value: string): Promise<{ effort: string; number?: number }> {
	const clean = cleanRequired(value, "Effort or ticket");
	const explicit = clean.match(/^([^/#\s]+)(?:[/#](?:issues\/)?(?:0*(\d+))(?:-[^/]+\.md)?)$/);
	if (explicit) return { effort: explicit[1], number: Number(explicit[2]) };

	const efforts = await listEfforts(root);
	if (efforts.includes(clean)) return { effort: clean };

	const needle = clean.toLowerCase().replace(/\.md$/, "");
	const matches: Array<{ effort: string; number: number }> = [];
	for (const effort of efforts) {
		for (const ticket of await listTickets(root, effort)) {
			if (
				ticket.filename.toLowerCase().replace(/\.md$/, "") === needle ||
				ticket.slug.toLowerCase() === needle ||
				ticket.title.toLowerCase() === needle ||
				(/^\d+$/.test(needle) && ticket.number === Number(needle))
			) matches.push({ effort, number: ticket.number });
		}
	}
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`Ticket ${clean} is ambiguous; use <effort>#<ticket-number>`);
	throw new Error(`No effort or ticket matches ${clean}`);
}

async function dispatchSkill(pi: ExtensionAPI, invocation: string): Promise<void> {
	const discovered = pi.getCommands().some((command) => command.name === SKILL_COMMAND);
	pi.sendUserMessage(
		discovered
			? `/${SKILL_COMMAND} ${invocation}`
			: `Read and follow ${SKILL_PATH}. This is an explicit /map invocation: /map ${invocation}`,
	);
}

function claimant(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() || process.env.PI_SESSION_ID || "map-session";
}

function hasResolvedNonResearch(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some((entry: any) =>
		entry.type === "message" &&
		entry.message?.role === "toolResult" &&
		entry.message?.toolName === "map_update" &&
		entry.message?.details?.action === "resolve" &&
		entry.message?.details?.ticketType !== "research"
	);
}

async function canonicalPath(path: string): Promise<string> {
	const absolute = resolve(path);
	try {
		return await realpath(absolute);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}

	let existing = absolute;
	const tail: string[] = [];
	while (true) {
		try {
			const base = await realpath(existing);
			return resolve(base, ...tail.reverse());
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
			const parent = dirname(existing);
			if (parent === existing) return absolute;
			tail.push(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			existing = parent;
		}
	}
}

async function protectedTarget(root: string, inputPath: string): Promise<string | undefined> {
	let config;
	try {
		config = await readConfig(root);
	} catch (error: any) {
		if (String(error?.message).startsWith(`Missing ${CONFIG_FILE}`)) return undefined;
		throw error;
	}
	const target = await canonicalPath(config.target);
	const raw = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
	const candidate = await canonicalPath(isAbsolute(raw) ? raw : resolve(root, raw));
	return isInsidePath(target, candidate) ? target : undefined;
}

const readSchema = Type.Object({
	action: StringEnum(["config", "list", "status", "map", "ticket"] as const),
	effort: Type.Optional(Type.String()),
	number: Type.Optional(Type.Integer({ minimum: 1 })),
});

const createSchema = Type.Object({
	action: StringEnum(["map", "ticket"] as const),
	effort: Type.String(),
	name: Type.Optional(Type.String()),
	destination: Type.Optional(Type.String()),
	notes: Type.Optional(Type.String()),
	fog: Type.Optional(Type.String()),
	outOfScope: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	type: Type.Optional(StringEnum(["research", "prototype", "grilling", "task"] as const)),
	question: Type.Optional(Type.String()),
});

const updateSchema = Type.Object({
	action: StringEnum(["blockers", "claim", "release", "resolve", "fog", "add-out-of-scope", "mark-out-of-scope"] as const),
	effort: Type.String(),
	number: Type.Optional(Type.Integer({ minimum: 1 })),
	blockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
	answer: Type.Optional(Type.String()),
	gist: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
});

export default function mapExtension(pi: ExtensionAPI): void {
	let nonResearchResolutionUsed = false;

	pi.registerTool({
		name: "map_read",
		label: "Map Read",
		description: "Read project-map configuration, effort status, a map index, or one decision ticket. Use instead of hand-reading tracker Markdown.",
		parameters: readSchema,
		async execute(_id, params, _signal, _update, ctx) {
			switch (params.action) {
				case "config": {
					const config = await readConfig(ctx.cwd);
					return textResult(`Target (read-only): ${config.target}`, { action: params.action, config });
				}
				case "list": {
					const efforts = await listEfforts(ctx.cwd);
					return textResult(efforts.length ? efforts.join("\n") : "No maps.", { action: params.action, efforts });
				}
				case "status": {
					if (params.effort) {
						const status = await effortStatus(ctx.cwd, params.effort);
						await updateStatusUi(ctx, params.effort);
						return textResult(detailedStatus(status), { action: params.action, status });
					}
					const statuses = await Promise.all((await listEfforts(ctx.cwd)).map((effort) => effortStatus(ctx.cwd, effort)));
					return textResult(statuses.length ? statuses.map(compactStatus).join("\n") : "No maps.", { action: params.action, statuses });
				}
				case "map": {
					const effort = cleanRequired(params.effort, "Effort");
					const map = await readMap(ctx.cwd, effort);
					return textResult(JSON.stringify(map, null, 2), { action: params.action, effort, map });
				}
				case "ticket": {
					const effort = cleanRequired(params.effort, "Effort");
					const number = numberRequired(params.number);
					const ticket = (await listTickets(ctx.cwd, effort)).find((item) => item.number === number);
					if (!ticket) throw new Error(`Ticket ${number} does not exist in ${effort}`);
					return textResult(JSON.stringify(ticket, null, 2), { action: params.action, effort, ticket });
				}
			}
		},
	});

	pi.registerTool({
		name: "map_create",
		label: "Map Create",
		description: "Create one project map or append one safely numbered decision ticket. Create tickets without blockers, then wire blockers with map_update after ticket numbers exist.",
		parameters: createSchema,
		async execute(_id, params, _signal, _update, ctx) {
			await readConfig(ctx.cwd);
			const effort = cleanRequired(params.effort, "Effort");
			if (params.action === "map") {
				const map = await createMap(ctx.cwd, effort, {
					name: cleanRequired(params.name, "Map name"),
					destination: cleanRequired(params.destination, "Destination"),
					notes: params.notes?.trim() || "None.",
					fog: params.fog?.trim() || "None.",
					outOfScope: params.outOfScope?.trim() || "None.",
				});
				await updateStatusUi(ctx, effort);
				return textResult(`Created map ${effort}.`, { action: params.action, effort, map });
			}
			const ticket = await createTicket(ctx.cwd, effort, {
				title: cleanRequired(params.title, "Ticket title"),
				type: cleanRequired(params.type, "Ticket type") as TicketType,
				question: cleanRequired(params.question, "Ticket question"),
			});
			await updateStatusUi(ctx, effort);
			return textResult(`Created #${ticket.number} ${ticket.title}.`, { action: params.action, effort, ticket });
		},
	});

	pi.registerTool({
		name: "map_update",
		label: "Map Update",
		description: "Safely wire blockers, claim/release/resolve one ticket, update fog, or mark scope. Claims use the current session and resolutions are atomic.",
		parameters: updateSchema,
		async execute(_id, params, _signal, _update, ctx) {
			await readConfig(ctx.cwd);
			const effort = cleanRequired(params.effort, "Effort");
			const session = claimant(ctx);
			let message: string;
			let ticket: TicketDocument | undefined;
			let ticketType: TicketType | undefined;

			switch (params.action) {
				case "blockers":
					ticket = await setBlockers(ctx.cwd, effort, numberRequired(params.number), params.blockedBy ?? []);
					message = `Updated blockers for #${ticket.number}.`;
					break;
				case "claim":
					ticket = await claimTicket(ctx.cwd, effort, numberRequired(params.number), session);
					message = `Claimed #${ticket.number} ${ticket.title} for this session.`;
					break;
				case "release":
					ticket = await releaseClaim(ctx.cwd, effort, numberRequired(params.number), session);
					message = `Released #${ticket.number}.`;
					break;
				case "resolve": {
					const number = numberRequired(params.number);
					const current = (await listTickets(ctx.cwd, effort)).find((item) => item.number === number);
					if (!current) throw new Error(`Ticket ${number} does not exist`);
					if (current.type !== "research" && (nonResearchResolutionUsed || hasResolvedNonResearch(ctx))) {
						throw new Error("This session already resolved one non-research ticket; stop and report the frontier");
					}
					if (current.type !== "research") nonResearchResolutionUsed = true;
					try {
						ticket = await resolveTicket(
							ctx.cwd,
							effort,
							number,
							session,
							cleanRequired(params.answer, "Answer"),
							cleanRequired(params.gist, "Decision gist"),
						);
					} catch (error) {
						if (current.type !== "research") nonResearchResolutionUsed = hasResolvedNonResearch(ctx);
						throw error;
					}
					ticketType = ticket.type;
					message = `Resolved #${ticket.number} ${ticket.title}.`;
					break;
				}
				case "fog":
					await setFog(ctx.cwd, effort, params.text?.trim() || "None.");
					message = "Updated Not yet specified.";
					break;
				case "add-out-of-scope":
					await addOutOfScope(ctx.cwd, effort, cleanRequired(params.text, "Out-of-scope entry"));
					message = "Added out-of-scope boundary.";
					break;
				case "mark-out-of-scope":
					ticket = await markOutOfScope(ctx.cwd, effort, numberRequired(params.number), cleanRequired(params.text, "Out-of-scope reason"), session);
					message = `Marked #${ticket.number} out of scope.`;
					break;
			}
			await updateStatusUi(ctx, effort);
			return textResult(message!, { action: params.action, effort, ticket, ticketType });
		},
	});

	pi.registerCommand("map", {
		description: "Chart or work a decision map: init|new|status|finish|<effort-or-ticket>",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			const [verb = "status", ...rest] = args.split(/\s+/);
			const value = rest.join(" ").trim();
			try {
				if (verb === "init") {
					const target = cleanRequired(value, "Target path");
					if (!ctx.hasUI) throw new Error("/map init requires interactive confirmation");
					const planning = await canonicalPath(ctx.cwd);
					const targetPath = await canonicalPath(resolve(ctx.cwd, target));
					if (isInsidePath(targetPath, planning) || isInsidePath(planning, targetPath)) {
						throw new Error("Planning and target repositories must be separate, non-nested directories");
					}
					const confirmed = await ctx.ui.confirm(
						"Initialize project map?",
						`Store map state only in:\n${planning}\n\nTreat this target as read-only:\n${targetPath}`,
					);
					if (!confirmed) {
						ctx.ui.notify("Map initialization cancelled.", "info");
						return;
					}
					await initConfig(ctx.cwd, targetPath);
					ctx.ui.notify(`Initialized ${CONFIG_FILE}. Target is read-only: ${targetPath}`, "info");
					return;
				}

				try {
					await readConfig(ctx.cwd);
				} catch (error: any) {
					if (String(error?.message).startsWith(`Missing ${CONFIG_FILE}`)) {
						ctx.ui.notify(
							`Mapping requires a dedicated planning repository. Create or use an adjacent repo, then explicitly run /map init <target>.`,
							"warning",
						);
						return;
					}
					throw error;
				}

				if (verb === "status") {
					if (value) {
						const status = await effortStatus(ctx.cwd, value);
						ctx.ui.notify(detailedStatus(status), "info");
						await updateStatusUi(ctx, value);
					} else {
						const statuses = await Promise.all((await listEfforts(ctx.cwd)).map((effort) => effortStatus(ctx.cwd, effort)));
						ctx.ui.notify(statuses.length ? statuses.map(compactStatus).join("\n") : "No maps. Use /map new <idea>.", "info");
					}
					return;
				}

				if (verb === "finish") {
					const effort = cleanRequired(value, "Effort");
					const status = await effortStatus(ctx.cwd, effort);
					const completion = checkCompletion(status.map, status.tickets);
					if (!completion.complete) {
						ctx.ui.notify(`Cannot finish ${effort}: ${completion.reasons.join("; ")}`, "warning");
						await updateStatusUi(ctx, effort);
						return;
					}
					await writeHandoff(ctx.cwd, effort);
					ctx.ui.notify(`Wrote maps/${effort}/handoff.md. Ready for a future /plan session.`, "info");
					await updateStatusUi(ctx, effort);
					return;
				}

				if (verb === "new") {
					await dispatchSkill(pi, `new ${cleanRequired(value, "Idea")}`);
					return;
				}

				const work = await resolveWorkTarget(ctx.cwd, args);
				const status = await effortStatus(ctx.cwd, work.effort);
				if (work.number !== undefined) {
					const ticket = status.tickets.find((item) => item.number === work.number);
					if (!ticket) throw new Error(`Ticket ${work.number} does not exist in ${work.effort}`);
					if (!status.frontier.some((item) => item.number === work.number)) {
						throw new Error(`Ticket #${work.number} is not open, unblocked, and unclaimed`);
					}
				} else if (!status.frontier.length) {
					throw new Error(`No frontier ticket is ready in ${work.effort}`);
				}
				await updateStatusUi(ctx, work.effort);
				await dispatchSkill(pi, args);
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const inputPath = (event.input as { path?: unknown }).path;
		if (typeof inputPath !== "string") return;
		const target = await protectedTarget(ctx.cwd, inputPath);
		if (target) {
			return {
				block: true,
				reason: `Project map boundary: ${event.toolName} cannot mutate configured target ${target}. Inspect it read-only. Do not use bash to mutate it.`,
			};
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		nonResearchResolutionUsed = hasResolvedNonResearch(ctx);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
