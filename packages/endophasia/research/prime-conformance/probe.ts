// Research-only (Prime Runtime Conformance v0). Runs deterministic scenarios against a real Prime Agent over
// `--mode rpc`, in isolated temporary environments against a loopback fake provider, and keeps only sanitized
// evidence. Live payloads are inspected in memory only to decide when to abort; nothing but evidence is retained.
//
// Fail closed: every Prime value passes decode.ts before it becomes evidence, every scenario states the provider
// requests it expects, and every scenario's invariants must hold. Anything the probe cannot establish is recorded as a
// failure, which makes the scenario invalid evidence; it never becomes a default, a skipped step or a plausible value.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
	commandEvidenceV0,
	decodePrimeCompactionResultV0,
	decodePrimeEventV0,
	decodePrimeForkTargetsV0,
	decodePrimeMessageCountV0,
	decodePrimeSessionFileV0,
	decodePrimeStateV0,
	decodePrimeStatsV0,
	PrimeDecodeError,
	requirePrimeNotCancelledV0,
} from "./decode.ts";
import { createPrimeEnvironmentV0, PROBE_MODEL, type PrimeBinaryV0, type PrimeEnvironmentV0 } from "./environment.ts";
import {
	PROBE_NAME,
	PROBE_VERSION,
	type PrimeBuildProvenanceV0,
	type PrimeCommandErrorKindV0,
	type PrimeCommandEvidenceV0,
	type PrimeEntrySnapshotV0,
	type PrimeObservationsV0,
	type PrimeProvenanceV0,
	type PrimeScenarioEvidenceV0,
	type PrimeSessionEntryEvidenceV0,
	type PrimeStatsEvidenceV0,
} from "./evidence.ts";
import { CHILD_USAGE_SEED, type FakeProviderV0, SENTINELS, startFakeProviderV0 } from "./fake-provider.ts";
import { scenarioInvariantProblemsV0 } from "./invariants.ts";
import type { PrimeEvidenceEventV0, PrimeRpcResponseV0 } from "./protocol.ts";
import { PrimeRpcClientV0, PrimeRpcError, type PrimeRpcExitV0 } from "./rpc-client.ts";

/** A probe-authored failure: its message never contains Prime payloads, so it is safe to keep as evidence. */
export class PrimeProbeFailureV0 extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrimeProbeFailureV0";
	}
}

/**
 * The text kept for a caught error. Only messages the probe itself composed (field paths, command names, counts) are
 * kept; any other error (a Node or parser message, which may quote data) is reduced to its name.
 */
export function failureTextV0(error: unknown): string {
	if (error instanceof PrimeProbeFailureV0 || error instanceof PrimeDecodeError || error instanceof PrimeRpcError) {
		return error.message;
	}
	return error instanceof Error ? `unexpected ${error.name}` : "unexpected non-error exception";
}

/**
 * The real path of a session file Prime named, only if it lies inside the scenario's isolated session directory: a
 * path elsewhere (Prime ignoring --session-dir) could be the user's real session, which the probe must never read.
 */
export function confinedSessionFileV0(path: string, sessionDir: string): string {
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		throw new PrimeProbeFailureV0("get_state named a session file that does not exist");
	}
	if (!real.startsWith(`${realpathSync(sessionDir)}${sep}`)) {
		throw new PrimeProbeFailureV0("get_state named a session file outside the isolated session directory");
	}
	return real;
}

/** Prime exits 0 when its RPC input ends; any other exit (a crash, a kill after the close timeout, a signal) fails. */
export function abnormalExitV0(exit: PrimeRpcExitV0): string | undefined {
	return exit.code === 0 && exit.signal === null
		? undefined
		: `Prime RPC process exited abnormally (code ${exit.code}, signal ${exit.signal})`;
}

type Trigger = (type: string, event: Record<string, unknown>) => boolean;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface ScenarioRecorder {
	events: PrimeEvidenceEventV0[];
	abortRequestedAfter: number[];
	commands: PrimeCommandEvidenceV0[];
	stats: PrimeStatsEvidenceV0[];
	sessionEntries: PrimeSessionEntryEvidenceV0[];
	entrySnapshots: PrimeEntrySnapshotV0[];
	stateKeys: string[];
	observations: Mutable<PrimeObservationsV0>;
	protocolErrors: string[];
	failures: string[];
}

