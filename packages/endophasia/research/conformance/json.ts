// Descriptor inspection follows the audited plain-data guard; kept separate from historical instruments.
import { createHash } from "node:crypto";
import { types } from "node:util";

export type Json = null | string | boolean | number | Json[] | { [key: string]: Json };

/** Validate without invoking getters, proxies or serializers. Undefined is not JSON, even in object slots. */
export function assertPlainJson(value: unknown): asserts value is Json {
	const ancestors = new Set<object>();
	const walk = (item: unknown): void => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isFinite(item)) return;
		if (typeof item !== "object" || types.isProxy(item) || ancestors.has(item)) throw new Error("nonplain JSON");
		const array = Array.isArray(item);
		const prototype = Object.getPrototypeOf(item);
		if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
			throw new Error("nonplain JSON");
		for (let parent: object | null = item; parent !== null; parent = Object.getPrototypeOf(parent))
			if (Object.getOwnPropertyDescriptor(parent, "toJSON")) throw new Error("custom JSON serializer");
		ancestors.add(item);
		const descriptors = Object.getOwnPropertyDescriptors(item);
		if (Reflect.ownKeys(item).some((key) => typeof key !== "string")) throw new Error("symbol JSON key");
		if (array && Object.keys(descriptors).length !== item.length + 1) throw new Error("sparse JSON array");
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (array && key === "length") continue;
			if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("nondata JSON property");
			if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
				throw new Error("custom JSON array property");
			walk(descriptor.value);
		}
		ancestors.delete(item);
	};
	walk(value);
}

/** Sorted object keys, preserved array order, UTF-8 with one LF. This is a local format, not RFC 8785. */
export function canonicalJson(value: unknown): string {
	assertPlainJson(value);
	const sorted = (item: Json): Json => {
		if (Array.isArray(item)) return item.map(sorted);
		if (item === null || typeof item !== "object") return item;
		const result: { [key: string]: Json } = Object.create(null);
		for (const key of Object.keys(item).sort()) result[key] = sorted(item[key]!);
		return result;
	};
	return `${JSON.stringify(sorted(value), null, "\t")}\n`;
}

export function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function assertDigest(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length !== 64 || !/^[0-9a-f]+$/.test(value))
		throw new Error("SHA-256 requires 64 lowercase hexadecimal characters");
}
