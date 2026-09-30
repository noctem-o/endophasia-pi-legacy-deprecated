// Privacy domains are deliberately closed. A new wire name needs a schema review before it can reach disk.
// Numeric drift and missing semantic witnesses remain inspectable; free text never does.
import { SCENARIOS } from "./probe.ts";

const FIELD_NAMES = new Set([
	"aggregateUsage",
	"childUsage",
	"content",
	"customType",
	"cwd",
	"details",
	"display",
	"firstKeptEntryId",
	"fromHook",
	"harnessDigest",
	"harnessStateFingerprint",
	"id",
	"message",
	"modelId",
	"parentId",
	"parentSession",
	"provider",
	"rlmDepth",
	"serviceTier",
	"state",
	"summary",
	"targetId",
	"thinkingLevel",
	"timestamp",
	"tokensBefore",
	"type",
	"usage",
	"version",
	"assistantMessages",
	"cancelled",
	"contextUsage",
	"cost",
	"messages",
	"sessionFile",
	"sessionId",
	"text",
	"tokens",
	"toolCalls",
	"toolResults",
	"totalMessages",
	"userMessages",
	"autoCompactionEnabled",
	"followUpMode",
	"goal",
	"isCompacting",
	"isStreaming",
	"messageCount",
	"model",
	"sessionActions",
	"steeringMode",
	"_meta",
	"kind",
	"messageId",
	"rawInput",
	"rawOutput",
	"sessionUpdate",
	"status",
	"title",
	"toolCallId",
	"autonomous",
	"compaction",
	"eventSequence",
	"outcome",
	"phase",
	"promptTurnId",
	"quiescence",
	"terminalQuiescenceExpected",
	"name",
	"loadSession",
	"mcpCapabilities",
	"mcpCapabilities.http",
	"mcpCapabilities.sse",
	"promptCapabilities",
	"promptCapabilities.embeddedContext",
	"promptCapabilities.image",
	"promptCapabilities.audio",
	"sessionCapabilities",
	"sessionCapabilities.close",
	"sessionCapabilities.fork",
	"sessionCapabilities.list",
	"sessionCapabilities.resume",
]);
const TAGS: Record<string, readonly string[]> = {
	schemaVersion: ["prime-acp-evidence.v0"],
	source: ["prime-agent"],
	generatedBy: ["prime-conformance-v0"],
	build: ["clean-checkout", "dirty-checkout", "unverified-checkout", "binary"],
	endophasiaBuild: ["clean-checkout", "dirty-checkout", "unverified-checkout"],
	mode: ["rpc", "acp"],
	agentName: ["prime-agent"],
	provider: ["probe-local"],
	model: ["probe-model"],
	role: ["user", "assistant", "toolResult", "custom", "bashExecution", "branchSummary", "compactionSummary"],
	messageRoles: ["user", "assistant", "toolResult", "custom", "bashExecution", "branchSummary", "compactionSummary"],
	stopReason: [
		"stop",
		"length",
		"toolUse",
		"error",
		"aborted",
		"end_turn",
		"cancelled",
		"max_tokens",
		"max_turn_requests",
		"refusal",
	],
	assistantStopReasons: ["stop", "length", "toolUse", "error", "aborted"],
	method: ["initialize", "session/new", "session/prompt", "session/close", "session/cancel", "session/load"],
	command: [
		"abort",
		"compact",
		"fork",
		"get_messages",
		"get_session_stats",
		"prompt",
		"set_auto_retry",
		"switch_session",
	],
	errorKind: ["queued-input-suspended", "input-admission-paused", "other"],
	kind: ["agent_message_chunk", "agent_thought_chunk", "session_info_update", "tool_call", "tool_call_update"],
	phase: ["event", "responseBoundary", "terminalQuiescence"],
	outcome: ["result", "error"],
	response: ["result", "error"],
	status: ["pending", "in_progress", "completed", "failed"],
	toolKind: ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"],
	toolName: ["probe_tool"],
	name: ["probe_tool"],
	reason: ["manual", "overflow", "threshold"],
	label: [
		"after",
		"after-compaction",
		"after-fork",
		"after-fork-prompt",
		"after-multi-a",
		"after-multi-b",
		"after-multi-c",
		"after-next-prompt",
		"after-open",
		"after-reopen",
		"after-resume",
		"before-compaction",
		"before-fork",
		"fork-original-after",
		"fork-original-before",
	],
	metaNamespaces: ["ai.primeintellect.prime-agent"],
	extraKeys: ["reasoning", "cacheWrite1h"],
	protocolErrors: ["RPC protocol failed", "ACP protocol failed"],
	failures: [
		"RPC scenario failed",
		"ACP cancellation local write failed",
		"ACP scenario execution failed",
		"ACP abnormal process exit",
		"ACP durable file decode failed",
		"ACP unexpected provider request",
	],
};
const TYPES = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
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
	"unknown",
	"session",
	"message",
	"child_usage_attributed",
	"compaction",
	"branch_summary",
	"custom_message",
	"model_change",
	"service_tier_change",
	"session_state",
	"thinking_level_change",
];
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const NUMBERS = new Set([
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"totalTokens",
	"total",
	"cost",
	"userMessages",
	"assistantMessages",
	"toolCalls",
	"toolResults",
	"totalMessages",
	"contextUsageTokens",
	"messagesAfterReopen",
	"forkTargets",
	"originalEntriesAfterFork",
	"forkSharedEntryIds",
	"providerRequests",
	"summaryRequests",
	"abortRequestedAfter",
	"attempt",
	"maxAttempts",
	"protocolVersion",
	"ordinal",
	"promptTurnId",
	"eventSequence",
	"errorCode",
	"triggerIndex",
	"cancelAfter",
	"continuationsUsed",
	"turnsUsed",
	"tokensUsed",
	"gateAttempt",
	"outstandingSubagents",
	"remainingAutonomousContinuations",
	"tokensBefore",
]);
const BOOLEANS = new Set([
	"success",
	"isError",
	"hasErrorMessage",
	"aborted",
	"willRetry",
	"succeeded",
	"plainPromptAfterAbortAdmitted",
	"followUpAfterAbortAdmitted",
	"plainPromptAfterCompactionAdmitted",
	"followUpAfterCompactionAdmitted",
	"reopenedIntendedSession",
	"entryIdsStableAcrossReopen",
	"forkCreatedNewFile",
	"forkSharedEntriesIdentical",
	"forkOriginalUnchanged",
	"forkParentLinked",
	"terminalQuiescenceExpected",
	"enabled",
	"hasGateFailure",
	"hasSummary",
]);
const LISTS = new Set([
	"events",
	"abortRequestedAfter",
	"commands",
	"stats",
	"sessionEntries",
	"entrySnapshots",
	"entries",
	"stateKeys",
	"protocolErrors",
	"failures",
	"keys",
	"dataKeys",
	"extraKeys",
	"toolCalls",
	"toolResults",
	"messageRoles",
	"assistantStopReasons",
	"updates",
	"prompts",
	"sessionIds",
	"cancelAfter",
	"files",
	"metaKeys",
	"agentInfoKeys",
	"capabilityFields",
	"metaNamespaces",
	"primeMetaKeys",
]);

