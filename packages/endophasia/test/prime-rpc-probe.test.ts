// Offline tests for the research-only Prime RPC conformance probe (Prime Runtime Conformance v0): framing, request
// correlation, termination and sanitization. No Prime installation is needed; a local fake RPC server stands in.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeCommandV0, sanitizeSessionEntryV0 } from "../research/prime-conformance/evidence.ts";
import { SENTINEL_PATTERN, SENTINELS } from "../research/prime-conformance/fake-provider.ts";
import { encodeJsonlRecordV0, JsonlDecoderV0, type JsonlRecordV0 } from "../research/prime-conformance/jsonl.ts";
import { classifyPrimeRecordV0, sanitizePrimeEventV0 } from "../research/prime-conformance/protocol.ts";
import { PrimeRpcClientV0, PrimeRpcExitError } from "../research/prime-conformance/rpc-client.ts";

const fakeServer = fileURLToPath(new URL("./fixtures/prime/fake-rpc-server.mjs", import.meta.url));

function objects(records: JsonlRecordV0[]): Record<string, unknown>[] {
	return records.flatMap((record) => (record.kind === "object" ? [record.value] : []));
}

/** Probe sentinels in a serialized value. */
function leaks(value: unknown): string[] {
	return JSON.stringify(value).match(new RegExp(SENTINEL_PATTERN, "g")) ?? [];
}

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

	it("rejects a pending request when the process exits", async () => {
		const rpc = client("exit");
		await expect(rpc.request({ type: "prompt", message: "x" })).rejects.toBeInstanceOf(PrimeRpcExitError);
		await expect(rpc.request({ type: "get_state" })).rejects.toBeInstanceOf(PrimeRpcExitError);
		expect((await rpc.exited).code).toBe(3);
	});
});

describe("sanitization", () => {
	const assistant = {
		role: "assistant",
		content: [
			{ type: "text", text: SENTINELS.assistant },
			{ type: "thinking", thinking: SENTINELS.reasoning },
			{ type: "toolCall", id: "call_1", name: "probe_tool", arguments: { note: SENTINELS.toolArgs } },
		],
		stopReason: "toolUse",
		errorMessage: SENTINELS.errorDetail,
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, reasoning: 1, cost: { total: 1 } },
	};

	it("keeps identities, kinds, flags and numbers only", () => {
		const events = [
			sanitizePrimeEventV0("message_end", { message: assistant }),
			sanitizePrimeEventV0("turn_end", {
				message: assistant,
				toolResults: [
					{ toolCallId: "call_1", toolName: "probe_tool", isError: true, content: SENTINELS.toolResult },
				],
			}),
			sanitizePrimeEventV0("agent_end", { messages: [{ role: "user", content: SENTINELS.prompt }, assistant] }),
			sanitizePrimeEventV0("tool_execution_end", {
				toolCallId: "call_1",
				toolName: "probe_tool",
				isError: true,
				result: SENTINELS.toolResult,
			}),
		];
		expect(leaks(events)).toEqual([]);
		expect(events[0]).toMatchObject({
			assistant: { toolCalls: [{ id: "call_1", name: "probe_tool" }], hasErrorMessage: true },
		});
		expect(events[0]).toMatchObject({ assistant: { usage: { extraKeys: ["reasoning"] } } });
	});

	it("drops streaming deltas and keeps unknown events by name only", () => {
		expect(sanitizePrimeEventV0("message_update", { delta: SENTINELS.assistant })).toBeUndefined();
		expect(sanitizePrimeEventV0("brand_new_event", { payload: SENTINELS.prompt })).toEqual({
			type: "unknown",
			primeType: "brand_new_event",
		});
	});

	it("reduces command errors and session entries to labels and field names", () => {
		const refused = sanitizeCommandV0({
			command: "prompt",
			success: false,
			error: "Cannot admit a session action while queued session input is suspended.",
		});
		expect(refused).toEqual({ command: "prompt", success: false, dataKeys: [], errorKind: "queued-input-suspended" });
		expect(sanitizeCommandV0({ command: "prompt", success: false, error: SENTINELS.errorDetail })).toEqual({
			command: "prompt",
			success: false,
			dataKeys: [],
			errorKind: "other",
		});
		const entry = sanitizeSessionEntryV0({
			type: "compaction",
			id: "c0ffee00",
			parentId: "c0ffee01",
			summary: SENTINELS.summary,
			usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { total: 7 } },
		});
		expect(entry).toMatchObject({
			type: "compaction",
			usage: { input: 5 },
			keys: ["id", "parentId", "summary", "type", "usage"],
		});
		expect(leaks(entry)).toEqual([]);
	});
});

describe("isolation", () => {
	it("is not exported from @endophasia/core", () => {
		const index = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
		expect(index).not.toMatch(/research|prime/i);
	});
});
