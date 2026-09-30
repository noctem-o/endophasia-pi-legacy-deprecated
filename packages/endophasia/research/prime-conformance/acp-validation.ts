// Re-check persisted, sanitized ACP evidence. Correlation is scoped to the ACP slot, never a durable operation.
import { type AcpScenarioEvidence, acpObject, acpSessionId } from "./acp-evidence.ts";
import { ACP_SCENARIOS } from "./acp-probe.ts";
import { PROBE_MODEL_COST } from "./environment.ts";
import { entryProblems } from "./evidence.ts";
import { expectedPrimeUsageV0 } from "./fake-provider.ts";
import type { PrimeUsageEvidenceV0 } from "./protocol.ts";

function closed(value: unknown, fields: string[]): Record<string, unknown> {
	const record = acpObject(value, "sanitized object");
	if (Object.keys(record).some((key) => !fields.includes(key))) throw new Error("unapproved evidence field");
	return record;
}
function strings(value: unknown): void {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("string list required");
}
function integer(value: unknown, negative = false): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || (!negative && value < 0))
		throw new Error("safe integer required");
}
function boolean(value: unknown): void {
	if (typeof value !== "boolean") throw new Error("boolean required");
}
function tag(value: unknown, choices: string[]): void {
	if (typeof value !== "string" || !choices.includes(value)) throw new Error("closed discriminator required");
}
function usage(value: unknown): void {
	const u = closed(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "extraKeys"]);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) integer(u[key]);
	const cost = closed(u.cost, ["input", "output", "cacheRead", "cacheWrite", "total"]);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
		if (typeof cost[key] !== "number" || !Number.isFinite(cost[key]) || cost[key] < 0)
			throw new Error("finite cost required");
	}
	strings(u.extraKeys);
}

