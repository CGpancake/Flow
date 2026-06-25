import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
  "subagent",
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
const GLOBAL_ENV = readDotEnv(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), ".env"));
const GLOBAL_PROJECT_FLOW_ENV = readDotEnv(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "project-flow.env"));
const FLOW_ENV = { ...GLOBAL_ENV, ...GLOBAL_PROJECT_FLOW_ENV, ...process.env };
const VALIDATION_CWD = normalizePath(FLOW_ENV.PI_PROJECT_FLOW_VALIDATION_CWD || FLOW_ENV.PI_PROJECT_FLOW_TEST_CWD || "");
const REPO_FLOW_ROOT = normalizePath(FLOW_ENV.PI_PROJECT_FLOW_REPO || FLOW_ENV.PROJECT_FLOW_REPO || "");
const DEV_FLOW_ROOT = normalizePath(FLOW_ENV.PI_PROJECT_FLOW_DEV_ROOT || REPO_FLOW_ROOT || "");
const SELF_TEST_DIR = `${ROOT_DIR}/self-test`;
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const PF_WORKER_MODEL = FLOW_ENV.PI_PROJECT_FLOW_WORKER_MODEL || FLOW_ENV.PI_PROJECT_FLOW_CHEAP_MODEL || "";
const PF_REVIEW_MODEL = FLOW_ENV.PI_PROJECT_FLOW_REVIEW_MODEL || FLOW_ENV.PI_PROJECT_FLOW_EXPENSIVE_MODEL || "";
const MAX_SAFE_CARGO_JOBS = Number(FLOW_ENV.PI_PROJECT_FLOW_MAX_CARGO_JOBS || "2");
const GSD_MAX_AUTOFIX_ATTEMPTS = Number(FLOW_ENV.PI_PROJECT_FLOW_GSD_MAX_AUTOFIX_ATTEMPTS || "3");
const GSD_MAX_CONTINUE_TASKS = Math.min(15, Math.max(1, Number(FLOW_ENV.PI_PROJECT_FLOW_GSD_MAX_CONTINUE_TASKS || "15")));
const GSD_DEFAULT_CONTINUE_TASKS = Math.min(GSD_MAX_CONTINUE_TASKS, Math.max(1, Number(FLOW_ENV.PI_PROJECT_FLOW_GSD_DEFAULT_BATCH_TASKS || "15")));
const PONYTAIL_SKILL_NAME = "ponytail";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSION_REPO_ROOT = normalizePath(join(EXTENSION_DIR, "..", "..", ".."));
const SOURCE_FLOW_ROOT = DEV_FLOW_ROOT || REPO_FLOW_ROOT || EXTENSION_REPO_ROOT;
const PACKAGE_FLOW_DIR = join(SOURCE_FLOW_ROOT, ".pi", "project-flow");

let state: SessionState = {
  id: "none",
  phase: "idle",
  updatedAt: new Date().toISOString(),
};

function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

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

type GsdBaseAgent = "scout" | "worker" | "reviewer";

type GsdDisplayIdentity = {
  baseAgent: GsdBaseAgent;
  workerName: string;
  taskTitle: string;
  slug: string;
  displayName: string;
  displayAgent: string;
};

const GSD_WORKER_NAMES = [
  "Regex Necromancer", "Merge Oracle", "YAML Sommelier", "Cache Goblin", "Lint Gremlin", "Schema Whisperer", "Commit Alchemist", "Diff Cartographer",
  "Build Janitor", "Token Accountant", "Prompt Mechanic", "Stack Archaeologist", "Bug Sommelier", "Flake Exorcist", "Config Surgeon", "Dependency Diplomat",
  "Branch Librarian", "Race Detective", "Patch Barber", "Scope Bouncer", "Null Wrangler", "Import Chiropractor", "Docker Florist", "Queue Therapist",
  "Review Goblin", "Format Wizard", "Release Cartographer", "Deadline Juggler", "Backlog Gardener", "Migration Plumber", "Context Tailor", "Protocol Dentist",
  "Workflow Locksmith", "Artifact Curator", "Rollback Prophet", "Fixture Blacksmith", "Mock Naturalist", "Pipeline Barber", "Semaphore Mystic", "Runtime Notary",
];
const GSD_TITLE_FILLER = ["Task", "Work", "Review"];
const GSD_BASE_AGENT_PROFILES: Record<GsdBaseAgent, { description: string; thinking: "low" | "medium" | "high"; tools: string; extraFrontmatter?: string; rolePrompt: string }> = {
  scout: {
    description: "Project Flow GSD display alias for continuation planning",
    thinking: "low",
    tools: "read, grep, find, ls, bash, write, intercom",
    extraFrontmatter: "output: context.md\ndefaultProgress: true",
    rolePrompt: "You are a scouting subagent running inside pi. Move fast, verify from local evidence, and return compressed context/planning output for handoff. Use the task prompt as the source of truth.",
  },
  worker: {
    description: "Project Flow GSD display alias for atomic implementation work",
    thinking: "medium",
    tools: "read, grep, find, ls, bash, edit, write, contact_supervisor",
    extraFrontmatter: "defaultContext: fresh\nskills: ponytail\ndefaultProgress: true",
    rolePrompt: "You are `worker`: the implementation subagent and single writer thread. Execute only the assigned atomic task with narrow, coherent edits. Use only the task packet, explicit reads, and handoff outputs unless you must inspect owned files. Pause for unapproved decisions instead of guessing.",
  },
  reviewer: {
    description: "Project Flow GSD display alias for validation review",
    thinking: "high",
    tools: "read, grep, find, ls, bash, edit, write, intercom",
    extraFrontmatter: "defaultReads: plan.md, progress.md\ndefaultProgress: true",
    rolePrompt: "You are a disciplined review subagent. Inspect, evaluate, and report evidence-backed findings. Do not invent issues; cite files, commands, and exact blockers.",
  },
};

function titleSlug(input: string): string {
  return safeSlug(input) || "gsd-task";
}

function titleCaseWord(word: string): string {
  if (/^\d+$/.test(word)) return word;
  return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();
}

function sanitizeGsdTaskTitle(input: string): string {
  const words = input.match(/[A-Za-z0-9]+/g)?.map(titleCaseWord) ?? [];
  const normalized = [...words, ...GSD_TITLE_FILLER].slice(0, 3);
  return normalized.join(" ");
}

function randomFrom<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)]!;
}

function randomWorkerName(): string {
  return randomFrom(GSD_WORKER_NAMES);
}

function uniqueGsdSlug(baseSlug: string, usedSlugs: Set<string>): string {
  const root = baseSlug || "gsd-worker";
  let slug = root;
  let i = 2;
  while (usedSlugs.has(slug)) slug = `${root}-${i++}`;
  usedSlugs.add(slug);
  return slug;
}

function makeGsdDisplayIdentity(title: string, baseAgent: GsdBaseAgent, usedSlugs: Set<string>): GsdDisplayIdentity {
  const workerName = randomWorkerName();
  const taskTitle = sanitizeGsdTaskTitle(title);
  const slug = uniqueGsdSlug(`${safeSlug(workerName)}-${titleSlug(taskTitle)}`, usedSlugs);
  const displayName = `${workerName} — ${taskTitle}`;
  return {
    baseAgent,
    workerName,
    taskTitle,
    slug,
    displayName,
    displayAgent: `${displayName} (${baseAgent})`,
  };
}

function gsdIdentityPrompt(identity: GsdDisplayIdentity): string {
  return [
    `Worker: ${identity.workerName}`,
    `Task title: ${identity.taskTitle}`,
    `Display agent: ${identity.displayAgent}`,
    `Stable slug: ${identity.slug}`,
    "",
    "Begin your output artifact with this identity header so the parent can map the TUI row to the output file:",
    `# ${identity.taskTitle}`,
    `Worker: ${identity.workerName}`,
    `Task title: ${identity.taskTitle}`,
    `Stable slug: ${identity.slug}`,
  ].join("\n");
}

