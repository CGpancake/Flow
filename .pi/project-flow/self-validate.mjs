#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const EXPECTED_CWD = (process.env.PI_PROJECT_FLOW_VALIDATION_CWD || process.env.PI_PROJECT_FLOW_TEST_CWD || process.cwd()).replace(/\\/g, '/').replace(/\/+$/, '');
const ROOT = '.pi/project-flow';
const SELF_TEST = `${ROOT}/self-test`;
const EXTENSION = '.pi/extensions/project-flow/index.ts';
const THEME = '.pi/themes/relay-concrete-dim.json';
const SETTINGS = '.pi/settings.json';
const DEV_EXTENSION = process.env.PI_PROJECT_FLOW_DEV_ROOT
  ? join(process.env.PI_PROJECT_FLOW_DEV_ROOT, EXTENSION)
  : ''; 

const cwd = process.cwd().replace(/\\/g, '/').replace(/\/+$/, '');
const checks = [];
function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
}
function readIf(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
function latestFile(dir, suffix) {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter(f => f.endsWith(suffix)).sort().reverse();
  return files[0] ? join(dir, files[0]) : undefined;
}

record('validation cwd', cwd.toLowerCase() === EXPECTED_CWD.toLowerCase(), `cwd=${cwd}; expected=${EXPECTED_CWD}`);
mkdirSync(ROOT, { recursive: true });
rmSync(SELF_TEST, { recursive: true, force: true });
mkdirSync(SELF_TEST, { recursive: true });
record('self-test directory cleaned', existsSync(SELF_TEST), SELF_TEST);

for (const dir of [ROOT, `${ROOT}/memory`, `${ROOT}/plans`, `${ROOT}/sessions`]) {
  mkdirSync(dir, { recursive: true });
  record(`directory exists ${dir}`, existsSync(dir));
}

const ext = readIf(EXTENSION);
const theme = readIf(THEME);
const settings = readIf(SETTINGS);
record('extension present', ext.length > 1000, EXTENSION);
record('relay concrete dim theme present', /"name":\s*"relay-concrete-dim"/.test(theme) && /#222120/.test(theme) && /#F5C400/.test(theme), THEME);
record('project settings selects relay theme', /"theme":\s*"relay-concrete-dim"/.test(settings), SETTINGS);
record('no old Project Flow private package path', !/Pi_Project_Flow|C:\\Users\\user\\Pi_Project_Flow/.test(ext));
record('no old private subagent rpc events', !/subagents:rpc:(spawn|ping)/.test(ext));
record('uses public pi-subagents slash bridge', /subagent:slash:request/.test(ext) && /subagent:slash:response/.test(ext));
record('has defensive sendUserMessage queueing', /deliverAs:\s*"followUp"/.test(ext) && /streamingBehavior:\s*"followUp"/.test(ext));
record('has lazy context tool', /name:\s*"project_flow_context"/.test(ext));
record('has reading protocol tools', /project_flow_list_modules/.test(ext) && /project_flow_read_headers/.test(ext) && /project_flow_read_signatures/.test(ext));
record('has memory search tool', /project_flow_memory_search/.test(ext));
record('has grill question tool', /name:\s*"project_flow_grill_question"/.test(ext));
record('has grill cycle tool', /name:\s*"project_flow_grill_cycle"/.test(ext));
record('has finish lifecycle tool', /name:\s*"project_flow_finish"/.test(ext));
record('has self validation command', /registerCommand\("pf-self-validate"/.test(ext));
record('has reload-flow helper command', /registerCommand\("reload-flow"/.test(ext));
record('has confined lifecycle e2e command', /registerCommand\("pf-e2e"/.test(ext));
record('reload-flow copies relay theme', /relay-concrete-dim\.json/.test(ext));
record('reload-flow sets project theme', /updateProjectThemeSetting/.test(ext) && /settings\.theme\s*=\s*"relay-concrete-dim"/.test(ext));
record('validation cwd is configurable', /PI_PROJECT_FLOW_VALIDATION_CWD/.test(ext) && /function validationCwd/.test(ext));
record('planning startup uses compact memoryContext', /const context = memoryContext\(ctx\.cwd\)/.test(ext));
record('all command sendUserMessage calls are queued', !/[^.]\bpi\.sendUserMessage\(/.test(ext), 'direct pi.sendUserMessage should not be used outside queueUserMessage');
for (const label of [
  'Build now in this session',
  'Compact handoff / build after compact',
  'Build in fresh subagent worker',
  'Stop process / no build',
]) {
  record(`post-plan option present: ${label}`, ext.includes(`"${label}"`));
}
for (const label of [
  'Read plan only / do not build yet',
  'Refine plan / answer questions',
  'Cancel / mark blocked',
]) {
  record(`post-plan option removed: ${label}`, !ext.includes(`"${label}"`));
}
record('plan-continue reopens post-plan selector', /\["plan_ready", "build_requested", "building", "validating"\]\.includes\(state\.phase\)[\s\S]*await chooseAfterPlan\(pi, ctx, latestPlanPath\)/.test(ext));
record('stop process does not start a build', /Stop process \/ no build/.test(ext) && /stopPostPlanProcess/.test(ext));
record('subagent build is bridge-mediated', /requestSubagentBridge\(pi, withModel\(\{[\s\S]*agent:\s*identity\.displayAgent[\s\S]*async:\s*true/.test(ext));
record('foreground e2e worker is bridge-mediated', /requestSubagentBridge\(pi, withModel\(\{[\s\S]*agent:\s*identity\.displayAgent[\s\S]*async:\s*false/.test(ext));
record('grill rules included in plan prompt', /Use the Grill rules/.test(ext) && /project_flow_grill_question/.test(ext));
record('grill captures recommendation alternatives and context', /Recommended:/.test(ext) && /Alternative/.test(ext) && /Additional context/.test(ext));
record('grill loop requires revision before final plan', /Grill loop requirement/.test(ext) && /grillResolutionSummary/.test(ext));
record('grill flow sweeps blocker queue before and after answers', /blocker queue/.test(ext) && /re-sweep/.test(ext) && /blockerAnalysisSummary/.test(ext));
record('grill keeps independent ambiguities as separate concise questions', /Do not merge independent ambiguities/.test(ext) && /one concise/.test(ext) && /related blockers/.test(ext));
record('grill cycle supports responsive precomputed queues', /project_flow_grill_cycle/.test(ext) && /precompute the current grill-cycle queue/.test(ext) && /Project Flow Grill Cycle/.test(ext));
record('grill queue state is deterministic', /blockerQueue/.test(ext) && /currentGrillCycle/.test(ext) && /recordAnsweredBlocker/.test(ext));
record('grill merge guard is present', /grillMergeWarning/.test(ext) && /independent ambiguities/.test(ext));
record('grill answers are persisted and surfaced on continue', /grillRounds/.test(ext) && /sessionNotesContext/.test(ext) && /Grill Rounds Answered/.test(ext));
record('planning prompts are function-built', /function planningPrompt/.test(ext) && /function continuePrompt/.test(ext) && /projectFlowPlanningRules/.test(ext));
record('planning mode blocks validation/test execution', /planningCommandReason/.test(ext) && /Planning mode is planning only/.test(ext) && /must not run test\/build\/validation commands/.test(ext));
record('planning subagents are read-only only', /planningSubagentReason/.test(ext) && /worker\/validator execution/.test(ext));
record('GSD continue default cap is 15 atomic workers', /PI_PROJECT_FLOW_GSD_MAX_CONTINUE_TASKS \|\| "15"/.test(ext) && /Math\.min\(15/.test(ext));
record('initial GSD build uses atomic continue chain', /Build with GSD subagent pipeline[\s\S]*launchGsdContinue\(pi, ctx, planPath/.test(ext));
record('plan prompt requires fresh-worker-sized tasks', /small enough for fresh worker sessions/.test(ext) && /break it down further before saving the plan/.test(ext));
record('plan save rejects omitted blocker analysis', /missing_blocker_analysis_summary/.test(ext));
record('plan save rejects omitted grill resolution summary', /missing_grill_resolution_summary/.test(ext));
record('plan save rejects incomplete grill summaries', /incomplete_grill_resolution_summary/.test(ext) && /grillResolutionMissingRefs/.test(ext));
record('plan save rejects obvious unresolved build-ready language', /build_ready_contains_unresolved_language/.test(ext) && /obviousUnresolvedLanguage/.test(ext));
record('ambiguous prompt lazy context guidance included', /For ambiguous prompts, use project_flow_context/.test(ext) && /relevant lazy context/.test(ext));
record('plan prompt enforces codebase reading protocol', /Codebase Reading Protocol/.test(ext) && /project_flow_list_modules/.test(ext));
record('plan prompt prefers memory search', /project_flow_memory_search for long-term memory/.test(ext));
record('finish required after existing-context build', /call project_flow_finish with status complete or failed/.test(ext));
record('model routing is configurable, not hardcoded', /PI_PROJECT_FLOW_WORKER_MODEL/.test(ext) && /withModel/.test(ext));
record('subagent plan handoff uses reads', /reads:\s*\[rel\(ctx\.cwd, planPath\)\]/.test(ext));
record('GSD worker aliases request ponytail only for workers', /worker:[\s\S]*skills: ponytail/.test(ext) && !/scout:[\s\S]*skills: ponytail[\s\S]*worker:/.test(ext) && !/reviewer:[\s\S]*skills: ponytail/.test(ext));
record('planning bash is guarded read-only', /isSafeReadOnlyBash/.test(ext) && /Project Flow planning permits only read-only shell inspection/.test(ext));
record('cargo build safety guard present', /MAX_SAFE_CARGO_JOBS/.test(ext) && /cargoSafetyReason/.test(ext) && /explicit job limit/.test(ext));
record('cargo run guarded for graphical apps', /PI_PROJECT_FLOW_ALLOW_CARGO_RUN=1/.test(ext) && /will not auto-run graphical\/interactive Cargo apps/.test(ext));
record('draft or blocked plans withhold build choices', /normalizedStatus/.test(ext) && /build choices withheld/.test(ext));
record('plan review is displayed before choices', /project-flow-plan-review/.test(ext) && /Project Flow Plan Review/.test(ext));
record('unresolved questions withhold build choices', /unresolvedQuestions/.test(ext) && /Blocking Questions/.test(ext));
record('major assumptions are blocking in plan prompt', /choosing a major framework\/engine not named by the user/.test(ext));
record('web research required when dependencies materially affect plan', /web\/current docs would materially affect dependency\/framework choice/.test(ext));

if (DEV_EXTENSION && existsSync(DEV_EXTENSION)) {
  const dev = readFileSync(DEV_EXTENSION, 'utf8').replace(/\r\n/g, '\n');
  const test = ext.replace(/\r\n/g, '\n');
  record('test extension matches dev source', dev === test, `${EXTENSION} vs ${DEV_EXTENSION}`);
}

const planPath = join(`${ROOT}/plans`, `${new Date().toISOString().slice(0, 10)}-self-validation-loop.md`);
writeFileSync(planPath, `---\ntype: project-flow-plan\nstatus: self-validation\ncreated: ${new Date().toISOString()}\ntitle: Self Validation Loop\n---\n\n# Self Validation Loop\n\nValidated by .pi/project-flow/self-validate.mjs.\n`, 'utf8');
record('plan persistence write', existsSync(planPath), planPath);

const artifact = join(SELF_TEST, 'hello.txt');
writeFileSync(artifact, 'hello from project-flow self-validation\n', 'utf8');
record('self-test artifact write', existsSync(artifact), artifact);

const sessionDir = `${ROOT}/sessions`;
const report = [
  '# Project Flow Self-Validation Loop Report',
  '',
  `Created: ${new Date().toISOString()}`,
  `CWD: ${cwd}`,
  '',
  ...checks.map(c => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`),
  '',
  `Latest plan: ${latestFile(`${ROOT}/plans`, '.md') ?? 'none'}`,
].join('\n') + '\n';
const reportPath = join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-self-validation-loop.md`);
writeFileSync(reportPath, report, 'utf8');

console.log(report);
console.log(`Report: ${relative(cwd, reportPath)}`);
const failed = checks.filter(c => !c.ok);
process.exitCode = failed.length ? 1 : 0;
