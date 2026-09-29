// Research-only (Prime Runtime Conformance v0). A minimal client for `prime-agent --mode rpc` over a process boundary:
// just enough to drive the conformance scenarios. It is not a Prime SDK and not an Endophasia runtime adapter.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { encodeJsonlRecordV0, JsonlDecoderV0 } from "./jsonl.ts";
import { classifyPrimeRecordV0, type PrimeRpcResponseV0 } from "./protocol.ts";

export interface PrimeRpcClientOptionsV0 {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	/** Every non-response record, in arrival order. Raw Prime events: sanitize before keeping anything. */
	readonly onEvent?: (type: string, event: Record<string, unknown>) => void;
}

export interface PrimeRpcExitV0 {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

/** An RPC failure described by the client itself (never Prime's text), so its message is safe to keep. */
export class PrimeRpcError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrimeRpcError";
	}
}

export class PrimeRpcExitError extends PrimeRpcError {
	readonly exit: PrimeRpcExitV0;
	constructor(command: string, exit: PrimeRpcExitV0) {
		super(`Prime RPC process exited before responding to ${command} (code ${exit.code}, signal ${exit.signal})`);
		this.name = "PrimeRpcExitError";
		this.exit = exit;
	}
}

interface Pending {
	readonly command: string;
	resolve(response: PrimeRpcResponseV0): void;
	reject(error: Error): void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** How long `exited` waits after process exit for stdout to finish draining. */
const STDOUT_DRAIN_GRACE_MS = 2_000;

export class PrimeRpcClientV0 {
	/** Protocol violations observed: malformed records, responses without or with unknown/duplicate ids. */
	readonly protocolErrors: string[] = [];
	/** Settles once the process has exited and its stdout has drained (bounded): every record has been decoded. */
	readonly exited: Promise<PrimeRpcExitV0>;
	/** Settles as soon as the process exits, before stdout necessarily drained. */
	readonly exitObserved: Promise<PrimeRpcExitV0>;
	#observeExit: (exit: PrimeRpcExitV0) => void = () => {};
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #decoder = new JsonlDecoderV0();
	readonly #pending = new Map<string, Pending>();
	readonly #settledIds = new Set<string>();
	readonly #onEvent: PrimeRpcClientOptionsV0["onEvent"];
	#nextId = 0;
	#exit: PrimeRpcExitV0 | undefined;
	#drainTimedOut = false;
	stderr = "";

	constructor(options: PrimeRpcClientOptionsV0) {
		this.#onEvent = options.onEvent;
		this.#child = spawn(options.command, [...options.args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child.stdout.on("data", (chunk: Buffer) => this.#receive(this.#decoder.push(chunk)));
		this.#child.stdout.on("end", () => this.#receive(this.#decoder.end()));
		// Kept only for diagnosing a failed launch; never written to evidence.
		this.#child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4_000);
		});
		this.#child.stdin.on("error", () => {});
		this.exitObserved = new Promise((resolve) => {
			this.#observeExit = resolve;
		});
		this.exited = new Promise((resolve) => {
			// Pending requests fail as soon as the process exits, but `exited` settles only once stdout has drained
			// ("close"), so records written just before exit are decoded and any protocol errors in them are counted.
			// A descendant that inherited stdout could hold it open, so the wait after exit is bounded.
			this.#child.on("exit", (code, signal) => {
				const exit = this.#settle({ code, signal });
				setTimeout(() => {
					this.#drainTimedOut = true;
					resolve(exit);
				}, STDOUT_DRAIN_GRACE_MS).unref();
			});
			this.#child.on("close", (code, signal) => resolve(this.#settle({ code, signal })));
			// A spawn failure never emits exit; pending requests must fail now, not at their timeout.
			this.#child.on("error", () => resolve(this.#settle({ code: null, signal: null })));
		});
	}

	/** Record the first exit and reject every pending request with it. */
	#settle(exit: PrimeRpcExitV0): PrimeRpcExitV0 {
		this.#exit ??= exit;
		this.#observeExit(this.#exit);
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(new PrimeRpcExitError(pending.command, this.#exit));
			this.#pending.delete(id);
		}
		return this.#exit;
	}

	/**
	 * True when `exited` settled because stdout was still open after the drain grace period: records could still
	 * arrive, so what was decoded is not known to be complete.
	 */
	get drainTimedOut(): boolean {
		return this.#drainTimedOut;
	}

	get pid(): number | undefined {
		return this.#child.pid;
	}

	/** Send one command and resolve with its correlated response. A `success: false` response resolves, not rejects. */
	request(
		command: { readonly type: string } & Record<string, unknown>,
		timeoutMs = 60_000,
	): Promise<PrimeRpcResponseV0> {
		if (this.#exit !== undefined) {
			return Promise.reject(new PrimeRpcExitError(command.type, this.#exit));
		}
		const id = `probe-${++this.#nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new PrimeRpcError(`Prime RPC ${command.type} timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			this.#pending.set(id, { command: command.type, resolve, reject, timer });
			this.#child.stdin.write(encodeJsonlRecordV0({ ...command, id }));
		});
	}

	/** Close stdin and wait for exit and stdout drain; kill the process if it does not exit in time. */
	async close(timeoutMs = 10_000): Promise<PrimeRpcExitV0> {
		// Already exited: stdout may still be draining, so wait for `exited` rather than returning the exit early.
		if (this.#exit !== undefined) return await this.exited;
		this.#child.stdin.end();
		const timer = setTimeout(() => this.#child.kill("SIGKILL"), timeoutMs);
		try {
			return await this.exited;
		} finally {
			clearTimeout(timer);
		}
	}

	#receive(records: ReturnType<JsonlDecoderV0["push"]>): void {
		for (const decoded of records) {
			if (decoded.kind === "invalid") {
				this.protocolErrors.push(`${decoded.error} (${decoded.length} characters)`);
				continue;
			}
			const record = classifyPrimeRecordV0(decoded.value);
			if (record.kind === "invalid") {
				this.protocolErrors.push(record.reason);
				continue;
			}
			if (record.kind === "event") {
				this.#onEvent?.(record.type, record.event);
				continue;
			}
			const { id } = record.response;
			if (id === undefined) {
				// Prime reports a parse failure of a command without an id; nothing is waiting for it by id.
				this.protocolErrors.push(`Response without id for ${record.response.command}`);
				continue;
			}
			const pending = this.#pending.get(id);
			if (pending === undefined) {
				this.protocolErrors.push(
					this.#settledIds.has(id) ? `Duplicate response for ${id}` : `Response for unknown id ${id}`,
				);
				continue;
			}
			clearTimeout(pending.timer);
			this.#pending.delete(id);
			this.#settledIds.add(id);
			// The right id with another command's response would hand the caller a different data shape.
			if (record.response.command !== pending.command) {
				const error = `Response for ${id} echoes ${record.response.command}, expected ${pending.command}`;
				this.protocolErrors.push(error);
				pending.reject(new PrimeRpcError(error));
				continue;
			}
			pending.resolve(record.response);
		}
	}
}
