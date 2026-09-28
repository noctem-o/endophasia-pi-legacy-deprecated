// Research-only (Prime Runtime Conformance v0). The sanitized, committed evidence format. Everything here is either an
// identity, a kind, a flag or a number: no prompt, assistant, reasoning, tool or error text. Live values reach this
// format only through decode.ts; evidenceProblemsV0 re-checks the result as a second, defensive layer (it also runs on
// fixtures read back from disk).
import type { PrimeEvidenceEventV0, PrimeUsageEvidenceV0 } from "./protocol.ts";

export const PROBE_NAME = "prime-conformance-v0";
export const PROBE_VERSION = "0.3.0";

/**
 * How the Prime that ran is known:
 * - clean-checkout: a PRIME_AGENT_ROOT checkout at `commit` with no modified tracked files (verified source provenance)
 * - dirty-checkout: `commit` is known, but modified tracked files mean the code that ran is not exactly `commit`
 * - unverified-checkout: a PRIME_AGENT_ROOT checkout whose commit or cleanliness could not be read
 * - binary: a PRIME_AGENT_BIN executable; its version is reported, its source commit is unknown
 */
export type PrimeBuildProvenanceV0 = "clean-checkout" | "dirty-checkout" | "unverified-checkout" | "binary";

export interface PrimeProvenanceV0 {
	readonly source: "prime-agent";
	readonly version: string;
	/** The Prime source commit (clean-checkout and dirty-checkout only). */
	readonly commit?: string;
	readonly build: PrimeBuildProvenanceV0;
	readonly mode: "rpc";
	readonly generatedBy: typeof PROBE_NAME;
	readonly probeVersion: string;
	readonly platform: string;
	readonly node: string;
}

/** Provenance of one scenario's evidence, as committed with each fixture. */
export interface PrimeScenarioProvenanceV0 extends PrimeProvenanceV0 {
	readonly scenario: string;
}

export interface PrimeStatsEvidenceV0 {
	readonly label: string;
	readonly userMessages: number;
	readonly assistantMessages: number;
	readonly toolCalls: number;
	readonly toolResults: number;
	readonly totalMessages: number;
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
	readonly cost: number;
	/** Prime's current context-window estimate (null while unknown): kept only to show it is a different fact. */
	readonly contextUsageTokens: number | null | undefined;
	readonly keys: readonly string[];
}

/**
 * One durable session-file entry, reduced to its tree identity and accounting facts. `usage` is an assistant message's
 * usage, or the summarization usage persisted on a compaction or branch_summary entry.
 */
export interface PrimeSessionEntryEvidenceV0 {
	readonly type: string;
	readonly id: string;
	/** Absent only on the session header. */
	readonly parentId?: string | null;
	readonly role?: string;
	readonly stopReason?: string;
	readonly usage?: PrimeUsageEvidenceV0;
	/** For compaction: the first entry kept on the context path. */
	readonly firstKeptEntryId?: string;
	/** For child_usage_attributed: the assistant entry the usage was folded into. */
	readonly targetId?: string;
	readonly childUsage?: PrimeUsageEvidenceV0;
	readonly aggregateUsage?: PrimeUsageEvidenceV0;
	/** Field names present on the entry, never their values. */
	readonly keys: readonly string[];
}

export type PrimeCommandErrorKindV0 = "queued-input-suspended" | "input-admission-paused" | "other";

export interface PrimeCommandEvidenceV0 {
	readonly command: string;
	readonly success: boolean;
	/** Response data field names only. */
	readonly dataKeys: readonly string[];
	/** A failed command's error, reduced to a label; the error text itself is never kept. */
	readonly errorKind?: PrimeCommandErrorKindV0;
}

