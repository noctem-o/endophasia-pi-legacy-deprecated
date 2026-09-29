// Offline tests for Prime RPC Runtime Ingress v0 (runtime/prime): strict JSONL framing (held to the research probe's
// decoder by differential tests), request correlation, ordered events, listener isolation, bounded lifecycle, runtime
// identity, hermetic environments and import-graph boundaries. A local fake stands in for `prime-agent --mode rpc`;
// no Prime installation, provider key, ~/.prime state or network is used. The live smoke at the end is opt-in only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { JsonlDecoderV0, type JsonlRecordV0 } from "../research/prime-conformance/jsonl.ts";
import { hashBuildOutputV0 } from "../research/prime-conformance/probe.ts";
import { PrimeJsonlDecoderV0, type PrimeJsonlRecordV0 } from "../runtime/prime/jsonl.ts";
import { PrimeProcessGroupV0 } from "../runtime/prime/process-group.ts";
import {
	type PrimeRpcConnectionOptionsV0,
	PrimeRpcConnectionV0,
	type PrimeRpcDiagnosticV0,
	PrimeRpcErrorV0,
	type PrimeRpcEventV0,
	PrimeRpcExitErrorV0,
} from "../runtime/prime/rpc-connection.ts";
import {
	type PrimeInstallationV0,
	readPrimeRuntimeIdentityV0,
	resolvePrimeInstallationV0,
} from "../runtime/prime/runtime-identity.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/prime-ingress/fake-prime-rpc.mjs", import.meta.url));
const SENTINEL = /PROMPT_SENTINEL|ASSISTANT_SENTINEL|TOOL_ARGS_SENTINEL/;
const POSIX = process.platform !== "win32";
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

function decodeAll(chunks: readonly Uint8Array[]): PrimeJsonlRecordV0[] {
	const decoder = new PrimeJsonlDecoderV0();
	return [...chunks.flatMap((chunk) => decoder.push(chunk)), ...decoder.end()];
}

const opened: PrimeRpcConnectionV0[] = [];
const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(opened.splice(0).map((connection) => connection.close()));
});
afterAll(() => {
	for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporary.push(directory);
	return directory;
}

/** A connection to the fake in one mode, with an exact minimal environment and every diagnostic collected. */
function connect(mode: string, options: Partial<PrimeRpcConnectionOptionsV0> = {}) {
	const diagnostics: PrimeRpcDiagnosticV0[] = [];
	const events: PrimeRpcEventV0[] = [];
	const connection = new PrimeRpcConnectionV0({
		installation: { mode: "binary", command: process.execPath, leadingArgs: [FAKE] },
		args: [mode],
		env: { PATH: process.env.PATH ?? "" },
		cwd: tmpdir(),
		requestTimeoutMs: 10_000,
		onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		...options,
	});
	connection.subscribe((event) => events.push(event));
	opened.push(connection);
	return { connection, diagnostics, events };
}

/** Whether a process (or any member of a group) is running: zombies, which kill(pid, 0) still sees, do not count. */
function running(target: { readonly pid: number } | { readonly group: number }): boolean {
	try {
		process.kill("pid" in target ? target.pid : -target.group, 0);
	} catch {
		return false;
	}
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return true;
	}
	return entries.some((entry) => {
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const member = "pid" in target ? Number(entry) === target.pid : Number(group) === target.group;
			return member && state !== "Z" && state !== "X";
		} catch {
			return false;
		}
	});
}

/** Wait up to 5 s for a process or group to stop running. */
async function gone(target: { readonly pid: number } | { readonly group: number }): Promise<boolean> {
	const deadline = Date.now() + 5_000;
	while (running(target)) {
		if (Date.now() > deadline) return false;
		await new Promise((done) => setTimeout(done, 25));
	}
	return true;
}

const faults = (diagnostics: readonly PrimeRpcDiagnosticV0[]) =>
	diagnostics.flatMap((diagnostic) => (diagnostic.kind === "protocol-fault" ? [diagnostic.fault] : []));

describe("Prime JSONL framing", () => {
	it("decodes one record, several records in one chunk, and a partial final record at end of stream", () => {
		expect(decodeAll([bytes('{"type":"a"}\n')])).toEqual([{ kind: "object", value: { type: "a" } }]);
		expect(decodeAll([bytes('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n')]).map((r) => r.kind)).toEqual([
			"object",
			"object",
			"object",
		]);
		const decoder = new PrimeJsonlDecoderV0();
		expect(decoder.push(bytes('{"type":"a"}\n{"type":'))).toHaveLength(1);
		expect(decoder.push(bytes('"b"}'))).toEqual([]);
		expect(decoder.end()).toEqual([{ kind: "object", value: { type: "b" } }]);
		expect(decoder.end()).toEqual([]);
	});

	it("reassembles UTF-8 split at every byte and keeps U+2028 and U+2029 inside a record", () => {
		const record = bytes('{"type":"x","text":"é🙂 mid end"}\n');
		for (let cut = 0; cut <= record.length; cut++) {
			expect(decodeAll([record.subarray(0, cut), record.subarray(cut)])).toEqual([
				{ kind: "object", value: { type: "x", text: "é🙂 mid end" } },
			]);
		}
		expect(decodeAll([...record].map((byte) => Uint8Array.of(byte)))).toHaveLength(1);
	});

	it("strips one CR before LF and never splits on a lone CR", () => {
		expect(decodeAll([bytes('{"type":"a"}\r\n')])).toEqual([{ kind: "object", value: { type: "a" } }]);
		expect(decodeAll([bytes("\r\n")])).toEqual([{ kind: "fault", fault: "empty-record", byteLength: 0 }]);
		// A lone CR is not a record separator: two objects joined by CR are one malformed record.
		expect(decodeAll([bytes('{"type":"a"}\r{"type":"b"}\n')])).toEqual([
			{ kind: "fault", fault: "malformed-json", byteLength: 25 },
		]);
	});

	it("treats blank lines, malformed JSON, malformed UTF-8 and non-objects as faults, never as records", () => {
		expect(decodeAll([bytes('\n{"type":"a"}\n')]).map((r) => (r.kind === "fault" ? r.fault : r.kind))).toEqual([
			"empty-record",
			"object",
		]);
		expect(decodeAll([bytes('{"type":"a"\n')])).toEqual([{ kind: "fault", fault: "malformed-json", byteLength: 11 }]);
		expect(decodeAll([bytes('{"a":1}{"b":2}\n')])[0]).toMatchObject({ fault: "malformed-json" });
		const invalid = Uint8Array.of(...bytes('{"type":"'), 0xff, ...bytes('"}\n'));
		expect(decodeAll([invalid])).toEqual([{ kind: "fault", fault: "malformed-utf8", byteLength: 12 }]);
		// An overlong encoding and a lone surrogate are malformed too, not replaced with U+FFFD.
		expect(decodeAll([Uint8Array.of(...bytes('{"t":"'), 0xc0, 0xaf, ...bytes('"}\n'))])[0]).toMatchObject({
			fault: "malformed-utf8",
		});
		expect(decodeAll([Uint8Array.of(...bytes('{"t":"'), 0xed, 0xa0, 0x80, ...bytes('"}\n'))])[0]).toMatchObject({
			fault: "malformed-utf8",
		});
		for (const value of ["[]", "null", "1", '"text"', "true"]) {
			expect(decodeAll([bytes(`${value}\n`)])[0]).toMatchObject({ kind: "fault", fault: "not-an-object" });
		}
		// A truncated multi-byte code point at end of stream is malformed, not silently dropped.
		expect(decodeAll([Uint8Array.of(...bytes('{"t":"'), 0xf0, 0x9f)])[0]).toMatchObject({ fault: "malformed-utf8" });
	});
});

describe("Prime JSONL framing: large and oversized records", () => {
	it("decodes a record delivered one byte per chunk, and bounds it the same way", () => {
		const text = "x".repeat(256 * 1024);
		const record = bytes(`${JSON.stringify({ type: "big", text })}\n`);
		const decoder = new PrimeJsonlDecoderV0();
		const records: PrimeJsonlRecordV0[] = [];
		const started = Date.now();
		for (let index = 0; index < record.length; index++)
			records.push(...decoder.push(record.subarray(index, index + 1)));
		expect(records).toEqual([{ kind: "object", value: { type: "big", text } }]);
		// Amortized: a quarter of a million one-byte chunks take well under the time a copy per chunk would.
		expect(Date.now() - started).toBeLessThan(5_000);
		const bounded = new PrimeJsonlDecoderV0({ maxRecordBytes: 1024 });
		const faults: PrimeJsonlRecordV0[] = [];
		for (let index = 0; index < record.length; index++)
			faults.push(...bounded.push(record.subarray(index, index + 1)));
		expect(faults).toEqual([{ kind: "fault", fault: "oversized-record", byteLength: record.length - 1 }]);
		// The decoder is reusable after a large record.
		expect(decoder.push(bytes('{"type":"after"}\n'))).toEqual([{ kind: "object", value: { type: "after" } }]);
	});

	it("decodes a large record split over many chunks", () => {
		const text = "é".repeat(512 * 1024);
		const record = bytes(`${JSON.stringify({ type: "big", text })}\n`);
		const chunks: Uint8Array[] = [];
		for (let start = 0; start < record.length; start += 4096) chunks.push(record.subarray(start, start + 4096));
		expect(decodeAll(chunks)).toEqual([{ kind: "object", value: { type: "big", text } }]);
	});

	it("skips a record over the bound up to its LF and keeps decoding", () => {
		const oversized = bytes('{"type":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n{"type":"b"}\n');
		const expected = [
			{ kind: "fault", fault: "oversized-record", byteLength: 35 },
			{ kind: "object", value: { type: "b" } },
		];
		for (const size of [1, 3, 7, oversized.length]) {
			const decoder = new PrimeJsonlDecoderV0({ maxRecordBytes: 16 });
			const records: PrimeJsonlRecordV0[] = [];
			for (let start = 0; start < oversized.length; start += size) {
				records.push(...decoder.push(oversized.subarray(start, start + size)));
			}
			expect([...records, ...decoder.end()]).toEqual(expected);
		}
		const decoder = new PrimeJsonlDecoderV0({ maxRecordBytes: 16 });
		expect(decoder.push(bytes('{"type":"aaaaaaaaaaaaaaaaaaaaaaaa"'))).toEqual([]);
		expect(decoder.end()).toEqual([{ kind: "fault", fault: "oversized-record", byteLength: 34 }]);
	});
});

