// Live instrument identity: all tracked executable source, not a hand-maintained dependency list.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isBuiltin, stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

export const INSTRUMENT_ROOT = resolve(import.meta.dirname, "../../../..");

function git(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
}

export function researchInstrumentHash(root = INSTRUMENT_ROOT): string {
	const hash = createHash("sha256");
	for (const name of git(root, ["ls-files", "-z"])
		.split("\0")
		.filter((name) => /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/.test(name))
		.sort())
		hash
			.update(name)
			.update("\0")
			.update(readFileSync(join(root, name)))
			.update("\0");
	return hash.digest("hex");
}

/** The live CLI uses direct tracked .ts modules and Node builtins only. Reject generated/dependency imports.
 * Type stripping removes type-only edges. This deliberately supports static ESM declarations only; new loaders,
 * computed imports or external dependencies require a new instrument audit rather than silently escaping identity.
 */
export function assertInstrumentSources(root: string, entry: string): void {
	const tracked = new Set(git(root, ["ls-files", "-z"]).split("\0"));
	const seen = new Set<string>();
	const walk = (name: string): void => {
		if (seen.has(name)) return;
		seen.add(name);
		const path = join(root, name);
		if (!tracked.has(name) || !name.endsWith(".ts") || realpathSync(path) !== path)
			throw new Error("instrument imports untracked, generated or linked code");
		const source = stripTypeScriptTypes(readFileSync(path, "utf8"));
		if (/\bimport\s*\(|\bcreateRequire\s*\(/.test(source)) throw new Error("instrument uses an unbound loader");
		// Includes static imports/reexports and literal Node requires inside the tracked keeper source string.
		for (const match of source.matchAll(
			/^\s*import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']|^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/gm,
		)) {
			const specifier = match[1] ?? match[2] ?? match[3]!;
			if (specifier.startsWith("node:") && isBuiltin(specifier)) continue;
			if (!specifier.startsWith(".")) throw new Error("instrument imports external code");
			walk(relative(root, resolve(dirname(path), specifier)));
		}
	};
	walk(entry);
}

export function describeResearchInstrument(root = INSTRUMENT_ROOT) {
	return {
		endophasiaCommit: git(root, ["rev-parse", "HEAD"]),
		endophasiaBuild: git(root, ["status", "--porcelain", "--untracked-files=all"])
			? "dirty-checkout"
			: "clean-checkout",
		researchHash: researchInstrumentHash(root),
	};
}

export function requireCleanResearchInstrument(root = INSTRUMENT_ROOT) {
	if (process.env.NODE_OPTIONS || process.execArgv.some((arg) => arg !== "--no-warnings"))
		throw new Error("live instrument requires direct Node execution without injected flags or loaders");
	const identity = describeResearchInstrument(root);
	if (identity.endophasiaBuild !== "clean-checkout") throw new Error("Endophasia instrument worktree is dirty");
	assertInstrumentSources(root, "packages/endophasia/research/prime-conformance/cli-097.ts");
	return identity;
}
