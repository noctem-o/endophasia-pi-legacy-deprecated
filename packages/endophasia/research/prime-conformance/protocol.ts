// Research-only (Prime Runtime Conformance v0). Minimal structural shapes at Prime's RPC process boundary, validated
// defensively. These are not Prime's types and not an Endophasia runtime interface.

/** A command response: Prime echoes the command's `id` when one was sent. */
export interface PrimeRpcResponseV0 {
	readonly id?: string;
	readonly command: string;
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: string;
}

export type PrimeRpcRecordV0 =
	| { readonly kind: "response"; readonly response: PrimeRpcResponseV0 }
	| { readonly kind: "event"; readonly type: string; readonly event: Record<string, unknown> }
	| { readonly kind: "invalid"; readonly reason: string };

/** Classify one decoded record without trusting its shape. */
export function classifyPrimeRecordV0(value: Record<string, unknown>): PrimeRpcRecordV0 {
	const type = value.type;
	if (typeof type !== "string") return { kind: "invalid", reason: "Record has no string type" };
	if (type === "response") {
		if (typeof value.command !== "string" || typeof value.success !== "boolean") {
			return { kind: "invalid", reason: "Response lacks command or success" };
		}
		if (value.id !== undefined && typeof value.id !== "string") {
			return { kind: "invalid", reason: "Response id is not a string" };
		}
		return {
			kind: "response",
			response: {
				...(typeof value.id === "string" ? { id: value.id } : {}),
				command: value.command,
				success: value.success,
				...(value.data === undefined ? {} : { data: value.data }),
				...(typeof value.error === "string" ? { error: value.error } : {}),
			},
		};
	}
	return { kind: "event", type, event: value };
}

// ---------------------------------------------------------------------------------------------------------------
// Sanitized evidence: only identities, kinds, flags and numbers survive; no text, reasoning, arguments, results or
// error messages. Unknown event types are kept by name only, for forward compatibility.

export interface PrimeUsageEvidenceV0 {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
	/** Usage keys Prime reported beyond the ones above, by name only (e.g. a future reasoning count). */
	readonly extraKeys: readonly string[];
}

export interface PrimeAssistantEvidenceV0 {
	readonly stopReason: string;
	readonly provider?: string;
	readonly model?: string;
	readonly usage?: PrimeUsageEvidenceV0;
	readonly toolCalls: readonly { readonly id: string; readonly name: string }[];
	/** Whether Prime attached an error message; its text is never kept. */
	readonly hasErrorMessage: boolean;
}

export type PrimeEvidenceEventV0 =
	| { readonly type: "agent_start" }
	| {
			readonly type: "agent_end";
			readonly messageRoles: readonly string[];
			readonly assistantStopReasons: readonly string[];
	  }
	| { readonly type: "turn_start" }
	| {
			readonly type: "turn_end";
			readonly assistant?: PrimeAssistantEvidenceV0;
			readonly toolResults: readonly {
				readonly toolCallId: string;
				readonly toolName: string;
				readonly isError: boolean;
			}[];
	  }
	| {
			readonly type: "message_start" | "message_end";
			readonly role: string;
			readonly assistant?: PrimeAssistantEvidenceV0;
	  }
	| {
			readonly type: "tool_execution_start" | "tool_execution_update";
			readonly toolCallId: string;
			readonly toolName: string;
	  }
	| {
			readonly type: "tool_execution_end";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly isError: boolean;
	  }
	| { readonly type: "compaction_start"; readonly reason: string }
	| {
			readonly type: "compaction_end";
			readonly reason: string;
			readonly aborted: boolean;
			readonly willRetry: boolean;
			readonly succeeded: boolean;
	  }
	| { readonly type: "auto_retry_start"; readonly attempt: number; readonly maxAttempts: number }
	| { readonly type: "auto_retry_end"; readonly success: boolean; readonly attempt: number }
	| { readonly type: "session_action_update"; readonly queuedCount: number }
	| { readonly type: "extension_error" }
	| { readonly type: "unknown"; readonly primeType: string };

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * A missing or non-string field becomes "", never a plausible value: two missing identities must not look like a
 * match. `evidenceProblemsV0` rejects empty required fields, so such evidence never reaches a report or fixture.
 */
function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

const USAGE_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"]);

