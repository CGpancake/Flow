// Pure plan/run helpers for lean-flow. Entry points: branchSlug, tasksFromPlanText, parseTracks, reviewVerdict.
// No Pi imports so tests/*.test.ts can run under plain `node --test`.

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
const STATUS_MARKER: Record<TrackStatus, string> = { pending: " ", started: "-", completed: "x" };

function issueStatus(marker: string): TrackStatus {
	return MARKER_STATUS[marker.toLowerCase()] ?? "pending";
}

function linesOf(text: string): string[] {
	return text.split(/\r?\n/);
}

function eolOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
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

type IssueRef = number | string | Pick<TrackIssue, "text">;

function matchesIssue(text: string, index: number, ref: IssueRef): boolean {
	if (typeof ref === "number") return index === ref;
	return text === (typeof ref === "string" ? ref : ref.text);
}

// Change one marker only; the issue text, its detail lines, and every other line stay byte-identical.
export function setIssueStatus(text: string, trackName: string, issueRef: IssueRef, status: TrackStatus): string {
	const lines = linesOf(text);
	let track: string | undefined;
	let seen = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const heading = line.match(TRACK_HEADING);
		if (heading) {
			track = heading[1]!.trim();
			continue;
		}
		const found = track === trackName.trim() && line.match(TRACK_ISSUE);
		if (!found) continue;
		const issueText = found[3]!.replace(/^\]\s+/, "").trim();
		if (!matchesIssue(issueText, seen++, issueRef)) continue;
		lines[index] = found[1]! + STATUS_MARKER[status] + found[3]!;
		return lines.join(eolOf(text));
	}
	return text;
}

// Append a pending issue after the track's last issue/detail block. Unknown tracks are left untouched.
export function appendIssue(text: string, trackName: string, issueText: string, detail = ""): string {
	const lines = linesOf(text);
	const heading = lines.findIndex((line) => line.match(TRACK_HEADING)?.[1]?.trim() === trackName.trim());
	if (heading < 0) return text;
	let insert = heading + 1;
	for (let index = heading + 1; index < lines.length; index++) {
		const line = lines[index]!;
		if (TRACK_HEADING.test(line)) break;
		if (TRACK_ISSUE.test(line)) insert = index + 1;
		else if (insert > heading + 1 && TRACK_DETAIL.test(line)) insert = index + 1;
	}
	const added = [`- [ ] ${issueText.trim()}`, ...detail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => `  ${line}`)];
	lines.splice(insert, 0, ...added);
	return lines.join(eolOf(text));
}

// Drop fully completed tracks and completed issues plus their detail blocks; unrelated lines stay as-is.
export function clearCompleted(text: string): string {
	const lines = linesOf(text);
	const out: string[] = [];
	for (let start = 0; start < lines.length; ) {
		const isTrack = TRACK_HEADING.test(lines[start]!);
		let end = start + 1;
		while (end < lines.length && !TRACK_HEADING.test(lines[end]!)) end++;
		const block = lines.slice(start, end);
		const issueLines = block.slice(isTrack ? 1 : 0).filter((line) => /^\s*-\s+\[[ xX-]\]\s+/.test(line));
		if (isTrack && issueLines.length && issueLines.every((line) => /^\s*-\s+\[[xX]\]\s+/.test(line))) {
			start = end;
			continue;
		}
		if (isTrack) out.push(block[0]!);
		let skipDetail = false;
		for (const line of block.slice(isTrack ? 1 : 0)) {
			if (TRACK_ISSUE.test(line)) {
				skipDetail = /^\s*-\s+\[[xX]\]\s+/.test(line);
				if (!skipDetail) out.push(line);
				continue;
			}
			if (skipDetail && TRACK_DETAIL.test(line)) continue;
			skipDetail = false;
			out.push(line);
		}
		start = end;
	}
	return out.join(eolOf(text));
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
		const issue = planStep.detail.match(/^[ \t]*(?:-[ \t]+)?Issue:[ \t]*(.+)$/im)?.[1]?.trim();
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