/** Privacy/closed shape only: failed or incomplete experiments remain safe diagnostic material. */
export function acpPrivacyShapeProblems(value: unknown): string[] {
	try {
		const v = closed(value, [
			"schemaVersion",
			"provenance",
			"initialize",
			"updates",
			"prompts",
			"commands",
			"sessionIds",
			"cancelAfter",
			"providerRequests",
			"summaryRequests",
			"files",
			"protocolErrors",
			"failures",
		]);
		tag(v.schemaVersion, ["prime-acp-evidence.v0"]);
		const p = closed(v.provenance, [
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
			"researchHash",
			"launcherHash",
			"lockHash",
			"endophasiaBuild",
			"scenario",
		]);
		tag(p.mode, ["acp"]);
		for (const key of Object.keys(p)) if (typeof p[key] !== "string") throw new Error("provenance string required");
		if (v.initialize !== undefined) {
			const init = closed(v.initialize, [
				"protocolVersion",
				"agentName",
				"agentVersion",
				"agentInfoKeys",
				"capabilityFields",
				"capabilityFlags",
				"metaNamespaces",
				"primeMetaKeys",
			]);
			integer(init.protocolVersion);
			for (const key of ["agentName", "agentVersion"])
				if (typeof init[key] !== "string") throw new Error("agent identity required");
			for (const key of ["agentInfoKeys", "capabilityFields", "metaNamespaces", "primeMetaKeys"]) strings(init[key]);
			for (const flag of Object.values(acpObject(init.capabilityFlags, "capability flags"))) boolean(flag);
		}
		for (const key of [
			"updates",
			"prompts",
			"commands",
			"sessionIds",
			"cancelAfter",
			"files",
			"protocolErrors",
			"failures",
		])
			if (!Array.isArray(v[key])) throw new Error("list required");
		strings(v.sessionIds);
		strings(v.protocolErrors);
		strings(v.failures);
		integer(v.providerRequests);
		integer(v.summaryRequests);
		const run = value as AcpScenarioEvidence;
		for (const id of run.sessionIds) acpSessionId(id);
		for (const index of run.cancelAfter) integer(index);
		for (const prompt of run.prompts) {
			closed(prompt, ["ordinal", "response", "stopReason", "errorCode"]);
			integer(prompt.ordinal);
			tag(prompt.response, ["result", "error"]);
			if (prompt.response === "result") {
				tag(prompt.stopReason, ["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"]);
				if (prompt.errorCode !== undefined) throw new Error("result with error");
			} else {
				integer(prompt.errorCode, true);
				if (prompt.stopReason !== undefined) throw new Error("error with stop reason");
			}
		}
		for (const command of run.commands) {
			closed(command, ["method", "success", "errorCode", "sessionId", "triggerIndex"]);
			tag(command.method, [
				"initialize",
				"session/new",
				"session/prompt",
				"session/close",
				"session/cancel",
				"session/load",
			]);
			boolean(command.success);
			if (command.sessionId !== undefined) acpSessionId(command.sessionId);
			if (command.triggerIndex !== undefined) integer(command.triggerIndex);
			if (command.errorCode !== undefined) {
				integer(command.errorCode, true);
				if (command.success) throw new Error("command contradicts error");
			}
		}
		for (const update of run.updates) {
			closed(update, [
				"sessionId",
				"kind",
				"keys",
				"metaKeys",
				"promptTurnId",
				"eventSequence",
				"phase",
				"outcome",
				"terminalQuiescenceExpected",
				"toolCallId",
				"toolKind",
				"status",
				"messageId",
				"autonomous",
				"quiescence",
				"compaction",
			]);
			acpSessionId(update.sessionId);
			strings(update.keys);
			strings(update.metaKeys);
			integer(update.promptTurnId);
			integer(update.eventSequence);
			if (typeof update.kind !== "string" || !/^[a-z_]+$/.test(update.kind)) throw new Error("update kind required");
			tag(update.phase, ["event", "responseBoundary", "terminalQuiescence"]);
			if (update.outcome !== undefined) tag(update.outcome, ["result", "error"]);
			if (update.terminalQuiescenceExpected !== undefined) boolean(update.terminalQuiescenceExpected);
			if (update.status !== undefined) tag(update.status, ["pending", "in_progress", "completed", "failed"]);
			if (update.toolKind !== undefined)
				tag(update.toolKind, ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);
			if (update.toolCallId !== undefined && !/^call_probe_[0-9]+$/.test(update.toolCallId))
				throw new Error("unexpected tool identity");
			if (update.messageId !== undefined && !/^prime-agent-assistant-[1-9][0-9]*$/.test(update.messageId))
				throw new Error("unexpected message identity");
			if (update.autonomous !== undefined) {
				const a = closed(update.autonomous, [
					"enabled",
					"continuationsUsed",
					"turnsUsed",
					"tokensUsed",
					"gateAttempt",
					"hasGateFailure",
				]);
				boolean(a.enabled);
				boolean(a.hasGateFailure);
				for (const key of ["continuationsUsed", "turnsUsed", "tokensUsed"]) integer(a[key]);
				if (a.gateAttempt !== undefined) integer(a.gateAttempt);
			}
			if (update.quiescence !== undefined) {
				const q = closed(update.quiescence, ["outstandingSubagents", "remainingAutonomousContinuations"]);
				integer(q.outstandingSubagents);
				integer(q.remainingAutonomousContinuations);
			}
			if (update.compaction !== undefined) {
				const c = closed(update.compaction, ["tokensBefore", "hasSummary"]);
				boolean(c.hasSummary);
				if (c.tokensBefore !== undefined) integer(c.tokensBefore);
			}
		}
		for (const file of run.files) {
			if (!Array.isArray(file)) throw new Error("file list required");
			for (const entry of file) {
				closed(entry, [
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
				]);
				strings(entry.keys);
				for (const key of ["type", "id", "parentId", "role", "stopReason", "firstKeptEntryId", "targetId"])
					if (
						entry[key as keyof typeof entry] !== undefined &&
						entry[key as keyof typeof entry] !== null &&
						typeof entry[key as keyof typeof entry] !== "string"
					)
						throw new Error("entry identity string required");
				for (const u of [entry.usage, entry.childUsage, entry.aggregateUsage]) if (u !== undefined) usage(u);
			}
		}
		return [];
	} catch {
		return ["ACP evidence is not the closed sanitized schema"];
	}
}

export function acpEvidenceProblems(value: unknown): string[] {
	const shape = acpPrivacyShapeProblems(value);
	if (shape.length) return shape;
	const run = value as AcpScenarioEvidence;
	return [...run.files.flatMap((file) => entryProblems("ACP durable file", file)), ...acpScenarioProblems(run)];
}