export function sanitizeUsageV0(value: unknown): PrimeUsageEvidenceV0 | undefined {
	const usage = record(value);
	if (usage === undefined) return undefined;
	const cost = record(usage.cost) ?? {};
	return {
		input: number(usage.input),
		output: number(usage.output),
		cacheRead: number(usage.cacheRead),
		cacheWrite: number(usage.cacheWrite),
		totalTokens: number(usage.totalTokens),
		cost: {
			input: number(cost.input),
			output: number(cost.output),
			cacheRead: number(cost.cacheRead),
			cacheWrite: number(cost.cacheWrite),
			total: number(cost.total),
		},
		extraKeys: Object.keys(usage)
			.filter((key) => !USAGE_KEYS.has(key))
			.sort(),
	};
}

/** Keep an assistant message's identity, stop reason, usage and tool-call identities; drop every payload. */
export function sanitizeAssistantV0(value: unknown): PrimeAssistantEvidenceV0 | undefined {
	const message = record(value);
	if (message === undefined || message.role !== "assistant") return undefined;
	const content = Array.isArray(message.content) ? message.content : [];
	const usage = sanitizeUsageV0(message.usage);
	return {
		stopReason: string(message.stopReason),
		...(typeof message.provider === "string" ? { provider: message.provider } : {}),
		...(typeof message.model === "string" ? { model: message.model } : {}),
		...(usage === undefined ? {} : { usage }),
		toolCalls: content.flatMap((block) => {
			const item = record(block);
			return item?.type === "toolCall" ? [{ id: string(item.id), name: string(item.name) }] : [];
		}),
		hasErrorMessage: typeof message.errorMessage === "string" && message.errorMessage.length > 0,
	};
}

function roleOf(value: unknown): string {
	return string(record(value)?.role);
}

/** Reduce one live Prime event to evidence. Payload fields are never copied, only named facts. */
export function sanitizePrimeEventV0(type: string, event: Record<string, unknown>): PrimeEvidenceEventV0 | undefined {
	switch (type) {
		case "agent_start":
		case "turn_start":
			return { type };
		case "agent_end": {
			const messages = Array.isArray(event.messages) ? event.messages : [];
			return {
				type,
				messageRoles: messages.map(roleOf),
				assistantStopReasons: messages.flatMap((message) => {
					const item = record(message);
					return item?.role === "assistant" ? [string(item.stopReason)] : [];
				}),
			};
		}
		case "turn_end": {
			const assistant = sanitizeAssistantV0(event.message);
			const results = Array.isArray(event.toolResults) ? event.toolResults : [];
			return {
				type,
				...(assistant === undefined ? {} : { assistant }),
				toolResults: results.map((result) => {
					const item = record(result) ?? {};
					return {
						toolCallId: string(item.toolCallId),
						toolName: string(item.toolName),
						isError: item.isError === true,
					};
				}),
			};
		}
		case "message_start":
		case "message_end": {
			const assistant = type === "message_end" ? sanitizeAssistantV0(event.message) : undefined;
			return { type, role: roleOf(event.message), ...(assistant === undefined ? {} : { assistant }) };
		}
		// Streaming deltas carry text, reasoning and argument fragments only: they are not evidence.
		case "message_update":
			return undefined;
		case "tool_execution_start":
		case "tool_execution_update":
			return { type, toolCallId: string(event.toolCallId), toolName: string(event.toolName) };
		case "tool_execution_end":
			return {
				type,
				toolCallId: string(event.toolCallId),
				toolName: string(event.toolName),
				isError: event.isError === true,
			};
		case "compaction_start":
			return { type, reason: string(event.reason) };
		case "compaction_end":
			return {
				type,
				reason: string(event.reason),
				aborted: event.aborted === true,
				willRetry: event.willRetry === true,
				succeeded: record(event.result) !== undefined,
			};
		case "auto_retry_start":
			return { type, attempt: number(event.attempt), maxAttempts: number(event.maxAttempts) };
		case "auto_retry_end":
			return { type, success: event.success === true, attempt: number(event.attempt) };
		case "session_action_update":
			return { type, queuedCount: number(record(event.actions)?.queuedCount) };
		case "extension_error":
			return { type };
		default:
			return { type: "unknown", primeType: type };
	}
}