function gsdDisplayAgentDefinition(identity: GsdDisplayIdentity): string {
  const profile = GSD_BASE_AGENT_PROFILES[identity.baseAgent];
  return [
    "---",
    `name: ${identity.displayAgent}`,
    `description: ${profile.description}: ${identity.displayName}`,
    `tools: ${profile.tools}`,
    `thinking: ${profile.thinking}`,
    "systemPromptMode: replace",
    "inheritProjectContext: true",
    "inheritSkills: false",
    profile.extraFrontmatter,
    "---",
    "",
    `You are the Project Flow GSD display alias for the built-in \`${identity.baseAgent}\` role.`,
    "",
    "Visible identity:",
    `- Worker: ${identity.workerName}`,
    `- Task title: ${identity.taskTitle}`,
    `- Stable slug: ${identity.slug}`,
    "",
    profile.rolePrompt,
    "",
    "Follow the task prompt exactly, keep scope tight, and preserve the identity header in file-only outputs.",
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function ensureProjectFlowDisplayAgentAlias(cwd: string, identity: GsdDisplayIdentity): string {
  const aliasDir = join(cwd, ".pi", "agents", "project-flow-gsd");
  const aliasPath = join(aliasDir, `${identity.slug}.md`);
  writeAtomic(aliasPath, gsdDisplayAgentDefinition(identity));
  return relative(cwd, aliasPath);
}

function ensureGsdDisplayAgentAlias(cwd: string, identity: GsdDisplayIdentity): string {
  return ensureProjectFlowDisplayAgentAlias(cwd, identity);
}

type PonytailStatus = {
  installed: boolean;
  skillAvailable: boolean;
  packageAvailable: boolean;
  sources: string[];
  message: string;
};

function readJsonBestEffort(path: string): any | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function packageRootsInNodeModules(root: string): string[] {
  if (!existsSync(root)) return [];
  const roots: string[] = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(root, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      let scopedEntries;
      try { scopedEntries = readdirSync(entryPath, { withFileTypes: true }); } catch { continue; }
      for (const scoped of scopedEntries) {
        if (!scoped.name.startsWith(".") && (scoped.isDirectory() || scoped.isSymbolicLink())) roots.push(join(entryPath, scoped.name));
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) roots.push(entryPath);
  }
  return roots;
}

function skillPathHasPonytail(skillPath: string): boolean {
  if (!existsSync(skillPath)) return false;
  const baseName = safeSlug(skillPath.split(/[\\/]/).pop() || "");
  if (baseName === PONYTAIL_SKILL_NAME && existsSync(join(skillPath, "SKILL.md"))) return true;
  if (skillPath.toLowerCase().endsWith(`${PONYTAIL_SKILL_NAME}.md`)) return true;
  let entries;
  try { entries = readdirSync(skillPath, { withFileTypes: true }); } catch { return false; }
  return entries.some(entry => {
    if (entry.name.toLowerCase() === `${PONYTAIL_SKILL_NAME}.md`) return true;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
    return safeSlug(entry.name) === PONYTAIL_SKILL_NAME && existsSync(join(skillPath, entry.name, "SKILL.md"));
  });
}

function detectPonytailStatus(cwd: string): PonytailStatus {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const sources: string[] = [];
  const skillCandidates = [
    join(cwd, ".pi", "skills", PONYTAIL_SKILL_NAME, "SKILL.md"),
    join(cwd, ".pi", "skills", `${PONYTAIL_SKILL_NAME}.md`),
    join(cwd, ".agents", "skills", PONYTAIL_SKILL_NAME, "SKILL.md"),
    join(agentDir, "skills", PONYTAIL_SKILL_NAME, "SKILL.md"),
    join(agentDir, "skills", `${PONYTAIL_SKILL_NAME}.md`),
    join(homedir(), ".agents", "skills", PONYTAIL_SKILL_NAME, "SKILL.md"),
  ];
  for (const candidate of skillCandidates) {
    if (existsSync(candidate)) sources.push(`skill:${candidate}`);
  }

  let packageAvailable = false;
  const packageRoots = [
    ...packageRootsInNodeModules(join(cwd, ".pi", "npm", "node_modules")),
    ...packageRootsInNodeModules(join(agentDir, "npm", "node_modules")),
  ];
  for (const packageRoot of packageRoots) {
    const pkg = readJsonBestEffort(join(packageRoot, "package.json"));
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) continue;
    const name = typeof pkg.name === "string" ? pkg.name : "";
    const pi = pkg.pi && typeof pkg.pi === "object" && !Array.isArray(pkg.pi) ? pkg.pi : undefined;
    const piSkills = Array.isArray(pi?.skills) ? pi.skills.filter((s: unknown): s is string => typeof s === "string") : [];
    const piExtensions = Array.isArray(pi?.extensions) ? pi.extensions.filter((s: unknown): s is string => typeof s === "string") : [];
    const looksLikePonytail = name.toLowerCase().includes(PONYTAIL_SKILL_NAME)
      || [...piSkills, ...piExtensions].some((entry: string) => entry.toLowerCase().includes(PONYTAIL_SKILL_NAME));
    if (!looksLikePonytail) continue;
    packageAvailable = true;
    sources.push(`package:${packageRoot}`);
    for (const skillEntry of piSkills) {
      const skillPath = join(packageRoot, skillEntry);
      if (skillPathHasPonytail(skillPath)) sources.push(`package-skills:${skillPath}`);
    }
  }

  const skillAvailable = sources.some(source => source.startsWith("skill:") || source.startsWith("package-skills:"));
  const installed = skillAvailable || packageAvailable;
  return {
    installed,
    skillAvailable,
    packageAvailable,
    sources,
    message: installed
      ? `Ponytail detected (${sources.join(", ")}); Project Flow will request skill '${PONYTAIL_SKILL_NAME}' when skill metadata is available and will not disable package extension hooks.`
      : `Ponytail not detected in local Pi skill/package paths; Project Flow will not request a missing skill. Install with 'pi install git:github.com/DietrichGebert/ponytail' before expecting package-backed Ponytail behavior.`,
  };
}

function ponytailSkillParam(status: PonytailStatus): Record<string, unknown> {
  return status.skillAvailable ? { skill: PONYTAIL_SKILL_NAME } : {};
}

function ponytailPromptNote(status: PonytailStatus): string {
  return `Ponytail worker-behavior integration: ${status.message}`;
}

function ponytailPreviewLines(status: PonytailStatus): string[] {
  return [
    "Ponytail worker-behavior integration:",
    `- Installed locally: ${status.installed ? "yes" : "no"}`,
    `- Skill request: ${status.skillAvailable ? PONYTAIL_SKILL_NAME : "not requested because the skill/package is not installed"}`,
    `- Package sources: ${status.sources.length ? status.sources.join(", ") : "none detected"}`,
  ];
}

type GsdWorkerBudget = {
  hardCap: number;
  defaultBatch: number;
  explicitRequestedWorkerCount?: number;
  pendingAutoTaskEstimate?: number;
  workerBudget: number;
  rationale: string;
};

function parseSmallCount(raw: string): number | undefined {
  const normalized = raw.trim().toLowerCase();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  };
  return words[normalized];
}

