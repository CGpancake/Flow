import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, CONFIG_DIR_NAME, convertToLlm, createAgentSession, DefaultResourceLoader, getAgentDir, serializeConversation, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LEAN_SYSTEM = `LEAN FLOW ACTIVE. PONYTAIL MODE BAKED IN.
Permanent rules for the parent agent:
- Be lazy like a senior dev: the best code is code not written.
- YAGNI wins: delete before adding; stdlib/native/project-local before dependencies; no future-proof abstractions.
- Code is source of truth. Use rg/find/read before assuming: rg for filenames/line numbers, then read only tight offset/limit slices. Use rg for callers before bug fixes.
- Keep modules feature/function focused and readable; split by reason-to-change, not type buckets; ~500-1000 lines is a warning, not a law.
- Non-trivial modules should start with a short header: purpose, main entry points, and split trigger. When browsing, rg module headers first, then read matching files.
- No long-term memory, lifecycle docs, ADRs, or issue tracker ceremony unless the user explicitly asks.
- Bug fix = root cause, not symptom. Use rg on every caller of the function you touch.
- Non-trivial logic needs the smallest runnable check; trivial one-liners do not.
- Output caveman-terse: code/actions first, then at most three short lines.
- Use batched grill only when ambiguity changes implementation. Generate the whole question batch at once, then evaluate answers as a batch.
- For large chunks: grill -> short temporary plan -> pass the full atomic task list to lean_subagent_chain for TUI display -> worker chain -> fresh review -> human validation gate.
- Lean-flow owns subagents. Use lean_subagent_chain, not external subagent tools/workflows.
- Keep subagents lazy: worker for atomic write tasks, reviewer for read-only review. Use as many chain steps as needed; no arbitrary cap.
- Subagent chain tasks must have descriptive labels in 3 words or fewer so the TUI shows what is happening.
- If context usage reaches about 50%, prepare a /handover and stop instead of compacting by default.`;

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
	status: "queued" | "running" | "done" | "failed";
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