describe("Prime JSONL framing is no weaker than the research probe's", () => {
	const corpus: readonly Uint8Array[] = [
		bytes('{"type":"a"}\n'),
		bytes('{"type":"b","text":"  "}\r\n'),
		bytes("\n"),
		bytes("\r\n"),
		bytes('{"type":\n'),
		bytes("[1,2]\n"),
		bytes("null\n"),
		bytes('"string"\n'),
		bytes('{"a":1}{"b":2}\n'),
		bytes('{"type":"é🙂"}\n'),
		Uint8Array.of(...bytes('{"x":"'), 0xff, ...bytes('"}\n')),
		Uint8Array.of(...bytes('{"x":"'), 0xed, 0xa0, 0x80, ...bytes('"}\n')),
		bytes('{"type":"c"}\r\r\n'),
		bytes('{"type":"no-final-lf"}'),
	];
	const categories: Record<string, string> = {
		"Empty record": "empty-record",
		"Malformed UTF-8": "malformed-utf8",
		"Malformed JSON": "malformed-json",
		"Record is not a JSON object": "not-an-object",
	};
	const research = (chunks: readonly Uint8Array[]) => {
		const decoder = new JsonlDecoderV0();
		return [...chunks.flatMap((chunk) => decoder.push(chunk)), ...decoder.end()];
	};
	const comparable = (record: JsonlRecordV0) =>
		record.kind === "object" ? record : { kind: "fault", fault: categories[record.error] ?? record.error };
	const production = (record: PrimeJsonlRecordV0) =>
		record.kind === "object" ? record : { kind: "fault", fault: record.fault };

	it("classifies every record of a hostile corpus the same way, whatever the chunking", () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		for (let trial = 0; trial < 200; trial++) {
			const order = corpus.map((_, index) => index).sort(() => random() - 0.5);
			// The record without a final LF is only meaningful last.
			const joined = Uint8Array.from(
				order
					.filter((index) => index !== corpus.length - 1)
					.flatMap((index) => [...corpus[index]])
					.concat(trial % 2 === 0 ? [...corpus[corpus.length - 1]] : []),
			);
			const chunks: Uint8Array[] = [];
			let start = 0;
			while (start < joined.length) {
				const size = 1 + Math.floor(random() * 9);
				chunks.push(joined.subarray(start, start + size));
				start += size;
			}
			const expected = research(chunks).map(comparable);
			expect(decodeAll(chunks).map(production)).toEqual(expected);
			expect(expected.some((record) => record.kind === "fault")).toBe(true);
		}
	});

	it("reports byte lengths where the research decoder does", () => {
		for (const record of [bytes("\n"), Uint8Array.of(...bytes('{"x":"'), 0xff, ...bytes('"}\n'))]) {
			const [expected] = research([record]);
			const [actual] = decodeAll([record]);
			expect(expected.kind === "invalid" && actual.kind === "fault" && actual.byteLength).toBe(
				expected.kind === "invalid" ? expected.length : undefined,
			);
		}
	});
});

