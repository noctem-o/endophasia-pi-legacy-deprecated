// Research-only (Prime Runtime Conformance v0). Runs deterministic scenarios against a real Prime Agent over
// `--mode rpc`, in isolated temporary environments against a loopback fake provider, and keeps only sanitized
// evidence. Live payloads are inspected in memory only to decide when to abort; nothing but evidence is retained.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPrimeEnvironmentV0, type PrimeBinaryV0, type PrimeEnvironmentV0 } from "./environment.ts";
import {
	PROBE_NAME,
	PROBE_VERSION,
	type PrimeCommandEvidenceV0,
	type PrimeProvenanceV0,
	type PrimeScenarioEvidenceV0,
	type PrimeSessionEntryEvidenceV0,
	type PrimeStatsEvidenceV0,
	sanitizeCommandV0,
	sanitizeSessionEntryV0,
	sanitizeStatsV0,
} from "./evidence.ts";
import { type FakeProviderV0, SENTINELS, startFakeProviderV0 } from "./fake-provider.ts";
import { type PrimeEvidenceEventV0, sanitizePrimeEventV0 } from "./protocol.ts";
import { PrimeRpcClientV0 } from "./rpc-client.ts";

type Trigger = (type: string, event: Record<string, unknown>) => boolean;

/** One Prime process attached to an isolated environment, recording sanitized evidence only. */
class ProbeSession {
	readonly client: PrimeRpcClientV0;
	readonly #run: ScenarioRecorder;
	#agentEnd: (() => void) | undefined;
	#abortOn: Trigger | undefined;

	constructor(binary: PrimeBinaryV0, environment: PrimeEnvironmentV0, run: ScenarioRecorder) {
		this.#run = run;
		this.client = new PrimeRpcClientV0({
			command: binary.command,
			args: [...binary.leadingArgs, ...environment.baseArgs],
			env: environment.env,
			cwd: environment.cwd,
			onEvent: (type, event) => {
				const sanitized = sanitizePrimeEventV0(type, event);
				if (sanitized !== undefined) run.events.push(sanitized);
				// Decide on the event's type and role only; the payload is not read.
				if (this.#abortOn?.(type, event) === true) {
					this.#abortOn = undefined;
					run.abortRequestedAfter.push(run.events.length - 1);
					void this.command({ type: "abort" });
				}
				if (type === "agent_end") this.#agentEnd?.();
			},
		});
	}

	async command(command: { readonly type: string } & Record<string, unknown>) {
		const response = await this.client.request(command);
		this.#run.commands.push(sanitizeCommandV0(response));
		return response;
	}

	/**
	 * Prompt one scenario turn and wait for its agent_end. Optionally abort when a trigger first matches. Returns whether
	 * Prime admitted the prompt. `streamingBehavior` is the only RPC prompt option that also resumes a suspended queue.
	 */
	async prompt(
		scenario: string,
		options: { abortOn?: Trigger; streamingBehavior?: "followUp" } = {},
	): Promise<boolean> {
		this.#abortOn = options.abortOn;
		const ended = new Promise<void>((resolve) => {
			this.#agentEnd = resolve;
		});
		const response = await this.command({
			type: "prompt",
			message: `SCENARIO:${scenario} ${SENTINELS.prompt}`,
			...(options.streamingBehavior === undefined ? {} : { streamingBehavior: options.streamingBehavior }),
		});
		if (!response.success) return false;
		await Promise.race([
			ended,
			new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`${scenario} did not end`)), 60_000)),
		]);
		this.#agentEnd = undefined;
		return true;
	}

	async stats(label: string): Promise<void> {
		const response = await this.command({ type: "get_session_stats" });
		this.#run.stats.push(sanitizeStatsV0(label, response.data));
	}

	/** The current session file path, used in memory only to read the durable entries. */
	async sessionFile(): Promise<string | undefined> {
		const response = await this.client.request({ type: "get_state" });
		const data = response.data as Record<string, unknown> | undefined;
		this.#run.stateKeys = Object.keys(data ?? {}).sort();
		return typeof data?.sessionFile === "string" ? data.sessionFile : undefined;
	}

	async close(): Promise<void> {
		await this.client.close();
		this.#run.protocolErrors.push(...this.client.protocolErrors);
	}
}

