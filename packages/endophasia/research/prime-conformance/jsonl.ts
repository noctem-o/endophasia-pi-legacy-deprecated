// Research-only (Prime Runtime Conformance v0). Not exported from @endophasia/core and not used by any runtime path.

/** One decoded JSONL record, or a record that was not a single JSON object. */
export type JsonlRecordV0 =
	| { readonly kind: "object"; readonly value: Record<string, unknown> }
	| { readonly kind: "invalid"; readonly error: string; readonly length: number };

/**
 * Strict JSONL decoder for Prime's RPC framing: bytes are buffered and split on LF only, one trailing CR is stripped,
 * and each complete record is decoded as UTF-8 on its own with a fatal decoder, so malformed UTF-8 invalidates that
 * record instead of being replaced with U+FFFD. Each record must be one JSON object. U+2028 and U+2029 are ordinary
 * characters here, unlike Node's readline, which would split valid JSON strings on them. Incomplete bytes stay
 * buffered between chunks. Empty records are skipped.
 */
export class JsonlDecoderV0 {
	#pending: Uint8Array = new Uint8Array(0);

	/** Buffer one chunk and return every complete record it finished. */
	push(chunk: Uint8Array): JsonlRecordV0[] {
		const joined = new Uint8Array(this.#pending.length + chunk.length);
		joined.set(this.#pending);
		joined.set(chunk, this.#pending.length);
		const records: JsonlRecordV0[] = [];
		let start = 0;
		let newline = joined.indexOf(0x0a, start);
		while (newline !== -1) {
			const record = decodeRecord(joined.subarray(start, newline));
			if (record !== undefined) records.push(record);
			start = newline + 1;
			newline = joined.indexOf(0x0a, start);
		}
		this.#pending = joined.slice(start);
		return records;
	}

	/** Flush at end of stream: a final record without a trailing LF is still returned. */
	end(): JsonlRecordV0[] {
		const rest = this.#pending;
		this.#pending = new Uint8Array(0);
		const record = rest.length === 0 ? undefined : decodeRecord(rest);
		return record === undefined ? [] : [record];
	}
}

function decodeRecord(bytes: Uint8Array): JsonlRecordV0 | undefined {
	const line = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
	if (line.length === 0) return undefined;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(line);
	} catch {
		return { kind: "invalid", error: "Malformed UTF-8", length: line.length };
	}
	return parseRecord(text);
}

function parseRecord(line: string): JsonlRecordV0 {
	try {
		const value: unknown = JSON.parse(line);
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return { kind: "invalid", error: "Record is not a JSON object", length: line.length };
		}
		return { kind: "object", value: value as Record<string, unknown> };
	} catch (error) {
		// The message is the parser's, never the record's content.
		return {
			kind: "invalid",
			error: error instanceof SyntaxError ? "Malformed JSON" : "Unreadable record",
			length: line.length,
		};
	}
}

/** Encode one command as a JSONL record. JSON.stringify escapes LF and CR inside strings, so one record stays one line. */
export function encodeJsonlRecordV0(value: Record<string, unknown>): string {
	return `${JSON.stringify(value)}\n`;
}
