// PR #27 read-side golden specimen. This does not run, remeasure or adapt the subject.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256 } from "../research/conformance/json.ts";
import { orderScenarios } from "../research/conformance/order.ts";
import { verifyReference } from "../research/conformance/reference.ts";
import { sourceDigestAtCommit } from "../research/conformance/repository.ts";
import { ACP_SCENARIOS } from "../research/prime-conformance/acp-probe.ts";
import { buildPrime097Report, readAcpFixtures } from "../research/prime-conformance/comparison.ts";
import { SCENARIO_NAMES_WITH_INVARIANTS } from "../research/prime-conformance/invariants.ts";
import { readPrimeFixturesV0 } from "../research/prime-conformance/report.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/prime/", import.meta.url));
const reference = join(fixtures, "0.9.7");
const manifestBytes = readFileSync(new URL("./fixtures/conformance/prime-097-reference.json", import.meta.url));
const manifest: unknown = JSON.parse(manifestBytes.toString());
const reportBytes = readFileSync(join(reference, "report.json"));

describe("Prime 0.9.7 as a sealed Conformance Lab specimen", () => {
	it("pins the complete 28-member bundle and its historical measuring source", () => {
		expect(sha256(manifestBytes)).toBe("7e9f090a28e0fa0af3e0106645720b0d4c36eaf12f334ea18af7333fe0ad69ac");
		expect(verifyReference(reference, manifest)).toEqual({ digest: sha256(manifestBytes), members: 28 });
		expect(sha256(reportBytes)).toBe("d61a8b298954880068b954872d9ea6c110a49fc60d815856d6da344fb2299a53");
		const captured = readPrimeFixturesV0(join(reference, "rpc"))[0]!.provenance;
		expect(captured.probeVersion).toBe("0.14.7");
		expect(captured.endophasiaCommit).toBe("45adf6b103bf484f40aa69b4774c089ccd170bda");
		expect(sourceDigestAtCommit(repo, captured.endophasiaCommit!)).toBe(captured.researchHash);
	});
	it("checks complete scenarios while leaving all interpretations to the original classifier", () => {
		const rpc = readPrimeFixturesV0(join(reference, "rpc"));
		const acp = readAcpFixtures(join(reference, "acp"));
		const orderedRpc = orderScenarios(
			[...rpc].reverse(),
			SCENARIO_NAMES_WITH_INVARIANTS,
			(r) => r.provenance.scenario,
		);
		const orderedAcp = orderScenarios(
			[...acp].reverse(),
			ACP_SCENARIOS.map((s) => s.name),
			(r) => r.provenance.scenario,
		);
		expect(orderedRpc).toHaveLength(12);
		expect(orderedAcp).toHaveLength(15);
		const history = readPrimeFixturesV0(join(fixtures, "0.9.6"));
		expect(
			Buffer.from(`${JSON.stringify(buildPrime097Report(orderedRpc, orderedAcp, history), null, "\t")}\n`),
		).toEqual(reportBytes);
		expect(
			execFileSync(process.execPath, [join(repo, "packages/endophasia/research/prime-conformance/offline-097.ts")]),
		).toEqual(reportBytes);
	});
	it("metadata cannot edit or reinterpret the specimen's semantic findings", () => {
		const before = JSON.parse(reportBytes.toString());
		const metadata = structuredClone(manifest) as { path: string; sha256: string; judgment?: string }[];
		metadata[0]!.judgment = "exact";
		expect(() => verifyReference(reference, metadata)).toThrow("closed reference member");
		expect(readFileSync(join(reference, "report.json"))).toEqual(reportBytes);
		expect(JSON.parse(readFileSync(join(reference, "report.json"), "utf8")).capabilities).toEqual(
			before.capabilities,
		);
		expect(before.candidateForPR27).toEqual([]);
	});
	it("generic sources have no subject imports, judgments, runtime composition or capability mappings", () => {
		const root = join(repo, "packages/endophasia/research/conformance");
		for (const name of readdirSync(root).filter((n) => n.endsWith(".ts"))) {
			const source = readFileSync(join(root, name), "utf8");
			expect(source).not.toMatch(
				/prime|\bpi\b|codex|\brpc\b|\bacp\b|capability|RuntimeAdapter|MissionTrace|stopReason|continuity|evaluator/i,
			);
			for (const match of source.matchAll(/from\s+["']([^"']+)["']/g))
				expect(match[1]!.startsWith("node:") || match[1]!.startsWith("./")).toBe(true);
		}
	});
	it("another study can use lab mechanics without importing the specimen", () => {
		const dir = mkdtempSync(join(tmpdir(), "lab-other-"));
		try {
			const bytes = '{"observed":false}\n';
			writeFileSync(join(dir, "measurement.json"), bytes);
			expect(verifyReference(dir, [{ path: "measurement.json", sha256: sha256(bytes) }]).members).toBe(1);
			expect(orderScenarios([{ id: "z" }, { id: "a" }], ["a", "z"], (r) => r.id).map((r) => r.id)).toEqual([
				"a",
				"z",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
