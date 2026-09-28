// Research-only (Prime Runtime Conformance v0). Derives conformance facts from sanitized probe evidence and classifies
// each Endophasia v0 contract on two axes. Nothing here is an Endophasia contract or runtime interface.

import { PROBE_MODEL_COST } from "./environment.ts";
import type { PrimeScenarioEvidenceV0, PrimeSessionEntryEvidenceV0, PrimeStatsEvidenceV0 } from "./evidence.ts";
import { EXPECTED_ASSISTANT_USAGE, EXPECTED_PERSISTED_USAGE, expectedPrimeUsageV0 } from "./fake-provider.ts";
import { type MissionTraceMappingV0, mapPrimeMissionTraceV0 } from "./mission-trace.ts";
import { rebuildPrimeRuntimeMetricsV0 } from "./projection.ts";
import type { PrimeEvidenceEventV0, PrimeUsageEvidenceV0 } from "./protocol.ts";

/** Where the contract's facts come from. */
export type PrimeSupportV0 = "native" | "adapter-state" | "unavailable";
/** Whether those facts mean what the contract says they mean. */
export type PrimeSemanticFitV0 = "exact" | "qualified" | "incompatible";

/**
 * How the classification stands on this run's evidence:
 * - established: every fact it rests on was observed with the value the classification assumes
 * - unverified: some fact was not observed (its scenario did not run); the classification is not claimed
 * - contradicted: some fact was observed with another value; Prime behaves differently from what the classification
 *   describes, so it must be re-analysed and is not claimed
 */
export type PrimeFindingBasisV0 = "established" | "unverified" | "contradicted";

export interface PrimeConformanceFindingV0 {
	readonly contract: string;
	/** The established classification, or "undetermined" when it is unverified or contradicted. */
	readonly support: PrimeSupportV0 | "undetermined";
	readonly semanticFit: PrimeSemanticFitV0 | "undetermined";
	readonly basis: PrimeFindingBasisV0;
	/** The classification this analysis describes, as last established from verified evidence. */
	readonly baseline: { readonly support: PrimeSupportV0; readonly semanticFit: PrimeSemanticFitV0 };
	/** Required facts that were not observed. */
	readonly missing: readonly string[];
	/** Required facts observed with a value the classification does not assume. */
	readonly contradictions: readonly string[];
	/** Probe scenarios (`probe:<scenario>`) and pinned Prime source or docs (`prime:<path>:<line>`) behind the finding. */
	readonly evidence: readonly string[];
	/** State the adapter itself would have to own to produce the contract. */
	readonly adapterState: readonly string[];
	/** Where a truthful mapping differs from the contract's meaning. */
	readonly qualifications: readonly string[];
	/** Facts the contract needs that Prime does not provide. */
	readonly unavailable: readonly string[];
}

/** One fact a classification rests on, and the value it assumes. */
interface Requirement {
	readonly fact: string;
	/** true: holds; false: contradicted; undefined: not observed. */
	holds(facts: PrimeFactsV0): boolean | undefined;
}

function expect<K extends keyof PrimeFactsV0>(key: K, expected: PrimeFactsV0[K]): Requirement {
	return {
		fact: `${key} = ${String(expected)}`,
		holds: (facts) => (facts[key] === undefined ? undefined : facts[key] === expected),
	};
}

type FindingAnalysis = Omit<
	PrimeConformanceFindingV0,
	"support" | "semanticFit" | "basis" | "baseline" | "missing" | "contradictions"
> & {
	readonly support: PrimeSupportV0;
	readonly semanticFit: PrimeSemanticFitV0;
	readonly requires: readonly Requirement[];
};

/** Claim an analysis's classification only when every fact it rests on was observed as assumed. */
function settle(analysis: FindingAnalysis, facts: PrimeFactsV0): PrimeConformanceFindingV0 {
	const { requires, support, semanticFit, ...rest } = analysis;
	const missing = requires.filter((item) => item.holds(facts) === undefined).map((item) => item.fact);
	const contradictions = requires.filter((item) => item.holds(facts) === false).map((item) => item.fact);
	const basis: PrimeFindingBasisV0 =
		contradictions.length > 0 ? "contradicted" : missing.length > 0 ? "unverified" : "established";
	return {
		...rest,
		support: basis === "established" ? support : "undetermined",
		semanticFit: basis === "established" ? semanticFit : "undetermined",
		basis,
		baseline: { support, semanticFit },
		missing,
		contradictions,
	};
}

/**
 * The Prime revision whose source and docs the classifications cite (PRIME_SOURCE). Evidence from any other build can
 * confirm the observed facts but not the source-derived conclusions, so every finding stays unverified until the new
 * revision is re-audited and this constant updated.
 */
export const AUDITED_PRIME = { version: "0.9.6", commit: "2d24ad4e6b2d1ee8e6919af6f108e980a14d550e" } as const;

const AUDITED_REVISION: Requirement = {
	fact: `Prime ${AUDITED_PRIME.version} @ ${AUDITED_PRIME.commit.slice(0, 8)} (the audited revision), clean checkout`,
	holds: (facts) => (facts.auditedRevision === true ? true : undefined),
};

