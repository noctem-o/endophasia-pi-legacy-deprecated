// Prime RPC Runtime Ingress v0: strict JSONL framing for `prime-agent --mode rpc`. Prime-specific and Node-side only;
// never part of the browser-facing @endophasia/core surface. It keeps the framing guarantees the Prime Runtime
// Conformance v0 probe established (research/prime-conformance/jsonl.ts), which differential tests hold it to.

/** Why a record was not a single JSON object. Categories only: the record's content is never quoted. */
export type PrimeJsonlFaultV0 =
	| "empty-record"
	| "malformed-utf8"
	| "malformed-json"
	| "not-an-object"
	| "oversized-record";

/** One decoded record, a JSON object, or a fault with the record's byte length. */
export type PrimeJsonlRecordV0 =
	| { readonly kind: "object"; readonly value: Record<string, unknown> }
	| { readonly kind: "fault"; readonly fault: PrimeJsonlFaultV0; readonly byteLength: number };

const LF = 0x0a;
const CR = 0x0d;
/** Default bound on one record. Far above any expected Prime response, yet a runaway record cannot exhaust memory. */
export const PRIME_JSONL_DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
/** A partial-record buffer larger than this is released after its record, not kept for the next one. */
const RETAINED_BUFFER_BYTES = 1024 * 1024;

/**
 * Strict decoder for Prime's RPC framing. Bytes are split on LF only (never with readline, which would also split on
 * U+2028 and U+2029 inside valid JSON strings); one trailing CR is stripped; each complete record is decoded on its
 * own with a fatal UTF-8 decoder, so malformed bytes invalidate that record instead of becoming U+FFFD. A record must
 * be exactly one JSON object; a blank line is a fault. Incomplete bytes, including a split multi-byte code point, stay
 * buffered between chunks in one buffer that grows by doubling, so a record split over many chunks costs amortized
 * linear copying and a single allocation, however small the chunks are.
 * A record longer than `maxRecordBytes` is discarded up to its LF and reported as `oversized-record`.
 */
export class PrimeJsonlDecoderV0 {
	readonly #maxRecordBytes: number;
	/** The incomplete record's bytes are buffer[0, pendingLength); the rest is spare capacity. */
	#buffer: Uint8Array = new Uint8Array(0);
	#pendingLength = 0;
	/** Set while an oversized record is being skipped: its bytes are counted, not kept. */
	#discarding = false;

	constructor(options: { readonly maxRecordBytes?: number } = {}) {
		const maxRecordBytes = options.maxRecordBytes ?? PRIME_JSONL_DEFAULT_MAX_RECORD_BYTES;
		// NaN would break buffering and Infinity would lift the memory bound: only a positive safe integer is a limit.
		if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
			throw new RangeError("maxRecordBytes must be a positive safe integer");
		}
		this.#maxRecordBytes = maxRecordBytes;
	}

	/** Buffer one chunk and return every record it completed, in order. */
	push(chunk: Uint8Array): PrimeJsonlRecordV0[] {
		const records: PrimeJsonlRecordV0[] = [];
		let start = 0;
		let newline = chunk.indexOf(LF, start);
		while (newline !== -1) {
			records.push(this.#take(chunk.subarray(start, newline)));
			start = newline + 1;
			newline = chunk.indexOf(LF, start);
		}
		this.#hold(chunk.subarray(start));
		return records;
	}

	/** At end of stream: a final record without a trailing LF is still decoded; an empty remainder is nothing. */
	end(): PrimeJsonlRecordV0[] {
		if (this.#pendingLength === 0 && !this.#discarding) return [];
		return [this.#take(new Uint8Array(0))];
	}

	/** Keep an incomplete tail, or only count it once the record is over the bound. */
	#hold(bytes: Uint8Array): void {
		if (bytes.length === 0) return;
		const length = this.#pendingLength + bytes.length;
		if (this.#discarding || length > this.#maxRecordBytes) {
			this.#pendingLength = length;
			this.#discarding = true;
			this.#buffer = new Uint8Array(0);
			return;
		}
		this.#reserve(length);
		// A copy into the decoder's own buffer: the chunk may be a view into a larger buffer that should not stay alive.
		this.#buffer.set(bytes, this.#pendingLength);
		this.#pendingLength = length;
	}

	/** Grow the buffer to hold `length` bytes, doubling (up to the record bound) so growth is amortized. */
	#reserve(length: number): void {
		if (length <= this.#buffer.length) return;
		const capacity = Math.min(
			Math.max(length, this.#buffer.length * 2, 4096),
			Math.max(length, this.#maxRecordBytes),
		);
		const grown = new Uint8Array(capacity);
		grown.set(this.#buffer.subarray(0, this.#pendingLength));
		this.#buffer = grown;
	}

	/** Complete the pending record with `tail` (the bytes before its LF) and decode it. */
	#take(tail: Uint8Array): PrimeJsonlRecordV0 {
		const length = this.#pendingLength + tail.length;
		const discarding = this.#discarding || length > this.#maxRecordBytes;
		const pending = this.#pendingLength;
		if (discarding) {
			this.#pendingLength = 0;
			this.#discarding = false;
			this.#buffer = new Uint8Array(0);
			return { kind: "fault", fault: "oversized-record", byteLength: length };
		}
		if (pending === 0) return decodeRecord(tail);
		// Grown while the pending length is still set, so the bytes already held are carried over.
		this.#reserve(length);
		this.#pendingLength = 0;
		this.#buffer.set(tail, pending);
		// Decoding copies what it keeps (text and parsed values), so the buffer can be reused for the next record; a
		// buffer grown for one large record is dropped rather than kept for the life of the connection.
		const record = decodeRecord(this.#buffer.subarray(0, length));
		if (this.#buffer.length > RETAINED_BUFFER_BYTES) this.#buffer = new Uint8Array(0);
		return record;
	}
}

function decodeRecord(bytes: Uint8Array): PrimeJsonlRecordV0 {
	const line = bytes.at(-1) === CR ? bytes.subarray(0, -1) : bytes;
	if (line.length === 0) return { kind: "fault", fault: "empty-record", byteLength: 0 };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(line);
	} catch {
		return { kind: "fault", fault: "malformed-utf8", byteLength: line.length };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { kind: "fault", fault: "malformed-json", byteLength: line.length };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { kind: "fault", fault: "not-an-object", byteLength: line.length };
	}
	return { kind: "object", value: value as Record<string, unknown> };
}

/** Encode one command as one record. JSON.stringify escapes LF and CR inside strings, so a record stays one line. */
export function encodePrimeJsonlRecordV0(value: Record<string, unknown>): string {
	return `${JSON.stringify(value)}\n`;
}
