import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";

/**
 * Clean Project Flow base extension.
 *
 * This is intentionally a new implementation. It does not reuse any previous
 * Project Flow package, vendored subagents, or private subagent RPC events.
 */

type Phase = "idle" | "planning" | "blocked" | "plan_ready" | "build_requested" | "building" | "validating" | "docs" | "complete" | "failed";

type GrillRound = {
  question: string;
  reason: string;
  recommendation: string;
  alternatives: string[];
  defaultAssumption?: string;
  answer: string;
  answeredAt: string;
  blockerId?: string;
  cycleId?: string;
  mergeWarning?: string;
};

type BlockerQueueItem = {
  id: string;
  cycleId: string;
  topic: string;
  question: string;
  status: "answered" | "superseded";
  askedAt: string;
  answeredAt?: string;
  answer?: string;
  mergeWarning?: string;
};

type GrillCycle = {
  id: string;
  status: "active" | "ready_for_resweep" | "closed";
  startedAt: string;
  updatedAt: string;
  blockerIds: string[];
};

type SessionState = {
  id: string;
  phase: Phase;
  task?: string;
  planPath?: string;
  updatedAt: string;
  notes?: string[];
  grillRounds?: GrillRound[];
  blockerQueue?: BlockerQueueItem[];
  answeredBlockers?: BlockerQueueItem[];
  currentGrillCycle?: GrillCycle;
};

const ROOT_DIR = ".pi/project-flow";
const MEMORY_DIR = `${ROOT_DIR}/memory`;
const PLANS_DIR = `${ROOT_DIR}/plans`;
const SESSIONS_DIR = `${ROOT_DIR}/sessions`;
const WIDGET_KEY = "project-flow";
const WELCOME_ART_PATH = `${ROOT_DIR}/welcome-art.md`;

const READ_ONLY_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "web_search",
  "code_search",
  "fetch_content",
  "get_search_content",
  "project_flow_context",
  "project_flow_list_modules",
  "project_flow_read_headers",
  "project_flow_read_signatures",
  "project_flow_memory_search",
  "project_flow_grill_question",
  "project_flow_grill_cycle",
  "project_flow_save_plan",
];

const EXEC_TOOLS = ["read", "bash", "edit", "write", "subagent", "project_flow_context", "project_flow_list_modules", "project_flow_read_headers", "project_flow_read_signatures", "project_flow_memory_search", "project_flow_grill_question", "project_flow_grill_cycle", "project_flow_finish"];
const WEB_TOOLS = ["web_search", "code_search", "fetch_content", "get_search_content"];
const OLD_RISK_NAMES = ["plan_save", "pf-doctor", "get_subagent_result", "steer_subagent", "Agent"];
const VALIDATION_CWD = normalizePath(process.env.PI_PROJECT_FLOW_VALIDATION_CWD || process.env.PI_PROJECT_FLOW_TEST_CWD || "");
const DEV_FLOW_ROOT = normalizePath(process.env.PI_PROJECT_FLOW_DEV_ROOT || "");
const SELF_TEST_DIR = `${ROOT_DIR}/self-test`;
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const PF_WORKER_MODEL = process.env.PI_PROJECT_FLOW_WORKER_MODEL || process.env.PI_PROJECT_FLOW_CHEAP_MODEL || "";
const PF_REVIEW_MODEL = process.env.PI_PROJECT_FLOW_REVIEW_MODEL || process.env.PI_PROJECT_FLOW_EXPENSIVE_MODEL || "";
const MAX_SAFE_CARGO_JOBS = Number(process.env.PI_PROJECT_FLOW_MAX_CARGO_JOBS || "2");

let state: SessionState = {
  id: "none",
  phase: "idle",
  updatedAt: new Date().toISOString(),
};

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "");
}

function validationCwd(ctx: ExtensionContext): string {
  return VALIDATION_CWD || normalizePath(ctx.cwd);
}

function devFlowRoot(ctx: ExtensionContext): string {
  return DEV_FLOW_ROOT || normalizePath(ctx.cwd);
}

function safeSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "project-flow-plan";
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function day(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureProjectFlow(cwd: string): void {
  for (const dir of [ROOT_DIR, MEMORY_DIR, PLANS_DIR, SESSIONS_DIR]) mkdirSync(join(cwd, dir), { recursive: true });
  const memoryIndex = join(cwd, MEMORY_DIR, "index.md");
  if (!existsSync(memoryIndex)) writeAtomic(memoryIndex, "# Project Flow Memory Index\n\n- Clean Project Flow memory.\n");
}

function writeAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

function copyTextFileAtomic(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`Source file not found: ${from}`);
  writeAtomic(to, readFileSync(from, "utf8"));
}

function updateProjectThemeSetting(cwd: string): string {
  const settingsPath = join(cwd, ".pi", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { settings = {}; }
  }
  settings.theme = "relay-concrete-dim";
  writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return settingsPath;
}

function sessionPath(cwd: string, id = state.id): string {
  return join(cwd, SESSIONS_DIR, `${id}.json`);
}

function saveState(cwd: string): void {
  if (state.id === "none") return;
  state.updatedAt = new Date().toISOString();
  ensureProjectFlow(cwd);
  writeAtomic(sessionPath(cwd), JSON.stringify(state, null, 2) + "\n");
}

function latestFile(cwd: string, relDir: string, suffix: string): string | undefined {
  const dir = join(cwd, relDir);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter(f => f.endsWith(suffix)).sort().reverse();
  return files[0] ? join(dir, files[0]) : undefined;
}

function latestSession(cwd: string): SessionState | undefined {
  const path = latestFile(cwd, SESSIONS_DIR, ".json");
  if (!path) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as SessionState; } catch { return undefined; }
}

function rel(cwd: string, path?: string): string {
  return path ? relative(cwd, path) || path : "none";
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function conciseTopic(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).slice(0, 8).join(" ") || "blocker";
}

function grillMergeWarning(question: string): string | undefined {
  const q = question.trim();
  const questionMarks = (q.match(/\?/g) || []).length;
  const bulletish = /(^|\n)\s*[-*]\s+/.test(q) || /(^|\n)\s*\d+[.)]\s+/.test(q);
  const multiAsk = /\b(and|plus|also)\b[^?]*(\bwhat\b|\bwhich\b|\bshould\b|\bwhere\b|\bhow\b)/i.test(q);
  const pairedNouns = /\b(font|color|engine|platform|runtime|path|asset|validation|scope|menu|control|input)\b[^?]{0,40}\band\b[^?]{0,40}\b(font|color|engine|platform|runtime|path|asset|validation|scope|menu|control|input)\b/i.test(q);
  if (questionMarks > 1 || bulletish || multiAsk || pairedNouns) {
    return "This question may combine independent ambiguities. Prefer one concise blocker per grill call; ask related blockers in adjacent separate calls.";
  }
  return undefined;
}

function activeGrillCycle(): GrillCycle {
  const now = new Date().toISOString();
  if (!state.currentGrillCycle || state.currentGrillCycle.status === "closed") {
    state.currentGrillCycle = { id: newId("grill-cycle"), status: "active", startedAt: now, updatedAt: now, blockerIds: [] };
  }
  return state.currentGrillCycle;
}

function recordAnsweredBlocker(question: string, answer: string, mergeWarning?: string, cycleOverride?: GrillCycle): { blockerId: string; cycleId: string } {
  const now = new Date().toISOString();
  const cycle = cycleOverride ?? activeGrillCycle();
  cycle.status = "ready_for_resweep";
  cycle.updatedAt = now;
  const item: BlockerQueueItem = {
    id: newId("blocker"),
    cycleId: cycle.id,
    topic: conciseTopic(question),
    question,
    status: "answered",
    askedAt: now,
    answeredAt: now,
    answer,
    mergeWarning,
  };
  cycle.blockerIds = [...cycle.blockerIds, item.id];
  state.currentGrillCycle = cycle;
  state.blockerQueue = [...(state.blockerQueue ?? []), item];
  state.answeredBlockers = [...(state.answeredBlockers ?? []), item];
  return { blockerId: item.id, cycleId: cycle.id };
}

function grillResolutionMissingRefs(summary: string): string[] {
  const text = summary.toLowerCase();
  return (state.grillRounds ?? []).flatMap((round, i) => {
    if (text.includes(`grill round ${i + 1}`) || text.includes(`round ${i + 1}`)) return [];
    const tokens = conciseTopic(round.question).split(/\s+/).filter(t => t.length >= 4);
    const hits = tokens.filter(t => text.includes(t)).length;
    return hits >= Math.min(2, tokens.length) ? [] : [`Grill Round ${i + 1}: ${round.question}`];
  });
}

function obviousUnresolvedLanguage(markdown: string): boolean {
  return /\b(todo:|tbd|needs user|awaiting|blocked by|open question|must ask)\b/i.test(markdown);
}

function assertInsideProject(cwd: string, path: string): void {
  const normalizedCwd = join(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = join(path).replace(/\\/g, "/");
  if (!normalizedPath.startsWith(normalizedCwd + "/") && normalizedPath !== normalizedCwd) {
    throw new Error(`Path is outside project: ${path}`);
  }
}

function walkMarkdownFiles(root: string, maxFiles = 250): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > 4 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (out.length >= maxFiles) return;
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) {
        if (["node_modules", ".git", "sessions", "plans", "self-test"].includes(name)) continue;
        visit(path, depth + 1);
      } else if (st.isFile() && [".md", ".mdx", ".ts", ".tsx", ".js", ".mjs"].includes(extname(name))) {
        out.push(path);
      }
    }
  };
  visit(root, 0);
  return out;
}

