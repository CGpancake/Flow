// Lean workflow tools and TUI. Entry points: grill_batch and lean subagent commands. Split when their concerns diverge.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, CONFIG_DIR_NAME, convertToLlm, createAgentSession, DefaultResourceLoader, getAgentDir, serializeConversation, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	appendPlanStep,
	branchSlug,
	clearCompleted,
	PLAN_HEADING,
	planGoal,
	planStepCount,
	planStepsFromText,
	planTrack,
	parseTracks,
	pathRefs,
	reviewVerdict,
	runId as makeRunId,
	setIssueStatus,
	slugify,
	staleRunIds,
	taskFileName,
	taskLabel,
	tasksFromPlanText,
	type LeanAgent,
	type LeanTask,
	type PlanStep,
} from "../../lean-flow-plan.ts";

const LEAN_SYSTEM_BASE = `LEAN FLOW ACTIVE. CONCISE PONYTAIL-FULL BASELINE; DO NOT AUTO-LOAD SKILLS.
Permanent rules for the parent agent:
- Ponytail full: understand and trace the real flow first, then stop at the first working rung: skip speculative work; reuse project code; stdlib; native platform; installed dependency; one line; minimum code.
- Be lazy like a senior dev: the best code is code not written. YAGNI wins: delete before adding; no future-proof abstractions, boilerplate, scaffolding, factories, or one-implementation interfaces.
- Code is source of truth. Use rg/find/read before assuming: rg for filenames/line numbers, then read only tight offset/limit slices. For bugs, trace every caller and fix the shared root cause, not the named symptom.
- Preserve requested validation, data-loss prevention, security, accessibility, and error handling. Pick the edge-case-correct stdlib option; mark deliberate shortcut ceilings with a ponytail comment and upgrade path.
- Keep modules feature/function focused and readable; split by reason-to-change, not type buckets; ~500-1000 lines is a warning, not a law.
- Non-trivial modules should start with a short header: purpose, main entry points, and split trigger. When browsing, rg module headers first, then read matching files.
- Non-trivial logic needs the smallest runnable check; trivial one-liners do not.
- Output caveman-terse: code/actions first, then at most three short lines.
- Use batched grill only when ambiguity changes implementation. Generate the whole question batch at once, then evaluate answers as a batch.
- If context usage reaches about 50%, prepare a /handover and stop instead of compacting by default.
- Tracks live in the committed .pi/tracks.md: tick completed issues as "- [x]" and add new issues under the right track; never rewrite unrelated tracks.`;

const LEAN_SYSTEM_WORKFLOW = `
- No long-term memory, lifecycle docs, ADRs, or issue tracker ceremony unless the user explicitly asks.
- For large chunks: grill -> short temporary plan -> pass the full atomic task list to lean_subagent_chain for TUI display -> worker chain -> fresh review -> human validation gate.
- Lean-flow owns subagents. Use lean_subagent_chain, not external subagent tools/workflows.
- Keep subagents lazy: worker for atomic write tasks, reviewer for read-only review, researcher for read-only research. Use as many chain steps as needed; no arbitrary cap.
- Subagent chain tasks must have descriptive labels in 3 words or fewer so the TUI shows what is happening.`;

function leanSystem(): string {
	return `${LEAN_SYSTEM_BASE}${LEAN_SYSTEM_WORKFLOW}`;
}

const PONYTAIL_DIGEST = `PONYTAIL FULL:
Understand first: trace real flow + every caller. Bug fix = shared root cause, not symptom.
Stop at first working rung: YAGNI -> reuse project code -> stdlib -> native -> installed dep -> one line -> minimum.
Delete before adding. No unrequested abstractions, one-impl interfaces, factories, boilerplate, scaffolding.
Shortest working diff; boring over clever. Keep validation, security, data-loss prevention, accessibility.
Non-trivial logic leaves one smallest runnable check; trivial one-liners need none.
Mark shortcut ceilings with a ponytail comment: ceiling + upgrade path.
Output caveman-terse: code first, max three short lines.`;

const HANDOFF_SYSTEM = `Generate a focused handover prompt for a fresh Pi session.
Include only: current goal, decisions, relevant files, changed files, open issues, validation status, blockers, and exact next task.
Use the supplied plan and repo state as fact; do not invent state. Keep it concise and self-contained. No preamble.`;

type GrillQuestion = {
	id?: string;
	question: string;
	reason: string;
	recommendation: string;
	alternatives?: string[];
	defaultAssumption?: string;
};

type LeanUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	contextTokens: number;
	contextWindow?: number;
};

type LeanTaskProgress = LeanTask & {
	status: "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";
	thinking?: string;
	usage?: LeanUsage;
	latest?: string;
	output?: string;
	phase?: string;
	pid?: number;
	startedAt?: number;
	updatedAt?: number;
	endedAt?: number;
	events?: Record<string, number>;
};

type ChildProgress = Partial<Pick<LeanTaskProgress, "latest" | "output" | "phase" | "pid" | "events" | "usage">>;

type LeanChainDetails = {
	tasks: LeanTaskProgress[];
	current: number;
	statuses: LeanTaskProgress["status"][];
	usage?: string;
	thinking?: string;
	currentTask?: string;
	currentOutput?: string;
	note?: string;
	// Plan goal, so the live work widget can render the same `Plan n/m · goal` header
	// as the plan overlay instead of a bare row list.
	goal?: string;
};

type LeanChainResult = {
	content: { type: "text"; text: string }[];
	details?: LeanChainDetails | Record<string, unknown>;
	isError?: boolean;
	paused?: boolean;
};

type LeanChainUpdate = {
	content: { type: "text"; text: string }[];
	details: LeanChainDetails;
};

type ActiveWorkJob = {
	tasks: LeanTask[];
	progress: LeanTaskProgress[];
	details: LeanChainDetails;
	controller: AbortController;
	pauseRequested: boolean;
	startedAt: number;
	// Set when /reload or a session switch invalidates this extension instance; the chain then
	// finishes its abort without touching the dead pi/ctx, and the new instance resumes from
	// plan-state.json.
	detached?: boolean;
};

type LastWorkJob = {
	status: "complete" | "cancelled" | "failed" | "paused";
	summary: string;
	details: LeanChainDetails;
	finishedAt: number;
};

const PER_TASK_OUTPUT_CAP = 2_000;

// Fixed model for all children, independent of the parent session.
// Falls back to ctx.model if DeepSeek auth is unavailable.
const CHILD_MODEL = { provider: "deepseek", id: "deepseek-flash" };

// Single source of truth: role, tools, and full prompt. No prompt logic elsewhere.
const AGENTS: Record<LeanAgent, { tools: string; prompt: string; extensions?: boolean }> = {
	worker: {
		tools: "read,bash,edit,write",
		prompt: `You are lean.worker: an atomic implementation child.

Rules:
- Ponytail/YAGNI is mandatory: be lazy like a senior dev; smallest working diff, no ceremony.
- Do exactly one assigned task. If broad, stop and ask for a narrower task.
- Use rg/find/read before editing: rg for filenames/line numbers, then read only tight offset/limit slices. For bug fixes, rg callers and fix the shared root cause.
- Delete before adding. Prefer stdlib/native/project-local code. No new dependencies unless explicitly approved.
- No speculative abstractions, no factories/interfaces for one implementation, no scaffolding for later.
- Keep modules feature/function focused and readable; split only by reason-to-change.
- For non-trivial modules you touch, keep/add a tiny top header: purpose, main entry points, split trigger. Use rg over headers first; avoid broad reads unless slices prove insufficient.
- Do not create memory/docs/ADRs/plans. Code and tests are the source of truth.
- If .pi/tracks.md has the issue you completed, tick it "- [x]"; add new issues under the right track; never rewrite unrelated tracks.
- Run the smallest relevant check. If no automated check exists, say so.
- Output caveman-terse: changed files; checks; blockers; manual validation. No essays.

Output: changed files; checks run + result; blockers/decisions; manual validation needed.

${PONYTAIL_DIGEST}`,
	},
	reviewer: {
		tools: "read,bash",
		prompt: `You are lean.reviewer: a read-only reviewer. Ponytail/YAGNI is mandatory.

Review only. Do not modify project/source files.
Inspect the actual repo/diff with git diff, rg, and read. Report only evidence-backed findings.

Axes: correctness/regressions; missed acceptance criteria or plan drift; AGENTS.md/guideline inconsistencies; module header/searchability gaps; validation gaps; over-engineering/deletion. Prefer findings that delete or simplify.

Output concise findings with severity, file/line or command evidence, what to change, and smallest safe fix. If nothing worth fixing now, say that.

${PONYTAIL_DIGEST}`,
	},
	researcher: {
		tools: "read,grep,bash,web_search,fetch_content",
		extensions: true,
		prompt: `You are lean.researcher: read-only research child. CAVEMAN MODE. Terse. No filler.

- Read only. No edit. No write. No mutate. Bash read-only.
- Research brief: find answer. Repo first, web if needed. Trace flow and callers. Cite file:line or URL.
- Facts vs guesses separate. Name uncertainty. Name blockers.
- Reuse existing code, stdlib, native, installed deps. No new dependency.

Output: answer; evidence; uncertainty; next step. Fragments. No essay.`,
	},
};

function emptyUsage(contextWindow?: number): LeanUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0, contextWindow };
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${Math.round(count / 1000)}k`;
	return `${count}`;
}

function usageTotal(usage?: LeanUsage): number {
	if (!usage) return 0;
	return usage.input + usage.output + usage.cacheWrite;
}

function padLeftVisible(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function padRightVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function compactDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function contextPercent(usage?: LeanUsage): string {
	if (!usage?.contextTokens || !usage.contextWindow) return "--";
	return `${Math.round((usage.contextTokens / usage.contextWindow) * 100)}%`;
}

// One glyph after the rail names the child's role. Nerd Font private-use icons, not emoji: the terminal
// draws these with the monospace font, so they inherit the row colour (an emoji glyph would not).
const AGENT_TAG: Record<LeanAgent, string> = { worker: "\uF0AD", reviewer: "\uF002", researcher: "\uF0C3" };

function statusRail(task: LeanTaskProgress, ctxSeparator = "/"): string {
	const usage = task.usage;
	const ctx = contextPercent(usage);
	const ctxTokens = usage?.contextTokens ? formatTokens(usage.contextTokens) : "--";
	const input = usage?.input ? formatTokens(usage.input) : "--";
	const output = usage?.output ? formatTokens(usage.output) : "--";
	// A finished task freezes its clock; only a running one may still tick.
	const end = task.endedAt ?? (task.status === "running" ? Date.now() : undefined);
	const clock = task.startedAt && end ? compactDuration(end - task.startedAt) : "--:--";
	return ` │ ctx ${padLeftVisible(ctx, 4)} ${ctxSeparator} ${padRightVisible(ctxTokens, 5)} │ ↑ ${padLeftVisible(input, 5)} │ ↓ ${padLeftVisible(output, 5)} │ ◷ ${padLeftVisible(clock, 5)} │ ${AGENT_TAG[task.agent] ?? ""}`;
}

// Queued rows carry the role glyph too, so the column reads the same before a task starts.
function queuedRail(task: Pick<LeanTaskProgress, "parallel" | "agent">): string {
	return ` │ ${queuedText(task)} ${AGENT_TAG[task.agent] ?? ""}`;
}

function formatUsage(usage?: LeanUsage): string | undefined {
	if (!usage) return undefined;
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns}⟳`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) {
		const percent = usage.contextWindow ? ` ${Math.round((usage.contextTokens / usage.contextWindow) * 100)}%` : "";
		parts.push(`ctx:${formatTokens(usage.contextTokens)}${percent}`);
	}
	const total = usageTotal(usage);
	return parts.length ? `${formatTokens(total)} tok · ${parts.join(" ")}` : undefined;
}

function cloneUsage(usage: LeanUsage): LeanUsage {
	return { ...usage };
}

function taskAge(task: LeanTaskProgress): string | undefined {
	const end = task.endedAt ?? (task.status === "running" ? Date.now() : undefined);
	return task.startedAt && end ? `${Math.max(0, Math.round((end - task.startedAt) / 1000))}s` : undefined;
}

function queuedText(task: Pick<LeanTaskProgress, "parallel">): string {
	return task.parallel ? "queued ∥" : "queued";
}