/** Prime source and docs the classification relies on, at the pinned commit. */
export const PRIME_SOURCE = {
	rpcCommands: "prime:packages/coding-agent/docs/rpc.md:225-256 (command table, observe/observed_session_event)",
	rpcEvents: "prime:packages/coding-agent/docs/rpc.md:793-808 (event table: no run, turn or operation identity)",
	sessionFormat: "prime:packages/coding-agent/docs/session-format.md:265-280 (child_usage_attributed)",
	agentEndPaths:
		"prime:packages/agent/src/agent-loop.ts:345-436 (agent_end emitted on stop, error, abort and tool-batch abort paths)",
	sessionStats:
		"prime:packages/coding-agent/src/core/agent-session.ts:14776-14815 (getSessionStats sums state.messages; total recomputed)",
	childUsage:
		"prime:packages/coding-agent/src/core/agent-session.ts:1507-1516 (attributeChildUsage keeps parent totalTokens)",
	retrySlice:
		"prime:packages/coding-agent/src/core/agent-session.ts:13442-13444 (retry removes the failed assistant from context)",
	requestAbort:
		"prime:packages/coding-agent/src/core/agent-session.ts:8199-8206 (abort suspends queued session input)",
	compactAborts: "prime:packages/coding-agent/src/core/agent-session.ts:8718-8725 (manual compact aborts first)",
	promptResume:
		"prime:packages/coding-agent/src/modes/daemon/daemon-mode.ts:4628 (prompt resumes only with streamingBehavior)",
	compactionUsage:
		"prime:packages/coding-agent/src/core/compaction/compaction.ts:108-116 (summary usage persisted on the entry)",
	openAiUsage: "prime:packages/ai/src/providers/openai-completions.ts:1110 (usage parser: no reasoning field)",
	sessionRewrite:
		"prime:packages/coding-agent/src/core/session-manager.ts:1812-1818,1917-1930 (whole-file atomic rewrite on migration and moves)",
	autoRefine:
		"prime:packages/coding-agent/src/core/settings-manager.ts:1030-1045 and core/agent-session.ts:3398-3428 (auto-refine, on by default, runs a review model call after compaction)",
	rlmChildren: "prime:packages/coding-agent/docs/rlm.md:64-118 (children are separate AgentSessions and session dirs)",
} as const;

/** A fact is `undefined` when the scenario that establishes it was not run. */
export interface PrimeFactsV0 {
	/** The evidence came from a clean checkout of the audited Prime revision; undefined otherwise (not re-audited). */
	readonly auditedRevision: true | undefined;
	/** Every entry a fork file shares by id with the original is identical to it. */
	readonly forkSharedEntriesIdentical: boolean | undefined;
	/** Every assistant usage equals what the fake provider scripted, through Prime's documented mapping, in every field. */
	readonly providerUsageDecodedExactly: boolean | undefined;
	readonly toolCallIdentityNative: boolean | undefined;
	readonly toolErrorRecovered: boolean | undefined;
	readonly providerFailureStop: string | undefined;
	readonly abortStreamStop: string | undefined;
	readonly abortToolStop: string | undefined;
	readonly lengthStop: string | undefined;
	readonly plainPromptAfterAbortAdmitted: boolean | undefined;
	readonly plainPromptAfterCompactionAdmitted: boolean | undefined;
	readonly reasoningFieldReported: boolean | undefined;
	readonly statsTotalRecomputed: boolean | undefined;
	readonly statsDropAfterCompaction: boolean | undefined;
	readonly compactionUsageDurable: boolean | undefined;
	readonly compactionUsageInStats: boolean | undefined;
	readonly statsDropAfterFork: boolean | undefined;
	readonly forkNewFile: boolean | undefined;
	/** Entries of the fork's new file whose id also appears in the original file (copied path entries). */
	readonly forkSharedEntryIds: number | undefined;
	readonly reopenStatsEqual: boolean | undefined;
	readonly reopenEntryIdsStable: boolean | undefined;
	readonly rebuildMatchesStatsOnSinglePath: boolean | undefined;
	readonly rebuildIncludesCompactionUsage: boolean | undefined;
	readonly childUsageFoldedIntoStats: boolean | undefined;
	/** After child folding: stats' recomputed tokens.total next to the aggregate's reported totalTokens. */
	readonly childFoldTotals: { readonly statsTokensTotal: number; readonly aggregateTotalTokens: number } | undefined;
	readonly childUsageRewritesEarlierRow: boolean | undefined;
	readonly undocumentedEventTypes: readonly string[];
	readonly protocolErrors: number;
}

function byScenario(evidence: readonly PrimeScenarioEvidenceV0[]): Map<string, PrimeScenarioEvidenceV0> {
	return new Map(evidence.map((item) => [item.provenance.scenario, item]));
}

function stat(run: PrimeScenarioEvidenceV0 | undefined, label: string): PrimeStatsEvidenceV0 | undefined {
	return run?.stats.find((item) => item.label === label);
}

function snapshot(
	run: PrimeScenarioEvidenceV0 | undefined,
	label: string,
): readonly PrimeSessionEntryEvidenceV0[] | undefined {
	return run?.entrySnapshots.find((item) => item.label === label)?.entries;
}

