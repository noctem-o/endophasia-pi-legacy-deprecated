// Research-only JSON-RPC 2.0 over NDJSON. Independent of production RPC ingress and RPC event classification.
import { type PrimeProcessExitV0, PrimeProcessGroupV0 } from "../../runtime/prime/process-group.ts";
import { acpObject } from "./acp-evidence.ts";
import { PrimeDecodeError } from "./decode.ts";
import { encodeJsonlRecordV0, JsonlDecoderV0 } from "./jsonl.ts";

export class AcpRequestError extends Error {
	readonly code: number;
	constructor(code: number) {
		super("ACP request error");
		this.code = code;
	}
}
interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}
export class ResearchAcpClient {
	readonly protocolErrors: string[] = [];
	readonly #group: PrimeProcessGroupV0;
	readonly #decoder = new JsonlDecoderV0();
	readonly #pending = new Map<number, Pending>();
	readonly #ended: Promise<void>;
	#id = 0;
	#exit: PrimeProcessExitV0 | undefined;
	#recordBytes = 0;
	#closing: Promise<PrimeProcessExitV0> | undefined;
	constructor(options: {
		command: string;
		args: readonly string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
		onUpdate(value: unknown): void;
	}) {
		this.#group = new PrimeProcessGroupV0(options.command, options.args, {
			cwd: options.cwd,
			env: Object.fromEntries(
				Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
			stderr: "ignore",
		});
		this.#group.stdin?.on("error", () => this.#fail("ACP input closed"));
		this.#ended = new Promise((resolve) =>
			this.#group.stdout?.once("end", () => {
				this.#receive(this.#decoder.end(), options.onUpdate);
				resolve();
			}),
		);
		this.#group.stdout?.on("data", (bytes: Buffer) => {
			for (const byte of bytes) {
				this.#recordBytes = byte === 10 ? 0 : this.#recordBytes + 1;
				if (this.#recordBytes > 8 * 1024 * 1024) {
					this.#fail("ACP record exceeds bound");
					this.#group.killGroup();
					return;
				}
			}
			this.#receive(this.#decoder.push(bytes), options.onUpdate);
		});
		void this.#group.exited.then((exit) => {
			this.#exit = exit;
			this.#fail("ACP process exited", false);
		});
	}
	#fail(message: string, protocol = true): void {
		if (protocol) this.protocolErrors.push(message);
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new PrimeDecodeError(message));
		}
		this.#pending.clear();
	}
	#receive(records: ReturnType<JsonlDecoderV0["push"]>, onUpdate: (value: unknown) => void): void {
		for (const record of records) {
			try {
				if (record.kind === "invalid") throw new PrimeDecodeError("ACP framing violation");
				const value = record.value;
				if (value.jsonrpc !== "2.0") throw new PrimeDecodeError("ACP JSON-RPC version");
				if (Object.hasOwn(value, "method")) {
					if (
						Object.hasOwn(value, "id") ||
						Object.hasOwn(value, "result") ||
						Object.hasOwn(value, "error") ||
						value.method !== "session/update"
					)
						throw new PrimeDecodeError("Unexpected ACP method or server request");
					onUpdate(value.params);
					continue;
				}
				if (
					typeof value.id !== "number" ||
					!Number.isSafeInteger(value.id) ||
					Object.hasOwn(value, "result") === Object.hasOwn(value, "error")
				)
					throw new PrimeDecodeError("Malformed ACP response");
				const pending = this.#pending.get(value.id);
				if (pending === undefined) throw new PrimeDecodeError("Unknown or duplicate ACP response ID");
				let errorCode: number | undefined;
				if (Object.hasOwn(value, "error")) {
					const error = acpObject(value.error, "ACP error");
					if (
						typeof error.code !== "number" ||
						!Number.isSafeInteger(error.code) ||
						typeof error.message !== "string"
					)
						throw new PrimeDecodeError("Malformed ACP error");
					errorCode = error.code;
				}
				this.#pending.delete(value.id);
				clearTimeout(pending.timer);
				if (errorCode !== undefined) pending.reject(new AcpRequestError(errorCode));
				else pending.resolve(value.result);
			} catch {
				this.#fail("ACP protocol or update decode violation");
			}
		}
	}
	request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (this.#exit !== undefined || this.#closing !== undefined)
			return Promise.reject(new PrimeDecodeError("ACP connection closed"));
		const id = ++this.#id;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new PrimeDecodeError("ACP request timeout"));
			}, 60_000);
			this.#pending.set(id, { resolve, reject, timer });
			this.#group.stdin?.write(encodeJsonlRecordV0({ jsonrpc: "2.0", id, method, params }));
		});
	}
	/** Resolves on the local Writable callback; JSON-RPC notifications have no remote response. */
	notify(method: string, params: Record<string, unknown>): Promise<void> {
		const input = this.#group.stdin;
		if (this.#exit !== undefined || this.#closing !== undefined || !input || input.destroyed || input.writableEnded)
			return Promise.reject(new PrimeDecodeError("ACP connection closed"));
		return new Promise((resolve, reject) => {
			input.write(encodeJsonlRecordV0({ jsonrpc: "2.0", method, params }), (error) => {
				if (error) reject(new PrimeDecodeError("ACP notification local write failed"));
				else resolve();
			});
		});
	}
	close(): Promise<PrimeProcessExitV0> {
		this.#closing ??= (async () => {
			this.#group.stdin?.end();
			const timer = setTimeout(() => this.#group.killGroup(), 10_000);
			try {
				const exit = await this.#group.exited;
				await this.#group.release();
				await this.#ended;
				return exit;
			} finally {
				clearTimeout(timer);
			}
		})();
		return this.#closing;
	}
}