interface ScenarioRecorder {
	events: PrimeEvidenceEventV0[];
	abortRequestedAfter: number[];
	commands: PrimeCommandEvidenceV0[];
	stats: PrimeStatsEvidenceV0[];
	sessionEntries: PrimeSessionEntryEvidenceV0[];
	stateKeys: string[];
	protocolErrors: string[];
	notes: string[];
}

function readSessionEntries(path: string | undefined): PrimeSessionEntryEvidenceV0[] {
	if (path === undefined) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.flatMap((line) => {
			const entry = sanitizeSessionEntryV0(JSON.parse(line));
			return entry === undefined ? [] : [entry];
		});
}

interface ScenarioContext {
	readonly binary: PrimeBinaryV0;
	readonly environment: PrimeEnvironmentV0;
	readonly run: ScenarioRecorder;
	open(): ProbeSession;
}

interface ScenarioDefinition {
	readonly name: string;
	readonly description: string;
	execute(context: ScenarioContext): Promise<void>;
}

const assistantStarted: Trigger = (type, event) =>
	type === "message_start" && (event.message as { role?: unknown } | undefined)?.role === "assistant";
const toolStarted: Trigger = (type) => type === "tool_execution_start";

/** Write a crafted durable session: one assistant reply with an RLM child usage attribution folded into it. */
function writeChildUsageSession(environment: PrimeEnvironmentV0): string {
	const id = "01a0e89c-0000-7000-8000-00000000c41d";
	const usage = (input: number, output: number, total: number) => ({
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: total,
		cost: { input, output: output * 2, cacheRead: 0, cacheWrite: 0, total: input + output * 2 },
	});
	const parent = usage(1_000, 50, 1_050);
	const child = usage(400, 20, 420);
	const aggregate = { ...usage(1_400, 70, 1_050), totalTokens: 1_050 };
	const lines = [
		{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: environment.cwd },
		{
			type: "message",
			id: "a0000001",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: `SCENARIO:simple ${SENTINELS.prompt}`, timestamp: 1 },
		},
		{
			type: "message",
			id: "a0000002",
			parentId: "a0000001",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `${SENTINELS.assistant} parent` }],
				api: "openai-completions",
				provider: "probe-local",
				model: "probe-model",
				usage: parent,
				stopReason: "stop",
				timestamp: 2,
			},
		},
		{
			type: "child_usage_attributed",
			id: "a0000003",
			parentId: "a0000002",
			timestamp: "2026-01-01T00:00:03.000Z",
			targetId: "a0000002",
			childUsage: child,
			aggregateUsage: aggregate,
		},
	];
	const path = join(environment.sessionDir, `${id}.jsonl`);
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return path;
}