function extractHeaderBlock(body: string): string {
  const lines = body.split(/\r?\n/);
  const firstNonEmpty = lines.findIndex(l => l.trim());
  if (firstNonEmpty < 0) return "";
  if (lines[firstNonEmpty].trim() === "---") {
    const end = lines.findIndex((l, i) => i > firstNonEmpty && l.trim() === "---");
    if (end > firstNonEmpty) return lines.slice(firstNonEmpty, end + 1).join("\n");
  }
  const moduleIdx = lines.findIndex(l => /^(\/\/\s*)?MODULE:|^MODULE:/.test(l.trim()));
  if (moduleIdx >= 0) {
    const block: string[] = [];
    for (let i = moduleIdx; i < Math.min(lines.length, moduleIdx + 12); i++) {
      const line = lines[i];
      if (!line.trim() && block.length) break;
      if (/^(\/\/\s*)?(MODULE|PURPOSE|OWNS|DOES NOT OWN|USED BY|DEPS):/.test(line.trim())) block.push(line);
      else if (block.length) break;
    }
    return block.join("\n");
  }
  const heading = lines.findIndex(l => /^#\s+/.test(l));
  if (heading >= 0) return lines.slice(heading, Math.min(lines.length, heading + 8)).join("\n");
  return lines.slice(firstNonEmpty, Math.min(lines.length, firstNonEmpty + 8)).join("\n");
}

function extractSignatures(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*export\s+(async\s+)?function\s+\w+|^\s*export\s+(const|let|class|interface|type)\s+\w+/.test(line)) {
      const prev = lines[i - 1]?.trim();
      if (prev?.startsWith("//")) out.push(prev);
      out.push(line.trim().slice(0, 220));
    } else if (/^#{1,3}\s+/.test(line)) {
      out.push(line.trim());
    }
    if (out.length >= 80) break;
  }
  return out.join("\n") || extractHeaderBlock(body);
}

function toolNames(pi: ExtensionAPI): Set<string> {
  return new Set(pi.getAllTools().map(t => t.name));
}

function available(names: Set<string>, wanted: string[]): string[] {
  return wanted.filter(name => names.has(name));
}

function missing(names: Set<string>, wanted: string[]): string[] {
  return wanted.filter(name => !names.has(name));
}

function withModel(params: Record<string, unknown>, model: string): Record<string, unknown> {
  return model ? { ...params, model } : params;
}

function setTools(pi: ExtensionAPI, wanted: string[]): void {
  const names = toolNames(pi);
  pi.setActiveTools(wanted.filter(t => names.has(t)));
}

function isSafeReadOnlyBash(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  const dangerous = /(^|[;&|`$()\n])\s*(rm|mv|cp|write|touch|mkdir|rmdir|del|erase|copy|move|ren|rename|powershell|pwsh|python|node|npm|pnpm|yarn|git\s+(add|commit|checkout|reset|clean|rm|mv)|chmod|chown|truncate|tee|cat\s*>|echo\s+.*>|sed\s+-i)\b|>|>>|\b--output\b|\b-o\s+\S/i;
  if (dangerous.test(trimmed)) return false;
  return /^(pwd|ls|dir|find|rg|grep|git\s+(status|diff|log|show|rev-parse|ls-files)|wc|head|tail|sort|uniq|which|where|type)\b/i.test(trimmed);
}

function cargoSafetyReason(command: string): string | undefined {
  const trimmed = command.trim();
  if (!/\bcargo\s+(build|check|clippy|test|run|install|bench)\b/i.test(trimmed)) return undefined;
  if (/\bcargo\s+run\b/i.test(trimmed) && !/\bPI_PROJECT_FLOW_ALLOW_CARGO_RUN=1\b/i.test(trimmed)) {
    return "Project Flow will not auto-run graphical/interactive Cargo apps. Use cargo check -j 2 for automated validation, or explicitly rerun with PI_PROJECT_FLOW_ALLOW_CARGO_RUN=1 after user approval.";
  }
  const envJobs = trimmed.match(/\bCARGO_BUILD_JOBS\s*=\s*["']?(\d+)/i)?.[1];
  const flagJobs = trimmed.match(/(?:^|\s)(?:-j|--jobs)(?:\s+|=)(\d+)\b/i)?.[1];
  const jobs = Number(flagJobs || envJobs || "0");
  if (!jobs) return `Project Flow Cargo safety requires an explicit job limit for heavy Cargo commands, e.g. cargo check -j ${MAX_SAFE_CARGO_JOBS}.`;
  if (jobs > MAX_SAFE_CARGO_JOBS) return `Project Flow Cargo safety limits heavy Cargo commands to -j ${MAX_SAFE_CARGO_JOBS} or lower; requested ${jobs}.`;
  return undefined;
}

function renderWelcomeHeader(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const artPath = join(ctx.cwd, WELCOME_ART_PATH);
  if (!existsSync(artPath)) return;
  const raw = readFileSync(artPath, "utf8").trim();
  const lines = raw
    .replace(/^```[\w-]*\r?\n/, "")
    .replace(/\r?\n```$/, "")
    .split(/\r?\n/);

  ctx.ui.setHeader((_tui, theme) => ({
    invalidate() {},
    render(width: number) {
      return [
        "",
        ...lines.map(line => theme.fg("dim", truncateToWidth(line, width))),
        "",
      ];
    },
  }));
}

function renderWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
    invalidate() {},
    render(width: number) {
      const plan = state.planPath ? rel(ctx.cwd, state.planPath) : "none";
      const phase = state.phase.toUpperCase();
      const border = "-".repeat(Math.max(12, Math.min(width, 72)));
      const lines = [
        theme.fg("borderMuted", border),
        `${theme.fg("accent", "PI")} ${theme.fg("toolTitle", "Project Flow")} ${theme.fg("dim", "//")} ${theme.fg("success", phase)}`,
        `${theme.fg("muted", "session")} ${theme.fg("text", state.id)}  ${theme.fg("muted", "plan")} ${theme.fg("text", plan)}`,
        theme.fg("borderMuted", border),
      ];
      return lines.map(line => truncateToWidth(line, width));
    },
  }));
  ctx.ui.setStatus(WIDGET_KEY, ctx.ui.theme.fg("accent", `PI PF ${state.phase}`));
}


function queueUserMessage(pi: ExtensionAPI, message: string): void {
  // pi v0.78 docs use deliverAs; the runtime error mentions streamingBehavior.
  // Pass both defensively while this base is being validated.
  (pi.sendUserMessage as any)(message, { deliverAs: "followUp", streamingBehavior: "followUp" });
}

type AgentBridgeResult = { ok: true; response: any; requestId: string } | { ok: false; error: string; requestId: string };

async function requestSubagentBridge(pi: ExtensionAPI, params: Record<string, unknown>, timeoutMs = 15000): Promise<AgentBridgeResult> {
  const events = (pi as any).events;
  if (!events?.on || !events?.emit) return { ok: false, error: "Pi event bus unavailable", requestId: "unavailable" };

  return await new Promise(resolve => {
    const requestId = `project-flow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let done = false;
    let cleanupResponse: (() => void) | undefined;
    let cleanupStarted: (() => void) | undefined;
    const finish = (result: AgentBridgeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      cleanupResponse?.();
      cleanupStarted?.();
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, error: `pi-subagents slash bridge timed out after ${timeoutMs}ms`, requestId }), timeoutMs);
    cleanupResponse = events.on(SLASH_SUBAGENT_RESPONSE_EVENT, (reply: any) => {
      if (reply?.requestId !== requestId) return;
      if (reply?.isError) finish({ ok: false, error: reply.errorText || reply.result?.content?.[0]?.text || "subagent request failed", requestId });
      else finish({ ok: true, response: reply, requestId });
    });
    cleanupStarted = events.on(SLASH_SUBAGENT_STARTED_EVENT, (reply: any) => {
      if (reply?.requestId === requestId) timeout.refresh?.();
    });
    events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params });
  });
}

function clearWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget(WIDGET_KEY, undefined);
  ctx.ui.setStatus(WIDGET_KEY, undefined);
}
function stopPostPlanProcess(ctx: ExtensionContext, planPath: string, reason: string): void {
  state.phase = "plan_ready";
  state.planPath = planPath;
  state.notes = [...(state.notes ?? []), `${reason}; no build started.`];
  saveState(ctx.cwd);
  clearWidget(ctx);
  ctx.ui.notify(`Project Flow stopped; no build started. Run /plan-continue to resume ${rel(ctx.cwd, planPath)}.`, "info");
}

