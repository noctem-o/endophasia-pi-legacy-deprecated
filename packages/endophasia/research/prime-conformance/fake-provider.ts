// Research-only (Prime Runtime Conformance v0). A deterministic loopback OpenAI Chat Completions endpoint that Prime
// is pointed at through its documented models.json custom-provider seam. It listens on 127.0.0.1 only, so no probe
// content leaves the machine and no API credits are spent.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const SENTINELS = {
	prompt: "PROMPT_SENTINEL",
	assistant: "ASSISTANT_SENTINEL",
	reasoning: "REASONING_SENTINEL",
	toolArgs: "TOOL_ARGS_SENTINEL",
	toolResult: "TOOL_RESULT_SENTINEL",
	errorDetail: "ERROR_DETAIL_SENTINEL",
	summary: "SUMMARY_SENTINEL",
} as const;

export const SENTINEL_PATTERN = new RegExp(Object.values(SENTINELS).join("|"));

/** Usage the fake reports, in OpenAI's shape. Prime derives input = prompt - cached - cacheWrite. */
export interface FakeUsageV0 {
	readonly prompt: number;
	readonly completion: number;
	readonly cached: number;
	readonly cacheWrite: number;
	readonly reasoning?: number;
}

export const SCENARIO_USAGE: Readonly<Record<string, FakeUsageV0>> = {
	simple: { prompt: 1_000, completion: 40, cached: 300, cacheWrite: 100 },
	"tool-call": { prompt: 1_200, completion: 60, cached: 0, cacheWrite: 200 },
	"tool-answer": { prompt: 1_400, completion: 30, cached: 800, cacheWrite: 0 },
	"multi-a": { prompt: 500, completion: 7, cached: 0, cacheWrite: 0 },
	"multi-b": { prompt: 700, completion: 11, cached: 250, cacheWrite: 50 },
	"multi-c": { prompt: 900, completion: 13, cached: 400, cacheWrite: 0 },
	reasoning: { prompt: 600, completion: 90, cached: 0, cacheWrite: 0, reasoning: 70 },
	length: { prompt: 400, completion: 64, cached: 0, cacheWrite: 0 },
	summary: { prompt: 2_000, completion: 120, cached: 0, cacheWrite: 0 },
};

/**
 * The usage Prime should record for one scripted response, derived from what the fake reports (OpenAI shape) through
 * Prime's documented mapping (openai-completions.ts parseChunkUsage): input = prompt - cached - cacheWrite, cacheRead =
 * cached, totalTokens recomputed, and cost = tokens x the probe model's per-million prices.
 */
export function expectedPrimeUsageV0(
	name: string,
	cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	},
): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
} {
	const usage = SCENARIO_USAGE[name];
	if (usage === undefined) throw new Error(`no usage is scripted for ${name}`);
	const input = usage.prompt - usage.cached - usage.cacheWrite;
	const tokens = { input, output: usage.completion, cacheRead: usage.cached, cacheWrite: usage.cacheWrite };
	const price = {
		input: (tokens.input * cost.input) / 1_000_000,
		output: (tokens.output * cost.output) / 1_000_000,
		cacheRead: (tokens.cacheRead * cost.cacheRead) / 1_000_000,
		cacheWrite: (tokens.cacheWrite * cost.cacheWrite) / 1_000_000,
	};
	return {
		...tokens,
		totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		cost: { ...price, total: price.input + price.output + price.cacheRead + price.cacheWrite },
	};
}

/**
 * For each probe scenario, the scripted usage behind each assistant message it produces, in order. `null` is an
 * assistant message the fake reported no usage for (a provider failure, or a stream aborted before usage).
 */
export const EXPECTED_ASSISTANT_USAGE: Readonly<Record<string, readonly (string | null)[]>> = {
	simple: ["simple"],
	"tool-run": ["tool-call", "tool-answer"],
	"tool-error": ["tool-call", "tool-answer"],
	"provider-failure": [null],
	"abort-stream": [null, "multi-b"],
	"abort-tool": ["tool-call"],
	"length-stop": ["length"],
	"reasoning-usage": ["reasoning"],
	"multi-turn-reopen": ["multi-a", "multi-b", "multi-c"],
	compaction: ["multi-a", "multi-b", "multi-c"],
	fork: ["multi-a", "multi-b", "multi-c"],
	"child-usage-replay": [],
};

/**
 * For each scenario, the scripted usage behind each assistant entry in the session file the evidence keeps, in file
 * order. It differs from the live messages only for the fork, whose kept file is the fork: it copies the first
 * exchange and adds the prompt made on the fork. child-usage-replay is absent: its file is crafted by the probe.
 */
export const EXPECTED_PERSISTED_USAGE: Readonly<Record<string, readonly (string | null)[]>> = {
	...Object.fromEntries(Object.entries(EXPECTED_ASSISTANT_USAGE).filter(([name]) => name !== "child-usage-replay")),
	fork: ["multi-a", "multi-c"],
};