/** The final assistant stop reason of the scenario's first run. */
function firstRunStop(run: PrimeScenarioEvidenceV0 | undefined): string | undefined {
	const end = run?.events.find((event) => event.type === "agent_end");
	return end?.type === "agent_end" ? end.assistantStopReasons.at(-1) : undefined;
}

/**
 * Whether get_session_stats counts the compaction summary, judged from the session file snapshotted immediately after
 * compaction (before any later prompt) on a single linear path: the context path then holds only the kept entries
 * (from firstKeptEntryId up to the compaction entry), so stats equal their assistant cost if the summary is excluded,
 * and that plus the summary cost if it is counted. Anything else is undecided rather than guessed.
 */
function compactionSummaryCounted(
	entries: readonly PrimeSessionEntryEvidenceV0[] | undefined,
	afterCompaction: PrimeStatsEvidenceV0 | undefined,
): boolean | undefined {
	if (entries === undefined || afterCompaction === undefined) return undefined;
	const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
	const compaction = entries[compactionIndex];
	if (compaction?.usage === undefined || compaction.firstKeptEntryId === undefined) return undefined;
	const firstKept = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	if (firstKept === -1 || firstKept > compactionIndex) return undefined;
	const keptCost = entries
		.slice(firstKept, compactionIndex)
		.reduce(
			(sum, entry) =>
				sum + (entry.type === "message" && entry.role === "assistant" ? (entry.usage?.cost.total ?? 0) : 0),
			0,
		);
	if (afterCompaction.cost === keptCost + compaction.usage.cost.total) return true;
	if (afterCompaction.cost === keptCost) return false;
	return undefined;
}

/**
 * Stats equal in every field expected to survive a pure close and reopen: every message count, every token count, the
 * cost and the field-name set. Excluded, deliberately: `contextUsageTokens`, Prime's context-window estimate, which is
 * recomputed per process and is null right after compaction until the next response; and `label`, which names the read.
 */
function stableStatsEqual(a: PrimeStatsEvidenceV0, b: PrimeStatsEvidenceV0): boolean {
	return (
		a.userMessages === b.userMessages &&
		a.assistantMessages === b.assistantMessages &&
		a.toolCalls === b.toolCalls &&
		a.toolResults === b.toolResults &&
		a.totalMessages === b.totalMessages &&
		a.tokens.input === b.tokens.input &&
		a.tokens.output === b.tokens.output &&
		a.tokens.cacheRead === b.tokens.cacheRead &&
		a.tokens.cacheWrite === b.tokens.cacheWrite &&
		a.tokens.total === b.tokens.total &&
		a.cost === b.cost &&
		a.keys.join(",") === b.keys.join(",")
	);
}

/**
 * Compare every assistant message's usage, both as emitted live and as persisted in the session file, with the fake
 * provider's script, through Prime's documented mapping: a consistent misparse (or a file that persists other numbers
 * than the events report) would otherwise pass, since stats and session entries are both copies of Prime's own
 * numbers. Undefined when no scenario with a known script ran.
 */
function providerUsageDecodedExactly(evidence: readonly PrimeScenarioEvidenceV0[]): boolean | undefined {
	const checked = evidence.filter((run) => EXPECTED_ASSISTANT_USAGE[run.provenance.scenario] !== undefined);
	if (checked.length === 0) return undefined;
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	const noCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const script = (names: readonly (string | null)[]): PrimeUsageEvidenceV0[] =>
		names.map((name) =>
			name === null
				? { ...zero, cost: noCost, extraKeys: [] }
				: { ...expectedPrimeUsageV0(name, PROBE_MODEL_COST), extraKeys: [] },
		);
	// A usage field Prime added (extraKeys) is an accounting dimension the projections would drop: not exact.
	const matches = (observed: readonly (PrimeUsageEvidenceV0 | undefined)[], expected: PrimeUsageEvidenceV0[]) =>
		observed.length === expected.length &&
		observed.every(
			(usage, index) => usage !== undefined && usage.extraKeys.length === 0 && usageEqual(usage, expected[index]!),
		);
	// Prime sums its summary calls into the compaction entry, and the fake serves each the same scripted summary.
	const summaries = (count: number): PrimeUsageEvidenceV0 => {
		const one = expectedPrimeUsageV0("summary", PROBE_MODEL_COST);
		return {
			input: one.input * count,
			output: one.output * count,
			cacheRead: one.cacheRead * count,
			cacheWrite: one.cacheWrite * count,
			totalTokens: one.totalTokens * count,
			cost: {
				input: one.cost.input * count,
				output: one.cost.output * count,
				cacheRead: one.cost.cacheRead * count,
				cacheWrite: one.cost.cacheWrite * count,
				total: one.cost.total * count,
			},
			extraKeys: [],
		};
	};
	return checked.every((run) => {
		const live = run.events.flatMap((event) =>
			event.type === "message_end" && event.assistant !== undefined ? [event.assistant.usage] : [],
		);
		const persistedScript = EXPECTED_PERSISTED_USAGE[run.provenance.scenario];
		const persisted = run.sessionEntries.flatMap((entry) =>
			entry.type === "message" && entry.role === "assistant" ? [entry.usage] : [],
		);
		const compactions = run.sessionEntries.filter((entry) => entry.type === "compaction");
		return (
			matches(live, script(EXPECTED_ASSISTANT_USAGE[run.provenance.scenario]!)) &&
			(persistedScript === undefined || matches(persisted, script(persistedScript))) &&
			(compactions.length === 0 ||
				matches(
					compactions.map((entry) => entry.usage),
					compactions.map(() => summaries(run.observations.summaryRequests ?? 0)),
				))
		);
	});
}

