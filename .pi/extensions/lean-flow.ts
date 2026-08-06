// Lean workflow tools and TUI. Entry points: grill_batch and lean subagent commands. Split when their concerns diverge.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, CONFIG_DIR_NAME, convertToLlm, createAgentSession, DefaultResourceLoader, getAgentDir, serializeConversation, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LEAN_SYSTEM = `LEAN FLOW ACTIVE. CONCISE PONYTAIL-FULL BASELINE; DO NOT AUTO-LOAD SKILLS.
Permanent rules for the parent agent:
- Ponytail full: understand and trace the real flow first, then stop at the first working rung: skip speculative work; reuse project code; stdlib; native platform; installed dependency; one line; minimum code.
- Be lazy like a senior dev: the best code is code not written. YAGNI wins: delete before adding; no future-proof abstractions, boilerplate, scaffolding, factories, or one-implementation interfaces.
- Code is source of truth. Use rg/find/read before assuming: rg for filenames/line numbers, then read only tight offset/limit slices. For bugs, trace every caller and fix the shared root cause, not the named symptom.
- Preserve requested validation, data-loss prevention, security, accessibility, and error handling. Pick the edge-case-correct stdlib option; mark deliberate shortcut ceilings with a ponytail comment and upgrade path.
- Keep modules feature/function focused and readable; split by reason-to-change, not type buckets; ~500-1000 lines is a warning, not a law.
- Non-trivial modules should start with a short header: purpose, main entry points, and split trigger. When browsing, rg module headers first, then read matching files.
- No long-term memory, lifecycle docs, ADRs, or issue tracker ceremony unless the user explicitly asks.
- Non-trivial logic needs the smallest runnable check; trivial one-liners do not.
- Output caveman-terse: code/actions first, then at most three short lines.
- Use batched grill only when ambiguity changes implementation. Generate the whole question batch at once, then evaluate answers as a batch.
- For large chunks: grill -> short temporary plan -> pass the full atomic task list to lean_subagent_chain for TUI display -> worker chain -> fresh review -> human validation gate.
- Lean-flow owns subagents. Use lean_subagent_chain, not external subagent tools/workflows.
- Keep subagents lazy: worker for atomic write tasks, reviewer for read-only review. Use as many chain steps as needed; no arbitrary cap.
- Subagent chain tasks must have descriptive labels in 3 words or fewer so the TUI shows what is happening.
- If context usage reaches about 50%, prepare a /handover and stop instead of compacting by default.`;

const PONYTAIL_SKILL_PATH = join(getAgentDir(), "skills", "ponytail", "SKILL.md");

function ponytailRules(): string {
	const skill = readFileSync(PONYTAIL_SKILL_PATH, "utf8").trim();
	return skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

const HANDOFF_SYSTEM = `Generate a focused handover prompt for a fresh Pi session.
Include only: current goal, decisions, relevant files, changed files if known, validation status, blockers, and exact next task.
Keep it concise and self-contained. No preamble.`;

type GrillQuestion = {
	id?: string;
	question: string;
	reason: string;
	recommendation: string;
	alternatives?: string[];
	defaultAssumption?: string;
};

type LeanTask = {
	agent: "worker" | "reviewer";
	label: string;
	task: string;
	parallel?: boolean;
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
	status: "queued" | "running" | "done" | "failed" | "cancelled";
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
};

type LeanChainResult = {
	content: { type: "text"; text: string }[];
	details?: LeanChainDetails | Record<string, unknown>;
	isError?: boolean;
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
	startedAt: number;
};

type LeanBackgroundJob = {
	id: string;
	controller: AbortController;
	details: LeanChainDetails;
	startedAt: number;
	lastProgressAt: number;
};

const LEAN_JOB_MESSAGE = "lean-background-job";
const PER_TASK_OUTPUT_CAP = 2_000;

const AGENTS: Record<LeanTask["agent"], { tools: string; prompt: string }> = {
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
- Run the smallest relevant check. If no automated check exists, say so.
- Output caveman-terse: changed files; checks; blockers; manual validation. No essays.

Output: changed files; checks run + result; blockers/decisions; manual validation needed.`,
	},
	reviewer: {
		tools: "read,bash",
		prompt: `You are lean.reviewer: a read-only reviewer. Ponytail/YAGNI is mandatory.

Review only. Do not modify project/source files.
Inspect the actual repo/diff with git diff, rg, and read. Report only evidence-backed findings.

Axes: correctness/regressions; missed acceptance criteria or plan drift; AGENTS.md/guideline inconsistencies; module header/searchability gaps; validation gaps; over-engineering/deletion. Prefer findings that delete or simplify.

Output concise findings with severity, file/line or command evidence, what to change, and smallest safe fix. If nothing worth fixing now, say that.`,
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

function statusRail(task: LeanTaskProgress, ctxSeparator = "/"): string {
	const usage = task.usage;
	const ctx = contextPercent(usage);
	const ctxTokens = usage?.contextTokens ? formatTokens(usage.contextTokens) : "--";
	const input = usage?.input ? formatTokens(usage.input) : "--";
	const output = usage?.output ? formatTokens(usage.output) : "--";
	const clock = task.startedAt ? compactDuration((task.endedAt ?? Date.now()) - task.startedAt) : "--:--";
	return ` │ ctx ${padLeftVisible(ctx, 4)} ${ctxSeparator} ${padRightVisible(ctxTokens, 5)} │ ↑ ${padLeftVisible(input, 5)} │ ↓ ${padLeftVisible(output, 5)} │ ◷ ${padLeftVisible(clock, 5)} │`;
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
	return task.startedAt ? `${Math.max(0, Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000))}s` : undefined;
}

function queuedText(task: LeanTaskProgress): string {
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
	const childPrompt = `${agent.prompt}\n\nPONYTAIL FULL RULES (explicitly injected; skills remain isolated):\n${ponytailRules()}`;
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		appendSystemPromptOverride: () => [childPrompt],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
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
		if (event.type === "agent_end") { phase = "agent done"; live = "agent done"; addFeed(live); publish(); }
	});

	try {
		publish();
		await session.prompt(task.task);
		updateContext(session);
		return { code: 0, output: (output || live).trim() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (signal?.aborted) {
			phase = "cancelled";
			live = "Cancelled.";
			addFeed(live);
			publish();
			return { code: null, output: (output || live).trim(), cancelled: true };
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
	const entries = compactionIndex < 0 ? branch : branch.slice(compactionIndex);
	return entries.map(entryToMessage).filter((m): m is AgentMessage => m !== undefined);
}

function send(pi: ExtensionAPI, text: string) {
	pi.sendUserMessage(text, { deliverAs: "followUp" });
}

function projectRoot(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		if (existsSync(join(current, ".git")) || existsSync(join(current, "Map"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

function explicitPlanContext(cwd: string, args: string): { label: string; path: string; text: string } | undefined {
	const reference = args.trim();
	const issueId = reference.match(/^(?:issue\s+|#)(\d+)$/i)?.[1];
	if (issueId) {
		const dir = join(projectRoot(cwd), "Map", "issues");
		const name = existsSync(dir) ? readdirSync(dir).find((value) => value.startsWith(`${issueId}-`) && value.endsWith(".json")) : undefined;
		if (!name) return;
		const path = join(dir, name);
		return { label: `issue #${issueId}`, path, text: readFileSync(path, "utf8") };
	}
	if (!reference || reference === "." || reference === ".." || /[/\\]/.test(reference)) return;
	const path = join(projectRoot(cwd), "Map", reference, "handoff.md");
	if (!existsSync(path)) return;
	return { label: "effort handoff", path, text: readFileSync(path, "utf8") };
}

function renderEyeHeader(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const candidates = [
		join(ctx.cwd, CONFIG_DIR_NAME, "project-flow", "welcome-art.md"),
		join(getAgentDir(), "..", "project-flow", "welcome-art.md"),
	];
	const artPath = candidates.find((path) => existsSync(path));
	if (!artPath) return;
	const lines = readFileSync(artPath, "utf8")
		.trim()
		.replace(/^```[\w-]*\r?\n/, "")
		.replace(/\r?\n```$/, "")
		.split(/\r?\n/)
		.slice(4, 21);
	ctx.ui.setHeader((_tui, theme) => ({
		invalidate() {},
		render(width: number) {
			return ["", ...lines.map((line) => theme.fg("muted", truncateToWidth(line, width))), ""];
		},
	}));
}

async function ensureLeanDir(cwd: string): Promise<string> {
	const dir = join(cwd, CONFIG_DIR_NAME, "lean-flow");
	await mkdir(dir, { recursive: true });
	return dir;
}

function leanPlanStepCount(cwd: string): number {
	const path = join(cwd, CONFIG_DIR_NAME, "lean-flow", "plan.md");
	if (!existsSync(path)) return 0;
	const text = readFileSync(path, "utf8");
	const section = text.split(/\n##\s+Lean implementation plan\s*\n/i)[1]?.split(/\n##\s+/)[0] ?? text;
	return (section.match(/^\s*\d+\.\s+/gm) ?? []).length;
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
				const icon = status === "running" ? runningIcon : status === "done" ? "◆" : status === "failed" || status === "cancelled" ? "✖" : "◇";
				return `${icon} ${task.label}`;
			});
			const activeRightWidth = Math.max(0, ...d.tasks.map((task, i) => {
				const status = task.status ?? d.statuses?.[i] ?? "queued";
				return status === "queued"
					? visibleWidth(` - ${queuedText(task)}`)
					: visibleWidth(statusRail(task, status === "running" ? runningCtxIcon : "/")) + visibleWidth(` ${status}`);
			}));
			const titleWidth = Math.min(Math.max(...titles.map(visibleWidth)), Math.max(0, width - activeRightWidth));
			const lines: string[] = d.tasks.map((task, i) => {
				const status = task.status ?? d.statuses?.[i] ?? "queued";
				const color = status === "running" ? "accent" : status === "done" ? "success" : status === "failed" || status === "cancelled" ? "error" : "borderAccent";
				const title = titles[i]!;
				const left = truncateToWidth(title, titleWidth, "…", true);
				if (status === "queued") return theme.fg("dim", `${left} - ${queuedText(task)}`);
				const railText = statusRail(task, status === "running" ? runningCtxIcon : "/");
				const stateText = ` ${status}`;
				return theme.fg(color, left) + theme.fg(color, railText) + theme.fg(color, stateText);
			});
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

function stripPlanParallelMarker(text: string): string {
	return text.replace(/\s\[parallel(?::[^\]]+)?\]\s*$/i, "").trim();
}

function taskLabel(text: string): string {
	return stripPlanParallelMarker(text).replace(/[`*_#>[\]()]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 3).join(" ") || "Lean work";
}

function planStepParallel(body: string): boolean {
	return stripPlanParallelMarker(body) !== body.trim();
}

function tasksFromPlan(cwd: string, args: string): LeanTask[] {
	const path = join(cwd, CONFIG_DIR_NAME, "lean-flow", "plan.md");
	if (!existsSync(path)) return [{ agent: "worker", label: "Lean work", task: args.trim() || "Implement the next approved chunk." }];
	const text = readFileSync(path, "utf8");
	const section = text.split(/\n##\s+Implementation\s*\n/i)[1]?.split(/\n##\s+/)[0] ?? text;
	const wantedStep = args.match(/\b(?:step|item|part)\s*#?\s*(\d+)\b/i)?.[1];
	const planSteps = [...section.matchAll(/^\s*(\d+)\.\s+(.+)$/gm)]
		.map((match) => {
			const rawBody = match[2]!.trim();
			return { step: match[1]!, body: stripPlanParallelMarker(rawBody), markedParallel: planStepParallel(rawBody) };
		})
		.filter((step) => !wantedStep || step.step === wantedStep);
	const tasks = planSteps.map((planStep, index) => {
		const hasParallelNeighbor = planStep.markedParallel && Boolean(planSteps[index - 1]?.markedParallel || planSteps[index + 1]?.markedParallel);
		return {
			agent: "worker" as const,
			label: taskLabel(planStep.body),
			task: `Implement plan step ${planStep.step}: ${planStep.body}${args.trim() ? `\n\nExtra instruction: ${args.trim()}` : ""}`,
			parallel: hasParallelNeighbor || undefined,
		};
	});
	// Ponytail ceiling: this only extracts flat numbered plan items; nested/semantic "next approved chunk" selection still belongs to a parent planning turn.
	return tasks.length ? tasks : [{ agent: "worker", label: "Lean work", task: `${args.trim() || "Implement the next approved chunk."}\n\nPlan:\n${text.slice(0, 4000)}` }];
}

function initialDetails(tasks: LeanTask[]): LeanChainDetails {
	const progress: LeanTaskProgress[] = tasks.map((task) => ({ ...task, status: "queued", latest: "queued" }));
	return { tasks: progress, current: 0, statuses: progress.map((task) => task.status), currentTask: progress[0]?.task };
}

function boundedDetails(details: LeanChainDetails): LeanChainDetails {
	const tasks = details.tasks.map((task) => ({ ...task, output: task.output?.slice(-PER_TASK_OUTPUT_CAP) }));
	return { ...details, tasks, statuses: tasks.map((task) => task.status), currentOutput: details.currentOutput?.slice(-PER_TASK_OUTPUT_CAP) };
}

function jobMessage(job: LeanBackgroundJob, state: "started" | "progress" | "complete" | "failed"): { content: string; details: { jobId: string; state: string; elapsed: string; chain: LeanChainDetails } } {
	const chain = boundedDetails(job.details);
	const current = chain.tasks[chain.current];
	const task = current ? ` · ${current.label}: ${current.status}` : "";
	return {
		content: `Lean job ${job.id} ${state}${task}`,
		details: { jobId: job.id, state, elapsed: compactDuration(Date.now() - job.startedAt), chain },
	};
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

function formatWorkStatus(activeWorkJob: ActiveWorkJob | undefined, options: { feedTail?: boolean | number } = {}): string {
	if (!activeWorkJob) return "/work idle";
	const elapsed = compactDuration(Date.now() - activeWorkJob.startedAt);
	const feedTailLines = typeof options.feedTail === "number" ? Math.max(0, options.feedTail) : options.feedTail ? 8 : 0;
	const lines = [`/work active ${elapsed}`];
	for (const task of activeWorkJob.progress) {
		const usage = task.usage;
		const ctx = contextPercent(usage);
		const ctxTokens = usage?.contextTokens ? formatTokens(usage.contextTokens) : "--";
		const input = usage?.input ? formatTokens(usage.input) : "--";
		const output = usage?.output ? formatTokens(usage.output) : "--";
		lines.push(`- ${task.label}: ${task.status} ctx ${ctx} ${ctxTokens} in ${input} out ${output}`);
	}
	const latest = latestWorkLine(activeWorkJob.progress);
	if (latest) lines.push(`latest: ${latest}`);
	if (feedTailLines > 0) {
		const feed = activeWorkJob.progress
			.filter((task) => task.status === "running" && task.output)
			.flatMap((task) => task.output!.split(/\r?\n/).filter(Boolean).map((line) => `${task.label}: ${line}`))
			.slice(-feedTailLines);
		if (feed.length) lines.push("feed:", ...feed.map((line) => `  ${line}`));
	}
	return lines.join("\n");
}

function workSummary(status: "complete" | "cancelled" | "failed", tasks: LeanTaskProgress[], reason?: string): string {
	const counts = tasks.reduce<Record<LeanTaskProgress["status"], number>>((acc, task) => {
		acc[task.status]++;
		return acc;
	}, { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 });
	const failed = tasks.filter((task) => task.status === "failed").map((task) => task.label).slice(0, 2).join(", ");
	const suffix = reason ? `: ${reason.split(/\r?\n/)[0]?.slice(0, 160)}` : failed ? `: ${failed}` : "";
	return `/work ${status}: ${counts.done} done, ${counts.failed} failed, ${counts.cancelled} cancelled, ${counts.running + counts.queued} pending${suffix}`;
}

function sendWorkSummary(pi: ExtensionAPI, summary: string, details: LeanChainDetails): void {
	pi.sendMessage({
		customType: "lean-work-summary",
		content: summary,
		display: true,
		details: { status: summary.includes(" cancelled:") ? "cancelled" : summary.includes(" failed:") ? "failed" : "complete", chain: boundedDetails(details) },
	}, { deliverAs: "followUp" });
}

function sendWorkStatus(pi: ExtensionAPI, status: string): void {
	pi.sendMessage({ customType: "lean-work-status", content: status, display: true }, { deliverAs: "followUp" });
}

function resolvedToolPath(cwd: string, path: string): string {
	return resolve(cwd, path.startsWith("@") ? path.slice(1) : path);
}

export default function leanFlow(pi: ExtensionAPI) {
	let activeWorkJob: ActiveWorkJob | undefined;
	const backgroundJobs = new Map<string, LeanBackgroundJob>();
	const ownedPaths = new Map<string, Set<LeanTaskProgress>>();
	let nextBackgroundJob = 1;
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
	pi.registerMessageRenderer(LEAN_JOB_MESSAGE, (message, options, theme) => {
		const details = message.details as { jobId?: string; state?: string; elapsed?: string; chain?: LeanChainDetails } | undefined;
		const header = theme.fg("toolTitle", `Lean job ${details?.jobId ?? "?"} ${details?.state ?? "update"} · ${details?.elapsed ?? "--:--"}`);
		const chain = leanChainComponent(details?.chain, options, theme);
		return new Text([header, ...chain.render(100)].join("\n"), options.outputPad, 0);
	});
	pi.registerMessageRenderer("lean-work-summary", (message, options, theme) => {
		const details = message.details as { status?: string; chain?: LeanChainDetails } | undefined;
		const state = details?.status === "cancelled" || details?.status === "failed"
			? theme.fg("error", details.status.toUpperCase())
			: "complete";
		const chain = leanChainComponent(details?.chain, options, theme);
		return new Text([theme.fg("toolTitle", `/work ${state}`), ...chain.render(100)].join("\n"), options.outputPad, 0);
	});
	const renderActiveWork = (ctx: ExtensionContext) => ctx.ui.setWidget("lean-work", (_tui, theme) => leanChainComponent(activeWorkJob?.details, { expanded: false }, theme), { placement: "aboveEditor" });

	const runLeanChain = async (ctx: ExtensionContext, inputTasks: LeanTask[], signal?: AbortSignal, publish?: (update: LeanChainUpdate) => void): Promise<LeanChainResult> => {
		if (inputTasks.length === 0) return { content: [{ type: "text" as const, text: "No lean subagent tasks." }] };
		const workerTasks = inputTasks.filter((task) => task.agent === "worker");
		const planSteps = leanPlanStepCount(ctx.cwd);
		if (workerTasks.length === 1 && planSteps > 1 && !looksExplicitlyNarrow(workerTasks[0]!.task)) {
			return {
				content: [{ type: "text" as const, text: `Plan has ${planSteps} numbered implementation steps, but only one broad worker task was submitted. Split the work into atomic worker tasks, normally at least one per plan step. If this is intentionally narrow, mention the exact step or include narrow-task-ok.` }],
				isError: true,
				details: { planSteps, workerTasks: workerTasks.length },
			};
		}
		for (const task of inputTasks) {
			const words = task.label.trim().split(/\s+/).filter(Boolean);
			if (words.length > 3) {
				return { content: [{ type: "text" as const, text: `Task label too long: "${task.label}". Use 3 words or fewer.` }], isError: true };
			}
		}
		let current = 0;
		const progress: LeanTaskProgress[] = inputTasks.map((task) => ({ ...task, status: "queued", latest: "queued" }));
		const details = (): LeanChainDetails => {
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
			};
		};
		const plainSummary = () => {
			const titleWidth = Math.max(...progress.map((task) => visibleWidth(`◦ ${task.label}`)));
			return progress.map((task) => {
				const icon = task.status === "running" ? "⠋" : task.status === "done" ? "✓" : task.status === "failed" || task.status === "cancelled" ? "✗" : "◦";
				const title = `${icon} ${task.label}`;
				const left = truncateToWidth(title, titleWidth, "…", true);
				if (task.status === "queued") return `${left} - ${queuedText(task)}`;
				return `${left}${statusRail(task)} ${task.status}`;
			}).join("\n");
		};
		const emit = () => {
			publish?.({ content: [{ type: "text", text: plainSummary() }], details: details() });
		};
		const outputs: string[] = [];
		emit();
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
			const result = await runPiChild(ctx, task, ctx.model?.contextWindow, signal, (childProgress) => {
				if (signal?.aborted) return;
				current = i;
				Object.assign(task, childProgress);
				task.updatedAt = Date.now();
				task.output = task.output?.slice(-4000);
				task.latest = task.latest?.slice(0, 160) || "working";
				emit();
			}, (path) => ownPath(task, ctx.cwd, path)).catch((error) => ({
				code: 1,
				output: error instanceof Error ? error.message : String(error),
				cancelled: false,
			}));
			releaseTaskPaths(task);
			task.status = result.cancelled || signal?.aborted ? "cancelled" : result.code === 0 ? "done" : "failed";
			task.endedAt = Date.now();
			task.updatedAt = task.endedAt;
			task.output = result.output.slice(-4000);
			task.latest = task.status === "done" ? "done" : task.status === "cancelled" ? "cancelled" : `failed: exit ${result.code}`;
			emit();
			return { index: i, code: result.code, output: result.output, cancelled: task.status === "cancelled" };
		};
		for (let i = 0; i < progress.length;) {
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
			const batch: number[] = [i];
			if (progress[i]!.parallel) {
				while (i + batch.length < progress.length && progress[i + batch.length]!.parallel) batch.push(i + batch.length);
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
			for (const result of results) {
				const task = progress[result.index]!;
				outputs.push(`\n## ${result.index + 1}. ${task.label} (${task.agent}, exit ${result.code})\n\n${result.output}`);
			}
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
		const cancelled = progress.some((task) => task.status === "cancelled");
		return { content: [{ type: "text" as const, text: cancelled ? "Lean chain cancelled." : "Lean chain complete." }], details: details(), isError: cancelled || undefined };
	};

	pi.on("session_start", async (_event, ctx) => {
		renderEyeHeader(ctx);
		ctx.ui.setStatus("lean-flow", ctx.ui.theme.fg("accent", "lean"));
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const warning = usage?.percent !== null && usage?.percent !== undefined && usage.percent >= 50
			? `\n\n[LEAN FLOW CONTEXT WARNING] Context is about ${usage.percent.toFixed(0)}%. Generate a /handover and stop unless the user explicitly wants to continue.`
			: "";
		return { systemPrompt: `${ctx.getSystemPrompt()}\n\n${LEAN_SYSTEM}${warning}` };
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const path = (event.input as { path?: unknown }).path;
		if (typeof path !== "string") return;
		const owners = ownedPaths.get(resolvedToolPath(ctx.cwd, path));
		if (!owners?.size) return;
		const labels = [...owners].map((task) => task.label).join(", ");
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
							const opts = optionsFor(questions[qIndex]!);
							if (matchesKey(data, Key.shift("left"))) { changeQuestion(Math.max(0, qIndex - 1)); return; }
							if (matchesKey(data, Key.shift("right"))) { changeQuestion(Math.min(questions.length - 1, qIndex + 1)); return; }
							if (matchesKey(data, Key.escape)) { done(null); return; }
							if (matchesKey(data, Key.enter)) { commitCurrent(); return; }
							if (matchesKey(data, Key.shift("up"))) { optionIndex = Math.max(0, optionIndex - 1); refresh(); return; }
							if (matchesKey(data, Key.shift("down"))) { optionIndex = Math.min(opts.length - 1, optionIndex + 1); refresh(); return; }
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
							addWrapped(theme.fg("dim", " arrows edit notes • Shift+↑/↓ choose • Shift+←/→ questions • Enter next/finish • Esc cancels"));
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
		name: "save_lean_plan",
		label: "Save Lean Plan",
		description: "Save one temporary lean implementation plan under .pi/lean-flow/plan.md.",
		promptSnippet: "Save a short temporary plan; no memory or docs.",
		promptGuidelines: ["Use save_lean_plan for non-trivial approved plans; keep it short and temporary."],
		parameters: Type.Object({
			title: Type.String(),
			markdown: Type.String(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = await ensureLeanDir(ctx.cwd);
			const path = join(dir, "plan.md");
			await writeFile(path, `# ${params.title}\n\n${params.markdown.trim()}\n`, "utf8");
			return { content: [{ type: "text", text: `Saved lean plan: ${path}` }], details: { path } };
		},
	});

	pi.registerTool({
		name: "lean_subagent_chain",
		label: "Lean Chain",
		description: "Run lean-flow-owned worker/reviewer child agents. Consecutive parallel=true tasks may run together. Parent write/edit calls are blocked only for paths a child has written or edited; shell writes cannot be reliably parsed.",
		promptSnippet: "Run a visible lean child-agent chain with 3-word-or-less labels.",
		promptGuidelines: [
			"Use lean_subagent_chain for /work and /review. Pass the complete task list to the tool; do not print it separately. Do not use external subagent tools.",
			"Every lean_subagent_chain task label must be descriptive and 3 words or fewer.",
			"Set parallel: true only for consecutive tasks that are independent and expected not to touch the same files.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				agent: Type.Union([Type.Literal("worker"), Type.Literal("reviewer")]),
				label: Type.String(),
				task: Type.String(),
				parallel: Type.Optional(Type.Boolean()),
			})),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const id = `job-${nextBackgroundJob++}`;
			const job: LeanBackgroundJob = {
				id,
				controller: new AbortController(),
				details: initialDetails(params.tasks as LeanTask[]),
				startedAt: Date.now(),
				lastProgressAt: 0,
			};
			backgroundJobs.set(id, job);
			const emit = (state: "started" | "progress" | "complete" | "failed") => {
				const message = jobMessage(job, state);
				pi.sendMessage({ customType: LEAN_JOB_MESSAGE, content: message.content, display: true, details: message.details }, { deliverAs: "steer", triggerTurn: false });
			};
			emit("started");
			void runLeanChain(ctx, params.tasks as LeanTask[], job.controller.signal, (update) => {
				job.details = boundedDetails(update.details);
				if (Date.now() - job.lastProgressAt < 500) return;
				job.lastProgressAt = Date.now();
				emit("progress");
			}).then((result) => {
				const details = result.details as LeanChainDetails | undefined;
				if (Array.isArray(details?.tasks)) job.details = boundedDetails(details);
				emit(result.isError ? "failed" : "complete");
			}).catch((error) => {
				const task = job.details.tasks[job.details.current];
				if (task) { task.status = "failed"; task.latest = error instanceof Error ? error.message : String(error); }
				emit("failed");
			}).finally(() => backgroundJobs.delete(id));
			return { content: [{ type: "text", text: `Started lean background job ${id}.` }], details: { jobId: id } };
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
		handler: async (args) => send(pi, `Start a lean batched grill session for this goal. First scan only the relevant repo surface: rg for filenames/line numbers, then read only tight offset/limit slices. Then call grill_batch with all current implementation-blocking questions at once. After I answer, evaluate the full batch and either call grill_batch again or state shared understanding. Goal:\n${args.trim() || "Use the current conversation goal."}`),
	});

	pi.registerCommand("plan", {
		description: "Create a short temporary lean plan",
		handler: async (args, ctx) => {
			const prompt = `Create a short lean implementation plan. Use rg for filenames/line numbers, then read only tight offset/limit slices for the code map. Ask grill_batch first if any ambiguity changes implementation. Then call save_lean_plan. No memory/docs/ADRs. Scope:\n${args.trim() || "Use the current conversation goal."}`;
			const context = explicitPlanContext(ctx.cwd, args);
			send(pi, context ? `${prompt}\n\nExplicit ${context.label} (${context.path}):\n${context.text}` : prompt);
		},
	});

	pi.registerCommand("work", {
		description: "Run atomic lean worker tasks from the current plan. Use /work cancel to stop active work.",
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
			const tasks = tasksFromPlan(ctx.cwd, args);
			const controller = new AbortController();
			const details = initialDetails(tasks);
			activeWorkJob = { tasks, progress: details.tasks, details, controller, startedAt: Date.now() };
			const renderWork = () => renderActiveWork(ctx);
			renderWork();
			void runLeanChain(ctx, tasks, controller.signal, (update) => {
				if (!activeWorkJob) return;
				activeWorkJob.details = update.details;
				activeWorkJob.progress = update.details.tasks;
				renderWork();
			}).then((result) => {
				const job = activeWorkJob;
				const progress = job?.progress ?? details.tasks;
				const finalDetails = job?.details ?? { tasks: progress, current: 0, statuses: progress.map((task) => task.status) };
				const failed = Boolean(result.isError) || progress.some((task) => task.status === "failed");
				if (controller.signal.aborted) {
					ctx.ui.notify("/work cancelled", "warning");
					sendWorkSummary(pi, workSummary("cancelled", progress), finalDetails);
				} else if (failed) {
					ctx.ui.notify("/work failed", "error");
					sendWorkSummary(pi, workSummary("failed", progress, result.isError ? result.content?.[0]?.text : undefined), finalDetails);
				} else {
					ctx.ui.notify("/work complete", "info");
					sendWorkSummary(pi, workSummary("complete", progress), finalDetails);
				}
			}).catch((error) => {
				const job = activeWorkJob;
				const progress = job?.progress ?? details.tasks;
				const finalDetails = job?.details ?? { tasks: progress, current: 0, statuses: progress.map((task) => task.status) };
				if (controller.signal.aborted) {
					ctx.ui.notify("/work cancelled", "warning");
					sendWorkSummary(pi, workSummary("cancelled", progress), finalDetails);
				} else {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`/work failed: ${message}`, "error");
					sendWorkSummary(pi, workSummary("failed", progress, message), finalDetails);
				}
			}).finally(() => {
				activeWorkJob = undefined;
				ctx.ui.setWidget("lean-work", undefined);
			});
			ctx.ui.notify(`/work started ${tasks.length} task${tasks.length === 1 ? "" : "s"}`, "info");
		},
	});

	pi.registerCommand("work-status", {
		description: "Show one snapshot of the active background /work job",
		handler: async (_args, ctx) => {
			if (!activeWorkJob) {
				ctx.ui.notify("No /work job running", "warning");
				return;
			}
			sendWorkStatus(pi, formatWorkStatus(activeWorkJob));
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
			const parentSession = ctx.sessionManager.getSessionFile();

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating lean handover...");
				loader.onAbort = () => done(null);
				(async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
					if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
					const userMessage: Message = { role: "user", content: [{ type: "text", text: `Goal: ${goal}\n\nConversation:\n${conversationText}` }], timestamp: Date.now() };
					const response = await complete(ctx.model!, { systemPrompt: HANDOFF_SYSTEM, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal });
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
			await ctx.newSession({
				parentSession,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(edited);
					replacementCtx.ui.notify("Lean handover ready. Submit when ready.", "info");
				},
			});
		},
	});
}