function agentFailureReport(ctx: ExtensionContext, planPath: string, error: string, requestId?: string): string {
  return [
    "# AgentAdapter Build Blocked",
    "",
    `Plan: ${rel(ctx.cwd, planPath)}`,
    `Session: ${state.id}`,
    `Phase when blocked: ${state.phase}`,
    requestId ? `Request id: ${requestId}` : undefined,
    "",
    "## Error",
    "",
    error,
    "",
    "## Recovery",
    "",
    "No parent build was started automatically.",
    "",
    "Safe next steps:",
    "",
    "1. Inspect repo state if needed.",
    "2. Run `/plan-continue` to return to the saved plan.",
    "3. Choose `Build now in this session` or `Build in fresh subagent worker` only after explicit approval.",
  ].filter(Boolean).join("\n");
}


function doctorReport(pi: ExtensionAPI, ctx: ExtensionContext): string {
  ensureProjectFlow(ctx.cwd);
  const names = toolNames(pi);
  const commands = pi.getCommands?.() ?? [];
  const commandNames = new Set(commands.map(c => c.name));
  const oldToolRisks = OLD_RISK_NAMES.filter(n => names.has(n));
  const oldCommandRisks = ["plan_save", "memory-save"].filter(n => commandNames.has(n));
  const webPresent = available(names, WEB_TOOLS);
  const webMissing = missing(names, WEB_TOOLS);
  const subagentPresent = names.has("subagent");
  const latestPlanPath = latestFile(ctx.cwd, PLANS_DIR, ".md");
  const loadedSession = latestSession(ctx.cwd);

  return [
    "# Project Flow Doctor",
    "",
    "## Paths",
    `- cwd: ${ctx.cwd}`,
    `- root: ${ROOT_DIR}`,
    `- memory: ${MEMORY_DIR}`,
    `- plans: ${PLANS_DIR}`,
    `- sessions: ${SESSIONS_DIR}`,
    "",
    "## Lifecycle",
    `- current phase: ${state.phase}`,
    `- current session: ${state.id}`,
    `- latest saved session: ${loadedSession?.id ?? "none"}`,
    `- latest plan: ${rel(ctx.cwd, latestPlanPath)}`,
    "",
    "## ResearchAdapter / pi-web-access",
    `- status: ${webPresent.length ? "available" : "unavailable"}`,
    `- present: ${webPresent.join(", ") || "none"}`,
    `- missing: ${webMissing.join(", ") || "none"}`,
    "",
    "## AgentAdapter / pi-subagents",
    `- subagent tool: ${subagentPresent ? "available" : "unavailable"}`,
    `- fresh/fork worker support: ${subagentPresent ? "expected via subagent tool; validate with /subagents-doctor" : "unavailable"}`,
    "",
    "## Duplicate/old package risk",
    `- old tool names detected: ${oldToolRisks.join(", ") || "none"}`,
    `- old command names detected: ${oldCommandRisks.join(", ") || "none"}`,
    "",
    "## Active tools",
    `- ${pi.getActiveTools().map(t => t.name).join(", ") || "none"}`,
  ].join("\n");
}

function memoryContext(cwd: string): string {
  const index = join(cwd, MEMORY_DIR, "index.md");
  if (!existsSync(index)) return "No memory index yet.";
  return [
    `## ${relative(cwd, index)}`,
    readFileSync(index, "utf8").slice(0, 2500),
    "",
    "Lazy memory files are available on demand:",
    `- ${MEMORY_DIR}/decisions.md`,
    `- ${MEMORY_DIR}/learnings.md`,
    `- ${MEMORY_DIR}/validation.md`,
  ].join("\n");
}

function sessionNotesContext(cwd: string, maxChars = 9000): string {
  const notes = state.notes ?? [];
  const grillRounds = state.grillRounds ?? [];
  const blocks: string[] = [];
  if (notes.length) {
    blocks.push("## Session Notes", ...notes.map((note, i) => `### Note ${i + 1}\n${note}`));
  }
  if (state.currentGrillCycle || state.blockerQueue?.length) {
    const cycle = state.currentGrillCycle;
    blocks.push([
      "## Grill Queue State",
      cycle ? `Current cycle: ${cycle.id} (${cycle.status})` : "Current cycle: none",
      `Answered blockers: ${(state.answeredBlockers ?? []).length}`,
      ...(state.blockerQueue ?? []).slice(-12).map((item, i) => `${i + 1}. [${item.status}] ${item.topic} — ${item.question}${item.mergeWarning ? ` (${item.mergeWarning})` : ""}`),
    ].join("\n"));
  }
  if (grillRounds.length) {
    blocks.push("## Grill Rounds Answered");
    grillRounds.forEach((round, i) => {
      blocks.push([
        `### Grill Round ${i + 1}`,
        `Question: ${round.question}`,
        `Reason: ${round.reason}`,
        `Recommendation: ${round.recommendation}`,
        round.alternatives.length ? `Alternatives: ${round.alternatives.join(" | ")}` : undefined,
        round.defaultAssumption ? `Default assumption: ${round.defaultAssumption}` : undefined,
        round.answer,
      ].filter(Boolean).join("\n"));
    });
  }
  const latestPlanPath = state.planPath;
  if (latestPlanPath && existsSync(latestPlanPath)) {
    blocks.push(`## Current Saved Plan (${rel(cwd, latestPlanPath)})\n${readFileSync(latestPlanPath, "utf8").slice(0, 6000)}`);
  }
  return (blocks.join("\n\n") || "No session notes yet.").slice(0, maxChars);
}

function projectFlowPlanningRules(): string {
  return [
    "Rules:",
    "- Before creating any module/tool/function/system, follow the Codebase Reading Protocol: project_flow_list_modules, then project_flow_read_headers for relevant files, then project_flow_read_signatures, and only then full read if still needed.",
    "- Inspect shallow-first with read-only tools.",
    "- Use project_flow_memory_search for long-term memory lookups instead of loading large memory/log files.",
    "- Use pi-web-access tools only if research materially improves the plan.",
    "- Before the first grill question, sketch the potential plan privately and sweep it for all build-readiness blockers you can identify. Form a blocker queue, but ask only the first unresolved blocker.",
    "- Ask concise blocking questions through project_flow_grill_cycle when multiple current-cycle blockers are known, or project_flow_grill_question when only one blocker is known. Do not merge independent ambiguities into one question; queue them as separate question objects. Each grill question must include a single recommended answer, alternatives, a default assumption, and room for additional user context.",
    "- Grill loop requirement: precompute the current grill-cycle queue where possible so the UI can advance responsively from one concise question to the next. Keep related blockers adjacent before farther-apart topics. After the cycle is answered, plug collected answers back into the potential plan, revise blocker status, and re-sweep for blockers introduced or removed by the answers. If new blockers appear, start another grill cycle. Only then save the final plan.",
    "- When calling project_flow_save_plan, include blockerAnalysisSummary describing the blocker sweep/queue and final status. After any grill round, also include grillResolutionSummary explaining how each grill answer was incorporated. If a plan is still blocked, explain why the answered questions did not unblock it and list only genuinely unresolved questions.",
    "- Use the Grill rules: inspect relevant docs/context first, prefer reversible default assumptions, and ask only for product intent, irreversible tradeoffs, destructive actions, or locally impossible validation.",
    "- Treat these as blocking for build-ready plans: choosing a major framework/engine not named by the user, creating a new project/crate at repo root, destructive restructuring, unclear target platform/runtime, unclear acceptance criteria for game feel, or validation that cannot be run locally.",
    "- For ambiguous prompts, use project_flow_context and/or project_flow_memory_search only for relevant lazy context before asking; do not load heavy docs by default.",
    "- If web/current docs would materially affect dependency/framework choice or API correctness, use pi-web-access before saving a build-ready plan.",
    "- Do not hide major assumptions in a build-ready plan. If blocking questions remain after the full blocker sweep and grill loop, call project_flow_save_plan with status blocked or draft, unresolvedQuestions, blockerAnalysisSummary, and grillResolutionSummary if any grill rounds occurred; build choices will be withheld.",
    "- If enough information exists, produce a GSD-style plan with milestones, slices, owned files, decisions, risks, and validation.",
    `- For Rust/Cargo plans, include Cargo safety in validation: heavy Cargo commands must use an explicit job limit of -j ${MAX_SAFE_CARGO_JOBS} or lower, prefer cargo fmt --check and cargo check -j ${MAX_SAFE_CARGO_JOBS}, and mark cargo run for graphical/interactive apps as manual unless explicitly approved.`,
    "- Save the plan by calling project_flow_save_plan.",
    "- Do not start implementation until the post-plan choice explicitly approves build.",
  ].join("\n");
}

function planningPrompt(task: string, context: string): string {
  return `[PROJECT FLOW: PLAN]\nTask: ${task}\n\nYou are planning only. Do not edit files. Project Flow core owns lifecycle and build approval.\n\n${projectFlowPlanningRules()}\n\n<project-flow-memory>\n${context || "No memory yet."}\n</project-flow-memory>`;
}

function continuePrompt(cwd: string, latestPlanPath?: string): string {
  return `[PROJECT FLOW: CONTINUE]
Session: ${state.id}
Phase: ${state.phase}
Task: ${state.task || "unknown"}
Plan: ${rel(cwd, latestPlanPath)}

Resume the Project Flow lifecycle from this state. Session notes, grill answers, deterministic grill queue state, and the current saved plan are included below. If phase is blocked, do not merely repeat the old blocked plan: reconsider the captured grill answers and any new user context, revise the potential plan, re-sweep for all build-readiness blockers, then use project_flow_grill_cycle for multiple current-cycle blockers or project_flow_grill_question for one blocker, or save a final plan with project_flow_save_plan. Keep independent ambiguities in separate queued calls and ask related blockers before farther-apart topics. project_flow_save_plan must include blockerAnalysisSummary, and after any grill round it must also include grillResolutionSummary. If building/validating and evidence is complete, call project_flow_finish. Do not substitute a different/latest plan unless the user explicitly selects it.

<project-flow-session-context>
${sessionNotesContext(cwd)}
</project-flow-session-context>`;
}

