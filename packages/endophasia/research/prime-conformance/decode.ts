// Research-only (Prime Runtime Conformance v0). The strict Prime boundary: every Prime-specific shape the probe relies
// on is validated here before anything is reduced to evidence. A required field that is missing, of the wrong type or
// not finite throws PrimeDecodeError; nothing is defaulted, dropped or substituted. Only after validation is a value
// reduced to payload-minimal evidence (identities, kinds, flags, numbers).
//
// Authority for the shapes, at the pinned Prime commit:
// - events: packages/agent/src/types.ts (AgentEvent) and coding-agent/src/core/agent-session.ts (session events)
// - messages and usage: packages/ai/src/types.ts (AssistantMessage, ToolResultMessage, Usage)
// - responses: packages/coding-agent/docs/rpc.md and core/session-stats.ts
// - session file: packages/coding-agent/src/core/session-manager.ts (SessionEntryBase and entry types)
//
// Nothing outside research/prime-conformance may depend on this vocabulary.
import type {
	PrimeCommandErrorKindV0,
	PrimeCommandEvidenceV0,
	PrimeSessionEntryEvidenceV0,
	PrimeStatsEvidenceV0,
} from "./evidence.ts";
import type {
	PrimeAssistantEvidenceV0,
	PrimeEvidenceEventV0,
	PrimeRpcResponseV0,
	PrimeUsageEvidenceV0,
} from "./protocol.ts";

/**
 * A Prime value did not have the structure a claim needs. The message names field paths only, never values, so it is
 * safe to keep as a scenario failure.
 */
export class PrimeDecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrimeDecodeError";
	}
}

type Json = Record<string, unknown>;

function object(value: unknown, path: string): Json {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new PrimeDecodeError(`${path} is not an object`);
	}
	return value as Json;
}

function array(value: unknown, path: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new PrimeDecodeError(`${path} is not an array`);
	return value;
}

/** A required identity or kind: a non-empty string. */
function text(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) throw new PrimeDecodeError(`${path} is not a non-empty string`);
	return value;
}

function flag(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw new PrimeDecodeError(`${path} is not a boolean`);
	return value;
}

/** Every number the probe keeps is a count, a cost or an attempt: finite and never negative. */
function count(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		throw new PrimeDecodeError(`${path} is not a non-negative finite number`);
	return value;
}

const USAGE_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"]);

/** Prime's `Usage`: every count and every cost component is required. */
export function decodePrimeUsageV0(value: unknown, path: string): PrimeUsageEvidenceV0 {
	const usage = object(value, path);
	const cost = object(usage.cost, `${path}.cost`);
	return {
		input: count(usage.input, `${path}.input`),
		output: count(usage.output, `${path}.output`),
		cacheRead: count(usage.cacheRead, `${path}.cacheRead`),
		cacheWrite: count(usage.cacheWrite, `${path}.cacheWrite`),
		totalTokens: count(usage.totalTokens, `${path}.totalTokens`),
		cost: {
			input: count(cost.input, `${path}.cost.input`),
			output: count(cost.output, `${path}.cost.output`),
			cacheRead: count(cost.cacheRead, `${path}.cost.cacheRead`),
			cacheWrite: count(cost.cacheWrite, `${path}.cost.cacheWrite`),
			total: count(cost.total, `${path}.cost.total`),
		},
		extraKeys: Object.keys(usage)
			.filter((key) => !USAGE_KEYS.has(key))
			.sort(),
	};
}

/** Prime's `AssistantMessage`, reduced to identity, stop reason, usage and tool-call identities. */
export function decodePrimeAssistantV0(value: unknown, path: string): PrimeAssistantEvidenceV0 {
	const message = object(value, path);
	if (message.role !== "assistant") throw new PrimeDecodeError(`${path}.role is not assistant`);
	const content = array(message.content, `${path}.content`);
	if (message.errorMessage !== undefined && typeof message.errorMessage !== "string") {
		throw new PrimeDecodeError(`${path}.errorMessage is not a string`);
	}
	return {
		// Any non-empty stop reason is accepted: a new Prime stop reason is a semantic difference to report, not a
		// malformed observation.
		stopReason: text(message.stopReason, `${path}.stopReason`),
		provider: text(message.provider, `${path}.provider`),
		model: text(message.model, `${path}.model`),
		usage: decodePrimeUsageV0(message.usage, `${path}.usage`),
		toolCalls: content.flatMap((block, index) => {
			const item = object(block, `${path}.content[${index}]`);
			return item.type === "toolCall"
				? [
						{
							id: text(item.id, `${path}.content[${index}].id`),
							name: text(item.name, `${path}.content[${index}].name`),
						},
					]
				: [];
		}),
		hasErrorMessage: typeof message.errorMessage === "string" && message.errorMessage.length > 0,
	};
}

