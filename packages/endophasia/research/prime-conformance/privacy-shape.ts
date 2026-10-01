// Defensive fixture boundary: reject payload slots even when their values do not contain a probe sentinel.
import type { PrimeScenarioEvidenceV0 } from "./evidence.ts";
import { assertRequiredProvenance } from "./evidence.ts";
import { assertPlainEvidence } from "./plain-data.ts";
import { assertPrivacyDomains } from "./privacy-domains.ts";

const ENTRY = [
	"type",
	"id",
	"parentId",
	"role",
	"stopReason",
	"usage",
	"firstKeptEntryId",
	"targetId",
	"childUsage",
	"aggregateUsage",
	"keys",
];
const USAGE = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "extraKeys"];
const COST = ["input", "output", "cacheRead", "cacheWrite", "total"];
export function rpcPrivacyShapeProblems(run: PrimeScenarioEvidenceV0): string[] {
	const checked = new Set<object>();
	function closed(value: unknown, keys: readonly string[]): void {
		if (
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).some((key) => !keys.includes(key))
		)
			throw new Error("unapproved RPC evidence field");
		checked.add(value);
	}
	try {
		assertPlainEvidence(run);
		closed(run, [
			"provenance",
			"description",
			"events",
			"abortRequestedAfter",
			"commands",
			"stats",
			"sessionEntries",
			"entrySnapshots",
			"stateKeys",
			"observations",
			"protocolErrors",
			"failures",
		]);
		closed(run.provenance, [
			"source",
			"version",
			"commit",
			"artifactsHash",
			"build",
			"mode",
			"generatedBy",
			"probeVersion",
			"platform",
			"node",
			"endophasiaCommit",
			"endophasiaBuild",
			"researchHash",
			"launcherHash",
			"lockHash",
			"scenario",
		]);
		assertRequiredProvenance(run.provenance, "rpc");
		closed(run.observations, [
			"plainPromptAfterAbortAdmitted",
			"followUpAfterAbortAdmitted",
			"plainPromptAfterCompactionAdmitted",
			"followUpAfterCompactionAdmitted",
			"reopenedIntendedSession",
			"messagesAfterReopen",
			"entryIdsStableAcrossReopen",
			"forkTargets",
			"forkCreatedNewFile",
			"originalEntriesAfterFork",
			"forkSharedEntryIds",
			"forkSharedEntriesIdentical",
			"forkOriginalUnchanged",
			"forkParentLinked",
			"providerRequests",
			"summaryRequests",
			"compactFirstKeptEntryId",
		]);
		for (const command of run.commands) closed(command, ["command", "success", "dataKeys", "errorKind"]);
		for (const stats of run.stats) {
			closed(stats, [
				"label",
				"userMessages",
				"assistantMessages",
				"toolCalls",
				"toolResults",
				"totalMessages",
				"tokens",
				"cost",
				"contextUsageTokens",
				"keys",
			]);
			closed(stats.tokens, ["input", "output", "cacheRead", "cacheWrite", "total"]);
		}
		for (const snapshot of run.entrySnapshots) closed(snapshot, ["label", "entries"]);
		for (const entry of [...run.sessionEntries, ...run.entrySnapshots.flatMap((s) => s.entries)]) {
			closed(entry, ENTRY);
			for (const usage of [entry.usage, entry.childUsage, entry.aggregateUsage])
				if (usage) {
					closed(usage, USAGE);
					closed(usage.cost, COST);
				}
		}
		for (const event of run.events) {
			const fields: Record<string, readonly string[]> = {
				agent_start: [],
				agent_end: ["messageRoles", "assistantStopReasons"],
				turn_start: [],
				turn_end: ["assistant", "toolResults"],
				message_start: ["role"],
				message_end: ["role", "assistant"],
				tool_execution_start: ["toolCallId", "toolName"],
				tool_execution_update: ["toolCallId", "toolName"],
				tool_execution_end: ["toolCallId", "toolName", "isError"],
				compaction_start: ["reason"],
				compaction_end: ["reason", "aborted", "willRetry", "succeeded"],
				auto_retry_start: ["attempt", "maxAttempts"],
				auto_retry_end: ["success", "attempt"],
				session_action_update: [],
				extension_error: [],
				unknown: ["primeType"],
			};
			closed(event, ["type", ...(fields[event.type] ?? [])]);
			if ((event.type === "turn_end" || event.type === "message_end") && event.assistant) {
				closed(event.assistant, ["stopReason", "provider", "model", "usage", "toolCalls", "hasErrorMessage"]);
				closed(event.assistant.usage, USAGE);
				closed(event.assistant.usage.cost, COST);
				for (const tool of event.assistant.toolCalls) closed(tool, ["id", "name"]);
			}
			if (event.type === "turn_end")
				for (const result of event.toolResults) closed(result, ["toolCallId", "toolName", "isError"]);
		}
		// A scalar/list slot must not smuggle a new object past the closed object checks above.
		const walk = (value: unknown): void => {
			if (Array.isArray(value)) {
				for (const item of value) walk(item);
			} else if (value !== null && typeof value === "object") {
				if (!checked.has(value)) throw new Error("unapproved RPC evidence object");
				for (const item of Object.values(value)) walk(item);
			}
		};
		walk(run);
		assertPrivacyDomains(run, run.provenance.scenario);
		return [];
	} catch {
		return ["RPC evidence contains an unapproved payload field"];
	}
}
