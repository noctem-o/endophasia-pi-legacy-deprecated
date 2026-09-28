// Research-only (Prime Runtime Conformance v0). A deterministic loopback OpenAI Chat Completions endpoint that Prime
// is pointed at through its documented models.json custom-provider seam. It listens on 127.0.0.1 only, so no probe
// content leaves the machine and no API credits are spent.
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
	partial: { prompt: 300, completion: 5, cached: 0, cacheWrite: 0 },
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

/**
 * Pick the scripted step: the scenario comes from the last user prompt that starts with a marker, the step from replies
 * since. Summarization requests embed the conversation (markers included) inside a larger prompt, so an anchored
 * marker keeps them on the summary script.
 */
export function selectStepV0(messages: readonly ChatMessage[]): { scenario: string; step: Step } {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user" && SCENARIO_MARKER.test(text(messages[i]?.content))) {
			lastUser = i;
			break;
		}
	}
	if (lastUser === -1) return { scenario: "summary", step: { kind: "text", usage: "summary" } };
	const scenario = SCENARIO_MARKER.exec(text(messages[lastUser]?.content))?.[1] ?? "simple";
	const replies = messages.slice(lastUser + 1).filter((message) => message.role === "assistant").length;
	const script = SCRIPTS[scenario] ?? SCRIPTS.simple!;
	return { scenario, step: script[Math.min(replies, script.length - 1)]! };
}

function usageChunk(name: string): Record<string, unknown> {
	const usage = SCENARIO_USAGE[name] ?? SCENARIO_USAGE.simple!;
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
	/** Scenario names of every request received, in order. */
	readonly requests: string[];
	close(): Promise<void>;
}

/** Start the fake on an ephemeral loopback port. */
export async function startFakeProviderV0(): Promise<FakeProviderV0> {
	const requests: string[] = [];
	let callCounter = 0;
	const open = new Set<ServerResponse>();
	const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			let body: { messages?: ChatMessage[]; model?: string } = {};
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {}
			const { scenario, step } = selectStepV0(body.messages ?? []);
			requests.push(scenario);
			const model = body.model ?? "probe-model";
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
		async close() {
			for (const response of open) response.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
