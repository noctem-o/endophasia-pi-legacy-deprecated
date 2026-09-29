// Prime RPC Runtime Ingress v0: owns one `prime-agent --mode rpc` child process and its JSONL protocol. It correlates
// command responses, delivers native events in order, and shuts the process down within a bounded time. It interprets
// no event: Prime's vocabulary stays raw here, for a Prime-specific semantic adapter above it to validate and map.
// Node-side and Prime-specific; never part of the browser-facing contract surface.
import { encodePrimeJsonlRecordV0, PrimeJsonlDecoderV0, type PrimeJsonlFaultV0 } from "./jsonl.ts";
import { PrimeProcessGroupV0 } from "./process-group.ts";
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
	/**
	 * "sent" as the command is written to Prime's stdin, in write order. "undelivered" later, for a command already
	 * announced as sent whose write then failed (e.g. EPIPE): Prime never received it.
	 */
	readonly status: "sent" | "undelivered";
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
const MAX_UNSENT_IDS = 1024;
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

	readonly #group: PrimeProcessGroupV0;
	readonly #decoder: PrimeJsonlDecoderV0;
	readonly #pending = new Map<string, Pending>();
	readonly #events = new Set<(event: PrimeRpcEventV0) => void>();
	readonly #commands = new Set<(command: PrimeRpcSentCommandV0) => void>();
	/** Command notices not yet delivered to every observer, in write order (see #announce). */
	readonly #notices: PrimeRpcSentCommandV0[] = [];
	#announcing = false;
	readonly #options: PrimeRpcConnectionOptionsV0;
	#nextId = 0;
	/**
	 * Reserved IDs that were never sent and could not be handed back because a re-entrant request reserved a later one
	 * meanwhile. Only that rare case adds to it, and it is capped; see #release.
	 */
	readonly #unsent = new Set<number>();
	#exit: PrimeRpcExitV0 | undefined;
	#stdinFailed = false;
	#stdoutOpen = true;
	#closing: Promise<PrimeRpcTerminationV0> | undefined;
	/** When the process group is due SIGKILL, once SIGTERM was sent to it. */
	#sigkillAt: number | undefined;
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
		// Once stdout is drained (or abandoned), every response that will ever arrive has been decoded: requests still
		// waiting then fail with the exit.
		this.#reaped = this.terminated.then(({ exit }) => {
			for (const [id, pending] of this.#pending) {
				clearTimeout(pending.timer);
				this.#pending.delete(id);
				pending.reject(new PrimeRpcExitErrorV0(pending.command, exit));
			}
			return this.#reapGroup();
		});
		const { installation } = options;
		// Prime runs in a process group this connection owns (see process-group.ts), so a bounded shutdown also reaches
		// its descendants and never signals a recycled group ID. Exactly the given environment: never process.env,
		// which may hold provider keys. stderr is not read: it may quote payloads, and an unread pipe could block Prime.
		this.#group = new PrimeProcessGroupV0(
			installation.command,
			[...installation.leadingArgs, "--mode", "rpc", ...(options.args ?? [])],
			{ cwd: options.cwd, env: options.env, stderr: "ignore" },
		);
		const { stdout, stdin } = this.#group;
		stdout?.on("data", (chunk: Buffer) => this.#receive(this.#decoder.push(chunk)));
		stdout?.on("end", () => this.#receive(this.#decoder.end()));
		stdout?.on("close", () => {
			this.#stdoutOpen = false;
			this.#maybeTerminated();
		});
		// A write to a closed stdin fails with EPIPE. After exit the pending requests are already rejected; while Prime
		// still runs, nothing can be sent any more, so waiting requests fail now instead of at their timeouts.
		stdin?.on("error", () => this.#onStdinFailure());
		void this.#group.exited.then((exit) => {
			// A command that never started writes nothing: stdout need not be waited for.
			if (exit.spawnFailed) this.#stdoutOpen = false;
			this.#onExit(exit);
		});
	}

	/** Prime's PID, once it started. */
	get pid(): number | undefined {
		return this.#group.pid;
	}

	/** The ID of the process group this connection owns (POSIX only). */
	get processGroupId(): number | undefined {
		return this.#group.groupId;
	}

	/** Receive every native event, in arrival order. A throwing listener is reported and does not affect others. */
	subscribe(listener: (event: PrimeRpcEventV0) => void): () => void {
		this.#events.add(listener);
		return () => {
			this.#events.delete(listener);
		};
	}

	/**
	 * Observe each command as it is written (`status: "sent"`), in write order and before any response or later event
	 * can arrive, and a later `status: "undelivered"` notice if that write fails. A throwing observer is reported and
	 * does not affect others.
	 */
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
		let record: Uint8Array;
		// Reserved before any caller hook runs: a getter or nested toJSON may itself call request() while this command
		// is copied or serialized, and must get its own ID. An ID whose command is never sent is simply skipped.
		const sequence = ++this.#nextId;
		const id = `endophasia-${sequence}`;
		// A command that is not sent gives its ID back, so only IDs Prime actually received count as issued.
		const refuse = (error: Error) => {
			this.#release(sequence);
			return Promise.reject(error);
		};
		try {
			const declared: unknown = command.type;
			if (typeof declared !== "string" || declared.length === 0) {
				return refuse(new PrimeRpcErrorV0("A Prime RPC command needs a type"));
			}
			if ("id" in command) {
				return refuse(new PrimeRpcErrorV0("Prime RPC request IDs are assigned by the connection"));
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
				return refuse(new PrimeRpcErrorV0("A Prime RPC command must not define toJSON"));
			}
			// Written as bytes, so the stdin backlog is counted in bytes, whatever the text's encoding width.
			record = Buffer.from(encodePrimeJsonlRecordV0(envelope), "utf8");
		} catch {
			return refuse(new PrimeRpcErrorV0("A Prime RPC command could not be serialized"));
		}
		const refusal = this.#refuseWrite(type, record);
		if (refusal !== undefined) return refuse(refusal);
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
	 * request: it resolves once the record was written to Prime's stdin pipe, and rejects if that write fails (e.g.
	 * EPIPE when Prime closed its input), so an undelivered answer is never reported as sent. The ID is Prime's, which is why it cannot go through
	 * request(). The record is built field by field from the three shapes Prime accepts, nothing else.
	 */
	answerExtensionUi(
		requestId: string,
		answer: { readonly value: string } | { readonly confirmed: boolean } | { readonly cancelled: true },
	): Promise<void> {
		const type = "extension_ui_response";
		let record: Uint8Array;
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
			record = Buffer.from(encodePrimeJsonlRecordV0({ type, id: requestId, [field]: value }), "utf8");
		} catch {
			return Promise.reject(new PrimeRpcErrorV0("An extension UI answer could not be serialized"));
		}
		const refusal = this.#refuseWrite(type, record);
		if (refusal !== undefined) return Promise.reject(refusal);
		return new Promise((resolve, reject) => {
			this.#write(requestId, type, record, (error) => {
				if (error === undefined) resolve();
				else reject(new PrimeRpcErrorV0(`Prime RPC input failed; ${type} was not delivered`));
			});
		});
	}

	/** Why a record cannot be written now, if it cannot: the process is gone, closing, its input failed, or backlogged. */
	#refuseWrite(type: string, record: Uint8Array): Error | undefined {
		if (this.#exit !== undefined) return new PrimeRpcExitErrorV0(type, this.#exit);
		if (this.#closing !== undefined)
			return new PrimeRpcErrorV0(`Prime RPC connection is closing; ${type} was not sent`);
		if (this.#stdinFailed) return new PrimeRpcErrorV0(`Prime RPC input failed; ${type} was not sent`);
		// Every record is written as a Buffer, so writableLength is a byte count.
		const backlog = this.#group.stdin?.writableLength ?? 0;
		const maxBacklog = this.#options.maxInputBacklogBytes ?? DEFAULT_MAX_INPUT_BACKLOG_BYTES;
		if (backlog + record.length > maxBacklog) {
			return new PrimeRpcErrorV0(`Prime RPC input backlog is full; ${type} was not sent`);
		}
		return undefined;
	}

	/** The only stdin write: every record is announced to command observers synchronously as it is written. */
	#write(id: string, type: string, record: Uint8Array, written?: (error: Error | undefined) => void): void {
		const stdin = this.#group.stdin;
		if (stdin === null) {
			written?.(new Error("no stdin"));
			return;
		}
		stdin.write(record, (error) => {
			if (error !== undefined && error !== null) this.#announce({ id, type, status: "undelivered" });
			written?.(error ?? undefined);
		});
		this.#announce({ id, type, status: "sent" });
	}

	/**
	 * Deliver a command notice to every observer, in write order. An observer may itself write a command (call
	 * request()); that command's notice is queued and delivered once the current notice reached every observer, so no
	 * observer sees a later write before an earlier one.
	 */
	#announce(notice: PrimeRpcSentCommandV0): void {
		this.#notices.push(notice);
		if (this.#announcing) return;
		this.#announcing = true;
		try {
			for (let next = this.#notices.shift(); next !== undefined; next = this.#notices.shift()) {
				this.#notify(this.#commands, next, "command");
			}
		} finally {
			this.#announcing = false;
		}
	}

	/**
	 * End Prime's input and wait until it exited and stdout drained. Bounded: after closeTimeoutMs the process group is
	 * sent SIGTERM, then SIGKILL; a stdout held open after exit is abandoned after the drain grace. Idempotent: every
	 * call returns the same termination. Safe after the process already exited: it still waits for the drain.
	 */
	close(): Promise<PrimeRpcTerminationV0> {
		this.#closing ??= (async () => {
			this.#group.stdin?.end();
			const timeoutMs = this.#options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
			let escalation: ReturnType<typeof setTimeout> | undefined;
			if (this.#exit === undefined) {
				escalation = setTimeout(() => {
					if (this.#exit !== undefined) return;
					this.#diagnose({ kind: "forced-termination", signal: "SIGTERM" });
					this.#group.signalGroup("SIGTERM");
					this.#sigkillAt = Date.now() + TERMINATE_GRACE_MS;
					escalation = setTimeout(() => {
						if (this.#exit !== undefined) return;
						this.#diagnose({ kind: "forced-termination", signal: "SIGKILL" });
						// Directly on the owned group, not through the keeper, which may itself be stuck.
						this.#group.killGroup();
					}, TERMINATE_GRACE_MS);
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
	 * group already did) and SIGKILL when the grace expires; the group is then released, which SIGKILLs anything left.
	 * Where members cannot be observed (no /proc), the group is released at once.
	 */
	async #reapGroup(): Promise<void> {
		if (this.#group.liveMembers() === true) {
			if (this.#sigkillAt === undefined) {
				this.#diagnose({ kind: "forced-termination", signal: "SIGTERM" });
				this.#group.signalGroup("SIGTERM");
				this.#sigkillAt = Date.now() + TERMINATE_GRACE_MS;
			}
			while (this.#group.liveMembers() === true && Date.now() < this.#sigkillAt) {
				await new Promise((done) => setTimeout(done, 25));
			}
			if (this.#group.liveMembers() === true) this.#diagnose({ kind: "forced-termination", signal: "SIGKILL" });
		}
		await this.#group.release();
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

	#onExit(exit: PrimeRpcExitV0): void {
		if (this.#exit !== undefined) return;
		this.#exit = exit;
		// Pending requests are not failed yet: the exit report can arrive before stdout is drained, and a response Prime
		// wrote just before exiting (e.g. to shutdown) must still settle its request. They fail at termination.
		this.#resolveExited(exit);
		if (this.#stdoutOpen) {
			// A descendant that inherited stdout could hold it open forever: the drain is bounded, then abandoned.
			setTimeout(() => {
				if (!this.#stdoutOpen) return;
				this.#diagnose({ kind: "stdout-drain-timeout" });
				void this.#group.release();
				this.#group.stdout?.removeAllListeners("data");
				this.#group.stdout?.destroy();
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
		if (match === null) return false;
		const sequence = Number(match[1]);
		return sequence <= this.#nextId && !this.#unsent.has(sequence);
	}

	/**
	 * Give back a reserved ID whose command was not sent. The latest reservation is simply undone; an earlier one (a
	 * re-entrant request reserved after it) is remembered as unsent, so a response carrying it is classified unknown.
	 * That set only grows through re-entrant failures and is capped: past the cap the oldest entries are dropped, and a
	 * forged response for one of those IDs would be reported as stale instead of unknown.
	 */
	#release(sequence: number): void {
		if (sequence === this.#nextId) {
			this.#nextId--;
			while (this.#unsent.delete(this.#nextId)) this.#nextId--;
			return;
		}
		this.#unsent.add(sequence);
		if (this.#unsent.size > MAX_UNSENT_IDS) this.#unsent.delete(this.#unsent.values().next().value as number);
	}

	#diagnose(diagnostic: PrimeRpcDiagnosticV0): void {
		try {
			// An async sink's rejection is absorbed too, instead of becoming an unhandled rejection.
			const result: unknown = this.#options.onDiagnostic?.(diagnostic);
			if (
				result !== null &&
				typeof result === "object" &&
				typeof (result as PromiseLike<unknown>).then === "function"
			) {
				(result as PromiseLike<unknown>).then(undefined, () => {});
			}
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
				// A listener typed as returning void may still be async: a rejected promise it returns is reported like a
				// throw, instead of becoming an unhandled rejection.
				const result: unknown = deliver(value);
				if (
					result !== null &&
					typeof result === "object" &&
					typeof (result as PromiseLike<unknown>).then === "function"
				) {
					(result as PromiseLike<unknown>).then(undefined, (error: unknown) =>
						this.#diagnose({ kind: "listener-failure", listener, errorName: listenerErrorName(error) }),
					);
				}
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
