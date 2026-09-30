// Research-only ACP evidence. No raw content, tool arguments, errors or arbitrary _meta values survive.
import { PrimeDecodeError } from "./decode.ts";
import type { PrimeProvenanceV0, PrimeSessionEntryEvidenceV0 } from "./evidence.ts";

export const ACP_NAMESPACE = "ai.primeintellect.prime-agent";
export type AcpProvenance = Omit<PrimeProvenanceV0, "mode"> & { readonly mode: "acp"; readonly scenario: string };
export interface AcpInitializeEvidence {
	protocolVersion: number;
	agentName: string;
	agentVersion: string;
	agentInfoKeys: string[];
	capabilityFields: string[];
	capabilityFlags: Record<string, boolean>;
	metaNamespaces: string[];
	primeMetaKeys: string[];
}
export interface AcpUpdateEvidence {
	sessionId: string;
	kind: string;
	keys: string[];
	metaKeys: string[];
	promptTurnId: number;
	eventSequence: number;
	phase: "event" | "responseBoundary" | "terminalQuiescence";
	outcome?: "result" | "error";
	terminalQuiescenceExpected?: boolean;
	toolCallId?: string;
	toolKind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed";
	messageId?: string;
	autonomous?: {
		enabled: boolean;
		continuationsUsed: number;
		turnsUsed: number;
		tokensUsed: number;
		gateAttempt?: number;
		hasGateFailure: boolean;
	};
	quiescence?: { outstandingSubagents: number; remainingAutonomousContinuations: number };
	compaction?: { tokensBefore?: number; hasSummary: boolean };
}
export interface AcpPromptEvidence {
	ordinal: number;
	response: "result" | "error";
	stopReason?: string;
	errorCode?: number;
}
export interface AcpScenarioEvidence {
	schemaVersion: "prime-acp-evidence.v0";
	provenance: AcpProvenance;
	initialize?: AcpInitializeEvidence;
	updates: AcpUpdateEvidence[];
	prompts: AcpPromptEvidence[];
	/** session/cancel success means local write completion only, never remote acknowledgement. */
	commands: { method: string; success: boolean; errorCode?: number; sessionId?: string; triggerIndex?: number }[];
	sessionIds: string[];
	cancelAfter: number[];
	providerRequests: number;
	summaryRequests: number;
	/** Durable file observations are separate from ACP wire observations. */
	files: PrimeSessionEntryEvidenceV0[][];
	protocolErrors: string[];
	failures: string[];
}

export function acpObject(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new PrimeDecodeError(`${path}: object required`);
	return value as Record<string, unknown>;
}
function text(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) throw new PrimeDecodeError(`${path}: string required`);
	return value;
}
function flag(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw new PrimeDecodeError(`${path}: boolean required`);
	return value;
}
function count(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new PrimeDecodeError(`${path}: safe count required`);
	return value;
}
function choice<const T extends string>(value: unknown, choices: readonly T[], path: string): T {
	if (typeof value !== "string" || !choices.includes(value as T))
		throw new PrimeDecodeError(`${path}: invalid discriminator`);
	return value as T;
}
export function acpSessionId(value: unknown): string {
	const id = text(value, "sessionId");
	if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
		throw new PrimeDecodeError("sessionId: UUID required");
	return id;
}

export function decodeAcpInitialize(value: unknown): AcpInitializeEvidence {
	const result = acpObject(value, "initialize");
	const info = acpObject(result.agentInfo, "agentInfo");
	const capabilities = acpObject(result.agentCapabilities, "agentCapabilities");
	const fields: string[] = [];
	const flags: Record<string, boolean> = {};
	const walk = (record: Record<string, unknown>, prefix: string, depth = 0): void => {
		if (depth > 8) throw new PrimeDecodeError("capabilities: excessive nesting");
		for (const [key, item] of Object.entries(record)) {
			const path = prefix ? `${prefix}.${key}` : key;
			fields.push(path);
			if (typeof item === "boolean") flags[path] = item;
			else if (key === "_meta") acpObject(item, "capability _meta");
			else walk(acpObject(item, "capability group"), path, depth + 1);
		}
	};
	walk(capabilities, "");
	const meta = acpObject(result._meta, "initialize._meta");
	return {
		protocolVersion: count(result.protocolVersion, "protocolVersion"),
		agentName: text(info.name, "agentInfo.name"),
		agentVersion: text(info.version, "agentInfo.version"),
		agentInfoKeys: Object.keys(info).sort(),
		capabilityFields: fields.sort(),
		capabilityFlags: flags,
		metaNamespaces: Object.keys(meta).sort(),
		primeMetaKeys: Object.keys(acpObject(meta[ACP_NAMESPACE], "Prime _meta")).sort(),
	};
}