/** One Prime process attached to an isolated environment, recording decoded evidence only. */
class ProbeSession {
	readonly client: PrimeRpcClientV0;
	readonly #run: ScenarioRecorder;
	#agentEnd: (() => void) | undefined;
	#abortOn: Trigger | undefined;
	#closed: Promise<void> | undefined;

	readonly #sessionDir: string;

	constructor(binary: PrimeBinaryV0, environment: PrimeEnvironmentV0, run: ScenarioRecorder) {
		this.#run = run;
		this.#sessionDir = environment.sessionDir;
		this.client = new PrimeRpcClientV0({
			command: binary.command,
			args: [...binary.leadingArgs, ...environment.baseArgs],
			env: environment.env,
			cwd: environment.cwd,
			onEvent: (type, event) => {
				try {
					const evidence = decodePrimeEventV0(type, event);
					if (evidence !== undefined) run.events.push(evidence);
				} catch (error) {
					// A malformed event is not dropped silently: the scenario becomes invalid evidence.
					run.failures.push(`event ${type}: ${failureTextV0(error)}`);
				}
				// Decide on the event's type and role only; the payload is not read.
				if (this.#abortOn?.(type, event) === true) {
					this.#abortOn = undefined;
					run.abortRequestedAfter.push(run.events.length - 1);
					// Detached from the scenario's control flow: a failure is recorded, never left unhandled.
					this.command({ type: "abort" }).catch((error: unknown) => {
						run.failures.push(`abort request: ${failureTextV0(error)}`);
					});
				}
				if (type === "agent_end") this.#agentEnd?.();
			},
		});
	}

	/**
	 * Send a command and record it. A refusal fails the scenario unless the scenario expects exactly that refusal
	 * category (`expectRefusal`): any other refusal is not the behavior under test.
	 */
	async command(
		command: { readonly type: string } & Record<string, unknown>,
		options: { expectRefusal?: PrimeCommandErrorKindV0 } = {},
	): Promise<PrimeRpcResponseV0> {
		const response = await this.client.request(command);
		const evidence = commandEvidenceV0(response);
		this.#run.commands.push(evidence);
		if (!response.success && (options.expectRefusal === undefined || evidence.errorKind !== options.expectRefusal)) {
			throw new PrimeProbeFailureV0(`${command.type} was refused (${evidence.errorKind ?? "no category"})`);
		}
		return response;
	}

	/** A read-only lookup: not part of the recorded command evidence, but a refusal still fails the scenario. */
	async lookup(type: string): Promise<PrimeRpcResponseV0> {
		const response = await this.client.request({ type });
		if (!response.success) throw new PrimeProbeFailureV0(`${type} was refused`);
		return response;
	}

	/**
	 * Prompt one scenario turn and wait for its agent_end. Optionally abort when a trigger first matches. Returns whether
	 * Prime admitted the prompt; a refusal is accepted only with the expected category. `streamingBehavior` is the only
	 * RPC prompt option that also resumes a suspended queue.
	 */
	async prompt(
		marker: string,
		options: { abortOn?: Trigger; streamingBehavior?: "followUp"; expectRefusal?: PrimeCommandErrorKindV0 } = {},
	): Promise<boolean> {
		this.#abortOn = options.abortOn;
		const ended = new Promise<void>((resolve) => {
			this.#agentEnd = resolve;
		});
		const response = await this.command(
			{
				type: "prompt",
				message: `SCENARIO:${marker} ${SENTINELS.prompt}`,
				...(options.streamingBehavior === undefined ? {} : { streamingBehavior: options.streamingBehavior }),
			},
			options.expectRefusal === undefined ? {} : { expectRefusal: options.expectRefusal },
		);
		if (!response.success) {
			this.#abortOn = undefined;
			this.#agentEnd = undefined;
			return false;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				ended,
				new Promise<void>((_, reject) => {
					timer = setTimeout(() => reject(new PrimeProbeFailureV0(`prompt ${marker} did not end`)), 60_000);
				}),
			]);
		} finally {
			// A pending timer would keep the probe process alive after the last scenario.
			clearTimeout(timer);
			this.#agentEnd = undefined;
		}
		return true;
	}

	async stats(label: string): Promise<void> {
		this.#run.stats.push(decodePrimeStatsV0(label, await this.command({ type: "get_session_stats" })));
	}

	/** The current session file path, used in memory only to read the durable entries. */
	async sessionFile(): Promise<string> {
		const state = decodePrimeStateV0(await this.lookup("get_state"));
		this.#run.stateKeys = state.keys;
		return confinedSessionFileV0(state.sessionFile, this.#sessionDir);
	}

	/**
	 * Close once; the client's protocol errors are recorded after its stdout has drained. Prime exits 0 when its RPC
	 * input ends; any other exit (a crash during shutdown, a kill after the close timeout, a signal) fails the scenario.
	 */
	close(): Promise<void> {
		this.#closed ??= (async () => {
			const exit = await this.client.close();
			this.#run.protocolErrors.push(...this.client.protocolErrors);
			const abnormal = abnormalExitV0(exit);
			if (abnormal !== undefined) this.#run.failures.push(abnormal);
			// An inherited stdout held open past the grace period: later records would be lost, so evidence is incomplete.
			if (this.client.drainTimedOut)
				this.#run.failures.push("Prime RPC stdout did not close after the process exited");
		})();
		return this.#closed;
	}
}

