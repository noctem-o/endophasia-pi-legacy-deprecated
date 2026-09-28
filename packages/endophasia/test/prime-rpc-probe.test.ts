// Offline tests for the research-only Prime RPC conformance probe (Prime Runtime Conformance v0) at the Prime boundary:
// JSONL framing, request correlation and process lifecycle, the strict decoders, the fake provider's expectations,
// executable resolution and failure-text safety. No Prime installation is needed; a local fake RPC server stands in.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	classifyPrimeRefusalV0,
	commandEvidenceV0,
	decodePrimeCompactionResultV0,
	decodePrimeEventV0,
	decodePrimeForkTargetsV0,
	decodePrimeMessageCountV0,
	decodePrimeSessionFileV0,
	decodePrimeSessionLineV0,
	decodePrimeStateV0,
	decodePrimeStatsV0,
	decodePrimeUsageV0,
	PrimeDecodeError,
	requirePrimeNotCancelledV0,
} from "../research/prime-conformance/decode.ts";
import { resolvePrimeBinaryV0 } from "../research/prime-conformance/environment.ts";
import {
	type FakeProviderRequestV0,
	SENTINEL_PATTERN,
	SENTINELS,
	startFakeProviderV0,
} from "../research/prime-conformance/fake-provider.ts";
import { encodeJsonlRecordV0, JsonlDecoderV0, type JsonlRecordV0 } from "../research/prime-conformance/jsonl.ts";
import { abnormalExitV0, failureTextV0, PrimeProbeFailureV0 } from "../research/prime-conformance/probe.ts";
import { classifyPrimeRecordV0, type PrimeRpcResponseV0 } from "../research/prime-conformance/protocol.ts";
import { PrimeRpcClientV0, PrimeRpcError, PrimeRpcExitError } from "../research/prime-conformance/rpc-client.ts";

const fakeServer = fileURLToPath(new URL("./fixtures/prime/fake-rpc-server.mjs", import.meta.url));

function objects(records: JsonlRecordV0[]): Record<string, unknown>[] {
	return records.flatMap((record) => (record.kind === "object" ? [record.value] : []));
}

/** Probe sentinels in a serialized value. */
function leaks(value: unknown): string[] {
	return JSON.stringify(value).match(new RegExp(SENTINEL_PATTERN, "g")) ?? [];
}

/** A deep copy with one path changed; `undefined` deletes the field. */
function mutate<T>(value: T, path: readonly (string | number)[], next: unknown): T {
	const copy = structuredClone(value) as Record<string | number, unknown>;
	let cursor = copy;
	for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
	const last = path.at(-1)!;
	if (next === undefined) delete cursor[last];
	else cursor[last] = next;
	return copy as T;
}

function expectDecodeError(run: () => unknown): void {
	expect(run).toThrow(PrimeDecodeError);
}

const usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 1, output: 4, cacheRead: 1.5, cacheWrite: 1, total: 7.5 },
};

const assistant = {
	role: "assistant",
	content: [
		{ type: "text", text: SENTINELS.assistant },
		{ type: "thinking", thinking: SENTINELS.reasoning },
		{ type: "toolCall", id: "call_1", name: "probe_tool", arguments: { note: SENTINELS.toolArgs } },
	],
	api: "openai-completions",
	provider: "probe-local",
	model: "probe-model",
	usage,
	stopReason: "toolUse",
	errorMessage: SENTINELS.errorDetail,
	timestamp: 1,
};

const toolResult = {
	role: "toolResult",
	toolCallId: "call_1",
	toolName: "probe_tool",
	content: [{ type: "text", text: SENTINELS.toolResult }],
	isError: true,
	timestamp: 2,
};

const response = (command: string, data: unknown, success = true): PrimeRpcResponseV0 => ({
	command,
	success,
	...(data === undefined ? {} : { data }),
});

