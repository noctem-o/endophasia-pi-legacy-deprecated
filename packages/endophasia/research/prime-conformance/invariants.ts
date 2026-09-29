// Research-only (Prime Runtime Conformance v0). Scenario invariants: what each scenario's evidence must show for the
// experiment to have demonstrably happened. Completing without an exception is not enough: a fork scenario that never
// forked, or a reopen that reopened nothing, must not become evidence. The live probe records violations as failures,
// and the report re-checks committed fixtures with the same rules.
//
// Invariants check that an operation occurred, never what Prime answered: a valid observation of unexpected Prime
// behavior (e.g. a tool error Prime does not flag) is conformance evidence, not an invalid run.
import { PROBE_MODEL, PROBE_PROVIDER } from "./environment.ts";
import type { PrimeScenarioEvidenceV0 } from "./evidence.ts";
import { EXPECTED_ASSISTANT_USAGE } from "./fake-provider.ts";

type Invariant = (run: PrimeScenarioEvidenceV0) => string[];

/** Exactly these stats labels, each once: a repeated or extra label would let a later record contradict the first. */
function stats(...labels: string[]): Invariant {
	return (run) => {
		const observed = run.stats.map((item) => item.label);
		return [
			...labels.flatMap((label) => {
				const count = observed.filter((item) => item === label).length;
				return count === 1 ? [] : [`expected stats "${label}" once, observed ${count}`];
			}),
			...observed.filter((label) => !labels.includes(label)).map((label) => `unexpected stats "${label}"`),
		];
	};
}

/**
 * The fake served exactly one request per assistant message the scenario scripts (a provider failure and a hung stream
 * included, though they report no usage), and summary requests only in the compaction scenario.
 */
function providerRequests(): Invariant {
	return (run) => {
		const scripted = EXPECTED_ASSISTANT_USAGE[run.provenance.scenario]?.length;
		const total = run.observations.providerRequests;
		const summaries = run.observations.summaryRequests;
		if (scripted === undefined || total === undefined || summaries === undefined)
			return ["provider requests cannot be reconciled with the script"];
		return [
			...(total - summaries === scripted
				? []
				: [`expected ${scripted} scripted provider request(s), observed ${total - summaries}`]),
			...(run.provenance.scenario === "compaction" || summaries === 0
				? []
				: [`unexpected summary request(s) outside compaction: ${summaries}`]),
		];
	};
}

