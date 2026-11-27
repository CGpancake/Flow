// Herdr glue shipped inside the lean-flow package. Purpose: show what lean
// subagents are doing in Herdr panes. Herdr's own pi integration
// (herdr-agent-state.ts) stays herdr-managed in user scope and is never touched
// by this file.
// Entry points: pi.events "lean:chain" / "lean:chain-end" (from lean-flow) and
// "ui_prompt_start" / "ui_prompt_end" (from pi core). Split only if Herdr grows
// more surfaces than pane metadata plus the blocked signal.
import net from "node:net";

const SOCKET = process.env.HERDR_SOCKET_PATH;
const ENDPOINT = process.platform === "win32" && SOCKET ? `\\\\.\\pipe\\${SOCKET}` : SOCKET;
const PANE = process.env.HERDR_PANE_ID;
const ENABLED = process.env.HERDR_ENV === "1" && !!SOCKET && !!PANE;

// Metadata is presentation-only by design: herdr:pi keeps lifecycle authority
// (idle/working/blocked + session restore). Source must not start with "herdr:".
export const SOURCE = "user:pi-lean";
const AGENT = "pi";
const APPLIES_TO = "herdr:pi";
const THROTTLE_MS = 1_000;
const TTL_MS = 15 * 60 * 1000;
const TOKEN_KEYS = ["mode", "step", "task", "agent", "done", "failed", "running", "queued"];

export type LeanTask = { label: string; status: string; agent?: string };
export type LeanDetails = { tasks?: LeanTask[]; current?: number };

export function chainMetadata(kind: "work" | "chain", details: LeanDetails) {
	const tasks = details.tasks ?? [];
	const total = tasks.length;
	const index = Math.min((details.current ?? 0) + 1, total || 1);
	const mode = kind === "work" ? "/work" : "chain";
	const task = (tasks[details.current ?? 0]?.label ?? "chain").slice(0, 40);
	const agent = tasks[details.current ?? 0]?.agent ?? "";
	const counts: Record<string, number> = { done: 0, failed: 0, running: 0, queued: 0, cancelled: 0 };
	for (const item of tasks) counts[item.status] = (counts[item.status] ?? 0) + 1;
	const step = total ? `${index}/${total}` : "";
	return {
		agent: AGENT,
		applies_to_source: APPLIES_TO,
		title: [`pi · ${mode} ${step}`.trim(), agent, task].filter(Boolean).join(" · "),
		display_agent: `pi: ${mode}${step ? ` ${step}` : ""}${agent ? ` · ${agent}` : ""}`,
		state_labels: { working: [step, agent, task].filter(Boolean).join(" ") },
		tokens: {
			mode,
			step,
			task,
			agent,
			done: String(counts.done),
			failed: String(counts.failed),
			running: String(counts.running),
			queued: String(counts.queued),
		},
		ttl_ms: TTL_MS,
	};
}

export function promptBlocked(event: { kind?: string; title?: string }) {
	return { active: true, label: event.title ? String(event.title) : `waiting: ${event.kind ?? "input"}` };
}

function send(request: unknown): void {
	if (!ENABLED) return;
	const socket = net.createConnection(ENDPOINT!);
	socket.on("error", () => socket.destroy());
	socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
	socket.on("data", () => socket.destroy());
	socket.setTimeout(1_500, () => socket.destroy());
}

export default function (pi) {
	if (!ENABLED) return;

	let seq = Date.now() * 1000;
	let lastKey = "";
	let pending: Record<string, unknown> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let sentAt = 0;

	const report = (params: Record<string, unknown>) =>
		send({
			id: `${SOURCE}:${++seq}`,
			method: "pane.report_metadata",
			params: { pane_id: PANE, source: SOURCE, seq, ...params },
		});

	const flush = () => {
		timer = undefined;
		if (!pending) return;
		const params = pending;
		pending = undefined;
		sentAt = Date.now();
		report(params);
	};

	pi.events.on("lean:chain", (data) => {
		const params = chainMetadata(data?.kind === "work" ? "work" : "chain", data?.details ?? {});
		const key = JSON.stringify(params);
		if (key === lastKey) return;
		lastKey = key;
		pending = params;
		const wait = Math.max(0, THROTTLE_MS - (Date.now() - sentAt));
		if (wait === 0) flush();
		else timer ??= setTimeout(flush, wait);
	});

	pi.events.on("lean:chain-end", () => {
		lastKey = "";
		pending = undefined;
		if (timer) clearTimeout(timer);
		timer = undefined;
		report({
			clear_title: true,
			clear_display_agent: true,
			clear_state_labels: true,
			tokens: Object.fromEntries(TOKEN_KEYS.map((key) => [key, null])),
		});
	});

	// herdr:pi already turns this event into the blocked badge and notification.
	pi.events.on("ui_prompt_start", (event) => pi.events.emit("herdr:blocked", promptBlocked(event ?? {})));
	pi.events.on("ui_prompt_end", () => pi.events.emit("herdr:blocked", { active: false }));
}