/** Scenario observations the probe established itself (not Prime fields), as typed facts rather than free text. */
export interface PrimeObservationsV0 {
	readonly plainPromptAfterAbortAdmitted?: boolean;
	readonly followUpAfterAbortAdmitted?: boolean;
	readonly plainPromptAfterCompactionAdmitted?: boolean;
	readonly followUpAfterCompactionAdmitted?: boolean;
	/** get_state named the reopened session file after switch_session. */
	readonly reopenedIntendedSession?: boolean;
	readonly messagesAfterReopen?: number;
	readonly entryIdsStableAcrossReopen?: boolean;
	readonly forkTargets?: number;
	readonly forkCreatedNewFile?: boolean;
	readonly originalEntriesAfterFork?: number;
	/** Entries of the fork's new file whose id also appears in the original file (copied path entries). */
	readonly forkSharedEntryIds?: number;
	readonly providerRequests?: number;
}

/** The session file at a named moment, e.g. immediately before and after compaction, before later prompts add rows. */
export interface PrimeEntrySnapshotV0 {
	readonly label: string;
	readonly entries: readonly PrimeSessionEntryEvidenceV0[];
}

export interface PrimeScenarioEvidenceV0 {
	readonly provenance: PrimeScenarioProvenanceV0;
	readonly description: string;
	readonly events: readonly PrimeEvidenceEventV0[];
	/** Indexes into `events` after which the probe sent an RPC abort. */
	readonly abortRequestedAfter: readonly number[];
	readonly commands: readonly PrimeCommandEvidenceV0[];
	readonly stats: readonly PrimeStatsEvidenceV0[];
	/** Session-file entries at the end of the scenario, in file order. */
	readonly sessionEntries: readonly PrimeSessionEntryEvidenceV0[];
	readonly entrySnapshots: readonly PrimeEntrySnapshotV0[];
	/** Field names of get_state's data. */
	readonly stateKeys: readonly string[];
	readonly observations: PrimeObservationsV0;
	readonly protocolErrors: readonly string[];
	/**
	 * Why the experiment cannot be trusted: a decode error, a missing operation, an unexpected refusal or provider
	 * request, a violated scenario invariant. Probe-authored text only. Any entry makes the scenario invalid evidence.
	 */
	readonly failures: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Defensive second layer. Types say these fields are present and valid; values read back from disk are not typed.

function missingText(value: unknown): boolean {
	return typeof value !== "string" || value.length === 0;
}

function usageProblems(label: string, usage: unknown, required: boolean): string[] {
	if (usage === undefined) return required ? [`${label}: usage is missing`] : [];
	if (usage === null || typeof usage !== "object") return [`${label}: usage is not an object`];
	const value = usage as Record<string, unknown>;
	const cost = (value.cost ?? {}) as Record<string, unknown>;
	const fields: Record<string, unknown> = {
		input: value.input,
		output: value.output,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		totalTokens: value.totalTokens,
		"cost.input": cost.input,
		"cost.output": cost.output,
		"cost.cacheRead": cost.cacheRead,
		"cost.cacheWrite": cost.cacheWrite,
		"cost.total": cost.total,
	};
	return Object.entries(fields).flatMap(([name, field]) =>
		typeof field === "number" && Number.isFinite(field) ? [] : [`${label}: usage ${name} is not a finite number`],
	);
}

function assistantProblems(label: string, assistant: unknown): string[] {
	if (assistant === null || typeof assistant !== "object") return [`${label}: assistant is missing`];
	const value = assistant as Record<string, unknown>;
	const toolCalls = Array.isArray(value.toolCalls) ? (value.toolCalls as Record<string, unknown>[]) : undefined;
	return [
		...(missingText(value.stopReason) ? [`${label}: assistant has no stop reason`] : []),
		...usageProblems(label, value.usage, true),
		...(toolCalls === undefined ? [`${label}: assistant has no tool-call list`] : []),
		...(toolCalls ?? []).flatMap((call) =>
			missingText(call?.id) || missingText(call?.name) ? [`${label}: tool call without id or name`] : [],
		),
	];
}

function booleanProblem(label: string, value: unknown, field: string): string[] {
	return typeof value === "boolean" ? [] : [`${label}: ${field} is not a boolean`];
}

/** Stats fields that do not hold a finite number. `contextUsageTokens` may legitimately be null or absent. */
export function invalidStatsFieldsV0(stats: PrimeStatsEvidenceV0): string[] {
	const fields: Record<string, unknown> = {
		userMessages: stats.userMessages,
		assistantMessages: stats.assistantMessages,
		toolCalls: stats.toolCalls,
		toolResults: stats.toolResults,
		totalMessages: stats.totalMessages,
		"tokens.input": stats.tokens?.input,
		"tokens.output": stats.tokens?.output,
		"tokens.cacheRead": stats.tokens?.cacheRead,
		"tokens.cacheWrite": stats.tokens?.cacheWrite,
		"tokens.total": stats.tokens?.total,
		cost: stats.cost,
	};
	return Object.entries(fields).flatMap(([name, value]) =>
		typeof value === "number" && Number.isFinite(value) ? [] : [name],
	);
}

function entryProblems(where: string, entries: readonly PrimeSessionEntryEvidenceV0[]): string[] {
	return entries.flatMap((entry, index) => {
		const label = `${where} entry ${index} (${entry.type})`;
		return [
			...(missingText(entry.type) || missingText(entry.id) ? [`${label}: entry without type or id`] : []),
			// Prime's AssistantMessage and child attribution always carry usage; compaction and branch summaries may not.
			...(entry.type === "message" && entry.role === "assistant"
				? [
						...(missingText(entry.stopReason) ? [`${label}: assistant entry has no stop reason`] : []),
						...usageProblems(label, entry.usage, true),
					]
				: usageProblems(label, entry.usage, false)),
			...(entry.type === "child_usage_attributed"
				? [
						...(missingText(entry.targetId) ? [`${label}: child attribution without targetId`] : []),
						...usageProblems(`${label} childUsage`, entry.childUsage, true),
						...usageProblems(`${label} aggregateUsage`, entry.aggregateUsage, true),
					]
				: []),
			...(entry.type === "compaction" && missingText(entry.firstKeptEntryId)
				? [`${label}: compaction without firstKeptEntryId`]
				: []),
		];
	});
}

/**
 * Evidence that is not structurally what decode.ts would produce: a missing identity, a missing required usage object,
 * a non-boolean flag or a non-finite number. Any problem means the evidence must not be accepted.
 */
export function evidenceProblemsV0(run: PrimeScenarioEvidenceV0): string[] {
	const events = run.events.flatMap((event, index) => {
		const label = `event ${index} (${event.type})`;
		switch (event.type) {
			case "message_start":
				return missingText(event.role) ? [`${label}: message has no role`] : [];
			case "message_end":
				return [
					...(missingText(event.role) ? [`${label}: message has no role`] : []),
					...(event.role === "assistant" ? assistantProblems(label, event.assistant) : []),
				];
			case "turn_end":
				return [
					...assistantProblems(label, event.assistant),
					...(event.toolResults ?? []).flatMap((result) => [
						...(missingText(result.toolCallId) || missingText(result.toolName)
							? [`${label}: tool result without id or name`]
							: []),
						...booleanProblem(label, result.isError, "tool result isError"),
					]),
				];
			case "tool_execution_start":
			case "tool_execution_update":
				return missingText(event.toolCallId) || missingText(event.toolName)
					? [`${label}: tool execution without id or name`]
					: [];
			case "tool_execution_end":
				return [
					...(missingText(event.toolCallId) || missingText(event.toolName)
						? [`${label}: tool execution without id or name`]
						: []),
					...booleanProblem(label, event.isError, "isError"),
				];
			case "compaction_end":
				return [
					...booleanProblem(label, event.aborted, "aborted"),
					...booleanProblem(label, event.willRetry, "willRetry"),
					...booleanProblem(label, event.succeeded, "succeeded"),
				];
			case "agent_end":
				return [
					...(event.messageRoles.some(missingText) ? [`${label}: message without role`] : []),
					...(event.assistantStopReasons.some(missingText) ? [`${label}: assistant without stop reason`] : []),
				];
			default:
				return [];
		}
	});
	const stats = run.stats.flatMap((item) =>
		invalidStatsFieldsV0(item).map((field) => `stats ${item.label}: ${field} is not a finite number`),
	);
	return [
		...events,
		...entryProblems("final", run.sessionEntries),
		...run.entrySnapshots.flatMap((snapshot) => entryProblems(`snapshot ${snapshot.label}`, snapshot.entries)),
		...stats,
	];
}
