// Research-only (Prime Runtime Conformance v0). Scenario invariants: what each scenario's evidence must show for the
// experiment to have demonstrably happened. Completing without an exception is not enough: a fork scenario that never
// forked, or a reopen that reopened nothing, must not become evidence. The live probe records violations as failures,
// and the report re-checks committed fixtures with the same rules.
//
// Invariants check that an operation occurred, never what Prime answered: a valid observation of unexpected Prime
// behavior (e.g. a tool error Prime does not flag) is conformance evidence, not an invalid run.
import { PROBE_MODEL, PROBE_PROVIDER } from "./environment.ts";
import type { PrimeScenarioEvidenceV0 } from "./evidence.ts";

type Invariant = (run: PrimeScenarioEvidenceV0) => string[];

function stats(...labels: string[]): Invariant {
	return (run) =>
		labels.flatMap((label) => (run.stats.some((item) => item.label === label) ? [] : [`missing stats "${label}"`]));
}

function succeeded(command: string, times = 1): Invariant {
	return (run) => {
		const count = run.commands.filter((item) => item.command === command && item.success === true).length;
		return count === times ? [] : [`expected ${times} successful ${command}, observed ${count}`];
	};
}

function runs(count: number): Invariant {
	return (run) => {
		const starts = run.events.filter((event) => event.type === "agent_start").length;
		const ends = run.events.filter((event) => event.type === "agent_end").length;
		return starts === count && ends === count
			? []
			: [`expected ${count} complete runs, observed ${starts} starts and ${ends} ends`];
	};
}

function observed(...keys: (keyof PrimeScenarioEvidenceV0["observations"])[]): Invariant {
	return (run) => keys.flatMap((key) => (run.observations[key] === undefined ? [`missing observation ${key}`] : []));
}

function toolExecuted(): Invariant {
	return (run) =>
		run.events.some((event) => event.type === "tool_execution_end") ? [] : ["no tool execution completed"];
}

function abortRequested(after: "assistant-start" | "tool-start"): Invariant {
	return (run) => {
		const [index, ...rest] = run.abortRequestedAfter;
		if (index === undefined || rest.length > 0)
			return [`expected one abort request, observed ${run.abortRequestedAfter.length}`];
		const trigger = run.events[index];
		const matches =
			after === "tool-start"
				? trigger?.type === "tool_execution_start"
				: trigger?.type === "message_start" && trigger.role === "assistant";
		return matches ? [] : [`abort was not requested at the ${after}`];
	};
}

/** Only the explicitly expected refusal may appear, and only with the queued-input category. */
function refusals(expected: number): Invariant {
	return (run) => {
		const failed = run.commands.filter((item) => item.success !== true);
		return [
			...(failed.length === expected ? [] : [`expected ${expected} refused command(s), observed ${failed.length}`]),
			...failed.flatMap((item) =>
				item.command === "prompt" && item.errorKind === "queued-input-suspended"
					? []
					: [`unexpected refusal of ${item.command} (${item.errorKind ?? "no category"})`],
			),
		];
	};
}

function sessionFileRead(): Invariant {
	return (run) => (run.sessionEntries[0]?.type === "session" ? [] : ["session file was not read from its header"]);
}

/** After compaction the file holds exactly the pre-compaction entries, unchanged, plus one compaction entry. */
function compactionSnapshots(): Invariant {
	return (run) => {
		const before = run.entrySnapshots.find((snapshot) => snapshot.label === "before-compaction");
		const after = run.entrySnapshots.find((snapshot) => snapshot.label === "after-compaction");
		if (before === undefined || after === undefined) return ["missing compaction snapshots"];
		const prefixKept = before.entries.every(
			(entry, index) => JSON.stringify(after.entries[index]) === JSON.stringify(entry),
		);
		const added = after.entries.slice(before.entries.length);
		const end = run.events.find((event) => event.type === "compaction_end");
		return [
			...(prefixKept ? [] : ["pre-compaction entries changed across compaction"]),
			...(added.length === 1 && added[0]?.type === "compaction"
				? []
				: [
						`expected exactly one new entry, a compaction, observed ${added.map((entry) => entry.type).join(", ") || "none"}`,
					]),
			...(end?.type === "compaction_end" && end.succeeded && !end.aborted
				? []
				: ["no successful compaction_end was observed"]),
		];
	};
}

/**
 * Forking leaves the original file unchanged (a row appended there would be spend the evidence drops), and the fork
 * copies exactly the original's entries before the latest user message, the intended target.
 */
