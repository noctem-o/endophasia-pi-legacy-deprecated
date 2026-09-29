// Prime RPC Runtime Ingress v0: owns one `prime-agent --mode rpc` child process and its JSONL protocol. It correlates
// command responses, delivers native events in order, and shuts the process down within a bounded time. It interprets
// no event: Prime's vocabulary stays raw here, for a Prime-specific semantic adapter above it to validate and map.
// Node-side and Prime-specific; never part of the browser-facing contract surface.
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { encodePrimeJsonlRecordV0, PrimeJsonlDecoderV0, type PrimeJsonlFaultV0 } from "./jsonl.ts";
import type { PrimeInstallationV0 } from "./runtime-identity.ts";

/** One command response, correlated to the request that caused it. `success: false` is a refusal, not an error. */
export interface PrimeRpcResponseV0 {
	readonly id: string;
	readonly command: string;
	readonly success: boolean;
	readonly data?: unknown;
	/** Prime's refusal text, present only when success is false. It may quote user content: never persist it raw. */
	readonly error?: string;
}

/** One native Prime event, uninterpreted. Its fields may carry prompts, output and tool payloads. */
export interface PrimeRpcEventV0 {
	readonly type: string;
	readonly record: Readonly<Record<string, unknown>>;
}

/** A command this connection wrote to Prime's stdin, observed synchronously as it is written. */
export interface PrimeRpcSentCommandV0 {
	/** The connection's request ID; for an `extension_ui_response`, Prime's request ID it answers. */
	readonly id: string;
	readonly type: string;
}

export type PrimeRpcProtocolFaultV0 =
	| PrimeJsonlFaultV0
	| "missing-type"
	| "malformed-response"
	| "response-without-id"
	| "unknown-response-id"
	/** An ID this connection issued whose request already settled: answered, rejected or timed out. */
	| "stale-response-id"
	| "command-mismatch";

/**
 * The name of a value a listener threw, from a fixed set: an Error's `name` is mutable and could carry payload text,
 * so only the standard constructors' names pass through.
 */
export type PrimeRpcListenerErrorNameV0 =
	| "Error"
	| "TypeError"
	| "RangeError"
	| "ReferenceError"
	| "SyntaxError"
	| "EvalError"
	| "URIError"
	| "AggregateError"
	| "other-error"
	| "non-error";

/**
 * What the connection reports besides responses and events. Structural categories only: a diagnostic never carries a
 * record's content, a thrown value, or Prime's text.
 */
export type PrimeRpcDiagnosticV0 =
	| { readonly kind: "protocol-fault"; readonly fault: PrimeRpcProtocolFaultV0; readonly byteLength?: number }
	| {
			readonly kind: "listener-failure";
			readonly listener: "event" | "command";
			readonly errorName: PrimeRpcListenerErrorNameV0;
	  }
	/** Prime's stdin failed (e.g. EPIPE while Prime is still running): no further command can be sent. */
	| { readonly kind: "stdin-failure" }
	| { readonly kind: "stdout-drain-timeout" }
	| { readonly kind: "forced-termination"; readonly signal: "SIGTERM" | "SIGKILL" };

export interface PrimeRpcExitV0 {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	/** True when the process could not be started at all. */
	readonly spawnFailed: boolean;
}

/** How the connection ended: the exit, and whether stdout was completely drained (every record was decoded). */
export interface PrimeRpcTerminationV0 {
	readonly exit: PrimeRpcExitV0;
	readonly stdoutDrained: boolean;
}

export interface PrimeRpcConnectionOptionsV0 {
	readonly installation: PrimeInstallationV0;
	/** Arguments after `--mode rpc` (provider, model, session directory...). */
	readonly args?: readonly string[];
	/** The child's complete environment: nothing is inherited from this process, so no ambient credential leaks in. */
	readonly env: Readonly<Record<string, string>>;
	readonly cwd: string;
	/** Default time a request waits for its response. Default 60 s. */
	readonly requestTimeoutMs?: number;
	/** How long stdout may stay open after the process exited (e.g. held by a descendant). Default 2 s. */
	readonly drainGraceMs?: number;
	/** How long close() waits for a voluntary exit after ending stdin, before SIGTERM and then SIGKILL. Default 10 s. */
	readonly closeTimeoutMs?: number;
	/** Largest record accepted from Prime; a longer one is skipped as `oversized-record`. Default 64 MiB. */
	readonly maxRecordBytes?: number;
	/**
	 * Most command bytes buffered for Prime's stdin while Prime reads slowly. A request that would exceed it is rejected
	 * unsent, so a stalled reader cannot grow the queue without bound. Default 16 MiB.
	 */
	readonly maxInputBacklogBytes?: number;
	readonly onDiagnostic?: (diagnostic: PrimeRpcDiagnosticV0) => void;
}