async function runPiChild(ctx: ExtensionContext, task: LeanTask, contextWindow: number | undefined, signal?: AbortSignal, onData?: (progress: ChildProgress) => void, onWrite?: (path: string) => void): Promise<{ code: number | null; output: string; cancelled?: boolean }> {
	if (signal?.aborted) return { code: null, output: "Cancelled before start.", cancelled: true };
	const agent = AGENTS[task.agent];
	const usage = emptyUsage(contextWindow);
	const feed: string[] = [];
	let output = "";
	let live = "starting sdk child";
	let phase = "starting";
	const events: Record<string, number> = {};
	const textBlocks = (content: any) => Array.isArray(content)
		? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n")
		: "";
	const bump = (type: string) => { events[type] = (events[type] ?? 0) + 1; };
	const addFeed = (text: string) => {
		const compact = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ⏎ ");
		if (!compact || compact === feed.at(-1)?.replace(/^\S+\s+/, "")) return;
		feed.push(`${new Date().toLocaleTimeString()} ${compact}`);
		while (feed.length > 80) feed.shift();
	};
	const publish = () => onData?.({ latest: live.split(/\r?\n/).filter(Boolean).slice(-1)[0] || phase, output: feed.join("\n") || output, phase, events: { ...events }, usage: cloneUsage(usage) });
	const updateContext = (session: Awaited<ReturnType<typeof createAgentSession>>["session"]) => {
		const stats = session.getSessionStats?.();
		const tokens = stats?.tokens;
		if (tokens) {
			usage.input = tokens.input ?? usage.input;
			usage.output = tokens.output ?? usage.output;
			usage.cacheWrite = tokens.cacheWrite ?? usage.cacheWrite;
		}
		const context = stats?.contextUsage;
		if (typeof context?.tokens === "number") usage.contextTokens = context.tokens;
		if (typeof context?.contextWindow === "number") usage.contextWindow = context.contextWindow;
		else if (contextWindow) usage.contextWindow = contextWindow;
	};

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		noExtensions: !agent.extensions,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		appendSystemPromptOverride: () => [agent.prompt],
	});
	await loader.reload();
	const childModel = ctx.modelRegistry.find(CHILD_MODEL.provider, CHILD_MODEL.id) ?? ctx.model;
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		modelRegistry: ctx.modelRegistry,
		model: childModel,
		tools: agent.tools.split(","),
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(ctx.cwd),
	});

	const onAbort = () => session.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	const unsubscribe = session.subscribe((event: any) => {
		bump(event.type ?? "event");
		updateContext(session);
		if (event.type === "agent_start") { phase = "agent starting"; live = "agent starting"; addFeed(live); publish(); }
		if (event.type === "turn_start") { phase = "thinking"; live = "thinking..."; addFeed(live); publish(); }
		if (event.type === "message_update") {
			const ae = event.assistantMessageEvent;
			bump(ae?.type ?? "message_delta");
			if (ae?.type === "thinking_delta") { phase = "thinking"; live = "thinking..."; }
			else if (ae?.type === "text_delta") { phase = "responding"; live = "responding..."; }
			else if (ae?.type?.startsWith?.("toolcall")) { phase = "preparing tool"; live = `preparing ${ae.toolCall?.name ?? "tool"}...`; }
			else { phase = "model event"; live = ae?.type ?? "model event"; }
			publish();
		}
		if (event.type === "tool_execution_start") {
			if ((event.toolName === "write" || event.toolName === "edit") && typeof event.args?.path === "string") onWrite?.(event.args.path);
			phase = `running ${event.toolName}`;
			live = `running ${event.toolName}...\n${JSON.stringify(event.args ?? {})}`;
			addFeed(live); publish();
		}
		if (event.type === "tool_execution_update") {
			phase = `running ${event.toolName}`;
			live = `running ${event.toolName}...`;
			publish();
		}
		if (event.type === "tool_execution_end") {
			const text = textBlocks(event.result?.content);
			phase = event.isError ? `${event.toolName} failed` : `${event.toolName} done`;
			live = `${phase}${text ? `\n${text}` : ""}`;
			addFeed(live); publish();
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			usage.turns++;
			const text = textBlocks(event.message.content);
			if (text) { output += `${text}\n`; phase = "assistant output"; live = text; addFeed(live); }
			updateContext(session);
			publish();
		}
		if (event.type === "turn_end") { phase = "turn done"; live = "turn done"; publish(); }
		if (event.type === "agent_end") { phase = "agent done"; live = output.trim() || "agent done"; addFeed(live); publish(); }
	});

	try {
		publish();
		await session.prompt(task.task);
		updateContext(session);
		const text = output.trim();
		return text ? { code: 0, output: text } : { code: 1, output: "Child produced no assistant message (empty output)." };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (signal?.aborted) {
			phase = "cancelled";
			live = "Cancelled.";
			addFeed(live);
			publish();
			const text = output.trim();
			return text ? { code: null, output: text, cancelled: true } : { code: 1, output: "Child produced no assistant message (empty output)." };
		}
		phase = "failed";
		live = message;
		addFeed(live);
		publish();
		return { code: 1, output: (output || message).trim() };
	} finally {
		unsubscribe();
		signal?.removeEventListener("abort", onAbort);
	}
}
function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		} as AgentMessage;
	}
	return undefined;
}

function handoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	// Keep the newest compaction summary plus only the last 30 turns after it.
	const summary = compactionIndex < 0 ? [] : branch.slice(compactionIndex, compactionIndex + 1);
	const recent = (compactionIndex < 0 ? branch : branch.slice(compactionIndex + 1)).slice(-30);
	return [...summary, ...recent].map(entryToMessage).filter((m): m is AgentMessage => m !== undefined);
}

// This runs per render tick. Outside a repo git walks up to the mount point and prints
// "fatal: not a git repository" / "Stopping at filesystem boundary" onto the TUI, so find
// out whether cwd is in a repo before spawning anything, and cache it briefly.
const repoCache = new Map<string, { repo: boolean; at: number }>();

function inRepo(cwd: string): boolean {
	const cached = repoCache.get(cwd);
	if (cached && Date.now() - cached.at < 30_000) return cached.repo;
	let repo = false;
	for (let dir = resolve(cwd); ;) {
		if (existsSync(join(dir, ".git"))) {
			repo = true;
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	repoCache.set(cwd, { repo, at: Date.now() });
	return repo;
}

function gitText(cwd: string, args: string[]): string {
	if (!inRepo(cwd)) return "";
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

// All files in .pi/issues are open by definition; issues.ts has no closed state.
function openIssueTitles(cwd: string): string[] {
	const dir = join(cwd, CONFIG_DIR_NAME, "issues");
	if (!existsSync(dir)) return [];
	const issues: { id: number; title: string }[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const issue = JSON.parse(readFileSync(join(dir, name), "utf8")) as { id?: unknown; module?: unknown; problem?: unknown };
			if (typeof issue.id !== "number" || typeof issue.module !== "string" || typeof issue.problem !== "string") continue;
			issues.push({ id: issue.id, title: `#${issue.id} ${issue.module}: ${issue.problem}` });
		} catch {
			// Ignore a malformed issue file; one bad ledger entry must not block handover.
		}
	}
	return issues.sort((a, b) => a.id - b.id).map((issue) => issue.title);
}

function handoverRepoState(cwd: string): string {
	// ponytail: a completed plan stays on disk for /plan to replace or /work-add to extend.
	const plan = planSteps(cwd);
	const issues = openIssueTitles(cwd);
	const status = gitText(cwd, ["status", "-sb"]);
	const changed = status.split("\n").slice(1).map((line) => line.slice(3).trim()).filter(Boolean);
	return [
		`Plan goal: ${plan?.goal || "none"}`,
		...(plan?.steps.length ? ["Remaining plan steps:", ...plan.steps.map((step) => `${step.step}. ${step.body}`)] : []),
		`Open issues: ${issues.length ? issues.join("; ") : "none"}`,
		`Git status -sb:\n${status || "unknown"}`,
		`Changed files: ${changed.length ? changed.join(", ") : "none"}`,
	].join("\n");
}

function send(pi: ExtensionAPI, text: string, expandPromptTemplates = false) {
	pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates });
}

function planDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "lean-flow", branchSlug(gitBranch(cwd)));
}

// .pi is local scratch space except tracks.md (committed issue ledger) and extension code.
async function ensurePiGitignore(cwd: string): Promise<void> {
	const path = join(cwd, CONFIG_DIR_NAME, ".gitignore");
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	const lines = existing.split(/\r?\n/);
	const missing = ["*", "!tracks.md", "!extensions/", "!extensions/**"].filter((line) => !lines.includes(line));
	if (!missing.length) return;
	const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
	await writeFile(path, existing + prefix + missing.join("\n") + "\n", "utf8");
}

async function ensureLeanDir(cwd: string): Promise<string> {
	const dir = planDir(cwd);
	await mkdir(dir, { recursive: true });
	await ensurePiGitignore(cwd);
	return dir;
}

function planPath(cwd: string): string {
	return join(planDir(cwd), "plan.md");
}