describe("JsonlDecoderV0", () => {
	it("reassembles a multi-byte character split across chunks", () => {
		const decoder = new JsonlDecoderV0();
		const bytes = Buffer.from('{"text":"é€𝄞"}\n');
		const records = [...bytes].flatMap((byte) => decoder.push(Uint8Array.of(byte)));
		expect(objects(records)).toEqual([{ text: "é€𝄞" }]);
	});

	it("returns every record of one chunk and keeps a partial record buffered", () => {
		const decoder = new JsonlDecoderV0();
		expect(objects(decoder.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":')))).toEqual([{ a: 1 }, { b: 2 }]);
		expect(decoder.push(Buffer.from("3"))).toEqual([]);
		expect(objects(decoder.push(Buffer.from("}\n")))).toEqual([{ c: 3 }]);
	});

	it("strips one trailing CR and flushes a final record without LF at end", () => {
		const decoder = new JsonlDecoderV0();
		expect(objects(decoder.push(Buffer.from('{"a":1}\r\n{"b":2}')))).toEqual([{ a: 1 }]);
		expect(objects(decoder.end())).toEqual([{ b: 2 }]);
	});

	it("does not split on U+2028 or U+2029", () => {
		const decoder = new JsonlDecoderV0();
		expect(objects(decoder.push(Buffer.from('{"text":"a b c"}\n')))).toEqual([{ text: "a b c" }]);
	});

	it("reports malformed and non-object records by length only", () => {
		const decoder = new JsonlDecoderV0();
		const records = decoder.push(Buffer.from(`{"x":"${SENTINELS.prompt}"\n[1]\n"s"\n\n{"ok":true}\n`));
		expect(records).toEqual([
			{ kind: "invalid", error: "Malformed JSON", length: 22 },
			{ kind: "invalid", error: "Record is not a JSON object", length: 3 },
			{ kind: "invalid", error: "Record is not a JSON object", length: 3 },
			{ kind: "object", value: { ok: true } },
		]);
		expect(leaks(records)).toEqual([]);
	});

	it("invalidates a record with malformed UTF-8 instead of substituting U+FFFD", () => {
		const decoder = new JsonlDecoderV0();
		const bad = Buffer.concat([
			Buffer.from('{"id":"call_'),
			Buffer.from([0xc3, 0x28]),
			Buffer.from('"}\n{"ok":true}\n'),
		]);
		expect(decoder.push(bad)).toEqual([
			{ kind: "invalid", error: "Malformed UTF-8", length: 16 },
			{ kind: "object", value: { ok: true } },
		]);
	});

	it("encodes one command as exactly one line", () => {
		const line = encodeJsonlRecordV0({ type: "prompt", message: "a\nb\r " });
		expect(line.indexOf("\n")).toBe(line.length - 1);
	});

	it("classifies responses, events and invalid records", () => {
		expect(classifyPrimeRecordV0({ type: "response", id: "p-1", command: "abort", success: true }).kind).toBe(
			"response",
		);
		expect(classifyPrimeRecordV0({ type: "response", command: "abort" }).kind).toBe("invalid");
		expect(classifyPrimeRecordV0({ type: "response", id: 1, command: "abort", success: true }).kind).toBe("invalid");
		expect(classifyPrimeRecordV0({ type: "brand_new_event" })).toMatchObject({
			kind: "event",
			type: "brand_new_event",
		});
		expect(classifyPrimeRecordV0({ kind: "no type" }).kind).toBe("invalid");
		expect(classifyPrimeRecordV0({ type: "" }).kind).toBe("invalid");
	});
});

describe("PrimeRpcClientV0", () => {
	const client = (mode: string, events: string[] = []) =>
		new PrimeRpcClientV0({
			command: process.execPath,
			args: [fakeServer, mode],
			env: { PATH: process.env.PATH },
			cwd: process.cwd(),
			onEvent: (type) => events.push(type),
		});

	it("correlates responses by id and forwards unknown events", async () => {
		const events: string[] = [];
		const rpc = client("echo", events);
		const response = await rpc.request({ type: "get_state" });
		expect(response).toMatchObject({ id: "probe-1", command: "get_state", success: true });
		expect(events).toEqual(["future_event_kind"]);
		expect(await rpc.close()).toEqual({ code: 0, signal: null });
		expect(rpc.protocolErrors).toEqual([]);
	});

	it("resolves out-of-order responses to their own requests", async () => {
		const rpc = client("reverse");
		const [first, second] = await Promise.all([rpc.request({ type: "get_state" }), rpc.request({ type: "abort" })]);
		expect([first.command, second.command]).toEqual(["get_state", "abort"]);
		await rpc.close();
	});

	it("records duplicate and unknown response ids as protocol errors", async () => {
		const duplicate = client("duplicate");
		await duplicate.request({ type: "get_state" });
		await duplicate.request({ type: "abort" });
		await duplicate.close();
		expect(duplicate.protocolErrors).toEqual(["Duplicate response for probe-1", "Duplicate response for probe-2"]);

		const unknown = client("unknown-id");
		await unknown.request({ type: "get_state" });
		await unknown.close();
		expect(unknown.protocolErrors).toEqual(["Response for unknown id not-a-probe-id"]);
	});

	it("records malformed and non-object records without failing the request", async () => {
		const rpc = client("malformed");
		expect((await rpc.request({ type: "get_state" })).success).toBe(true);
		await rpc.close();
		expect(rpc.protocolErrors).toEqual([
			"Malformed JSON (19 characters)",
			"Record is not a JSON object (5 characters)",
		]);
	});

	it("reassembles a response split across writes inside a multi-byte character", async () => {
		const rpc = client("split");
		const response = await rpc.request({ type: "get_state" });
		expect(response.data).toEqual({ text: "é " });
		await rpc.close();
	});

	it("rejects a response that echoes a different command", async () => {
		const rpc = client("wrong-command");
		await expect(rpc.request({ type: "get_session_stats" })).rejects.toThrow("echoes get_messages");
		await rpc.close();
		expect(rpc.protocolErrors).toEqual(["Response for probe-1 echoes get_messages, expected get_session_stats"]);
	});

	it("counts records written just before exit once close completes", async () => {
		const rpc = client("trailing-exit");
		await rpc.request({ type: "get_state" });
		await rpc.close();
		expect(rpc.protocolErrors).toEqual(["Malformed JSON (9 characters)"]);
	});

	it("rejects a pending request at once when the process cannot be spawned", async () => {
		const rpc = new PrimeRpcClientV0({
			command: "/nonexistent/prime-agent",
			args: [],
			env: { PATH: process.env.PATH },
			cwd: process.cwd(),
		});
		const started = Date.now();
		await expect(rpc.request({ type: "get_state" }, 30_000)).rejects.toBeInstanceOf(PrimeRpcExitError);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await rpc.exited).toEqual({ code: null, signal: null });
	});

	it("rejects a pending request when the process exits", async () => {
		const rpc = client("exit");
		await expect(rpc.request({ type: "prompt", message: "x" })).rejects.toBeInstanceOf(PrimeRpcExitError);
		await expect(rpc.request({ type: "get_state" })).rejects.toBeInstanceOf(PrimeRpcExitError);
		expect((await rpc.exited).code).toBe(3);
	});

	it("still waits for stdout to drain when close() is called after the process already exited", async () => {
		const rpc = client("trailing-exit");
		await rpc.request({ type: "get_state" });
		// The process has exited before close(); the malformed record written just before exit must still be counted.
		await rpc.exitObserved;
		await rpc.close();
		expect(rpc.protocolErrors).toEqual(["Malformed JSON (9 characters)"]);
	});
});

describe("strict Prime decoders", () => {
	const events: Record<string, Record<string, unknown>> = {
		message_end: { message: assistant },
		turn_end: { message: assistant, toolResults: [toolResult] },
		agent_end: { messages: [{ role: "user", content: SENTINELS.prompt }, assistant, toolResult] },
		tool_execution_end: { toolCallId: "call_1", toolName: "probe_tool", isError: true, result: SENTINELS.toolResult },
		tool_execution_start: { toolCallId: "call_1", toolName: "probe_tool", args: { note: SENTINELS.toolArgs } },
		compaction_end: { reason: "manual", result: { summary: SENTINELS.summary }, aborted: false, willRetry: false },
		compaction_start: { reason: "manual" },
		auto_retry_end: { success: false, attempt: 1, finalError: SENTINELS.errorDetail },
	};

	it("reduces valid events to identities, kinds, flags and numbers only", () => {
		const decoded = Object.entries(events).map(([type, event]) => decodePrimeEventV0(type, event));
		expect(leaks(decoded)).toEqual([]);
		expect(decodePrimeEventV0("turn_end", events.turn_end!)).toEqual({
			type: "turn_end",
			assistant: {
				stopReason: "toolUse",
				provider: "probe-local",
				model: "probe-model",
				usage: { ...usage, extraKeys: [] },
				toolCalls: [{ id: "call_1", name: "probe_tool" }],
				hasErrorMessage: true,
			},
			toolResults: [{ toolCallId: "call_1", toolName: "probe_tool", isError: true }],
		});
		expect(decodePrimeEventV0("compaction_end", events.compaction_end!)).toMatchObject({ succeeded: true });
	});

	it.each([
		["message_end", ["message"], undefined, "missing message"],
		["message_end", ["message", "role"], undefined, "missing role"],
		["message_end", ["message", "usage"], undefined, "missing whole usage object"],
		["message_end", ["message", "usage", "output"], undefined, "missing usage field"],
		["message_end", ["message", "usage", "output"], Number.NaN, "NaN usage field"],
		["message_end", ["message", "usage", "cost", "total"], Number.POSITIVE_INFINITY, "infinite cost"],
		["message_end", ["message", "usage", "input"], "1", "string usage field"],
		["message_end", ["message", "stopReason"], undefined, "missing stop reason"],
		["message_end", ["message", "content", 2, "id"], undefined, "tool call without id"],
		["message_end", ["message", "content", 2, "name"], "", "tool call with empty name"],
		["message_end", ["message", "content"], undefined, "missing content"],
		["turn_end", ["message"], undefined, "turn without assistant"],
		["turn_end", ["toolResults"], undefined, "turn without tool results"],
		["turn_end", ["toolResults", 0, "isError"], undefined, "tool result without isError"],
		["turn_end", ["toolResults", 0, "isError"], "true", "tool result with non-boolean isError"],
		["turn_end", ["toolResults", 0, "toolCallId"], undefined, "tool result without id"],
		["agent_end", ["messages"], undefined, "agent_end without messages"],
		["agent_end", ["messages", 1, "stopReason"], undefined, "assistant without stop reason"],
		["tool_execution_end", ["isError"], undefined, "missing isError"],
		["tool_execution_end", ["isError"], 0, "numeric isError"],
		["tool_execution_end", ["toolCallId"], undefined, "missing tool id"],
		["tool_execution_end", ["toolName"], "", "empty tool name"],
		["tool_execution_start", ["toolName"], undefined, "missing tool name at start"],
		["compaction_end", ["aborted"], undefined, "compaction_end without aborted"],
		["compaction_end", ["result"], "done", "non-object compaction result"],
		["compaction_start", ["reason"], undefined, "compaction_start without reason"],
		["auto_retry_end", ["success"], undefined, "auto_retry_end without success"],
	] as const)("rejects %s with %s = %s (%s)", (type, path, value, _case) => {
		expectDecodeError(() => decodePrimeEventV0(type, mutate(events[type]!, path, value)));
	});

	it("keeps unknown event types by name and never keeps streaming deltas", () => {
		expect(decodePrimeEventV0("brand_new_event", { payload: SENTINELS.prompt })).toEqual({
			type: "unknown",
			primeType: "brand_new_event",
		});
		expect(decodePrimeEventV0("message_update", { delta: SENTINELS.assistant })).toBeUndefined();
	});

	it("names field paths, never values, in decode errors", () => {
		const broken = mutate(events.message_end!, ["message", "usage", "output"], SENTINELS.prompt);
		expect(() => decodePrimeEventV0("message_end", broken)).toThrow(
			"message_end.message.usage.output is not a finite number",
		);
		try {
			decodePrimeEventV0("message_end", broken);
		} catch (error) {
			expect(leaks((error as Error).message)).toEqual([]);
		}
	});

	it("decodes usage strictly, keeping unknown usage keys by name", () => {
		expect(decodePrimeUsageV0({ ...usage, reasoning: 5 }, "u").extraKeys).toEqual(["reasoning"]);
		expectDecodeError(() => decodePrimeUsageV0(undefined, "u"));
		expectDecodeError(() => decodePrimeUsageV0(mutate(usage, ["cost"], undefined), "u"));
	});
});

describe("strict session-file decoding", () => {
	const header = { type: "session", version: 3, id: "session-1", timestamp: "t", cwd: "/tmp" };
	const lines: Record<string, Record<string, unknown>> = {
		user: {
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "t",
			message: { role: "user", content: SENTINELS.prompt },
		},
		assistant: { type: "message", id: "a2", parentId: "a1", timestamp: "t", message: assistant },
		compaction: {
			type: "compaction",
			id: "c1",
			parentId: "a2",
			timestamp: "t",
			summary: SENTINELS.summary,
			firstKeptEntryId: "a2",
			tokensBefore: 10,
			usage,
		},
		child: {
			type: "child_usage_attributed",
			id: "u1",
			parentId: "a2",
			timestamp: "t",
			targetId: "a2",
			childUsage: usage,
			aggregateUsage: usage,
		},
	};

	it("decodes a file to payload-minimal entries", () => {
		const entries = decodePrimeSessionFileV0(
			`${[header, ...Object.values(lines)].map((line) => JSON.stringify(line)).join("\n")}\n`,
		);
		expect(entries.map((entry) => entry.type)).toEqual([
			"session",
			"message",
			"message",
			"compaction",
			"child_usage_attributed",
		]);
		expect(leaks(entries)).toEqual([]);
	});

	it.each([
		["assistant", ["message", "usage"], undefined, "assistant entry without usage"],
		["assistant", ["message", "usage", "cacheRead"], Number.NaN, "assistant entry with NaN usage"],
		["assistant", ["id"], undefined, "entry without id"],
		["assistant", ["parentId"], undefined, "entry without parentId"],
		["assistant", ["parentId"], 7, "entry with numeric parentId"],
		["assistant", ["type"], undefined, "entry without type"],
		["user", ["message"], undefined, "message entry without message"],
		["compaction", ["firstKeptEntryId"], undefined, "compaction without firstKeptEntryId"],
		["compaction", ["usage", "input"], undefined, "compaction with malformed usage"],
		["child", ["childUsage"], undefined, "child attribution without childUsage"],
		["child", ["aggregateUsage", "cost"], undefined, "child attribution with malformed aggregateUsage"],
		["child", ["targetId"], undefined, "child attribution without targetId"],
	] as const)("rejects %s with %s = %s (%s)", (name, path, value, _case) => {
		expectDecodeError(() => decodePrimeSessionLineV0(JSON.stringify(mutate(lines[name]!, path, value)), 2));
	});

	it("rejects blank lines, a missing final newline, repeated ids, empty parents and unknown accounting", () => {
		const file = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");
		expect(decodePrimeSessionFileV0(`${file(header, lines.user)}\n`)).toHaveLength(2);
		expectDecodeError(() => decodePrimeSessionFileV0(`${file(header, lines.user)}`));
		expectDecodeError(() => decodePrimeSessionFileV0(`${file(header, lines.user)}\n\n`));
		expectDecodeError(() => decodePrimeSessionFileV0(`${JSON.stringify(header)}\n\n${JSON.stringify(lines.user)}\n`));
		expectDecodeError(() => decodePrimeSessionFileV0(`${file(header, lines.user, lines.user)}\n`));
		expectDecodeError(() => decodePrimeSessionLineV0(JSON.stringify(mutate(lines.assistant!, ["parentId"], "")), 2));
		const accounting = { type: "future_entry", id: "f1", parentId: "a2", timestamp: "t", usage };
		expect(() => decodePrimeSessionLineV0(JSON.stringify(accounting), 3)).toThrow(
			"unknown entry type carrying accounting",
		);
	});

	it("rejects malformed and non-object lines without quoting them", () => {
		for (const raw of [`{"type":"message","note":"${SENTINELS.prompt}"`, "[1,2]", "null", '"text"']) {
			try {
				decodePrimeSessionLineV0(raw, 4);
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(PrimeDecodeError);
				expect(leaks((error as Error).message)).toEqual([]);
				expect((error as Error).message).toContain("session line 4");
			}
		}
	});

	it("keeps a structurally valid entry of an unknown type, and allows an optional compaction usage to be absent", () => {
		const unknown = { type: "future_entry", id: "f1", parentId: "a2", timestamp: "t", payload: SENTINELS.prompt };
		expect(decodePrimeSessionLineV0(JSON.stringify(unknown), 3)).toEqual({
			type: "future_entry",
			id: "f1",
			parentId: "a2",
			keys: ["id", "parentId", "payload", "timestamp", "type"],
		});
		const withoutUsage = mutate(lines.compaction!, ["usage"], undefined);
		expect(decodePrimeSessionLineV0(JSON.stringify(withoutUsage), 3).usage).toBeUndefined();
	});
});

describe("strict command-response decoding", () => {
	const stats = {
		sessionFile: "/tmp/s.jsonl",
		sessionId: "s",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 2,
		tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		cost: 3,
		contextUsage: { tokens: null, contextWindow: 10, percent: null },
	};

	it("decodes stats, keeping a null context estimate as null", () => {
		expect(decodePrimeStatsV0("after", response("get_session_stats", stats))).toMatchObject({
			label: "after",
			totalMessages: 2,
			contextUsageTokens: null,
		});
		expect(
			decodePrimeStatsV0("x", response("get_session_stats", mutate(stats, ["contextUsage"], undefined)))
				.contextUsageTokens,
		).toBeUndefined();
	});

	it.each([
		[["cost"], undefined],
		[["cost"], "3"],
		[["tokens", "total"], undefined],
		[["tokens"], undefined],
		[["totalMessages"], Number.NaN],
		[["contextUsage", "tokens"], "many"],
	] as const)("rejects stats with %s = %s", (path, value) => {
		expectDecodeError(() => decodePrimeStatsV0("x", response("get_session_stats", mutate(stats, path, value))));
	});

	it("rejects a successful response without data", () => {
		expectDecodeError(() => decodePrimeStatsV0("x", response("get_session_stats", undefined)));
		expectDecodeError(() => decodePrimeStateV0(response("get_state", undefined)));
	});

	it("requires the session file, the messages array and at least one named fork target", () => {
		expect(decodePrimeStateV0(response("get_state", { sessionFile: "/s.jsonl", isStreaming: false }))).toEqual({
			sessionFile: "/s.jsonl",
			keys: ["isStreaming", "sessionFile"],
		});
		expectDecodeError(() => decodePrimeStateV0(response("get_state", { isStreaming: false })));
		expect(decodePrimeMessageCountV0(response("get_messages", { messages: [{}, {}] }))).toBe(2);
		expectDecodeError(() => decodePrimeMessageCountV0(response("get_messages", {})));
		expectDecodeError(() => decodePrimeMessageCountV0(response("get_messages", { messages: 3 })));
		expect(
			decodePrimeForkTargetsV0(response("get_fork_messages", { messages: [{ entryId: "e1", text: "x" }] })),
		).toEqual(["e1"]);
		expectDecodeError(() => decodePrimeForkTargetsV0(response("get_fork_messages", {})));
		expectDecodeError(() => decodePrimeForkTargetsV0(response("get_fork_messages", { messages: [] })));
		expectDecodeError(() =>
			decodePrimeForkTargetsV0(response("get_fork_messages", { messages: [{ entryId: "e1" }, { text: "no id" }] })),
		);
	});

	it("treats a cancelled fork or session switch as not having happened", () => {
		expect(() => requirePrimeNotCancelledV0(response("fork", { cancelled: false, text: "x" }))).not.toThrow();
		expectDecodeError(() => requirePrimeNotCancelledV0(response("fork", { cancelled: true })));
		expectDecodeError(() => requirePrimeNotCancelledV0(response("switch_session", {})));
		expect(decodePrimeCompactionResultV0(response("compact", { firstKeptEntryId: "a2", tokensBefore: 3 }))).toEqual({
			firstKeptEntryId: "a2",
		});
		expectDecodeError(() => decodePrimeCompactionResultV0(response("compact", { tokensBefore: 3 })));
	});

	it("classifies refusals by category and keeps no error text", () => {
		expect(classifyPrimeRefusalV0("Cannot admit a session action while queued session input is suspended.")).toBe(
			"queued-input-suspended",
		);
		expect(classifyPrimeRefusalV0("Cannot admit a session action while session input admission is paused.")).toBe(
			"input-admission-paused",
		);
		expect(classifyPrimeRefusalV0("Session is closed")).toBe("other");
		expect(classifyPrimeRefusalV0(undefined)).toBe("other");
		const refused = commandEvidenceV0({
			command: "prompt",
			success: false,
			error: `${SENTINELS.errorDetail} closed`,
		});
		expect(refused).toEqual({ command: "prompt", success: false, dataKeys: [], errorKind: "other" });
	});
});

describe("fake provider expectations", () => {
	const user = (content: string) => ({ role: "user", content });

	it("serves only the scenario's scripted requests, and summaries only while allowed", async () => {
		const fake = await startFakeProviderV0({ markers: ["simple"], model: "probe-model" });
		try {
			const post = async (body: string) => {
				const reply = await fetch(`${fake.baseUrl}/chat/completions`, {
					method: "POST",
					body,
					headers: { "content-type": "application/json" },
				});
				await reply.text();
				return reply.status;
			};
			expect(await post(JSON.stringify({ model: "probe-model", messages: [user("SCENARIO:simple x")] }))).toBe(200);
			expect(await post("{not json")).toBe(400);
			expect(await post(JSON.stringify({ model: "probe-model" }))).toBe(400);
			expect(await post(JSON.stringify({ model: "other-model", messages: [user("SCENARIO:simple x")] }))).toBe(400);
			expect(await post(JSON.stringify({ messages: [user("SCENARIO:simple x")] }))).toBe(400);
			expect(
				await post(JSON.stringify({ model: "probe-model", messages: [user("SCENARIO:no-such-scenario x")] })),
			).toBe(400);
			expect(await post(JSON.stringify({ model: "probe-model", messages: [user("SCENARIO:multi-a x")] }))).toBe(400);
			expect(
				await post(
					JSON.stringify({
						model: "probe-model",
						messages: [user("SCENARIO:simple x"), { role: "assistant", content: "done" }],
					}),
				),
			).toBe(400);
			expect(
				await post(JSON.stringify({ model: "probe-model", messages: [user("summarize the conversation")] })),
			).toBe(400);
			fake.allowSummaries(true);
			expect(
				await post(JSON.stringify({ model: "probe-model", messages: [user("summarize the conversation")] })),
			).toBe(200);
			fake.allowSummaries(false);
			expect(fake.requests).toEqual<FakeProviderRequestV0[]>([
				{ kind: "scripted", marker: "simple", reply: 0 },
				{ kind: "malformed" },
				{ kind: "malformed" },
				{ kind: "unexpected", reason: "wrong-model" },
				{ kind: "unexpected", reason: "wrong-model" },
				{ kind: "unexpected", reason: "unknown-marker" },
				{ kind: "unexpected", reason: "marker-not-expected" },
				{ kind: "unexpected", reason: "beyond-script" },
				{ kind: "unexpected", reason: "summary-not-allowed" },
				{ kind: "summary" },
			]);
		} finally {
			await fake.close();
		}
	});
});

describe("executable resolution", () => {
	it("resolves path-like values against the invocation directory and attributes a commit only to a checkout", () => {
		expect(
			resolvePrimeBinaryV0({ PRIME_AGENT_BIN: "/opt/prime/bin/prime-agent", PRIME_AGENT_ROOT: "/src/prime" }),
		).toEqual({
			command: "/opt/prime/bin/prime-agent",
			leadingArgs: [],
			description: "/opt/prime/bin/prime-agent",
		});
		expect(resolvePrimeBinaryV0({ PRIME_AGENT_BIN: "./bin/prime-agent" })?.command).toBe(
			resolve("./bin/prime-agent"),
		);
		expect(resolvePrimeBinaryV0({ PRIME_AGENT_BIN: "prime-agent" })?.command).toBe("prime-agent");
		// Windows forms are paths too, never PATH lookups.
		expect(resolvePrimeBinaryV0({ PRIME_AGENT_BIN: ".\\bin\\prime-agent.exe" })?.command).toBe(
			resolve(".\\bin\\prime-agent.exe"),
		);
		expect(resolvePrimeBinaryV0({ PRIME_AGENT_BIN: "C:\\bin\\prime-agent.exe" })?.command).toBe(
			resolve("C:\\bin\\prime-agent.exe"),
		);
		expect(resolvePrimeBinaryV0({ PRIME_AGENT_ROOT: "../prime-agent" })).toMatchObject({
			command: resolve("../prime-agent", "prime-agent.sh"),
			checkout: resolve("../prime-agent"),
		});
		expect(resolvePrimeBinaryV0({ PRIME_AGENT_ROOT: "/src/prime" })).toMatchObject({
			command: "/src/prime/prime-agent.sh",
			checkout: "/src/prime",
		});
		expect(resolvePrimeBinaryV0({})).toBeUndefined();
	});
});

describe("process exit", () => {
	it("accepts only a clean exit after Prime's input ends", () => {
		expect(abnormalExitV0({ code: 0, signal: null })).toBeUndefined();
		expect(abnormalExitV0({ code: 1, signal: null })).toBe(
			"Prime RPC process exited abnormally (code 1, signal null)",
		);
		expect(abnormalExitV0({ code: null, signal: "SIGKILL" })).toContain("SIGKILL");
		expect(abnormalExitV0({ code: null, signal: null })).toBeDefined();
	});
});

describe("failure text", () => {
	it("keeps only probe-composed messages", () => {
		expect(failureTextV0(new PrimeProbeFailureV0("fork was refused (other)"))).toBe("fork was refused (other)");
		expect(failureTextV0(new PrimeDecodeError("get_state.data.sessionFile is not a non-empty string"))).toContain(
			"sessionFile",
		);
		expect(failureTextV0(new PrimeRpcError("Prime RPC abort timed out after 5 ms"))).toContain("timed out");
		expect(failureTextV0(new SyntaxError(`Unexpected token in ${SENTINELS.prompt}`))).toBe("unexpected SyntaxError");
		expect(failureTextV0("thrown string")).toBe("unexpected non-error exception");
	});
});

describe("isolation", () => {
	it("is not exported from @endophasia/core", () => {
		const index = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
		expect(index).not.toMatch(/research|prime/i);
	});
});
