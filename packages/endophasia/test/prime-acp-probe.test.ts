// Offline wire/decoder tests; no Prime binary, SDK or provider credentials.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AcpRequestError, ResearchAcpClient } from "../research/prime-conformance/acp-client.ts";
import {
	ACP_NAMESPACE,
	decodeAcpInitialize,
	decodeAcpPrompt,
	decodeAcpUpdate,
} from "../research/prime-conformance/acp-evidence.ts";
import { PrimeDecodeError } from "../research/prime-conformance/decode.ts";
import { SENTINELS } from "../research/prime-conformance/fake-provider.ts";
import { scanForSentinelsV0 } from "../research/prime-conformance/report.ts";

const update = {
	sessionId: "00000000-0000-4000-8000-000000000001",
	update: {
		sessionUpdate: "agent_message_chunk",
		messageId: "prime-agent-assistant-1",
		content: { type: "text", text: SENTINELS.assistant },
		_meta: {
			[ACP_NAMESPACE]: { promptTurnId: 1, eventSequence: 1, phase: "event", future: { text: SENTINELS.prompt } },
		},
	},
};
function mutate(value: unknown, path: string[], next: unknown): unknown {
	const copy = structuredClone(value) as Record<string, unknown>;
	let cursor = copy;
	for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
	if (next === undefined) delete cursor[path.at(-1)!];
	else cursor[path.at(-1)!] = next;
	return copy;
}
describe("ACP structural decoding", () => {
	it("drops chunks and unknown meta payload values while keeping structural names", () => {
		const result = decodeAcpUpdate(update);
		expect(result.metaKeys).toContain("future");
		expect(result.keys).toContain("content");
		expect(scanForSentinelsV0("decode", result)).toEqual([]);
		expect(result).not.toHaveProperty("content");
	});
	it.each([
		["sessionId", "bad"],
		["sessionId", null],
		["update._meta", undefined],
		["update.sessionUpdate", ""],
		[`update._meta.${ACP_NAMESPACE}.promptTurnId`, -1],
		[`update._meta.${ACP_NAMESPACE}.eventSequence`, 1.5],
		[`update._meta.${ACP_NAMESPACE}.phase`, "complete"],
		[`update._meta.${ACP_NAMESPACE}.outcome`, "success"],
		[`update._meta.${ACP_NAMESPACE}.terminalQuiescenceExpected`, "true"],
		["update.content.type", "image"],
		["update.content.text", 17],
	])("rejects malformed %s", (path, value) => {
		const keys = path
			.replace(ACP_NAMESPACE, "NAMESPACE")
			.split(".")
			.map((key) => (key === "NAMESPACE" ? ACP_NAMESPACE : key));
		expect(() => decodeAcpUpdate(mutate(update, keys, value))).toThrow(PrimeDecodeError);
	});
	it("drops raw tool input, outputs, summaries and gate failure text", () => {
		const result = decodeAcpUpdate({
			sessionId: update.sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "call_probe_1",
				kind: "execute",
				status: "in_progress",
				rawInput: { text: SENTINELS.toolArgs },
				content: SENTINELS.toolResult,
				_meta: {
					[ACP_NAMESPACE]: {
						promptTurnId: 1,
						eventSequence: 2,
						phase: "event",
						compaction: { summary: SENTINELS.summary, tokensBefore: 500 },
						autonomous: {
							enabled: true,
							continuationsUsed: 0,
							turnsUsed: 1,
							tokensUsed: 7,
							gateFailure: SENTINELS.errorDetail,
						},
					},
				},
			},
		});
		expect(scanForSentinelsV0("tool", result)).toEqual([]);
		expect(result.compaction).toEqual({ hasSummary: true, tokensBefore: 500 });
		expect(result.autonomous?.hasGateFailure).toBe(true);
	});
	it("requires identity and closed status for native tool events", () => {
		const tool = {
			...update,
			update: {
				...update.update,
				sessionUpdate: "tool_call",
				kind: "other",
				status: "in_progress",
				toolCallId: "call_probe_1",
			},
		};
		expect(decodeAcpUpdate(tool).toolKind).toBe("other");
		for (const field of ["kind", "status", "toolCallId"])
			expect(() => decodeAcpUpdate(mutate(tool, ["update", field], undefined))).toThrow();
		expect(() => decodeAcpUpdate(mutate(tool, ["update", "status"], "succeeded"))).toThrow();
	});
	it("retains actual initialize booleans and only metadata field names", () => {
		const result = decodeAcpInitialize({
			protocolVersion: 1,
			agentInfo: { name: "prime-agent", version: "0.9.7", title: SENTINELS.assistant },
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: true },
				sessionCapabilities: { close: {} },
			},
			_meta: { [ACP_NAMESPACE]: { future: SENTINELS.prompt } },
		});
		expect(result.capabilityFlags).toEqual({ loadSession: false, "promptCapabilities.image": true });
		expect(result.primeMetaKeys).toEqual(["future"]);
		expect(scanForSentinelsV0("init", result)).toEqual([]);
		expect(() => decodeAcpInitialize({})).toThrow();
	});
	it.each(["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"])(
		"preserves %s without inferring a mission terminal",
		(reason) =>
			expect(decodeAcpPrompt({ stopReason: reason, _meta: { payload: SENTINELS.prompt } }, 1)).toEqual({
				ordinal: 1,
				response: "result",
				stopReason: reason,
			}),
	);
	it.each([{}, { stopReason: "success" }, { stopReason: null }])("rejects malformed prompt result %j", (result) =>
		expect(() => decodeAcpPrompt(result, 1)).toThrow(),
	);
});
const fake = fileURLToPath(new URL("./fixtures/prime/fake-acp-server.mjs", import.meta.url));
function client(mode: string): ResearchAcpClient {
	return new ResearchAcpClient({
		command: process.execPath,
		args: [fake, mode],
		cwd: process.cwd(),
		env: { PATH: process.env.PATH },
		onUpdate: decodeAcpUpdate,
	});
}
describe("ACP NDJSON process transport", () => {
	it("notification success means local writer completion and fails after close", async () => {
		const c = client("normal");
		try {
			await expect(c.notify("session/cancel", { sessionId: update.sessionId })).resolves.toBeUndefined();
			// This response is to a separate request. The cancellation notification has no response ID or acknowledgement.
			expect(await c.request("initialize", {})).toEqual({ ok: true });
		} finally {
			await c.close();
		}
		await expect(c.notify("session/cancel", {})).rejects.toThrow("connection closed");
		expect(c.protocolErrors).toEqual([]);
	});
	it.each(["normal", "split", "final"])("correlates %s framing and drains cleanly", async (mode) => {
		const c = client(mode);
		try {
			expect(await c.request("initialize", {})).toEqual({ ok: true });
		} finally {
			expect((await c.close()).code).toBe(0);
		}
		expect(c.protocolErrors).toEqual([]);
	});
	it.each([
		"unknown-id",
		"ambiguous",
		"wrong-version",
		"wrong-id",
		"malformed",
		"nonobject",
		"server-request",
		"bad-error",
		"bad-update",
	])("rejects %s without retaining raw text", async (mode) => {
		const c = client(mode);
		try {
			await expect(c.request("initialize", {})).rejects.toThrow(PrimeDecodeError);
		} finally {
			await c.close();
		}
		expect(c.protocolErrors.length).toBeGreaterThan(0);
		expect(scanForSentinelsV0("errors", c.protocolErrors)).toEqual([]);
	});
	it("does not turn a JSON-RPC error into success or persist its message/data", async () => {
		const c = client("error");
		try {
			await expect(c.request("session/prompt", {})).rejects.toMatchObject({
				code: -32603,
				message: "ACP request error",
			});
		} finally {
			await c.close();
		}
		expect(c.protocolErrors).toEqual([]);
		expect(new AcpRequestError(-1).code).toBe(-1);
	});
	it("detects a duplicate response even after resolving the first", async () => {
		const c = client("duplicate");
		try {
			await c.request("initialize", {});
		} finally {
			await c.close();
		}
		expect(c.protocolErrors.length).toBeGreaterThan(0);
	});
	it("rejects pending requests and reports abnormal process exit", async () => {
		const c = client("exit");
		await expect(c.request("initialize", {})).rejects.toThrow("exited");
		expect((await c.close()).code).toBe(7);
	});
});