export function decodeAcpUpdate(value: unknown): AcpUpdateEvidence {
	const params = acpObject(value, "session/update");
	const update = acpObject(params.update, "update");
	const meta = acpObject(acpObject(update._meta, "update._meta")[ACP_NAMESPACE], "Prime _meta");
	const result: AcpUpdateEvidence = {
		sessionId: acpSessionId(params.sessionId),
		kind: text(update.sessionUpdate, "sessionUpdate"),
		keys: Object.keys(update).sort(),
		metaKeys: Object.keys(meta).sort(),
		promptTurnId: count(meta.promptTurnId, "promptTurnId"),
		eventSequence: count(meta.eventSequence, "eventSequence"),
		phase: choice(meta.phase, ["event", "responseBoundary", "terminalQuiescence"], "phase"),
	};
	if (meta.outcome !== undefined) result.outcome = choice(meta.outcome, ["result", "error"], "outcome");
	if (meta.terminalQuiescenceExpected !== undefined)
		result.terminalQuiescenceExpected = flag(meta.terminalQuiescenceExpected, "terminalQuiescenceExpected");
	if (update.toolCallId !== undefined) result.toolCallId = text(update.toolCallId, "toolCallId");
	if (update.kind !== undefined)
		result.toolKind = choice(
			update.kind,
			["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"],
			"tool kind",
		);
	if (update.status !== undefined)
		result.status = choice(update.status, ["pending", "in_progress", "completed", "failed"], "tool status");
	if (update.messageId !== undefined) result.messageId = text(update.messageId, "messageId");
	if (["agent_message_chunk", "agent_thought_chunk"].includes(result.kind)) {
		const content = acpObject(update.content, "content");
		if (content.type !== "text" || typeof content.text !== "string")
			throw new PrimeDecodeError("stream chunk: text required");
	}
	if (
		result.kind === "tool_call" &&
		(result.toolCallId === undefined || result.status === undefined || result.toolKind === undefined)
	)
		throw new PrimeDecodeError("tool_call: identity, kind and status required");
	if (result.kind === "tool_call_update" && (result.toolCallId === undefined || result.status === undefined))
		throw new PrimeDecodeError("tool_call_update: identity and status required");
	if (meta.autonomous !== undefined) {
		const a = acpObject(meta.autonomous, "autonomous");
		result.autonomous = {
			enabled: flag(a.enabled, "autonomous.enabled"),
			continuationsUsed: count(a.continuationsUsed, "continuationsUsed"),
			turnsUsed: count(a.turnsUsed, "turnsUsed"),
			tokensUsed: count(a.tokensUsed, "tokensUsed"),
			hasGateFailure: a.gateFailure !== undefined,
		};
		if (a.gateAttempt !== undefined) result.autonomous.gateAttempt = count(a.gateAttempt, "gateAttempt");
		if (a.gateFailure !== undefined && typeof a.gateFailure !== "string")
			throw new PrimeDecodeError("gateFailure: text required");
	}
	if (meta.quiescence !== undefined) {
		const q = acpObject(meta.quiescence, "quiescence");
		result.quiescence = {
			outstandingSubagents: count(q.outstandingSubagents, "outstandingSubagents"),
			remainingAutonomousContinuations: count(
				q.remainingAutonomousContinuations,
				"remainingAutonomousContinuations",
			),
		};
	}
	if (meta.compaction !== undefined) {
		const c = acpObject(meta.compaction, "compaction");
		result.compaction = { hasSummary: typeof c.summary === "string" && c.summary.length > 0 };
		if (c.summary !== undefined && typeof c.summary !== "string")
			throw new PrimeDecodeError("compaction.summary: text required");
		if (c.tokensBefore !== undefined) result.compaction.tokensBefore = count(c.tokensBefore, "tokensBefore");
	}
	return result;
}

export function decodeAcpPrompt(value: unknown, ordinal: number): AcpPromptEvidence {
	const result = acpObject(value, "prompt result");
	return {
		ordinal,
		response: "result",
		stopReason: choice(
			result.stopReason,
			["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"],
			"stopReason",
		),
	};
}