type Step =
	| {
			readonly kind: "text";
			readonly usage: string;
			readonly finish?: "stop" | "length";
			readonly reasoning?: boolean;
	  }
	| { readonly kind: "tool"; readonly usage: string; readonly mode: "ok" | "fail" | "hang" }
	| { readonly kind: "http-error" }
	| { readonly kind: "hang-stream" };

/** Each scenario's scripted assistant responses, by how many assistant replies follow the scenario's user prompt. */
const SCRIPTS: Readonly<Record<string, readonly Step[]>> = {
	simple: [{ kind: "text", usage: "simple" }],
	"tool-run": [
		{ kind: "tool", usage: "tool-call", mode: "ok" },
		{ kind: "text", usage: "tool-answer" },
	],
	"tool-error": [
		{ kind: "tool", usage: "tool-call", mode: "fail" },
		{ kind: "text", usage: "tool-answer" },
	],
	"provider-failure": [{ kind: "http-error" }],
	"abort-stream": [{ kind: "hang-stream" }],
	"abort-tool": [{ kind: "tool", usage: "tool-call", mode: "hang" }],
	"multi-a": [{ kind: "text", usage: "multi-a" }],
	"multi-b": [{ kind: "text", usage: "multi-b" }],
	"multi-c": [{ kind: "text", usage: "multi-c" }],
	reasoning: [{ kind: "text", usage: "reasoning", reasoning: true }],
	length: [{ kind: "text", usage: "length", finish: "length" }],
};

interface ChatMessage {
	readonly role?: unknown;
	readonly content?: unknown;
}

const SCENARIO_MARKER = /^\s*SCENARIO:([a-z-]+)/;

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part !== null && typeof part === "object" && "text" in part ? String(part.text) : ""))
			.join("");
	}
	return "";
}

/** Why a request was refused: it does not belong to the scenario the fake is serving. */
export type UnexpectedProviderRequestV0 =
	| "unknown-marker"
	| "marker-not-expected"
	| "beyond-script"
	| "summary-not-allowed"
	| "wrong-model"
	| "wrong-endpoint"
	| "repeated-step";

/** One request the fake received, classified. Only `scripted` and `summary` requests are answered with a completion. */
export type FakeProviderRequestV0 =
	| { readonly kind: "scripted"; readonly marker: string; readonly reply: number }
	| { readonly kind: "summary" }
	| { readonly kind: "unexpected"; readonly reason: UnexpectedProviderRequestV0 }
	| { readonly kind: "malformed" };

/** What one scenario is allowed to ask for: its prompt markers, and summaries only while explicitly allowed. */
export interface FakeProviderExpectationsV0 {
	readonly markers: readonly string[];
	/** The only model the probe configured; a request for any other (or none) is refused. */
	readonly model: string;
}

/**
 * Classify a request. The scenario is the last user prompt that starts with a marker; the step is the number of
 * assistant replies since. A request with no marker is a summarization request (Prime embeds the conversation, markers
 * included, inside a larger prompt, so an anchored marker never matches it). Nothing falls back to another script.
 */
export function selectStepV0(
	messages: readonly ChatMessage[],
	expectations: FakeProviderExpectationsV0,
	summariesAllowed: boolean,
): { request: FakeProviderRequestV0; step?: Step } {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user" && SCENARIO_MARKER.test(text(messages[i]?.content))) {
			lastUser = i;
			break;
		}
	}
	if (lastUser === -1) {
		return summariesAllowed
			? { request: { kind: "summary" }, step: { kind: "text", usage: "summary" } }
			: { request: { kind: "unexpected", reason: "summary-not-allowed" } };
	}
	const marker = SCENARIO_MARKER.exec(text(messages[lastUser]?.content))?.[1] ?? "";
	const script = SCRIPTS[marker];
	if (script === undefined) return { request: { kind: "unexpected", reason: "unknown-marker" } };
	if (!expectations.markers.includes(marker))
		return { request: { kind: "unexpected", reason: "marker-not-expected" } };
	const reply = messages.slice(lastUser + 1).filter((message) => message.role === "assistant").length;
	const step = script[reply];
	if (step === undefined) return { request: { kind: "unexpected", reason: "beyond-script" } };
	return { request: { kind: "scripted", marker, reply }, step };
}

function usageChunk(name: string): Record<string, unknown> {
	// Every script step names a defined usage; a missing one is a probe bug, never a reason to borrow another's.
	const usage = SCENARIO_USAGE[name];
	if (usage === undefined) throw new Error(`no usage is scripted for ${name}`);
	return {
		prompt_tokens: usage.prompt,
		completion_tokens: usage.completion,
		total_tokens: usage.prompt + usage.completion,
		prompt_tokens_details: { cached_tokens: usage.cached + usage.cacheWrite, cache_write_tokens: usage.cacheWrite },
		...(usage.reasoning === undefined ? {} : { completion_tokens_details: { reasoning_tokens: usage.reasoning } }),
	};
}

