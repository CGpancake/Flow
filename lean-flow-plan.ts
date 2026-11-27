// Pure lean-flow helpers: plan/run parsing plus tracks-tree and ticket file IO. Entry points are
// plan/run (tasksFromPlanText, branchSlug, reviewVerdict) and tracks/tickets (parseTracks,
// parseTicketFile, readTracksTree, parseTicketFilters, filterTickets, completedTracks, doneTickets,
// import tickets). No Pi imports so tests/*.test.ts run under plain `node --test`. Split trigger: move
// ticket read/write/migrate into lean-flow-tickets.ts once ticket IO outgrows parsing.

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type LeanAgent = "worker" | "reviewer" | "researcher";

export type LeanTask = {
	agent: LeanAgent;
	label: string;
	task: string;
	parallel?: boolean;
	track?: string;
	issue?: string;
};

export type PlanStep = { step: string; body: string; parallel?: boolean };

// Canonical plan contract: both /work parsing and the plan-size guard read this section.
export const PLAN_HEADING = /(?:^|\n)##[ \t]+(?:Implementation|Lean implementation plan)[ \t]*\r?\n/i;

export function planImplementation(text: string): string {
	return text.match(/(?:^|\n)##[ \t]+Implementation[ \t]*\r?\n([\s\S]*?)(?=\n##[ \t]+|$)/i)?.[1] ?? text;
}

export function planGoal(text: string): string {
	return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

export function planStepCount(text: string): number {
	return (planImplementation(text).match(/^\s*\d+\.\s+/gm) ?? []).length;
}

export function stripPlanParallelMarker(text: string): string {
	return text.replace(/\[parallel(?::[^\]]+)?\]/ig, "").replace(/\s+/g, " ").trim();
}

export function planStepParallel(body: string): boolean {
	// Ignore inline code: a step body that merely mentions `[parallel]` is not marked parallel.
	return /\[parallel(?::[^\]]+)?\]/i.test(body.replace(/`[^`]*`/g, ""));
}

// Path-ish token: separator after a real character (`/work-add` is a command, not a path)
// or a source/config extension. Collision holds resolve these against live child ownership.
const PATH_REF = /(?<=[\p{L}\p{N}._~-])[\\/]|\.(?:[cm]?[jt]sx?|py|md|json|toml|ya?ml|css|scss|html?|sh|rs|go|java|kt|kts|c|cc|cpp|h|hpp|rb|php|swift|cs|lua|sql|txt|lock|cfg|ini)$/iu;

export function pathRefs(text: string): string[] {
	const refs = new Set<string>();
	for (const match of stripPlanParallelMarker(text).matchAll(/`([^`]+)`|\S+/g)) {
		const token = (match[1] ?? match[0])
			.trim()
			.replace(/^[`"'([{<*_]+/, "")
			.replace(/[`"')\]}<>*_,;.:]+$/, "")
			.replace(/:\d+(?::\d+)?$/, "");
		if (!token || /^[a-z][a-z0-9+.-]*:\/\//i.test(token) || !PATH_REF.test(token)) continue;
		refs.add(token);
	}
	return [...refs];
}

const LABEL_STOPWORDS = new Set(["the", "a", "an", "to", "for", "of", "in", "on", "and", "or", "with", "is", "are", "this", "that", "from", "as", "at", "by"]);

// Labels are the leading action phrase: inline code, path-ish words, and file extensions end it.
// Path-ish = contains `/` or `~`, or a known file extension. Used to cut and shorten labels
// deterministically.
const LABEL_CUT = /[/~]|\.(?:ts|md|json|js|mjs|py)\b/iu;
const LABEL_EXT = /\.(?:ts|md|json|js|mjs|py)$/i;
// Legacy path-ish test: separator after another character (so `/work-reload` is not a path),
// or a known file extension. Only used by the fallback below.
const LABEL_PATH = /(?<=[\p{L}\p{N}._~-])[\\/]|\.(?:ts|md|json|js|mjs|py)\b/iu;

function finishLabel(words: string[]): string {
	const meaningful = words.filter((word) => !LABEL_STOPWORDS.has(word.toLowerCase()));
	return (meaningful.length ? meaningful : words).slice(0, 5).join(" ") || "Lean work";
}

// Deterministic label shortening: a token that looks like a path collapses to its basename
// (`/home/me/repo/README.md` -> `README.md`). No model decides this.
export function shortPath(word: string): string {
	if (!LABEL_PATH.test(word)) return word;
	const token = word.replace(/[:;,.]+$/, "").replace(/^[^\p{L}\p{N}~./]+/u, "");
	return token.split(/[/\\]/).filter(Boolean).at(-1) ?? token;
}

function legacyLabelWords(text: string): string[] {
	return stripPlanParallelMarker(text).replace(/[`*_#>[\]()]/g, " ").trim().split(/\s+/).filter(Boolean).map((word) => shortPath(word.replace(/[:;,.]+$/, "")));
}

// Previous taskLabel behavior, kept as the fallback when the leading-phrase cut leaves nothing.
function legacyTaskLabel(text: string): string {
	const words = stripPlanParallelMarker(text)
		.replace(/`([^`]*)`/g, (_match: string, code: string) => ` ${code} `)
		.replace(/[`*_#>[\]()]/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const cut = words.findIndex((word) => LABEL_PATH.test(word));
	const phrase = cut < 0 ? words : words.slice(0, cut + 1);
	const label = phrase.map((word) => shortPath(word).replace(/^[^\p{L}\p{N}]+/u, "").replace(/[:;,.]+$/, "")).filter(Boolean);
	return finishLabel(label.length ? label : legacyLabelWords(text));
}

// Label = leading phrase before the first inline code span or path-ish word. The cut word
// contributes its basename without the extension (`/repo/README.md` -> `README`). If the cut
// leaves nothing, keep the old label behavior.
export function taskLabel(text: string): string {
	const words: string[] = [];
	for (const match of stripPlanParallelMarker(text).matchAll(/`[^`]*`|\S+/g)) {
		const token = match[0]!;
		if (token.startsWith("`")) break;
		if (LABEL_CUT.test(token)) {
			const base = shortPath(token.replace(/[`*_#>[\]()]/g, "")).replace(LABEL_EXT, "");
			if (base) words.push(base);
			break;
		}
		words.push(...token.replace(/[`*_#>[\]()]/g, " ").split(/\s+/).filter(Boolean));
	}
	const label = words.map((word) => word.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[:;,.]+$/, "")).filter(Boolean);
	// A leading phrase of only stopwords ("In `path` …") names nothing: fall back to the whole step.
	const meaningful = label.filter((word) => !LABEL_STOPWORDS.has(word.toLowerCase()));
	return meaningful.length ? finishLabel(label) : legacyTaskLabel(text);
}

function parsedSteps(section: string): { step: string; body: string; detail: string; markedParallel: boolean }[] {
	const steps: { step: string; body: string; detail: string; markedParallel: boolean }[] = [];
	let current: (typeof steps)[number] | undefined;
	let acceptingDetail = false;
	for (const line of section.split(/\r?\n/)) {
		const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/);
		if (numbered) {
			if (current) steps.push(current);
			const rawBody = numbered[2]!.trim();
			current = { step: numbered[1]!, body: stripPlanParallelMarker(rawBody), detail: "", markedParallel: planStepParallel(rawBody) };
			acceptingDetail = true;
			continue;
		}
		if (!current || !acceptingDetail) continue;
		if (/^(?:\t| {2,})\S/.test(line)) current.detail = current.detail ? `${current.detail}\n${line}` : line;
		else acceptingDetail = false;
	}
	if (current) steps.push(current);
	return steps;
}

export function planStepsFromText(text: string): { goal: string; steps: PlanStep[] } {
	const steps = parsedSteps(planImplementation(text)).map(({ step, body, markedParallel }) => ({ step, body, parallel: markedParallel }));
	return { goal: planGoal(text).replace(/^#+\s*/, ""), steps };
}

// Append one numbered step at the end of the implementation section (not after trailing notes).
export function appendPlanStep(text: string, stepText: string): { text: string; step: string } {
	const step = String(planStepsFromText(text).steps.reduce((max, item) => Math.max(max, Number(item.step) || 0), 0) + 1);
	const line = `${step}. ${stepText.trim()}`;
	const heading = text.match(PLAN_HEADING);
	if (!heading) return { text: `${text.trimEnd()}\n\n## Implementation\n\n${line}\n`, step };
	const start = heading.index! + heading[0].length;
	const rest = text.slice(start);
	const stop = rest.search(/\n##[ \t]+/);
	if (stop < 0) return { text: `${text.trimEnd()}\n${line}\n`, step };
	return { text: `${text.slice(0, start + stop).trimEnd()}\n${line}\n${rest.slice(stop + 1)}`, step };
}

// Track: <name> in plan.md selects the issue track for /work.
export function planTrack(text: string): string | undefined {
	const line = text.split(/\r?\n/).find((candidate) => /^\s*track\s*:/i.test(candidate));
	return line?.replace(/^\s*track\s*:/i, "").trim() || undefined;
}

export type TrackStatus = "pending" | "started" | "completed";
export type TrackIssue = { text: string; status: TrackStatus; detail: string };
export type Track = { name: string; issues: TrackIssue[] };

const TRACK_HEADING = /^##[ \t]+(.+?)[ \t]*$/;
const TRACK_ISSUE = /^(\s*-\s+\[)([ xX-])(\]\s+.*)$/;
const TRACK_DETAIL = /^(?:\t| {2,})\S/;
const MARKER_STATUS: Record<string, TrackStatus> = { " ": "pending", "-": "started", x: "completed" };

function issueStatus(marker: string): TrackStatus {
	return MARKER_STATUS[marker.toLowerCase()] ?? "pending";
}

function linesOf(text: string): string[] {
	return text.split(/\r?\n/);
}

// Ponytail ceiling: flat `## track` headings with `- [ ]`/`- [-]`/`- [x]` issues and indented detail only;
// nested sub-tracks would need a tree.
export function parseTracks(text: string): Track[] {
	const tracks: Track[] = [];
	let issue: TrackIssue | undefined;
	for (const line of linesOf(text)) {
		const heading = line.match(TRACK_HEADING);
		if (heading) {
			tracks.push({ name: heading[1]!, issues: [] });
			issue = undefined;
			continue;
		}
		// Detail wins over a lookalike issue while one is open: `  - [ ] note` stays detail.
		if (issue && TRACK_DETAIL.test(line)) {
			issue.detail = [issue.detail, line.trim()].filter(Boolean).join("\n");
			continue;
		}
		const found = line.match(/^\s*-\s+\[([ xX-])\]\s+(.+?)\s*$/);
		if (found && tracks.length) {
			issue = { text: found[2]!, status: issueStatus(found[1]!), detail: "" };
			tracks.at(-1)!.issues.push(issue);
			continue;
		}
		issue = undefined;
	}
	return tracks;
}

// Folder-based tracks: every subfolder is a track, every `*.md` file is a ticket.
export type TicketType = "bug" | "feature" | "rnd";
export type TicketStatus = "todo" | "started" | "done";
export type Ticket = {
	id: string;
	type: TicketType;
	status: TicketStatus;
	title: string;
	body: string;
	track: string;
	path: string;
};
export type TrackNode = { name: string; path: string; children: TrackNode[]; issues: Ticket[] };

const MIGRATED_STATUS: Record<TrackStatus, TicketStatus> = { pending: "todo", started: "started", completed: "done" };
const MIGRATED_MARKER = ".migrated";
const TICKET_FILE = /^(bug|feature|rnd)-([0-9a-f]{6})-(.*)\.md$/i;

function baseName(path: string): string {
	return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function ticketTrack(path: string): string {
	return path.split(/[/\\]/).slice(0, -1).filter((segment) => segment && segment !== ".").join("/");
}

function isTicketStatus(value: string | undefined): value is TicketStatus {
	return value === "todo" || value === "started" || value === "done";
}

// Filename = `<type>-<id>-<slug>.md`; legacy `<slug>.md` reads as feature with no id until migrated.
// Status = frontmatter `status:` limited to todo/started/done (default todo).
// Title = first `# ` heading, else the filename slug. Body = the markdown left after both are removed.
export function parseTicketFile(text: string, path: string, track = ticketTrack(path)): Ticket {
	const source = text.replace(/^\uFEFF/, "");
	const frontmatter = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
	const rawStatus = frontmatter?.[1]
		.split(/\r?\n/)
		.map((line) => line.match(/^\s*status\s*:\s*(.+?)\s*$/i)?.[1]?.replace(/^["']|["']$/g, "").toLowerCase())
		.find(Boolean);
	const filename = baseName(path);
	const match = filename.match(TICKET_FILE);
	const type = (match?.[1]?.toLowerCase() as TicketType | undefined) ?? "feature";
	const id = match?.[2]?.toLowerCase() ?? "";
	const slug = match?.[3] ?? filename.replace(/\.md$/i, "");
	const rest = frontmatter ? source.slice(frontmatter[0].length) : source;
	const lines = rest.split(/\r?\n/);
	const heading = lines.findIndex((line) => /^#[ \t]+\S/.test(line));
	const title = heading >= 0 ? lines[heading]!.replace(/^#[ \t]+/, "").trim() : slug;
	if (heading >= 0) lines.splice(heading, 1);
	return { id, type, status: isTicketStatus(rawStatus) ? rawStatus : "todo", title, body: lines.join("\n").trim(), track, path };
}

function ticketIds(node: TrackNode, ids = new Set<string>()): Set<string> {
	for (const ticket of node.issues) ids.add(ticket.id);
	for (const child of node.children) ticketIds(child, ids);
	return ids;
}

const EMPTY_TREE: TrackNode = { name: "", path: "", children: [], issues: [] };

function uniqueTicketId(used: Set<string>): string {
	let id: string;
	do id = randomBytes(3).toString("hex"); while (used.has(id));
	used.add(id);
	return id;
}

// Random 6-hex ticket id, retried until it does not collide with any ticket already in the tree.
export function mintTicketId(tree: TrackNode = EMPTY_TREE): string {
	return uniqueTicketId(ticketIds(tree));
}

export function ticketFileName(ticket: Pick<Ticket, "type" | "id" | "title">): string {
	return `${ticket.type}-${ticket.id}-${slugify(ticket.title, 60)}.md`;
}

// Frontmatter carries status and type; the title heading and body are written as-is (trimmed edges).
export function serializeTicketFile(ticket: Pick<Ticket, "type" | "status" | "title" | "body">): string {
	const title = ticket.title.trim();
	const body = ticket.body.trim();
	return `---\nstatus: ${ticket.status}\ntype: ${ticket.type}\n---\n\n# ${title}${body ? `\n\n${body}` : ""}\n`;
}

const STATUS_LINE = /^([ \t]*status[ \t]*:[ \t]*)(.*?)([ \t]*)(?=\r?\n|$)/im;

// Rewrite only the frontmatter `status:` value: every other key, line ending and body byte stays
// intact. A missing status line is inserted first; text without frontmatter gets one prepended.
export function rewriteTicketStatus(text: string, status: TicketStatus): string {
	const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
	const source = text.slice(bom.length);
	const frontmatter = source.match(/^(---[ \t]*)(\r?\n)((?:[\s\S]*?\r?\n)?)(---[ \t]*)(?=\r?\n|$)/);
	const eol = source.includes("\r\n") ? "\r\n" : "\n";
	if (!frontmatter) return `${bom}---${eol}status: ${status}${eol}---${eol}${source}`;
	const open = frontmatter[1]!;
	const openEol = frontmatter[2]!;
	const inner = frontmatter[3]!;
	const close = frontmatter[4]!;
	const insertEol = inner.match(/\r?\n/)?.[0] ?? openEol;
	const nextInner = STATUS_LINE.test(inner)
		? inner.replace(STATUS_LINE, (_match, prefix: string, _value: string, trailing: string) => `${prefix}${status}${trailing}`)
		: `status: ${status}${inner ? insertEol : openEol}${inner}`;
	return `${bom}${open}${openEol}${nextInner}${close}${source.slice(frontmatter[0].length)}`;
}

function readTrackDir(dir: string, name: string, path: string): TrackNode {
	const node: TrackNode = { name, path, children: [], issues: [] };
	if (!existsSync(dir)) return node;
	const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const childPath = path ? `${path}/${entry.name}` : entry.name;
		if (entry.isDirectory()) node.children.push(readTrackDir(join(dir, entry.name), entry.name, childPath));
		else if (entry.isFile() && /\.md$/i.test(entry.name)) {
			node.issues.push(parseTicketFile(readFileSync(join(dir, entry.name), "utf8"), childPath));
		}
	}
	return node;
}

// Root node represents the tracks directory itself; its `children` are the top-level tracks.
export function readTracksTree(root: string): TrackNode {
	return readTrackDir(root, baseName(root), "");
}

export type TicketFilters = { track?: string; type?: TicketType; status?: TicketStatus; idPrefix?: string };

const TICKET_TYPES: TicketType[] = ["bug", "feature", "rnd"];
const TICKET_STATUSES: TicketStatus[] = ["todo", "started", "done"];

// Space-separated filters only lift a token when its value validates, so prose like `type:location`
// stays in the guidance text instead of aborting the plan.
export function parseTicketFilters(input: string): { filters: TicketFilters; rest: string[] } {
	const tokens = input.split(/\s+/).filter(Boolean);
	const filters: TicketFilters = {};
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const pair = token.match(/^(track|type|status):(.+)$/i);
		if (pair) {
			const key = pair[1]!.toLowerCase();
			const value = pair[2]!;
			const lower = value.toLowerCase();
			if (key === "track") filters.track = value;
			else if (key === "type" && TICKET_TYPES.includes(lower as TicketType)) filters.type = lower as TicketType;
			else if (key === "status" && TICKET_STATUSES.includes(lower as TicketStatus)) filters.status = lower as TicketStatus;
			else {
				rest.push(token);
				continue;
			}
			continue;
		}
		const key = token.toLowerCase();
		if ((key === "track" || key === "type" || key === "status") && tokens[i + 1]) {
			const value = tokens[i + 1]!;
			const lower = value.toLowerCase();
			if (key === "track") filters.track = value;
			else if (key === "type" && TICKET_TYPES.includes(lower as TicketType)) filters.type = lower as TicketType;
			else if (key === "status" && TICKET_STATUSES.includes(lower as TicketStatus)) filters.status = lower as TicketStatus;
			else {
				rest.push(token);
				continue;
			}
			i++;
			continue;
		}
		if (token.startsWith("#") && token.length > 1) {
			filters.idPrefix = token.slice(1);
			continue;
		}
		rest.push(token);
	}
	return { filters, rest };
}

function walkTickets(node: TrackNode, visit: (ticket: Ticket) => void): void {
	for (const ticket of node.issues) visit(ticket);
	for (const child of node.children) walkTickets(child, visit);
}

// Track is a prefix (`area` also matches `area/sub`); id is a prefix; all filters combine with AND.
export function filterTickets(tree: TrackNode, filters: TicketFilters = {}): Ticket[] {
	const track = filters.track?.replace(/^[/\\]+|[/\\]+$/g, "").toLowerCase();
	const type = filters.type?.toLowerCase();
	const status = filters.status?.toLowerCase();
	const id = filters.idPrefix?.replace(/^#/, "").toLowerCase();
	const tickets: Ticket[] = [];
	walkTickets(tree, (ticket) => {
		const ticketTrackName = ticket.track.toLowerCase();
		if (track && ticketTrackName !== track && !ticketTrackName.startsWith(`${track}/`)) return;
		if (type && ticket.type.toLowerCase() !== type) return;
		if (status && ticket.status.toLowerCase() !== status) return;
		if (id && !ticket.id.toLowerCase().startsWith(id)) return;
		tickets.push(ticket);
	});
	return tickets;
}

// One compact ranking line per ticket so a planner can pick ids without reading bodies.
export function ticketIndexLines(tickets: Ticket[], cap = 200): string {
	const shown = tickets.slice(0, Math.max(0, cap));
	const lines = shown.map((ticket) => `${ticket.type} ${ticket.id} ${ticket.status} ${ticket.track || "(root)"} ${ticket.title}`);
	const hidden = tickets.length - shown.length;
	if (hidden > 0) lines.push(`…${hidden} more`);
	return lines.join("\n");
}

// Open = not done. Counts are per exact track path; root-level tickets use `(root)`.
export function ticketCounts(tree: TrackNode): Record<string, number> {
	const counts: Record<string, number> = {};
	walkTickets(tree, (ticket) => {
		if (ticket.status === "done") return;
		const track = ticket.track || "(root)";
		counts[track] = (counts[track] ?? 0) + 1;
	});
	return counts;
}

// A track is completed when its own tickets and every nested track are done; empty folders count.
function trackCompleted(node: TrackNode): boolean {
	return node.issues.every((ticket) => ticket.status === "done") && node.children.every(trackCompleted);
}

// Top-level `archive` is reserved legacy (done tickets once mirrored their track under
// archive/<YYYY-MM>/); nothing writes it.
export const ARCHIVE_DIR = "archive";

// Every completed track node, parents before their nested tracks (root and reserved archive excluded). `/track-clear` acts on these.
export function completedTracks(tree: TrackNode): TrackNode[] {
	const tracks: TrackNode[] = [];
	const visit = (node: TrackNode) => {
		for (const child of node.children) {
			if (child.path.split("/")[0] === ARCHIVE_DIR) continue;
			if (trackCompleted(child)) tracks.push(child);
			visit(child);
		}
	};
	visit(tree);
	return tracks;
}

// Done tickets at any depth in track order. `/ticket-clear` acts on these.
export function doneTickets(tree: TrackNode): Ticket[] {
	const tickets: Ticket[] = [];
	walkTickets(tree, (ticket) => {
		if (ticket.status === "done") tickets.push(ticket);
	});
	return tickets;
}

export const INBOX_DIR = "inbox";

// Rename legacy `<slug>.md` tickets in place, minting a 6-hex id and keeping the track folder.
async function renameLegacyTickets(dir: string, used: Set<string>): Promise<boolean> {
	if (!existsSync(dir)) return false;
	let changed = false;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) changed = (await renameLegacyTickets(path, used)) || changed;
		else if (entry.isFile() && /\.md$/i.test(entry.name) && !TICKET_FILE.test(entry.name)) {
			const ticket = parseTicketFile(readFileSync(path, "utf8"), path);
			const target = join(dir, ticketFileName({ type: ticket.type, id: uniqueTicketId(used), title: ticket.title }));
			await rename(path, target);
			changed = true;
		}
	}
	return changed;
}

// Top-level `.md` files are not a real track: move them under inbox/ (renaming legacy slugs).
async function moveRootTickets(root: string, used: Set<string>): Promise<boolean> {
	if (!existsSync(root)) return false;
	const inbox = join(root, INBOX_DIR);
	let changed = false;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
		const source = join(root, entry.name);
		const ticket = parseTicketFile(readFileSync(source, "utf8"), entry.name);
		const target = join(inbox, entry.name);
		const name = TICKET_FILE.test(entry.name) && !existsSync(target)
			? entry.name
			: ticketFileName({ type: ticket.type, id: uniqueTicketId(used), title: ticket.title });
		await mkdir(inbox, { recursive: true });
		await rename(source, join(inbox, name));
		changed = true;
	}
	return changed;
}

// One-shot `tracks.md` import: the first run writes minted typed filenames and a `.migrated`
// marker inside tracksDir. Later runs skip the ledger, so tickets deleted after the first import
// stay deleted. A populated tree without the marker predates one-shot import, so it is marked
// migrated instead of risking re-adding deleted tickets. Also renames legacy `<slug>.md` tickets
// and moves root tickets to inbox/. Never deletes `tracks.md` (humans compare first).
export async function migrateTracksMd(tracksMdPath: string, tracksDir: string): Promise<number> {
	const tree = readTracksTree(tracksDir);
	const used = ticketIds(tree);
	await moveRootTickets(tracksDir, used);
	await renameLegacyTickets(tracksDir, used);
	const marker = join(tracksDir, MIGRATED_MARKER);
	if (existsSync(marker)) return 0;
	if (!existsSync(tracksMdPath)) return 0;
	const existing = new Set<string>();
	walkTickets(readTracksTree(tracksDir), (ticket) => existing.add(`${ticket.track}\0${ticket.title}`));
	if (existing.size) {
		await mkdir(tracksDir, { recursive: true });
		await writeFile(marker, "", "utf8");
		return 0;
	}
	const tracks = parseTracks(readFileSync(tracksMdPath, "utf8"));
	let added = 0;
	for (const track of tracks) {
		const segments = track.name.split("/").map((segment) => segment.trim()).filter((segment) => segment && segment !== "." && segment !== "..");
		const trackPath = segments.join("/");
		for (const issue of track.issues) {
			const key = `${trackPath}\0${issue.text}`;
			if (existing.has(key)) continue;
			const ticket = { type: "feature" as const, id: uniqueTicketId(used), title: issue.text, status: MIGRATED_STATUS[issue.status], body: issue.detail };
			const dir = segments.length ? join(tracksDir, ...segments) : tracksDir;
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, ticketFileName(ticket)), serializeTicketFile(ticket), "utf8");
			existing.add(key);
			added += 1;
		}
	}
	await mkdir(tracksDir, { recursive: true });
	await writeFile(marker, "", "utf8");
	return added;
}

export function tasksFromPlanText(text: string | undefined, args: string, resumeFrom?: string, skipSteps: string[] = []): LeanTask[] {
	if (text === undefined) return [{ agent: "worker", label: "Lean work", task: args.trim() || "Implement the next approved chunk." }];
	const section = planImplementation(text);
	// /work text is guidance for every child. Select steps only with an explicit scope
	// phrase, so mentioning a step in the guidance does not silently drop plan work.
	const startStep = args.match(/\b(?:start|resume|continue)\s+(?:from|at)\s+(?:step|item|part)?\s*#?\s*(\d+)\b/i)?.[1];
	const onlyStep = args.match(/\b(?:only|just)\s+(?:step|item|part)\s*#?\s*(\d+)\b/i)?.[1];
	// A bare /work resumes at the saved first-unfinished step; explicit text still wins.
	const fromStep = startStep ?? (onlyStep ? undefined : resumeFrom);
	const planSteps = parsedSteps(section)
		.filter((step) => !skipSteps.includes(step.step))
		.filter((step) => !fromStep || Number(step.step) >= Number(fromStep))
		.filter((step) => !onlyStep || step.step === onlyStep);
	const tasks = planSteps.map((planStep, index) => {
		const hasParallelNeighbor = planStep.markedParallel && Boolean(planSteps[index - 1]?.markedParallel || planSteps[index + 1]?.markedParallel);
		const track = planStep.detail.match(/^[ \t]*(?:-[ \t]+)?Track:[ \t]*(.+)$/im)?.[1]?.trim();
		const issue = planStep.detail.match(/^[ \t]*(?:-[ \t]+)?(?:Issue|Ticket):[ \t]*(.+)$/im)?.[1]?.trim();
		const detail = planStep.detail.trimEnd();
		return {
			agent: "worker" as const,
			label: taskLabel(planStep.body),
			task: `Implement plan step ${planStep.step}: ${planStep.body}${detail ? `\n${detail}` : ""}${args.trim() ? `\n\nExtra instruction: ${args.trim()}` : ""}`,
			parallel: hasParallelNeighbor || undefined,
			...(track ? { track } : {}),
			...(issue ? { issue } : {}),
		};
	});
	// Ponytail ceiling: this only extracts flat numbered plan items; nested/semantic "next approved chunk" selection still belongs to a parent planning turn.
	return tasks.length ? tasks : [{ agent: "worker", label: "Lean work", task: `${args.trim() || "Implement the next approved chunk."}\n\nPlan:\n${text.slice(0, 4000)}` }];
}

export function slugify(text: string, max = 40): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "task";
}

export function branchSlug(branch: string, max = 60): string {
	return branch === "unknown" || branch === "HEAD" ? "_detached" : slugify(branch, max);
}

export function runTimestamp(date = new Date()): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

// Run IDs start with a UTC timestamp, so name order is start-time order even when a long
// run finishes after a newer one. Branch is encoded after the timestamp for /runs.
export function runId(branch: string, date = new Date()): string {
	return `${runTimestamp(date)}-${branchSlug(branch)}`;
}

export function taskFileName(index: number, branch: string, label: string): string {
	return `${String(index + 1).padStart(2, "0")}-${branchSlug(branch)}-${slugify(label)}.md`;
}

export function staleRunIds(ids: string[], keep = 3): string[] {
	return [...ids].sort((a, b) => b.localeCompare(a)).slice(Math.max(0, keep));
}

export function reviewVerdict(output: string): "clean" | "blocking" | undefined {
	const last = output.trim().split(/\r?\n/).at(-1)?.trim();
	return (/^REVIEW:\s*(clean|blocking)$/i.exec(last ?? "")?.[1]?.toLowerCase() as "clean" | "blocking" | undefined);
}