function readPlan(cwd: string): string | undefined {
	const path = planPath(cwd);
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

const PLAN_RULES = `Decompose only agent-executable work into atomic numbered implementation tasks; exclude human validation, approvals, interaction, and other user-owned steps from that task list. Make the chain complete before its human-validation gate, then mention any remaining human validation separately as a non-task note. For each independent consecutive batch, mark every task in that batch [parallel] (a lone marker remains serial); two [parallel] steps must never touch the same file. Use rg for filenames/line numbers, then read only tight offset/limit slices for the code map. Ask grill_batch first if any ambiguity changes implementation. Keep every section other than ## Implementation as a ### subheading inside it, or /work reads zero steps. Start each step with a 2-4 word action phrase carrying no path, slash, or inline code, then name the file: the label in the plan widget is that leading phrase.`;

function planPrompt(scope: string): string {
	return `Create a dependency-aware implementation plan. ${PLAN_RULES} Then call save_plan. No memory/docs/ADRs. Scope:\n${scope}`;
}

function planAddPrompt(current: string, scope: string): string {
	const highest = planStepsFromText(current).steps.reduce((max, step) => Math.max(max, Number(step.step) || 0), 0);
	const track = planTrack(current);
	return `Extend the existing plan instead of replacing it. Keep every existing numbered step byte-identical: same number, text, order, and indented detail lines; no rewrite, no renumbering, no reordering, and no edits to the title or other sections. Append only new atomic numbered steps to the ## Implementation section, continuing after the highest existing number (next step: ${highest + 1}). ${PLAN_RULES} Then call save_plan with the merged document, passing the current title${track ? ` and track "${track}"` : ""}. A running /work picks the new steps up at its next boundary. No memory/docs/ADRs. Scope for the new steps:\n${scope || "Use the current conversation goal."}\n\nCurrent plan.md:\n\n${current}`;
}

function startPlan(pi: ExtensionAPI, ctx: ExtensionContext, input: string): void {
	const name = input.match(/^track\s+(.+)$/i)?.[1]?.trim();
	const track = name ? trackScope(ctx.cwd, name) : undefined;
	if (name && !track) {
		unknownTrack(ctx, name);
		return;
	}
	const scope = track
		? `Work the "${track.name}" track from .pi/tracks.md. Emit exactly one numbered implementation step per open issue (marker [ ] or [-]); skip [x] issues. Carry an indented \`Track: ${track.name}\` line and an \`Issue: <issue text>\` line under each step, and use the issue detail to shape the step. Issues:\n${track.issues}`
		: input || "Use the current conversation goal.";
	send(pi, planPrompt(scope));
}

function canonicalPlan(title: string, markdown: string, track?: string): string {
	const body = markdown.trim().replace(/^#\s+.*(?:\r?\n)+/, "").replace(/^(?:[ \t]*track[ \t]*:[^\n]*\r?\n)+/i, "");
	const head = `# ${title}\n\n${track?.trim() ? `Track: ${track.trim()}\n\n` : ""}`;
	if (!PLAN_HEADING.test(body)) return `${head}## Implementation\n\n${body}\n`;
	return `${head}${body.replace(PLAN_HEADING, (heading) => `${heading.startsWith("\n") ? "\n" : ""}## Implementation\n`).trim()}\n`;
}

function leanPlanStepCount(cwd: string): number {
	const path = planPath(cwd);
	if (!existsSync(path)) return 0;
	return planStepCount(readFileSync(path, "utf8"));
}

function planSteps(cwd: string): { goal: string; track?: string; steps: PlanStep[] } | undefined {
	const path = planPath(cwd);
	if (!existsSync(path)) return undefined;
	const text = readFileSync(path, "utf8");
	return { ...planStepsFromText(text), track: planTrack(text) };
}

type PlanOverlayRow = { step: string; label: string; parallel?: boolean; task?: LeanTaskProgress };

function planRows(plan: { goal?: string; steps: PlanStep[] }, tasks: LeanTaskProgress[], goal?: string): PlanOverlayRow[] {
	// Tasks only belong to a plan's steps when both came from the same goal; a replaced plan
	// reuses step numbers for different work.
	const paired = goal === undefined || goal === plan.goal;
	return plan.steps.map((step) => ({
		step: step.step,
		label: taskLabel(step.body),
		parallel: step.parallel,
		task: paired ? tasks.find((task) => task.task.match(/\bplan step (\d+)\s*:/)?.[1] === step.step) : undefined,
	}));
}

function planStepProgress(cwd: string, tasks: LeanTaskProgress[] = [], goal?: string): { goal: string; rows: PlanOverlayRow[] } | undefined {
	const plan = planSteps(cwd);
	if (!plan?.steps.length) return undefined;
	// Without live tasks (cancel, interrupt, reload) the saved snapshot still shows which
	// steps finished and which one was cut off.
	const saved = tasks.length ? undefined : readPlanState(cwd);
	const savedMatches = saved?.goal === plan.goal;
	const rows = planRows(plan, savedMatches ? planStateTasks(plan, saved) : tasks, savedMatches ? plan.goal : goal);
	return { goal: plan.goal, rows };
}

function planStatePath(cwd: string): string {
	return join(planDir(cwd), "plan-state.json");
}

// Machine-readable progress; plan.md stays the human source of truth. The snapshot also
// survives a crash or /reload, so it is what /work resumes from.
type PlanStepState = {
	step: string;
	label: string;
	status: LeanTaskProgress["status"];
	usage?: LeanUsage;
	startedAt?: number;
	endedAt?: number;
};

const TASK_STATUSES = new Set<LeanTaskProgress["status"]>(["queued", "running", "done", "failed", "cancelled", "interrupted"]);

// A step left "running" by a dead process was interrupted, not still running.
function readPlanState(cwd: string): { goal: string; steps: PlanStepState[] } | undefined {
	const path = planStatePath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as { goal?: unknown; steps?: unknown };
		if (typeof data.goal !== "string" || !Array.isArray(data.steps)) return undefined;
		const steps = (data.steps as Partial<PlanStepState>[])
			.filter((step) => typeof step?.step === "string" && TASK_STATUSES.has(step.status as LeanTaskProgress["status"]))
			.map((step) => ({
				step: step.step!,
				label: typeof step.label === "string" ? step.label : `step ${step.step}`,
				status: step.status === "running" ? "interrupted" as const : step.status!,
				usage: step.usage,
				startedAt: step.startedAt,
				endedAt: step.endedAt,
			}));
		return steps.length ? { goal: data.goal, steps } : undefined;
	} catch {
		return undefined;
	}
}

// Synthesize chain tasks from a saved snapshot so done/interrupted rows render before any
// live task exists.
function planStateTasks(plan: { steps: PlanStep[] }, state: { steps: PlanStepState[] }): LeanTaskProgress[] {
	return plan.steps.map((step) => {
		const saved = state.steps.find((item) => item.step === step.step);
		return {
			agent: "worker" as const,
			label: saved?.label ?? taskLabel(step.body),
			task: `Implement plan step ${step.step}: ${step.body}`,
			parallel: step.parallel,
			status: saved?.status ?? "queued",
			usage: saved?.usage,
			startedAt: saved?.startedAt,
			endedAt: saved?.endedAt,
		};
	});
}

function planStateJson(plan: { goal: string; track?: string; steps: PlanStep[] }, tasks: LeanTaskProgress[], carried: PlanStepState[] = [], goal?: string): string {
	const paired = goal === undefined || goal === plan.goal;
	const steps = planRows(plan, tasks, goal).map((row) => {
		// Steps already finished by an earlier run are not re-queued for the chain, so carry
		// their last status forward instead of resetting them to queued.
		const saved = paired && !row.task ? carried.find((item) => item.step === row.step) : undefined;
		return {
			step: row.step,
			label: row.label,
			status: row.task?.status ?? saved?.status ?? "queued",
			usage: row.task?.usage ?? saved?.usage,
			startedAt: row.task?.startedAt ?? saved?.startedAt,
			endedAt: row.task?.endedAt ?? saved?.endedAt,
		};
	});
	return JSON.stringify({ track: plan.track, goal: plan.goal, steps, updatedAt: new Date().toISOString() });
}

function planOverlayComponent(rows: PlanOverlayRow[], goal: string, theme: ExtensionContext["ui"]["theme"]) {
	return {
		invalidate() {},
		render(width: number) {
			if (!rows.length) return [];
			const runningFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
			const ctxFrames = ["◜", "◝", "◞", "◟"];
			const frameIndex = Math.floor(Date.now() / 80);
			const frame = runningFrames[frameIndex % runningFrames.length]!;
			const runningCtxIcon = ctxFrames[frameIndex % ctxFrames.length]!;
			const statusOf = (row: PlanOverlayRow) => row.task?.status ?? "queued";
			const icons = rows.map((row) => {
				const status = statusOf(row);
				return status === "running" ? frame : status === "done" ? "✓" : status === "failed" || status === "cancelled" || status === "interrupted" ? "✗" : "◇";
			});
			const right = (row: PlanOverlayRow) => {
				const status = statusOf(row);
				if (status === "queued") return ` │ ${queuedText(row.task ?? row)}`;
				return statusRail(row.task, status === "running" ? runningCtxIcon : "/");
			};
			const rightWidth = Math.max(0, ...rows.map((row) => visibleWidth(right(row))));
			const titleWidth = Math.min(Math.max(...rows.map((row, i) => visibleWidth(`${icons[i]} ${row.label}`))), Math.max(0, width - rightWidth - 3));
			const done = rows.filter((row) => statusOf(row) === "done").length;
			const lines = [theme.fg("text", `${done > 0 ? "●" : "○"} Plan ${done}/${rows.length}`) + theme.fg("muted", ` · ${goal}`)];
			rows.forEach((row, i) => {
				const status = statusOf(row);
				const color = status === "running" ? "warning" : status === "done" ? "text" : status === "failed" || status === "cancelled" || status === "interrupted" ? "error" : "dim";
				const branch = i === rows.length - 1 ? "└─" : "├─";
				const label = `${icons[i]} ${truncateToWidth(row.label, titleWidth, "…", true)}`;
				lines.push(theme.fg("dim", branch) + " " + theme.fg(color, label) + theme.fg(color, right(row)));
				// Live status lives on its own branch line so rail columns never shift as text arrives.
				if (status === "running" && row.task?.latest) {
					const prefix = i === rows.length - 1 ? "   " : "│  ";
					lines.push(...liveTaskLines(row.task.latest, prefix, titleWidth).map((line) => theme.fg("warning", line)));
				}
			});
			return lines.map((line) => truncateToWidth(line, width));
		},
	};
}

// Live task text wraps inside the label column and re-emits the status rail divider, so the
// running row never cuts off at the widget edge and the right column border stays continuous.
const LIVE_LINE_CAP = 3;
function liveTaskLines(latest: string, prefix: string, labelWidth: number): string[] {
	const room = Math.max(8, labelWidth - 2);
	const all = wrapTextWithAnsi(latest.trim(), room);
	const chunks = all.slice(0, LIVE_LINE_CAP);
	if (all.length > chunks.length) chunks[chunks.length - 1] = truncateToWidth(`${chunks[chunks.length - 1]}…`, room, "…");
	return chunks.map((chunk, i) => `${prefix}${padRightVisible(`${i === 0 ? "↳ " : "  "}${chunk}`, labelWidth)} │`);
}

function planChainSignature(details: LeanChainDetails): string {
	return details.tasks.map((task) => task.status).join("|");
}

function looksExplicitlyNarrow(task: string): boolean {
	return /\b(step|item|part)\s*#?\s*\d+\b/i.test(task)
		|| /\b(only|just|first|single|one)\b/i.test(task)
		|| /\bnarrow-task-ok\b/i.test(task);
}

function leanChainComponent(d: LeanChainDetails | undefined, options: { expanded: boolean }, theme: ExtensionContext["ui"]["theme"]) {
	return {
		invalidate() {},
		render(width: number) {
			if (!d?.tasks?.length) return [];
			const age = (task: LeanTaskProgress) => taskAge(task);
			const runningFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
			const ctxFrames = ["◜", "◝", "◞", "◟"];
			const frameIndex = Math.floor(Date.now() / 80);
			const runningIcon = runningFrames[frameIndex % runningFrames.length]!;
			const runningCtxIcon = ctxFrames[frameIndex % ctxFrames.length]!;
			const titles = d.tasks.map((task, i) => {
				const status = task.status ?? d.statuses?.[i] ?? "queued";
				const icon = status === "running" ? runningIcon : status === "done" ? "✓" : status === "failed" || status === "cancelled" || status === "interrupted" ? "✖" : "◇";
				return `${icon} ${task.label}`;
			});
			const activeRightWidth = Math.max(0, ...d.tasks.map((task, i) => {
				const status = task.status ?? d.statuses?.[i] ?? "queued";
				return status === "queued"
					? visibleWidth(queuedRail(task))
					: visibleWidth(statusRail(task, status === "running" ? runningCtxIcon : "/"));
			}));
			// `├─ ` prefix costs 3 columns in the shared label column.
			const titleWidth = Math.min(Math.max(...titles.map(visibleWidth)), Math.max(0, width - activeRightWidth - 3));
			const done = d.tasks.filter((task, i) => (task.status ?? d.statuses?.[i] ?? "queued") === "done").length;
			const lines: string[] = d.goal
				? [theme.fg("text", `${done > 0 ? "●" : "○"} Plan ${done}/${d.tasks.length}`) + theme.fg("muted", ` · ${d.goal}`)]
				: [];
			d.tasks.forEach((task, i) => {
				const status = task.status ?? d.statuses?.[i] ?? "queued";
				const color = status === "running" ? "warning" : status === "done" ? "text" : status === "failed" || status === "cancelled" || status === "interrupted" ? "error" : "dim";
				const left = truncateToWidth(titles[i]!, titleWidth, "…", true);
				const last = i === d.tasks.length - 1;
				const prefix = theme.fg("dim", last ? "└─ " : "├─ ");
				if (status === "queued") {
					lines.push(prefix + theme.fg("dim", left + queuedRail(task)));
					return;
				}
				lines.push(prefix + theme.fg(color, left) + theme.fg(color, statusRail(task, status === "running" ? runningCtxIcon : "/")));
				// Live task output, on its own branch line so rail columns never shift.
				if (status === "running" && task.latest) lines.push(...liveTaskLines(task.latest, last ? "   " : "│  ", titleWidth).map((line) => theme.fg("warning", line)));
			});
			if (d.note) lines.push(theme.fg("muted", d.note));
			if (options.expanded) {
				const task = d.tasks[d.current];
				lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 80))));
				if (task) {
					const meta = [formatUsage(task.usage), task.startedAt ? age(task) : undefined, task.thinking].filter(Boolean).join(" • ");
					lines.push(theme.fg("accent", `${task.label}${meta ? ` (${meta})` : ""}`));
				}
				const output = task?.output ?? d.currentOutput;
				lines.push(theme.fg("muted", "Feed:"));
				if (output) lines.push(...output.split(/\r?\n/).slice(-16).map((line) => `  ${line}`));
				else lines.push(theme.fg("dim", "  waiting for child event stream..."));
				lines.push(theme.fg("dim", "Esc/Ctrl+C cancels."));
			}
			return lines.map((line) => truncateToWidth(line, width));
		},
	};
}

function runsRoot(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "lean-flow", "runs");
}

// Run IDs start with a UTC timestamp, so name order is start-time order even when a long
// run finishes after a newer one. Branch is encoded after the timestamp for /runs.
type LeanRunInfo = { id: string; path: string; ageMs: number; branch: string; tasks: number; bytes: number };

function listRuns(cwd: string): LeanRunInfo[] {
	const root = runsRoot(cwd);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const path = join(root, entry.name);
			const files = readdirSync(path, { withFileTypes: true }).filter((file) => file.isFile());
			const bytes = files.reduce((sum, file) => sum + statSync(join(path, file.name)).size, 0);
			const separator = entry.name.indexOf("-");
			return {
				id: entry.name,
				path,
				ageMs: Date.now() - statSync(path).mtimeMs,
				branch: separator < 0 ? "unknown" : entry.name.slice(separator + 1),
				tasks: files.filter((file) => file.name.endsWith(".md")).length,
				bytes,
			};
		})
		.sort((a, b) => b.id.localeCompare(a.id));
}