function usageEqual(a: PrimeUsageEvidenceV0, b: PrimeUsageEvidenceV0): boolean {
	return (
		a.input === b.input &&
		a.output === b.output &&
		a.cacheRead === b.cacheRead &&
		a.cacheWrite === b.cacheWrite &&
		a.totalTokens === b.totalTokens &&
		a.cost.input === b.cost.input &&
		a.cost.output === b.cost.output &&
		a.cost.cacheRead === b.cost.cacheRead &&
		a.cost.cacheWrite === b.cost.cacheWrite &&
		a.cost.total === b.cost.total
	);
}

/**
 * Whether the adapter rebuild keeps every pre-compaction row and adds exactly the summary usage, from the snapshots
 * taken immediately before and after compaction (no later prompt can make up for a loss). Exact in every usage
 * dimension: rebuild(after) must equal rebuild(before) plus the compaction entry's usage. Undecided without both
 * snapshots or a compaction usage.
 */
function rebuildRetainsCompaction(
	before: readonly PrimeSessionEntryEvidenceV0[] | undefined,
	after: readonly PrimeSessionEntryEvidenceV0[] | undefined,
): boolean | undefined {
	const summary = after?.find((entry) => entry.type === "compaction")?.usage;
	if (before === undefined || after === undefined || summary === undefined) return undefined;
	const kept = rebuildPrimeRuntimeMetricsV0(before).usage;
	const expected: PrimeUsageEvidenceV0 = {
		input: kept.input + summary.input,
		output: kept.output + summary.output,
		cacheRead: kept.cacheRead + summary.cacheRead,
		cacheWrite: kept.cacheWrite + summary.cacheWrite,
		totalTokens: kept.totalTokens + summary.totalTokens,
		cost: {
			input: kept.cost.input + summary.cost.input,
			output: kept.cost.output + summary.cost.output,
			cacheRead: kept.cost.cacheRead + summary.cost.cacheRead,
			cacheWrite: kept.cost.cacheWrite + summary.cost.cacheWrite,
			total: kept.cost.total + summary.cost.total,
		},
		extraKeys: [],
	};
	return usageEqual({ ...rebuildPrimeRuntimeMetricsV0(after).usage, extraKeys: [] }, expected);
}

const DOCUMENTED_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"session_action_update",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"extension_error",
]);