/** The final file's message roles, in order: exactly the prompts, completions and tool results the scenario made. */
function persistedMessages(...roles: string[]): Invariant {
	return (run) => {
		const observed = run.sessionEntries.flatMap((entry) => (entry.type === "message" ? [entry.role ?? "none"] : []));
		return JSON.stringify(observed) === JSON.stringify(roles)
			? []
			: [`persisted message roles ${observed.join(",") || "none"}, expected ${roles.join(",")}`];
	};
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
		// Exactly one compaction lifecycle: a second terminal (e.g. a later failed compaction_end) would be hidden behind
		// the first.
		const starts = run.events.filter((event) => event.type === "compaction_start");
		const ends = run.events.filter((event) => event.type === "compaction_end");
		const end = ends[0];
		const lifecycle =
			starts.length === 1 && ends.length === 1 && run.events.indexOf(starts[0]!) < run.events.indexOf(ends[0]!);
		const response = run.observations.compactFirstKeptEntryId;
		return [
			...(prefixKept ? [] : ["pre-compaction entries changed across compaction"]),
			...(added.length === 1 && added[0]?.type === "compaction"
				? []
				: [
						`expected exactly one new entry, a compaction, observed ${added.map((entry) => entry.type).join(", ") || "none"}`,
					]),
			...(lifecycle
				? []
				: [`expected one compaction_start then one compaction_end, observed ${starts.length} and ${ends.length}`]),
			...(end?.type === "compaction_end" && end.succeeded && !end.aborted
				? []
				: ["no successful compaction_end was observed"]),
			// The compact response and the durable entry describe one compaction: they must agree on what was kept.
			...(response !== undefined && added[0]?.firstKeptEntryId === response
				? []
				: ["the compact response and the compaction entry disagree on the first kept entry"]),
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

/**
 * The exact command sequence the scenario issues; a refused command is written `name!`. Any other command (e.g. an
 * extra state-changing switch_session) would be an operation the report never shows.
 */
function commands(...expected: string[]): Invariant {
	return (run) => {
		const observed = run.commands.map((item) => `${item.command}${item.success === true ? "" : "!"}`);
		return JSON.stringify(observed) === JSON.stringify(expected)
			? []
			: [`commands ${observed.join(",") || "none"}, expected ${expected.join(",")}`];
	};
}

/** An observation the scenario requires to be exactly true (e.g. the follow-up prompt that resumes the queue). */
function holds(
	key: "followUpAfterAbortAdmitted" | "followUpAfterCompactionAdmitted" | "reopenedIntendedSession",
): Invariant {
	return (run) => (run.observations[key] === true ? [] : [`${key} is not true`]);
}

/** Only the abort scenarios request an abort; a marker anywhere else would silently change the mapped terminal. */
function noAbortRequested(): Invariant {
	return (run) =>
		run.abortRequestedAfter.length === 0
			? []
			: [`unexpected abort request(s) at ${run.abortRequestedAfter.join(", ")}`];
}

const COMMON: Invariant[] = [
	sessionFileRead(),
	observed("providerRequests", "summaryRequests"),
	providerRequests(),
	probeModel(),
];

const INVARIANTS: Readonly<Record<string, readonly Invariant[]>> = {
	simple: [
		commands("prompt", "get_session_stats"),
		persistedMessages("user", "assistant"),
		runs(1),
		stats("after"),
		noAbortRequested(),
		refusals(0),
	],
	"tool-run": [
		commands("prompt", "get_session_stats"),
		persistedMessages("user", "assistant", "toolResult", "assistant"),
		runs(1),
		stats("after"),
		toolExecuted(),
		noAbortRequested(),
		refusals(0),
	],
	"tool-error": [
		commands("prompt", "get_session_stats"),
		persistedMessages("user", "assistant", "toolResult", "assistant"),
		runs(1),
		stats("after"),
		toolExecuted(),
		noAbortRequested(),
		refusals(0),
	],
	"provider-failure": [
		commands("set_auto_retry", "prompt", "get_session_stats"),
		persistedMessages("user", "assistant"),
		runs(1),
		stats("after"),
		succeeded("set_auto_retry"),
		noAbortRequested(),
		refusals(0),
	],
	"abort-stream": [
		commands("prompt", "abort", "get_session_stats", "prompt!", "prompt", "get_session_stats"),
		persistedMessages("user", "assistant", "user", "assistant"),
		runs(2),
		stats("after", "after-resume"),
		abortRequested("assistant-start"),
		succeeded("abort"),
		observed("plainPromptAfterAbortAdmitted"),
		holds("followUpAfterAbortAdmitted"),
		refusals(1),
	],
	"abort-tool": [
		commands("prompt", "abort", "get_session_stats"),
		persistedMessages("user", "assistant", "toolResult"),
		runs(1),
		stats("after"),
		toolExecuted(),
		abortRequested("tool-start"),
		succeeded("abort"),
		refusals(0),
	],
	"length-stop": [
		commands("prompt", "get_session_stats"),
		persistedMessages("user", "assistant"),
		runs(1),
		stats("after"),
		noAbortRequested(),
		refusals(0),
	],
	"reasoning-usage": [
		commands("prompt", "get_session_stats"),
		persistedMessages("user", "assistant"),
		runs(1),
		stats("after"),
		noAbortRequested(),
		refusals(0),
	],
	"multi-turn-reopen": [
		commands(
			"prompt",
			"get_session_stats",
			"prompt",
			"get_session_stats",
			"prompt",
			"get_session_stats",
			"switch_session",
			"get_session_stats",
			"get_messages",
		),
		persistedMessages("user", "assistant", "user", "assistant", "user", "assistant"),
		runs(3),
		stats("after-multi-a", "after-multi-b", "after-multi-c", "after-reopen"),
		succeeded("switch_session"),
		succeeded("get_messages"),
		observed("messagesAfterReopen", "entryIdsStableAcrossReopen"),
		(run) => {
			// The reopened process must restore the whole conversation recorded before the first process closed.
			const recorded = run.stats.find((item) => item.label === "after-multi-c")?.totalMessages;
			const reopened = run.stats.find((item) => item.label === "after-reopen")?.totalMessages;
			const restored = run.observations.messagesAfterReopen;
			return recorded !== undefined && restored === recorded && reopened === recorded
				? []
				: [`reopen restored ${restored ?? "no"} of ${recorded ?? "an unknown number of"} messages`];
		},
		holds("reopenedIntendedSession"),
		noAbortRequested(),
		refusals(0),
	],
	compaction: [
		commands(
			"prompt",
			"prompt",
			"get_session_stats",
			"compact",
			"get_session_stats",
			"prompt!",
			"prompt",
			"get_session_stats",
		),
		persistedMessages("user", "assistant", "user", "assistant", "user", "assistant"),
		runs(3),
		stats("before-compaction", "after-compaction", "after-next-prompt"),
		succeeded("compact"),
		compactionSnapshots(),
		(run) => ((run.observations.summaryRequests ?? 0) >= 1 ? [] : ["the compaction made no summary request"]),
		observed("plainPromptAfterCompactionAdmitted"),
		holds("followUpAfterCompactionAdmitted"),
		noAbortRequested(),
		refusals(1),
	],
	fork: [
		commands("prompt", "prompt", "get_session_stats", "fork", "get_session_stats", "prompt", "get_session_stats"),
		persistedMessages("user", "assistant", "user", "assistant"),
		runs(3),
		stats("before-fork", "after-fork", "after-fork-prompt"),
		succeeded("fork"),
		forkSnapshots(),
		// Byte-level, not only the reduced snapshots: content the evidence drops must not change either.
		(run) =>
			run.observations.forkOriginalUnchanged === true ? [] : ["the original session file changed across the fork"],
		observed("originalEntriesAfterFork", "forkSharedEntryIds"),
		(run) => ((run.observations.forkTargets ?? 0) >= 1 ? [] : ["no fork target was offered"]),
		(run) => (run.observations.forkCreatedNewFile === true ? [] : ["the fork produced no new session file"]),
		noAbortRequested(),
		refusals(0),
	],
	"child-usage-replay": [
		commands("switch_session", "get_session_stats"),
		persistedMessages("user", "assistant"),
		runs(0),
		stats("after-open"),
		succeeded("switch_session"),
		(run) =>
			run.sessionEntries.some((entry) => entry.type === "child_usage_attributed")
				? []
				: ["no child_usage_attributed entry was read"],
		noAbortRequested(),
		holds("reopenedIntendedSession"),
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