/**
 * Decode a session file as fatal UTF-8: a lenient read would turn malformed bytes into U+FFFD, inventing identities the
 * durable file never held.
 */
export function readPrimeSessionFileV0(path: string, sessionDir: string): PrimeSessionEntryEvidenceV0[] {
	// Confined again at the read itself, and opened without following a final symlink: Prime could replace the file
	// between the earlier check and this read (e.g. at shutdown) with a link to a session outside the isolation.
	const confined = confinedSessionFileV0(path, sessionDir);
	let fd: number;
	try {
		fd = openSync(confined, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		throw new PrimeProbeFailureV0("the session file could not be opened inside the isolated session directory");
	}
	let bytes: Buffer;
	try {
		bytes = readFileSync(fd);
	} finally {
		closeSync(fd);
	}
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new PrimeDecodeError("session file is not valid UTF-8");
	}
	return decodePrimeSessionFileV0(content);
}

function sameFile(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

interface ScenarioContext {
	readonly environment: PrimeEnvironmentV0;
	readonly fake: FakeProviderV0;
	readonly run: ScenarioRecorder;
	open(): ProbeSession;
}

interface ScenarioDefinition {
	readonly name: string;
	readonly description: string;
	/** Prompt markers this scenario sends; the fake provider refuses any other scripted request. */
	readonly markers: readonly string[];
	execute(context: ScenarioContext): Promise<void>;
}

const assistantStarted: Trigger = (type, event) =>
	type === "message_start" && (event.message as { role?: unknown } | undefined)?.role === "assistant";
const toolStarted: Trigger = (type) => type === "tool_execution_start";

/** Write a crafted durable session: one assistant reply with an RLM child usage attribution folded into it. */
function writeChildUsageSession(environment: PrimeEnvironmentV0): string {
	const id = "01a0e89c-0000-7000-8000-00000000c41d";
	const { parent, child, aggregate } = CHILD_USAGE_SEED;
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

/** One prompt, the stats after it, and the durable entries: the shape of every single-run scenario. */
function singleRun(marker: string, options: { abortOn?: Trigger; autoRetryOff?: boolean } = {}) {
	return async ({ environment, open, run }: ScenarioContext): Promise<void> => {
		const session = open();
		if (options.autoRetryOff === true) await session.command({ type: "set_auto_retry", enabled: false });
		await session.prompt(marker, options.abortOn === undefined ? {} : { abortOn: options.abortOn });
		await session.stats("after");
		// The durable file is read after the process exits, so anything Prime persists at shutdown is evidence too.
		const file = await session.sessionFile();
		await session.close();
		run.sessionEntries = readPrimeSessionFileV0(file, environment.sessionDir);
	};
}

export const SCENARIOS: readonly ScenarioDefinition[] = [
	{
		name: "simple",
		description: "One prompt, one assistant completion with known usage.",
		markers: ["simple"],
		execute: singleRun("simple"),
	},
	{
		name: "tool-run",
		description: "Assistant tool call, successful tool execution, second assistant completion.",
		markers: ["tool-run"],
		execute: singleRun("tool-run"),
	},
	{
		name: "tool-error",
		description: "The tool throws; the model recovers with a final answer.",
		markers: ["tool-error"],
		execute: singleRun("tool-error"),
	},
	{
		name: "provider-failure",
		description: "The provider rejects the request with a non-retryable error.",
		markers: ["provider-failure"],
		execute: singleRun("provider-failure", { autoRetryOff: true }),
	},
	{
		name: "abort-stream",
		description: "RPC abort while the assistant response is streaming.",
		markers: ["abort-stream", "multi-a", "multi-b"],
		async execute({ environment, open, run }) {
			const session = open();
			await session.prompt("abort-stream", { abortOn: assistantStarted });
			await session.stats("after");
			// An RPC abort suspends Prime's input queue; a plain prompt is refused (with that category only) until a
			// prompt that may queue resumes it.
			run.observations.plainPromptAfterAbortAdmitted = await session.prompt("multi-a", {
				expectRefusal: "queued-input-suspended",
			});
			run.observations.followUpAfterAbortAdmitted = await session.prompt("multi-b", {
				streamingBehavior: "followUp",
			});
			await session.stats("after-resume");
			const finalFile = await session.sessionFile();
			await session.close();
			run.sessionEntries = readPrimeSessionFileV0(finalFile, environment.sessionDir);
		},
	},
	{
		name: "abort-tool",
		description: "RPC abort while a tool is executing.",
		markers: ["abort-tool"],
		execute: singleRun("abort-tool", { abortOn: toolStarted }),
	},
	{
		name: "length-stop",
		description: "The assistant stops on the output-length limit.",
		markers: ["length"],
		execute: singleRun("length"),
	},
	{
		name: "reasoning-usage",
		description: "The provider reports reasoning tokens and reasoning content.",
		markers: ["reasoning"],
		execute: singleRun("reasoning"),
	},
	{
		name: "multi-turn-reopen",
		description: "Three prompts with known usage, then the process exits and a new process reopens the session file.",
		markers: ["multi-a", "multi-b", "multi-c"],
		async execute({ environment, open, run }) {
			const first = open();
			for (const marker of ["multi-a", "multi-b", "multi-c"]) {
				await first.prompt(marker);
				await first.stats(`after-${marker}`);
			}
			const path = await first.sessionFile();
			await first.close();
			const before = readPrimeSessionFileV0(path, environment.sessionDir);
			const second = open();
			requirePrimeNotCancelledV0(await second.command({ type: "switch_session", sessionPath: path }));
			await second.stats("after-reopen");
			run.observations.messagesAfterReopen = decodePrimeMessageCountV0(
				await second.command({ type: "get_messages" }),
			);
			const reopenedFile = await second.sessionFile();
			run.observations.reopenedIntendedSession = sameFile(reopenedFile, path);
			await second.close();
			const after = readPrimeSessionFileV0(reopenedFile, environment.sessionDir);
			run.observations.entryIdsStableAcrossReopen =
				JSON.stringify(before.map((entry) => entry.id)) ===
				JSON.stringify(after.slice(0, before.length).map((entry) => entry.id));
			run.sessionEntries = after;
		},
	},
	{
		name: "compaction",
		description: "Two prompts, then a manual compaction whose summary also reports usage.",
		markers: ["multi-a", "multi-b", "multi-c"],
		async execute({ environment, fake, open, run }) {
			const session = open();
			await session.prompt("multi-a");
			await session.prompt("multi-b");
			await session.stats("before-compaction");
			const file = await session.sessionFile();
			run.entrySnapshots.push({
				label: "before-compaction",
				entries: readPrimeSessionFileV0(file, environment.sessionDir),
			});
			// Summarization requests are expected only while the compaction runs.
			fake.allowSummaries(true);
			try {
				run.observations.compactFirstKeptEntryId = decodePrimeCompactionResultV0(
					await session.command({ type: "compact" }),
				).firstKeptEntryId;
			} finally {
				fake.allowSummaries(false);
			}
			await session.stats("after-compaction");
			// Snapshot before any later prompt adds rows, so retention is judged on the compaction alone.
			run.entrySnapshots.push({
				label: "after-compaction",
				entries: readPrimeSessionFileV0(file, environment.sessionDir),
			});
			// Manual compaction aborts first (compact -> abort -> requestAbort), which suspends the input queue. Record the
			// plain refusal (queued-input category only), then resume with a prompt that may queue.
			run.observations.plainPromptAfterCompactionAdmitted = await session.prompt("multi-c", {
				expectRefusal: "queued-input-suspended",
			});
			run.observations.followUpAfterCompactionAdmitted = await session.prompt("multi-c", {
				streamingBehavior: "followUp",
			});
			await session.stats("after-next-prompt");
			const finalFile = await session.sessionFile();
			await session.close();
			run.sessionEntries = readPrimeSessionFileV0(finalFile, environment.sessionDir);
		},
	},
	{
		name: "fork",
		description: "Two prompts, then a fork from the second user message, then one more prompt on the fork.",
		markers: ["multi-a", "multi-b", "multi-c"],
		async execute({ environment, open, run }) {
			const session = open();
			await session.prompt("multi-a");
			await session.prompt("multi-b");
			await session.stats("before-fork");
			const originalFile = await session.sessionFile();
			const beforeFork = readPrimeSessionFileV0(originalFile, environment.sessionDir);
			run.entrySnapshots.push({ label: "fork-original-before", entries: beforeFork });
			// The fork is the operation under test: no target, a cancelled fork or no new session fails the scenario. The
			// target is the second user message, identified in the file, never by its position in Prime's list.
			const target = beforeFork.findLast((entry) => entry.type === "message" && entry.role === "user")?.id;
			const targets = decodePrimeForkTargetsV0(await session.lookup("get_fork_messages"));
			run.observations.forkTargets = targets.length;
			if (target === undefined || !targets.includes(target))
				throw new Error("get_fork_messages does not offer the latest user message");
			requirePrimeNotCancelledV0(await session.command({ type: "fork", entryId: target }));
			await session.stats("after-fork");
			const forkFile = await session.sessionFile();
			run.observations.forkCreatedNewFile = !sameFile(forkFile, originalFile);
			await session.prompt("multi-c");
			await session.stats("after-fork-prompt");
			await session.close();
			run.sessionEntries = readPrimeSessionFileV0(forkFile, environment.sessionDir);
			const original = readPrimeSessionFileV0(originalFile, environment.sessionDir);
			run.entrySnapshots.push({ label: "fork-original-after", entries: original });
			run.observations.originalEntriesAfterFork = original.length;
			const originalIds = new Set(original.flatMap((entry) => (entry.type === "session" ? [] : [entry.id])));
			const shared = run.sessionEntries.filter((entry) => entry.type !== "session" && originalIds.has(entry.id));
			run.observations.forkSharedEntryIds = shared.length;
			// Treating shared ids as copies (and de-duplicating by id) is only safe if the entries are identical.
			const originalById = new Map(original.map((entry) => [entry.id, JSON.stringify(entry)]));
			run.observations.forkSharedEntriesIdentical = shared.every(
				(entry) => originalById.get(entry.id) === JSON.stringify(entry),
			);
		},
	},
	{
		name: "child-usage-replay",
		description:
			"A crafted durable session holding one child_usage_attributed entry, reopened by a real Prime process (no live RLM child).",
		markers: [],
		async execute({ environment, open, run }) {
			const path = writeChildUsageSession(environment);
			const session = open();
			requirePrimeNotCancelledV0(await session.command({ type: "switch_session", sessionPath: path }));
			await session.stats("after-open");
			await session.close();
			run.sessionEntries = readPrimeSessionFileV0(path, environment.sessionDir);
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

/** Run the scenarios, each in its own isolated environment, Prime process tree and fake provider. */
export async function runPrimeProbeV0(options: PrimeProbeOptionsV0): Promise<PrimeScenarioEvidenceV0[]> {
	const results: PrimeScenarioEvidenceV0[] = [];
	for (const scenario of SCENARIOS) {
		if (options.only !== undefined && !options.only.includes(scenario.name)) continue;
		options.log?.(`scenario ${scenario.name}`);
		const fake = await startFakeProviderV0({ markers: scenario.markers, model: PROBE_MODEL });
		const environment = createPrimeEnvironmentV0({ providerBaseUrl: fake.baseUrl, retain: options.retain });
		const run: ScenarioRecorder = {
			events: [],
			abortRequestedAfter: [],
			commands: [],
			stats: [],
			sessionEntries: [],
			entrySnapshots: [],
			stateKeys: [],
			observations: {},
			protocolErrors: [],
			failures: [],
		};
		const sessions: ProbeSession[] = [];
		try {
			await scenario.execute({
				environment,
				fake,
				run,
				open: () => {
					const session = new ProbeSession(options.binary, environment, run);
					sessions.push(session);
					return session;
				},
			});
		} catch (error) {
			run.failures.push(failureTextV0(error));
		} finally {
			// Close every session through the same path, so protocol errors are recorded even after a failure.
			for (const session of sessions) await session.close();
			environment.dispose(options.binary);
			await fake.close();
		}
		run.observations.providerRequests = fake.requests.length;
		run.observations.summaryRequests = fake.requests.filter((request) => request.kind === "summary").length;
		for (const request of fake.requests) {
			if (request.kind === "malformed") run.failures.push("provider received a malformed request");
			if (request.kind === "unexpected")
				run.failures.push(`provider received an unexpected request (${request.reason})`);
		}
		const evidence: PrimeScenarioEvidenceV0 = {
			provenance: { ...options.provenance, scenario: scenario.name },
			description: scenario.description,
			...run,
		};
		const violated = scenarioInvariantProblemsV0(evidence);
		results.push(violated.length === 0 ? evidence : { ...evidence, failures: [...run.failures, ...violated] });
	}
	return results;
}

/**
 * SHA-256 over the git-ignored build output the source launcher loads: every file under packages/<name>/dist, by
 * relative path and content, in a stable order. Undefined when there is none, or when any entry is a symlink: its
 * target is not hashed, so the build it loads is unverifiable.
 */
export function hashBuildOutputV0(checkout: string): string | undefined {
	const hash = createHash("sha256");
	let files = 0;
	let symlinks = 0;
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(directory, entry.name);
			// Node follows a symlink to code this walk would not hash, so any link makes the build output unverifiable.
			if (entry.isSymbolicLink()) symlinks++;
			else if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) {
				hash.update(relative(checkout, path)).update("\0").update(readFileSync(path)).update("\0");
				files++;
			}
		}
	};
	const packages = join(checkout, "packages");
	for (const name of existsSync(packages) ? readdirSync(packages).sort() : []) {
		const dist = join(packages, name, "dist");
		if (existsSync(dist)) walk(dist);
	}
	return files === 0 || symlinks > 0 ? undefined : hash.digest("hex");
}

function git(checkout: string, args: readonly string[]): string {
	return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
}

/** Identify the Prime under test: its reported version and how its build is known. */
export function describePrimeV0(binary: PrimeBinaryV0): PrimeProvenanceV0 {
	// Even --version runs in a disposable environment, so no user state is touched.
	const environment = createPrimeEnvironmentV0({ providerBaseUrl: "http://127.0.0.1:9/v1" });
	let version = "unknown";
	try {
		// Prime prints its version on stderr in some modes; accept either stream, but only from a successful run.
		const result = spawnSync(binary.command, [...binary.leadingArgs, "--version"], {
			cwd: environment.cwd,
			env: environment.env,
			encoding: "utf8",
			timeout: 60_000,
		});
		// Semver only (with an optional pre-release or build suffix): the version names a fixture directory, so it must
		// never carry a path separator.
		if (result.status === 0)
			version =
				/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*(?![^\s])/.exec(`${result.stdout} ${result.stderr}`)?.[0] ?? "unknown";
	} finally {
		environment.dispose(binary);
	}
	let build: PrimeBuildProvenanceV0 = binary.checkout === undefined ? "binary" : "unverified-checkout";
	let artifactsHash: string | undefined;
	let commit: string | undefined;
	if (binary.checkout !== undefined) {
		try {
			const head = git(binary.checkout, ["rev-parse", "HEAD"]);
			// Modified tracked files mean the source is not HEAD. The launcher also loads git-ignored build output
			// (packages/*/dist), which a clean tracked tree says nothing about: it is hashed below, so a different build
			// is runtime drift, and a checkout without that hash is not verified provenance. Whether that output was built
			// from HEAD cannot be proved here.
			const dirty = git(binary.checkout, ["status", "--porcelain", "--untracked-files=no"]).length > 0;
			commit = head;
			artifactsHash = hashBuildOutputV0(binary.checkout);
			build = dirty ? "dirty-checkout" : "clean-checkout";
		} catch {
			// Neither the commit nor cleanliness is known: stays unverified-checkout, with no commit.
		}
	}
	return {
		source: "prime-agent",
		version,
		...(commit === undefined ? {} : { commit }),
		...(artifactsHash === undefined ? {} : { artifactsHash }),
		build,
		mode: "rpc",
		generatedBy: PROBE_NAME,
		probeVersion: PROBE_VERSION,
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
	};
}