export function derivePrimeFactsV0(evidence: readonly PrimeScenarioEvidenceV0[]): PrimeFactsV0 {
	const runs = byScenario(evidence);
	const toolRun = runs.get("tool-run");
	const toolError = runs.get("tool-error");
	const compaction = runs.get("compaction");
	const fork = runs.get("fork");
	const reopen = runs.get("multi-turn-reopen");
	const child = runs.get("child-usage-replay");
	const reasoning = runs.get("reasoning-usage");

	const toolCallIdentityNative =
		toolRun === undefined
			? undefined
			: (() => {
					const called = toolRun.events.flatMap((event) =>
						event.type === "message_end" ? (event.assistant?.toolCalls ?? []) : [],
					);
					// Every execution phase (start, update, end) must name a tool call the assistant made.
					const executed = toolRun.events.flatMap((event) =>
						event.type === "tool_execution_start" ||
						event.type === "tool_execution_update" ||
						event.type === "tool_execution_end"
							? [event]
							: [],
					);
					// The (id, name) pair must match; a missing id ("") never counts, even when both sides lack one.
					return (
						executed.length > 0 &&
						executed.every(
							(execution) =>
								execution.toolCallId !== "" &&
								!execution.toolCallId.startsWith("adapter:") &&
								called.some((call) => call.id === execution.toolCallId && call.name === execution.toolName),
						)
					);
				})();

	const toolErrorRecovered =
		toolError === undefined
			? undefined
			: toolError.events.some((event) => event.type === "tool_execution_end" && event.isError) &&
				firstRunStop(toolError) === "stop";

	const allStats = evidence.flatMap((run) => run.stats);
	const statsTotalRecomputed =
		allStats.length === 0
			? undefined
			: allStats.every(
					(item) =>
						item.tokens.total ===
						item.tokens.input + item.tokens.output + item.tokens.cacheRead + item.tokens.cacheWrite,
				);

	const beforeCompaction = stat(compaction, "before-compaction");
	const afterCompaction = stat(compaction, "after-compaction");
	const beforeSnapshot = snapshot(compaction, "before-compaction");
	const afterSnapshot = snapshot(compaction, "after-compaction");
	const compactionEntry = afterSnapshot?.find((entry) => entry.type === "compaction");
	const beforeFork = stat(fork, "before-fork");
	const afterFork = stat(fork, "after-fork");

	const lastReopenPrompt = stat(reopen, "after-multi-c");
	const afterReopen = stat(reopen, "after-reopen");

	const childStats = stat(child, "after-open");
	const childEntry = child?.sessionEntries.find((entry) => entry.type === "child_usage_attributed");
	const childTarget = child?.sessionEntries.find((entry) => entry.id === childEntry?.targetId);

	const reasoningUsage = reasoning?.events.flatMap((event) =>
		event.type === "message_end" && event.assistant?.usage !== undefined ? [event.assistant.usage] : [],
	);

	const provenance = evidence[0]?.provenance;
	return {
		auditedRevision:
			provenance !== undefined &&
			provenance.build === "clean-checkout" &&
			provenance.version === AUDITED_PRIME.version &&
			provenance.commit === AUDITED_PRIME.commit
				? true
				: undefined,
		forkSharedEntriesIdentical: fork?.observations.forkSharedEntriesIdentical,
		providerUsageDecodedExactly: providerUsageDecodedExactly(evidence),
		toolCallIdentityNative,
		toolErrorRecovered,
		providerFailureStop: firstRunStop(runs.get("provider-failure")),
		abortStreamStop: firstRunStop(runs.get("abort-stream")),
		abortToolStop: firstRunStop(runs.get("abort-tool")),
		lengthStop: firstRunStop(runs.get("length-stop")),
		plainPromptAfterAbortAdmitted: runs.get("abort-stream")?.observations.plainPromptAfterAbortAdmitted,
		plainPromptAfterCompactionAdmitted: compaction?.observations.plainPromptAfterCompactionAdmitted,
		reasoningFieldReported:
			reasoningUsage === undefined || reasoningUsage.length === 0
				? undefined
				: reasoningUsage.some((usage) => usage.extraKeys.some((key) => /reason/i.test(key))),
		statsTotalRecomputed,
		statsDropAfterCompaction:
			beforeCompaction === undefined || afterCompaction === undefined
				? undefined
				: afterCompaction.tokens.total < beforeCompaction.tokens.total,
		compactionUsageDurable: afterSnapshot === undefined ? undefined : compactionEntry?.usage !== undefined,
		compactionUsageInStats: compactionSummaryCounted(afterSnapshot, afterCompaction),
		statsDropAfterFork:
			beforeFork === undefined || afterFork === undefined
				? undefined
				: afterFork.tokens.total < beforeFork.tokens.total,
		forkNewFile: fork?.observations.forkCreatedNewFile,
		forkSharedEntryIds: fork?.observations.forkSharedEntryIds,
		reopenStatsEqual:
			lastReopenPrompt === undefined || afterReopen === undefined
				? undefined
				: stableStatsEqual(lastReopenPrompt, afterReopen),
		reopenEntryIdsStable: reopen?.observations.entryIdsStableAcrossReopen,
		rebuildMatchesStatsOnSinglePath:
			reopen === undefined || afterReopen === undefined
				? undefined
				: (() => {
						// Every dimension both sides report; stats carry no per-component cost.
						const { usage } = rebuildPrimeRuntimeMetricsV0(reopen.sessionEntries);
						const { tokens } = afterReopen;
						return (
							usage.input === tokens.input &&
							usage.output === tokens.output &&
							usage.cacheRead === tokens.cacheRead &&
							usage.cacheWrite === tokens.cacheWrite &&
							usage.totalTokens === tokens.total &&
							usage.cost.total === afterReopen.cost
						);
					})(),
		rebuildIncludesCompactionUsage: rebuildRetainsCompaction(beforeSnapshot, afterSnapshot),
		// Every dimension both surfaces report with the same meaning. Stats report no per-component cost, and their
		// tokens.total is recomputed from the components, unlike the aggregate's reported totalTokens: that pair is kept
		// as its own fact below rather than compared here.
		childUsageFoldedIntoStats:
			childStats === undefined || childEntry?.aggregateUsage === undefined
				? undefined
				: childStats.tokens.input === childEntry.aggregateUsage.input &&
					childStats.tokens.output === childEntry.aggregateUsage.output &&
					childStats.tokens.cacheRead === childEntry.aggregateUsage.cacheRead &&
					childStats.tokens.cacheWrite === childEntry.aggregateUsage.cacheWrite &&
					childStats.cost === childEntry.aggregateUsage.cost.total,
		childFoldTotals:
			childStats === undefined || childEntry?.aggregateUsage === undefined
				? undefined
				: {
						statsTokensTotal: childStats.tokens.total,
						aggregateTotalTokens: childEntry.aggregateUsage.totalTokens,
					},
		childUsageRewritesEarlierRow:
			childStats === undefined || childTarget?.usage === undefined
				? undefined
				: childStats.tokens.input !== childTarget.usage.input,
		undocumentedEventTypes: [
			...new Set(
				evidence.flatMap((run) =>
					run.events.flatMap((event) =>
						event.type === "unknown" && !DOCUMENTED_EVENT_TYPES.has(event.primeType) ? [event.primeType] : [],
					),
				),
			),
		].sort(),
		protocolErrors: evidence.reduce((sum, run) => sum + run.protocolErrors.length, 0),
	};
}

/** Render a fact for evidence strings: unverified facts say so instead of defaulting. */
function show(value: boolean | number | string | undefined): string {
	return value === undefined ? "unverified (scenario not run)" : String(value);
}

export interface PrimeMissionTraceScenarioV0 {
	readonly scenario: string;
	readonly mapping: MissionTraceMappingV0;
}