/** Exhaustively visits scalar and list slots after each boundary's closed-object check. */
export function assertPrivacyDomains(value: unknown, scenario: string): void {
	const walk = (item: unknown, field: string, parent: string): void => {
		if (Array.isArray(item)) {
			if (!LISTS.has(field)) throw new Error("unapproved list slot");
			for (const element of item) walk(element, field, parent);
			return;
		}
		if (item !== null && typeof item === "object") {
			for (const [key, child] of Object.entries(item)) {
				if (field === "capabilityFlags" && !FIELD_NAMES.has(key)) throw new Error("unapproved capability name");
				walk(child, key, field);
			}
			return;
		}
		if (item === undefined) return; // Optional fields are checked by the boundary schema.
		if (item === null) {
			if (!["parentId", "contextUsageTokens"].includes(field)) throw new Error("unapproved null slot");
			return;
		}
		if (typeof item === "number") {
			if (!NUMBERS.has(field) || !Number.isFinite(item) || (item < 0 && field !== "errorCode"))
				throw new Error("invalid number");
			return;
		}
		if (typeof item === "boolean") {
			if (!BOOLEANS.has(field) && parent !== "capabilityFlags") throw new Error("unapproved boolean slot");
			return;
		}
		if (typeof item !== "string") throw new Error("unapproved scalar");
		let valid = false;
		if (TAGS[field]) valid = TAGS[field].includes(item);
		else if (
			["keys", "dataKeys", "stateKeys", "metaKeys", "agentInfoKeys", "capabilityFields", "primeMetaKeys"].includes(
				field,
			)
		)
			valid = FIELD_NAMES.has(item);
		else if (["commit", "endophasiaCommit"].includes(field)) valid = /^[0-9a-f]{40}$/.test(item);
		else if (["artifactsHash", "researchHash", "launcherHash", "lockHash"].includes(field))
			valid = /^[0-9a-f]{64}$/.test(item);
		else if (["version", "probeVersion", "agentVersion"].includes(field)) valid = /^\d+\.\d+\.\d+$/.test(item);
		else if (field === "node") valid = /^v\d+\.\d+\.\d+$/.test(item);
		else if (field === "platform")
			valid = /^(linux|darwin|win32|freebsd|openbsd|aix|sunos)-(x64|arm64|arm|ia32|ppc64|s390x|riscv64)$/.test(item);
		else if (field === "scenario")
			valid =
				SCENARIOS.some((s) => s.name === item) ||
				[
					"cancel-stream",
					"cancel-tool",
					"token-limit",
					"turn-limit",
					"gate-failure",
					"unsupported-requests",
					"multi-prompt",
					"close-recreate",
				].includes(item);
		else if (field === "description") valid = SCENARIOS.find((s) => s.name === scenario)?.description === item;
		else if (field === "type") valid = TYPES.includes(item);
		else if (field === "sessionId") valid = UUID.test(item);
		else if (["id", "parentId", "firstKeptEntryId", "targetId", "compactFirstKeptEntryId"].includes(field))
			valid =
				/^[0-9a-f]{8}$/.test(item) ||
				UUID.test(item) ||
				(parent === "toolCalls" && /^call_probe_[0-9]+$/.test(item));
		else if (field === "sessionIds") valid = UUID.test(item);
		else if (field === "toolCallId") valid = /^call_probe_[0-9]+$/.test(item);
		else if (field === "messageId") valid = /^prime-agent-assistant-[1-9][0-9]*$/.test(item);
		// No free-form unknown event/type name is safe to persist under this closed profile.
		if (!valid) throw new Error("unapproved string domain");
	};
	walk(value, "", "");
}