describe("Prime RPC connection: correlation", () => {
	it("delivers events before the response, with U+2028 and U+2029 intact", async () => {
		const { connection, events, diagnostics } = connect("echo");
		const response = await connection.request({ type: "get_state" });
		expect(response).toEqual({
			id: "endophasia-1",
			command: "get_state",
			success: true,
			data: { echoed: "get_state" },
		});
		expect(events).toEqual([
			{
				type: "message_update",
				record: { type: "message_update", delta: "ASSISTANT_SENTINEL", note: " line separators" },
			},
		]);
		expect(diagnostics).toEqual([]);
	});

	it("resolves a refusal as success: false, never as an error", async () => {
		const { connection } = connect("refuse");
		const response = await connection.request({ type: "prompt", message: "hi" });
		expect(response.success).toBe(false);
		expect(response.error).toMatch(/^refused /);
	});

	it("correlates responses that arrive out of order", async () => {
		const { connection } = connect("reverse");
		const first = connection.request({ type: "get_state" });
		const second = connection.request({ type: "get_messages" });
		expect(await first).toMatchObject({ id: "endophasia-1", command: "get_state" });
		expect(await second).toMatchObject({ id: "endophasia-2", command: "get_messages" });
	});

	it("settles once: a duplicate response ID is a stale-ID fault", async () => {
		const { connection, diagnostics } = connect("duplicate");
		expect(await connection.request({ type: "get_state" })).toMatchObject({ success: true });
		await connection.request({ type: "get_state" });
		// The second copy of the last response may still be in flight when its request resolves: drain stdout first.
		await connection.close();
		expect(faults(diagnostics)).toEqual(["stale-response-id", "stale-response-id"]);
	});

	it("classifies a response to a timed-out request as stale, and a foreign ID of its form as unknown", async () => {
		const { connection, diagnostics } = connect("reverse");
		await expect(connection.request({ type: "get_state" }, { timeoutMs: 50 })).rejects.toThrow("timed out");
		// The second command makes the fake answer both, in reverse: endophasia-2, then the timed-out endophasia-1.
		expect(await connection.request({ type: "get_messages" })).toMatchObject({ id: "endophasia-2" });
		await connection.close();
		expect(faults(diagnostics)).toEqual(["stale-response-id"]);
	});

	it("rejects a command that cannot be serialized without leaving a pending request behind", async () => {
		const { connection } = connect("echo", { requestTimeoutMs: 50 });
		const circular: Record<string, unknown> = { type: "prompt" };
		circular.self = circular;
		await expect(connection.request(circular as { type: string })).rejects.toThrow(
			"A Prime RPC command could not be serialized",
		);
		await expect(connection.request({ type: "prompt", n: 1n })).rejects.toThrow(
			"A Prime RPC command could not be serialized",
		);
		// Any orphaned timer would have rejected by now and failed the run as an unhandled rejection.
		await new Promise((done) => setTimeout(done, 100));
		// A command that was never sent hands its ID back: the next one reuses it and settles normally.
		expect(await connection.request({ type: "get_state" }, { timeoutMs: 10_000 })).toMatchObject({
			id: "endophasia-1",
			success: true,
		});
	});

	it("classifies a response for an ID that was reserved but never sent as unknown, not stale", async () => {
		const { connection, diagnostics } = connect("forge");
		let inner: Promise<unknown> | undefined;
		// The outer command reserves endophasia-1, a getter sends endophasia-2, then the outer command fails to encode:
		// endophasia-1 cannot be handed back, and was never sent.
		const outer = connection.request({
			type: "get_state",
			get payload() {
				inner ??= connection.request({ type: "get_state" });
				return 1n;
			},
		});
		await expect(outer).rejects.toThrow("A Prime RPC command could not be serialized");
		expect(await inner).toMatchObject({ id: "endophasia-2" });
		await connection.request({ type: "forge", target: "endophasia-1" });
		await connection.request({ type: "forge", target: "endophasia-2" });
		expect(faults(diagnostics)).toEqual(["unknown-response-id", "stale-response-id"]);
	});

	it("gives a request issued from inside another command's getter or toJSON its own ID", async () => {
		const { connection } = connect("echo");
		let fromGetter: Promise<unknown> | undefined;
		let fromToJson: Promise<unknown> | undefined;
		const outer = connection.request({
			type: "get_state",
			get payload() {
				fromGetter ??= connection.request({ type: "get_messages" });
				return {
					toJSON: () => {
						fromToJson ??= connection.request({ type: "get_session_stats" });
						return 1;
					},
				};
			},
		});
		const responses = (await Promise.all([outer, fromGetter, fromToJson])) as { id: string; data: unknown }[];
		expect(responses.map((response) => response.data)).toEqual([
			{ echoed: "get_state" },
			{ echoed: "get_messages" },
			{ echoed: "get_session_stats" },
		]);
		expect(new Set(responses.map((response) => response.id)).size).toBe(3);
	});

	it("reports an unknown response ID and a response without an ID, and delivers neither", async () => {
		const unknown = connect("unknown-id");
		expect(await unknown.connection.request({ type: "get_state" })).toMatchObject({ success: true });
		expect(faults(unknown.diagnostics)).toEqual(["unknown-response-id"]);
		const withoutId = connect("no-id");
		expect(await withoutId.connection.request({ type: "get_state" })).toMatchObject({ success: true });
		expect(faults(withoutId.diagnostics)).toEqual(["response-without-id"]);
	});

	it("rejects a response that echoes another command", async () => {
		const { connection, diagnostics } = connect("wrong-command");
		const error = await connection.request({ type: "get_state" }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PrimeRpcErrorV0);
		expect((error as Error).message).toBe("Prime RPC response endophasia-1 does not echo get_state");
		expect(faults(diagnostics)).toEqual(["command-mismatch"]);
	});

	it("rejects instead of throwing when reading the command itself throws", async () => {
		const { connection } = connect("echo");
		const throwingType = {
			get type(): string {
				throw new Error("PROMPT_SENTINEL");
			},
		};
		const error = await connection.request(throwingType).catch((caught: unknown) => caught);
		expect((error as Error).message).toBe("A Prime RPC command could not be serialized");
		const hostile = new Proxy(
			{ type: "prompt" },
			{
				has() {
					throw new Error("PROMPT_SENTINEL");
				},
			},
		);
		await expect(connection.request(hostile)).rejects.toThrow("A Prime RPC command could not be serialized");
		// `type` is read once and pinned: a getter answering differently later cannot change what is sent.
		let reads = 0;
		const shifting = {
			get type(): string {
				reads++;
				return reads === 1 ? "get_state" : "prompt";
			},
		};
		expect(await connection.request(shifting)).toMatchObject({ command: "get_state", data: { echoed: "get_state" } });
		// `type` is read exactly once, including while the other fields are copied.
		let typeReads = 0;
		const once = {
			get type(): string {
				typeReads++;
				if (typeReads > 1) throw new Error("PROMPT_SENTINEL read twice");
				return "get_state";
			},
			payload: 1,
		};
		expect(await connection.request(once)).toMatchObject({ command: "get_state" });
		expect(typeReads).toBe(1);
		// A root toJSON could replace the checked type and assigned ID in what is written: it is refused unsent.
		const observed: string[] = [];
		connection.observeCommands((command) => observed.push(command.type));
		const hijack = { type: "get_state", toJSON: () => ({ type: "shutdown", id: "foreign" }) };
		await expect(connection.request(hijack)).rejects.toThrow("A Prime RPC command must not define toJSON");
		expect(observed).toEqual([]);
		// A toJSON on a nested value only shapes that value, so it is allowed.
		const nested = { type: "get_state", payload: { toJSON: () => "flat" } };
		expect(await connection.request(nested)).toMatchObject({ command: "get_state" });
	});

	it("treats an error on a successful response as malformed, never delivering its text", async () => {
		const { connection, diagnostics } = connect("success-with-error");
		expect(await connection.request({ type: "get_state" })).toEqual({
			id: "endophasia-1",
			command: "get_state",
			success: true,
		});
		expect(faults(diagnostics)).toEqual(["malformed-response"]);
		expect(JSON.stringify(diagnostics)).not.toMatch(SENTINEL);
	});

	it("bounds the input backlog when Prime stops reading, rejecting new requests unsent", async () => {
		const { connection } = connect("stall", { maxInputBacklogBytes: 256 * 1024, closeTimeoutMs: 200 });
		const payload = "x".repeat(100 * 1024);
		const sent: Promise<unknown>[] = [];
		let refused: Error | undefined;
		for (let attempt = 0; attempt < 50 && refused === undefined; attempt++) {
			// Requests that were written stay pending until close, where they reject; only a refusal is recorded.
			sent.push(
				connection.request({ type: "prompt", message: payload }).catch((error: Error) => {
					if (error.message.includes("backlog")) refused = error;
				}),
			);
			await new Promise((done) => setImmediate(done));
		}
		expect(refused?.message).toBe("Prime RPC input backlog is full; prompt was not sent");
		await connection.close();
		await Promise.all(sent);
	});

	it("counts the input backlog in bytes, not string length", async () => {
		const { connection } = connect("stall", { maxInputBacklogBytes: 512 * 1024, closeTimeoutMs: 200 });
		// 100 Ki characters, 300 KiB of UTF-8: counted by string length, five of these would fit in the backlog.
		const payload = "界".repeat(100 * 1024);
		const sent: Promise<unknown>[] = [];
		let accepted = 0;
		let refused = false;
		for (let attempt = 0; attempt < 20 && !refused; attempt++) {
			sent.push(
				connection.request({ type: "prompt", message: payload }).catch((error: Error) => {
					if (error.message.includes("backlog")) refused = true;
				}),
			);
			await new Promise((done) => setImmediate(done));
			if (!refused) accepted++;
		}
		expect(refused).toBe(true);
		// A 300 KiB record fits a 512 KiB backlog once; a second would exceed it. Counted by string length (100 Ki per
		// record), three would have been accepted.
		expect(accepted).toBeLessThanOrEqual(2);
		await connection.close();
		await Promise.all(sent);
	});

	it("never settles a request with a malformed response", async () => {
		const { connection, diagnostics } = connect("malformed-response");
		expect(await connection.request({ type: "get_state" })).toEqual({
			id: "endophasia-1",
			command: "get_state",
			success: true,
		});
		expect(faults(diagnostics)).toEqual(["malformed-response", "malformed-response"]);
	});

	it("reports hostile records as categorized faults without content and keeps going", async () => {
		const { connection, diagnostics, events } = connect("hostile-records");
		expect(await connection.request({ type: "get_state" })).toMatchObject({ success: true });
		expect(faults(diagnostics)).toEqual([
			"empty-record",
			"malformed-json",
			"not-an-object",
			"malformed-utf8",
			"missing-type",
		]);
		expect(events).toEqual([]);
		expect(JSON.stringify(diagnostics)).not.toMatch(SENTINEL);
	});

	it("reassembles records split across chunks, several per chunk, with CRLF", async () => {
		const { connection, events, diagnostics } = connect("split");
		expect(await connection.request({ type: "get_state" })).toMatchObject({ data: { text: "é🙂" } });
		expect(events.map((event) => event.type)).toEqual(["turn_start", "turn_end"]);
		expect(events[1].record.t).toBe("  ");
		expect(diagnostics).toEqual([]);
	});

	it("keeps events without IDs in order around an interleaved response", async () => {
		const { connection, events } = connect("interleave");
		await connection.request({ type: "prompt", message: "hi" });
		await connection.close();
		expect(events.map((event) => event.type)).toEqual(["agent_start", "message_end", "agent_end"]);
	});

	it("rejects commands that carry an ID or no type, and times out an unanswered request", async () => {
		const { connection } = connect("reverse");
		await expect(connection.request({ type: "get_state", id: "mine" })).rejects.toThrow(
			"Prime RPC request IDs are assigned by the connection",
		);
		await expect(connection.request({ type: "" })).rejects.toThrow("A Prime RPC command needs a type");
		await expect(connection.request({ type: "get_state" }, { timeoutMs: 100 })).rejects.toThrow(
			"Prime RPC get_state (endophasia-1) timed out after 100 ms",
		);
	});
});