export function mapScenarioMissionTracesV0(
	evidence: readonly PrimeScenarioEvidenceV0[],
): PrimeMissionTraceScenarioV0[] {
	return evidence.map((run) => ({
		scenario: run.provenance.scenario,
		mapping: mapPrimeMissionTraceV0({ evidence: run.events, abortRequestedAfter: run.abortRequestedAfter }),
	}));
}

/** Adapter-owned identities must be unique per run, correlated within it and numbered without gaps. */
export function checkAdapterIdentitiesV0(mapping: MissionTraceMappingV0): string[] {
	const problems: string[] = [];
	let previous = 0;
	const runs = new Set<string>();
	const turns = new Set<string>();
	for (const event of mapping.events) {
		if (event.sequence !== previous + 1) problems.push(`sequence gap before ${event.sequence}`);
		previous = event.sequence;
		if (event.kind === "mission.started") {
			if (runs.has(event.runId)) problems.push(`run ${event.runId} started twice`);
			runs.add(event.runId);
		} else if (!runs.has(event.runId)) {
			problems.push(`${event.kind} for unstarted run ${event.runId}`);
		}
		if (event.kind === "turn.started") {
			if (turns.has(event.turnId)) problems.push(`turn ${event.turnId} started twice`);
			turns.add(event.turnId);
		}
		if ("turnId" in event && event.kind !== "turn.started" && !turns.has(event.turnId)) {
			problems.push(`${event.kind} for unstarted turn ${event.turnId}`);
		}
		if ("turnId" in event && !event.turnId.startsWith(`${event.runId}/`)) {
			problems.push(`turn ${event.turnId} not correlated with run ${event.runId}`);
		}
	}
	return problems;
}