export function acpScenarioProblems(run: AcpScenarioEvidence): string[] {
	const problems: string[] = [];
	const scenario = ACP_SCENARIOS.find((s) => s.name === run.provenance.scenario);
	if (!scenario) return ["unknown ACP scenario"];
	const expectedPrompts = scenario.markers.length + (scenario.name === "compaction" ? 1 : 0);
	if (run.prompts.length !== expectedPrompts || run.prompts.some((p, i) => p.ordinal !== i + 1))
		problems.push("ACP prompt coverage or ordinals incomplete");
	if (
		run.sessionIds.length !== (scenario.name === "close-recreate" ? 2 : 1) ||
		new Set(run.sessionIds).size !== run.sessionIds.length
	)
		problems.push("ACP session identity coverage incomplete");
	if (
		!run.commands.some((c) => c.method === "initialize" && c.success) ||
		run.commands.filter((c) => c.method === "session/close" && c.success).length !== run.sessionIds.length
	)
		problems.push("ACP initialization/close lifecycle incomplete");
	const ended = new Set<string>();
	const sequences = new Map<string, number>();
	const tools = new Map<string, string>();
	for (const u of run.updates) {
		if (!run.sessionIds.includes(u.sessionId)) problems.push("ACP update names an unknown session");
		if (u.eventSequence !== (sequences.get(u.sessionId) ?? 0) + 1)
			problems.push("ACP producer sequence repeats or has a gap");
		sequences.set(u.sessionId, u.eventSequence);
		const lifecycle = `${u.sessionId}/${u.promptTurnId}`;
		if (ended.has(lifecycle)) problems.push("ACP update follows terminal quiescence");
		if (u.phase === "terminalQuiescence") ended.add(lifecycle);
		for (const field of ["promptTurnId", "eventSequence", "phase"])
			if (!u.metaKeys.includes(field)) problems.push("ACP metadata keys contradict recorded fields");
		const turns = scenario.name === "close-recreate" ? 1 : expectedPrompts;
		// This probe retains only prompt-associated updates. No session-level update is used as prompt evidence.
		if (u.promptTurnId < 1 || u.promptTurnId > turns) problems.push("ACP update names an unknown prompt");
		if (u.phase !== "event" && (u.promptTurnId === 0 || u.outcome === undefined))
			problems.push("ACP terminal lacks prompt/outcome");
		const key = `${u.sessionId}/${u.promptTurnId}/${u.toolCallId}`;
		if (u.kind === "tool_call") {
			if (!u.toolCallId || !u.toolKind || u.status !== "in_progress" || tools.has(key))
				problems.push("ACP tool start is incomplete or duplicate");
			tools.set(key, "in_progress");
		}
		if (u.kind === "tool_call_update") {
			if (tools.get(key) !== "in_progress" || !["completed", "failed"].includes(u.status ?? ""))
				problems.push("ACP tool terminal has no matching start");
			tools.set(key, u.status ?? "unknown");
		}
	}
	for (const [i, prompt] of run.prompts.entries()) {
		const session = run.sessionIds[scenario.name === "close-recreate" ? i : 0];
		const turn = scenario.name === "close-recreate" ? 1 : i + 1;
		const updates = run.updates.filter((u) => u.sessionId === session && u.promptTurnId === turn);
		const boundaries = updates.filter((u) => u.phase === "responseBoundary");
		const terminals = updates.filter((u) => u.phase === "terminalQuiescence");
		if (boundaries.length > 1 || terminals.length > 1) problems.push("ACP duplicate boundary/terminal");
		if (boundaries.some((u) => u.terminalQuiescenceExpected !== true))
			problems.push("ACP response boundary lacks terminal promise");
		if (updates.some((u) => u.phase === "event" && u.outcome !== undefined))
			problems.push("ACP ordinary update carries a terminal outcome");
		if (
			prompt.stopReason !== "cancelled" &&
			[...tools.entries()].some(([key, status]) => key.startsWith(`${session}/${turn}/`) && status === "in_progress")
		)
			problems.push("ACP completed prompt has unfinished tool");
		// Early cancellation is a documented path without terminal envelopes; absence stays an observation.
		if (prompt.stopReason !== "cancelled" && (boundaries.length !== 1 || terminals.length !== 1))
			problems.push("ACP noncancelled prompt lacks unique response/terminal envelope");
		if (boundaries.some((u) => u.outcome !== prompt.response) || terminals.some((u) => u.outcome !== prompt.response))
			problems.push("ACP envelope contradicts prompt response");
		if (terminals.some((u) => !u.quiescence || u.quiescence.outstandingSubagents !== 0))
			problems.push("ACP terminal lacks reconciled child quiescence");
		if (boundaries.length && terminals.length && boundaries[0]!.eventSequence >= terminals[0]!.eventSequence)
			problems.push("ACP terminal precedes response boundary");
	}
	if (scenario.name.startsWith("cancel-")) {
		const cancels = run.commands.filter((c) => c.method === "session/cancel");
		const expected = scenario.name === "cancel-stream" ? "agent_message_chunk" : "tool_call";
		if (run.cancelAfter.length !== 1 || run.updates[run.cancelAfter[0] ?? -1]?.kind !== expected)
			problems.push("ACP cancellation trigger missing");
		const cancel = cancels[0];
		const trigger = run.updates[run.cancelAfter[0] ?? -1];
		if (
			cancels.length !== 1 ||
			cancel?.success !== true ||
			cancel.errorCode !== undefined ||
			cancel.triggerIndex !== run.cancelAfter[0] ||
			cancel.sessionId !== trigger?.sessionId
		)
			problems.push("ACP successful local cancellation emission missing or uncorrelated");
	} else if (run.cancelAfter.length || run.commands.some((c) => c.method === "session/cancel"))
		problems.push("unexpected ACP cancellation");
	if (
		scenario.name === "unsupported-requests" &&
		run.commands.filter((c) => !c.success && c.errorCode !== undefined).length !== 3
	)
		problems.push("ACP rejection coverage incomplete");
	const expectedRequests =
		scenario.markers.length + (["tool-run", "tool-error"].includes(scenario.name) ? 1 : 0) + run.summaryRequests;
	if (run.providerRequests !== expectedRequests) problems.push("ACP provider witness missing");
	if (scenario.name !== "compaction" && run.summaryRequests !== 0) problems.push("ACP unexpected summary request");
	if (
		scenario.name === "compaction" &&
		(run.summaryRequests < 1 ||
			run.summaryRequests > 2 ||
			!run.files.flat().some((entry) => entry.type === "compaction") ||
			!run.updates.some((u) => u.compaction?.hasSummary))
	)
		problems.push("ACP compaction witness incomplete");
	if (scenario.name !== "unsupported-requests" && run.files.length !== 1)
		problems.push("ACP durable session witness incomplete");
	if (run.summaryRequests > run.providerRequests)
		problems.push("ACP summary request count contradicts provider count");
	return [...new Set(problems)];
}