async function chooseAfterPlan(pi: ExtensionAPI, ctx: ExtensionContext, planPath: string): Promise<void> {
  state.phase = "plan_ready";
  state.planPath = planPath;
  saveState(ctx.cwd);
  renderWidget(ctx);

  const planBody = existsSync(planPath) ? readFileSync(planPath, "utf8") : "Plan file not found.";
  pi.sendMessage({
    customType: "project-flow-plan-review",
    content: `# Project Flow Plan Review\n\nPlan file: ${rel(ctx.cwd, planPath)}\n\n${planBody.slice(0, 30000)}${planBody.length > 30000 ? "\n\n[Plan truncated in review message; open the file for full content.]" : ""}`,
    display: true,
  }, { triggerTurn: false });

  const choice = await ctx.ui.select("Project Flow: choose next step", [
    "Build now in this session",
    "Compact handoff / build after compact",
    "Build in fresh subagent worker",
    "Stop process / no build",
  ]);

  if (!choice || choice === "Stop process / no build") {
    stopPostPlanProcess(ctx, planPath, choice ? "Post-plan process stopped by user" : "Post-plan selection closed");
    return;
  }

  if (choice === "Build now in this session") {
    state.phase = "building";
    saveState(ctx.cwd);
    renderWidget(ctx);
    setTools(pi, EXEC_TOOLS);
    queueUserMessage(pi, `[PROJECT FLOW: BUILD APPROVED]\nPlan file: ${rel(ctx.cwd, planPath)}\n\nBuild from the saved plan. Keep scope tight. Use edits only for plan-approved changes. Run relevant validation and report changed files, results, blockers, and follow-ups. Cargo safety: heavy Cargo commands must include an explicit job limit of -j ${MAX_SAFE_CARGO_JOBS} or lower; prefer cargo fmt --check and cargo check -j ${MAX_SAFE_CARGO_JOBS}. Do not run cargo run for graphical/interactive apps unless the user explicitly approves that exact step; report it as manual validation instead. When validation evidence is known, call project_flow_finish with status complete or failed.`);
    return;
  }

  if (choice === "Compact handoff / build after compact") {
    state.phase = "plan_ready";
    state.notes = [...(state.notes ?? []), "Compact handoff requested before build."];
    saveState(ctx.cwd);
    renderWidget(ctx);
    setTools(pi, READ_ONLY_TOOLS);
    pi.sendMessage({ customType: "project-flow-compact-handoff", content: `# Project Flow Compact Handoff\n\nPlan ready: ${rel(ctx.cwd, planPath)}\n\nRecommended next steps:\n\n1. Run /compact.\n2. Run /plan-continue.\n3. Approve Build now in this session or Build in fresh subagent worker.\n\nNo build has started.`, display: true }, { triggerTurn: false });
    ctx.ui.notify("Project Flow compact handoff prepared; no build started.", "info");
    return;
  }

  if (choice === "Build in fresh subagent worker") {
    state.phase = "build_requested";
    saveState(ctx.cwd);
    renderWidget(ctx);
    setTools(pi, ["read", "bash", "subagent", "project_flow_finish", "project_flow_context", "project_flow_list_modules", "project_flow_read_headers", "project_flow_read_signatures", "project_flow_memory_search"]);

    const bridge = await requestSubagentBridge(pi, withModel({
      agent: "worker",
      task: `[PROJECT FLOW: SUBAGENT BUILD]\nPlan file: ${rel(ctx.cwd, planPath)}\n\nRead the written plan and implement only plan-approved changes. Keep scope tight. Validate and return changed files, validation evidence, blockers, and follow-ups. Cargo safety: heavy Cargo commands must include an explicit job limit of -j ${MAX_SAFE_CARGO_JOBS} or lower; prefer cargo fmt --check and cargo check -j ${MAX_SAFE_CARGO_JOBS}. Do not run cargo run for graphical/interactive apps unless the user explicitly approves that exact step; report it as manual validation instead. Do not mutate Project Flow lifecycle state directly; return evidence for the parent Project Flow core to record. Use only tools/skills needed for this plan; do not inherit or assume parent-only context.`, 
      reads: [rel(ctx.cwd, planPath)],
      skill: false,
      context: "fresh",
      async: true,
      agentScope: "both",
    }, PF_WORKER_MODEL));

    if (!bridge.ok) {
      state.phase = "blocked";
      state.notes = [...(state.notes ?? []), `AgentAdapter blocked fresh-worker build: ${bridge.error}`];
      saveState(ctx.cwd);
      renderWidget(ctx);
      ctx.ui.notify(`AgentAdapter blocked build: ${bridge.error}`, "error");
      pi.sendMessage({ customType: "project-flow-agent-blocked", content: agentFailureReport(ctx, planPath, bridge.error, bridge.requestId), display: true }, { triggerTurn: false });
      return;
    }

    state.phase = "building";
    saveState(ctx.cwd);
    renderWidget(ctx);
    const text = bridge.response?.result?.content?.find?.((c: any) => c.type === "text")?.text ?? "Subagent worker started.";
    ctx.ui.notify("Project Flow worker started via AgentAdapter.", "info");
    pi.sendMessage({ customType: "project-flow-agent-started", content: `# Project Flow Worker Started\n\n${text}`, display: true }, { triggerTurn: false });
  }
}

