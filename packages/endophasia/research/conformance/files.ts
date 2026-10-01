import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Linked roots or ancestor components cannot redirect a reference or instrument outside its stated path. */
export function assertPlainPath(path: string, kind: "file" | "directory"): string {
	const absolute = resolve(path);
	if (realpathSync(absolute) !== absolute) throw new Error("linked path");
	const stat = lstatSync(absolute);
	if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw new Error("plain path required");
	return absolute;
}

export function assertMemberPath(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		!value.length ||
		!value
			.split("/")
			.every((part) => part.length > 0 && !/[^A-Za-z0-9._-]/.test(part) && part !== "." && part !== "..")
	)
		throw new Error("relative member path required");
}