/** A failure the connection itself describes: it names commands, IDs and categories, never Prime's text. */
export class PrimeRpcErrorV0 extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrimeRpcErrorV0";
	}
}

export class PrimeRpcExitErrorV0 extends PrimeRpcErrorV0 {
	readonly exit: PrimeRpcExitV0;
	constructor(command: string, exit: PrimeRpcExitV0) {
		super(
			`Prime RPC process ${exit.spawnFailed ? "could not start" : "exited"} before responding to ${command} (code ${exit.code}, signal ${exit.signal})`,
		);
		this.name = "PrimeRpcExitErrorV0";
		this.exit = exit;
	}
}

interface Pending {
	readonly command: string;
	readonly resolve: (response: PrimeRpcResponseV0) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_DRAIN_GRACE_MS = 2_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_INPUT_BACKLOG_BYTES = 16 * 1024 * 1024;
/** After SIGTERM, how long before SIGKILL. */
const TERMINATE_GRACE_MS = 2_000;

/**
 * One Prime RPC process. The connection is the only writer to its stdin: every command goes through request(), so a
 * semantic adapter can observe the commands it sent (e.g. its own abort) in order with the events that follow.
 */
export class PrimeRpcConnectionV0 {
	/** Settles when the process exits (or fails to start), possibly before stdout is drained. */
	readonly exited: Promise<PrimeRpcExitV0>;
	/** Settles when the process exited and stdout is closed, or the bounded drain grace expired. */
	readonly terminated: Promise<PrimeRpcTerminationV0>;

	readonly #child: ChildProcess;
	readonly #decoder: PrimeJsonlDecoderV0;
	readonly #pending = new Map<string, Pending>();
	readonly #events = new Set<(event: PrimeRpcEventV0) => void>();
	readonly #commands = new Set<(command: PrimeRpcSentCommandV0) => void>();
	readonly #options: PrimeRpcConnectionOptionsV0;
	#nextId = 0;
	#exit: PrimeRpcExitV0 | undefined;
	#stdinFailed = false;
	#stdoutOpen = true;
	#closing: Promise<PrimeRpcTerminationV0> | undefined;
	/** When the process group is due SIGKILL, once SIGTERM was sent to it. */
	#sigkillAt: number | undefined;
	/**
	 * Set once the group was reaped after termination. Its ID is never probed or signalled again: once every member is
	 * gone the OS may reuse it for an unrelated group.
	 */
	#groupGone = false;
	/** Settles once the process group is reaped after termination (see #reapGroup). */
	readonly #reaped: Promise<void>;
	#resolveExited!: (exit: PrimeRpcExitV0) => void;
	#resolveTerminated!: (termination: PrimeRpcTerminationV0) => void;

