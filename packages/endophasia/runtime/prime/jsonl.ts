// Prime RPC Runtime Ingress v0: strict JSONL framing for `prime-agent --mode rpc`. Prime-specific and Node-side only;
// never part of the browser-facing @endophasia/core surface. It keeps the framing guarantees the Prime Runtime
// Conformance v0 probe established (research/prime-conformance/jsonl.ts), which differential tests hold it to.

/** Why a record was not a single JSON object. Categories only: the record's content is never quoted. */
export type PrimeJsonlFaultV0 = "empty-record" | "malformed-utf8" | "malformed-json" | "not-an-object";

/** One decoded record: a JSON object, or a fault with the record's byte length. */
export type PrimeJsonlRecordV0 =
	| { readonly kind: "object"; readonly value: Record<string, unknown> }
	| { readonly kind: "fault"; readonly fault: PrimeJsonlFaultV0; readonly byteLength: number };

const LF = 0x0a;
const CR = 0x0d;

/**
 * Strict decoder for Prime's RPC framing. Bytes are buffered and split on LF only (never with readline, which would
 * also split on U+2028 and U+2029 inside valid JSON strings); one trailing CR is stripped; each complete record is
 * decoded on its own with a fatal UTF-8 decoder, so malformed bytes invalidate that record instead of becoming U+FFFD.
 * A record must be exactly one JSON object; a blank line is a fault. Incomplete bytes, including a split multi-byte
 * code point, stay buffered between chunks.
 */
export class PrimeJsonlDecoderV0 {
	#pending: Uint8Array = new Uint8Array(0);

	/** Buffer one chunk and return every record it completed, in order. */
	push(chunk: Uint8Array): PrimeJsonlRecordV0[] {
		const joined = new Uint8Array(this.#pending.length + chunk.length);
		joined.set(this.#pending);
		joined.set(chunk, this.#pending.length);
		const records: PrimeJsonlRecordV0[] = [];
		let start = 0;
		let newline = joined.indexOf(LF, start);
		while (newline !== -1) {
			records.push(decodeRecord(joined.subarray(start, newline)));
			start = newline + 1;
			newline = joined.indexOf(LF, start);
		}
		this.#pending = joined.slice(start);
		return records;
	}

	/** At end of stream: a final record without a trailing LF is still decoded; an empty remainder is nothing. */
	end(): PrimeJsonlRecordV0[] {
		const rest = this.#pending;
		this.#pending = new Uint8Array(0);
		return rest.length === 0 ? [] : [decodeRecord(rest)];
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