function role(value: unknown, path: string): string {
	return text(object(value, path).role, `${path}.role`);
}

/**
 * Decode one live Prime event into evidence. Returns undefined only for `message_update`, whose streaming deltas carry
 * text, reasoning and argument fragments and are deliberately never evidence. An event type the probe does not know is
 * kept by name (forward compatibility); a known type with a malformed required field throws.
 */
export function decodePrimeEventV0(type: string, event: Json): PrimeEvidenceEventV0 | undefined {
	switch (type) {
		case "agent_start":
		case "turn_start":
			return { type };
		case "agent_end": {
			const messages = array(event.messages, "agent_end.messages");
			return {
				type,
				messageRoles: messages.map((message, index) => role(message, `agent_end.messages[${index}]`)),
				assistantStopReasons: messages.flatMap((message, index) => {
					const item = object(message, `agent_end.messages[${index}]`);
					return item.role === "assistant"
						? [text(item.stopReason, `agent_end.messages[${index}].stopReason`)]
						: [];
				}),
			};
		}
		case "turn_end":
			return {
				type,
				assistant: decodePrimeAssistantV0(event.message, "turn_end.message"),
				toolResults: array(event.toolResults, "turn_end.toolResults").map((result, index) => {
					const item = object(result, `turn_end.toolResults[${index}]`);
					return {
						toolCallId: text(item.toolCallId, `turn_end.toolResults[${index}].toolCallId`),
						toolName: text(item.toolName, `turn_end.toolResults[${index}].toolName`),
						isError: flag(item.isError, `turn_end.toolResults[${index}].isError`),
					};
				}),
			};
		case "message_start":
			return { type, role: role(event.message, "message_start.message") };
		case "message_end": {
			const messageRole = role(event.message, "message_end.message");
			return messageRole === "assistant"
				? { type, role: messageRole, assistant: decodePrimeAssistantV0(event.message, "message_end.message") }
				: { type, role: messageRole };
		}
		case "message_update":
			return undefined;
		case "tool_execution_start":
		case "tool_execution_update":
			return {
				type,
				toolCallId: text(event.toolCallId, `${type}.toolCallId`),
				toolName: text(event.toolName, `${type}.toolName`),
			};
		case "tool_execution_end":
			return {
				type,
				toolCallId: text(event.toolCallId, "tool_execution_end.toolCallId"),
				toolName: text(event.toolName, "tool_execution_end.toolName"),
				isError: flag(event.isError, "tool_execution_end.isError"),
			};
		case "compaction_start":
			return { type, reason: text(event.reason, "compaction_start.reason") };
		case "compaction_end":
			if (event.result !== undefined) object(event.result, "compaction_end.result");
			return {
				type,
				reason: text(event.reason, "compaction_end.reason"),
				aborted: flag(event.aborted, "compaction_end.aborted"),
				willRetry: flag(event.willRetry, "compaction_end.willRetry"),
				succeeded: event.result !== undefined,
			};
		case "auto_retry_start":
			return {
				type,
				attempt: count(event.attempt, "auto_retry_start.attempt"),
				maxAttempts: count(event.maxAttempts, "auto_retry_start.maxAttempts"),
			};
		case "auto_retry_end":
			return {
				type,
				success: flag(event.success, "auto_retry_end.success"),
				attempt: count(event.attempt, "auto_retry_end.attempt"),
			};
		// Known, but no claim reads their fields: recorded by type only.
		case "session_action_update":
		case "extension_error":
			return { type };
		default:
			return { type: "unknown", primeType: type };
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Command responses

/** The response's data object; a successful response without one is malformed. */
function data(response: PrimeRpcResponseV0): Json {
	return object(response.data, `${response.command}.data`);
}

export function decodePrimeStatsV0(label: string, response: PrimeRpcResponseV0): PrimeStatsEvidenceV0 {
	const stats = data(response);
	const tokens = object(stats.tokens, "get_session_stats.data.tokens");
	// contextUsage is optional in Prime's SessionStats; when present its tokens may be null (unknown after compaction).
	let contextUsageTokens: number | null | undefined;
	if (stats.contextUsage !== undefined) {
		const context = object(stats.contextUsage, "get_session_stats.data.contextUsage");
		contextUsageTokens =
			context.tokens === null ? null : count(context.tokens, "get_session_stats.data.contextUsage.tokens");
	}
	return {
		label,
		userMessages: count(stats.userMessages, "get_session_stats.data.userMessages"),
		assistantMessages: count(stats.assistantMessages, "get_session_stats.data.assistantMessages"),
		toolCalls: count(stats.toolCalls, "get_session_stats.data.toolCalls"),
		toolResults: count(stats.toolResults, "get_session_stats.data.toolResults"),
		totalMessages: count(stats.totalMessages, "get_session_stats.data.totalMessages"),
		tokens: {
			input: count(tokens.input, "get_session_stats.data.tokens.input"),
			output: count(tokens.output, "get_session_stats.data.tokens.output"),
			cacheRead: count(tokens.cacheRead, "get_session_stats.data.tokens.cacheRead"),
			cacheWrite: count(tokens.cacheWrite, "get_session_stats.data.tokens.cacheWrite"),
			total: count(tokens.total, "get_session_stats.data.tokens.total"),
		},
		cost: count(stats.cost, "get_session_stats.data.cost"),
		contextUsageTokens,
		keys: Object.keys(stats).sort(),
	};
}

/** get_state: the session file is required, since durable evidence is read from it. */
export function decodePrimeStateV0(response: PrimeRpcResponseV0): { sessionFile: string; keys: string[] } {
	const state = data(response);
	return { sessionFile: text(state.sessionFile, "get_state.data.sessionFile"), keys: Object.keys(state).sort() };
}

/** get_messages: the restored message list; only its length is kept. */
export function decodePrimeMessageCountV0(response: PrimeRpcResponseV0): number {
	return array(data(response).messages, "get_messages.data.messages").length;
}

/** get_fork_messages: every forkable message must name its entry; an empty list is no fork target. */
export function decodePrimeForkTargetsV0(response: PrimeRpcResponseV0): string[] {
	const targets = array(data(response).messages, "get_fork_messages.data.messages").map((message, index) =>
		text(
			object(message, `get_fork_messages.data.messages[${index}]`).entryId,
			`get_fork_messages.data.messages[${index}].entryId`,
		),
	);
	if (targets.length === 0) throw new PrimeDecodeError("get_fork_messages.data.messages is empty");
	return targets;
}

/**
 * fork and switch_session answer `success: true` even when an extension cancelled them (`cancelled: true`); the
 * operation happened only when `cancelled` is exactly false.
 */
export function requirePrimeNotCancelledV0(response: PrimeRpcResponseV0): void {
	if (flag(data(response).cancelled, `${response.command}.data.cancelled`)) {
		throw new PrimeDecodeError(`${response.command} was cancelled`);
	}
}

/** compact: a successful compaction names the first kept entry. */
export function decodePrimeCompactionResultV0(response: PrimeRpcResponseV0): { firstKeptEntryId: string } {
	const result = data(response);
	count(result.tokensBefore, "compact.data.tokensBefore");
	return { firstKeptEntryId: text(result.firstKeptEntryId, "compact.data.firstKeptEntryId") };
}

/**
 * A refused command's category. The texts are Prime's admission errors (agent-session.ts
 * _assertSessionActionAdmissionAvailable); they are matched here and never copied into evidence.
 */
export function classifyPrimeRefusalV0(error: string | undefined): PrimeCommandErrorKindV0 {
	if (error?.includes("queued session input is suspended") === true) return "queued-input-suspended";
	if (error?.includes("session input admission is paused") === true) return "input-admission-paused";
	return "other";
}

export function commandEvidenceV0(response: PrimeRpcResponseV0): PrimeCommandEvidenceV0 {
	return {
		command: response.command,
		success: response.success,
		dataKeys: response.data !== null && typeof response.data === "object" ? Object.keys(response.data).sort() : [],
		...(response.success ? {} : { errorKind: classifyPrimeRefusalV0(response.error) }),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Session file

/**
 * Decode one session-file line (1-based `line`). Malformed JSON, a non-object, a missing type or a malformed base
 * identity throws: such a line cannot silently disappear. A structurally valid entry of an unknown type is kept with
 * its identity and field names, as evidence of a new Prime surface.
 */
export function decodePrimeSessionLineV0(raw: string, line: number): PrimeSessionEntryEvidenceV0 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// The parser's message can quote the line; only its number is kept.
		throw new PrimeDecodeError(`session line ${line} is not valid JSON`);
	}
	const path = `session line ${line}`;
	const entry = object(parsed, path);
	const type = text(entry.type, `${path}.type`);
	const keys = Object.keys(entry).sort();
	// The header carries the session id; every other entry extends SessionEntryBase (id, parentId).
	if (type === "session") return { type, id: text(entry.id, `${path}.id`), keys };
	const id = text(entry.id, `${path}.id`);
	if (entry.parentId !== null && (typeof entry.parentId !== "string" || entry.parentId.length === 0)) {
		throw new PrimeDecodeError(`${path}.parentId is neither a non-empty string nor null`);
	}
	const base = { type, id, parentId: entry.parentId, keys };
	switch (type) {
		case "message": {
			const messageRole = role(entry.message, `${path}.message`);
			if (messageRole !== "assistant") return { ...base, role: messageRole };
			const assistant = decodePrimeAssistantV0(entry.message, `${path}.message`);
			return { ...base, role: messageRole, stopReason: assistant.stopReason, usage: assistant.usage };
		}
		case "compaction":
			return {
				...base,
				firstKeptEntryId: text(entry.firstKeptEntryId, `${path}.firstKeptEntryId`),
				// Optional in Prime's CompactionEntry; strict when present.
				...(entry.usage === undefined ? {} : { usage: decodePrimeUsageV0(entry.usage, `${path}.usage`) }),
			};
		case "branch_summary":
			return entry.usage === undefined ? base : { ...base, usage: decodePrimeUsageV0(entry.usage, `${path}.usage`) };
		case "child_usage_attributed":
			return {
				...base,
				targetId: text(entry.targetId, `${path}.targetId`),
				childUsage: decodePrimeUsageV0(entry.childUsage, `${path}.childUsage`),
				aggregateUsage: decodePrimeUsageV0(entry.aggregateUsage, `${path}.aggregateUsage`),
			};
		default:
			// An unknown entry is kept for forward compatibility only when it carries no accounting: dropping a usage the
			// probe cannot decode would silently undercount every usage projection and rebuilt metric.
			if (ACCOUNTING_KEYS.some((key) => key in entry)) {
				throw new PrimeDecodeError(`${path} is an unknown entry type carrying accounting fields`);
			}
			return base;
	}
}

/** Field names that carry usage on any known entry; an unknown entry with one of them cannot be read safely. */
const ACCOUNTING_KEYS = ["usage", "childUsage", "aggregateUsage", "cost"] as const;

/**
 * Decode a whole session file's text. Only the single empty element after the final newline is skipped: a blank line
 * anywhere else, or a missing final newline, is a malformed file. Entry ids must be unique within one file (a fork's
 * copied ids live in another file).
 */
export function decodePrimeSessionFileV0(content: string): PrimeSessionEntryEvidenceV0[] {
	const lines = content.split("\n");
	if (lines.at(-1) !== "") throw new PrimeDecodeError("session file does not end with a newline");
	const entries = lines.slice(0, -1).map((raw, index) => {
		if (raw.length === 0) throw new PrimeDecodeError(`session line ${index + 1} is empty`);
		return decodePrimeSessionLineV0(raw, index + 1);
	});
	// Exactly one header, on line 1: a second header means a concatenated or corrupted file.
	for (const [index, entry] of entries.entries()) {
		if ((entry.type === "session") !== (index === 0))
			throw new PrimeDecodeError(`session line ${index + 1}: the session header must be line 1 and only line 1`);
	}
	const seen = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		if (seen.has(entry.id)) throw new PrimeDecodeError(`session line ${index + 1} repeats an entry id`);
		seen.add(entry.id);
	}
	return entries;
}