	constructor(options: PrimeRpcConnectionOptionsV0) {
		this.#options = options;
		this.#decoder = new PrimeJsonlDecoderV0(
			options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes },
		);
		this.exited = new Promise((resolve) => {
			this.#resolveExited = resolve;
		});
		this.terminated = new Promise((resolve) => {
			this.#resolveTerminated = resolve;
		});
		this.#reaped = this.terminated.then(() => this.#reapGroup());
		const { installation } = options;
		this.#child = spawn(
			installation.command,
			[...installation.leadingArgs, "--mode", "rpc", ...(options.args ?? [])],
			{
				cwd: options.cwd,
				// Exactly the given environment: never process.env, which may hold provider keys.
				env: { ...options.env },
				// stderr is not read: it may quote payloads, and an unread pipe could block Prime, so it is discarded.
				stdio: ["pipe", "pipe", "ignore"],
				// Its own process group on POSIX, so a bounded shutdown can also reach descendants holding stdout.
				detached: process.platform !== "win32",
			},
		);
		const { stdout, stdin } = this.#child;
		stdout?.on("data", (chunk: Buffer) => this.#receive(this.#decoder.push(chunk)));
		stdout?.on("end", () => this.#receive(this.#decoder.end()));
		stdout?.on("close", () => {
			this.#stdoutOpen = false;
			this.#maybeTerminated();
		});
		// A write to a closed stdin fails with EPIPE. After exit the pending requests are already rejected; while Prime
		// still runs, nothing can be sent any more, so waiting requests fail now instead of at their timeouts.
		stdin?.on("error", () => this.#onStdinFailure());
		this.#child.on("exit", (code, signal) => this.#onExit({ code, signal, spawnFailed: false }));
		this.#child.on("error", () => {
			// A spawn failure emits no exit and no stdout close.
			this.#stdoutOpen = false;
			this.#onExit({ code: null, signal: null, spawnFailed: true });
		});
	}

	get pid(): number | undefined {
		return this.#child.pid;
	}

	/** Receive every native event, in arrival order. A throwing listener is reported and does not affect others. */
	subscribe(listener: (event: PrimeRpcEventV0) => void): () => void {
		this.#events.add(listener);
		return () => {
			this.#events.delete(listener);
		};
	}

	/** Observe each command synchronously as it is written, before any response or later event can arrive. */
	observeCommands(listener: (command: PrimeRpcSentCommandV0) => void): () => void {
		this.#commands.add(listener);
		return () => {
			this.#commands.delete(listener);
		};
	}

	/**
	 * Send one command and resolve with its correlated response, including a refusal (`success: false`). Rejects when
	 * the process exits first, the response echoes another command, or the timeout expires. IDs belong to the
	 * connection: a command must not carry its own.
	 */
	request(
		command: { readonly type: string } & Record<string, unknown>,
		options: { readonly timeoutMs?: number } = {},
	): Promise<PrimeRpcResponseV0> {
		// Every read of the caller's object happens inside this guard: a throwing getter or Proxy trap (on `type`, on
		// `id`, or while serializing) rejects instead of throwing. The thrown message is never quoted.
		let type: string;
		let record: string;
		const id = `endophasia-${this.#nextId + 1}`;
		try {
			const declared: unknown = command.type;
			if (typeof declared !== "string" || declared.length === 0) {
				return Promise.reject(new PrimeRpcErrorV0("A Prime RPC command needs a type"));
			}
			if ("id" in command) {
				return Promise.reject(new PrimeRpcErrorV0("Prime RPC request IDs are assigned by the connection"));
			}
			type = declared;
			// Serialized before anything is registered, so a command that cannot be encoded (a cycle, a BigInt, a
			// throwing getter) leaves no pending entry or timer behind. `type` is pinned to the value that was checked.
			// A null-prototype envelope, and no own `toJSON`: JSON.stringify would call a root `toJSON` for the whole
			// envelope, letting it replace the checked `type` and the assigned `id` with a command nobody is waiting for.
			// The other fields are copied by key, skipping `type`, so its getter is never read a second time.
			const envelope: Record<string, unknown> = Object.create(null);
			envelope.type = type;
			for (const key of Object.keys(command)) if (key !== "type") envelope[key] = command[key];
			envelope.id = id;
			if (Object.hasOwn(envelope, "toJSON")) {
				return Promise.reject(new PrimeRpcErrorV0("A Prime RPC command must not define toJSON"));
			}
			record = encodePrimeJsonlRecordV0(envelope);
		} catch {
			return Promise.reject(new PrimeRpcErrorV0("A Prime RPC command could not be serialized"));
		}
		const refusal = this.#refuseWrite(type, record);
		if (refusal !== undefined) return Promise.reject(refusal);
		this.#nextId++;
		const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const response = new Promise<PrimeRpcResponseV0>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				// A late response for this ID is then reported as stale, never delivered to anyone.
				reject(new PrimeRpcErrorV0(`Prime RPC ${type} (${id}) timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			this.#pending.set(id, { command: type, resolve, reject, timer });
		});
		this.#write(id, type, record);
		return response;
	}

	/**
	 * Answer a dialog Prime opened with `extension_ui_request` (select, confirm, input, editor). Prime blocks until an
	 * `extension_ui_response` carrying the same `id` arrives, and sends no response to it, so this is a write, not a
	 * request: it resolves once the record is handed to stdin. The ID is Prime's, which is why it cannot go through
	 * request(). The record is built field by field from the three shapes Prime accepts, nothing else.
	 */
	answerExtensionUi(
		requestId: string,
		answer: { readonly value: string } | { readonly confirmed: boolean } | { readonly cancelled: true },
	): Promise<void> {
		const type = "extension_ui_response";
		let record: string;
		try {
			if (typeof requestId !== "string" || requestId.length === 0) {
				return Promise.reject(new PrimeRpcErrorV0("An extension UI answer needs Prime's request ID"));
			}
			const fields: Record<string, unknown> =
				"cancelled" in answer
					? { cancelled: answer.cancelled }
					: "confirmed" in answer
						? { confirmed: answer.confirmed }
						: { value: answer.value };
			const [field, value] = Object.entries(fields)[0];
			const valid =
				(field === "cancelled" && value === true) ||
				(field === "confirmed" && typeof value === "boolean") ||
				(field === "value" && typeof value === "string");
			if (!valid) return Promise.reject(new PrimeRpcErrorV0("An extension UI answer is malformed"));
			record = encodePrimeJsonlRecordV0({ type, id: requestId, [field]: value });
		} catch {
			return Promise.reject(new PrimeRpcErrorV0("An extension UI answer could not be serialized"));
		}
		const refusal = this.#refuseWrite(type, record);
		if (refusal !== undefined) return Promise.reject(refusal);
		this.#write(requestId, type, record);
		return Promise.resolve();
	}

	/** Why a record cannot be written now, if it cannot: the process is gone, closing, its input failed, or backlogged. */
	#refuseWrite(type: string, record: string): Error | undefined {
		if (this.#exit !== undefined) return new PrimeRpcExitErrorV0(type, this.#exit);
		if (this.#closing !== undefined)
			return new PrimeRpcErrorV0(`Prime RPC connection is closing; ${type} was not sent`);
		if (this.#stdinFailed) return new PrimeRpcErrorV0(`Prime RPC input failed; ${type} was not sent`);
		const backlog = this.#child.stdin?.writableLength ?? 0;
		const maxBacklog = this.#options.maxInputBacklogBytes ?? DEFAULT_MAX_INPUT_BACKLOG_BYTES;
		if (backlog + Buffer.byteLength(record) > maxBacklog) {
			return new PrimeRpcErrorV0(`Prime RPC input backlog is full; ${type} was not sent`);
		}
		return undefined;
	}

	/** The only stdin write: every record is announced to command observers synchronously as it is written. */
	#write(id: string, type: string, record: string): void {
		this.#child.stdin?.write(record);
		this.#notify(this.#commands, { id, type }, "command");
	}

	/**
	 * End Prime's input and wait until it exited and stdout drained. Bounded: after closeTimeoutMs the process group is
	 * sent SIGTERM, then SIGKILL; a stdout held open after exit is abandoned after the drain grace. Idempotent: every
	 * call returns the same termination. Safe after the process already exited: it still waits for the drain.
	 */
	close(): Promise<PrimeRpcTerminationV0> {
		this.#closing ??= (async () => {
			this.#child.stdin?.end();
			const timeoutMs = this.#options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
			let escalation: ReturnType<typeof setTimeout> | undefined;
			if (this.#exit === undefined) {
				escalation = setTimeout(() => {
					if (this.#exit !== undefined) return;
					this.#diagnose({ kind: "forced-termination", signal: "SIGTERM" });
					this.#killGroup("SIGTERM");
					this.#sigkillAt = Date.now() + TERMINATE_GRACE_MS;
					escalation = setTimeout(() => this.#forceKill(), TERMINATE_GRACE_MS);
				}, timeoutMs);
			}
			try {
				await this.terminated;
			} finally {
				clearTimeout(escalation);
			}
			await this.#reaped;
			return this.terminated;
		})();
		return this.#closing;
	}

	/**
	 * The connection owns Prime's whole process group. Once Prime exited and stdout drained (whether or not close() was
	 * called), any member still running, such as a descendant that does not hold stdout, gets SIGTERM (unless the
	 * group already did) and SIGKILL when the grace expires. This runs right at termination, while a live member still
	 * holds the group ID, never later against an ID the OS may have reused. The group is then marked gone.
	 */
	async #reapGroup(): Promise<void> {
		if (this.#groupAlive()) {
			if (this.#sigkillAt === undefined) {
				this.#diagnose({ kind: "forced-termination", signal: "SIGTERM" });
				this.#killGroup("SIGTERM");
				this.#sigkillAt = Date.now() + TERMINATE_GRACE_MS;
			}
			while (this.#groupAlive() && Date.now() < this.#sigkillAt) {
				await new Promise((done) => setTimeout(done, 25));
			}
			this.#forceKill();
		}
		this.#groupGone = true;
	}

	#forceKill(): void {
		if (!this.#groupAlive()) return;
		this.#diagnose({ kind: "forced-termination", signal: "SIGKILL" });
		this.#killGroup("SIGKILL");
	}

	/** Whether any process of Prime's group remains. On Windows there is no group: only Prime itself is tracked. */
	#groupAlive(): boolean {
		const pid = this.#child.pid;
		if (pid === undefined || this.#groupGone) return false;
		if (process.platform === "win32") return this.#exit === undefined;
		try {
			process.kill(-pid, 0);
		} catch {
			return false;
		}
		// A killed descendant whose parent already exited stays a zombie until init reaps it, and a container's PID 1
		// may never do so; kill(-pgid, 0) still counts zombies. Where /proc exists, only a live member counts.
		return liveGroupMember(pid) ?? true;
	}

	#onStdinFailure(): void {
		if (this.#stdinFailed || this.#exit !== undefined) return;
		this.#stdinFailed = true;
		this.#diagnose({ kind: "stdin-failure" });
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			this.#pending.delete(id);
			pending.reject(new PrimeRpcErrorV0(`Prime RPC input failed before responding to ${pending.command}`));
		}
	}

	#killGroup(signal: "SIGTERM" | "SIGKILL"): void {
		const pid = this.#child.pid;
		if (pid === undefined || this.#groupGone) return;
		try {
			if (process.platform === "win32") this.#child.kill(signal);
			else process.kill(-pid, signal);
		} catch {
			// The group is already gone.
		}
	}

	#onExit(exit: PrimeRpcExitV0): void {
		if (this.#exit !== undefined) return;
		this.#exit = exit;
		// Pending requests fail as soon as the process is gone; stdout may still deliver trailing records.
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			this.#pending.delete(id);
			pending.reject(new PrimeRpcExitErrorV0(pending.command, exit));
		}
		this.#resolveExited(exit);
		if (this.#stdoutOpen) {
			// A descendant that inherited stdout could hold it open forever: the drain is bounded, then abandoned.
			setTimeout(() => {
				if (!this.#stdoutOpen) return;
				this.#diagnose({ kind: "stdout-drain-timeout" });
				this.#killGroup("SIGKILL");
				this.#child.stdout?.removeAllListeners("data");
				this.#child.stdout?.destroy();
				this.#resolveTerminated({ exit, stdoutDrained: false });
			}, this.#options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS).unref();
		}
		this.#maybeTerminated();
	}

	#maybeTerminated(): void {
		if (this.#exit !== undefined && !this.#stdoutOpen)
			this.#resolveTerminated({ exit: this.#exit, stdoutDrained: true });
	}

	#receive(records: readonly ReturnType<PrimeJsonlDecoderV0["push"]>[number][]): void {
		for (const record of records) {
			if (record.kind === "fault") {
				this.#fault(record.fault, record.byteLength);
				continue;
			}
			const { value } = record;
			if (typeof value.type !== "string" || value.type.length === 0) {
				this.#fault("missing-type");
				continue;
			}
			if (value.type === "response") {
				this.#response(value);
				continue;
			}
			this.#notify(this.#events, { type: value.type, record: value }, "event");
		}
	}

	#response(value: Record<string, unknown>): void {
		const { id, command, success, data, error } = value;
		if (
			typeof command !== "string" ||
			command.length === 0 ||
			typeof success !== "boolean" ||
			(id !== undefined && (typeof id !== "string" || id.length === 0)) ||
			(error !== undefined && typeof error !== "string") ||
			// `error` is present exactly on a refusal: a success carrying one is not a response this contract admits.
			(success === false) !== (error !== undefined)
		) {
			this.#fault("malformed-response");
			return;
		}
		// Prime answers a command it could not parse without an ID: nothing is waiting for it by ID.
		if (id === undefined) {
			this.#fault("response-without-id");
			return;
		}
		const pending = this.#pending.get(id);
		if (pending === undefined) {
			this.#fault(this.#issued(id) ? "stale-response-id" : "unknown-response-id");
			return;
		}
		clearTimeout(pending.timer);
		this.#pending.delete(id);
		// The right ID with another command's response would hand the caller a different data shape.
		if (command !== pending.command) {
			this.#fault("command-mismatch");
			pending.reject(new PrimeRpcErrorV0(`Prime RPC response ${id} does not echo ${pending.command}`));
			return;
		}
		pending.resolve({
			id,
			command,
			success,
			...(data === undefined ? {} : { data }),
			...(typeof error === "string" ? { error } : {}),
		});
	}

	/** IDs are sequential, so whether this connection issued an ID needs no per-request history. */
	#issued(id: string): boolean {
		const match = /^endophasia-([1-9][0-9]*)$/.exec(id);
		return match !== null && Number(match[1]) <= this.#nextId;
	}

	#diagnose(diagnostic: PrimeRpcDiagnosticV0): void {
		try {
			this.#options.onDiagnostic?.(diagnostic);
		} catch {
			// A failing diagnostic sink must not break record processing; there is nowhere further to report it.
		}
	}

	#fault(fault: PrimeRpcProtocolFaultV0, byteLength?: number): void {
		this.#diagnose({
			kind: "protocol-fault",
			fault,
			...(byteLength === undefined ? {} : { byteLength }),
		});
	}

	#notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T, listener: "event" | "command"): void {
		for (const deliver of [...listeners]) {
			// A listener removed while this value is being delivered does not receive it.
			if (!listeners.has(deliver)) continue;
			try {
				deliver(value);
			} catch (error) {
				// Isolation: later listeners and later records are unaffected. Only a standard error name is reported.
				this.#diagnose({ kind: "listener-failure", listener, errorName: listenerErrorName(error) });
			}
		}
	}
}

const STANDARD_ERROR_NAMES: ReadonlySet<string> = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"EvalError",
	"URIError",
	"AggregateError",
]);

function listenerErrorName(error: unknown): PrimeRpcListenerErrorNameV0 {
	try {
		// `instanceof` can throw too (a Proxy's getPrototypeOf trap), and `name` is mutable or a throwing getter: every
		// read is guarded, and only a standard name is passed through.
		if (!(error instanceof Error)) return "non-error";
		const name: unknown = error.name;
		return typeof name === "string" && STANDARD_ERROR_NAMES.has(name)
			? (name as PrimeRpcListenerErrorNameV0)
			: "other-error";
	} catch {
		return "other-error";
	}
}

/**
 * Whether process group `pgid` has a member that is not a zombie, from /proc (Linux). Undefined when /proc cannot be
 * read, so the caller falls back to kill(-pgid, 0). A /proc/<pid>/stat line is "pid (comm) state ppid pgrp ...", where
 * comm may itself contain spaces and parentheses, so the fields are read after the last ")".
 */
function liveGroupMember(pgid: number): boolean | undefined {
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!/^[0-9]+$/.test(entry)) continue;
		let stat: string;
		try {
			stat = readFileSync(`/proc/${entry}/stat`, "utf8");
		} catch {
			continue; // The process ended while the directory was read.
		}
		const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (Number(group) === pgid && state !== "Z" && state !== "X") return true;
	}
	return false;
}