// Numeric disagreements with the audited provider mapping are real observed drift, not a malformed transport.
function exactUsage(
	actual: PrimeUsageEvidenceV0 | undefined,
	expected: ReturnType<typeof expectedPrimeUsageV0>,
	count = 1,
): boolean {
	return (
		actual !== undefined &&
		actual.extraKeys?.length === 0 &&
		(["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const).every(
			(key) => actual[key] === expected[key] * count,
		) &&
		(["input", "output", "cacheRead", "cacheWrite", "total"] as const).every(
			(key) => actual.cost?.[key] === expected.cost[key] * count,
		)
	);
}

export function acpUsageScriptMatches(run: AcpScenarioEvidence): boolean {
	const names = run.provenance.scenario;
	const script =
		names === "tool-run" || names === "tool-error"
			? ["tool-call", "tool-answer"]
			: names === "cancel-tool"
				? ["tool-call"]
				: names === "cancel-stream" || names === "provider-failure"
					? [null]
					: names === "length-stop"
						? ["length"]
						: names === "reasoning-usage"
							? ["reasoning"]
							: names === "multi-prompt" || names === "close-recreate" || names === "compaction"
								? ["multi-a", "multi-b"]
								: names === "unsupported-requests"
									? []
									: ["simple"];
	const assistants = run.files.flat().filter((entry) => entry.type === "message" && entry.role === "assistant");
	const expected = script.map((name) =>
		name === null
			? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				}
			: expectedPrimeUsageV0(name, PROBE_MODEL_COST),
	);
	if (assistants.length !== expected.length) return false;
	if (assistants.some((entry, i) => !exactUsage(entry.usage, expected[i]!))) return false;
	const summaries = run.files.flat().filter((entry) => entry.type === "compaction");
	if (summaries.length !== (names === "compaction" ? 1 : 0)) return false;
	if (summaries.length) {
		if (!exactUsage(summaries[0]!.usage, expectedPrimeUsageV0("summary", PROBE_MODEL_COST), run.summaryRequests))
			return false;
	}
	return true;
}