async function pruneRuns(cwd: string, keep = 3): Promise<number> {
	const runs = listRuns(cwd);
	const staleIds = new Set(staleRunIds(runs.map((run) => run.id), keep));
	const stale = runs.filter((run) => staleIds.has(run.id));
	await Promise.all(stale.map((run) => rm(run.path, { recursive: true, force: true })));
	return stale.length;
}

function formatRunAge(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function formatRunBytes(bytes: number): string {
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
	return bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`;
}

// Only generated run IDs (timestamp, optional slugified branch), never a path traversal.
function summarizedRunDirs(cwd: string, text: string): string[] {
	const ids = [...text.matchAll(/lean-flow[\\/]runs[\\/]([0-9]{8}T[0-9]{6}(?:-[a-z0-9_-]+)?)/g)].map((match) => match[1]!);
	return [...new Set(ids)].map((id) => join(runsRoot(cwd), id));
}

function gitBranch(cwd: string): string {
	if (!inRepo(cwd)) return "unknown";
	try {
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
	} catch {
		return "unknown";
	}
}

function tasksFromPlan(cwd: string, args: string, resumeFrom?: string, skipSteps: string[] = []): LeanTask[] {
	const path = planPath(cwd);
	return tasksFromPlanText(existsSync(path) ? readFileSync(path, "utf8") : undefined, args, resumeFrom, skipSteps);
}

// Bare /work continues an unfinished plan at its first non-done step; explicit start/only
// text still wins. The saved snapshot is per-branch and only used when the goal matches.
function resumeState(cwd: string, guidance: string): { from?: string; steps: PlanStepState[] } | undefined {
	if (/\b(?:start|resume|continue)\s+(?:from|at)\b|\b(?:only|just)\s+(?:step|item|part)\b/i.test(guidance)) return undefined;
	const plan = planSteps(cwd);
	const saved = readPlanState(cwd);
	if (!plan || !saved || saved.goal !== plan.goal) return undefined;
	const pending = plan.steps.find((step) => saved.steps.find((item) => item.step === step.step)?.status !== "done");
	return { from: pending?.step, steps: saved.steps };
}

function initialDetails(tasks: LeanTask[]): LeanChainDetails {
	const progress: LeanTaskProgress[] = tasks.map((task) => ({ ...task, status: "queued", latest: "queued" }));
	return { tasks: progress, current: 0, statuses: progress.map((task) => task.status), currentTask: progress[0]?.task };
}

function boundedDetails(details: LeanChainDetails): LeanChainDetails {
	const tasks = details.tasks.map((task) => ({ ...task, output: task.output?.slice(-PER_TASK_OUTPUT_CAP) }));
	return { ...details, tasks, statuses: tasks.map((task) => task.status), currentOutput: details.currentOutput?.slice(-PER_TASK_OUTPUT_CAP) };
}

const PLAN_STATE_ENTRY = "lean-plan-state";

type PlanChainSnapshot = {
	goal: string;
	tasks: Pick<LeanTaskProgress, "agent" | "label" | "task" | "status" | "latest" | "parallel" | "usage" | "startedAt" | "endedAt">[];
	current?: number;
};

function planChainSnapshot(details: LeanChainDetails, goal: string): PlanChainSnapshot {
	return {
		goal,
		tasks: details.tasks.map(({ agent, label, task, status, latest, parallel, usage, startedAt, endedAt }) => ({ agent, label, task, status, latest, parallel, usage, startedAt, endedAt })),
		current: details.current,
	};
}

function replayPlanChain(branch: SessionEntry[], goal: string): LeanChainDetails | undefined {
	const statuses = new Set<LeanTaskProgress["status"]>(["queued", "running", "done", "failed", "cancelled", "interrupted"]);
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY) continue;
		const data = entry.data as PlanChainSnapshot | undefined;
		if (data?.goal !== goal || !Array.isArray(data.tasks)) continue;
		if (!data.tasks.every((task) => statuses.has(task.status) && typeof task.label === "string" && typeof task.task === "string" && typeof task.agent === "string")) return undefined;
		const tasks = data.tasks.map((task) => ({ ...task, status: task.status === "running" ? "interrupted" as const : task.status })) as LeanTaskProgress[];
		return { tasks, current: data.current ?? 0, statuses: tasks.map((task) => task.status) };
	}
	return undefined;
}

function markPendingWorkCancelled(job: ActiveWorkJob): void {
	for (const task of job.progress) {
		if (task.status !== "queued" && task.status !== "running") continue;
		task.status = "cancelled";
		task.latest = "cancelled";
		task.output ||= "Cancelled.";
		task.endedAt ||= Date.now();
	}
	job.details.statuses = job.progress.map((task) => task.status);
}

function latestWorkLine(tasks: LeanTaskProgress[]): string | undefined {
	return tasks.find((task) => task.status === "running")?.latest
		?? [...tasks].reverse().find((task) => task.latest)?.latest;
}

function taskCounts(tasks: LeanTaskProgress[]): Record<LeanTaskProgress["status"], number> {
	return tasks.reduce<Record<LeanTaskProgress["status"], number>>((acc, task) => {
		acc[task.status]++;
		return acc;
	}, { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, interrupted: 0 });
}

// Compact chain result: one line per task (number, label, agent, status, latest, output path),
// then the first 400 chars of each failed task so the parent can triage without reading every file.
function chainIndex(tasks: LeanTaskProgress[], files: string[]): string {
	const lines = tasks.map((task, i) => `${i + 1}. ${task.label} [${task.agent}] ${task.status} - ${task.latest ?? ""}\n   ${files[i]}`);
	for (const [i, task] of tasks.entries()) {
		if (task.status === "failed") lines.push(`\n${i + 1}. ${task.label} failed:\n${(task.output ?? "").slice(0, 400)}`);
	}
	return lines.join("\n");
}

function chainSummary(status: "complete" | "cancelled" | "failed" | "paused", tasks: LeanTaskProgress[], reason?: string): string {
	const counts = taskCounts(tasks);
	const failed = tasks.filter((task) => task.status === "failed").map((task) => task.label).slice(0, 2).join(", ");
	const suffix = reason ? `: ${reason.split(/\r?\n/)[0]?.slice(0, 160)}` : failed ? `: ${failed}` : "";
	const interrupted = counts.interrupted ? `, ${counts.interrupted} interrupted` : "";
	return `${status}: ${counts.done} done, ${counts.failed} failed, ${counts.cancelled} cancelled${interrupted}, ${counts.running + counts.queued} pending${suffix}`;
}

// On-demand /work-status snapshot: distinguishes running vs queued (chainSummary lumps them
// as "pending" since that distinction stops mattering once a chain is finished).
function activeSummary(activeWorkJob: ActiveWorkJob): string {
	const elapsed = compactDuration(Date.now() - activeWorkJob.startedAt);
	const counts = taskCounts(activeWorkJob.progress);
	const latest = latestWorkLine(activeWorkJob.progress);
	return `active ${elapsed}: ${counts.done} done, ${counts.running} running, ${counts.queued} queued, ${counts.failed} failed${latest ? ` — ${latest}` : ""}`;
}

function sendWorkSummary(pi: ExtensionAPI, status: "complete" | "cancelled" | "failed" | "paused", summary: string, details: LeanChainDetails): void {
	const nextStep = status === "complete"
		? "Review the completed chain outputs and recommend the concise next steps. Do not start more work or treat human validation as a chain task."
		: status === "paused"
			? "The chain is paused with remaining steps queued. Wait for the human to resume with /work start from the reported step; do not start more work."
			: "Review the chain outcome and recommend the concise next steps.";
	pi.sendMessage({
		customType: "lean-work-summary",
		content: `${summary}\n\n${nextStep}`,
		display: true,
		details: { status, chain: boundedDetails(details) },
	}, { deliverAs: "followUp" });
}

function sendWorkStatus(pi: ExtensionAPI, summary: string, details: LeanChainDetails): void {
	pi.sendMessage({ customType: "lean-work-status", content: summary, display: true, details: { chain: boundedDetails(details) } }, { deliverAs: "followUp" });
}

const REVIEW_LABEL = "Final review";
const REVIEW_ROUND_CAP = 3;
const REVIEW_TASK = `Review the final worker batch against the original goal and the actual diff. Do not edit files. Report only evidence-backed findings. End with exactly one final line, either \`REVIEW: clean\` or \`REVIEW: blocking\`; put nothing after it.`;

function resolvedToolPath(cwd: string, path: string): string {
	return resolve(cwd, path.startsWith("@") ? path.slice(1) : path);
}

function trackList(tracks: ReturnType<typeof parseTracks>): string[] {
	return tracks.map((track) => `${track.name}: ${track.issues.filter((issue) => issue.status !== "completed").length} open / ${track.issues.length}`);
}

let issueWrite = Promise.resolve();
// Serialized because parallel workers share one tracks.md read-modify-write.
async function writeIssueStatus(cwd: string, task: LeanTask, status: "started" | "completed"): Promise<void> {
	if (!task.track || !task.issue) return;
	const path = join(cwd, CONFIG_DIR_NAME, "tracks.md");
	issueWrite = issueWrite
		.then(async () => {
			if (!existsSync(path)) return;
			const text = readFileSync(path, "utf8");
			const next = setIssueStatus(text, task.track!, task.issue!, status);
			if (next !== text) await writeFile(path, next, "utf8");
		})
		.catch(() => {});
	await issueWrite;
}

// Shared by /grill and /plan: `track <name>` loads that committed track's issues and details.
function trackScope(cwd: string, name: string): { name: string; issues: string } | undefined {
	const path = join(cwd, CONFIG_DIR_NAME, "tracks.md");
	const track = parseTracks(existsSync(path) ? readFileSync(path, "utf8") : "").find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
	if (!track) return undefined;
	const marker = (status: string) => (status === "completed" ? "x" : status === "started" ? "-" : " ");
	const issues = track.issues.map((issue) => `- [${marker(issue.status)}] ${issue.text}${issue.detail ? `\n  ${issue.detail.replace(/\n/g, "\n  ")}` : ""}`).join("\n");
	return { name: track.name, issues: issues || "No issues." };
}

function unknownTrack(ctx: ExtensionContext, name: string): void {
	const path = join(ctx.cwd, CONFIG_DIR_NAME, "tracks.md");
	const lines = trackList(parseTracks(existsSync(path) ? readFileSync(path, "utf8") : ""));
	ctx.ui.notify(`Unknown track: ${name}\n${lines.join("\n") || `No tracks in ${path}`}`, "warning");
}

export default function leanFlow(pi: ExtensionAPI) {
	let activeWorkJob: ActiveWorkJob | undefined;
	// Set by /work-reload; the batch loop consumes it at the next task boundary.
	let pendingWorkReload: string | undefined;
	// Steps added by /work-add; the batch loop moves them ahead of the queued tail.
	const pendingWorkAdditions: string[] = [];
	let lastWorkJob: LastWorkJob | undefined;
	let planChainGoal: string | undefined;
	let planChainState = "";
	// Statuses from the saved snapshot for steps the live chain does not re-run (already done).
	let planStateCarry: PlanStepState[] = [];
	// Emits fire every 80ms; concurrent writers to the same .tmp path corrupted the snapshot,
	// so writes are serialized through one promise chain.
	let planStateWrite = Promise.resolve();
	const renderPlanOverlay = (ctx: ExtensionContext, tasks: LeanTaskProgress[] = [], goal?: string) => {
		// The live chain widget owns the slot while /work runs; one widget at a time.
		if (activeWorkJob) return;
		const progress = planStepProgress(ctx.cwd, tasks, goal);
		if (!progress) {
			ctx.ui.setWidget("lean-plan", undefined);
			return;
		}
		ctx.ui.setWidget("lean-plan", (_tui, theme) => planOverlayComponent(progress.rows, progress.goal, theme), { placement: "aboveEditor" });
	};
	const syncPlanState = (ctx: ExtensionContext, details: LeanChainDetails) => {
		// Check the cheap signature first: emit() runs every 80ms and planSteps shells out to git.
		const signature = planChainSignature(details);
		if (planChainGoal && planChainState === signature) return;
		const plan = planSteps(ctx.cwd);
		const statePath = planStatePath(ctx.cwd);
		// The snapshot outlives the chain (including a finished one) so /work can resume and
		// /work-add can extend; only a deleted/emptied plan clears it.
		if (!plan?.steps.length) {
			planChainGoal = undefined;
			planChainState = "";
			renderPlanOverlay(ctx, details.tasks, details.goal);
			return;
		}
		if (planChainGoal === plan.goal && planChainState === signature) return;
		// A plan replaced mid-run has a different goal: leave the running chain's snapshot alone
		// and let the next /work adopt the new plan.
		if (activeWorkJob && planChainGoal !== undefined && plan.goal !== planChainGoal) {
			planChainState = signature;
			return;
		}
		planChainGoal = plan.goal;
		planChainState = signature;
		pi.appendEntry(PLAN_STATE_ENTRY, planChainSnapshot(details, details.goal ?? plan.goal));
		// Atomic replace so a host reading the file never sees a partial snapshot.
		planStateWrite = planStateWrite
			.then(() => writeFile(`${statePath}.tmp`, planStateJson(plan, details.tasks, planStateCarry, details.goal), "utf8"))
			.then(() => rename(`${statePath}.tmp`, statePath))
			.catch(() => {});
		renderPlanOverlay(ctx, details.tasks, details.goal);
	};
	const ownedPaths = new Map<string, Set<LeanTaskProgress>>();
	const ownPath = (task: LeanTaskProgress, cwd: string, path: string) => {
		const resolved = resolvedToolPath(cwd, path);
		const owners = ownedPaths.get(resolved) ?? new Set<LeanTaskProgress>();
		owners.add(task);
		ownedPaths.set(resolved, owners);
	};
	const releaseTaskPaths = (task: LeanTaskProgress) => {
		for (const [path, owners] of ownedPaths) {
			owners.delete(task);
			if (owners.size === 0) ownedPaths.delete(path);
		}
	};
	pi.registerMessageRenderer("lean-work-summary", (message, options, theme) => {
		const details = message.details as { status?: string; chain?: LeanChainDetails } | undefined;
		const header = theme.fg(details?.status === "cancelled" || details?.status === "failed" ? "error" : "toolTitle", String(message.content));
		const chain = leanChainComponent(details?.chain, options, theme);
		return new Text([header, ...chain.render(100)].join("\n"), options.outputPad, 0);
	});
	pi.registerMessageRenderer("lean-work-status", (message, options, theme) => {
		const details = message.details as { chain?: LeanChainDetails } | undefined;
		const header = theme.fg("toolTitle", String(message.content));
		const chain = leanChainComponent(details?.chain, { expanded: true }, theme);
		return new Text([header, ...chain.render(100)].join("\n"), options.outputPad, 0);
	});
	const renderActiveWork = (ctx: ExtensionContext) => ctx.ui.setWidget("lean-work", (_tui, theme) => leanChainComponent(activeWorkJob?.details, { expanded: false }, theme), { placement: "aboveEditor" });
	// ponytail: in-memory per-branch cap; persist if reloads must keep counting a gate.
	const reviewRounds = new Map<string, number>();
	const closeReviewLoop = (ctx: ExtensionContext, progress: LeanTaskProgress[], key: string) => {
		const review = progress.at(-1);
		if (review?.agent !== "reviewer" || review.status !== "done") return;
		const findings = (review.output ?? "").trim().slice(-4000);
		const verdict = reviewVerdict(findings);
		if (verdict === "clean") {
			reviewRounds.delete(key);
			return;
		}
		if (!verdict) {
			ctx.ui.notify(`Reviewer output missing a final \`REVIEW: clean|blocking\` verdict. Tail: ${findings.slice(-300)}`, "error");
			send(pi, `The reviewer finished but its output has no parseable final verdict (expected \`REVIEW: clean\` or \`REVIEW: blocking\`). Read the reviewer output below and decide whether to finish, re-plan, or re-run \`/work\`. Reviewer output:\n\n${findings}`);
			return;
		}
		const rounds = (reviewRounds.get(key) ?? 0) + 1;
		reviewRounds.set(key, rounds);
		if (rounds < REVIEW_ROUND_CAP) {
			send(pi, `Blocking review (round ${rounds}/${REVIEW_ROUND_CAP}). Re-plan against these findings, then re-run \`/work\`. Do not finish until a review ends with \`REVIEW: clean\`. Findings:\n\n${findings}`);
			return;
		}
		send(pi, `Review round cap (${REVIEW_ROUND_CAP}) reached with blocking findings. Stop the review loop and surface these findings to the human; do not auto-run \`/work\` again. Findings:\n\n${findings}`);
	};

	const runLeanChain = async (ctx: ExtensionContext, inputTasks: LeanTask[], signal?: AbortSignal, publish?: (update: LeanChainUpdate) => void, options: { checkLabelWords?: boolean; reloadPlan?: boolean; completed?: PlanStepState[] } = {}): Promise<LeanChainResult> => {
		if (inputTasks.length === 0) return { content: [{ type: "text" as const, text: "No lean subagent tasks." }] };
		const workerTasks = inputTasks.filter((task) => task.agent === "worker");
		// Captured up front: after /reload every ctx property throws, but the aborting chain still
		// needs plain paths and the model window to finish cleanly.
		const cwd = ctx.cwd;
		const contextWindow = ctx.model?.contextWindow;
		const detached = () => activeWorkJob?.detached === true;
		const planSteps = leanPlanStepCount(cwd);
		if (workerTasks.length === 1 && planSteps > 1 && !looksExplicitlyNarrow(workerTasks[0]!.task)) {
			return {
				content: [{ type: "text" as const, text: `Plan has ${planSteps} numbered implementation steps, but only one broad worker task was submitted. Split the work into atomic worker tasks, normally at least one per plan step. If this is intentionally narrow, mention the exact step or include narrow-task-ok.` }],
				isError: true,
				details: { planSteps, workerTasks: workerTasks.length },
			};
		}
		// checkLabelWords keeps the LLM-authored tool path terse (it can reason about a good
		// 3-word label); /work's mechanically-sliced plan labels get more words instead, since a
		// dumb slice at 3 words often drops the one word that made the label comprehensible.
		if (options.checkLabelWords !== false) {
			for (const task of inputTasks) {
				const words = task.label.trim().split(/\s+/).filter(Boolean);
				if (words.length > 3) {
					return { content: [{ type: "text" as const, text: `Task label too long: "${task.label}". Use 3 words or fewer.` }], isError: true };
				}
			}
		}
		let current = 0;
		// Steps an earlier run already finished stay in the chain as done rows with their frozen
		// timestamps, so a resumed /work still shows what is complete; the loop skips them.
		const progress: LeanTaskProgress[] = inputTasks.map((task) => {
			const step = task.task.match(/\bplan step (\d+)\s*:/i)?.[1];
			const saved = step ? options.completed?.find((item) => item.step === step) : undefined;
			if (saved?.status !== "done") return { ...task, status: "queued", latest: "queued" };
			return { ...task, status: "done", latest: "done", output: "Already completed before this run.", usage: saved.usage, startedAt: saved.startedAt, endedAt: saved.endedAt };
		});
		const branch = gitBranch(cwd);
		const runId = makeRunId(branch);
		const taskFiles = progress.map((task, i) => join(CONFIG_DIR_NAME, "lean-flow", "runs", runId, taskFileName(i, branch, task.label)));
		const reloadPlan = options.reloadPlan === true;
		let paused = false;
		const planStepOf = (task: Pick<LeanTask, "task">) => task.task.match(/\bplan step (\d+)\s*:/i)?.[1];
		const stepNumbers = (tasks: LeanTask[]) => tasks.map(planStepOf).filter((step): step is string => Boolean(step));
		const stepMap = (text: string | undefined) => new Map((text ? planStepsFromText(text).steps : []).map((step) => [step.step, `${step.body}\0${step.parallel ? "parallel" : ""}`]));
		let planBaseline = reloadPlan ? readPlan(cwd) : undefined;
		const planBaselineGoal = planBaseline === undefined ? undefined : planStepsFromText(planBaseline).goal;
		let goalNoticeShown = false;
		const initialPlanSteps = stepMap(planBaseline);
		const initialRunSteps = new Set(stepNumbers(progress));
		let planNote: string | undefined;
		// Scheduling ownership lasts through the chain: a newly added step must queue behind
		// the row that just wrote the same file, while the parent write guard below only
		// blocks paths of tasks that are still running.
		const ownerOf = (task: LeanTaskProgress) => {
			let owner: LeanTaskProgress | undefined;
			let index = -1;
			for (const path of pathRefs(task.task)) {
				for (const candidate of ownedPaths.get(resolvedToolPath(cwd, path)) ?? []) {
					if (candidate === task) continue;
					const candidateIndex = progress.indexOf(candidate);
					if (candidateIndex > index) {
						owner = candidate;
						index = candidateIndex;
					}
				}
			}
			return owner ? { owner, index } : undefined;
		};
		const heldNote = (task: LeanTaskProgress, owner: LeanTaskProgress, ownerIndex: number) => {
			const step = planStepOf(owner.task) ?? String(ownerIndex + 1);
			const note = `held "${task.label}" until step ${step} finishes`;
			if (!planNote?.includes(note)) planNote = planNote ? `${planNote} · ${note}` : note;
		};
		const details = (): LeanChainDetails => {
			if (detached()) return { tasks: progress, current, statuses: progress.map((task) => task.status) };
			const usage = ctx.getContextUsage();
			const usageText = usage?.tokens ? `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} (${usage.percent?.toFixed(0) ?? "?"}%)` : undefined;
			const thinking = pi.getThinkingLevel();
			if (progress[current]) {
				progress[current].thinking = thinking;
			}
			return {
				tasks: progress,
				current,
				statuses: progress.map((task) => task.status),
				usage: usageText,
				thinking,
				currentTask: progress[current]?.task,
				currentOutput: progress[current]?.output?.slice(-2000),
				note: planNote,
				goal: planChainGoal,
			};
		};
		const plainSummary = () => {
			const titleWidth = Math.max(...progress.map((task) => visibleWidth(`◦ ${task.label}`)));
			return progress.map((task) => {
				const icon = task.status === "running" ? "⠋" : task.status === "done" ? "✓" : task.status === "failed" || task.status === "cancelled" || task.status === "interrupted" ? "✗" : "◦";
				const title = `${icon} ${task.label}`;
				const left = truncateToWidth(title, titleWidth, "…", true);
				if (task.status === "queued") return `${left}${queuedRail(task)}`;
				return `${left}${statusRail(task)}`;
			}).join("\n");
		};
		const emit = () => {
			// The abort triggered by a reload/shutdown unwinds through emit; keep the dead instance
			// off pi and ctx while the on-disk snapshot carries the resume point.
			if (detached()) return;
			const snapshot = details();
			// Single fan-out point: host integrations (herdr) follow chain progress without
			// owning lifecycle state; tool chains and background /work both land here.
			pi.events.emit("lean:chain", { kind: activeWorkJob ? "work" : "chain", details: snapshot });
			publish?.({ content: [{ type: "text", text: plainSummary() }], details: snapshot });
			syncPlanState(ctx, snapshot);
		};
		emit();
		const reloadQueuedTail = (ran: number): string | undefined => {
			if (!reloadPlan) return undefined;
			const text = readPlan(cwd);
			if (text === undefined || text === planBaseline) return undefined;
			const previous = stepMap(planBaseline);
			const nextPlan = planStepsFromText(text);
			// A different goal is a new plan, not an edit: keep the running chain on its starting
			// plan and let the next /work pick the new one up instead of merging step numbers.
			if (planBaselineGoal !== undefined && nextPlan.goal !== planBaselineGoal) {
				if (!goalNoticeShown) {
					goalNoticeShown = true;
					if (!detached()) ctx.ui.notify("plan.md has a new goal; the new plan waits for the next /work run", "info");
				}
				return undefined;
			}
			const next = new Map(nextPlan.steps.map((step) => [step.step, `${step.body}\0${step.parallel ? "parallel" : ""}`]));
			planBaseline = text;
			const byNumber = (a: string, b: string) => Number(a) - Number(b);
			const added = [...next.keys()].filter((step) => !previous.has(step)).sort(byNumber);
			const removed = [...previous.keys()].filter((step) => !next.has(step)).sort(byNumber);
			const renamed = [...next.keys()].filter((step) => previous.has(step) && previous.get(step) !== next.get(step)).sort(byNumber);
			if (!added.length && !removed.length && !renamed.length) return undefined;
			const kept = progress.slice(0, ran);
			const keptSteps = new Set(stepNumbers(kept));
			// Reviewers are appended by /work, not plan steps, so they survive a reload.
			const extras = progress.slice(ran).filter((task) => task.agent !== "worker");
			const nextTasks = tasksFromPlanText(text, "");
			const tail = nextPlan.steps.length
				? nextTasks.filter((task) => {
					const step = planStepOf(task);
					if (!step || keptSteps.has(step)) return false;
					return initialRunSteps.size === 0 || initialRunSteps.has(step) || !initialPlanSteps.has(step);
				})
				: nextTasks;
			const tailProgress: LeanTaskProgress[] = tail.map((task) => {
				// A step finished before this plan edit keeps its done row instead of re-queueing.
				const previous = progress.find((row) => planStepOf(row) === planStepOf(task));
				return previous?.status === "done" ? previous : { ...task, status: "queued", latest: "queued" };
			});
			const rebuilt = [...kept, ...tailProgress, ...extras];
			progress.splice(0, progress.length, ...rebuilt);
			const labels = new Map(nextPlan.steps.map((step) => [step.step, taskLabel(step.body)]));
			planNote = `reloaded plan: ${[
				...added.map((step) => `+${step} "${labels.get(step)}"`),
				...renamed.map((step) => `~${step} "${labels.get(step)}"`),
				...removed.map((step) => `-${step}`),
			].join(", ")}`;
			const addedSet = new Set(added);
			const placed = new Set<LeanTaskProgress>();
			for (const task of progress.slice(ran)) {
				const step = planStepOf(task);
				if (!step || !addedSet.has(step)) continue;
				const held = ownerOf(task);
				if (!held) continue;
				const current = progress.indexOf(task);
				let at = held.index + 1;
				while (at < progress.length && (progress[at]!.parallel || placed.has(progress[at]!))) at++;
				at = Math.max(ran, at);
				if (current < at) {
					progress.splice(current, 1);
					const ownerIndex = progress.indexOf(held.owner);
					let insert = ownerIndex + 1;
					while (insert < progress.length && (progress[insert]!.parallel || placed.has(progress[insert]!))) insert++;
					insert = Math.max(ran, insert);
					progress.splice(insert, 0, task);
				}
				// Serial barrier: a held step never shares a batch with the owner's file.
				task.parallel = undefined;
				placed.add(task);
				heldNote(task, held.owner, progress.indexOf(held.owner));
			}
			taskFiles.splice(0, taskFiles.length, ...taskFiles.slice(0, ran), ...progress.slice(ran).map((task, offset) => join(CONFIG_DIR_NAME, "lean-flow", "runs", runId, taskFileName(ran + offset, branch, task.label))));
			emit();
			return planNote;
		};
		const applyPendingAdditions = (ran: number) => {
			if (!pendingWorkAdditions.length) return;
			const wanted = new Set(pendingWorkAdditions);
			pendingWorkAdditions.length = 0;
			const moved = progress.slice(ran).filter((task) => {
				const step = planStepOf(task);
				return Boolean(step && wanted.has(step) && task.status === "queued");
			});
			if (!moved.length) return;
			const moving = new Set(moved);
			const rest = progress.slice(ran).filter((task) => !moving.has(task));
			progress.splice(ran, progress.length - ran, ...rest);
			const placed = new Set<LeanTaskProgress>();
			for (const task of moved) {
				const held = ownerOf(task);
				let at = ran;
				if (held) {
					at = held.index + 1;
					while (at < progress.length && (progress[at]!.parallel || placed.has(progress[at]!))) at++;
					at = Math.max(ran, at);
					// Serial barrier: a held step never shares a batch with the owner's file.
					task.parallel = undefined;
					heldNote(task, held.owner, held.index);
				}
				progress.splice(at, 0, task);
				placed.add(task);
			}
			taskFiles.splice(ran, taskFiles.length - ran, ...progress.slice(ran).map((task, offset) => join(CONFIG_DIR_NAME, "lean-flow", "runs", runId, taskFileName(ran + offset, branch, task.label))));
			emit();
		};
		const runTask = async (i: number): Promise<{ index: number; code: number | null; output: string; cancelled?: boolean }> => {
			const task = progress[i]!;
			if (signal?.aborted) {
				task.status = "cancelled";
				task.latest = "cancelled";
				task.output = "Cancelled before start.";
				task.endedAt = Date.now();
				emit();
				return { index: i, code: null, output: task.output, cancelled: true };
			}
			current = i;
			task.status = "running";
			task.latest = "starting";
			task.phase = "starting";
			task.startedAt = Date.now();
			task.updatedAt = task.startedAt;
			task.output = "";
			emit();
			await writeIssueStatus(cwd, task, "started");
			const result = await runPiChild(ctx, task, contextWindow, signal, (childProgress) => {
				if (signal?.aborted) return;
				current = i;
				Object.assign(task, childProgress);
				task.updatedAt = Date.now();
				task.output = task.output?.slice(-4000);
				task.latest = task.latest?.slice(0, 160) || "working";
				emit();
			}, (path) => ownPath(task, cwd, path)).catch((error) => ({
				code: 1,
				output: error instanceof Error ? error.message : String(error),
				cancelled: false,
			}));
			task.status = result.cancelled || signal?.aborted ? "cancelled" : result.code === 0 ? "done" : "failed";
			task.endedAt = Date.now();
			task.updatedAt = task.endedAt;
			task.output = result.output.slice(-4000);
			task.latest = task.status === "done" ? "done" : task.status === "cancelled" ? "cancelled" : `failed: exit ${result.code}`;
			emit();
			if (task.status === "done") await writeIssueStatus(cwd, task, "completed");
			return { index: i, code: result.code, output: result.output, cancelled: task.status === "cancelled" };
		};
		// No condition: after the last batch i equals progress.length, but that boundary still
		// has to consume /work-add steps before the loop can stop.
		for (let i = 0; ;) {
			// Rows completed by an earlier run stay visible as done but are never re-run.
			while (i < progress.length && progress[i]!.status === "done") i++;
			const reloadDiff = reloadQueuedTail(i);
			applyPendingAdditions(i);
			if (activeWorkJob?.progress === progress && pendingWorkReload !== undefined) {
				const note = pendingWorkReload;
				pendingWorkReload = undefined;
				if (!detached()) ctx.ui.notify(`${reloadDiff ?? "reloaded plan: no changes"}${note ? ` (${note})` : ""}`, "info");
			}
			if (i >= progress.length) break;
			if (signal?.aborted) {
				for (let j = i; j < progress.length; j++) {
					progress[j]!.status = "cancelled";
					progress[j]!.latest = "cancelled";
					progress[j]!.output ||= "Cancelled before start.";
					progress[j]!.endedAt ||= Date.now();
				}
				emit();
				break;
			}
			// Pause at a batch boundary: the current batch already finished, so unfinished
			// rows stay queued for `/work start from step N` instead of being cancelled.
			if (activeWorkJob?.progress === progress && activeWorkJob.pauseRequested) {
				paused = true;
				emit();
				break;
			}
			const batch: number[] = [i];
			if (progress[i]!.parallel) {
				while (i + batch.length < progress.length && progress[i + batch.length]!.parallel && progress[i + batch.length]!.status !== "done") batch.push(i + batch.length);
			}
			current = batch[0]!;
			const tick = setInterval(emit, 80);
			const stopTick = () => clearInterval(tick);
			signal?.addEventListener("abort", stopTick, { once: true });
			const results = await Promise.all(batch.map((index) => runTask(index))).finally(() => {
				clearInterval(tick);
				signal?.removeEventListener("abort", stopTick);
			});
			results.sort((a, b) => a.index - b.index);
			if (results.some((result) => result.cancelled)) {
				for (let j = i + batch.length; j < progress.length; j++) {
					progress[j]!.status = "cancelled";
					progress[j]!.latest = "cancelled";
					progress[j]!.output ||= "Cancelled before start.";
					progress[j]!.endedAt ||= Date.now();
				}
				emit();
				break;
			}
			if (results.some((result) => result.code !== 0)) break;
			i += batch.length;
		}
		// Ownership only has to outlive the chain: release it after the last boundary so a
		// later chain or /work-add does not inherit stale file locks.
		for (const task of progress) releaseTaskPaths(task);
		const cancelled = progress.some((task) => task.status === "cancelled");
		if (!detached()) pi.events.emit("lean:chain-end", { cancelled });
		await mkdir(join(cwd, CONFIG_DIR_NAME, "lean-flow", "runs", runId), { recursive: true });
		await Promise.all(progress.map((task, i) => writeFile(join(cwd, taskFiles[i]!), task.output ?? "")));
		await pruneRuns(cwd);
		return { content: [{ type: "text" as const, text: chainIndex(progress, taskFiles) }], details: details(), isError: cancelled || undefined, paused: paused || undefined };
	};

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("lean-flow", ctx.ui.theme.fg("accent", "lean · ponytail"));
		const plan = planSteps(ctx.cwd);
		const saved = plan ? readPlanState(ctx.cwd) : undefined;
		const carried = plan && saved?.goal === plan.goal ? saved : undefined;
		const restored = plan && !carried ? replayPlanChain(ctx.sessionManager.getBranch(), plan.goal) : undefined;
		planChainGoal = plan?.goal;
		planStateCarry = carried?.steps ?? [];
		const tasks = carried && plan ? planStateTasks(plan, carried) : restored?.tasks;
		planChainState = tasks ? planChainSignature({ tasks, current: 0, statuses: tasks.map((task) => task.status) }) : "";
		renderPlanOverlay(ctx, tasks, plan?.goal);
	});

	// /reload, /new, /fork and quit replace or tear down this extension instance, which makes
	// every captured pi/ctx call throw. Abort the chain and detach it: the in-flight step stays
	// "running" in plan-state.json, so the next instance shows it interrupted and /work resumes
	// from that step with the completed rows still marked done.
	pi.on("session_shutdown", () => {
		const job = activeWorkJob;
		if (!job) return;
		job.detached = true;
		job.controller.abort();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const warning = usage?.percent !== null && usage?.percent !== undefined && usage.percent >= 50
			? `\n\n[LEAN FLOW CONTEXT WARNING] Context is about ${usage.percent.toFixed(0)}%. Generate a /handover and stop unless the user explicitly wants to continue.`
			: "";
		return { systemPrompt: `${ctx.getSystemPrompt()}\n\n${leanSystem()}${warning}` };
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const path = (event.input as { path?: unknown }).path;
		if (typeof path !== "string") return;
		const owners = [...(ownedPaths.get(resolvedToolPath(ctx.cwd, path)) ?? [])].filter((task) => task.status === "running");
		if (!owners.length) return;
		const labels = owners.map((task) => task.label).join(", ");
		const reason = `Path conflict: ${path} is owned by background child task ${labels}. Wait for it to finish or cancel that work. Shell writes cannot be reliably parsed and are not blocked.`;
		ctx.ui.notify(reason, "warning");
		return { block: true, reason };
	});

	pi.registerTool({
		name: "grill_batch",
		label: "Grill Batch",
		description: "Ask a whole batch of implementation-blocking clarification questions and return the user's batch answers.",
		promptSnippet: "Ask batched grill questions with recommendation/options/freeform answers.",
		promptGuidelines: [
			"Use grill_batch when ambiguity affects implementation; generate all current questions at once and do not reason between individual answers.",
		],
		parameters: Type.Object({
			questions: Type.Array(Type.Object({
				id: Type.Optional(Type.String()),
				question: Type.String(),
				reason: Type.String(),
				recommendation: Type.String(),
				alternatives: Type.Optional(Type.Array(Type.String())),
				defaultAssumption: Type.Optional(Type.String()),
			})),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const questions = (params.questions as GrillQuestion[]).slice(0, 12);
			if (questions.length === 0) {
				return { content: [{ type: "text", text: "No grill questions." }], details: { answers: [] } };
			}
			const optionsFor = (q: GrillQuestion) => [
				`Recommended: ${q.recommendation}`,
				...(q.alternatives ?? []).map((a, i) => `Alternative ${i + 1}: ${a}`),
				`Use default assumption: ${q.defaultAssumption || q.recommendation}`,
				"None of these / I will describe what I want",
			];
			const fallback = questions.map((q) => ({ selected: optionsFor(q)[0]!, context: "" }));
			const answers = ctx.hasUI
				? await ctx.ui.custom<Array<{ selected: string; context: string }> | null>((tui, theme, _kb, done) => {
					let qIndex = 0;
					let optionIndex = 0;
					const contexts = questions.map(() => "");
					const selected = questions.map(() => "");
					let cached: string[] | undefined;
					let focused = false;
					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (s) => theme.fg("accent", s),
							selectedText: (s) => theme.fg("accent", s),
							description: (s) => theme.fg("muted", s),
							scrollInfo: (s) => theme.fg("dim", s),
							noMatch: (s) => theme.fg("warning", s),
						},
					};
					const editor = new Editor(tui, editorTheme);
					editor.disableSubmit = true;
					const refresh = () => { cached = undefined; tui.requestRender(); };
					editor.onChange = refresh;
					const saveContext = () => { contexts[qIndex] = editor.getExpandedText(); };
					const changeQuestion = (next: number) => {
						saveContext();
						qIndex = next;
						optionIndex = 0;
						editor.setText(contexts[qIndex]!);
						refresh();
					};
					const commitCurrent = () => {
						saveContext();
						selected[qIndex] = optionsFor(questions[qIndex]!)[optionIndex]!;
						if (qIndex < questions.length - 1) { changeQuestion(qIndex + 1); return; }
						done(selected.map((s, i) => ({ selected: s || optionsFor(questions[i]!)[0]!, context: contexts[i]! })));
					};
					return {
						get focused() { return focused; },
						set focused(value: boolean) { focused = value; editor.focused = value; },
						invalidate: () => { cached = undefined; editor.invalidate(); },
						handleInput(data: string) {
							// Up/down and tab/shift+tab, not shift+arrow: many terminal emulators
							// intercept shift+arrow for their own native text selection and never
							// forward it to the app, so that binding silently did nothing.
							const opts = optionsFor(questions[qIndex]!);
							if (matchesKey(data, Key.shift("tab"))) { changeQuestion(Math.max(0, qIndex - 1)); return; }
							if (matchesKey(data, Key.tab)) { changeQuestion(Math.min(questions.length - 1, qIndex + 1)); return; }
							if (matchesKey(data, Key.escape)) { done(null); return; }
							if (matchesKey(data, Key.enter)) { commitCurrent(); return; }
							if (matchesKey(data, Key.up)) { optionIndex = Math.max(0, optionIndex - 1); refresh(); return; }
							if (matchesKey(data, Key.down)) { optionIndex = Math.min(opts.length - 1, optionIndex + 1); refresh(); return; }
							editor.handleInput(data);
							refresh();
						},
						render(width: number) {
							if (cached) return cached;
							const renderWidth = Math.max(1, width);
							const q = questions[qIndex]!;
							const opts = optionsFor(q);
							const lines: string[] = [];
							const addWrapped = (text: string) => lines.push(...wrapTextWithAnsi(text, renderWidth));
							const addPrefixed = (prefix: string, text: string) => {
								const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - visibleWidth(prefix)));
								wrapped.forEach((line, i) => lines.push(`${i === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`));
							};
							lines.push(theme.fg("accent", "─".repeat(renderWidth)));
							addWrapped(theme.fg("toolTitle", ` Lean Grill: ${qIndex + 1}/${questions.length}`));
							lines.push("");
							addPrefixed(" ", theme.fg("text", q.question));
							lines.push("");
							addPrefixed(" Why: ", theme.fg("muted", q.reason));
							lines.push("");
							opts.forEach((option, i) => {
								const prefix = i === optionIndex ? theme.fg("accent", "> ") : "  ";
								addPrefixed(`${prefix}${i + 1}. `, i === optionIndex ? theme.fg("accent", option) : theme.fg("text", option));
							});
							lines.push("");
							addWrapped(theme.fg("muted", " Notes/comment:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
							lines.push("");
							addWrapped(theme.fg("dim", " ←/→ edit notes • ↑/↓ choose • Tab/Shift+Tab questions • Enter next/finish • Esc cancels"));
							lines.push(theme.fg("accent", "─".repeat(renderWidth)));
							cached = lines;
							return lines;
						},
					};
				})
				: fallback;

			if (answers === null) {
				return { content: [{ type: "text", text: "Grill batch cancelled." }], isError: true, details: { cancelled: true } };
			}
			const finalAnswers = questions.map((q, i) => {
				const answer = (answers ?? fallback)[i] ?? fallback[i]!;
				return `Question ${i + 1}: ${q.question}\nSelected answer: ${answer.selected}\nAdditional context: ${answer.context || "none"}`;
			});
			return {
				content: [{ type: "text", text: `Lean grill answers received as a batch:\n\n${finalAnswers.join("\n\n")}` }],
				details: { questions, answers },
			};
		},
	});

	pi.registerTool({
		name: "save_plan",
		label: "Save Plan",
		description: "Save one temporary implementation plan under .pi/lean-flow/<branch>/plan.md.",
		promptSnippet: "Save a short temporary plan; no memory or docs.",
		promptGuidelines: ["Use save_plan for non-trivial approved plans; keep it short and temporary."],
		parameters: Type.Object({
			title: Type.String(),
			markdown: Type.String(),
			track: Type.Optional(Type.String({ description: "Track name from .pi/tracks.md this plan belongs to." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = await ensureLeanDir(ctx.cwd);
			const path = join(dir, "plan.md");
			const next = canonicalPlan(params.title, params.markdown, params.track);
			// /work reads steps only from the Implementation section: an empty one would silently run
			// a single fallback task, so reject it and let the model retry with a fixable plan.
			if (planStepCount(next) === 0) {
				return { content: [{ type: "text" as const, text: "No numbered steps parsed. Put every numbered step in the ## Implementation section (one step per line, `1. `), and make every other section a ### subheading inside it. Nothing was saved." }], isError: true };
			}
			if (existsSync(path)) {
				const old = readFileSync(path, "utf8");
				const oldGoal = planGoal(old);
				if (oldGoal && oldGoal !== planGoal(next)) {
					const archive = join(dir, "archive");
					await mkdir(archive, { recursive: true });
					const date = new Date().toISOString().slice(0, 10);
					await writeFile(join(archive, `${date}-${slugify(oldGoal.replace(/^#+\s*/, ""))}.md`), old, "utf8");
				}
			}
			await writeFile(path, next, "utf8");
			planChainGoal = undefined;
			planChainState = "";
			renderPlanOverlay(ctx);
			return { content: [{ type: "text", text: `Saved plan: ${path}` }], details: { path } };
		},
	});

	pi.registerTool({
		name: "lean_subagent_chain",
		label: "Lean Chain",
		description: "Run lean-flow-owned worker/reviewer/researcher child agents. Consecutive parallel=true tasks may run together. Parent write/edit calls are blocked only for paths a child has written or edited; shell writes cannot be reliably parsed.",
		promptSnippet: "Run a visible lean child-agent chain with 3-word-or-less labels.",
		promptGuidelines: [
			"Use lean_subagent_chain for /work and /review. Pass the complete task list to the tool; do not print it separately. Do not use external subagent tools.",
			"Every lean_subagent_chain task label must be descriptive and 3 words or fewer.",
			"Set parallel: true only for consecutive tasks that are independent and expected not to touch the same files.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				agent: Type.Union(Object.keys(AGENTS).map((agent) => Type.Literal(agent))),
				label: Type.String(),
				task: Type.String(),
				parallel: Type.Optional(Type.Boolean()),
			})),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			// Keep progress on this tool row: Pi supplies its Ctrl+O expanded state to renderResult.
			return runLeanChain(ctx, params.tasks as LeanTask[], signal, onUpdate);
		},
		renderCall(_args, _theme, _context) {
			return new Text("", 0, 0);
		},
		renderResult(result, options, theme, _context) {
			return leanChainComponent(result.details as LeanChainDetails | undefined, options, theme);
		},
	});

	pi.registerCommand("grill", {
		description: "Start/continue batched grill clarification",
		handler: async (args, ctx) => {
			const input = args.trim();
			const name = input.match(/^track\s+(.+)$/i)?.[1]?.trim();
			const track = name ? trackScope(ctx.cwd, name) : undefined;
			if (name && !track) {
				unknownTrack(ctx, name);
				return;
			}
			const goal = track ? `Work the "${track.name}" track from .pi/tracks.md. Issues:\n${track.issues}` : input || "Use the current conversation goal.";
			send(pi, `Start a lean batched grill session for this goal. First scan only the relevant repo surface: rg for filenames/line numbers, then read only tight offset/limit slices. Then call grill_batch with all current implementation-blocking questions at once. After I answer, evaluate the full batch and either call grill_batch again or state shared understanding. Goal:\n${goal}`);
		},
	});

	pi.registerCommand("plan", {
		description: "Create a comprehensive temporary implementation plan",
		handler: async (args, ctx) => {
			startPlan(pi, ctx, args.trim());
		},
	});

	pi.registerCommand("plan-add", {
		description: "Add steps to the current plan; falls back to /plan when none exists",
		handler: async (args, ctx) => {
			const current = readPlan(ctx.cwd);
			if (current === undefined) {
				startPlan(pi, ctx, args.trim());
				return;
			}
			send(pi, planAddPrompt(current, args.trim()));
		},
	});

	pi.registerCommand("plan-clear", {
		description: "Erase the branch plan and its progress snapshot",
		handler: async (_args, ctx) => {
			if (activeWorkJob) {
				ctx.ui.notify("/work is running; run /work cancel before /plan-clear", "warning");
				return;
			}
			const path = planPath(ctx.cwd);
			await rm(path, { force: true });
			await rm(planStatePath(ctx.cwd), { force: true });
			planChainGoal = undefined;
			planChainState = "";
			pendingWorkAdditions.length = 0;
			renderPlanOverlay(ctx);
			ctx.ui.notify("Plan erased", "info");
		},
	});

	pi.registerCommand("work", {
		description: "Run plan tasks; text guides the approach. Say 'start from step 3' to resume there, /work-pause to pause at the next boundary, /work cancel to abort, or --no-review to skip the closing review loop.",
		handler: async (args, ctx) => {
			if (/^cancel\b/i.test(args.trim())) {
				if (!activeWorkJob) {
					ctx.ui.notify("No /work job running", "warning");
					return;
				}
				activeWorkJob.controller.abort();
				markPendingWorkCancelled(activeWorkJob);
				renderActiveWork(ctx);
				ctx.ui.notify("/work cancellation requested", "info");
				return;
			}
			if (activeWorkJob) {
				ctx.ui.notify("/work already active; use /work cancel", "error");
				return;
			}
			const noReview = /(?:^|\s)--no-review\b/i.test(args);
			const guidance = args.replace(/(?:^|\s)--no-review\b/gi, " ").trim();
			const saved = resumeState(ctx.cwd, guidance);
			if (saved && !saved.from) {
				ctx.ui.notify("plan complete — /plan to replace, /work-add to extend", "info");
				return;
			}
			planStateCarry = saved?.steps ?? [];
			// Record this run's starting goal: a plan replaced mid-run must not repoint it.
			planChainGoal = planSteps(ctx.cwd)?.goal;
			// Keep every plan row (including completed ones) so a resumed run still shows the done
			// steps; runLeanChain marks the ones in `saved` as done and skips them.
			const tasks = tasksFromPlan(ctx.cwd, guidance);
			const reviewKey = `${ctx.cwd}\0${gitBranch(ctx.cwd)}`;
			if (noReview) reviewRounds.delete(reviewKey);
			else tasks.push({ agent: "reviewer", label: REVIEW_LABEL, task: REVIEW_TASK });
			const controller = new AbortController();
			const details = initialDetails(tasks);
			pendingWorkReload = undefined;
			pendingWorkAdditions.length = 0;
			activeWorkJob = { tasks, progress: details.tasks, details, controller, pauseRequested: false, startedAt: Date.now() };
			lastWorkJob = undefined;
			ctx.ui.setWidget("lean-plan", undefined);
			const renderWork = () => renderActiveWork(ctx);
			renderWork();
			void runLeanChain(ctx, tasks, controller.signal, (update) => {
				if (!activeWorkJob) return;
				activeWorkJob.details = update.details;
				activeWorkJob.progress = update.details.tasks;
				renderWork();
			}, { checkLabelWords: false, reloadPlan: true, completed: saved?.steps }).then(async (result) => {
				const job = activeWorkJob;
				// /reload or a session switch detached this job; its pi/ctx are dead now.
				if (job?.detached) return;
				const progress = job?.progress ?? details.tasks;
				const finalDetails = job?.details ?? { tasks: progress, current: 0, statuses: progress.map((task) => task.status) };
				const paused = result.paused === true && !controller.signal.aborted;
				const failed = Boolean(result.isError) || progress.some((task) => task.status === "failed");
				const status = paused ? "paused" : controller.signal.aborted ? "cancelled" : failed ? "failed" : "complete";
				if (status === "complete") renderPlanOverlay(ctx);
				const reason = status === "failed" && result.isError ? result.content?.[0]?.text : undefined;
				const index = progress.some((task) => task.status !== "queued") ? result.content?.[0]?.text : undefined;
				const nextStep = paused ? progress.find((task) => task.status === "queued")?.task.match(/\bplan step (\d+)\s*:/i)?.[1] : undefined;
				const line = paused
					? nextStep
						? `paused at step ${nextStep} — resume with /work start from step ${nextStep}`
						: "paused before review — resume with /work"
					: `/work ${chainSummary(status, progress, reason)}`;
				const summary = index ? `${line}\n\n${index}` : line;
				ctx.ui.notify(line, status === "complete" ? "info" : status === "cancelled" || status === "failed" ? "error" : "warning");
				sendWorkSummary(pi, status, summary, finalDetails);
				if (!noReview) closeReviewLoop(ctx, progress, reviewKey);
				lastWorkJob = { status, summary: line, details: finalDetails, finishedAt: Date.now() };
			}).catch((error) => {
				const job = activeWorkJob;
				if (job?.detached) return;
				const progress = job?.progress ?? details.tasks;
				const finalDetails = job?.details ?? { tasks: progress, current: 0, statuses: progress.map((task) => task.status) };
				const status = controller.signal.aborted ? "cancelled" : "failed";
				const reason = status === "failed" ? (error instanceof Error ? error.message : String(error)) : undefined;
				const summary = `/work ${chainSummary(status, progress, reason)}`;
				ctx.ui.notify(summary, status === "cancelled" ? "warning" : "error");
				sendWorkSummary(pi, status, summary, finalDetails);
				lastWorkJob = { status, summary, details: finalDetails, finishedAt: Date.now() };
			}).finally(() => {
				const finished = activeWorkJob;
				activeWorkJob = undefined;
				if (finished?.detached) return;
				ctx.ui.setWidget("lean-work", undefined);
				// A completed plan stays on disk; the overlay keeps showing its done rows.
				renderPlanOverlay(ctx);
			});
			ctx.ui.notify(`/work started ${tasks.length} task${tasks.length === 1 ? "" : "s"}`, "info");
		},
	});

	pi.registerCommand("work-pause", {
		description: "Pause the active /work job at the next task boundary; /work cancel aborts instead",
		handler: async (_args, ctx) => {
			if (!activeWorkJob) {
				ctx.ui.notify("No /work job running", "warning");
				return;
			}
			if (activeWorkJob.controller.signal.aborted) {
				ctx.ui.notify("/work cancellation already requested", "warning");
				return;
			}
			activeWorkJob.pauseRequested = true;
			ctx.ui.notify("/work pause requested; finishing the current task", "info");
		},
	});

	pi.registerCommand("work-reload", {
		description: "Re-read plan.md at the next /work task boundary; optional note is echoed with the diff",
		handler: async (args, ctx) => {
			if (!activeWorkJob) {
				ctx.ui.notify("No active /work", "warning");
				return;
			}
			pendingWorkReload = args.trim();
			ctx.ui.notify("Plan reload queued for the next task boundary", "info");
		},
	});

	pi.registerCommand("work-add", {
		description: "Append a numbered step to plan.md; while /work runs it runs next unless a child owns one of its files",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /work-add <step text>", "warning");
				return;
			}
			const current = readPlan(ctx.cwd);
			if (current === undefined) {
				ctx.ui.notify("No plan.md to add to; run /plan first", "warning");
				return;
			}
			const { text: next, step } = appendPlanStep(current, text);
			await writeFile(planPath(ctx.cwd), next, "utf8");
			if (activeWorkJob) {
				pendingWorkAdditions.push(step);
				ctx.ui.notify(`Step ${step} will run at the next /work boundary`, "info");
				return;
			}
			renderPlanOverlay(ctx);
			ctx.ui.notify(`Added step ${step} to plan.md`, "info");
		},
	});

	pi.registerCommand("work-status", {
		description: "Show one snapshot of the active /work job, or a summary of the last finished chain",
		handler: async (_args, ctx) => {
			if (activeWorkJob) {
				sendWorkStatus(pi, `/work ${activeSummary(activeWorkJob)}`, activeWorkJob.details);
				return;
			}
			if (lastWorkJob) {
				const elapsed = compactDuration(Date.now() - lastWorkJob.finishedAt);
				sendWorkStatus(pi, `${lastWorkJob.summary} (finished ${elapsed} ago)`, lastWorkJob.details);
				return;
			}
			ctx.ui.notify("No /work job running", "warning");
		},
	});

	pi.registerCommand("work-cancel", {
		description: "Cancel the active background /work job",
		handler: async (_args, ctx) => {
			if (!activeWorkJob) {
				ctx.ui.notify("No /work job running", "warning");
				return;
			}
			if (activeWorkJob.controller.signal.aborted) {
				ctx.ui.notify("/work cancellation already requested", "warning");
				return;
			}
			activeWorkJob.controller.abort();
			markPendingWorkCancelled(activeWorkJob);
			renderActiveWork(ctx);
			ctx.ui.notify("/work cancellation requested", "info");
		},
	});

	pi.registerCommand("cancel-work", {
		description: "Alias for /work-cancel",
		handler: async (_args, ctx) => {
			if (!activeWorkJob) {
				ctx.ui.notify("No /work job running", "warning");
				return;
			}
			if (activeWorkJob.controller.signal.aborted) {
				ctx.ui.notify("/work cancellation already requested", "warning");
				return;
			}
			activeWorkJob.controller.abort();
			markPendingWorkCancelled(activeWorkJob);
			renderActiveWork(ctx);
			ctx.ui.notify("/work cancellation requested", "info");
		},
	});

	pi.registerCommand("review", {
		description: "Fresh lean review of current diff/plan",
		handler: async (args) => send(pi, `Run lean review. Do not print a separate task list; pass every needed reviewer task directly to lean_subagent_chain with labels of 3 words or fewer so the TUI displays them. Review axes: correctness, missed acceptance criteria, AGENTS.md/guideline inconsistencies, module header/searchability gaps, and over-engineering/deletion. Do not edit during review. Do not use external subagent tools. Extra focus:\n${args.trim() || "current diff against .pi/lean-flow/plan.md if present"}`),
	});

	pi.registerCommand("lean-init", {
		description: "Create a short AGENTS.md for the current project if missing",
		handler: async (_args, ctx) => {
			const path = join(ctx.cwd, "AGENTS.md");
			if (existsSync(path)) {
				ctx.ui.notify("AGENTS.md already exists", "info");
				return;
			}
			await writeFile(path, `# Agent Rules\n\n- Code is source of truth. Use \`rg\` for filenames/line numbers, then read only tight offset/limit slices.\n- Delete before adding.\n- Prefer stdlib/native/project-local code before dependencies.\n- No abstractions for future use.\n- Keep modules feature/function focused and readable.\n- Prefer ~500-1000 line files; split by reason-to-change, not type buckets.\n- Non-trivial modules start with a tiny header: purpose, main entry points, split trigger.\n- When browsing, use \`rg\` over module headers first; avoid broad reads unless slices prove insufficient.\n- Plans are temporary. No long-term memory/docs unless humans need them too.\n- Ask batched grill questions when ambiguity affects implementation.\n- Run the smallest relevant checks before reporting done.\n`, "utf8");
			ctx.ui.notify(`Created ${path}`, "info");
		},
	});

	pi.registerCommand("track", {
		description: "List .pi/tracks.md tracks (the /tracks alias was removed; use /track); /track add <name>, /track clear, /track <name> shows issues and injects the prototype skill",
		handler: async (args, ctx) => {
			const path = join(ctx.cwd, CONFIG_DIR_NAME, "tracks.md");
			const input = args.trim();
			let text = existsSync(path) ? readFileSync(path, "utf8") : "";
			const tracks = parseTracks(text);
			if (/^add\b/i.test(input)) {
				const name = input.match(/^add\s+(.+)$/i)?.[1]?.trim();
				if (!name) {
					ctx.ui.notify("Usage: /track add <name>", "warning");
					return;
				}
				if (tracks.some((track) => track.name.toLowerCase() === name.toLowerCase())) {
					ctx.ui.notify(`Track already exists: ${name}`, "warning");
					return;
				}
				await ensurePiGitignore(ctx.cwd);
				text = `${text.trimEnd()}${text.trim() ? "\n\n" : ""}## ${name}\n`;
				await writeFile(path, text, "utf8");
				ctx.ui.notify(`Added track: ${name}`, "info");
				return;
			}
			if (/^clear$/i.test(input)) {
				if (!text) {
					ctx.ui.notify(`No tracks in ${path}`, "warning");
					return;
				}
				const next = clearCompleted(text);
				if (next === text) {
					ctx.ui.notify("No completed issues to clear", "info");
					return;
				}
				await writeFile(path, next, "utf8");
				ctx.ui.notify(`Cleared completed issues in ${path}`, "info");
				return;
			}
			if (!input) {
				const lines = trackList(tracks);
				ctx.ui.notify(lines.length ? `Tracks:\n${lines.join("\n")}` : `No tracks in ${path}; use /track add <name>`, lines.length ? "info" : "warning");
				return;
			}
			const track = tracks.find((candidate) => candidate.name.toLowerCase() === input.toLowerCase());
			if (!track) {
				ctx.ui.notify(`Unknown track: ${input}\n${trackList(tracks).join("\n") || `No tracks in ${path}`}`, "warning");
				return;
			}
			const marker = (status: string) => (status === "completed" ? "x" : status === "started" ? "-" : " ");
			const details = track.issues.length
				? track.issues.map((issue) => `- [${marker(issue.status)}] ${issue.text}${issue.detail ? `\n  ${issue.detail.replace(/\n/g, "\n  ")}` : ""}`).join("\n")
				: "No issues.";
			ctx.ui.notify(`Track ${track.name}:\n${details}`, "info");
			const open = track.issues.filter((issue) => issue.status !== "completed");
			const openText = open.length
				? open.map((issue) => `- [${marker(issue.status)}] ${issue.text}${issue.detail ? `\n  ${issue.detail.replace(/\n/g, "\n  ")}` : ""}`).join("\n")
				: "No open issues; review the track and ask what to prototype.";
			send(pi, `/skill:prototype Work the "${track.name}" track from .pi/tracks.md. Open issues:\n${openText}`, true);
		},
	});

	pi.registerCommand("runs", {
		description: "List run artifacts with age, branch, task count, and size",
		handler: async (_args, ctx) => {
			const runs = listRuns(ctx.cwd);
			const lines = runs.map((run) => `${formatRunAge(run.ageMs)} ago  ${run.branch}  ${run.tasks} task${run.tasks === 1 ? "" : "s"}  ${formatRunBytes(run.bytes)}  ${run.id}`);
			ctx.ui.notify(lines.length ? `Runs (newest first):\n${lines.join("\n")}` : "No runs", lines.length ? "info" : "warning");
		},
	});

	pi.registerCommand("handover", {
		description: "Generate a concise handover and open it in a fresh session",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || !ctx.model) {
				ctx.ui.notify("/handover needs interactive mode and a selected model", "error");
				return;
			}
			const goal = args.trim() || "Continue the current task safely in a fresh session.";
			const messages = handoffMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("No session context to hand over", "error");
				return;
			}
			const conversationText = serializeConversation(convertToLlm(messages));
			const repoState = handoverRepoState(ctx.cwd);
			const parentSession = ctx.sessionManager.getSessionFile();

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating lean handover...");
				loader.onAbort = () => done(null);
				(async () => {
					const model = ctx.modelRegistry.find(CHILD_MODEL.provider, CHILD_MODEL.id) ?? ctx.model!;
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
					const userMessage: Message = { role: "user", content: [{ type: "text", text: `Goal: ${goal}\n\nRepo state:\n${repoState}\n\nConversation:\n${conversationText}` }], timestamp: Date.now() };
					const response = await complete(model, { systemPrompt: HANDOFF_SYSTEM, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal });
					if (response.stopReason === "aborted") return null;
					return response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
				})().then(done).catch((err) => done(`Handover generation failed: ${err instanceof Error ? err.message : String(err)}`));
				return loader;
			});

			if (!result) {
				ctx.ui.notify("Handover cancelled", "info");
				return;
			}
			const edited = await ctx.ui.editor("Edit lean handover", result);
			if (!edited) return;
			const summarizedRuns = summarizedRunDirs(ctx.cwd, conversationText);
			const created = await ctx.newSession({
				parentSession,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(edited);
					replacementCtx.ui.notify("Lean handover ready. Submit when ready.", "info");
				},
			});
			if (!created.cancelled) await Promise.all(summarizedRuns.map((path) => rm(path, { recursive: true, force: true })));
		},
	});
}
