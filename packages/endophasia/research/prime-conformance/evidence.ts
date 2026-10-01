// Research-only (Prime Runtime Conformance v0). The sanitized, committed evidence format. Everything here is either an
// identity, a kind, a flag or a number: no prompt, assistant, reasoning, tool or error text. Live values reach this
// format only through decode.ts; evidenceProblemsV0 re-checks the result as a second, defensive layer (it also runs on
// fixtures read back from disk).
import type { PrimeEvidenceEventV0, PrimeUsageEvidenceV0 } from "./protocol.ts";

export const PROBE_NAME = "prime-conformance-v0";
export const PROBE_VERSION = "0.14.7";

/** Mandatory RPC envelope lists, shared by fixture reading and the pre-persistence shape gate. */
export const RPC_EVIDENCE_ARRAYS = [
	"events",
	"abortRequestedAfter",
	"commands",
	"stats",
	"sessionEntries",
	"entrySnapshots",
	"stateKeys",
	"protocolErrors",
	"failures",
] as const;

/** Required on every sanitized scenario, including diagnostics. Optional build identities remain separate. */
export function assertRequiredProvenance(value: unknown, mode: "rpc" | "acp"): void {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("provenance required");
	const p = value as Record<string, unknown>;
	for (const key of [
		"source",
		"version",
		"build",
		"mode",
		"generatedBy",
		"probeVersion",
		"platform",
		"node",
		"scenario",
	])
		if (!Object.hasOwn(p, key) || typeof p[key] !== "string" || p[key].length === 0)
			throw new Error("required provenance field missing");
	if (p.source !== "prime-agent" || p.generatedBy !== PROBE_NAME || p.mode !== mode)
		throw new Error("provenance boundary mismatch");
}

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
	/**
	 * For a checkout: SHA-256 over the git-ignored build output the source launcher loads (packages/*\/dist). A clean
	 * tracked tree does not prove what ran, since the launcher imports those builds; the probe cannot prove they were
	 * built from `commit`, but any different build output changes this hash and is reported as runtime drift.
	 */
	readonly artifactsHash?: string;
	readonly build: PrimeBuildProvenanceV0;
	readonly mode: "rpc";
	readonly generatedBy: typeof PROBE_NAME;
	readonly probeVersion: string;
	readonly platform: string;
	readonly node: string;
	/** Research source revision, distinct from Prime and from a production composition. */
	readonly endophasiaCommit?: string;
	readonly endophasiaBuild?: string;
	readonly researchHash?: string;
	/** Hash of the exact launcher and dependency lock used with the freshly built artifacts. */
	readonly launcherHash?: string;
	readonly lockHash?: string;
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
	/** Every entry the fork file shares by id with the original is identical to it (a copy, not a reused id). */
	readonly forkSharedEntriesIdentical?: boolean;
	/** The original file's raw text is byte-identical before and after the fork (compared in memory). */
	readonly forkOriginalUnchanged?: boolean;
	/** The fork header's parentSession resolves to the original session file. */
	readonly forkParentLinked?: boolean;
	readonly providerRequests?: number;
	/** Summarization requests the fake served (all during compaction); what a compaction entry's usage must sum. */
	readonly summaryRequests?: number;
	/** The first kept entry id the `compact` response named; the durable compaction entry must name the same. */
	readonly compactFirstKeptEntryId?: string;
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
		isCountV0(field) ? [] : [`${label}: usage ${name} is not a non-negative finite number`],
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

/**
 * `turn_end.message` and the preceding assistant `message_end` describe the same completion; evidence where they
 * disagree (or a turn_end without its message_end) contradicts itself and cannot support a claim.
 */
function assistantAgreementProblems(events: readonly PrimeEvidenceEventV0[]): string[] {
	let lastAssistant: string | undefined;
	return events.flatMap((event, index) => {
		if (event.type === "message_end" && event.role === "assistant") lastAssistant = JSON.stringify(event.assistant);
		if (event.type !== "turn_end") return [];
		const agrees = lastAssistant !== undefined && lastAssistant === JSON.stringify(event.assistant);
		lastAssistant = undefined;
		return agrees ? [] : [`event ${index} (turn_end): its assistant does not match the preceding message_end`];
	});
}