describe("Prime RPC connection: listeners", () => {
	it("isolates a throwing event listener and reports only its error name", async () => {
		const { connection, diagnostics, events } = connect("interleave");
		connection.subscribe(() => {
			throw new TypeError("ASSISTANT_SENTINEL leaked");
		});
		const after: string[] = [];
		connection.subscribe((event) => after.push(event.type));
		connection.subscribe(() => {
			throw "PROMPT_SENTINEL";
		});
		await connection.request({ type: "prompt" });
		await connection.close();
		expect(events.map((event) => event.type)).toEqual(["agent_start", "message_end", "agent_end"]);
		expect(after).toEqual(["agent_start", "message_end", "agent_end"]);
		expect(diagnostics.filter((diagnostic) => diagnostic.kind === "listener-failure")).toEqual([
			{ kind: "listener-failure", listener: "event", errorName: "TypeError" },
			{ kind: "listener-failure", listener: "event", errorName: "non-error" },
			{ kind: "listener-failure", listener: "event", errorName: "TypeError" },
			{ kind: "listener-failure", listener: "event", errorName: "non-error" },
			{ kind: "listener-failure", listener: "event", errorName: "TypeError" },
			{ kind: "listener-failure", listener: "event", errorName: "non-error" },
		]);
		expect(JSON.stringify(diagnostics)).not.toMatch(SENTINEL);
	});

	it("reports only a standard error name, never a name a listener set", async () => {
		const { connection, diagnostics } = connect("echo");
		connection.subscribe((event) => {
			const error = new Error("failed");
			error.name = String(event.record.delta);
			throw error;
		});
		connection.subscribe(() => {
			const error = new Error("failed");
			Object.defineProperty(error, "name", {
				get() {
					throw new Error("ASSISTANT_SENTINEL");
				},
			});
			throw error;
		});
		connection.subscribe(() => {
			throw new Proxy(new Error("failed"), {
				getPrototypeOf() {
					throw new Error("ASSISTANT_SENTINEL");
				},
			});
		});
		const after: string[] = [];
		connection.subscribe((event) => after.push(event.type));
		await connection.request({ type: "get_state" });
		expect(diagnostics).toEqual([
			{ kind: "listener-failure", listener: "event", errorName: "other-error" },
			{ kind: "listener-failure", listener: "event", errorName: "other-error" },
			{ kind: "listener-failure", listener: "event", errorName: "other-error" },
		]);
		expect(after).toEqual(["message_update"]);
		expect(JSON.stringify(diagnostics)).not.toMatch(SENTINEL);
	});

	it("reports a rejecting async listener or observer instead of leaving an unhandled rejection", async () => {
		const { connection, diagnostics } = connect("echo");
		connection.subscribe(async () => {
			throw new TypeError("ASSISTANT_SENTINEL");
		});
		connection.observeCommands(async () => {
			throw new RangeError("PROMPT_SENTINEL");
		});
		await connection.request({ type: "get_state" });
		await new Promise((done) => setTimeout(done, 20));
		expect(diagnostics).toContainEqual({ kind: "listener-failure", listener: "event", errorName: "TypeError" });
		expect(diagnostics).toContainEqual({ kind: "listener-failure", listener: "command", errorName: "RangeError" });
		expect(JSON.stringify(diagnostics)).not.toMatch(SENTINEL);
	});

	it("absorbs a rejecting async diagnostic sink", async () => {
		const { connection } = connect("hostile-records", {
			onDiagnostic: async () => {
				throw new Error("sink failed");
			},
		});
		expect(await connection.request({ type: "get_state" })).toMatchObject({ success: true });
		// Any unhandled rejection from the sink would fail the run.
		await new Promise((done) => setTimeout(done, 20));
	});

	it("survives a throwing diagnostic sink", async () => {
		const { connection } = connect("hostile-records", {
			onDiagnostic: () => {
				throw new Error("sink failed");
			},
		});
		expect(await connection.request({ type: "get_state" })).toMatchObject({ success: true });
	});

	it("observes each command synchronously as it is written, before its events and response", async () => {
		const { connection } = connect("interleave");
		const log: string[] = [];
		connection.observeCommands((command) => log.push(`command ${command.type} ${command.id}`));
		connection.observeCommands(() => {
			throw new RangeError("observer failed");
		});
		connection.subscribe((event) => log.push(`event ${event.type}`));
		const response = connection.request({ type: "abort" });
		expect(log).toEqual(["command abort endophasia-1"]);
		await response;
		expect(log.slice(0, 3)).toEqual(["command abort endophasia-1", "event agent_start", "event message_end"]);
	});

	it("delivers command notices to every observer in write order, even when an observer writes a command", async () => {
		const { connection } = connect("echo");
		const first: string[] = [];
		const last: string[] = [];
		let nested: Promise<unknown> | undefined;
		connection.observeCommands((command) => {
			first.push(`${command.type} ${command.status}`);
			// An observer that reacts to a command by writing another (as an adapter might answer with an abort).
			if (command.type === "get_state") nested ??= connection.request({ type: "get_messages" });
		});
		connection.observeCommands((command) => last.push(`${command.type} ${command.status}`));
		await connection.request({ type: "get_state" });
		await nested;
		expect(first).toEqual(["get_state sent", "get_messages sent"]);
		expect(last).toEqual(["get_state sent", "get_messages sent"]);
	});

	it("reports a command whose write failed after it was announced as undelivered", async () => {
		const { connection } = connect("close-stdin", { closeTimeoutMs: 200 });
		await connection.request({ type: "get_state" });
		// The fake has closed its input; the next write passes the checks, is announced, then fails with EPIPE.
		await new Promise((done) => setTimeout(done, 100));
		const notices: string[] = [];
		connection.observeCommands((command) => notices.push(`${command.type} ${command.id} ${command.status}`));
		await expect(connection.request({ type: "abort" })).rejects.toThrow("Prime RPC input failed");
		const deadline = Date.now() + 5_000;
		while (notices.length < 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
		expect(notices).toEqual(["abort endophasia-2 sent", "abort endophasia-2 undelivered"]);
	});

	it("stops delivering to an unsubscribed listener", async () => {
		const { connection } = connect("interleave");
		const seen: string[] = [];
		const unsubscribe = connection.subscribe((event) => {
			seen.push(event.type);
			unsubscribe();
		});
		await connection.request({ type: "prompt" });
		await connection.close();
		expect(seen).toEqual(["agent_start"]);
	});
});

describe("Prime RPC connection: lifecycle", () => {
	it("rejects a pending request when the process exits, and every later request", async () => {
		const { connection } = connect("exit-pending");
		const error = await connection.request({ type: "prompt" }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PrimeRpcExitErrorV0);
		expect((error as PrimeRpcExitErrorV0).exit).toEqual({ code: 3, signal: null, spawnFailed: false });
		expect(await connection.exited).toEqual({ code: 3, signal: null, spawnFailed: false });
		await expect(connection.request({ type: "get_state" })).rejects.toBeInstanceOf(PrimeRpcExitErrorV0);
		// close() after exit still waits for the drain and returns the same termination.
		expect(await connection.close()).toEqual(await connection.terminated);
		expect((await connection.terminated).stdoutDrained).toBe(true);
	});

	it("settles a request whose response arrives after Prime's exit was reported", async () => {
		const { connection } = connect("late-response-after-exit");
		const response = connection.request({ type: "shutdown" });
		expect((await connection.exited).code).toBe(0);
		expect(await response).toMatchObject({ command: "shutdown", success: true, data: { late: true } });
		expect((await connection.terminated).stdoutDrained).toBe(true);
	});

	it("decodes every record written before exit, including a final record without LF", async () => {
		const { connection, events, diagnostics } = connect("trailing-exit");
		await connection.request({ type: "get_state" });
		const termination = await connection.terminated;
		expect(termination).toEqual({ exit: { code: 0, signal: null, spawnFailed: false }, stdoutDrained: true });
		expect(events.map((event) => event.type)).toEqual(["late_event", "final_without_lf"]);
		expect(diagnostics).toEqual([]);
	});

	it.runIf(POSIX)("bounds the drain when a descendant holds stdout, and kills the process group", async () => {
		const { connection, diagnostics } = connect("descendant", { drainGraceMs: 300 });
		await connection.request({ type: "get_state" });
		const pid = connection.processGroupId as number;
		expect(await connection.exited).toEqual({ code: 0, signal: null, spawnFailed: false });
		const termination = await connection.close();
		expect(termination.stdoutDrained).toBe(false);
		expect(diagnostics).toContainEqual({ kind: "stdout-drain-timeout" });
		expect(await gone({ group: pid })).toBe(true);
	});

	it("closes idempotently, and refuses requests while closing", async () => {
		const { connection } = connect("echo");
		await connection.request({ type: "get_state" });
		const first = connection.close();
		expect(connection.close()).toBe(first);
		await expect(connection.request({ type: "get_state" })).rejects.toThrow(
			"Prime RPC connection is closing; get_state was not sent",
		);
		expect(await first).toEqual({ exit: { code: 0, signal: null, spawnFailed: false }, stdoutDrained: true });
	});

	it("escalates to SIGTERM when Prime ignores the end of its input", async () => {
		const { connection, diagnostics } = connect("ignore-stdin-end", { closeTimeoutMs: 200 });
		await connection.request({ type: "get_state" });
		const termination = await connection.close();
		expect(termination.exit).toEqual({ code: null, signal: "SIGTERM", spawnFailed: false });
		expect(diagnostics).toEqual([{ kind: "forced-termination", signal: "SIGTERM" }]);
	});

	it.runIf(POSIX)("escalates to SIGKILL when Prime ignores SIGTERM", async () => {
		const { connection, diagnostics } = connect("ignore-sigterm", { closeTimeoutMs: 200 });
		await connection.request({ type: "get_state" });
		const termination = await connection.close();
		expect(termination.exit).toEqual({ code: null, signal: "SIGKILL", spawnFailed: false });
		expect(diagnostics).toEqual([
			{ kind: "forced-termination", signal: "SIGTERM" },
			{ kind: "forced-termination", signal: "SIGKILL" },
		]);
	});

	it("rejects waiting and later requests promptly when Prime closes its input but keeps running", async () => {
		const { connection, diagnostics } = connect("close-stdin", { closeTimeoutMs: 200 });
		await connection.request({ type: "get_state" });
		// Let the fake close its end of the pipe before the next write.
		await new Promise((done) => setTimeout(done, 100));
		const started = Date.now();
		await expect(connection.request({ type: "get_state" })).rejects.toThrow(
			"Prime RPC input failed before responding to get_state",
		);
		expect(Date.now() - started).toBeLessThan(5_000);
		await expect(connection.request({ type: "get_state" })).rejects.toThrow(
			"Prime RPC input failed; get_state was not sent",
		);
		expect(diagnostics).toContainEqual({ kind: "stdin-failure" });
		expect((await connection.close()).exit.signal).toBe("SIGTERM");
	});

	it("rejects an extension UI answer whose write fails after the checks passed", async () => {
		const { connection } = connect("close-stdin", { closeTimeoutMs: 200 });
		await connection.request({ type: "get_state" });
		// The fake has closed its input, but no write has failed yet, so the answer passes the checks and then hits EPIPE.
		await new Promise((done) => setTimeout(done, 100));
		await expect(connection.answerExtensionUi("ui-1", { cancelled: true })).rejects.toThrow(
			"Prime RPC input failed; extension_ui_response was not delivered",
		);
	});

	it.runIf(POSIX)(
		"still sends SIGKILL to the group when SIGTERM ended Prime but a descendant ignores it",
		async () => {
			const { connection, diagnostics } = connect("descendant-ignores-sigterm", { closeTimeoutMs: 200 });
			const response = await connection.request({ type: "get_state" });
			const descendant = (response.data as { descendant: number }).descendant;
			const termination = await connection.close();
			expect(termination.exit).toEqual({ code: null, signal: "SIGTERM", spawnFailed: false });
			expect(diagnostics).toEqual([
				{ kind: "forced-termination", signal: "SIGTERM" },
				{ kind: "forced-termination", signal: "SIGKILL" },
			]);
			expect(await gone({ pid: descendant })).toBe(true);
		},
	);

	it.runIf(POSIX)("reaps a descendant left in the group when Prime exits by itself before escalation", async () => {
		const { connection, diagnostics } = connect("early-exit-descendant", { closeTimeoutMs: 5_000 });
		const response = await connection.request({ type: "get_state" });
		const descendant = (response.data as { descendant: number }).descendant;
		const started = Date.now();
		const termination = await connection.close();
		expect(termination.exit).toEqual({ code: 0, signal: null, spawnFailed: false });
		expect(Date.now() - started).toBeLessThan(4_000);
		expect(diagnostics[0]).toEqual({ kind: "forced-termination", signal: "SIGTERM" });
		expect(await gone({ pid: descendant })).toBe(true);
	});

	it.runIf(POSIX)(
		"reaps a descendant when Prime exits by itself, without close(), and never signals the group again",
		async () => {
			const { connection, diagnostics } = connect("exit-with-descendant");
			const response = await connection.request({ type: "get_state" });
			const descendant = (response.data as { descendant: number }).descendant;
			const pid = connection.processGroupId as number;
			await connection.terminated;
			expect(await gone({ pid: descendant })).toBe(true);
			expect(diagnostics).toEqual([{ kind: "forced-termination", signal: "SIGTERM" }]);
			// Once reaped, the group ID may belong to an unrelated group: close() neither probes nor signals it.
			await new Promise((done) => setTimeout(done, 50));
			const kill = vi.spyOn(process, "kill");
			try {
				await connection.close();
				expect(kill.mock.calls.filter(([target]) => target === -pid)).toEqual([]);
			} finally {
				kill.mockRestore();
			}
			expect(diagnostics).toEqual([{ kind: "forced-termination", signal: "SIGTERM" }]);
		},
	);

	it("reports a process that could not start, and rejects its requests", async () => {
		const { connection } = connect("echo", {
			installation: { mode: "binary", command: join(tmpdir(), "no-such-prime-agent"), leadingArgs: [] },
		});
		const error = await connection.request({ type: "get_state" }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PrimeRpcExitErrorV0);
		expect((error as Error).message).toMatch(/^Prime RPC process could not start before responding to get_state/);
		expect(await connection.exited).toEqual({ code: null, signal: null, spawnFailed: true });
		expect(await connection.close()).toMatchObject({ exit: { spawnFailed: true } });
	});
});

describe("Prime RPC connection: extension UI answers", () => {
	it("answers a dialog with Prime's own request ID, as a write that expects no response", async () => {
		const { connection, events } = connect("extension-ui");
		const observed: string[] = [];
		connection.observeCommands((command) => observed.push(`${command.type} ${command.id}`));
		await connection.request({ type: "prompt", message: "hi" });
		const dialog = events.find((event) => event.type === "extension_ui_request");
		expect(dialog?.record.id).toBe("ui-1");
		await connection.answerExtensionUi("ui-1", { confirmed: true });
		await connection.answerExtensionUi("ui-1", { value: "Allow" });
		await connection.answerExtensionUi("ui-1", { cancelled: true });
		const deadline = Date.now() + 5_000;
		while (events.filter((event) => event.type === "ui_answered").length < 3 && Date.now() < deadline) {
			await new Promise((done) => setTimeout(done, 10));
		}
		expect(events.filter((event) => event.type === "ui_answered").map((event) => event.record)).toEqual([
			{ type: "ui_answered", id: "ui-1", answer: { confirmed: true } },
			{ type: "ui_answered", id: "ui-1", answer: { value: "Allow" } },
			{ type: "ui_answered", id: "ui-1", answer: { cancelled: true } },
		]);
		expect(observed).toEqual([
			"prompt endophasia-1",
			"extension_ui_response ui-1",
			"extension_ui_response ui-1",
			"extension_ui_response ui-1",
		]);
	});

	it("refuses malformed answers, and answers after close", async () => {
		const { connection } = connect("extension-ui");
		await expect(connection.answerExtensionUi("", { confirmed: true })).rejects.toThrow(
			"An extension UI answer needs Prime's request ID",
		);
		for (const answer of [{ value: 1 }, { confirmed: "yes" }, { cancelled: false }, {}]) {
			await expect(
				connection.answerExtensionUi("ui-1", answer as unknown as { readonly cancelled: true }),
			).rejects.toThrow("An extension UI answer is malformed");
		}
		const closing = connection.close();
		await expect(connection.answerExtensionUi("ui-1", { cancelled: true })).rejects.toThrow(
			"Prime RPC connection is closing; extension_ui_response was not sent",
		);
		await closing;
	});
});

describe.runIf(POSIX && existsSync("/proc/self/stat"))("Prime RPC connection: owned process group", () => {
	it("kills the whole group when the keeper cannot act on release", async () => {
		const pidFile = join(temporaryDirectory("prime-stopped-keeper-"), "command.pid");
		const group = new PrimeProcessGroupV0(
			process.execPath,
			[
				"-e",
				`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
			],
			{ cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" }, stderr: "ignore" },
		);
		const deadline = Date.now() + 5_000;
		while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
		const command = Number(readFileSync(pidFile, "utf8"));
		// A stopped keeper never reads the release message; the fallback must still reach the command.
		process.kill(group.groupId as number, "SIGSTOP");
		const started = Date.now();
		await group.release();
		// The group is killed directly, not by asking the keeper: no wait for a keeper that cannot act.
		expect(Date.now() - started).toBeLessThan(1_500);
		expect(await gone({ pid: command })).toBe(true);
		expect(await gone({ group: group.groupId as number })).toBe(true);
	});

	it("still ends a Prime that ignores every signal when the keeper is stuck", async () => {
		const { connection, diagnostics } = connect("ignore-sigterm", { closeTimeoutMs: 200 });
		await connection.request({ type: "get_state" });
		const prime = connection.pid as number;
		// A stopped keeper can act on nothing: the SIGKILL stage must not depend on it.
		process.kill(connection.processGroupId as number, "SIGSTOP");
		const started = Date.now();
		const termination = await connection.close();
		expect(Date.now() - started).toBeLessThan(8_000);
		expect(termination.exit.signal).toBe("SIGKILL");
		expect(diagnostics).toEqual([
			{ kind: "forced-termination", signal: "SIGTERM" },
			{ kind: "forced-termination", signal: "SIGKILL" },
		]);
		expect(await gone({ pid: prime })).toBe(true);
	});

	it("ends Prime and its descendants when the keeper dies unexpectedly", async () => {
		const { connection } = connect("descendant-ignores-sigterm");
		const response = await connection.request({ type: "get_state" });
		const descendant = (response.data as { descendant: number }).descendant;
		const prime = connection.pid as number;
		// Something other than this connection kills the keeper alone.
		process.kill(connection.processGroupId as number, "SIGKILL");
		expect(await gone({ pid: prime })).toBe(true);
		expect(await gone({ pid: descendant })).toBe(true);
		await connection.close();
	});

	it("keeps the command, arguments and environment off the keeper's command line and environment", async () => {
		const { connection } = connect("echo", {
			args: ["echo", "--secret", "TOOL_ARGS_SENTINEL"],
			env: { PATH: process.env.PATH ?? "", PRIME_TOKEN: "PROMPT_SENTINEL" },
		});
		await connection.request({ type: "get_state" });
		const keeper = connection.processGroupId as number;
		expect(readFileSync(`/proc/${keeper}/cmdline`, "utf8")).not.toMatch(SENTINEL);
		expect(readFileSync(`/proc/${keeper}/environ`, "utf8")).toBe("");
	});

	it("ends the whole group when the owning process dies without closing", async () => {
		const directory = temporaryDirectory("prime-orphan-");
		const script = join(directory, "owner.ts");
		writeFileSync(
			script,
			[
				`import { PrimeRpcConnectionV0 } from ${JSON.stringify(join(PACKAGE, "runtime/prime/rpc-connection.ts"))};`,
				"const connection = new PrimeRpcConnectionV0({",
				`\tinstallation: { mode: "binary", command: process.execPath, leadingArgs: [${JSON.stringify(FAKE)}] },`,
				'\targs: ["descendant-ignores-sigterm"],',
				'\tenv: { PATH: process.env.PATH ?? "" },',
				`\tcwd: ${JSON.stringify(tmpdir())},`,
				"});",
				'const response = await connection.request({ type: "get_state" });',
				"process.stdout.write(JSON.stringify({ group: connection.processGroupId, prime: connection.pid, descendant: response.data.descendant }));",
				"process.exit(0);",
			].join("\n"),
		);
		const output = execFileSync(process.execPath, [script], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "" },
		});
		const { group, prime, descendant } = JSON.parse(output) as { group: number; prime: number; descendant: number };
		expect(await gone({ group })).toBe(true);
		expect(running({ pid: prime })).toBe(false);
		expect(running({ pid: descendant })).toBe(false);
	});
});

describe("Prime RPC connection: hermetic environment", () => {
	it("passes a large non-ASCII environment through the keeper unchanged", async () => {
		// About 100 KB each of multi-byte text: the control socket delivers it over several reads, splitting characters.
		const values = {
			PRIME_TEST_A: "界".repeat(33_333),
			PRIME_TEST_B: `x${"é🙂".repeat(16_000)}`,
			PRIME_TEST_C: `xy${"界é".repeat(19_000)}`,
		};
		const { connection } = connect("env-values", { env: { PATH: process.env.PATH ?? "", ...values } });
		const response = await connection.request({ type: "get_state" });
		expect(response.data).toEqual(values);
	});

	it("passes exactly the given environment, never this process's credentials", async () => {
		const saved = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-must-not-leak";
		try {
			const { connection } = connect("env");
			const response = await connection.request({ type: "get_state" });
			expect(response.data).toEqual({ hasOpenAiKey: false, keys: ["PATH"] });
		} finally {
			if (saved === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = saved;
		}
	});
});

describe("Prime runtime identity", () => {
	it("resolves PRIME_AGENT_BIN before PRIME_AGENT_ROOT, against the given cwd", () => {
		const cwd = resolve("/work");
		expect(resolvePrimeInstallationV0({}, cwd)).toBeUndefined();
		expect(resolvePrimeInstallationV0({ PRIME_AGENT_BIN: "", PRIME_AGENT_ROOT: "" }, cwd)).toBeUndefined();
		expect(resolvePrimeInstallationV0({ PRIME_AGENT_BIN: "prime-agent" }, cwd)).toEqual({
			mode: "binary",
			command: "prime-agent",
			leadingArgs: [],
		});
		expect(resolvePrimeInstallationV0({ PRIME_AGENT_BIN: "bin/prime-agent", PRIME_AGENT_ROOT: "/src" }, cwd)).toEqual(
			{
				mode: "binary",
				command: resolve(cwd, "bin/prime-agent"),
				leadingArgs: [],
			},
		);
		expect(resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: "prime" }, cwd)).toEqual({
			mode: "source-checkout",
			root: resolve(cwd, "prime"),
			command: join(resolve(cwd, "prime"), "prime-agent.sh"),
			leadingArgs: [],
		});
	});

	function scriptInstallation(source: string): PrimeInstallationV0 {
		const directory = temporaryDirectory("prime-identity-");
		const script = join(directory, "version.mjs");
		writeFileSync(script, source);
		return { mode: "binary", command: process.execPath, leadingArgs: [script] };
	}
	const versionScript = (output: string, stream: "stdout" | "stderr" = "stdout") =>
		scriptInstallation(`process.${stream}.write(${JSON.stringify(output)});\n`);
	const options = { env: { PATH: process.env.PATH ?? "" }, cwd: tmpdir() };

	it("reads a binary's version and claims no source commit", async () => {
		const installation = versionScript("prime-agent 0.9.6\n");
		expect(await readPrimeRuntimeIdentityV0(installation, options)).toEqual({ version: "0.9.6", installation });
		expect(
			(await readPrimeRuntimeIdentityV0(versionScript("prime-agent 0.9.6-beta.1\n", "stderr"), options)).version,
		).toBe("0.9.6-beta.1");
		expect((await readPrimeRuntimeIdentityV0(versionScript("v0.9.6\n"), options)).version).toBe("0.9.6");
		// A version-like path segment is not a version.
		expect((await readPrimeRuntimeIdentityV0(versionScript("/opt/prime-1.2.3/bin 0.9.6\n"), options)).version).toBe(
			"0.9.6",
		);
	});

	it("rejects output that names more than one version, and accepts one version on both streams", async () => {
		await expect(readPrimeRuntimeIdentityV0(versionScript("node v20.1.0\n0.9.6\n"), options)).rejects.toThrow(
			"Could not read a Prime version from --version",
		);
		const both = scriptInstallation('process.stdout.write("0.9.6");\nprocess.stderr.write("0.9.6\\n");\n');
		expect((await readPrimeRuntimeIdentityV0(both, options)).version).toBe("0.9.6");
		// The streams are never glued into one word.
		const glued = scriptInstallation('process.stdout.write("0.9.6");\nprocess.stderr.write("x");\n');
		expect((await readPrimeRuntimeIdentityV0(glued, options)).version).toBe("0.9.6");
	});

	it("bounds --version when it ignores SIGTERM or a descendant holds its output open", async () => {
		const pidFile = join(temporaryDirectory("prime-identity-stubborn-"), "stubborn.pid");
		const stubborn = scriptInstallation(
			[
				'import { writeFileSync } from "node:fs";',
				`writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
				"process.on('SIGTERM', () => {});",
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		let started = Date.now();
		await expect(readPrimeRuntimeIdentityV0(stubborn, { ...options, timeoutMs: 300 })).rejects.toThrow(
			"Could not read a Prime version from --version",
		);
		expect(Date.now() - started).toBeLessThan(5_000);
		// The read settled only after the timed-out command was gone: it is not running when the rejection arrives.
		if (POSIX) expect(running({ pid: Number(readFileSync(pidFile, "utf8")) })).toBe(false);
		// A descendant holding the output open is killed once the command exited, so the read completes.
		const directory = temporaryDirectory("prime-identity-pid-");
		const holder = scriptInstallation(
			[
				'import { spawn } from "node:child_process";',
				'import { writeFileSync } from "node:fs";',
				'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "ignore"] });',
				"child.unref();",
				`writeFileSync(${JSON.stringify(join(directory, "holder.pid"))}, String(child.pid));`,
				'process.stdout.write("0.9.6\\n");',
			].join("\n"),
		);
		started = Date.now();
		expect((await readPrimeRuntimeIdentityV0(holder, { ...options, timeoutMs: 10_000 })).version).toBe("0.9.6");
		expect(Date.now() - started).toBeLessThan(5_000);
		if (POSIX) expect(await gone({ pid: Number(readFileSync(join(directory, "holder.pid"), "utf8")) })).toBe(true);
	});

	it.runIf(POSIX)("leaves no descendant behind after a successful --version", async () => {
		const directory = temporaryDirectory("prime-identity-pid-");
		const launcher = scriptInstallation(
			[
				'import { spawn } from "node:child_process";',
				'import { writeFileSync } from "node:fs";',
				'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
				"child.unref();",
				`writeFileSync(${JSON.stringify(join(directory, "detached.pid"))}, String(child.pid));`,
				'process.stdout.write("0.9.6\\n");',
			].join("\n"),
		);
		expect((await readPrimeRuntimeIdentityV0(launcher, options)).version).toBe("0.9.6");
		expect(await gone({ pid: Number(readFileSync(join(directory, "detached.pid"), "utf8")) })).toBe(true);
	});

	it("accepts only SemVer 2.0.0 versions", async () => {
		for (const output of ["1.2.3-rc.1+build.5\n", "1.2.3-0\n", "1.2.3-alpha-1\n", "v10.20.30\n"]) {
			expect((await readPrimeRuntimeIdentityV0(versionScript(output), options)).version).toBe(
				output.trim().replace(/^v/, ""),
			);
		}
		for (const output of ["01.2.3\n", "1.02.3\n", "1.2.3-01\n", "1.2.3+foo+bar\n", "1.2.3-\n", "1.2.3-a..b\n"]) {
			await expect(readPrimeRuntimeIdentityV0(versionScript(output), options)).rejects.toThrow(
				"Could not read a Prime version from --version",
			);
		}
	});

	it("rejects when no version can be read", async () => {
		for (const output of ["prime-agent\n", "/opt/prime/1.2.3\n", "prime-agent-1.2.3\n", "C:\\prime\\1.2.3\n"]) {
			await expect(readPrimeRuntimeIdentityV0(versionScript(output), options)).rejects.toThrow(
				"Could not read a Prime version from --version",
			);
		}
		await expect(
			readPrimeRuntimeIdentityV0(
				{ mode: "binary", command: join(tmpdir(), "no-such-prime"), leadingArgs: [] },
				options,
			),
		).rejects.toThrow("Could not read a Prime version from --version");
	});

	it.runIf(POSIX)("reads a source checkout's commit and clean or dirty tree", async () => {
		const root = temporaryDirectory("prime-checkout-");
		const home = temporaryDirectory("prime-git-home-");
		const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
				env,
				encoding: "utf8",
			});
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "prime-agent 0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		git("init", "-q");
		git("add", "prime-agent.sh");
		git("commit", "-q", "-m", "init");
		const commit = git("rev-parse", "HEAD").trim();
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		expect(await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).toEqual({
			version: "0.9.6",
			installation,
			source: { commit, tree: "clean" },
		});
		// Untracked files do not make a tree dirty; a modified tracked file does.
		writeFileSync(join(root, "untracked.txt"), "x");
		expect((await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source).toEqual({
			commit,
			tree: "clean",
		});
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "prime-agent 0.9.6"\n# edited\n');
		expect((await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source).toEqual({
			commit,
			tree: "dirty",
		});
	});

	it.runIf(POSIX)("accepts a SHA-256 repository's commit", async () => {
		const root = temporaryDirectory("prime-sha256-");
		const home = temporaryDirectory("prime-git-home-");
		const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
				env,
				encoding: "utf8",
			});
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		git("init", "-q", "--object-format=sha256");
		git("add", "prime-agent.sh");
		git("commit", "-q", "-m", "init");
		const commit = git("rev-parse", "HEAD").trim();
		expect(commit).toMatch(/^[0-9a-f]{64}$/);
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		expect((await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source).toEqual({
			commit,
			tree: "clean",
		});
	});

	it.runIf(POSIX)("ignores GIT_* variables that would select another repository", async () => {
		const home = temporaryDirectory("prime-git-home-");
		const base = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
		const commitIn = (root: string) => {
			const git = (...args: string[]) =>
				execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
					env: base,
					encoding: "utf8",
				});
			git("init", "-q");
			writeFileSync(join(root, "file.txt"), root);
			git("add", ".");
			git("commit", "-q", "-m", "init");
			return git("rev-parse", "HEAD").trim();
		};
		const other = temporaryDirectory("prime-other-repo-");
		commitIn(other);
		const prime = temporaryDirectory("prime-own-repo-");
		writeFileSync(join(prime, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(prime, "prime-agent.sh"), 0o755);
		const own = commitIn(prime);
		const redirect = { ...base, GIT_DIR: join(other, ".git"), GIT_WORK_TREE: prime };
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: prime }, tmpdir()) as PrimeInstallationV0;
		expect((await readPrimeRuntimeIdentityV0(installation, { env: redirect, cwd: tmpdir() })).source).toEqual({
			commit: own,
			tree: "clean",
		});
		// A root that is not a repository stays unknown even when GIT_DIR names one.
		const plain = temporaryDirectory("prime-plain-");
		writeFileSync(join(plain, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(plain, "prime-agent.sh"), 0o755);
		const plainInstallation = resolvePrimeInstallationV0(
			{ PRIME_AGENT_ROOT: plain },
			tmpdir(),
		) as PrimeInstallationV0;
		const toPlain = { ...base, GIT_DIR: join(other, ".git"), GIT_WORK_TREE: plain };
		expect((await readPrimeRuntimeIdentityV0(plainInstallation, { env: toPlain, cwd: tmpdir() })).source).toEqual({
			tree: "unknown",
		});
	});

	/** A checkout with a stand-in git whose HEAD is "a…" on the first read and "b…" after, or alternates on every read. */
	function movingCheckout(mode: "once" | "always", launcher = '#!/bin/sh\necho "0.9.6"\n') {
		const root = temporaryDirectory("prime-moving-head-");
		writeFileSync(join(root, "prime-agent.sh"), launcher);
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		const bin = temporaryDirectory("prime-fake-git-");
		writeFileSync(
			join(bin, "git"),
			[
				"#!/bin/sh",
				'root="$2"; shift 2',
				'if [ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]; then echo "$root"; exit 0; fi',
				// The launcher is reported as a tracked regular file, as in a real checkout.
				'if [ "$1" = ls-files ] && [ "$2" = -v ]; then printf "H prime-agent.sh\\000"; exit 0; fi',
				`if [ "$1" = ls-files ]; then printf "100755 %s 0\\t%s\\n" ${"c".repeat(40)} "$4"; exit 0; fi`,
				'if [ "$1" = rev-parse ]; then',
				'  n=$(cat "$PRIME_TEST_COUNTER" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$PRIME_TEST_COUNTER"',
				'  if [ "$PRIME_TEST_MODE" = always ]; then [ $((n % 2)) = 1 ] && moved=no || moved=yes; else [ "$n" = 1 ] && moved=no || moved=yes; fi',
				`  if [ "$moved" = no ]; then echo ${"a".repeat(40)}; else echo ${"b".repeat(40)}; fi; exit 0`,
				"fi",
				"exit 0",
			].join("\n"),
		);
		chmodSync(join(bin, "git"), 0o755);
		const env = {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			PRIME_TEST_COUNTER: join(bin, "reads"),
			PRIME_TEST_MODE: mode,
		};
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		return { installation, env };
	}

	it.runIf(POSIX)(
		"rereads the identity when the checkout moves during the read, never mixing two states",
		async () => {
			// HEAD moves once, between the snapshots around --version: the read is repeated and reports the settled commit.
			const once = movingCheckout("once");
			expect((await readPrimeRuntimeIdentityV0(once.installation, { env: once.env, cwd: tmpdir() })).source).toEqual(
				{
					commit: "b".repeat(40),
					tree: "clean",
				},
			);
			// A checkout that keeps moving is an error, not an identity that never described one runtime.
			const always = movingCheckout("always");
			await expect(
				readPrimeRuntimeIdentityV0(always.installation, { env: always.env, cwd: tmpdir() }),
			).rejects.toThrow("The Prime checkout changed while its identity was read");
			// So is a launcher that is rewritten each time --version runs, even with a stable HEAD and status.
			const selfEditing = movingCheckout("once", '#!/bin/sh\necho "0.9.6"\necho "# $$" >> "$0"\n');
			writeFileSync(selfEditing.env.PRIME_TEST_COUNTER, "1");
			await expect(
				readPrimeRuntimeIdentityV0(selfEditing.installation, { env: selfEditing.env, cwd: tmpdir() }),
			).rejects.toThrow("The Prime checkout changed while its identity was read");
			// The same stand-in with a stable HEAD and an unchanging launcher reads cleanly.
			const stable = movingCheckout("once");
			writeFileSync(stable.env.PRIME_TEST_COUNTER, "1");
			expect(
				(await readPrimeRuntimeIdentityV0(stable.installation, { env: stable.env, cwd: tmpdir() })).source,
			).toEqual({
				commit: "b".repeat(40),
				tree: "clean",
			});
		},
	);

	it.runIf(POSIX)("never reports an enclosing repository's commit as the checkout's", async () => {
		const outer = temporaryDirectory("prime-outer-repo-");
		const home = temporaryDirectory("prime-git-home-");
		const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
		const root = join(outer, "vendor", "prime");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", outer, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { env });
		git("init", "-q");
		git("add", ".");
		git("commit", "-q", "-m", "outer");
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		expect((await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source).toEqual({
			tree: "unknown",
		});
	});

	it.runIf(POSIX)("hashes the build output the launcher loads, as the conformance probe does", async () => {
		const root = temporaryDirectory("prime-built-");
		const home = temporaryDirectory("prime-git-home-");
		const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
				env,
				encoding: "utf8",
			});
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		writeFileSync(join(root, ".gitignore"), "dist/\n");
		git("init", "-q");
		git("add", "prime-agent.sh", ".gitignore");
		git("commit", "-q", "-m", "init");
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		const read = async () => (await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source;
		// No build output: nothing to hash, so the build is unverified.
		expect((await read())?.artifactsHash).toBeUndefined();
		for (const [name, content] of [
			["agent/dist/index.js", "export const a = 1;\n"],
			["agent/dist/nested/util.js", "export const b = 2;\n"],
			["coding-agent/dist/cli.js", "console.log('é');\n"],
		]) {
			mkdirSync(join(root, "packages", name, ".."), { recursive: true });
			writeFileSync(join(root, "packages", name), content);
		}
		const built = await read();
		expect(built).toMatchObject({ tree: "clean" });
		expect(built?.artifactsHash).toMatch(/^[0-9a-f]{64}$/);
		expect(built?.artifactsHash).toBe(hashBuildOutputV0(root));
		// A rebuilt output at the same commit, with a still-clean tracked tree, changes the hash.
		writeFileSync(join(root, "packages/agent/dist/index.js"), "export const a = 2;\n");
		const rebuilt = await read();
		expect(rebuilt).toMatchObject({ commit: built?.commit, tree: "clean" });
		expect(rebuilt?.artifactsHash).not.toBe(built?.artifactsHash);
		expect(rebuilt?.artifactsHash).toBe(hashBuildOutputV0(root));
		// A symlink loads code the hash does not cover: unverified.
		symlinkSync(join(root, "prime-agent.sh"), join(root, "packages/agent/dist/link.js"));
		expect((await read())?.artifactsHash).toBeUndefined();
		expect(hashBuildOutputV0(root)).toBeUndefined();
		rmSync(join(root, "packages/agent/dist/link.js"));
		expect((await read())?.artifactsHash).toMatch(/^[0-9a-f]{64}$/);
		// So does a symlinked dist or package directory, whose own children would otherwise be hashed as if local.
		const elsewhere = temporaryDirectory("prime-linked-build-");
		mkdirSync(join(elsewhere, "dist"), { recursive: true });
		writeFileSync(join(elsewhere, "dist", "index.js"), "export const linked = 1;\n");
		symlinkSync(join(elsewhere, "dist"), join(root, "packages/extra-dist"));
		mkdirSync(join(root, "packages/linked-dist"), { recursive: true });
		symlinkSync(join(elsewhere, "dist"), join(root, "packages/linked-dist/dist"));
		expect((await read())?.artifactsHash).toBeUndefined();
		rmSync(join(root, "packages/linked-dist/dist"));
		expect((await read())?.artifactsHash).toBeUndefined();
		rmSync(join(root, "packages/extra-dist"));
		symlinkSync(elsewhere, join(root, "packages/linked-package"));
		expect((await read())?.artifactsHash).toBeUndefined();
		rmSync(join(root, "packages/linked-package"));
		expect((await read())?.artifactsHash).toMatch(/^[0-9a-f]{64}$/);
		// A NUL byte in a file would let two different trees frame to the same digest input: unverified.
		writeFileSync(join(root, "packages/agent/dist/blob.bin"), Uint8Array.of(0x61, 0x00, 0x62));
		expect((await read())?.artifactsHash).toBeUndefined();
	});

	it.runIf(POSIX)("bounds the build-output walk: a tree nested past the depth bound is unverified", async () => {
		const root = temporaryDirectory("prime-deep-");
		const home = temporaryDirectory("prime-git-home-");
		const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
				env,
				encoding: "utf8",
			});
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		git("init", "-q");
		git("add", "prime-agent.sh");
		git("commit", "-q", "-m", "init");
		mkdirSync(join(root, "packages/core/dist"), { recursive: true });
		writeFileSync(join(root, "packages/core/dist/index.js"), "export {};\n");
		const shallow = join(root, "packages/core/dist", ...Array.from({ length: 10 }, () => "d"));
		mkdirSync(shallow, { recursive: true });
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		const read = async () => (await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source;
		expect((await read())?.artifactsHash).toBe(hashBuildOutputV0(root));
		mkdirSync(join(shallow, ...Array.from({ length: 70 }, () => "d")), { recursive: true });
		expect((await read())?.artifactsHash).toBeUndefined();
	});

	it.runIf(POSIX)("orders build output by code unit with /-separated paths, independent of locale", async () => {
		const root = temporaryDirectory("prime-order-");
		const home = temporaryDirectory("prime-git-home-");
		const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
				env,
				encoding: "utf8",
			});
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		git("init", "-q");
		git("add", "prime-agent.sh");
		git("commit", "-q", "-m", "init");
		// Names whose locale collation differs from code-unit order ("B" < "a" < "ä" by code unit).
		const files: [string, string][] = [
			["packages/core/dist/B.js", "upper"],
			["packages/core/dist/a.js", "lower"],
			["packages/core/dist/ä.js", "umlaut"],
		];
		for (const [path, content] of files) {
			mkdirSync(join(root, path, ".."), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		const expected = createHash("sha256");
		for (const [path, content] of files) expected.update(path).update("\0").update(content).update("\0");
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		const source = (await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source;
		expect(source?.artifactsHash).toBe(expected.digest("hex"));
		// The probe's locale order puts "a.js" first here, so it differs; for Prime 0.9.6's build output both orders agree.
		expect(source?.artifactsHash).not.toBe(hashBuildOutputV0(root));
	});

	it.runIf(POSIX)("reports no provenance when index flags hide modifications from git status", async () => {
		const root = temporaryDirectory("prime-index-flags-");
		const home = temporaryDirectory("prime-git-home-");
		const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
				env,
				encoding: "utf8",
			});
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		writeFileSync(join(root, "agent.js"), "export {};\n");
		git("init", "-q");
		git("add", "prime-agent.sh", "agent.js");
		git("commit", "-q", "-m", "init");
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		const read = async () => (await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source;
		const commit = git("rev-parse", "HEAD").trim();
		expect(await read()).toEqual({ commit, tree: "clean" });
		// A launcher marked assume-unchanged and then edited: git status stays empty, but the provenance is not trusted.
		git("update-index", "--assume-unchanged", "prime-agent.sh");
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n# edited\n');
		expect(git("status", "--porcelain", "--untracked-files=no")).toBe("");
		expect(await read()).toEqual({ tree: "unknown" });
		git("update-index", "--no-assume-unchanged", "prime-agent.sh");
		git("checkout", "--", "prime-agent.sh");
		expect(await read()).toEqual({ commit, tree: "clean" });
		// Any other tracked file hidden by skip-worktree likewise.
		git("update-index", "--skip-worktree", "agent.js");
		writeFileSync(join(root, "agent.js"), "export const hidden = 1;\n");
		expect(await read()).toEqual({ tree: "unknown" });
	});

	it.runIf(POSIX)("reports no provenance when the launcher is untracked or a symlink", async () => {
		const root = temporaryDirectory("prime-launcher-");
		const home = temporaryDirectory("prime-git-home-");
		const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
				env,
				encoding: "utf8",
			});
		writeFileSync(join(root, "README"), "checkout\n");
		git("init", "-q");
		git("add", "README");
		git("commit", "-q", "-m", "init");
		// An untracked launcher: the commit and a clean tracked tree say nothing about the code that ran.
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		const read = async () => (await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source;
		expect(await read()).toEqual({ tree: "unknown" });
		// A tracked symlink to a launcher outside the checkout: the code it runs is not the checkout's.
		const outside = join(temporaryDirectory("prime-outside-launcher-"), "prime-agent.sh");
		writeFileSync(outside, '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(outside, 0o755);
		rmSync(join(root, "prime-agent.sh"));
		symlinkSync(outside, join(root, "prime-agent.sh"));
		git("add", "prime-agent.sh");
		git("commit", "-q", "-m", "link");
		expect(await read()).toEqual({ tree: "unknown" });
		// A tracked regular launcher: the provenance is reported.
		rmSync(join(root, "prime-agent.sh"));
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		git("add", "prime-agent.sh");
		git("commit", "-q", "-m", "regular");
		expect(await read()).toEqual({ commit: git("rev-parse", "HEAD").trim(), tree: "clean" });
	});

	it.runIf(POSIX)("reports no commit when the tree status cannot be read", async () => {
		const root = temporaryDirectory("prime-no-status-");
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		const bin = temporaryDirectory("prime-fake-git-");
		writeFileSync(
			join(bin, "git"),
			[
				"#!/bin/sh",
				'root="$2"; shift 2',
				'if [ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]; then echo "$root"; exit 0; fi',
				// The launcher is reported as a tracked regular file, as in a real checkout.
				'if [ "$1" = ls-files ] && [ "$2" = -v ]; then printf "H prime-agent.sh\\000"; exit 0; fi',
				`if [ "$1" = ls-files ]; then printf "100755 %s 0\\t%s\\n" ${"c".repeat(40)} "$4"; exit 0; fi`,
				`if [ "$1" = rev-parse ]; then echo ${"a".repeat(40)}; exit 0; fi`,
				"exit 1",
			].join("\n"),
		);
		chmodSync(join(bin, "git"), 0o755);
		const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		expect((await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source).toEqual({
			tree: "unknown",
		});
	});

	it.runIf(POSIX)("reports an unknown tree when the checkout is not a git repository", async () => {
		const root = temporaryDirectory("prime-not-git-");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "prime-agent.sh"), '#!/bin/sh\necho "0.9.6"\n');
		chmodSync(join(root, "prime-agent.sh"), 0o755);
		const installation = resolvePrimeInstallationV0({ PRIME_AGENT_ROOT: root }, tmpdir()) as PrimeInstallationV0;
		const env = {
			PATH: process.env.PATH ?? "",
			HOME: temporaryDirectory("prime-git-home-"),
			GIT_CEILING_DIRECTORIES: tmpdir(),
		};
		expect((await readPrimeRuntimeIdentityV0(installation, { env, cwd: tmpdir() })).source).toEqual({
			tree: "unknown",
		});
	});
});