const AGENTS: Record<LeanTask["agent"], { tools: string; prompt: string }> = {
	worker: {
		tools: "read,bash,edit,write",
		prompt: `You are lean.worker: an atomic implementation child.

Rules:
- Be lazy like a senior dev: smallest working diff, no ceremony.
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

async function runPiChild(ctx: ExtensionContext, task: LeanTask, contextWindow: number | undefined, signal?: AbortSignal, onData?: (progress: ChildProgress) => void): Promise<{ code: number | null; output: string }> {
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
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		appendSystemPromptOverride: () => [agent.prompt],
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

export default function leanFlow(pi: ExtensionAPI) {
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
					const refresh = () => { cached = undefined; tui.requestRender(); };
					const isPrintable = (data: string) => data.length === 1 && data >= " " && data !== "\x7f";
					const commitCurrent = () => {
						selected[qIndex] = optionsFor(questions[qIndex]!)[optionIndex]!;
						if (qIndex < questions.length - 1) { qIndex++; optionIndex = 0; refresh(); return; }
						done(selected.map((s, i) => ({ selected: s || optionsFor(questions[i]!)[0]!, context: contexts[i]!.trim() })));
					};
					return {
						invalidate: () => { cached = undefined; },
						handleInput(data: string) {
							const opts = optionsFor(questions[qIndex]!);
							if (matchesKey(data, Key.up)) { optionIndex = Math.max(0, optionIndex - 1); refresh(); return; }
							if (matchesKey(data, Key.down)) { optionIndex = Math.min(opts.length - 1, optionIndex + 1); refresh(); return; }
							if (matchesKey(data, Key.left)) { qIndex = Math.max(0, qIndex - 1); optionIndex = 0; refresh(); return; }
							if (matchesKey(data, Key.right)) { qIndex = Math.min(questions.length - 1, qIndex + 1); optionIndex = 0; refresh(); return; }
							if (matchesKey(data, Key.escape)) { done(null); return; }
							if (matchesKey(data, Key.enter)) { commitCurrent(); return; }
							if (data === "\x7f" || data === "\b") { contexts[qIndex] = contexts[qIndex]!.slice(0, -1); refresh(); return; }
							if (isPrintable(data)) { contexts[qIndex] += data; refresh(); return; }
						},
						render(width: number) {
							if (cached) return cached;
							const q = questions[qIndex]!;
							const opts = optionsFor(q);
							const lines: string[] = [];
							const add = (s: string) => lines.push(truncateToWidth(s, width));
							add(theme.fg("accent", "─".repeat(width)));
							add(theme.fg("toolTitle", ` Lean Grill: ${qIndex + 1}/${questions.length}`));
							lines.push("");
							for (const line of q.question.split(/\r?\n/)) add(theme.fg("text", ` ${line}`));
							lines.push("");
							add(theme.fg("muted", ` Why: ${q.reason}`));
							lines.push("");
							opts.forEach((option, i) => {
								const prefix = i === optionIndex ? theme.fg("accent", "> ") : "  ";
								const text = i === optionIndex ? theme.fg("accent", option) : theme.fg("text", option);
								add(`${prefix}${i + 1}. ${text}`);
							});
							lines.push("");
							add(theme.fg("muted", " Notes/comment typed while choosing:"));
							add(theme.fg("text", ` ${contexts[qIndex]}${theme.fg("accent", "▌")}`));
							lines.push("");
							add(theme.fg("dim", " ↑↓ choose • type notes • Enter next/finish • ←/→ questions • Backspace edits notes • Esc cancels"));
							add(theme.fg("accent", "─".repeat(width)));
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
		description: "Run lean-flow-owned worker/reviewer child agents. Consecutive parallel=true tasks may run together.",
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
		async execute(_id, params, signal, onUpdate, ctx) {
			const inputTasks = params.tasks as LeanTask[];
			if (inputTasks.length === 0) return { content: [{ type: "text", text: "No lean subagent tasks." }] };
			const workerTasks = inputTasks.filter((task) => task.agent === "worker");
			const planSteps = leanPlanStepCount(ctx.cwd);
			if (workerTasks.length === 1 && planSteps > 1 && !looksExplicitlyNarrow(workerTasks[0]!.task)) {
				return {
					content: [{ type: "text", text: `Plan has ${planSteps} numbered implementation steps, but only one broad worker task was submitted. Split the work into atomic worker tasks, normally at least one per plan step. If this is intentionally narrow, mention the exact step or include narrow-task-ok.` }],
					isError: true,
					details: { planSteps, workerTasks: workerTasks.length },
				};
			}
			for (const task of inputTasks) {
				const words = task.label.trim().split(/\s+/).filter(Boolean);
				if (words.length > 3) {
					return { content: [{ type: "text", text: `Task label too long: "${task.label}". Use 3 words or fewer.` }], isError: true };
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
					const icon = task.status === "running" ? "⠋" : task.status === "done" ? "✓" : task.status === "failed" ? "✗" : "◦";
					const title = `${icon} ${task.label}`;
					if (task.status === "queued") return `${title} - queued`;
					return `${truncateToWidth(title, titleWidth, "…", true)}${statusRail(task)} ${task.status}`;
				}).join("\n");
			};
			const publish = () => {
				onUpdate?.({ content: [{ type: "text", text: plainSummary() }], details: details() });
			};
			const outputs: string[] = [];
			publish();
			const runTask = async (i: number): Promise<{ index: number; code: number | null; output: string }> => {
				const task = progress[i]!;
				current = i;
				task.status = "running";
				task.latest = "starting";
				task.phase = "starting";
				task.startedAt = Date.now();
				task.updatedAt = task.startedAt;
				task.output = "";
				publish();
				const result = await runPiChild(ctx, task, ctx.model?.contextWindow, signal, (childProgress) => {
					current = i;
					Object.assign(task, childProgress);
					task.updatedAt = Date.now();
					task.output = task.output?.slice(-4000);
					task.latest = task.latest?.slice(0, 160) || "working";
					publish();
				}).catch((error) => ({
					code: 1,
					output: error instanceof Error ? error.message : String(error),
				}));
				task.status = result.code === 0 ? "done" : "failed";
				task.endedAt = Date.now();
				task.updatedAt = task.endedAt;
				task.output = result.output.slice(-4000);
				task.latest = result.code === 0 ? "done" : `failed: exit ${result.code}`;
				publish();
				return { index: i, code: result.code, output: result.output };
			};
			for (let i = 0; i < progress.length;) {
				const batch: number[] = [i];
				if (progress[i]!.parallel) {
					while (i + batch.length < progress.length && progress[i + batch.length]!.parallel) batch.push(i + batch.length);
				}
				current = batch[0]!;
				const tick = setInterval(publish, 80);
				const results = await Promise.all(batch.map((index) => runTask(index))).finally(() => clearInterval(tick));
				results.sort((a, b) => a.index - b.index);
				for (const result of results) {
					const task = progress[result.index]!;
					outputs.push(`\n## ${result.index + 1}. ${task.label} (${task.agent}, exit ${result.code})\n\n${result.output}`);
				}
				if (results.some((result) => result.code !== 0)) break;
				i += batch.length;
			}
			return { content: [{ type: "text", text: "Lean chain complete." }], details: details() };
		},
		renderCall(_args, _theme, _context) {
			return new Text("", 0, 0);
		},
		renderResult(result, options, theme, _context) {
			const d = result.details as LeanChainDetails | undefined;
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
						const icon = status === "running" ? runningIcon : status === "done" ? "◆" : status === "failed" ? "✖" : "◇";
						return `${icon} ${task.label}`;
					});
					const activeRightWidth = Math.max(0, ...d.tasks.map((task, i) => {
						const status = task.status ?? d.statuses?.[i] ?? "queued";
						return status === "queued" ? 0 : visibleWidth(statusRail(task, status === "running" ? runningCtxIcon : "/")) + visibleWidth(` ${status}`);
					}));
					const titleWidth = Math.min(Math.max(...titles.map(visibleWidth)), Math.max(0, width - activeRightWidth));
					const lines: string[] = d.tasks.map((task, i) => {
						const status = task.status ?? d.statuses?.[i] ?? "queued";
						const color = status === "running" ? "accent" : status === "done" ? "success" : status === "failed" ? "error" : "borderAccent";
						const title = titles[i]!;
						if (status === "queued") return theme.fg("dim", truncateToWidth(`${title} - queued`, width, "…"));
						const railText = statusRail(task, status === "running" ? runningCtxIcon : "/");
						const stateText = ` ${status}`;
						const left = theme.fg(color, truncateToWidth(title, titleWidth, "…", true));
						return left + theme.fg(color, railText) + theme.fg(color, stateText);
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
		},
	});

	pi.registerCommand("grill", {
		description: "Start/continue batched grill clarification",
		handler: async (args) => send(pi, `Start a lean batched grill session for this goal. First scan only the relevant repo surface: rg for filenames/line numbers, then read only tight offset/limit slices. Then call grill_batch with all current implementation-blocking questions at once. After I answer, evaluate the full batch and either call grill_batch again or state shared understanding. Goal:\n${args.trim() || "Use the current conversation goal."}`),
	});

	pi.registerCommand("plan", {
		description: "Create a short temporary lean plan",
		handler: async (args) => send(pi, `Create a short lean implementation plan. Use rg for filenames/line numbers, then read only tight offset/limit slices for the code map. Ask grill_batch first if any ambiguity changes implementation. Then call save_lean_plan. No memory/docs/ADRs. Scope:\n${args.trim() || "Use the current conversation goal."}`),
	});

	pi.registerCommand("work", {
		description: "Run atomic lean worker tasks from the current plan",
		handler: async (args) => send(pi, `Execute lean work. Read .pi/lean-flow/plan.md if present. If the plan has multiple numbered implementation steps and the extra instruction is not explicitly limited to one step, create at least one worker task per step; never collapse a complicated plan into one broad worker. Do not print a separate task list; pass every needed worker task directly to lean_subagent_chain with labels of 3 words or fewer so the TUI displays them. Prefer one writer at a time; set parallel: true only for consecutive independent tasks expected not to touch the same files. Stop for human validation when automation cannot prove correctness. Do not use external subagent tools. Extra instruction:\n${args.trim() || "Implement the next approved chunk."}`),
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
