// Research-only (Prime Runtime Conformance v0). Not exported from @endophasia/core and not used by any runtime path.

/** One decoded JSONL record, or a record that was not a single JSON object. */
export type JsonlRecordV0 =
	| { readonly kind: "object"; readonly value: Record<string, unknown> }
	| { readonly kind: "invalid"; readonly error: string; readonly length: number };

/**
 * Strict JSONL decoder for Prime's RPC framing: UTF-8 is decoded incrementally, records are split on LF only, one
 * trailing CR is stripped, and each record must be one JSON object. U+2028 and U+2029 are ordinary characters here,
 * unlike Node's readline, which would split valid JSON strings on them. Incomplete bytes and text stay buffered
 * between chunks. Empty records are skipped.
 */
export class JsonlDecoderV0 {
	readonly #decoder = new TextDecoder("utf-8", { fatal: false });
	#buffer = "";

	/** Decode one chunk and return every complete record it finished. */
	push(chunk: Uint8Array): JsonlRecordV0[] {
		this.#buffer += this.#decoder.decode(chunk, { stream: true });
		return this.#drain(false);
	}

	/** Flush at end of stream: a final record without a trailing LF is still returned. */
	end(): JsonlRecordV0[] {
		this.#buffer += this.#decoder.decode();
		return this.#drain(true);
	}

	#drain(final: boolean): JsonlRecordV0[] {
		const records: JsonlRecordV0[] = [];
		let newline = this.#buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			const record = parseRecord(line);
			if (record !== undefined) records.push(record);
			newline = this.#buffer.indexOf("\n");
		}
		if (final && this.#buffer.length > 0) {
			const record = parseRecord(this.#buffer);
			this.#buffer = "";
			if (record !== undefined) records.push(record);
		}
		return records;
	}
}

function parseRecord(raw: string): JsonlRecordV0 | undefined {
	const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
	if (line.length === 0) return undefined;
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