/** Every Prime event type decode.ts decodes (or deliberately drops): never recorded as `unknown`. */
const DECODED_PRIME_EVENT_TYPES: ReadonlySet<string> = new Set([
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
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"session_action_update",
	"extension_error",
]);

/** A count, cost or attempt: finite and never negative. */
export function isCountV0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The terminal is classified from agent_end's final assistant stop reason, so it must repeat the stop reason of the
 * run's last assistant message_end; evidence where they disagree contradicts itself.
 */
function runAgreementProblems(events: readonly PrimeEvidenceEventV0[]): string[] {
	let last: string | undefined;
	return events.flatMap((event, index) => {
		if (event.type === "agent_start") last = undefined;
		if (event.type === "message_end" && event.role === "assistant") last = event.assistant?.stopReason;
		if (event.type !== "agent_end") return [];
		const agrees = event.assistantStopReasons.at(-1) === last;
		last = undefined;
		return agrees
			? []
			: [`event ${index} (agent_end): its final stop reason does not match the run's last assistant message_end`];
	});
}

/**
 * A turn's `toolResults` and its `tool_execution_end` events describe the same completed calls: the same ids, names
 * and error flags. Evidence where the two Prime surfaces disagree contradicts itself.
 */
function turnToolAgreementProblems(events: readonly PrimeEvidenceEventV0[]): string[] {
	let executed: string[] = [];
	return events.flatMap((event, index) => {
		if (event.type === "turn_start") executed = [];
		if (event.type === "tool_execution_end")
			executed.push(JSON.stringify([event.toolCallId, event.toolName, event.isError]));
		if (event.type !== "turn_end") return [];
		const results = (event.toolResults ?? []).map((result) =>
			JSON.stringify([result.toolCallId, result.toolName, result.isError]),
		);
		const agrees = JSON.stringify([...results].sort()) === JSON.stringify([...executed].sort());
		executed = [];
		return agrees ? [] : [`event ${index} (turn_end): its tool results do not match the turn's tool executions`];
	});
}

/** Stats fields that do not hold a non-negative finite number. `contextUsageTokens` may be null or absent. */
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
	return Object.entries(fields).flatMap(([name, value]) => (isCountV0(value) ? [] : [name]));
}

/** Outer accounting accepted by the decoder, shared with the persisted inventory check. Assistant usage is nested. */
export function unretainedAccountingKeys(type: string, keys: readonly string[]): string[] {
	const retained =
		type === "compaction" || type === "branch_summary"
			? ["usage"]
			: type === "child_usage_attributed"
				? ["childUsage", "aggregateUsage"]
				: [];
	return keys.filter(
		(key) => ["usage", "cost", "childUsage", "aggregateUsage"].includes(key) && !retained.includes(key),
	);
}