function forkSnapshots(): Invariant {
	return (run) => {
		const before = run.entrySnapshots.find((snapshot) => snapshot.label === "fork-original-before")?.entries;
		const after = run.entrySnapshots.find((snapshot) => snapshot.label === "fork-original-after")?.entries;
		if (before === undefined || after === undefined) return ["missing fork snapshots"];
		const target = before.findLastIndex((entry) => entry.type === "message" && entry.role === "user");
		const expected = before
			.slice(0, Math.max(target, 0))
			.flatMap((entry) => (entry.type === "session" ? [] : [entry.id]));
		const originalIds = new Set(before.map((entry) => entry.id));
		const copied = run.sessionEntries.flatMap((entry) =>
			entry.type !== "session" && originalIds.has(entry.id) ? [entry.id] : [],
		);
		return [
			...(JSON.stringify(after) === JSON.stringify(before)
				? []
				: ["the original session file changed across the fork"]),
			...(target > 0 && JSON.stringify(copied) === JSON.stringify(expected)
				? []
				: ["the fork did not copy exactly the entries before the latest user message"]),
		];
	};
}

/** Every assistant message came from the probe's deterministic model, never another provider or model. */
function probeModel(): Invariant {
	return (run) =>
		run.events.some(
			(event) =>
				(event.type === "message_end" || event.type === "turn_end") &&
				event.assistant !== undefined &&
				(event.assistant.provider !== PROBE_PROVIDER || event.assistant.model !== PROBE_MODEL),
		)
			? ["an assistant message came from another provider or model"]
			: [];
}

const COMMON: Invariant[] = [sessionFileRead(), observed("providerRequests"), probeModel()];

const INVARIANTS: Readonly<Record<string, readonly Invariant[]>> = {
	simple: [runs(1), stats("after"), refusals(0)],
	"tool-run": [runs(1), stats("after"), toolExecuted(), refusals(0)],
	"tool-error": [runs(1), stats("after"), toolExecuted(), refusals(0)],
	"provider-failure": [runs(1), stats("after"), succeeded("set_auto_retry"), refusals(0)],
	"abort-stream": [
		runs(2),
		stats("after", "after-resume"),
		abortRequested("assistant-start"),
		succeeded("abort"),
		observed("plainPromptAfterAbortAdmitted", "followUpAfterAbortAdmitted"),
		refusals(1),
	],
	"abort-tool": [
		runs(1),
		stats("after"),
		toolExecuted(),
		abortRequested("tool-start"),
		succeeded("abort"),
		refusals(0),
	],
	"length-stop": [runs(1), stats("after"), refusals(0)],
	"reasoning-usage": [runs(1), stats("after"), refusals(0)],
	"multi-turn-reopen": [
		runs(3),
		stats("after-multi-a", "after-multi-b", "after-multi-c", "after-reopen"),
		succeeded("switch_session"),
		succeeded("get_messages"),
		observed("messagesAfterReopen", "entryIdsStableAcrossReopen"),
		(run) => (run.observations.reopenedIntendedSession === true ? [] : ["the intended session was not reopened"]),
		refusals(0),
	],
	compaction: [
		runs(3),
		stats("before-compaction", "after-compaction", "after-next-prompt"),
		succeeded("compact"),
		compactionSnapshots(),
		observed("plainPromptAfterCompactionAdmitted", "followUpAfterCompactionAdmitted"),
		refusals(1),
	],
	fork: [
		runs(3),
		stats("before-fork", "after-fork", "after-fork-prompt"),
		succeeded("fork"),
		forkSnapshots(),
		observed("originalEntriesAfterFork", "forkSharedEntryIds"),
		(run) => ((run.observations.forkTargets ?? 0) >= 1 ? [] : ["no fork target was offered"]),
		(run) => (run.observations.forkCreatedNewFile === true ? [] : ["the fork produced no new session file"]),
		refusals(0),
	],
	"child-usage-replay": [
		runs(0),
		stats("after-open"),
		succeeded("switch_session"),
		(run) =>
			run.sessionEntries.some((entry) => entry.type === "child_usage_attributed")
				? []
				: ["no child_usage_attributed entry was read"],
		refusals(0),
	],
};

/** Every violated invariant of one scenario's evidence; an unknown scenario has none defined and is rejected. */
export function scenarioInvariantProblemsV0(run: PrimeScenarioEvidenceV0): string[] {
	const invariants = INVARIANTS[run.provenance.scenario];
	if (invariants === undefined) return [`no invariants are defined for scenario ${run.provenance.scenario}`];
	return [...COMMON, ...invariants].flatMap((invariant) => invariant(run));
}

export const SCENARIO_NAMES_WITH_INVARIANTS: readonly string[] = Object.keys(INVARIANTS);
