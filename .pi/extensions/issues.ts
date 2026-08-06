import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Tiny project-local issue ledger.
// Entry points: /issue, record_issue, prompt issue expansion.
// Stores one file per issue under the project Map, falling back to cwd/issues.

type Issue = {
	id: number;
	module: string;
	problem: string;
	context?: string;
	evidence?: string[];
	validation?: string;
	scope?: string[];
	done_when?: string;
	createdAt: number;
};

type Store = { nextId: number; issues: Issue[] };

const EMPTY: Store = { nextId: 1, issues: [] };

function projectRoot(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		if (existsSync(join(current, ".git")) || existsSync(join(current, "Map"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

function issuesDir(cwd: string): string {
	const root = projectRoot(cwd);
	return existsSync(join(root, "Map")) ? join(root, "Map", "issues") : join(cwd, "issues");
}

function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "issue";
}

function issuePath(cwd: string, issue: Issue): string {
	return join(issuesDir(cwd), `${issue.id}-${slug(`${issue.module}-${issue.problem}`)}.json`);
}

function legacyStorePaths(cwd: string): string[] {
	return [join(cwd, "light-flow", "issues.json"), join(cwd, ".pi", "light-flow", "issues.json")];
}

async function load(cwd: string): Promise<Store> {
	try {
		const names = await readdir(issuesDir(cwd));
		const issues: Issue[] = [];
		for (const name of names.filter((name) => name.endsWith(".json"))) {
			issues.push(JSON.parse(await readFile(join(issuesDir(cwd), name), "utf8")) as Issue);
		}
		issues.sort((a, b) => a.id - b.id);
		if (issues.length) return { nextId: Math.max(1, ...issues.map((issue) => issue.id + 1)), issues };
	} catch (err: any) {
		if (err?.code !== "ENOENT") throw err;
	}
	return { ...EMPTY, issues: [] };
}

async function save(cwd: string, store: Store): Promise<void> {
	const dir = issuesDir(cwd);
	await mkdir(dir, { recursive: true });
	const keep = new Set<string>();
	for (const issue of store.issues) {
		const path = issuePath(cwd, issue);
		keep.add(path);
		await writeFile(path, `${JSON.stringify(issue, null, "\t")}\n`, "utf8");
	}
	for (const name of await readdir(dir)) {
		const path = join(dir, name);
		if (name.endsWith(".json") && !keep.has(path)) await rm(path, { force: true });
	}
	for (const path of legacyStorePaths(cwd)) await rm(path, { force: true });
}

function title(issue: Issue): string {
	return `#${issue.id} ${issue.module}: ${issue.problem}`;
}

function full(issue: Issue): string {
	const lines = [title(issue)];
	if (issue.context) lines.push(`context: ${issue.context}`);
	if (issue.scope?.length) lines.push(`scope: ${issue.scope.join(", ")}`);
	if (issue.evidence?.length) lines.push(`evidence: ${issue.evidence.join(", ")}`);
	if (issue.validation) lines.push(`validation: ${issue.validation}`);
	if (issue.done_when) lines.push(`done_when: ${issue.done_when}`);
	return lines.join("\n");
}

function listText(issues: Issue[]): string {
	if (issues.length === 0) return "No open issues.";
	return issues.map(full).join("\n\n");
}

function splitCsv(text: string | undefined): string[] | undefined {
	const values = (text ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return values.length ? values : undefined;
}

function cleanFreeform(text: string): string {
	return text
		.replace(/\b(?:problem|issue|bug)?\s*discussed in (?:this|the) context\b/gi, "")
		.replace(/\bwhat we discussed\b/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

function inferFreeformIssue(text: string): Omit<Issue, "id" | "createdAt"> | undefined {
	const cleaned = cleanFreeform(text);
	if (!cleaned) return undefined;
	const lower = cleaned.toLowerCase();
	const moduleParts = [];
	if (/\bruntime|rust|lua\b/.test(lower)) moduleParts.push("runtime");
	if (/\bhoudini|sop|hda|charge\b/.test(lower)) moduleParts.push("houdini");
	if (/\bdatatable|data\s*table|crdt\b/.test(lower)) moduleParts.push("datatables");
	if (/\brender|viewport|vulkan|shadow\b/.test(lower)) moduleParts.push("renderer");
	const module = moduleParts.length ? [...new Set(moduleParts)].join("/") : "general";
	const problem = cleaned.replace(/\brust\b/g, "Rust").replace(/\blua\b/g, "Lua").replace(/\bdatatable\b/gi, "DataTable");
	return { module, problem };
}

function parseNewIssue(args: string): Omit<Issue, "id" | "createdAt"> | undefined {
	let text = args.replace(/^add\s+/i, "").trim();
	const freeform = /^mark:?\s+/i.test(text);
	if (freeform) return inferFreeformIssue(text.replace(/^mark:?\s+/i, ""));

	const colon = text.match(/^([^:;]{2,80}):\s*([^;]+)(?:;\s*(.*))?$/);
	if (colon) {
		return { module: colon[1].trim(), problem: cleanFreeform(colon[2]), context: colon[3]?.trim() || undefined };
	}

	const match = text.match(/^(\S+)\s+([^;]+)(?:;\s*(.*))?$/);
	if (!match) return undefined;
	return {
		module: match[1].trim().replace(/:$/, ""),
		problem: cleanFreeform(match[2]),
		context: match[3]?.trim() || undefined,
	};
}

function sameIssue(a: Pick<Issue, "module" | "problem">, b: Pick<Issue, "module" | "problem">): boolean {
	return a.module.toLowerCase() === b.module.toLowerCase() && a.problem.toLowerCase() === b.problem.toLowerCase();
}

function parseIds(text: string): number[] {
	const ids = new Set<number>();
	for (const match of text.matchAll(/#(\d+)\b/g)) ids.add(Number(match[1]));
	for (const match of text.matchAll(/\bissues?\s+((?:#?\d+\s*(?:,|and|or|maybe)?\s*)+)/gi)) {
		for (const id of match[1].matchAll(/\d+/g)) ids.add(Number(id[0]));
	}
	return [...ids].sort((a, b) => a - b);
}

function words(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[a-z0-9_/-]{3,}/g) ?? []);
}

function stripInjectedIssues(text: string): string {
	return text.replace(/\n\nRelevant open issues:\n[\s\S]*$/m, "");
}

function referencedIssues(text: string, issues: Issue[]): Issue[] {
	const lower = stripInjectedIssues(text).toLowerCase();
	if (!/\bissues?\b|#\d+\b/.test(lower)) return [];
	if (/\ball\s+issues\b|\bissues\s+all\b/.test(lower)) return issues;

	const ids = parseIds(text);
	if (ids.length) return issues.filter((issue) => ids.includes(issue.id));

	const promptWords = words(text);
	const scored = issues
		.map((issue) => {
			let score = 0;
			const module = issue.module.toLowerCase();
			if (lower.includes(module)) score += 5;
			for (const part of module.split(/[/-]/)) if (part.length >= 3 && promptWords.has(part)) score += 2;
			for (const word of words(issue.problem)) if (promptWords.has(word)) score += 1;
			return { issue, score };
		})
		.filter(({ score }) => score >= 2)
		.sort((a, b) => b.score - a.score);

	return scored.slice(0, 5).map(({ issue }) => issue);
}

function updateStatus(ctx: any, count: number): void {
	ctx.ui.setStatus("issues", count ? `issues:${count}` : "issues:0");
}

function issuesForSelector(selector: string, issues: Issue[]): Issue[] {
	const text = selector.trim();
	if (/^all$/i.test(text)) return issues;

	const ids = [...text.matchAll(/#?(\d+)\b/g)].map((m) => Number(m[1]));
	if (ids.length) return issues.filter((issue) => ids.includes(issue.id));

	const lower = text.toLowerCase();
	const exactModule = issues.filter((issue) => issue.module.toLowerCase() === lower);
	if (exactModule.length) return exactModule;

	const substring = issues.filter((issue) => `${issue.module} ${issue.problem}`.toLowerCase().includes(lower));
	if (substring.length) return substring;

	return referencedIssues(`issue ${text}`, issues);
}

export default function lightFlowIssues(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const store = await load(ctx.cwd);
		await save(ctx.cwd, store);
		updateStatus(ctx, store.issues.length);
	});

	pi.registerCommand("issue", {
		description: "Project issue files in Map/issues (or cwd/issues without Map): /issue <module> <problem>; context | /issue list | /issue clear <ids|all|module|text> | /issue <id> <more context>",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			const store = await load(ctx.cwd);

			if (!args || /^list$/i.test(args)) {
				ctx.ui.notify(listText(store.issues), "info");
				updateStatus(ctx, store.issues.length);
				return;
			}

			const clear = args.match(/^(?:clear|done)(?:\s+(.+))?$/i);
			if (clear) {
				const selector = clear[1]?.trim() || "all";
				const selected = issuesForSelector(selector, store.issues);
				if (selected.length === 0) {
					ctx.ui.notify(`No issues match: ${selector}`, "warning");
					return;
				}
				const ids = new Set(selected.map((issue) => issue.id));
				store.issues = store.issues.filter((issue) => !ids.has(issue.id));
				await save(ctx.cwd, store);
				updateStatus(ctx, store.issues.length);
				ctx.ui.notify(`Cleared ${selected.length} issue(s).`, "info");
				return;
			}

			const append = args.match(/^(\d+)\s+(.+)$/);
			if (append) {
				const issue = store.issues.find((item) => item.id === Number(append[1]));
				if (!issue) {
					ctx.ui.notify(`No issue #${append[1]}.`, "warning");
					return;
				}
				issue.context = [issue.context, append[2].trim()].filter(Boolean).join("\n");
				await save(ctx.cwd, store);
				ctx.ui.notify(`Updated ${title(issue)}`, "info");
				return;
			}

			const parsed = parseNewIssue(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /issue <module> <problem>; optional context", "warning");
				return;
			}

			const existing = store.issues.find((issue) => sameIssue(issue, parsed));
			if (existing) {
				if (parsed.context) existing.context = [existing.context, parsed.context].filter(Boolean).join("\n");
				await save(ctx.cwd, store);
				updateStatus(ctx, store.issues.length);
				ctx.ui.notify(`Already exists ${title(existing)}`, "info");
				return;
			}

			const issue: Issue = { id: store.nextId++, createdAt: Date.now(), ...parsed };
			store.issues.push(issue);
			await save(ctx.cwd, store);
			updateStatus(ctx, store.issues.length);
			ctx.ui.notify(`Added ${title(issue)}`, "info");
		},
	});

	pi.registerTool({
		name: "record_issue",
		label: "Record Issue",
		description: "Record a project-local open issue in Map/issues (or cwd/issues without Map) for later planning/work. Include enough context for a fresh planning agent to act without this chat.",
		promptSnippet: "Record a project-local issue with module, concise problem, detailed context, concrete evidence, validation, scope, and done_when when available.",
		promptGuidelines: [
			"Use record_issue only when the user asks to defer a discovered problem or when fixing it now would expand scope.",
			"Write it for a fresh planning agent: what is broken/missing, why it matters, where you saw it, smallest validation, and completion criteria.",
			"Do not record vague references like 'what we discussed'; summarize the actual technical issue from the current context.",
			"record_issue issues are project-local and temporary; do not use it for permanent project rules.",
		],
		parameters: Type.Object({
			module: Type.String({ description: "Affected project area, e.g. runtime/world, houdini/dso, renderer/shadows, audit/houdini" }),
			problem: Type.String({ description: "Concise issue title naming the broken/missing behavior" }),
			context: Type.Optional(Type.String({ description: "Detailed self-contained summary for a fresh planning agent: what happened, expected behavior, current behavior, constraints/decisions, and why it matters" })),
			evidence: Type.Optional(Type.Array(Type.String(), { description: "Concrete evidence: files, functions, commands, errors, observations, or exact paths to inspect" })),
			validation: Type.Optional(Type.String({ description: "Smallest useful check/manual repro that would prove the issue or fix" })),
			scope: Type.Optional(Type.Array(Type.String(), { description: "Directories/modules/files the future task should inspect" })),
			done_when: Type.Optional(Type.String({ description: "Observable completion criteria for closing the issue" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await load(ctx.cwd);
			const existing = store.issues.find((issue) => sameIssue(issue, params));
			if (existing) {
				await save(ctx.cwd, store);
				updateStatus(ctx, store.issues.length);
				return {
					content: [{ type: "text", text: `Already exists ${title(existing)}` }],
					details: { issue: existing },
				};
			}

			const issue: Issue = { id: store.nextId++, createdAt: Date.now(), ...params };
			store.issues.push(issue);
			await save(ctx.cwd, store);
			updateStatus(ctx, store.issues.length);
			return {
				content: [{ type: "text", text: `Recorded ${title(issue)}` }],
				details: { issue },
			};
		},
	});

	pi.on("input", async (event, ctx) => {
		const baseText = stripInjectedIssues(event.text);
		if (event.source === "extension" || baseText.startsWith("/issue")) return { action: "continue" };
		const store = await load(ctx.cwd);
		if (store.issues.length === 0) return { action: "continue" };

		const matched = referencedIssues(baseText, store.issues);
		if (matched.length === 0) return { action: baseText === event.text ? "continue" : "transform", text: baseText };

		return {
			action: "transform",
			text: `${baseText}\n\nRelevant open issues:\n${matched.map(title).join("\n")}`,
		};
	});
}
