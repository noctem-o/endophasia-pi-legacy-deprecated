// Transitive source guard, including type-only imports. Browser smoke separately checks actual bundle inputs.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(packageRoot, "../..");
function specs(source: string): string[] {
	// Include erased type edges as well as value imports/reexports. Actual browser bundle inputs are checked separately.
	const staticEdges = /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g;
	const dynamicEdges = /\bimport\s*\(\s*["']([^"']+)["']/g;
	return [...source.matchAll(staticEdges), ...source.matchAll(dynamicEdges)].map((match) => match[1]!);
}
function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
	);
}
function researchReachable(roots: string[], read: (path: string) => string, has: (path: string) => boolean): string[] {
	const queue = [...roots];
	const seen = new Set<string>();
	const hits = new Set<string>();
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		if (file.includes("/endophasia/research/")) {
			hits.add(file);
			continue;
		}
		for (const spec of specs(read(file))) {
			if (spec.includes("prime-conformance") || /(?:prime-agent|agentclientprotocol)/.test(spec)) hits.add(spec);
			if (!spec.startsWith(".")) continue;
			const base = resolve(dirname(file), spec);
			const target = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")].find(has);
			if (target) queue.push(target);
		}
	}
	return [...hits];
}

describe("Prime research stays outside production", () => {
	it.each(["src", "runtime/prime", "presentation", "cockpit"])(
		"%s imports no research, directly or through another relative module",
		(dir) => {
			expect(
				researchReachable(
					files(join(packageRoot, dir)),
					(p) => readFileSync(p, "utf8"),
					(p) => existsSync(p) && statSync(p).isFile(),
				),
			).toEqual([]);
		},
	);
	it("rejects indirect, type-only and dynamic import edges in a hostile graph", () => {
		for (const statement of [
			'import type { Evidence } from "../research/prime-conformance/evidence.ts";',
			'export * from "../research/prime-conformance/report.ts";',
			'const report = import("../research/prime-conformance/report.ts");',
		]) {
			const graph: Record<string, string> = {
				"/endophasia/src/profile.ts": 'import "./helper.ts";',
				"/endophasia/src/helper.ts": statement,
				"/endophasia/research/prime-conformance/evidence.ts": "",
				"/endophasia/research/prime-conformance/report.ts": "",
			};
			expect(
				researchReachable(
					["/endophasia/src/profile.ts"],
					(p) => graph[p]!,
					(p) => p in graph,
				).length,
			).toBeGreaterThan(0);
		}
	});
	it("Runtime Profile cannot inspect a report at runtime", () => {
		for (const file of ["runtime-profile-service.ts", "runtime-profile-facet.ts"]) {
			const source = readFileSync(join(packageRoot, "src", file), "utf8");
			expect(source).not.toMatch(/prime-conformance|research\/|candidateForPR27|readPrimeFixtures|report\.json/);
		}
	});
	it("does not add upstream Prime or ACP SDK as any Endophasia dependency", () => {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		expect(
			Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).some((name) =>
				/prime-agent|agentclientprotocol/.test(name),
			),
		).toBe(false);
		const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as {
			packages: Record<string, unknown>;
		};
		expect(Object.keys(lock.packages).some((name) => /agentclientprotocol|prime-agent/.test(name))).toBe(false);
	});
});