export function entryProblems(where: string, entries: readonly PrimeSessionEntryEvidenceV0[]): string[] {
	const ids = entries.map((entry) => entry.id);
	const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
	return [
		...duplicates.map(() => `${where}: an entry id repeats within one session file`),
		...entries.flatMap((entry, index) =>
			typeof entry.parentId === "string" && !entries.slice(1, index).some((earlier) => earlier.id === entry.parentId)
				? [`${where} entry ${index}: parentId names no earlier entry`]
				: [],
		),
		...entries.flatMap((entry, index) =>
			(entry.type === "session") === (index === 0)
				? []
				: [`${where} entry ${index}: the session header must be the first entry and only the first`],
		),
		...entries.flatMap((entry, index) => {
			const label = `${where} entry ${index} (${entry.type})`;
			// These are outer wire keys; role/assistant usage live inside the message key, not beside it.
			const required = ["type", "id", ...(entry.type === "session" ? [] : ["parentId"])];
			if (entry.type === "message") required.push("message");
			if (entry.type === "compaction") required.push("firstKeptEntryId");
			for (const field of ["targetId", "childUsage", "aggregateUsage"] as const)
				if (entry[field] !== undefined) required.push(field);
			if (entry.type !== "message" && entry.usage !== undefined) required.push("usage");
			return [
				...(unretainedAccountingKeys(entry.type, entry.keys).length
					? [`${label}: unretained accounting wire fields`]
					: []),
				...(entry.usage !== undefined &&
				!(
					["compaction", "branch_summary"].includes(entry.type) ||
					(entry.type === "message" && entry.role === "assistant")
				)
					? [`${label}: usage has no decoded accounting source`]
					: []),
				...(entry.type !== "child_usage_attributed" &&
				(entry.childUsage !== undefined || entry.aggregateUsage !== undefined)
					? [`${label}: child usage has no decoded accounting source`]
					: []),
				...(new Set(entry.keys).size !== entry.keys.length || required.some((key) => !entry.keys.includes(key))
					? [`${label}: durable key inventory contradicts retained wire observations`]
					: []),
				...(["compaction", "branch_summary"].includes(entry.type) &&
				entry.keys.includes("usage") !== (entry.usage !== undefined)
					? [`${label}: durable usage key contradicts retained wire observations`]
					: []),
				...(missingText(entry.type) || missingText(entry.id) ? [`${label}: entry without type or id`] : []),
				...(entry.type !== "session" && entry.parentId !== null && missingText(entry.parentId)
					? [`${label}: parentId is neither a non-empty string nor null`]
					: []),
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
		}),
	];
}

const ERROR_KINDS = new Set<unknown>(["queued-input-suspended", "input-admission-paused", "other"]);

function commandProblems(commands: readonly PrimeCommandEvidenceV0[]): string[] {
	return commands.flatMap((command, index) => {
		const label = `command ${index}`;
		return [
			...(missingText(command.command) ? [`${label}: no command name`] : []),
			...booleanProblem(label, command.success, "success"),
			...(command.success === false && !ERROR_KINDS.has(command.errorKind)
				? [`${label}: refusal without a category`]
				: []),
			...(command.success === true && command.errorKind !== undefined
				? [`${label}: success with a refusal category`]
				: []),
		];
	});
}

/**
 * Evidence that is not structurally what decode.ts would produce: a missing identity, a missing required usage object,
 * a non-boolean flag or a negative or non-finite number. Any problem means the evidence must not be accepted.
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
			case "compaction_start":
				return missingText(event.reason) ? [`${label}: compaction without reason`] : [];
			case "auto_retry_start":
				return isCountV0(event.attempt) && isCountV0(event.maxAttempts)
					? []
					: [`${label}: retry attempt counts are not non-negative finite numbers`];
			case "auto_retry_end":
				return [
					...booleanProblem(label, event.success, "success"),
					...(isCountV0(event.attempt) ? [] : [`${label}: retry attempt is not a non-negative finite number`]),
				];
			case "unknown":
				if (missingText(event.primeType)) return [`${label}: unknown event without its Prime type`];
				// The decoder keeps only genuinely new types as unknown: a known name here would hide a lifecycle event.
				return DECODED_PRIME_EVENT_TYPES.has(event.primeType)
					? [`${label}: a known event type recorded as unknown`]
					: [];
			case "agent_start":
			case "turn_start":
			case "session_action_update":
			case "extension_error":
				return [];
			default:
				// Only the variants decode.ts produces are evidence; any other tag (e.g. in an edited fixture) is not.
				return [`${label}: not an event kind the decoder produces`];
		}
	});
	const stats = run.stats.flatMap((item) =>
		invalidStatsFieldsV0(item).map((field) => `stats ${item.label}: ${field} is not a non-negative finite number`),
	);
	return [
		...events,
		...assistantAgreementProblems(run.events),
		...runAgreementProblems(run.events),
		...turnToolAgreementProblems(run.events),
		...commandProblems(run.commands),
		...entryProblems("final", run.sessionEntries),
		...run.entrySnapshots.flatMap((snapshot) => entryProblems(`snapshot ${snapshot.label}`, snapshot.entries)),
		...stats,
	];
}