export const SCENARIOS: readonly ScenarioDefinition[] = [
	{
		name: "simple",
		description: "One prompt, one assistant completion with known usage.",
		async execute({ open, run }) {
			const session = open();
			await session.prompt("simple");
			await session.stats("after");
			run.sessionEntries = readSessionEntries(await session.sessionFile());
			await session.close();
		},
	},
	{
		name: "tool-run",
		description: "Assistant tool call, successful tool execution, second assistant completion.",
		async execute({ open, run }) {
			const session = open();
			await session.prompt("tool-run");
			await session.stats("after");
			run.sessionEntries = readSessionEntries(await session.sessionFile());
			await session.close();
		},
	},
	{
		name: "tool-error",
		description: "The tool throws; the model recovers with a final answer.",
		async execute({ open, run }) {
			const session = open();
			await session.prompt("tool-error");
			await session.stats("after");
			run.sessionEntries = readSessionEntries(await session.sessionFile());
			await session.close();
		},
	},
	{
		name: "provider-failure",
		description: "The provider rejects the request with a non-retryable error.",
		async execute({ open, run }) {
			const session = open();
			await session.command({ type: "set_auto_retry", enabled: false });
			await session.prompt("provider-failure");
			await session.stats("after");
			run.sessionEntries = readSessionEntries(await session.sessionFile());
			await session.close();
		},
	},
	{
		name: "abort-stream",
		description: "RPC abort while the assistant response is streaming.",
		async execute({ open, run }) {
			const session = open();
			await session.prompt("abort-stream", { abortOn: assistantStarted });
			await session.stats("after");
			// An RPC abort suspends Prime's input queue; a plain prompt is refused until a prompt that may queue resumes it.
			run.notes.push(`plain prompt after abort admitted: ${await session.prompt("multi-a")}`);
			run.notes.push(
				`followUp prompt after abort admitted: ${await session.prompt("multi-b", { streamingBehavior: "followUp" })}`,
			);
			await session.stats("after-resume");
			run.sessionEntries = readSessionEntries(await session.sessionFile());
			await session.close();
		},
	},
	{
		name: "abort-tool",
		description: "RPC abort while a tool is executing.",
		async execute({ open, run }) {
			const session = open();
			await session.prompt("abort-tool", { abortOn: toolStarted });
			await session.stats("after");
			run.sessionEntries = readSessionEntries(await session.sessionFile());
			await session.close();
		},
	},
	{
		name: "length-stop",
		description: "The assistant stops on the output-length limit.",
		async execute({ open, run }) {
			const session = open();
			await session.prompt("length");
			await session.stats("after");
			run.sessionEntries = readSessionEntries(await session.sessionFile());
			await session.close();
		},
	},
	{
		name: "reasoning-usage",
		description: "The provider reports reasoning tokens and reasoning content.",
		async execute({ open, run }) {
			const session = open();
			await session.prompt("reasoning");
			await session.stats("after");
			run.sessionEntries = readSessionEntries(await session.sessionFile());
			await session.close();
		},
	},
	{
		name: "multi-turn-reopen",
		description: "Three prompts with known usage, then the process exits and a new process reopens the session file.",
		async execute({ open, run }) {
			const first = open();
			for (const scenario of ["multi-a", "multi-b", "multi-c"]) {
				await first.prompt(scenario);
				await first.stats(`after-${scenario}`);
			}
			const path = await first.sessionFile();
			const before = readSessionEntries(path);
			await first.close();
			const second = open();
			const switched = await second.command({ type: "switch_session", sessionPath: path });
			run.notes.push(`reopen via switch_session succeeded: ${switched.success}`);
			await second.stats("after-reopen");
			const messages = await second.command({ type: "get_messages" });
			const count = Array.isArray((messages.data as { messages?: unknown[] } | undefined)?.messages)
				? (messages.data as { messages: unknown[] }).messages.length
				: -1;
			run.notes.push(`messages after reopen: ${count}`);
			const after = readSessionEntries(await second.sessionFile());
			run.notes.push(
				`entry ids stable across reopen: ${JSON.stringify(before.map((entry) => entry.id)) === JSON.stringify(after.slice(0, before.length).map((entry) => entry.id))}`,
			);
			run.sessionEntries = after;
			await second.close();
		},
	},
	{
		name: "compaction",
		description: "Two prompts, then a manual compaction whose summary also reports usage.",
		async execute({ open, run }) {
			const session = open();
			await session.prompt("multi-a");
			await session.prompt("multi-b");
			await session.stats("before-compaction");
			const compacted = await session.command({ type: "compact" });
			run.notes.push(`compaction succeeded: ${compacted.success}`);
			await session.stats("after-compaction");
			// Manual compaction aborts first (compact -> abort -> requestAbort), which suspends the input queue. Record the
			// plain refusal, then resume with a prompt that may queue.
			run.notes.push(`plain prompt after compaction admitted: ${await session.prompt("multi-c")}`);
			run.notes.push(
				`followUp prompt after compaction admitted: ${await session.prompt("multi-c", { streamingBehavior: "followUp" })}`,
			);
			await session.stats("after-next-prompt");
			run.sessionEntries = readSessionEntries(await session.sessionFile());
			await session.close();
		},
	},
	{
		name: "fork",
		description: "Two prompts, then a fork from the second user message, then one more prompt on the fork.",
		async execute({ open, run }) {
			const session = open();
			await session.prompt("multi-a");
			await session.prompt("multi-b");
			await session.stats("before-fork");
			const originalFile = await session.sessionFile();
			const forkable = await session.client.request({ type: "get_fork_messages" });
			const entries = (
				(forkable.data as { messages?: { entryId?: unknown }[] } | undefined)?.messages ?? []
			).flatMap((message) => (typeof message.entryId === "string" ? [message.entryId] : []));
			run.notes.push(`forkable user messages: ${entries.length}`);
			const target = entries.at(-1);
			if (target !== undefined) {
				const forked = await session.command({ type: "fork", entryId: target });
				run.notes.push(`fork succeeded: ${forked.success}`);
			}
			await session.stats("after-fork");
			const forkFile = await session.sessionFile();
			run.notes.push(`fork created a different session file: ${forkFile !== originalFile}`);
			await session.prompt("multi-c");
			await session.stats("after-fork-prompt");
			run.sessionEntries = readSessionEntries(forkFile);
			const original = readSessionEntries(originalFile);
			run.notes.push(`original file entries after fork: ${original.length}`);
			const originalIds = new Set(original.flatMap((entry) => (entry.type === "session" ? [] : [entry.id])));
			const shared = run.sessionEntries.filter((entry) => entry.type !== "session" && originalIds.has(entry.id));
			run.notes.push(`fork entries sharing an id with the original file: ${shared.length}`);
			await session.close();
		},
	},
	{
		name: "child-usage-replay",
		description:
			"A crafted durable session holding one child_usage_attributed entry, reopened by a real Prime process (no live RLM child).",
		async execute({ environment, open, run }) {
			const path = writeChildUsageSession(environment);
			const session = open();
			const switched = await session.command({ type: "switch_session", sessionPath: path });
			run.notes.push(`crafted session opened: ${switched.success}`);
			await session.stats("after-open");
			run.sessionEntries = readSessionEntries(path);
			await session.close();
		},
	},
];