describe("Prime runtime ingress import boundaries", () => {
	const specifiers = (file: string) =>
		[
			...readFileSync(file, "utf8").matchAll(
				/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"|import\s+"([^"]+)"/g,
			),
		].map((match) => match[1] ?? match[2]);
	const tsFiles = (directory: string): string[] =>
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory()
				? tsFiles(join(directory, entry.name))
				: entry.name.endsWith(".ts")
					? [join(directory, entry.name)]
					: [],
		);

	it("runtime/prime imports only node: builtins and its own modules, never research", () => {
		const files = tsFiles(join(PACKAGE, "runtime/prime"));
		expect(files.length).toBe(4);
		for (const file of files) {
			for (const specifier of specifiers(file)) expect(specifier).toMatch(/^(node:[a-z_/]+|\.\/[a-z-]+\.ts)$/);
		}
	});

	it("the common layer, Presentation, Cockpit and the Pi Session worker never reach runtime/prime", () => {
		const files = [
			...tsFiles(join(PACKAGE, "src")),
			...tsFiles(join(PACKAGE, "presentation")),
			...tsFiles(join(PACKAGE, "cockpit")),
			join(PACKAGE, "runtime/session-worker.ts"),
		];
		for (const file of files) {
			for (const specifier of specifiers(file)) expect(specifier, file).not.toMatch(/prime/i);
		}
		// The runtime-neutral observation contract has no Prime vocabulary at all.
		expect(readFileSync(join(PACKAGE, "src/runtime-observation.ts"), "utf8")).not.toMatch(/prime/i);
	});
});

// Opt-in only: ENDOPHASIA_PRIME_LIVE_SMOKE=1 with PRIME_AGENT_BIN or PRIME_AGENT_ROOT. It reads the identity, starts
// Prime in RPC mode in a disposable HOME, asks get_state (no prompt, so no provider request), and shuts down.
const liveInstallation =
	process.env.ENDOPHASIA_PRIME_LIVE_SMOKE === "1"
		? resolvePrimeInstallationV0(
				{ PRIME_AGENT_BIN: process.env.PRIME_AGENT_BIN, PRIME_AGENT_ROOT: process.env.PRIME_AGENT_ROOT },
				process.cwd(),
			)
		: undefined;

describe.runIf(liveInstallation !== undefined)("Prime RPC ingress live smoke (opt-in)", () => {
	it("reads the identity and answers get_state in an isolated environment", async () => {
		const installation = liveInstallation as PrimeInstallationV0;
		const root = temporaryDirectory("prime-ingress-live-");
		const home = join(root, "home");
		const tmp = join(root, "tmp");
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		for (const directory of [home, tmp, agentDir, sessionDir]) mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"ingress-local": {
						// Unreachable on purpose: no request is ever sent.
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "unused",
						models: [
							{
								id: "ingress-model",
								name: "Ingress",
								reasoning: false,
								input: ["text"],
								contextWindow: 1_000,
								maxTokens: 100,
							},
						],
					},
				},
			}),
		);
		const env = {
			PATH: process.env.PATH ?? "",
			HOME: home,
			TMPDIR: tmp,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			XDG_CACHE_HOME: join(home, ".cache"),
			PRIME_AGENT_CODING_AGENT_DIR: agentDir,
			PRIME_AGENT_SESSION_DIR: sessionDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PRIME_AGENT_TELEMETRY: "0",
			DO_NOT_TRACK: "1",
			NO_COLOR: "1",
		};
		const identity = await readPrimeRuntimeIdentityV0(installation, { env, cwd: root });
		expect(identity.version).toMatch(/^\d+\.\d+\.\d+/);
		if (installation.mode === "binary") expect(identity.source).toBeUndefined();
		const connection = new PrimeRpcConnectionV0({
			installation,
			args: [
				"--provider",
				"ingress-local",
				"--model",
				"ingress-model",
				"--session-dir",
				sessionDir,
				"--no-extensions",
				"--no-skills",
			],
			env,
			cwd: root,
		});
		try {
			expect(await connection.request({ type: "get_state" })).toMatchObject({ command: "get_state", success: true });
		} finally {
			await connection.close();
			execFileSync(installation.command, [...installation.leadingArgs, "shutdown", "--force"], {
				cwd: root,
				env,
				stdio: "ignore",
				timeout: 30_000,
			});
		}
	}, 120_000);
});