export default function projectFlow(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "project_flow_list_modules",
    label: "Project Flow List Modules",
    description: "Shallow-first codebase reading protocol: list known module/spec files before planning or creating anything new.",
    parameters: Type.Object({
      root: Type.Optional(Type.String({ description: "Relative root to scan. Defaults to unified-project-flow, then .pi/project-flow/memory." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const roots = params.root ? [join(ctx.cwd, params.root)] : [join(ctx.cwd, "docs"), join(ctx.cwd, "unified-project-flow"), join(ctx.cwd, ROOT_DIR, "memory")];
      const files = roots.flatMap(root => walkMarkdownFiles(root, 200)).filter(path => existsSync(path));
      const lines = files.map(path => `- ${relative(ctx.cwd, path)}`);
      return { content: [{ type: "text", text: `# Project Flow Modules\n\n${lines.join("\n") || "No modules found."}` }], details: { count: files.length } };
    },
  });

  pi.registerTool({
    name: "project_flow_read_headers",
    label: "Project Flow Read Headers",
    description: "Read only module/header blocks for selected files. Use before signatures/full reads.",
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Project-relative file paths" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sections: string[] = [];
      for (const p of params.paths.slice(0, 20)) {
        const path = join(ctx.cwd, p);
        assertInsideProject(ctx.cwd, path);
        if (!existsSync(path)) { sections.push(`## ${p}\n\nNot found.`); continue; }
        sections.push(`## ${p}\n\n${extractHeaderBlock(readFileSync(path, "utf8"))}`);
      }
      return { content: [{ type: "text", text: `# Project Flow Headers\n\n${sections.join("\n\n")}` }], details: { count: sections.length } };
    },
  });

  pi.registerTool({
    name: "project_flow_read_signatures",
    label: "Project Flow Read Signatures",
    description: "Read exported function/type signatures or markdown headings for selected files. Use before full file reads.",
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Project-relative file paths" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sections: string[] = [];
      for (const p of params.paths.slice(0, 12)) {
        const path = join(ctx.cwd, p);
        assertInsideProject(ctx.cwd, path);
        if (!existsSync(path)) { sections.push(`## ${p}\n\nNot found.`); continue; }
        sections.push(`## ${p}\n\n${extractSignatures(readFileSync(path, "utf8"))}`);
      }
      return { content: [{ type: "text", text: `# Project Flow Signatures\n\n${sections.join("\n\n")}` }], details: { count: sections.length } };
    },
  });

  pi.registerTool({
    name: "project_flow_memory_search",
    label: "Project Flow Memory Search",
    description: "Search long-term Project Flow memory/log files on demand without loading them fully.",
    parameters: Type.Object({
      query: Type.String({ description: "Case-insensitive text or regex-like literal to search for" }),
      target: Type.Optional(Type.String({ description: "memory, logs, or all. Defaults to all." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureProjectFlow(ctx.cwd);
      const target = params.target || "all";
      const roots = target === "memory" ? [join(ctx.cwd, MEMORY_DIR)] : target === "logs" ? [join(ctx.cwd, ROOT_DIR)] : [join(ctx.cwd, MEMORY_DIR), join(ctx.cwd, ROOT_DIR)];
      const needle = params.query.toLowerCase();
      const matches: string[] = [];
      for (const file of roots.flatMap(root => walkMarkdownFiles(root, 300))) {
        const relPath = relative(ctx.cwd, file);
        if (relPath.includes(`${ROOT_DIR}\\sessions`) || relPath.includes(`${ROOT_DIR}/sessions`)) continue;
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (line.toLowerCase().includes(needle) && matches.length < 80) matches.push(`${relPath}:${idx + 1}: ${line.slice(0, 240)}`);
        });
      }
      return { content: [{ type: "text", text: `# Project Flow Memory Search: ${params.query}\n\n${matches.join("\n") || "No matches."}` }], details: { count: matches.length, target } };
    },
  });

  pi.registerTool({
    name: "project_flow_grill_question",
    label: "Project Flow Grill Question",
    description: "Ask one concise blocking planning question for one ambiguity, with a single recommendation, selectable alternatives, default assumption, and optional additional user context. Use before saving blocked/build-ready plans when ambiguity blocks mutual understanding; ask independent ambiguities in separate queued calls.",
    parameters: Type.Object({
      question: Type.String({ description: "One concise blocking question for one ambiguity" }),
      reason: Type.String({ description: "Why this blocks a build-ready plan" }),
      recommendation: Type.String({ description: "Single recommended answer" }),
      alternatives: Type.Optional(Type.Array(Type.String({ description: "Alternative answers" }))),
      defaultAssumption: Type.Optional(Type.String({ description: "Assumption if user declines to answer" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureProjectFlow(ctx.cwd);
      const alternatives = params.alternatives ?? [];
      const mergeWarning = grillMergeWarning(params.question);
      const options = [
        `Recommended: ${params.recommendation}`,
        ...alternatives.map((a: string, i: number) => `Alternative ${i + 1}: ${a}`),
        `Use default assumption: ${params.defaultAssumption || params.recommendation}`,
        "None of these / I will describe what I want",
      ];
      const result = await ctx.ui.custom<{ selected: string; context: string } | null>((tui, theme, _kb, done) => {
        let index = 0;
        let contextText = "";
        let cached: string[] | undefined;
        const refresh = () => { cached = undefined; tui.requestRender(); };
        const isPrintable = (data: string) => data.length === 1 && data >= " " && data !== "\x7f";
        return {
          invalidate: () => { cached = undefined; },
          handleInput(data: string) {
            if (matchesKey(data, Key.up)) { index = Math.max(0, index - 1); refresh(); return; }
            if (matchesKey(data, Key.down)) { index = Math.min(options.length - 1, index + 1); refresh(); return; }
            if (matchesKey(data, Key.escape)) { done(null); return; }
            if (matchesKey(data, Key.enter)) { done({ selected: options[index], context: contextText.trim() }); return; }
            if (data === "\x7f" || data === "\b") { contextText = contextText.slice(0, -1); refresh(); return; }
            if (isPrintable(data)) { contextText += data; refresh(); return; }
          },
          render(width: number) {
            if (cached) return cached;
            const lines: string[] = [];
            const add = (s: string) => lines.push(truncateToWidth(s, width));
            add(theme.fg("accent", "─".repeat(width)));
            add(theme.fg("toolTitle", " Project Flow Grill: one concise blocker"));
            lines.push("");
            for (const line of params.question.split(/\r?\n/)) add(theme.fg("text", ` ${line}`));
            if (mergeWarning) {
              lines.push("");
              add(theme.fg("warning", ` ${mergeWarning}`));
            }
            lines.push("");
            add(theme.fg("muted", ` Why this blocks: ${params.reason}`));
            lines.push("");
            options.forEach((option, i) => {
              const prefix = i === index ? theme.fg("accent", "> ") : "  ";
              const text = i === index ? theme.fg("accent", option) : theme.fg("text", option);
              add(`${prefix}${i + 1}. ${text}`);
            });
            lines.push("");
            add(theme.fg("muted", " Additional context typed while choosing:"));
            add(theme.fg("text", ` ${contextText}${theme.fg("accent", "▌")}`));
            lines.push("");
            add(theme.fg("dim", " ↑↓ choose • type to append context • Backspace edits context • Enter commits selected option + context • Esc cancels"));
            add(theme.fg("accent", "─".repeat(width)));
            cached = lines;
            return lines;
          },
        };
      });
      const selectedAnswer = result?.selected || `Use default assumption: ${params.defaultAssumption || params.recommendation}`;
      const finalAnswer = [`Selected answer: ${selectedAnswer}`, result?.context ? `Additional context: ${result.context}` : "Additional context: none"].join("\n");
      const blockerRef = recordAnsweredBlocker(params.question, finalAnswer, mergeWarning);
      const round: GrillRound = {
        question: params.question,
        reason: params.reason,
        recommendation: params.recommendation,
        alternatives,
        defaultAssumption: params.defaultAssumption,
        answer: finalAnswer,
        answeredAt: new Date().toISOString(),
        blockerId: blockerRef.blockerId,
        cycleId: blockerRef.cycleId,
        mergeWarning,
      };
      state.grillRounds = [...(state.grillRounds ?? []), round];
      state.notes = [...(state.notes ?? []), `Grill answered: ${params.question}\n${finalAnswer}${mergeWarning ? `\nMerge warning: ${mergeWarning}` : ""}`];
      saveState(ctx.cwd);
      return {
        content: [{ type: "text", text: `Project Flow grill answer captured. Update the working blocker queue with this answer. If another queued blocker remains, especially a related nearby ambiguity, ask the next concise project_flow_grill_question in a separate call. When the current grill cycle is cleared, revise the potential plan with the collected answers, re-sweep for new blockers, then either start another grill cycle or call project_flow_save_plan. When saving, include grillResolutionSummary explaining how every grill answer changed or confirmed the final plan; if the plan is still blocked, explain why the answered question remains blocked.${mergeWarning ? `\n\nSoft guard: ${mergeWarning}` : ""}\n\n${finalAnswer}` }],
        details: { question: params.question, answer: finalAnswer, grillRoundCount: state.grillRounds.length, blockerId: blockerRef.blockerId, cycleId: blockerRef.cycleId, mergeWarning },
      };
    },
  });

  pi.registerTool({
    name: "project_flow_grill_cycle",
    label: "Project Flow Grill Cycle",
    description: "Ask a precomputed sequence of concise blocking planning questions in one responsive UI cycle. Use after a blocker sweep when multiple current-cycle ambiguities are known; independent ambiguities stay as separate queued questions.",
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        question: Type.String({ description: "One concise blocking question for one ambiguity" }),
        reason: Type.String({ description: "Why this blocks a build-ready plan" }),
        recommendation: Type.String({ description: "Single recommended answer" }),
        alternatives: Type.Optional(Type.Array(Type.String({ description: "Alternative answers" }))),
        defaultAssumption: Type.Optional(Type.String({ description: "Assumption if user declines to answer" })),
      }), { description: "Current grill-cycle queue, ordered with related blockers adjacent" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureProjectFlow(ctx.cwd);
      const queued = params.questions.slice(0, 12);
      if (!queued.length) {
        return { content: [{ type: "text", text: "Project Flow grill cycle was not started: no questions were provided." }], isError: true, details: { reason: "empty_grill_cycle" } };
      }
      const cycle = activeGrillCycle();
      cycle.status = "active";
      cycle.updatedAt = new Date().toISOString();
      state.currentGrillCycle = cycle;
      const warnings = queued.map((q: any) => grillMergeWarning(q.question));
      const answers = await ctx.ui.custom<Array<{ selected: string; context: string }> | null>((tui, theme, _kb, done) => {
        let qIndex = 0;
        let optionIndex = 0;
        const contexts = queued.map(() => "");
        const selected = queued.map(() => "");
        let cached: string[] | undefined;
        const optionsFor = (q: any) => [
          `Recommended: ${q.recommendation}`,
          ...(q.alternatives ?? []).map((a: string, i: number) => `Alternative ${i + 1}: ${a}`),
          `Use default assumption: ${q.defaultAssumption || q.recommendation}`,
          "None of these / I will describe what I want",
        ];
        const refresh = () => { cached = undefined; tui.requestRender(); };
        const isPrintable = (data: string) => data.length === 1 && data >= " " && data !== "\x7f";
        const commitCurrent = () => {
          const opts = optionsFor(queued[qIndex]);
          selected[qIndex] = opts[optionIndex];
          if (qIndex < queued.length - 1) { qIndex++; optionIndex = 0; refresh(); return; }
          done(selected.map((s, i) => ({ selected: s || optionsFor(queued[i])[0], context: contexts[i].trim() })));
        };
        return {
          invalidate: () => { cached = undefined; },
          handleInput(data: string) {
            const opts = optionsFor(queued[qIndex]);
            if (matchesKey(data, Key.up)) { optionIndex = Math.max(0, optionIndex - 1); refresh(); return; }
            if (matchesKey(data, Key.down)) { optionIndex = Math.min(opts.length - 1, optionIndex + 1); refresh(); return; }
            if (matchesKey(data, Key.left)) { qIndex = Math.max(0, qIndex - 1); optionIndex = 0; refresh(); return; }
            if (matchesKey(data, Key.escape)) { done(null); return; }
            if (matchesKey(data, Key.enter)) { commitCurrent(); return; }
            if (data === "\x7f" || data === "\b") { contexts[qIndex] = contexts[qIndex].slice(0, -1); refresh(); return; }
            if (isPrintable(data)) { contexts[qIndex] += data; refresh(); return; }
          },
          render(width: number) {
            if (cached) return cached;
            const q = queued[qIndex];
            const opts = optionsFor(q);
            const lines: string[] = [];
            const add = (s: string) => lines.push(truncateToWidth(s, width));
            add(theme.fg("accent", "─".repeat(width)));
            add(theme.fg("toolTitle", ` Project Flow Grill Cycle: ${qIndex + 1}/${queued.length}`));
            lines.push("");
            for (const line of q.question.split(/\r?\n/)) add(theme.fg("text", ` ${line}`));
            if (warnings[qIndex]) { lines.push(""); add(theme.fg("warning", ` ${warnings[qIndex]}`)); }
            lines.push("");
            add(theme.fg("muted", ` Why this blocks: ${q.reason}`));
            lines.push("");
            opts.forEach((option, i) => {
              const prefix = i === optionIndex ? theme.fg("accent", "> ") : "  ";
              const text = i === optionIndex ? theme.fg("accent", option) : theme.fg("text", option);
              add(`${prefix}${i + 1}. ${text}`);
            });
            lines.push("");
            add(theme.fg("muted", " Additional context typed while choosing:"));
            add(theme.fg("text", ` ${contexts[qIndex]}${theme.fg("accent", "▌")}`));
            lines.push("");
            add(theme.fg("dim", " ↑↓ choose • type context • Enter next/finish • ← previous • Esc cancels"));
            add(theme.fg("accent", "─".repeat(width)));
            cached = lines;
            return lines;
          },
        };
      });
      const finalAnswers = queued.map((q: any, i: number) => {
        const selectedAnswer = answers?.[i]?.selected || `Use default assumption: ${q.defaultAssumption || q.recommendation}`;
        return [`Selected answer: ${selectedAnswer}`, answers?.[i]?.context ? `Additional context: ${answers[i].context}` : "Additional context: none"].join("\n");
      });
      const roundSummaries: string[] = [];
      queued.forEach((q: any, i: number) => {
        const warning = warnings[i];
        const blockerRef = recordAnsweredBlocker(q.question, finalAnswers[i], warning, cycle);
        const alternatives = q.alternatives ?? [];
        const round: GrillRound = {
          question: q.question,
          reason: q.reason,
          recommendation: q.recommendation,
          alternatives,
          defaultAssumption: q.defaultAssumption,
          answer: finalAnswers[i],
          answeredAt: new Date().toISOString(),
          blockerId: blockerRef.blockerId,
          cycleId: blockerRef.cycleId,
          mergeWarning: warning,
        };
        state.grillRounds = [...(state.grillRounds ?? []), round];
        roundSummaries.push(`Question ${i + 1}: ${q.question}\n${finalAnswers[i]}${warning ? `\nSoft guard: ${warning}` : ""}`);
      });
      state.notes = [...(state.notes ?? []), `Grill cycle answered (${queued.length} questions):\n${roundSummaries.join("\n\n")}`];
      state.currentGrillCycle = { ...cycle, status: "ready_for_resweep", updatedAt: new Date().toISOString() };
      saveState(ctx.cwd);
      return {
        content: [{ type: "text", text: `Project Flow grill cycle captured ${queued.length} answer(s). Now revise the potential plan with all collected answers, re-sweep for new blockers, then either start another grill cycle or call project_flow_save_plan.\n\n${roundSummaries.join("\n\n")}` }],
        details: { cycleId: cycle.id, grillRoundCount: state.grillRounds?.length ?? 0, answers: roundSummaries, warnings: warnings.filter(Boolean) },
      };
    },
  });

  pi.registerTool({
    name: "project_flow_context",
    label: "Project Flow Context",
    description: "Lazy-load Project Flow memory, module specs, templates, or the latest plan on demand. Use instead of loading all context at startup.",
    parameters: Type.Object({
      target: Type.String({ description: "One of: memory-index, decisions, learnings, validation, latest-plan, plan-template, module:<name>" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureProjectFlow(ctx.cwd);
      const target = params.target.trim();
      const moduleName = target.startsWith("module:") ? target.slice("module:".length).trim() : "";
      const candidates: Record<string, string | undefined> = {
        "memory-index": join(ctx.cwd, MEMORY_DIR, "index.md"),
        decisions: join(ctx.cwd, MEMORY_DIR, "decisions.md"),
        learnings: join(ctx.cwd, MEMORY_DIR, "learnings.md"),
        validation: join(ctx.cwd, MEMORY_DIR, "validation.md"),
        "model-policy": join(ctx.cwd, MEMORY_DIR, "model-policy.md"),
        "latest-plan": latestFile(ctx.cwd, PLANS_DIR, ".md"),
        "plan-template": join(ctx.cwd, "unified-project-flow", "templates", "plan-template.md"),
      };
      const path = moduleName
        ? join(ctx.cwd, "unified-project-flow", "modules", `${safeSlug(moduleName)}.md`)
        : candidates[target];
      if (!path || !existsSync(path)) {
        return { content: [{ type: "text", text: `Project Flow context target not found: ${target}` }], isError: true, details: { target } };
      }
      const body = readFileSync(path, "utf8");
      return { content: [{ type: "text", text: `# ${relative(ctx.cwd, path)}\n\n${body.slice(0, 20000)}` }], details: { target, path, truncated: body.length > 20000 } };
    },
  });

  pi.registerTool({
    name: "project_flow_finish",
    label: "Finish Project Flow",
    description: "Record build/docs validation evidence and transition Project Flow lifecycle to complete or failed. Use after approved build validation is known.",
    parameters: Type.Object({
      status: Type.String({ description: "complete or failed" }),
      summary: Type.String({ description: "Concise changed files, validation evidence, blockers, and follow-ups" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureProjectFlow(ctx.cwd);
      const normalized = params.status.toLowerCase().includes("fail") ? "failed" : "complete";
      state.phase = normalized;
      state.notes = [...(state.notes ?? []), params.summary];
      saveState(ctx.cwd);
      if (normalized === "complete") clearWidget(ctx); else renderWidget(ctx);
      const logPath = join(ctx.cwd, SESSIONS_DIR, `${state.id}-result.md`);
      writeAtomic(logPath, `# Project Flow Result\n\nStatus: ${normalized}\n\n${params.summary.trim()}\n`);
      return { content: [{ type: "text", text: `Project Flow marked ${normalized}. Result: ${relative(ctx.cwd, logPath)}` }], details: { status: normalized, path: logPath } };
    },
  });

  pi.registerTool({
    name: "project_flow_save_plan",
    label: "Save Project Flow Plan",
    description: "Persist a clean Project Flow plan under .pi/project-flow/plans and show the plan review. Use build-ready only when no blocking product/tech questions remain; otherwise save as draft or blocked.",
    parameters: Type.Object({
      title: Type.String({ description: "Short plan title for the filename" }),
      markdown: Type.String({ description: "Full markdown plan body" }),
      status: Type.Optional(Type.String({ description: "Plan status: build-ready only if no blocking questions remain; otherwise draft or blocked" })),
      unresolvedQuestions: Type.Optional(Type.Array(Type.String({ description: "Blocking questions still requiring user answer before build approval" }))),
      blockerAnalysisSummary: Type.Optional(Type.String({ description: "Required: summarize the blocker sweep over the potential plan: candidate blockers found, which were answered/assumed/resolved, and which remain unresolved." })),
      grillResolutionSummary: Type.Optional(Type.String({ description: "Required after any grill question was answered: explain how each grill answer was incorporated, and why any remaining blockers are still unresolved." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureProjectFlow(ctx.cwd);
      const grillRounds = state.grillRounds ?? [];
      if (!params.blockerAnalysisSummary?.trim()) {
        return {
          content: [{ type: "text", text: `Project Flow plan not saved yet. blockerAnalysisSummary was omitted. First sweep the potential plan for all build-readiness blockers you can identify, form a blocker queue, ask one concise unresolved blocker at a time via project_flow_grill_question without merging independent ambiguities, then call project_flow_save_plan with blockerAnalysisSummary.\n\n${sessionNotesContext(ctx.cwd)}` }],
          isError: true,
          details: { reason: "missing_blocker_analysis_summary", grillRoundCount: grillRounds.length },
        };
      }
      if (grillRounds.length && !params.grillResolutionSummary?.trim()) {
        return {
          content: [{ type: "text", text: `Project Flow plan not saved yet. ${grillRounds.length} grill round(s) have answers, but grillResolutionSummary was omitted. Reconsider those answers now, revise the plan, ask another project_flow_grill_question if a new blocker appears, then call project_flow_save_plan again with blockerAnalysisSummary and grillResolutionSummary.\n\n${sessionNotesContext(ctx.cwd)}` }],
          isError: true,
          details: { reason: "missing_grill_resolution_summary", grillRoundCount: grillRounds.length },
        };
      }
      if (grillRounds.length && params.grillResolutionSummary?.trim()) {
        const missingRefs = grillResolutionMissingRefs(params.grillResolutionSummary);
        if (missingRefs.length) {
          return {
            content: [{ type: "text", text: `Project Flow plan not saved yet. grillResolutionSummary does not appear to reference every answered grill question. Mention each grill round by number or by its concrete decision, then save again.\n\nMissing apparent references:\n${missingRefs.map(q => `- ${q}`).join("\n")}\n\n${sessionNotesContext(ctx.cwd)}` }],
            isError: true,
            details: { reason: "incomplete_grill_resolution_summary", grillRoundCount: grillRounds.length, missingRefs },
          };
        }
      }
      const name = `${day()}-${safeSlug(params.title)}.md`;
      const path = join(ctx.cwd, PLANS_DIR, name);
      const hasUnresolved = Array.isArray(params.unresolvedQuestions) && params.unresolvedQuestions.length > 0;
      const effectiveStatus = hasUnresolved ? "blocked" : (params.status || "build-ready");
      const normalizedStatus = effectiveStatus.toLowerCase();
      if (!hasUnresolved && !normalizedStatus.includes("blocked") && !normalizedStatus.includes("draft") && obviousUnresolvedLanguage(`${params.markdown}\n${params.blockerAnalysisSummary}\n${params.grillResolutionSummary || ""}`)) {
        return {
          content: [{ type: "text", text: `Project Flow plan not saved yet. The plan is marked build-ready, but contains obvious unresolved/blocking language such as TBD, TODO, awaiting, open question, or needs user. Either resolve/remove that language or save as draft/blocked with unresolvedQuestions.\n\n${sessionNotesContext(ctx.cwd)}` }],
          isError: true,
          details: { reason: "build_ready_contains_unresolved_language" },
        };
      }
      const blockerBlock = `\n\n## Blocker Analysis\n\n${params.blockerAnalysisSummary.trim()}\n`;
      const grillBlock = params.grillResolutionSummary?.trim() ? `\n\n## Grill Resolution\n\n${params.grillResolutionSummary.trim()}\n` : "";
      const questionsBlock = hasUnresolved ? `\n\n## Blocking Questions\n\n${params.unresolvedQuestions!.map((q: string, i: number) => `${i + 1}. ${q}`).join("\n")}\n` : "";
      const frontmatter = params.markdown.trimStart().startsWith("---")
        ? ""
        : `---\ntype: project-flow-plan\nstatus: ${effectiveStatus}\ncreated: ${new Date().toISOString()}\ntitle: ${params.title}\n---\n\n`;
      writeAtomic(path, frontmatter + params.markdown.trim() + blockerBlock + grillBlock + questionsBlock + "\n");
      if (state.currentGrillCycle?.status === "ready_for_resweep") {
        state.currentGrillCycle = { ...state.currentGrillCycle, status: "closed", updatedAt: new Date().toISOString() };
      }
      if (normalizedStatus.includes("blocked") || normalizedStatus.includes("draft")) {
        state.phase = "blocked";
        state.planPath = path;
        state.notes = [...(state.notes ?? []), `Plan saved without build choices because status is ${effectiveStatus}.`];
        saveState(ctx.cwd);
        renderWidget(ctx);
        const blockedBody = existsSync(path) ? readFileSync(path, "utf8") : "Plan file not found.";
        pi.sendMessage({ customType: "project-flow-plan-review", content: `# Project Flow Plan Needs Answers\n\nPlan file: ${relative(ctx.cwd, path)}\n\n${blockedBody.slice(0, 30000)}`, display: true }, { triggerTurn: false });
        ctx.ui.notify(`Project Flow plan saved as ${effectiveStatus}; build choices withheld.`, "warning");
      } else {
        await chooseAfterPlan(pi, ctx, path);
      }
      return { content: [{ type: "text", text: `Saved Project Flow plan: ${relative(ctx.cwd, path)}` }], details: { path, relativePath: relative(ctx.cwd, path), status: effectiveStatus, unresolvedQuestions: params.unresolvedQuestions ?? [] } };
    },
  });

  pi.registerCommand("reload-flow", {
    description: "Developer helper: refresh Project Flow extension/support files from PI_PROJECT_FLOW_DEV_ROOT (or this project) without touching project memories, plans, or sessions",
    handler: async (_args, ctx) => {
      const sourceRoot = devFlowRoot(ctx);
      const copied: string[] = [];
      const pairs: Array<[string, string]> = [
        [join(sourceRoot, ".pi/extensions/project-flow/index.ts"), join(ctx.cwd, ".pi/extensions/project-flow/index.ts")],
        [join(sourceRoot, ".pi/project-flow/README.md"), join(ctx.cwd, ".pi/project-flow/README.md")],
        [join(sourceRoot, ".pi/project-flow/VALIDATION.md"), join(ctx.cwd, ".pi/project-flow/VALIDATION.md")],
        [join(sourceRoot, ".pi/project-flow/self-validate.mjs"), join(ctx.cwd, ".pi/project-flow/self-validate.mjs")],
        [join(sourceRoot, ".pi/themes/relay-concrete-dim.json"), join(ctx.cwd, ".pi/themes/relay-concrete-dim.json")],
      ];
      for (const [from, to] of pairs) {
        copyTextFileAtomic(from, to);
        copied.push(relative(ctx.cwd, to));
      }
      const settingsPath = updateProjectThemeSetting(ctx.cwd);
      copied.push(relative(ctx.cwd, settingsPath));
      const report = [
        "# Project Flow Reload Helper",
        "",
        `Source: ${sourceRoot}`,
        "",
        "Copied:",
        ...copied.map(p => `- ${p}`),
        "",
        "Not touched:",
        `- ${MEMORY_DIR}/`,
        `- ${PLANS_DIR}/`,
        `- ${SESSIONS_DIR}/`,
        "",
        "Theme:",
        "- set .pi/settings.json theme to relay-concrete-dim",
        "",
        "Now run `/reload` so Pi loads the refreshed extension code and theme selection.",
      ].join("\n");
      pi.sendMessage({ customType: "project-flow-reload-helper", content: report, display: true }, { triggerTurn: false });
      ctx.ui.notify("Project Flow files/theme refreshed. Run /reload.", "info");
    },
  });

  pi.registerCommand("pf-doctor", {
    description: "Diagnose clean Project Flow state and adapter capabilities",
    handler: async (_args, ctx) => {
      const report = doctorReport(pi, ctx);
      pi.sendMessage({ customType: "project-flow-doctor", content: report, display: true }, { triggerTurn: false });
      ctx.ui.notify("Project Flow doctor report added to session.", "info");
    },
  });

  pi.registerCommand("pf-self-validate", {
    description: "Run Project Flow self-validation checks; set PI_PROJECT_FLOW_VALIDATION_CWD to restrict the allowed validation project",
    handler: async (args, ctx) => {
      ensureProjectFlow(ctx.cwd);
      const checks: string[] = [];
      const names = toolNames(pi);
      const wantBuild = /\bbuild\b/i.test(args);
      const expectedCwd = validationCwd(ctx);
      const cwdNorm = normalizePath(ctx.cwd).toLowerCase();
      const expectedNorm = expectedCwd.toLowerCase();
      const inValidationCwd = cwdNorm === expectedNorm;

      const record = (name: string, ok: boolean, detail = "") => {
        checks.push(`- ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
      };

      record("validation cwd", inValidationCwd, `cwd: ${ctx.cwd}; expected: ${expectedCwd}`);
      const selfTestRoot = join(ctx.cwd, SELF_TEST_DIR);
      rmSync(selfTestRoot, { recursive: true, force: true });
      mkdirSync(selfTestRoot, { recursive: true });
      record("clean self-test directory", existsSync(selfTestRoot), SELF_TEST_DIR);
      record("directories", [ROOT_DIR, MEMORY_DIR, PLANS_DIR, SESSIONS_DIR].every(d => existsSync(join(ctx.cwd, d))));
      const webPresent = available(names, WEB_TOOLS);
      record("ResearchAdapter tools", webPresent.length === WEB_TOOLS.length, `present: ${webPresent.join(", ") || "none"}`);
      record("project_flow_context tool", names.has("project_flow_context"));
      record("project_flow_save_plan tool", names.has("project_flow_save_plan"));
      record("project_flow_grill_question tool", names.has("project_flow_grill_question"));
      record("project_flow_finish tool", names.has("project_flow_finish"));

      const testPlanPath = join(ctx.cwd, PLANS_DIR, `${day()}-self-validation-smoke.md`);
      writeAtomic(testPlanPath, `---\ntype: project-flow-plan\nstatus: self-validation\ncreated: ${new Date().toISOString()}\ntitle: Self Validation Smoke\n---\n\n# Self Validation Smoke\n\nThis file verifies Project Flow plan persistence.\n`);
      record("plan persistence", existsSync(testPlanPath), relative(ctx.cwd, testPlanPath));

      const bridgeList = await requestSubagentBridge(pi, { action: "list", agentScope: "both" }, 8000);
      record("AgentAdapter bridge list", bridgeList.ok, bridgeList.ok ? "bridge responded" : bridgeList.error);

      if (wantBuild) {
        if (!inValidationCwd) {
          record("AgentAdapter foreground worker", false, `refusing build self-test outside ${expectedCwd}`);
        } else {
          const outRel = `${SELF_TEST_DIR}/hello.txt`;
          const worker = await requestSubagentBridge(pi, withModel({
            agent: "worker",
            task: `Project Flow self-validation build test running in ${expectedCwd}. Create or overwrite only ${outRel} with exactly: hello from project-flow self-validation. Do not touch other files. Then verify the file exists and report evidence.`,
            skill: false,
            context: "fresh",
            async: false,
            agentScope: "both",
          }, PF_WORKER_MODEL), 60000);
          const outPath = join(ctx.cwd, outRel);
          record("AgentAdapter foreground worker", worker.ok, worker.ok ? "worker returned" : worker.error);
          record("self-test artifact", existsSync(outPath), outRel);
        }
      }

      const ok = checks.every(line => line.startsWith("- PASS"));
      const report = [`# Project Flow Self-Validation`, "", `Status: ${ok ? "PASS" : "FAIL"}`, "", ...checks].join("\n");
      const reportPath = join(ctx.cwd, SESSIONS_DIR, `${stamp()}-self-validation.md`);
      writeAtomic(reportPath, report + "\n");
      pi.sendMessage({ customType: "project-flow-self-validation", content: `${report}\n\nReport: ${relative(ctx.cwd, reportPath)}`, display: true }, { triggerTurn: false });
      ctx.ui.notify(`Project Flow self-validation ${ok ? "passed" : "failed"}.`, ok ? "info" : "warning");
    },
  });

  pi.registerCommand("pf-e2e", {
    description: "Run a confined Project Flow lifecycle E2E in the validation project: plan persistence, AgentAdapter build, validation, finish",
    handler: async (_args, ctx) => {
      ensureProjectFlow(ctx.cwd);
      const expectedCwd = validationCwd(ctx);
      const cwdNorm = normalizePath(ctx.cwd).toLowerCase();
      if (cwdNorm !== expectedCwd.toLowerCase()) {
        ctx.ui.notify(`Project Flow E2E refused outside ${expectedCwd}`, "error");
        return;
      }

      const selfTestRoot = join(ctx.cwd, SELF_TEST_DIR);
      rmSync(selfTestRoot, { recursive: true, force: true });
      mkdirSync(selfTestRoot, { recursive: true });

      state = { id: `pf-e2e-${stamp()}`, phase: "planning", task: "Project Flow confined E2E validation", updatedAt: new Date().toISOString(), notes: [] };
      saveState(ctx.cwd);
      renderWidget(ctx);

      const planPath = join(ctx.cwd, PLANS_DIR, `${day()}-project-flow-e2e.md`);
      writeAtomic(planPath, `---\ntype: project-flow-plan\nstatus: build-ready\ncreated: ${new Date().toISOString()}\ntitle: Project Flow E2E\n---\n\n# Project Flow E2E\n\nApproved confined validation build.\n\n## Scope\n\n- Create only ${SELF_TEST_DIR}/e2e.txt\n\n## Validation\n\n- Confirm the file exists and contains the expected text.\n`);
      state.phase = "plan_ready";
      state.planPath = planPath;
      saveState(ctx.cwd);
      renderWidget(ctx);

      state.phase = "build_requested";
      saveState(ctx.cwd);
      renderWidget(ctx);
      const outRel = `${SELF_TEST_DIR}/e2e.txt`;
      const bridge = await requestSubagentBridge(pi, withModel({
        agent: "worker",
        task: `Project Flow E2E confined build in ${expectedCwd}. Read plan ${rel(ctx.cwd, planPath)}. Create or overwrite only ${outRel} with exactly: project-flow e2e ok. Do not touch other files. Verify file exists and report evidence.`,
        reads: [rel(ctx.cwd, planPath)],
        skill: false,
        context: "fresh",
        async: false,
        agentScope: "both",
      }, PF_WORKER_MODEL), 60000);

      if (!bridge.ok) {
        state.phase = "blocked";
        state.notes = [...(state.notes ?? []), `E2E AgentAdapter blocked: ${bridge.error}`];
        saveState(ctx.cwd);
        renderWidget(ctx);
        pi.sendMessage({ customType: "project-flow-e2e", content: `# Project Flow E2E\n\nStatus: BLOCKED\n\n${bridge.error}`, display: true }, { triggerTurn: false });
        return;
      }

      state.phase = "validating";
      saveState(ctx.cwd);
      renderWidget(ctx);
      const outPath = join(ctx.cwd, outRel);
      const ok = existsSync(outPath) && readFileSync(outPath, "utf8").trim() === "project-flow e2e ok";
      state.phase = ok ? "complete" : "failed";
      state.notes = [...(state.notes ?? []), `E2E ${ok ? "passed" : "failed"}: ${outRel}`];
      saveState(ctx.cwd);
      if (ok) clearWidget(ctx); else renderWidget(ctx);
      const reportPath = join(ctx.cwd, SESSIONS_DIR, `${state.id}-e2e.md`);
      const workerText = bridge.response?.result?.content?.find?.((c: any) => c.type === "text")?.text ?? "worker returned";
      writeAtomic(reportPath, `# Project Flow E2E\n\nStatus: ${ok ? "PASS" : "FAIL"}\n\nPlan: ${rel(ctx.cwd, planPath)}\nArtifact: ${outRel}\n\n## Worker\n\n${workerText}\n`);
      pi.sendMessage({ customType: "project-flow-e2e", content: `# Project Flow E2E\n\nStatus: ${ok ? "PASS" : "FAIL"}\n\nReport: ${relative(ctx.cwd, reportPath)}`, display: true }, { triggerTurn: false });
      ctx.ui.notify(`Project Flow E2E ${ok ? "passed" : "failed"}.`, ok ? "info" : "warning");
    },
  });

  pi.registerCommand("plan", {
    description: "Start a clean Project Flow planning lifecycle",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <task>", "warning");
        return;
      }
      ensureProjectFlow(ctx.cwd);
      state = { id: `pf-${stamp()}`, phase: "planning", task, updatedAt: new Date().toISOString(), notes: [] };
      saveState(ctx.cwd);
      renderWidget(ctx);
      setTools(pi, READ_ONLY_TOOLS);
      const context = memoryContext(ctx.cwd);
      queueUserMessage(pi, planningPrompt(task, context));
    },
  });

  pi.registerCommand("plan-continue", {
    description: "Resume the latest clean Project Flow session or plan",
    handler: async (_args, ctx) => {
      ensureProjectFlow(ctx.cwd);
      const loaded = latestSession(ctx.cwd);
      if (loaded) state = loaded;
      renderWidget(ctx);
      setTools(pi, READ_ONLY_TOOLS);
      const latestPlanPath = state.planPath;
      if (!loaded && state.id === "none") {
        clearWidget(ctx);
        ctx.ui.notify("No active Project Flow session found. Start with /plan <task>.", "warning");
        pi.sendMessage({ customType: "project-flow-continue", content: "# Project Flow Continue\n\nNo active Project Flow session was found. I will not infer a working task from an unrelated saved plan. Start a new project task with `/plan <task>`.", display: true }, { triggerTurn: false });
        return;
      }
      if (["plan_ready", "build_requested", "building", "validating"].includes(state.phase) && latestPlanPath) {
        state.notes = [...(state.notes ?? []), `Plan review shown by /plan-continue before resuming phase ${state.phase}.`];
        await chooseAfterPlan(pi, ctx, latestPlanPath);
        return;
      }
      setTools(pi, state.phase === "building" ? EXEC_TOOLS : READ_ONLY_TOOLS);
      queueUserMessage(pi, continuePrompt(ctx.cwd, latestPlanPath));
    },
  });

  pi.registerCommand("doc", {
    description: "Run Project Flow documentation/memory reconciliation",
    handler: async (_args, ctx) => {
      ensureProjectFlow(ctx.cwd);
      const latestPlanPath = state.planPath || latestFile(ctx.cwd, PLANS_DIR, ".md");
      state.phase = "docs";
      saveState(ctx.cwd);
      renderWidget(ctx);
      setTools(pi, ["read", "bash", "grep", "find", "ls", "edit", "write", "project_flow_context", "project_flow_memory_search", "project_flow_list_modules", "project_flow_read_headers"]);
      queueUserMessage(pi, `[PROJECT FLOW: DOC RECONCILIATION]\nPlan: ${rel(ctx.cwd, latestPlanPath)}\n\nReconcile docs and .pi/project-flow/memory after the build. Inspect changed files and validation evidence. Produce a drift report, then apply only warranted documentation or memory updates. When complete, call project_flow_finish if the lifecycle result should be recorded.`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ensureProjectFlow(ctx.cwd);
    renderWelcomeHeader(ctx);
    const loaded = latestSession(ctx.cwd);
    if (loaded && loaded.phase !== "complete" && loaded.phase !== "failed") state = loaded;
    if (state.phase !== "idle") renderWidget(ctx); else clearWidget(ctx);
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash") {
      const command = typeof (event as any).input?.command === "string" ? (event as any).input.command : "";
      if (["build_requested", "building", "validating"].includes(state.phase)) {
        const reason = cargoSafetyReason(command);
        if (reason) return { block: true, reason };
      }
    }
    if (state.phase !== "planning" && state.phase !== "blocked" && state.phase !== "plan_ready") return;
    if (event.toolName === "edit" || event.toolName === "write") {
      return { block: true, reason: "Project Flow planning is read-only. Save/approve a plan before editing." };
    }
    if (event.toolName === "bash") {
      const command = typeof (event as any).input?.command === "string" ? (event as any).input.command : "";
      if (!isSafeReadOnlyBash(command)) {
        return { block: true, reason: "Project Flow planning permits only read-only shell inspection before build approval." };
      }
    }
  });
}