export interface PrimeProbeOptionsV0 {
	readonly binary: PrimeBinaryV0;
	readonly provenance: PrimeProvenanceV0;
	readonly retain?: boolean;
	readonly only?: readonly string[];
	readonly log?: (message: string) => void;
}

/** Run every scenario, each in its own isolated environment and Prime process tree. */
export async function runPrimeProbeV0(options: PrimeProbeOptionsV0): Promise<PrimeScenarioEvidenceV0[]> {
	const results: PrimeScenarioEvidenceV0[] = [];
	for (const scenario of SCENARIOS) {
		if (options.only !== undefined && !options.only.includes(scenario.name)) continue;
		options.log?.(`scenario ${scenario.name}`);
		const fake: FakeProviderV0 = await startFakeProviderV0();
		const environment = createPrimeEnvironmentV0({ providerBaseUrl: fake.baseUrl, retain: options.retain });
		const run: ScenarioRecorder = {
			events: [],
			abortRequestedAfter: [],
			commands: [],
			stats: [],
			sessionEntries: [],
			stateKeys: [],
			protocolErrors: [],
			notes: [],
		};
		const sessions: ProbeSession[] = [];
		try {
			await scenario.execute({
				binary: options.binary,
				environment,
				run,
				open: () => {
					const session = new ProbeSession(options.binary, environment, run);
					sessions.push(session);
					return session;
				},
			});
		} catch (error) {
			run.notes.push(`scenario error: ${error instanceof Error ? error.name : "unknown"}`);
		} finally {
			for (const session of sessions) await session.client.close();
			environment.dispose(options.binary);
			await fake.close();
		}
		run.notes.push(`provider requests: ${fake.requests.length}`);
		results.push({
			provenance: { ...options.provenance, scenario: scenario.name },
			description: scenario.description,
			...run,
		});
	}
	return results;
}

/** Identify the Prime under test: its reported version and, for a source checkout, its commit. */
export function describePrimeV0(binary: PrimeBinaryV0, env: NodeJS.ProcessEnv): PrimeProvenanceV0 {
	// Even --version runs in a disposable environment, so no user state is touched.
	const environment = createPrimeEnvironmentV0({ providerBaseUrl: "http://127.0.0.1:9/v1" });
	let version: string;
	try {
		// Prime prints its version on stderr in some modes; accept either stream.
		const result = spawnSync(binary.command, [...binary.leadingArgs, "--version"], {
			cwd: environment.cwd,
			env: environment.env,
			encoding: "utf8",
			timeout: 60_000,
		});
		version = /\d+\.\d+\.\d+\S*/.exec(`${result.stdout} ${result.stderr}`)?.[0] ?? "unknown";
	} finally {
		environment.dispose(binary);
	}
	let commit: string | undefined;
	if (env.PRIME_AGENT_ROOT !== undefined) {
		try {
			commit = execFileSync("git", ["-C", env.PRIME_AGENT_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		} catch {}
	}
	return {
		source: "prime-agent",
		version,
		...(commit === undefined ? {} : { commit }),
		mode: "rpc",
		generatedBy: PROBE_NAME,
		probeVersion: PROBE_VERSION,
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
	};
}