export function classifyPrimeConformanceV0(
	evidence: readonly PrimeScenarioEvidenceV0[],
	facts: PrimeFactsV0 = derivePrimeFactsV0(evidence),
): PrimeConformanceFindingV0[] {
	const traces = mapScenarioMissionTracesV0(evidence);
	const ambiguous = traces.flatMap(({ scenario, mapping }) =>
		mapping.terminals.filter((terminal) => terminal.basis === "ambiguous").map(() => scenario),
	);
	const adapterAborts = traces.flatMap(({ scenario, mapping }) =>
		mapping.terminals.filter((terminal) => terminal.basis === "adapter-abort-request").map(() => scenario),
	);
	const identityProblems = traces.flatMap(({ scenario, mapping }) =>
		checkAdapterIdentitiesV0(mapping).map((problem) => `${scenario}: ${problem}`),
	);

	const missionTrace: FindingAnalysis = {
		contract: "MissionTraceEventV0",
		support: "adapter-state",
		semanticFit: "qualified",
		requires: [
			AUDITED_REVISION,
			expect("toolCallIdentityNative", true),
			expect("toolErrorRecovered", true),
			expect("providerFailureStop", "error"),
			expect("abortStreamStop", "aborted"),
			expect("abortToolStop", "toolUse"),
			expect("lengthStop", "length"),
			expect("plainPromptAfterAbortAdmitted", false),
			expect("plainPromptAfterCompactionAdmitted", false),
			{
				fact: "adapter identities unique, correlated and gap-free",
				holds: () => (evidence.length === 0 ? undefined : identityProblems.length === 0),
			},
		],
		evidence: [
			`probe:tool-run: tool_execution_* (toolCallId, toolName) pairs are Prime's own and match the assistant tool calls: ${show(facts.toolCallIdentityNative)}`,
			`probe:tool-error: tool_execution_end isError=true and the run recovers to stop: ${show(facts.toolErrorRecovered)}`,
			`probe:provider-failure: final stop reason ${show(facts.providerFailureStop)}`,
			`probe:abort-stream: final stop reason ${show(facts.abortStreamStop)}`,
			`probe:abort-tool: final stop reason ${show(facts.abortToolStop)}; agent_end alone does not say the run was aborted`,
			`probe:length-stop: final stop reason ${show(facts.lengthStop)}`,
			`probe:*: adapter identity problems: ${identityProblems.length === 0 ? "none" : identityProblems.join("; ")}`,
			PRIME_SOURCE.rpcEvents,
			PRIME_SOURCE.agentEndPaths,
		],
		adapterState: [
			"lane: an adapter label for the one root session an RPC process drives (prime:root); Prime names no lane",
			"runId: adapter counter opened at agent_start and closed at agent_end; lives only for one observation",
			"turnId: adapter counter per turn_start within the run",
			"abort requests the adapter sent, to classify runs whose final stop reason is toolUse",
			"mission sequence: adapter counter; restarts with each observation",
		],
		qualifications: [
			"Terminal status comes from the final assistant stop reason, not from agent_end: stop→completed, error→failed, aborted→aborted",
			`A run aborted during tool execution ends with stop reason toolUse; it maps to mission.aborted only because the adapter itself sent the abort (${adapterAborts.join(", ") || "not observed"})`,
			`Runs with no truthful terminal kind emit none (length stop, or toolUse without an adapter abort): ${ambiguous.join(", ") || "none observed"}`,
			"mission.resumed and mission.suspended are never emitted: Prime has no suspended-run concept in RPC",
			"model.completed is emitted per assistant message_end, including aborted and errored assistant messages",
			"Run and turn IDs do not survive a process restart or reconnect: Prime's events carry nothing to rebuild them",
			`After an abort (or a manual compaction, which aborts first), a plain prompt is refused until a prompt with streamingBehavior resumes the queue (admitted after abort: ${show(facts.plainPromptAfterAbortAdmitted)}; after compaction: ${show(facts.plainPromptAfterCompactionAdmitted)})`,
			`Prime emits event types beyond its documented table: ${facts.undocumentedEventTypes.join(", ") || "none observed"}; they are ignored, not mapped`,
		],
		unavailable: [
			"A native run identity (Pi runId)",
			"A native turn identity (Pi turnId)",
			"A native lane",
			"A native run terminal status",
		],
	};

	const runtimeMetrics: FindingAnalysis = {
		contract: "RuntimeMetricsV0",
		support: "adapter-state",
		semanticFit: "qualified",
		requires: [
			AUDITED_REVISION,
			expect("providerUsageDecodedExactly", true),
			expect("statsDropAfterCompaction", true),
			expect("statsDropAfterFork", true),
			expect("statsTotalRecomputed", true),
			expect("compactionUsageDurable", true),
			expect("compactionUsageInStats", false),
			expect("reasoningFieldReported", false),
			expect("childUsageFoldedIntoStats", true),
			expect("reopenStatsEqual", true),
			expect("rebuildMatchesStatsOnSinglePath", true),
			expect("rebuildIncludesCompactionUsage", true),
		],
		evidence: [
			`probe:*: every assistant usage equals the fake provider's scripted usage through Prime's documented mapping, in every field: ${show(facts.providerUsageDecodedExactly)}`,
			`probe:compaction: get_session_stats totals decrease after compaction: ${show(facts.statsDropAfterCompaction)}`,
			`probe:fork: get_session_stats totals decrease after fork: ${show(facts.statsDropAfterFork)}; fork writes a new session file: ${show(facts.forkNewFile)}`,
			`probe:*: tokens.total equals input+output+cacheRead+cacheWrite in every stats read: ${show(facts.statsTotalRecomputed)}`,
			`probe:compaction: summary usage persisted on the compaction entry: ${show(facts.compactionUsageDurable)}; included in stats cost: ${show(facts.compactionUsageInStats)}`,
			`probe:reasoning-usage: a reasoning count is reported: ${show(facts.reasoningFieldReported)}`,
			`probe:child-usage-replay: child usage folded into stats (input, output, cacheRead, cacheWrite, cost): ${show(facts.childUsageFoldedIntoStats)}`,
			`probe:child-usage-replay: after folding, stats tokens.total ${show(facts.childFoldTotals?.statsTokensTotal)} vs aggregate totalTokens ${show(facts.childFoldTotals?.aggregateTotalTokens)} (different definitions; not compared as a match)`,
			`probe:multi-turn-reopen: stats identical after reopen in every stable field (message counts, tokens, cost; contextUsage excluded): ${show(facts.reopenStatsEqual)}`,
			`probe:multi-turn-reopen: adapter rebuild from the session file equals get_session_stats on a single path: ${show(facts.rebuildMatchesStatsOnSinglePath)}`,
			`probe:compaction: adapter rebuild, from snapshots immediately before and after compaction, equals the pre-compaction rows plus the summary usage in every dimension: ${show(facts.rebuildIncludesCompactionUsage)}`,
			PRIME_SOURCE.sessionStats,
			PRIME_SOURCE.retrySlice,
			PRIME_SOURCE.childUsage,
			PRIME_SOURCE.openAiUsage,
			PRIME_SOURCE.autoRefine,
		],
		adapterState: [
			"A cumulative accounting sum rebuilt from every durable session file of the tree (assistant, compaction and branch_summary usage, and child_usage_attributed rows), because get_session_stats is scoped to the current context path",
			"The set of session files belonging to one logical session (forks write new files linked by parentSession)",
			"De-duplication by entry id across that file set: a fork copies the path's entries, ids included, into its new file",
		],
		qualifications: [
			"The native get_session_stats projection is incompatible with RuntimeMetricsV0; only the adapter rebuild from durable session entries is qualified",
			"The rebuild reads Prime's documented session-file format directly, outside the RPC boundary",
			"get_session_stats sums assistant usage over the current context path only: totals decrease after compaction and fork, so it is not cumulative accounting",
			"get_session_stats tokens.total is recomputed from the four components; RuntimeMetricsV0.totalTokens is the sum of reported totalTokens",
			"Compaction and branch-summary usage is durable on its entry but never counted by get_session_stats",
			"A failed attempt that is auto-retried is removed from the context path (source only; not exercised live), so its usage leaves get_session_stats",
			"Prime's default auto-refine runs a review model call after compaction; the probe disables it, so where that call's usage is recorded is not examined",
			"RLM child usage is folded into the parent assistant usage (input/output/cost) while that message's totalTokens stays at the parent's own context tokens",
			"messageCount has no equivalent: totalMessages counts current-path messages, not persisted message entries",
			"contextUsage is a context-window estimate and is deliberately not mapped",
			"get_session_stats reports only a total cost; per-component cost exists only on durable entries",
		],
		unavailable: [
			"reasoning: Prime's openai-completions usage carries no reasoning count (it is included in output)",
			"cacheWrite1h: not reported",
			"Caller usage adjustments: Prime has no recordUsage equivalent",
		],
	};

	const operationOutcome: FindingAnalysis = {
		contract: "OperationOutcomeV0",
		support: "unavailable",
		semanticFit: "incompatible",
		// The absence of a result lookup rests on Prime's RPC surface (source and docs); the probe must still see the
		// abort-during-tool case that no Prime record can recover.
		requires: [AUDITED_REVISION, expect("abortToolStop", "toolUse"), expect("reopenEntryIdsStable", true)],
		evidence: [
			PRIME_SOURCE.rpcCommands,
			PRIME_SOURCE.rpcEvents,
			`probe:multi-turn-reopen: entry ids stable across reopen: ${show(facts.reopenEntryIdsStable)}`,
			`probe:abort-tool: final stop reason ${show(facts.abortToolStop)}`,
		],
		adapterState: [
			"An adapter-assigned operation ID per prompt command, correlated to the agent_start/agent_end pair it caused",
			"A durable adapter record of {operationId, status, basis, fromTipId, tipId, startedAt, endedAt} written at agent_end, since Prime keeps none",
			"fromTipId/tipId from the session leaf entry id before and after the run (via get_state/session file), accepting that fork moves the leaf into a new file",
		],
		qualifications: [
			"The prompt response acknowledges admission only; the outcome arrives later as events with no operation identity",
			"An adapter-held outcome is lost if the adapter was detached when agent_end fired: Prime offers no lookup to recover it",
		],
		unavailable: [
			"Lookup of a terminal result by a stable operation ID, after completion, abort, detach or reopen",
			"A machine-readable error code for failed runs (only a free-text errorMessage on the assistant message)",
			"Run start and end timestamps as part of a result record",
		],
	};

	const usage: FindingAnalysis = {
		contract: "UsageLedgerRowV0",
		support: "adapter-state",
		semanticFit: "qualified",
		requires: [
			AUDITED_REVISION,
			expect("providerUsageDecodedExactly", true),
			expect("reopenEntryIdsStable", true),
			expect("forkSharedEntriesIdentical", true),
			expect("compactionUsageDurable", true),
			expect("childUsageRewritesEarlierRow", true),
			expect("forkNewFile", true),
			{
				fact: "forkSharedEntryIds > 0",
				holds: (facts) => (facts.forkSharedEntryIds === undefined ? undefined : facts.forkSharedEntryIds > 0),
			},
		],
		evidence: [
			`probe:multi-turn-reopen: entry ids stable across reopen: ${show(facts.reopenEntryIdsStable)}`,
			`probe:compaction: compaction entry carries usage: ${show(facts.compactionUsageDurable)}`,
			`probe:child-usage-replay: a later child_usage_attributed entry changes the reported usage of an earlier assistant entry on reload: ${show(facts.childUsageRewritesEarlierRow)}`,
			`probe:fork: fork writes a new session file: ${show(facts.forkNewFile)}; entries copied with the original ids: ${show(facts.forkSharedEntryIds)}`,
			PRIME_SOURCE.sessionFormat,
			PRIME_SOURCE.compactionUsage,
			PRIME_SOURCE.sessionRewrite,
		],
		adapterState: [
			"Row id: the session entry id (8 hex, stable across reopen); a fork copies path entries with the same ids into its new file, so the id names one durable row across the file set only after de-duplication",
			"Row sequence: a durable adapter-owned sequence across the whole fork family; Prime has none, and a file's line ordinal is not session-global (the original and a fork file reuse the same ordinals)",
			"Paging: the adapter reads the session file itself (Prime has no usage scan command)",
			"Fork: rows of a forked session live in a new file whose copied prefix repeats the original's rows; the adapter must track the file set and de-duplicate",
		],
		qualifications: [
			"Rows are session entries (assistant messages, compaction, branch_summary, child_usage_attributed), not Pi usage rows",
			"child_usage_attributed is a separate durable row, but on reload Prime also rewrites the target assistant's in-memory usage; an adapter must read the file's original row, never the replayed message",
			"A child row's association (targetId) names the parent assistant entry, not the child session that spent it",
			"adjustment is always false: Prime has no caller adjustments",
			"Prime rewrites the whole session file on format migration and session moves; a line ordinal is a stable cursor only while a rewrite preserves entry order, and the adapter must detect rewrites (inode or size shrink) to re-validate it",
			"Live observation needs the adapter to watch message_end/compaction_end and re-read the file for the durable row; events carry no sequence",
		],
		unavailable: [
			"A native durable monotonic usage sequence or cursor, and any session-global one: line ordinals are per file",
			"A native usage paging command",
			"reasoning and cacheWrite1h counts",
		],
	};

	return [missionTrace, runtimeMetrics, operationOutcome, usage].map((analysis) => settle(analysis, facts));
}

/** Every Prime event type the evidence contains, for the report's forward-compatibility section. */
export function observedEventTypesV0(events: readonly PrimeEvidenceEventV0[]): string[] {
	return [...new Set(events.map((event) => (event.type === "unknown" ? event.primeType : event.type)))].sort();
}
