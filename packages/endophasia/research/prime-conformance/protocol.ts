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
// Evidence shapes: only identities, kinds, flags and numbers. They are produced by decode.ts, which validates Prime's
// structure first; unknown event types are kept by name only, for forward compatibility.

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
	readonly provider: string;
	readonly model: string;
	readonly usage: PrimeUsageEvidenceV0;
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
			readonly assistant: PrimeAssistantEvidenceV0;
			readonly toolResults: readonly {
				readonly toolCallId: string;
				readonly toolName: string;
				readonly isError: boolean;
			}[];
	  }
	| { readonly type: "message_start"; readonly role: string }
	| { readonly type: "message_end"; readonly role: string; readonly assistant?: PrimeAssistantEvidenceV0 }
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
	| { readonly type: "session_action_update" }
	| { readonly type: "extension_error" }
	| { readonly type: "unknown"; readonly primeType: string };
