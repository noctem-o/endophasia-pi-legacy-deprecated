// Research-only (Prime Runtime Conformance v0). The sanitized, committed evidence format. Everything here is either an
// identity, a kind, a flag or a number: no prompt, assistant, reasoning, tool or error text.
import type { PrimeEvidenceEventV0, PrimeUsageEvidenceV0 } from "./protocol.ts";
import { sanitizeUsageV0 } from "./protocol.ts";

export const PROBE_NAME = "prime-conformance-v0";
export const PROBE_VERSION = "0.2.0";

export interface PrimeProvenanceV0 {
	readonly source: "prime-agent";
	readonly version: string;
	/** The Prime source commit, when the probe ran against a checkout. */
	readonly commit?: string;
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
	/** Prime's current context-window estimate: kept only to show it is a different fact. */
	readonly contextUsageTokens: number | null | undefined;
	readonly keys: readonly string[];
}

/**
 * One durable session-file entry, reduced to its tree identity and accounting facts. `usage` is an assistant message's
 * usage, or the summarization usage persisted on a compaction or branch_summary entry.
 */
export interface PrimeSessionEntryEvidenceV0 {
	readonly type: string;
	readonly id?: string;
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

export interface PrimeCommandEvidenceV0 {
	readonly command: string;
	readonly success: boolean;
	/** Response data field names only. */
	readonly dataKeys: readonly string[];
	/** A failed command's error, reduced to a label; the error text itself is never kept. */
	readonly errorKind?: PrimeCommandErrorKindV0;
}

export type PrimeCommandErrorKindV0 = "queued-input-suspended" | "input-admission-paused" | "other";

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
	/** Field names of get_state's data. */
	readonly stateKeys: readonly string[];
	readonly protocolErrors: readonly string[];
	readonly notes: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

export function sanitizeStatsV0(label: string, data: unknown): PrimeStatsEvidenceV0 {
	const stats = record(data) ?? {};
	const tokens = record(stats.tokens) ?? {};
	const context = record(stats.contextUsage);
	return {
		label,
		userMessages: finite(stats.userMessages),
		assistantMessages: finite(stats.assistantMessages),
		toolCalls: finite(stats.toolCalls),
		toolResults: finite(stats.toolResults),
		totalMessages: finite(stats.totalMessages),
		tokens: {
			input: finite(tokens.input),
			output: finite(tokens.output),
			cacheRead: finite(tokens.cacheRead),
			cacheWrite: finite(tokens.cacheWrite),
			total: finite(tokens.total),
		},
		cost: finite(stats.cost),
		contextUsageTokens:
			context === undefined ? undefined : typeof context.tokens === "number" ? context.tokens : null,
		keys: Object.keys(stats).sort(),
	};
}

/** Stats fields that did not hold a finite number. `contextUsageTokens` may legitimately be null and is not checked. */
export function invalidStatsFieldsV0(stats: PrimeStatsEvidenceV0): string[] {
	const fields: Record<string, number> = {
		userMessages: stats.userMessages,
		assistantMessages: stats.assistantMessages,
		toolCalls: stats.toolCalls,
		toolResults: stats.toolResults,
		totalMessages: stats.totalMessages,
		"tokens.input": stats.tokens.input,
		"tokens.output": stats.tokens.output,
		"tokens.cacheRead": stats.tokens.cacheRead,
		"tokens.cacheWrite": stats.tokens.cacheWrite,
		"tokens.total": stats.tokens.total,
		cost: stats.cost,
	};
	return Object.entries(fields).flatMap(([name, value]) => (Number.isFinite(value) ? [] : [name]));
}

export function sanitizeCommandV0(response: {
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}): PrimeCommandEvidenceV0 {
	return {
		command: response.command,
		success: response.success,
		dataKeys: Object.keys(record(response.data) ?? {}).sort(),
		...(response.success ? {} : { errorKind: commandErrorKind(response.error) }),
	};
}

function commandErrorKind(error: string | undefined): PrimeCommandErrorKindV0 {
	// Prime's admission errors (agent-session.ts _assertSessionActionAdmissionAvailable), matched, never copied.
	if (error?.includes("queued session input is suspended") === true) return "queued-input-suspended";
	if (error?.includes("session input admission is paused") === true) return "input-admission-paused";
	return "other";
}

/** Entry types whose own `usage` records a model call made outside an assistant message (summaries). */
const SUMMARY_USAGE_ENTRY_TYPES = new Set(["compaction", "branch_summary"]);

/** Reduce one session-file line. Unknown entry types keep their type and field names only. */
export function sanitizeSessionEntryV0(value: unknown): PrimeSessionEntryEvidenceV0 | undefined {
	const entry = record(value);
	if (entry === undefined || typeof entry.type !== "string") return undefined;
	const message = record(entry.message);
	const usage =
		message?.role === "assistant"
			? sanitizeUsageV0(message.usage)
			: SUMMARY_USAGE_ENTRY_TYPES.has(entry.type)
				? sanitizeUsageV0(entry.usage)
				: undefined;
	const childUsage = entry.type === "child_usage_attributed" ? sanitizeUsageV0(entry.childUsage) : undefined;
	const aggregateUsage = entry.type === "child_usage_attributed" ? sanitizeUsageV0(entry.aggregateUsage) : undefined;
	return {
		type: entry.type,
		...(typeof entry.id === "string" ? { id: entry.id } : {}),
		...(entry.parentId === null || typeof entry.parentId === "string" ? { parentId: entry.parentId } : {}),
		...(typeof message?.role === "string" ? { role: message.role } : {}),
		...(typeof message?.stopReason === "string" ? { stopReason: message.stopReason } : {}),
		...(usage === undefined ? {} : { usage }),
		...(entry.type === "compaction" && typeof entry.firstKeptEntryId === "string"
			? { firstKeptEntryId: entry.firstKeptEntryId }
			: {}),
		...(typeof entry.targetId === "string" && entry.type === "child_usage_attributed"
			? { targetId: entry.targetId }
			: {}),
		...(childUsage === undefined ? {} : { childUsage }),
		...(aggregateUsage === undefined ? {} : { aggregateUsage }),
		keys: Object.keys(entry).sort(),
	};
}
