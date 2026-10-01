// Inspect descriptors before reading values: neither validation nor JSON.stringify may execute caller code.
import { types } from "node:util";

export function assertPlainEvidence(value: unknown): void {
	const ancestors = new Set<object>();
	const walk = (item: unknown, inArray = false): void => {
		if (item === undefined && !inArray) return; // Optional object fields are omitted by JSON.
		if (item === null || typeof item === "string" || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isFinite(item)) return;
		if (typeof item !== "object" || types.isProxy(item) || ancestors.has(item)) throw new Error("nonplain evidence");
		const array = Array.isArray(item);
		const prototype = Object.getPrototypeOf(item);
		if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
			throw new Error("nonplain evidence");
		for (let parent: object | null = item; parent !== null; parent = Object.getPrototypeOf(parent))
			if (Object.getOwnPropertyDescriptor(parent, "toJSON")) throw new Error("custom evidence serializer");
		ancestors.add(item);
		const descriptors = Object.getOwnPropertyDescriptors(item);
		if (Reflect.ownKeys(item).some((key) => typeof key !== "string")) throw new Error("symbol evidence key");
		if (array && Object.keys(descriptors).length !== item.length + 1) throw new Error("sparse evidence array");
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (array && key === "length") continue;
			if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("nondata evidence property");
			if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
				throw new Error("custom evidence array property");
			walk(descriptor.value, array);
		}
		ancestors.delete(item);
	};
	walk(value);
}