export interface FakeProviderV0 {
	readonly baseUrl: string;
	/** Every request received, classified, in order. */
	readonly requests: readonly FakeProviderRequestV0[];
	/**
	 * Open or close the phase in which marker-less summarization requests are expected (one manual compaction). Prime
	 * makes one history call, plus one turn-prefix call when the cut splits a turn
	 * (prime:packages/coding-agent/src/core/compaction/compaction.ts:829-866): at most two distinct requests. The same
	 * request twice in one phase (a retry or double dispatch) is a repeated step; a third is beyond the script.
	 */
	allowSummaries(allowed: boolean): void;
	close(): Promise<void>;
}

const MAX_SUMMARIES_PER_COMPACTION = 2;

/** Start the fake on an ephemeral loopback port, serving exactly one scenario's expected requests. */
export async function startFakeProviderV0(expectations: FakeProviderExpectationsV0): Promise<FakeProviderV0> {
	const requests: FakeProviderRequestV0[] = [];
	let summariesAllowed = false;
	let summaryPhase = 0;
	let summariesInPhase = 0;
	const served = new Set<string>();
	let callCounter = 0;
	const open = new Set<ServerResponse>();
	const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			// Only the OpenAI Chat Completions route this provider is configured as; any other target is refused.
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				requests.push({ kind: "unexpected", reason: "wrong-endpoint" });
				response.writeHead(404, { "content-type": "application/json" });
				response.end(
					JSON.stringify({ error: { message: "unexpected probe endpoint", type: "invalid_request_error" } }),
				);
				return;
			}
			let body: { messages?: unknown; model?: unknown } | undefined;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {}
			const refuse = (message: string) => {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
			};
			// A request the fake cannot read, or did not expect, fails loudly: it is recorded, refused, and fails the run.
			if (body === null || typeof body !== "object" || !Array.isArray(body.messages)) {
				requests.push({ kind: "malformed" });
				refuse("malformed probe request");
				return;
			}
			if (body.model !== expectations.model) {
				requests.push({ kind: "unexpected", reason: "wrong-model" });
				refuse("unexpected probe model");
				return;
			}
			let selected = selectStepV0(body.messages as ChatMessage[], expectations, summariesAllowed);
			// Each scripted step, and the one summary of a compaction phase, is served once: a second request for it (a
			// retry or double dispatch) is unexpected, so its spend cannot vanish from the evidence.
			const stepKey =
				selected.request.kind === "scripted"
					? `${selected.request.marker}#${selected.request.reply}`
					: selected.request.kind === "summary"
						? `summary@${summaryPhase}:${createHash("sha256").update(JSON.stringify(body.messages)).digest("hex")}`
						: undefined;
			const repeated = stepKey !== undefined && served.has(stepKey);
			if (!repeated && selected.request.kind === "summary" && ++summariesInPhase > MAX_SUMMARIES_PER_COMPACTION)
				selected = { request: { kind: "unexpected", reason: "beyond-script" } };
			if (stepKey !== undefined) served.add(stepKey);
			const classified: FakeProviderRequestV0 = repeated
				? { kind: "unexpected", reason: "repeated-step" }
				: selected.request;
			const step = repeated ? undefined : selected.step;
			requests.push(classified);
			if (step === undefined) {
				refuse("unexpected probe request");
				return;
			}
			const scenario = classified.kind === "scripted" ? classified.marker : "summary";
			const model = expectations.model;
			if (step.kind === "http-error") {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						error: { message: `${SENTINELS.errorDetail} invalid request`, type: "invalid_request_error" },
					}),
				);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			open.add(response);
			response.on("close", () => open.delete(response));
			const id = `chatcmpl-probe-${++callCounter}`;
			const send = (
				delta: Record<string, unknown>,
				finish: string | null = null,
				extra: Record<string, unknown> = {},
			) =>
				response.write(
					`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
				);
			send({ role: "assistant", content: "" });
			if (step.kind === "hang-stream") {
				send({ content: `${SENTINELS.assistant} partial` });
				// Keep the stream open until the client aborts and closes it.
				return;
			}
			if (step.kind === "tool") {
				send({
					tool_calls: [
						{
							index: 0,
							id: `call_probe_${callCounter}`,
							type: "function",
							function: {
								name: "probe_tool",
								arguments: JSON.stringify({ mode: step.mode, note: SENTINELS.toolArgs }),
							},
						},
					],
				});
				send({}, "tool_calls");
			} else {
				if (step.reasoning === true) send({ reasoning_content: `${SENTINELS.reasoning} thinking` });
				send({ content: `${step.usage === "summary" ? SENTINELS.summary : SENTINELS.assistant} ${scenario}` });
				send({}, step.finish ?? "stop");
			}
			response.write(
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [], usage: usageChunk(step.usage) })}\n\n`,
			);
			response.write("data: [DONE]\n\n");
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		allowSummaries(allowed) {
			if (allowed && !summariesAllowed) {
				summaryPhase++;
				summariesInPhase = 0;
			}
			summariesAllowed = allowed;
		},
		async close() {
			for (const response of open) response.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