function detectExplicitGsdWorkerCount(text: string): number | undefined {
  const count = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)";
  const patterns = [
    new RegExp(`\\bexactly\\s+${count}\\s+(?:independent\\s+)?(?:workers?|subagents?|agents?)\\b`, "i"),
    new RegExp(`\\b(?:worker|subagent|agent)\\s+count\\s*:\\s*(?:exactly\\s*)?${count}\\b`, "i"),
    new RegExp(`\\b(?:selected\\s+)?(?:atomic\\s+)?(?:worker\\s+)?(?:budget|cap|batch|limit)\\s*(?::|=|to)?\\s*(?:exactly\\s*)?${count}\\b`, "i"),
    new RegExp(`\\b(?:delegate|launch|start|run|fan[- ]?out)\\s+(?:to\\s+)?(?:exactly\\s+)?${count}\\s+(?:independent\\s+)?(?:workers?|subagents?|agents?)\\b`, "i"),
    new RegExp(`\\b${count}[- ](?:worker|subagent|agent)\\b`, "i"),
    new RegExp(`\\b${count}\\s+(?:independent\\s+)?(?:workers?|subagents?|agents?)\\b`, "i"),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = match.slice(1).find(Boolean);
    const parsed = value ? parseSmallCount(value) : undefined;
    if (parsed !== undefined && Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function evidenceIndicatesGsdIncomplete(evidenceText: string): boolean {
  return /\b(overall plan is not complete|plan is not complete|first pending|remains? pending|pending work|next plan-approved work remains|slice \d+ remains pending)\b/i.test(evidenceText);
}

function evidenceIndicatesGsdComplete(evidenceText: string): boolean {
  if (evidenceIndicatesGsdIncomplete(evidenceText)) return false;
  return /\b(no pending auto(?:mated)? (?:work|tasks)|no planned auto task remains|chain is complete|overall plan is complete|status:\s*(?:complete|pass))\b/i.test(evidenceText);
}

function estimatePendingGsdAutoTasks(planText: string, evidenceText: string): number | undefined {
  if (evidenceText && evidenceIndicatesGsdComplete(evidenceText)) return 0;
  const beforeHardBlocker = planText.split(/^\s*(?:###\s+)?(?:.*(?:human-verify|manual checkpoint|decision blocker|required user decision).*)$/im)[0] ?? planText;
  const typeAutoCount = (beforeHardBlocker.match(/^\s*-?\s*Type:\s*`?auto`?\b/gim) || []).length;
  const uncheckedCount = (beforeHardBlocker.match(/^\s*[-*]\s+\[ \]\s+/gm) || []).length;
  const pendingCount = (beforeHardBlocker.match(/\b(?:pending|todo|remaining)\b[^\n]*(?:auto|task|slice)/gi) || []).length;
  const rawEstimate = Math.max(typeAutoCount, uncheckedCount, pendingCount);
  if (rawEstimate === 0) return undefined;
  const completedContinueTasks = (evidenceText.match(/^##?\s+.*(?:Status:\s*)?(?:complete|completed|pass|satisfied)\b/gim) || []).length;
  const completedFiles = (evidenceText.match(/^##\s+gsd\/continue-task-\d+\.md/gm) || []).length;
  const completedEstimate = Math.max(completedContinueTasks, completedFiles);
  return Math.max(0, rawEstimate - completedEstimate);
}

function computeGsdWorkerBudget(planText: string, targetText: string, evidenceText: string): GsdWorkerBudget {
  const explicitRequestedWorkerCount = detectExplicitGsdWorkerCount(`${targetText}\n\n${planText}`);
  const pendingAutoTaskEstimate = estimatePendingGsdAutoTasks(planText, evidenceText);
  let selected: number;
  let rationale: string;
  if (explicitRequestedWorkerCount !== undefined) {
    selected = explicitRequestedWorkerCount;
    rationale = `explicit worker count detected: ${explicitRequestedWorkerCount}`;
  } else if (pendingAutoTaskEstimate !== undefined && !(pendingAutoTaskEstimate === 0 && evidenceIndicatesGsdIncomplete(evidenceText))) {
    selected = pendingAutoTaskEstimate;
    rationale = `pending auto task estimate: ${pendingAutoTaskEstimate}`;
  } else {
    selected = GSD_DEFAULT_CONTINUE_TASKS;
    rationale = `no explicit count or reliable pending-task estimate; using default batch ${GSD_DEFAULT_CONTINUE_TASKS}`;
  }
  const workerBudget = Math.min(GSD_MAX_CONTINUE_TASKS, Math.max(0, selected));
  if (workerBudget !== selected) rationale = `${rationale}; clamped to hard cap ${GSD_MAX_CONTINUE_TASKS}`;
  return { hardCap: GSD_MAX_CONTINUE_TASKS, defaultBatch: GSD_DEFAULT_CONTINUE_TASKS, explicitRequestedWorkerCount, pendingAutoTaskEstimate, workerBudget, rationale };
}

function stripMarkdownInline(input: string): string {
  return input
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

function extractGsdAtomicTaskTitles(planText: string, maxCount: number): string[] {
  if (maxCount <= 0) return [];
  const titles: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    let title = stripMarkdownInline(raw)
      .replace(/^Atomic task\s+[A-Z0-9]+\s*[—:-]\s*/i, "")
      .replace(/^Slice\s+\d+\s*[—:-]\s*/i, "")
      .replace(/^Task\s+\d+\s*[—:-]\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!title || /^auto$/i.test(title)) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    titles.push(title);
  };

  for (const match of planText.matchAll(/^#{2,3}\s+((?:Slice|Milestone)\s+\d+\s*[:—-]\s*.+)$/gim)) add(match[1]);
  for (const match of planText.matchAll(/\*\*(Atomic task\s+[^*]+?)\*\*/gim)) add(match[1]);
  for (const match of planText.matchAll(/^\s*-\s+Concrete change:\s*(.+)$/gim)) add(match[1]);

  return titles.slice(0, maxCount);
}

function isTinyDocumentationOnlyGsd(planText: string, workerBudget: GsdWorkerBudget): boolean {
  if (workerBudget.workerBudget > 6) return false;
  const text = planText.toLowerCase();
  return /documentation-only|markdown note|validation note|validation artifact/.test(text)
    && /no source-code changes|no source code changes/.test(text);
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
  const welcomePath = join(cwd, WELCOME_ART_PATH);
  const packageWelcomePath = join(PACKAGE_FLOW_DIR, "welcome-art.md");
  if (!existsSync(welcomePath) && existsSync(packageWelcomePath)) copyTextFileAtomic(packageWelcomePath, welcomePath);
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

function grillAnswerLog(): string {
  const rounds = state.grillRounds ?? [];
  if (!rounds.length) return "";
  return [
    "## Grill Answer Log",
    "",
    ...rounds.flatMap((round, i) => [
      `### Grill Round ${i + 1}`,
      "",
      `- Question: ${round.question}`,
      `- Reason: ${round.reason}`,
      `- Recommendation: ${round.recommendation}`,
      `- Answer: ${round.answer}`,
      `- Answered at: ${round.answeredAt}`,
      round.defaultAssumption ? `- Default assumption: ${round.defaultAssumption}` : "",
      round.mergeWarning ? `- Note: ${round.mergeWarning}` : "",
      "",
    ].filter(Boolean)),
  ].join("\n");
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

function planningCommandReason(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (/\b(npm|pnpm|yarn|bun)\s+(test|run\s+(test|build|check|lint|typecheck)|build|check)\b/i.test(trimmed)) {
    return "Project Flow planning must not run test/build/validation commands. In plan mode, inspect read-only context and write the validation plan instead.";
  }
  if (/\b(cargo\s+(build|check|clippy|test|run|install|bench)|go\s+test|pytest|mvn\s+test|gradle\s+test|make\s+(test|check|build))\b/i.test(trimmed)) {
    return "Project Flow planning must not run test/build/validation commands. In plan mode, inspect read-only context and write the validation plan instead.";
  }
  return undefined;
}

function planningSubagentReason(input: any): string | undefined {
  const text = JSON.stringify(input ?? {}).toLowerCase();
  if (/"agent"\s*:\s*"(worker|validator)"/.test(text)) {
    return "Project Flow planning may only delegate read-only scout/research/review support, not worker/validator execution.";
  }
  if (/\b(run|execute)\b[^\n]{0,80}\b(test|tests|build|check|clippy|typecheck|lint)\b/.test(text)) {
    return "Project Flow planning subagents must not run tests/builds/checks; ask them for read-only inspection and validation recommendations only.";
  }
  return undefined;
}

function fitLine(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

function renderWelcomeHeader(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const sourceArtPath = join(PACKAGE_FLOW_DIR, "welcome-art.md");
  const projectArtPath = join(ctx.cwd, WELCOME_ART_PATH);
  const artPath = existsSync(sourceArtPath) ? sourceArtPath : projectArtPath;
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
    "- Planning mode is planning only: do not run tests, builds, checkers, validators, implementation workers, or auto-fix loops. Inspect read-only context, then write the validation/check plan that the later build phase should run.",
    "- Use pi-web-access tools only if research materially improves the plan.",
    "- Research gate: before using pi-web-access or launching researcher, identify the missing external fact, why repo inspection/project memory cannot answer it, and how the answer affects the plan. If no such fact exists, do not research.",
    "- If the task is large, unfamiliar, or externally dependent, you may use the subagent tool only for read-only planning support: scout for codebase reconnaissance, researcher for external/library/current-doc evidence, or reviewer for plan-risk review. Do not launch worker/validator agents and do not ask planning subagents to run tests/build/check commands. Keep this optional and targeted; do not spawn subagents for small obvious plans. When launching scout, explicitly require the Codebase Reading Protocol: project_flow_list_modules, project_flow_read_headers, project_flow_read_signatures, then selective full read only if needed. When launching researcher, include the research gate statement in the task and require a concise file-only or compact sourced answer.",
    "- Before the first grill question, sketch the potential plan privately and sweep it for all build-readiness blockers you can identify. Form a blocker queue, then ask unresolved blockers instead of silently converting them into assumptions.",
    "- Ask concise blocking questions through project_flow_grill_cycle when multiple current-cycle blockers are known, or project_flow_grill_question when only one blocker is known. Do not merge independent ambiguities into one question; queue them as separate question objects. Each grill question must include a single recommended answer, alternatives, a default assumption, and room for additional user context. Grill product intent, acceptance criteria, irreversible choices, destructive actions, dependency/framework choices, and locally impossible validation instead of guessing.",
    "- Grill loop requirement: precompute the current grill-cycle queue where possible so the UI can advance responsively from one concise question to the next. Keep related blockers adjacent before farther-apart topics. After the cycle is answered, plug collected answers back into the potential plan, revise blocker status, and re-sweep for blockers introduced or removed by the answers. If new blockers appear, start another grill cycle. Only then save the final plan.",
    "- When calling project_flow_save_plan, include blockerAnalysisSummary describing the blocker sweep/queue and final status. After any grill round, also include grillResolutionSummary explaining how each grill answer was incorporated. If a plan is still blocked, explain why the answered questions did not unblock it and list only genuinely unresolved questions.",
    "- Use the Grill rules: inspect relevant docs/context first, prefer reversible default assumptions, and ask only for product intent, irreversible tradeoffs, destructive actions, or locally impossible validation.",
    "- Treat these as blocking for build-ready plans: choosing a major framework/engine not named by the user, creating a new project/crate at repo root, destructive restructuring, unclear target platform/runtime, unclear acceptance criteria for game feel, or validation that cannot be run locally.",
    "- For ambiguous prompts, use project_flow_context and/or project_flow_memory_search only for relevant lazy context before asking; do not load heavy docs by default.",
    "- If web/current docs would materially affect dependency/framework choice or API correctness, use pi-web-access before saving a build-ready plan.",
    "- Do not hide major assumptions in a build-ready plan. If blocking questions remain after the full blocker sweep and grill loop, call project_flow_save_plan with status blocked or draft, unresolvedQuestions, blockerAnalysisSummary, and grillResolutionSummary if any grill rounds occurred; build choices will be withheld.",
    "- If you use scout, researcher, reviewer, pi-web-access, or substantial local inspection during planning, persist the useful result inside the saved plan under a concise `## Planning Evidence` section: source/tool or artifact, key findings, files/URLs checked, and how it changes the plan. Do not rely on invisible parent reasoning or transient chat context.",
    "- New `/plan` requests are authoritative fresh planning lifecycles, not continuations of the latest saved plan. Previous plans, sessions, and `gsd/*.md` artifacts may be used only as historical progress/evidence to avoid redoing completed work; do not inherit their pending slices, worker budget, or scope unless the user explicitly asks to continue/resume. Only `/plan-continue` and `/gsd-continue` are previous-plan continuation modes.",
    "- A new plan must decide its own GSD milestones/slices from the current requested changes and scope. Respect completed progress by citing it in Planning Evidence and excluding already-satisfied work, but create the slice set that fits the new request rather than replaying old GSD ledgers.",
    "- If enough information exists, produce a GSD-style plan with milestones, atomic slices, tasks, owned files, decisions, risks, and validation. Include enough slice/risk/validation evidence that build modes can reuse the plan instead of re-scouting.",
    "- GSD atomicity requirement: every slice must be independently verifiable, have one clear goal/user-visible outcome, list owned/shared files, dependencies, parallel-safety/conflict notes, stop/escalation triggers, automatic/manual validation, and required evidence.",
    "- Keep GSD work small enough for fresh worker sessions: split large slices into atomic tasks that one worker can complete and validate in one session. If a slice touches multiple subsystems or has multiple done conditions, break it down further before saving the plan.",
    "- Break each slice into ordered tasks. Each task must name its type (`auto`, `human-verify`, `decision`, or `human-action`), files, concrete change, done condition, validation, and auto-fix policy. Prefer `auto`; use human gates only for unavoidable user validation/action, secrets/auth, package legitimacy, destructive operations, or unapproved product/architecture decisions.",
    "- Split slices further if they touch unrelated behavior/files, cannot be validated independently, require separate architectural decisions, or would make failure attribution unclear. Mark parallel-safe only when dependencies and owned files do not conflict.",
    `- For Rust/Cargo plans, include Cargo safety in validation: heavy Cargo commands must use an explicit job limit of -j ${MAX_SAFE_CARGO_JOBS} or lower, prefer cargo fmt --check and cargo check -j ${MAX_SAFE_CARGO_JOBS}, and mark cargo run for graphical/interactive apps as manual unless explicitly approved.`,
    "- Save the plan by calling project_flow_save_plan.",
    "- Do not start implementation until the post-plan choice explicitly approves build.",
  ].join("\n");
}

function planningPrompt(task: string, context: string): string {
  return `[PROJECT FLOW: PLAN]\nTask: ${task}\n\nYou are planning only. Do not edit files, run tests/builds/checks, launch validators/workers, or try to finish by validating. Finish planning by calling project_flow_save_plan when the blocker sweep/grill loop is resolved or explicitly blocked. Project Flow core owns lifecycle and build approval.\n\n${projectFlowPlanningRules()}\n\n<project-flow-memory>\n${context || "No memory yet."}\n</project-flow-memory>`;
}

function continuePrompt(cwd: string, latestPlanPath?: string): string {
  return `[PROJECT FLOW: CONTINUE]
Session: ${state.id}
Phase: ${state.phase}
Task: ${state.task || "unknown"}
Plan: ${rel(cwd, latestPlanPath)}

Resume the Project Flow lifecycle from this state. Session notes, grill answers, deterministic grill queue state, and the current saved plan are included below. If phase is planning or blocked, stay in planning mode: do not run tests/builds/checks, launch validators/workers, or try to finish by validating. If phase is blocked, do not merely repeat the old blocked plan: reconsider the captured grill answers and any new user context, revise the potential plan, re-sweep for all build-readiness blockers, then use project_flow_grill_cycle for multiple current-cycle blockers or project_flow_grill_question for one blocker, or save a final plan with project_flow_save_plan. Keep independent ambiguities in separate queued calls and ask related blockers before farther-apart topics. project_flow_save_plan must include blockerAnalysisSummary, and after any grill round it must also include grillResolutionSummary. If building/validating and evidence is complete, call project_flow_finish. Do not substitute a different/latest plan unless the user explicitly selects it.

<project-flow-session-context>
${sessionNotesContext(cwd)}
</project-flow-session-context>`;
}

function planSection(body: string, heading: RegExp, maxChars = 3000): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(line => heading.test(line));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").slice(0, maxChars);
}

function planHasUsefulSection(body: string, heading: RegExp): boolean {
  const section = planSection(body, heading, 1200).toLowerCase();
  if (!section) return false;
  return !/\b(none|n\/a|not applicable|no known|no additional)\b/.test(section) || section.length > 240;
}

function renderPlanChoiceWidget(ctx: ExtensionContext, planPath: string, planBody: string): void {
  const preview = planBody
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\r?\n/)
    .filter(line => line.trim())
    .slice(0, 18);
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
    invalidate() {},
    render(width: number) {
      const border = "-".repeat(Math.max(12, Math.min(width, 88)));
      return [
        theme.fg("borderMuted", border),
        fitLine(`${theme.fg("accent", "PROJECT FLOW PLAN READY")} ${theme.fg("dim", rel(ctx.cwd, planPath))}`, width),
        ...preview.map(line => theme.fg(/^#/.test(line) ? "toolTitle" : "text", truncateToWidth(line, width))),
        theme.fg("dim", "Review the plan preview above, then choose the build mode below."),
        theme.fg("borderMuted", border),
      ];
    },
  }));
}

async function chooseAfterPlan(pi: ExtensionAPI, ctx: ExtensionContext, planPath: string): Promise<void> {
  state.phase = "plan_ready";
  state.planPath = planPath;
  saveState(ctx.cwd);
  renderWidget(ctx);

  const planBody = existsSync(planPath) ? readFileSync(planPath, "utf8") : "Plan file not found.";
  renderPlanChoiceWidget(ctx, planPath, planBody);
  pi.sendMessage({
    customType: "project-flow-plan-review",
    content: `# Project Flow Plan Review\n\nPlan file: ${rel(ctx.cwd, planPath)}\n\n${planBody.slice(0, 30000)}${planBody.length > 30000 ? "\n\n[Plan truncated in review message; open the file for full content.]" : ""}`,
    display: true,
  }, { triggerTurn: false });

  const choice = await ctx.ui.select("Project Flow: choose next step", [
    "Build now in this session",
    "Compact handoff / build after compact",
    "Build in fresh subagent worker",
    "Build with GSD subagent pipeline",
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
    queueUserMessage(pi, `[PROJECT FLOW: BUILD APPROVED]\nPlan file: ${rel(ctx.cwd, planPath)}\n\nBuild from the saved plan. Keep scope tight. Use edits only for plan-approved changes. Reuse any Planning Evidence, slices, risks, and validation sections in the saved plan; do not repeat scouting/research unless that evidence is missing, stale, or contradicted by the current repo state. Run relevant validation and report changed files, results, blockers, and follow-ups. Cargo safety: heavy Cargo commands must include an explicit job limit of -j ${MAX_SAFE_CARGO_JOBS} or lower; prefer cargo fmt --check and cargo check -j ${MAX_SAFE_CARGO_JOBS}. Do not run cargo run for graphical/interactive apps unless the user explicitly approves that exact step; report it as manual validation instead. When validation evidence is known, call project_flow_finish with status complete or failed.`);
    return;
  }

  if (choice === "Compact handoff / build after compact") {
    state.phase = "plan_ready";
    state.notes = [...(state.notes ?? []), "Compact handoff requested before build."];
    saveState(ctx.cwd);
    renderWidget(ctx);
    setTools(pi, READ_ONLY_TOOLS);
    pi.sendMessage({ customType: "project-flow-compact-handoff", content: `# Project Flow Compact Handoff\n\nPlan ready: ${rel(ctx.cwd, planPath)}\n\nRecommended next steps:\n\n1. Run /compact.\n2. Run /plan-continue.\n3. Approve Build now in this session, Build in fresh subagent worker, or Build with GSD subagent pipeline.\n\nNo build has started.`, display: true }, { triggerTurn: false });
    ctx.ui.notify("Project Flow compact handoff prepared; no build started.", "info");
    return;
  }

  if (choice === "Build in fresh subagent worker") {
    state.phase = "build_requested";
    saveState(ctx.cwd);
    renderWidget(ctx);
    setTools(pi, ["read", "bash", "subagent", "project_flow_finish", "project_flow_context", "project_flow_list_modules", "project_flow_read_headers", "project_flow_read_signatures", "project_flow_memory_search"]);

    const ponytailStatus = detectPonytailStatus(ctx.cwd);
    const identity = makeGsdDisplayIdentity("Plan Implementation Build", "worker", new Set<string>());
    const aliasFile = ensureProjectFlowDisplayAgentAlias(ctx.cwd, identity);

    const bridge = await requestSubagentBridge(pi, withModel({
      agent: identity.displayAgent,
      thinking: "medium",
      task: `[PROJECT FLOW: SUBAGENT BUILD]\n${gsdIdentityPrompt(identity)}\n\nPlan file: ${rel(ctx.cwd, planPath)}\n\n${ponytailPromptNote(ponytailStatus)}\n\nRead the written plan and implement only plan-approved changes. Keep scope tight. Reuse any Planning Evidence, slices, risks, and validation sections in the saved plan; do not repeat scouting/research unless that evidence is missing, stale, or contradicted by the current repo state. Validate and return changed files, validation evidence, blockers, and follow-ups. Research gate: do not use web research or researcher unless implementation is blocked by a missing external fact that repo inspection/project memory cannot answer; if so, state that fact, why local evidence is insufficient, and how it affects the build before researching. Cargo safety: heavy Cargo commands must include an explicit job limit of -j ${MAX_SAFE_CARGO_JOBS} or lower; prefer cargo fmt --check and cargo check -j ${MAX_SAFE_CARGO_JOBS}. Do not run cargo run for graphical/interactive apps unless the user explicitly approves that exact step; report it as manual validation instead. Do not mutate Project Flow lifecycle state directly; return evidence for the parent Project Flow core to record. Use only tools/skills needed for this plan; do not inherit or assume parent-only context.`,
      reads: [rel(ctx.cwd, planPath)],
      ...ponytailSkillParam(ponytailStatus),
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
    pi.sendMessage({ customType: "project-flow-agent-started", content: `# Project Flow Worker Started\n\nDisplay alias: ${identity.displayAgent}\nAlias file: ${aliasFile}\n${ponytailPromptNote(ponytailStatus)}\n\n${text}`, display: true }, { triggerTurn: false });
    return;
  }

  if (choice === "Build with GSD subagent pipeline") {
    await launchGsdContinue(pi, ctx, planPath, "Start from the current saved plan. Execute the plan-approved GSD slices for this request; do not reconcile previous GSD ledgers or inherit previous pending slices.", "fresh");
    return;

    state.phase = "build_requested";
    saveState(ctx.cwd);
    renderWidget(ctx);
    setTools(pi, ["read", "bash", "subagent", "project_flow_finish", "project_flow_context", "project_flow_list_modules", "project_flow_read_headers", "project_flow_read_signatures", "project_flow_memory_search"]);

    const planRel = rel(ctx.cwd, planPath);
    const hasEvidence = planHasUsefulSection(planBody, /^#{1,3}\s+(Planning Evidence|Evidence|Context Evidence|Research Evidence)\b/i);
    const hasSlices = planHasUsefulSection(planBody, /^#{1,3}\s+(GSD|Milestones|Slices|Tasks|Files to Modify|Implementation Plan)\b/i) || hasEvidence;
    const hasRisks = planHasUsefulSection(planBody, /^#{1,3}\s+(Risks|Risk|Assumptions|Decisions|Scope)\b/i) || hasEvidence;
    const hasValidation = planHasUsefulSection(planBody, /^#{1,3}\s+(Validation|Acceptance|Testing|Verification)\b/i) || hasEvidence;
    const preflight: any[] = [];
    if (!hasSlices) {
      preflight.push({
        agent: "scout",
        phase: "GSD planning",
        label: "Codebase slice map",
        as: "codeSlices",
        task: `[PROJECT FLOW: GSD CODEBASE SLICES]\nPlan file: ${planRel}\n\nThe saved plan does not contain enough implementation-slice/context evidence. Read the plan and follow the Codebase Reading Protocol before deeper inspection: project_flow_list_modules, project_flow_read_headers for relevant files, project_flow_read_signatures, then selective full read only if needed. Inspect only the files needed to map implementation slices. Do not modify project/source files. Return clear GSD slices: slice name, owned files, dependencies/order, likely conflicts, and first file to open for each slice.`,
        reads: [planRel],
        output: "gsd/code-slices.md",
        outputMode: "file-only",
      });
    }
    if (!hasRisks) {
      preflight.push({
        agent: "reviewer",
        phase: "GSD planning",
        label: "Plan risk and scope check",
        as: "riskPlan",
        task: `[PROJECT FLOW: GSD RISK CHECK]\nPlan file: ${planRel}\n\nThe saved plan does not contain enough risk/scope-review evidence. Review it for implementation risks before writing. Do not modify project/source files. Identify blockers, hidden decisions, scope creep risks, and smallest safe sequencing for a single writer worker.`,
        reads: [planRel],
        output: "gsd/risk-plan.md",
        outputMode: "file-only",
      });
    }
    if (!hasValidation) {
      preflight.push({
        agent: "reviewer",
        phase: "GSD planning",
        label: "Validation plan",
        as: "validationPlan",
        task: `[PROJECT FLOW: GSD VALIDATION PLAN]\nPlan file: ${planRel}\n\nThe saved plan does not contain enough validation evidence. Produce focused validation/doc/memory checks. Do not modify project/source files. Include exact commands when possible. Cargo safety: heavy Cargo commands must include -j ${MAX_SAFE_CARGO_JOBS} or lower; graphical/interactive cargo run is manual unless explicitly approved.`,
        reads: [planRel],
        output: "gsd/validation-plan.md",
        outputMode: "file-only",
      });
    }

    const planningEvidence = planSection(planBody, /^#{1,3}\s+(Planning Evidence|Evidence|Context Evidence|Research Evidence)\b/i);
    const relayedEvidence = [
      planningEvidence ? `Saved planning evidence:\n${planningEvidence}` : "",
      hasSlices ? `Saved plan slice/task evidence:\n${planSection(planBody, /^#{1,3}\s+(GSD|Milestones|Slices|Tasks|Files to Modify|Implementation Plan)\b/i) || planningEvidence}` : "Additional code-slice evidence from preflight:\n{outputs.codeSlices}",
      hasRisks ? `Saved plan risk/scope evidence:\n${planSection(planBody, /^#{1,3}\s+(Risks|Risk|Assumptions|Decisions|Scope)\b/i) || planningEvidence}` : "Additional risk/scope evidence from preflight:\n{outputs.riskPlan}",
      hasValidation ? `Saved plan validation evidence:\n${planSection(planBody, /^#{1,3}\s+(Validation|Acceptance|Testing|Verification)\b/i) || planningEvidence}` : "Additional validation evidence from preflight:\n{outputs.validationPlan}",
    ].filter(Boolean).join("\n\n");

    const gsdAutoRules = `GSD auto-mode contract:\n- Do not stop after the first slice/task. Continue through every plan-approved slice that can be completed safely.\n- Automatically fix issues directly caused by the current build work when they are bugs, missing critical correctness/security/validation, broken imports/types/config, or other blockers to completing the approved slice.\n- Make up to ${GSD_MAX_AUTOFIX_ATTEMPTS} focused auto-fix attempts for the same task/slice before deferring that local issue and moving to the next independent plan-approved slice when possible.\n- Stop only for unavoidable user validation/action, secrets/auth, package-legitimacy checks, destructive operations, unapproved product/architecture decisions, or when no independent slice can progress.\n- Record deferred issues, attempted fixes, commands, residual risks, and the exact user action needed if a stop is inevitable.\n- Final handoff must be operator-actionable: state whether the overall plan is complete, partially complete, or blocked; list completed and pending milestones/slices; list exact manual checkpoints with steps and expected results; and say the next safe instruction (for example, \"continue GSD from Milestone 2\" or \"run Manual Checkpoint A first\").`;

    const gsdAcceptance = {
      criteria: [
        "Every plan-approved slice that can be safely completed without new user decisions is attempted; the worker does not stop merely because one slice finished.",
        "Issues directly caused by the implementation are auto-fixed within the approved scope before escalating.",
        "At least three focused repair/finalization turns are available before declaring a fixable implementation/validation issue blocked.",
        "Only unavoidable user validation/action, secrets/auth, package-legitimacy checks, destructive operations, or unapproved product/architecture decisions are escalated.",
        "Changed files, validation commands/results, deferred issues, blockers, residual risks, exact manual validation steps, and the next safe user instruction are reported."
      ],
      evidence: ["changed-files", "commands-run", "validation-output", "residual-risks", "diff-summary"],
      review: { agent: "reviewer", focus: "Plan adherence, validation failures, scope creep, and fixable issues before final response." },
      stopRules: [
        "Do not expand product scope beyond the saved plan.",
        "Do not make unapproved product or architecture decisions.",
        "Do not perform destructive operations or package-manager substitutions without user approval.",
        "Stop only when human validation/action is inevitable or no independent slice can progress.",
      ],
      maxFinalizationTurns: GSD_MAX_AUTOFIX_ATTEMPTS,
    };

    const chain: any[] = [];
    if (preflight.length) chain.push({ parallel: preflight, concurrency: Math.min(3, preflight.length) });
    chain.push({
      agent: "worker",
      thinking: "medium",
      phase: "Implementation",
      label: "Single writer implementation",
      as: "workerResult",
      task: `[PROJECT FLOW: GSD SINGLE WRITER BUILD]\nPlan file: ${planRel}\n\n${gsdAutoRules}\n\nImplement only plan-approved changes. You are the sole writer for the active worktree. Use the relayed saved-plan evidence and any preflight summaries below to sequence work, but do not expand scope or make unapproved product/architecture decisions. If a blocker or unapproved decision is required and no independent plan-approved slice can progress, stop and report it. Research gate: do not use web research or researcher unless implementation is blocked by a missing external fact that repo inspection/project memory cannot answer; if so, state that fact, why local evidence is insufficient, and how it affects the build before researching. Validate with focused checks. Cargo safety: heavy Cargo commands must include -j ${MAX_SAFE_CARGO_JOBS} or lower; graphical/interactive cargo run is manual unless explicitly approved. Do not mutate Project Flow lifecycle state directly; return evidence for the parent Project Flow core to record.\n\n${relayedEvidence}`,
      reads: [planRel],
      output: "gsd/worker-result.md",
      outputMode: "file-only",
      progress: true,
      acceptance: gsdAcceptance,
    });
    chain.push({
      parallel: [
        {
          agent: "reviewer",
          phase: "Validation",
          label: "Implementation validation",
          as: "implementationValidation",
          task: `Validate the post-worker diff against the saved plan ${planRel}. Start from worker result: {outputs.workerResult}. Do not modify project/source files; returning findings through the configured output artifact is allowed. Report blockers, fixes worth doing now, independent slices that can still progress, and validation gaps.`,
          reads: [planRel],
          output: "gsd/implementation-validation.md",
          outputMode: "file-only",
        },
        {
          agent: "reviewer",
          phase: "Validation",
          label: "Scope and docs validation",
          as: "scopeDocsValidation",
          task: `Validate scope control, docs/memory needs, and regression risk after the worker result: {outputs.workerResult}. Do not modify project/source files; returning findings through the configured output artifact is allowed. Report only evidence-backed issues with file references, and distinguish must-fix-now from optional/deferred feedback.`,
          reads: [planRel],
          output: "gsd/scope-docs-validation.md",
          outputMode: "file-only",
        },
      ],
      concurrency: 2,
    });
    chain.push({
      agent: "worker",
      thinking: "medium",
      phase: "Autofix",
      label: "Apply validation fixes and continue remaining slices",
      as: "autofixResult",
      task: `[PROJECT FLOW: GSD AUTOFIX AND CONTINUE]\nPlan file: ${planRel}\n\n${gsdAutoRules}\n\nRead the initial worker result and validation artifacts. Apply only must-fix-now issues that are inside the saved plan and directly caused by the implementation. If reviewers found no must-fix-now issues, verify that no independent plan-approved slice remains unattempted; otherwise continue those remaining slices. Do not stop just because an earlier slice closed. If a reported issue needs user validation/action or an unapproved decision, defer it with exact rationale and continue any independent safe slice.\n\nInitial worker result:\n{outputs.workerResult}\n\nImplementation validation:\n{outputs.implementationValidation}\n\nScope/docs validation:\n{outputs.scopeDocsValidation}`,
      reads: [planRel],
      output: "gsd/autofix-result.md",
      outputMode: "file-only",
      progress: true,
      acceptance: gsdAcceptance,
    });
    chain.push({
      parallel: [
        {
          agent: "reviewer",
          phase: "Final validation",
          label: "Final implementation validation",
          task: `Validate the final diff against the saved plan ${planRel}. Start from worker results: {outputs.workerResult}\n\nAutofix result: {outputs.autofixResult}. Do not modify project/source files; returning findings through the configured output artifact is allowed. Report remaining blockers, whether they truly require user validation/action, any safe independent slices left unattempted, exact manual validation steps with expected results, and the next safe operator instruction.`,
          reads: [planRel],
          output: "gsd/final-implementation-validation.md",
          outputMode: "file-only",
        },
        {
          agent: "reviewer",
          phase: "Final validation",
          label: "Final scope and docs validation",
          task: `Validate final scope control, docs/memory needs, and regression risk after autofix result: {outputs.autofixResult}. Do not modify project/source files; returning findings through the configured output artifact is allowed. Report only evidence-backed must-fix blockers, precise manual follow-ups, pending plan slices/milestones, and whether the user can safely continue GSD or must validate first.`,
          reads: [planRel],
          output: "gsd/final-scope-docs-validation.md",
          outputMode: "file-only",
        },
      ],
      concurrency: 2,
    });

    const bridge = await requestSubagentBridge(pi, {
      context: "fresh",
      async: true,
      agentScope: "both",
      chain,
    });

    if (!bridge.ok) {
      state.phase = "blocked";
      state.notes = [...(state.notes ?? []), `AgentAdapter blocked GSD pipeline build: ${bridge.error}`];
      saveState(ctx.cwd);
      renderWidget(ctx);
      ctx.ui.notify(`AgentAdapter blocked GSD build: ${bridge.error}`, "error");
      pi.sendMessage({ customType: "project-flow-agent-blocked", content: agentFailureReport(ctx, planPath, bridge.error, bridge.requestId), display: true }, { triggerTurn: false });
      return;
    }

    state.phase = "building";
    saveState(ctx.cwd);
    renderWidget(ctx);
    const text = bridge.response?.result?.content?.find?.((c: any) => c.type === "text")?.text ?? "GSD subagent pipeline started.";
    ctx.ui.notify("Project Flow GSD pipeline started via AgentAdapter.", "info");
    pi.sendMessage({ customType: "project-flow-agent-started", content: `# Project Flow GSD Pipeline Started\n\n${text}`, display: true }, { triggerTurn: false });
  }
}

function gsdEvidenceFiles(cwd: string, maxFiles = 24): string[] {
  const dir = join(cwd, "gsd");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith(".md"))
    .sort()
    .slice(0, maxFiles)
    .map(name => relative(cwd, join(dir, name)));
}

function gsdPrintReport(cwd: string, planPath?: string): string {
  const evidenceFiles = gsdEvidenceFiles(cwd, 40);
  const planBody = planPath && existsSync(planPath) ? readFileSync(planPath, "utf8") : "No Project Flow plan found.";
  const preferred = [
    "gsd/resume-ledger.md",
    "gsd/next-slice-plan.md",
    "gsd/continue-result.md",
    "gsd/continue-validation.md",
    "gsd/continue-scope-validation.md",
    "gsd/worker-result.md",
    "gsd/post-gsd-fix-worker.md",
    "gsd/full-spec-gsd-inventory.md",
  ].filter(p => existsSync(join(cwd, p)));
  const rest = evidenceFiles.filter(p => !preferred.includes(p));
  const selected = [...preferred, ...rest].slice(0, 18);
  const evidenceBlocks = selected.map(p => {
    const body = readFileSync(join(cwd, p), "utf8");
    return `## ${p}\n\n${body.slice(0, 6000)}${body.length > 6000 ? "\n\n[truncated]" : ""}`;
  }).join("\n\n");
  return [
    "# Project Flow GSD Status Print",
    "",
    `Plan: ${planPath ? relative(cwd, planPath) : "none"}`,
    "",
    "## Full Saved Plan",
    "",
    planBody.slice(0, 30000) + (planBody.length > 30000 ? "\n\n[plan truncated]" : ""),
    "",
    "## GSD Evidence / Progress Files",
    "",
    evidenceFiles.length ? evidenceFiles.map(p => `- ${p}`).join("\n") : "No gsd/*.md files found.",
    "",
    evidenceBlocks || "No GSD evidence content found.",
  ].join("\n");
}

async function launchGsdContinue(pi: ExtensionAPI, ctx: ExtensionContext, planPath: string, target: string, mode: "continue" | "fresh" = "continue"): Promise<void> {
  ensureProjectFlow(ctx.cwd);
  state.phase = "build_requested";
  state.planPath = planPath;
  state.notes = [...(state.notes ?? []), mode === "continue" ? `/gsd-continue requested${target ? `: ${target}` : ""}` : `/gsd fresh build requested${target ? `: ${target}` : ""}`];
  saveState(ctx.cwd);
  renderWidget(ctx);
  setTools(pi, ["read", "bash", "subagent", "project_flow_finish", "project_flow_context", "project_flow_list_modules", "project_flow_read_headers", "project_flow_read_signatures", "project_flow_memory_search"]);

  const planRel = rel(ctx.cwd, planPath);
  const planBody = existsSync(planPath) ? readFileSync(planPath, "utf8") : "";
  const evidenceFiles = mode === "continue" ? gsdEvidenceFiles(ctx.cwd) : [];
  const evidenceText = evidenceFiles.map(p => `## ${p}\n${readFileSync(join(ctx.cwd, p), "utf8")}`).join("\n\n");
  const evidenceList = mode === "continue"
    ? (evidenceFiles.length ? evidenceFiles.map(p => `- ${p}`).join("\n") : "- No existing gsd/*.md evidence files found.")
    : "- Fresh GSD build: previous gsd/*.md evidence is intentionally ignored; the current saved plan is the source of truth.";
  const resumeTarget = target || (mode === "continue" ? "Continue from the first pending milestone/slice after reconciling existing evidence." : "Start from the current saved plan and execute its plan-approved slices without reconciling previous GSD ledgers.");
  let workerBudget = computeGsdWorkerBudget(planBody, resumeTarget, evidenceText);
  const freshPlanSliceTitles = mode === "fresh" ? extractGsdAtomicTaskTitles(planBody, GSD_MAX_CONTINUE_TASKS) : [];
  if (mode === "fresh" && workerBudget.explicitRequestedWorkerCount === undefined && freshPlanSliceTitles.length) {
    workerBudget = { ...workerBudget, pendingAutoTaskEstimate: freshPlanSliceTitles.length, workerBudget: freshPlanSliceTitles.length, rationale: `fresh saved-plan slice count: ${freshPlanSliceTitles.length}` };
  }
  const atomicTaskTitles = extractGsdAtomicTaskTitles(planBody, workerBudget.workerBudget);
  const tinyDocumentationOnly = isTinyDocumentationOnlyGsd(planBody, workerBudget);
  const ponytailStatus = detectPonytailStatus(ctx.cwd);
  const gsdRules = `${mode === "continue" ? "GSD continue contract" : "GSD fresh-plan contract"}:\n- ${mode === "continue" ? "First reconcile the saved plan and existing GSD evidence; do not redo completed milestones/slices/tasks." : "Use the current saved plan as the source of truth; do not reconcile or inherit previous GSD ledgers, previous pending slices, or previous worker budgets."}\n- Selected atomic worker budget: ${workerBudget.workerBudget}. Budget rationale: ${workerBudget.rationale}. Hard cap: ${workerBudget.hardCap}; default batch: ${workerBudget.defaultBatch}.\n- Write/update gsd/resume-ledger.md with completed, pending, blocked, manual-checkpoint, and continuation-plan items before implementation.\n- Plan a sensible dependency-ordered continuation batch before writing code: as many plan-approved atomic auto tasks as needed, but not more than the selected worker budget, before human validation/action is truly required.\n- Do not stop for deferrable human verification; record human-check/UAT items for end-of-chain review unless later work truly depends on the human result.\n- Each implementation worker executes at most one atomic task, then hands off through gsd/continue-task-XX.md; later workers start fresh and continue from the ledger plus prior task summaries.\n- Auto-fix scoped implementation/validation issues up to ${GSD_MAX_AUTOFIX_ATTEMPTS} focused attempts before marking that task blocked and allowing later independent planned tasks to progress when safe.\n- Stop only for unavoidable user validation/action, secrets/auth, package-legitimacy checks, destructive operations, unapproved product/architecture decisions, or when no independent planned task can progress.\n- Final handoff must say whether the overall plan is complete, partial, or blocked; list completed and pending milestones/slices/tasks; list deferred human-check/UAT items and blocking manual checkpoints with steps/expected results; and give the next safe operator instruction.\n- ${ponytailPromptNote(ponytailStatus)}`;
  const gsdAcceptance = {
    criteria: [
      mode === "continue" ? "Existing GSD evidence is reconciled before implementation and completed work is not redone." : "Fresh GSD execution follows the current saved plan without inheriting previous GSD ledgers, pending slices, or worker budgets.",
      "A completed/pending/blocked/manual checkpoint ledger plus sensible selected-batch continuation plan is written or updated under gsd/resume-ledger.md.",
      "The continuation plan records as many dependency-ordered plan-approved atomic auto tasks as needed, without exceeding the selected worker budget or launching unnecessary extra workers.",
      "Each implementation worker attempts at most one atomic task from the selected safe continuation batch, and later fresh workers continue from prior summaries.",
      "Scoped fixable issues are auto-fixed within the configured attempt budget before escalation.",
      "Final output includes exact validation evidence, remaining manual checks, and the next safe user instruction.",
    ],
    evidence: ["changed-files", "commands-run", "validation-output", "residual-risks", "diff-summary"],
    review: { agent: "reviewer", focus: "Resume correctness: no duplicated completed work, selected worker budget adherence, plan adherence, validation, and operator-actionable next steps." },
    stopRules: [
      mode === "continue" ? "Do not redo completed milestones/slices from existing evidence." : "Do not use previous GSD evidence as continuation state for this fresh saved-plan run.",
      "Do not expand product scope beyond the saved plan.",
      "Do not make unapproved product or architecture decisions.",
      "Stop only when human validation/action is inevitable before later planned work can safely proceed, or no planned auto task can progress.",
    ],
    maxFinalizationTurns: GSD_MAX_AUTOFIX_ATTEMPTS,
  };

  const gsdIdentitySlugs = new Set<string>();
  const resumeIdentity = makeGsdDisplayIdentity("Resume Ledger Planning", "scout", gsdIdentitySlugs);
  const atomicIdentities = Array.from({ length: workerBudget.workerBudget }, (_v, i) => {
    const fallback = `Atomic Task ${String(i + 1).padStart(2, "0")}`;
    const title = atomicTaskTitles[i] || fallback;
    return makeGsdDisplayIdentity(title, "worker", gsdIdentitySlugs);
  });
  const continueValidationIdentity = makeGsdDisplayIdentity("Continuation Chain Review", "reviewer", gsdIdentitySlugs);
  const scopeValidationIdentity = makeGsdDisplayIdentity("Scope Boundary Review", "reviewer", gsdIdentitySlugs);
  const gsdRoster = [resumeIdentity, ...atomicIdentities, continueValidationIdentity, scopeValidationIdentity];
  const gsdAliasFiles = gsdRoster.map(identity => ensureGsdDisplayAgentAlias(ctx.cwd, identity));

  const chainSummary = [
    mode === "continue" ? "# Project Flow GSD Continue Chain" : "# Project Flow Fresh Saved-Plan GSD Chain",
    "",
    `Plan: ${planRel}`,
    `Target: ${resumeTarget}`,
    "",
    mode === "continue" ? "Existing evidence that will be read:" : "Previous evidence policy:",
    evidenceList,
    "",
    "Selected worker budget:",
    `- Explicit count detected: ${workerBudget.explicitRequestedWorkerCount ?? "none"}`,
    `- Estimated pending auto tasks: ${workerBudget.pendingAutoTaskEstimate ?? "uncertain"}`,
    `- Default batch: ${workerBudget.defaultBatch}`,
    `- Hard cap: ${workerBudget.hardCap}`,
    `- Final atomic worker count: ${workerBudget.workerBudget}`,
    `- Rationale: ${workerBudget.rationale}`,
    `- Fast path: ${tinyDocumentationOnly ? "tiny documentation-only context minimization" : "standard GSD context"}`,
    "",
    "Planned atomic worker titles:",
    ...(atomicIdentities.length ? atomicIdentities.map((identity, i) => `- ${i + 1}. ${identity.taskTitle}`) : ["- none"]),
    "",
    ...ponytailPreviewLines(ponytailStatus),
    "",
    "Worker roster (TUI display aliases):",
    ...gsdRoster.map((identity, i) => `${i + 1}. ${identity.displayAgent} — slug: ${identity.slug}`),
    "",
    `Display alias files: ${gsdAliasFiles.join(", ")}`,
    "Dependency note: Project Flow writes only project-owned display aliases; pi-subagents package files are not edited.",
    "",
    "Steps that will run:",
    mode === "continue"
      ? "1. Continuation planning (scout): read the plan and existing gsd/*.md evidence; write gsd/resume-ledger.md with completed/pending/blocked/manual checkpoint status plus the selected sensible dependency-ordered atomic task batch."
      : "1. Fresh saved-plan planning (scout): read the current plan only; write gsd/resume-ledger.md with the current plan's selected dependency-ordered atomic slice batch. Previous GSD ledgers are not continuation state.",
    workerBudget.workerBudget === 0
      ? "2. Atomic task execution: 0 atomic workers selected; summary/review only, with no gsd/continue-task-XX.md no-op workers created."
      : `2. Atomic task execution: run up to ${workerBudget.workerBudget} fresh worker steps, each executing at most one planned atomic task and writing gsd/continue-task-XX.md.`,
    "3. Validation fanout (reviewers): verify no completed work was redone, no unnecessary extra workers were launched, workers followed the selected chain one atomic task at a time, validation evidence is sufficient, and deferred human checks/manual checkpoints/next steps are actionable.",
    "",
    "Stop conditions:",
    "- unavoidable user validation/action before later planned work can safely proceed, secrets/auth, package-legitimacy checks, destructive operations, unapproved product/architecture decisions, or no planned auto task can progress."
  ].join("\n");
  pi.sendMessage({ customType: "project-flow-gsd-chain-preview", content: chainSummary, display: true }, { triggerTurn: false });

  const atomicWorkerSteps = atomicIdentities.map((identity, i) => {
    const n = i + 1;
    const as = `continueTask${n}`;
    const priorOutputs = Array.from({ length: i }, (_v, j) => `## Prior atomic worker ${j + 1}\n{outputs.continueTask${j + 1}}`).join("\n\n") || `No prior atomic task workers in this ${mode === "continue" ? "/gsd-continue" : "fresh GSD"} run.`;
    return {
      agent: identity.displayAgent,
      thinking: tinyDocumentationOnly ? "low" : "medium",
      phase: "Implementation",
      label: identity.displayName,
      as,
      task: `[PROJECT FLOW: GSD ATOMIC TASK ${n}]\n${gsdIdentityPrompt(identity)}\n\nPlan file: ${planRel}\nResume target: ${resumeTarget}\nSelected atomic worker budget: ${workerBudget.workerBudget}\nBudget rationale: ${workerBudget.rationale}\nAssigned display title: ${identity.taskTitle}\nContext mode: ${tinyDocumentationOnly ? "tiny documentation-only fast path; avoid rereading full plan/evidence unless the ledger is insufficient" : "standard GSD handoff"}\n\n${gsdRules}\n\nResume ledger and continuation plan:\n{outputs.resumeLedger}\n\nPrior atomic task results:\n${priorOutputs}\n\nExecute at most ONE next atomic auto task from the selected sensible continuation batch in gsd/resume-ledger.md. Prefer the task matching your assigned display title when it is present and still pending; otherwise use the ledger and prior atomic task results to identify the first uncompleted planned task that is not blocked. Do not redo completed work. Do not execute two tasks in one worker, even if the next task is small. If no planned task remains, or all remaining tasks are blocked by prior results, write a no-op handoff saying the chain is complete or blocked and do not modify source files.\n\nDo not stop for deferrable human-check/UAT items; record them for end-of-chain review unless later work truly depends on the human result. Stop this task only at a true blocker: required user decision, auth/secret/manual action, package-legitimacy check, destructive operation, unapproved product/architecture decision, or human verification whose result is required before later work can safely proceed. If the current task is blocked but a later independent planned task can safely progress, skip the blocked task with exact rationale and execute that one independent task instead.\n\nValidate the task with focused checks before handoff. Cargo safety: heavy Cargo commands must include -j ${MAX_SAFE_CARGO_JOBS} or lower; graphical/interactive cargo run is manual unless explicitly approved. Do not mutate Project Flow lifecycle state directly; return evidence for the parent Project Flow core to record.`,
      reads: tinyDocumentationOnly ? [] : [planRel],
      output: `gsd/continue-task-${String(n).padStart(2, "0")}.md`,
      outputMode: "file-only",
      progress: true,
      ...ponytailSkillParam(ponytailStatus),
    };
  });
  const atomicTaskOutputRefs = atomicWorkerSteps.map((_step, i) => `## Atomic worker ${i + 1}\n{outputs.continueTask${i + 1}}`).join("\n\n") || `No atomic workers were selected for this ${mode === "continue" ? "/gsd-continue" : "fresh GSD"} run; validate the ledger summary/review-only path.`;

  const chain: any[] = [
    {
      agent: resumeIdentity.displayAgent,
      phase: mode === "continue" ? "Continuation planning" : "Fresh plan slicing",
      label: resumeIdentity.displayName,
      as: "resumeLedger",
      task: `[PROJECT FLOW: ${mode === "continue" ? "GSD RESUME + CONTINUATION PLAN" : "GSD FRESH SAVED-PLAN SLICE PLAN"}]\n${gsdIdentityPrompt(resumeIdentity)}\n\nPlan file: ${planRel}\nResume target: ${resumeTarget}\nSelected atomic worker budget: ${workerBudget.workerBudget}\nBudget rationale: ${workerBudget.rationale}\n${ponytailPromptNote(ponytailStatus)}\n\n${mode === "continue" ? "Existing evidence files" : "Previous evidence policy"}:\n${evidenceList}\n\n${mode === "continue" ? "Read the saved plan and existing GSD evidence." : "Read the current saved plan. Do not read or infer continuation state from previous gsd/*.md artifacts unless the current plan explicitly cites them as planning evidence."} Do not modify source files. Produce and write an operator-actionable gsd/resume-ledger.md that includes:\n1. completed/already-satisfied work from the current saved plan's own evidence,\n2. pending work for the current requested scope,\n3. blocked/manual checkpoints with exact validation steps and expected results,\n4. deferred human-check/UAT items that do NOT block further automation, and\n5. a \"Selected Sensible Continuation Batch\" section capped at the selected atomic worker budget.\n\nFor the continuation batch, plan as many dependency-ordered, plan-approved atomic auto tasks as needed, but not more than ${workerBudget.workerBudget}, before human validation/action is truly required. If the selected budget is 0, write the ledger as summary/review-only and do not invent no-op worker tasks. Prefer chaining dependent tasks sequentially over stopping early, but keep task boundaries atomic: one clear change, owned/shared files, validation, done condition, and handoff evidence. Only stop the chain at a true blocker: required user decision, auth/secret/manual action, package-legitimacy check, destructive operation, unapproved product/architecture decision, or human verification whose result is required before later work can safely proceed. If evidence is ambiguous, mark it uncertain rather than redoing work.`,
      reads: [planRel, ...evidenceFiles],
      output: "gsd/resume-ledger.md",
      outputMode: "file-only",
      progress: true,
    },
    ...atomicWorkerSteps,
    {
      parallel: [
        {
          agent: continueValidationIdentity.displayAgent,
          phase: "Validation",
          label: continueValidationIdentity.displayName,
          as: "continueValidation",
          task: `[PROJECT FLOW: GSD VALIDATION]\n${gsdIdentityPrompt(continueValidationIdentity)}\n\nValidate the resumed GSD work against ${planRel}. Selected atomic worker budget: ${workerBudget.workerBudget}. Budget rationale: ${workerBudget.rationale}. ${ponytailPromptNote(ponytailStatus)} Start from resume ledger and continuation plan: {outputs.resumeLedger}\n\nAtomic worker results:\n${atomicTaskOutputRefs}. Do not modify project/source files. Verify completed work was not redone, no unnecessary extra workers were launched, each worker executed at most one planned atomic task, workers followed the selected sensible continuation batch, pending work is accurately marked, validation evidence is sufficient, and deferred human checks/blockers/manual checkpoints are exact and actionable.`,
          reads: [planRel],
          output: "gsd/continue-validation.md",
          outputMode: "file-only",
          progress: true,
        },
        {
          agent: scopeValidationIdentity.displayAgent,
          phase: "Validation",
          label: scopeValidationIdentity.displayName,
          as: "continueScopeValidation",
          task: `[PROJECT FLOW: GSD SCOPE REVIEW]\n${gsdIdentityPrompt(scopeValidationIdentity)}\n\nValidate scope control, selected worker budget adherence, and manual checkpoint clarity after resumed GSD work. Selected atomic worker budget: ${workerBudget.workerBudget}. Budget rationale: ${workerBudget.rationale}. ${ponytailPromptNote(ponytailStatus)} Start from resume ledger and continuation plan: {outputs.resumeLedger}\n\nAtomic worker results:\n${atomicTaskOutputRefs}. Do not modify project/source files. Report whether the continuation planning chained the needed safe work without exceeding the selected budget, whether fresh workers respected atomic task boundaries, whether the user can safely run /gsd-continue again, must perform manual validation first, or the overall plan is complete.`,
          reads: [planRel],
          output: "gsd/continue-scope-validation.md",
          outputMode: "file-only",
          progress: true,
        },
      ],
      concurrency: 2,
    },
  ];

  const bridge = await requestSubagentBridge(pi, {
    context: "fresh",
    async: true,
    agentScope: "both",
    chain,
  });

  if (!bridge.ok) {
    state.phase = "blocked";
    state.notes = [...(state.notes ?? []), `AgentAdapter blocked /gsd-continue: ${bridge.error}`];
    saveState(ctx.cwd);
    renderWidget(ctx);
    ctx.ui.notify(`Project Flow /gsd-continue blocked: ${bridge.error}`, "error");
    pi.sendMessage({ customType: "project-flow-agent-blocked", content: agentFailureReport(ctx, planPath, bridge.error, bridge.requestId), display: true }, { triggerTurn: false });
    return;
  }

  state.phase = "building";
  saveState(ctx.cwd);
  renderWidget(ctx);
  const text = bridge.response?.result?.content?.find?.((c: any) => c.type === "text")?.text ?? (mode === "continue" ? "GSD continue pipeline started." : "Fresh GSD pipeline started.");
  ctx.ui.notify(mode === "continue" ? "Project Flow /gsd-continue pipeline started." : "Project Flow fresh GSD pipeline started.", "info");
  pi.sendMessage({ customType: "project-flow-agent-started", content: `# ${mode === "continue" ? "Project Flow GSD Continue Started" : "Project Flow Fresh GSD Started"}\n\nPlan: ${planRel}\nTarget: ${resumeTarget}\nSelected atomic workers: ${workerBudget.workerBudget}\nBudget rationale: ${workerBudget.rationale}\n${ponytailPromptNote(ponytailStatus)}\n\n${text}`, display: true }, { triggerTurn: false });
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
        "latest-plan": state.planPath,
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
          content: [{ type: "text", text: `Project Flow plan not saved yet. grillResolutionSummary was omitted after ${grillRounds.length} answered grill round(s). Re-sweep the potential plan with the captured answers, then call project_flow_save_plan with a grillResolutionSummary that explains how every grill answer changed or confirmed the plan.\n\n${sessionNotesContext(ctx.cwd)}` }],
          isError: true,
          details: { reason: "missing_grill_resolution_summary", grillRoundCount: grillRounds.length },
        };
      }
      if (grillRounds.length && params.grillResolutionSummary?.trim()) {
        const missingRefs = grillResolutionMissingRefs(params.grillResolutionSummary);
        if (missingRefs.length) {
          return {
            content: [{ type: "text", text: `Project Flow plan not saved yet. grillResolutionSummary does not appear to reference every answered grill question. Missing apparent references: ${missingRefs.join("; ")}\n\nRevise the potential plan with all grill answers, re-sweep blockers, and summarize how each answer was incorporated.\n\n${sessionNotesContext(ctx.cwd)}` }],
            isError: true,
            details: { reason: "incomplete_grill_resolution_summary", missingRefs },
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
      const grillSummary = params.grillResolutionSummary?.trim();
      const grillLog = grillAnswerLog();
      const grillBlock = grillSummary || grillLog
        ? `\n\n## Grill Resolution\n\n${grillSummary || "See the persisted Grill Answer Log below."}\n${grillLog ? `\n\n${grillLog}\n` : ""}`
        : "";
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
        [join(sourceRoot, ".pi/project-flow/welcome-art.md"), join(ctx.cwd, ".pi/project-flow/welcome-art.md")],
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
          const ponytailStatus = detectPonytailStatus(ctx.cwd);
          const identity = makeGsdDisplayIdentity("Self Validation Build", "worker", new Set<string>());
          ensureProjectFlowDisplayAgentAlias(ctx.cwd, identity);
          const worker = await requestSubagentBridge(pi, withModel({
            agent: identity.displayAgent,
            thinking: "medium",
            task: `${gsdIdentityPrompt(identity)}\n\n${ponytailPromptNote(ponytailStatus)}\n\nProject Flow self-validation build test running in ${expectedCwd}. Create or overwrite only ${outRel} with exactly: hello from project-flow self-validation. Do not touch other files. Then verify the file exists and report evidence.`,
            ...ponytailSkillParam(ponytailStatus),
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
      const ponytailStatus = detectPonytailStatus(ctx.cwd);
      const identity = makeGsdDisplayIdentity("Confined E2E Build", "worker", new Set<string>());
      ensureProjectFlowDisplayAgentAlias(ctx.cwd, identity);
      const bridge = await requestSubagentBridge(pi, withModel({
        agent: identity.displayAgent,
        thinking: "medium",
        task: `${gsdIdentityPrompt(identity)}\n\n${ponytailPromptNote(ponytailStatus)}\n\nProject Flow E2E confined build in ${expectedCwd}. Read plan ${rel(ctx.cwd, planPath)}. Create or overwrite only ${outRel} with exactly: project-flow e2e ok. Do not touch other files. Verify file exists and report evidence.`,
        reads: [rel(ctx.cwd, planPath)],
        ...ponytailSkillParam(ponytailStatus),
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

  pi.registerCommand("gsd-continue", {
    description: "Resume/continue the GSD subagent pipeline from the active or latest Project Flow plan without redoing completed evidence",
    handler: async (args, ctx) => {
      ensureProjectFlow(ctx.cwd);
      const loaded = latestSession(ctx.cwd);
      if (loaded) state = loaded;
      const raw = args.trim();
      const first = raw.split(/\s+/)[0] || "";
      const candidatePath = first ? (first.startsWith("/") ? first : join(ctx.cwd, first)) : "";
      const planPath = candidatePath && existsSync(candidatePath)
        ? candidatePath
        : state.planPath || latestFile(ctx.cwd, PLANS_DIR, ".md");
      if (!planPath || !existsSync(planPath)) {
        ctx.ui.notify("No Project Flow plan found for /gsd-continue. Run /plan first or pass a plan path.", "warning");
        pi.sendMessage({ customType: "project-flow-gsd-continue", content: "# Project Flow GSD Continue\n\nNo saved Project Flow plan was found. Run `/plan <task>` first, or pass a plan path: `/gsd-continue .pi/project-flow/plans/<plan>.md`.", display: true }, { triggerTurn: false });
        return;
      }
      const target = candidatePath && existsSync(candidatePath) ? raw.slice(first.length).trim() : raw;
      await launchGsdContinue(pi, ctx, planPath, target);
    },
  });

  pi.registerCommand("gsd", {
    description: "Start a fresh GSD run for the active Project Flow plan; use /gsd-continue to reconcile previous GSD evidence",
    handler: async (args, ctx) => {
      ensureProjectFlow(ctx.cwd);
      const loaded = latestSession(ctx.cwd);
      if (loaded) state = loaded;
      const raw = args.trim();
      const first = raw.split(/\s+/)[0] || "";
      const candidatePath = first ? (first.startsWith("/") ? first : join(ctx.cwd, first)) : "";
      const planPath = candidatePath && existsSync(candidatePath)
        ? candidatePath
        : state.planPath;
      if (!planPath || !existsSync(planPath)) {
        ctx.ui.notify("No active Project Flow plan found for /gsd. Run /plan first, choose GSD after saving, or pass a plan path.", "warning");
        pi.sendMessage({ customType: "project-flow-gsd", content: "# Project Flow GSD\n\nNo active Project Flow plan was found. Run `/plan <task>` first, or pass a plan path for a fresh saved-plan GSD run: `/gsd .pi/project-flow/plans/<plan>.md`. Use `/gsd-continue` when you intentionally want to reconcile previous GSD evidence.", display: true }, { triggerTurn: false });
        return;
      }
      const target = candidatePath && existsSync(candidatePath) ? raw.slice(first.length).trim() : raw;
      await launchGsdContinue(pi, ctx, planPath, target || "Start from the current saved plan. Execute its plan-approved slices; do not reconcile previous GSD ledgers.", "fresh");
    },
  });

  pi.registerCommand("gsd-print", {
    description: "Print current GSD progress/evidence and the rest of the saved Project Flow plan without launching workers",
    handler: async (args, ctx) => {
      ensureProjectFlow(ctx.cwd);
      const loaded = latestSession(ctx.cwd);
      if (loaded) state = loaded;
      const raw = args.trim();
      const candidatePath = raw ? (raw.startsWith("/") ? raw : join(ctx.cwd, raw)) : "";
      const planPath = candidatePath && existsSync(candidatePath)
        ? candidatePath
        : state.planPath || latestFile(ctx.cwd, PLANS_DIR, ".md");
      const report = gsdPrintReport(ctx.cwd, planPath);
      pi.sendMessage({ customType: "project-flow-gsd-print", content: report, display: true }, { triggerTurn: false });
      ctx.ui.notify("Project Flow GSD status printed; no workers launched.", "info");
    },
  });

  pi.registerCommand("gsd-print-status", {
    description: "Alias for /gsd-print",
    handler: async (args, ctx) => {
      ensureProjectFlow(ctx.cwd);
      const loaded = latestSession(ctx.cwd);
      if (loaded) state = loaded;
      const raw = args.trim();
      const candidatePath = raw ? (raw.startsWith("/") ? raw : join(ctx.cwd, raw)) : "";
      const planPath = candidatePath && existsSync(candidatePath)
        ? candidatePath
        : state.planPath || latestFile(ctx.cwd, PLANS_DIR, ".md");
      const report = gsdPrintReport(ctx.cwd, planPath);
      pi.sendMessage({ customType: "project-flow-gsd-print", content: report, display: true }, { triggerTurn: false });
      ctx.ui.notify("Project Flow GSD status printed; no workers launched.", "info");
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
      const planningReason = planningCommandReason(command);
      if (planningReason) return { block: true, reason: planningReason };
      if (!isSafeReadOnlyBash(command)) {
        return { block: true, reason: "Project Flow planning permits only read-only shell inspection before build approval." };
      }
    }
    if (event.toolName === "subagent") {
      const reason = planningSubagentReason((event as any).input);
      if (reason) return { block: true, reason };
    }
  });
}
