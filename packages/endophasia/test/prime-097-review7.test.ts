// PR #26 review 5381403102: parent-path continuity, invalid accounting basis, mandatory RPC arrays.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpEvidenceProblems, acpScenarioProblems } from "../research/prime-conformance/acp-validation.ts";
import {
	assessPrime097,
	buildPrime097Report,
	publishPrime097,
	readAcpFixtures,
} from "../research/prime-conformance/comparison.ts";
import { writePrime097Diagnostics } from "../research/prime-conformance/diagnostics.ts";
import { RPC_EVIDENCE_ARRAYS } from "../research/prime-conformance/evidence.ts";
import { rpcPrivacyShapeProblems } from "../research/prime-conformance/privacy-shape.ts";
import { readPrimeFixturesV0 } from "../research/prime-conformance/report.ts";
import { baseline, controls } from "./prime-097-controls.ts";

describe("PR #26 review 7 reported attacks", () => {
	it("rejects a disconnected second close-recreate exchange", () => {
		const { rpc, acp } = controls();
		const run = acp.find((r) => r.provenance.scenario === "close-recreate")!;
		const file = run.files[0]!;
		const user = file.filter((e) => e.role === "user")[1]!;
		Object.assign(user, { parentId: file.find((e) => e.type === "custom_message")!.id });
		expect(acpEvidenceProblems(run)).toContain("ACP durable messages do not follow the scripted parent path");
		expect(assessPrime097(rpc, acp).invalid.length).toBeGreaterThan(0);
	});
	it("missing assistant evidence leaves every durable basis unverified", () => {
		const { rpc, acp } = controls();
		const run = acp.find((r) => r.provenance.scenario === "simple")!;
		run.files[0]!.splice(
			run.files[0]!.findIndex((e) => e.role === "assistant"),
			1,
		);
		const report = buildPrime097Report(rpc, acp, baseline);
		expect(report.assessment.invalid.length).toBeGreaterThan(0);
		expect(report.acp.facts.providerUsageDecodedExactly).toBe(false);
		for (const capability of report.capabilities) expect(capability.durable.basis).toBe("unverified");
	});
	it("missing stateKeys cannot reach either persistence boundary", () => {
		const { rpc, acp } = controls();
		Reflect.deleteProperty(rpc[0]!, "stateKeys");
		expect(rpcPrivacyShapeProblems(rpc[0]!).length).toBeGreaterThan(0);
		const dir = mkdtempSync(join(tmpdir(), "prime-array-"));
		try {
			expect(() => writePrime097Diagnostics(join(dir, ".artifacts"), rpc, acp, baseline)).toThrow("nothing written");
			expect(() => publishPrime097(join(dir, "reference"), rpc, acp, baseline)).toThrow("refused");
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("PR #26 scripted durable parent paths", () => {
	const cases = controls().acp.flatMap((run) =>
		run.files.flatMap((file, fileIndex) =>
			file.flatMap((entry, index) =>
				entry.type === "message" && file.slice(0, index).some((e) => e.type === "message")
					? ["null", "earlier metadata", "skip previous message"].map((attack) => ({
							scenario: run.provenance.scenario,
							fileIndex,
							index,
							attack,
						}))
					: [],
			),
		),
	);
	it.each(cases)("rejects $scenario message $index: $attack", ({ scenario, fileIndex, index, attack }) => {
		const { rpc, acp } = controls();
		const run = acp.find((r) => r.provenance.scenario === scenario)!;
		const file = run.files[fileIndex]!;
		const prior = file.slice(0, index).filter((e) => e.type === "message");
		Object.assign(file[index]!, {
			parentId:
				attack === "null"
					? null
					: attack === "earlier metadata"
						? file.find((e) => e.type === "custom_message")!.id
						: (prior.at(-2)?.id ?? null),
		});
		expect(acpEvidenceProblems(run)).toContain("ACP durable messages do not follow the scripted parent path");
		expect(assessPrime097(rpc, acp).invalid.length).toBeGreaterThan(0);
	});
	it.each(["simple", "tool-run", "multi-prompt", "close-recreate", "compaction"])(
		"permits interstitial metadata on the continuing %s path",
		(scenario) => {
			const { rpc, acp } = controls();
			const run = acp.find((r) => r.provenance.scenario === scenario)!;
			const file = run.files[0]!;
			const index = file.findIndex((e) => e.role === "assistant");
			const parentId = file[index]!.parentId;
			file.splice(index, 0, { type: "custom_message", id: "ffffffff", parentId, keys: ["type", "id", "parentId"] });
			Object.assign(file[index + 1]!, { parentId: "ffffffff" });
			expect(acpEvidenceProblems(run)).toEqual([]);
			expect(assessPrime097(rpc, acp)).toEqual({ invalid: [], unpublishable: [] });
		},
	);
	it("rejects an interstitial branch that bypasses the previous message", () => {
		const { acp } = controls();
		const run = acp.find((r) => r.provenance.scenario === "close-recreate")!;
		const file = run.files[0]!;
		const index = file.findIndex((e, i) => e.role === "user" && file.slice(0, i).some((p) => p.role === "user"));
		file.splice(index, 0, {
			type: "custom_message",
			id: "ffffffff",
			parentId: file.find((e) => e.type === "custom_message")!.id,
			keys: ["type", "id", "parentId"],
		});
		Object.assign(file[index + 1]!, { parentId: "ffffffff" });
		expect(acpEvidenceProblems(run)).toContain("ACP durable messages do not follow the scripted parent path");
	});
	it("terminates the direct scenario validator on cyclic metadata", () => {
		const { acp } = controls();
		const run = acp.find((r) => r.provenance.scenario === "simple")!;
		const metadata = run.files[0]!.find((e) => e.type === "custom_message")!;
		Object.assign(metadata, { parentId: metadata.id });
		expect(acpScenarioProblems(run)).toEqual([]); // No prior message is claimed; structural validator rejects the cycle.
		expect(acpEvidenceProblems(run).some((p) => p.includes("parentId names no earlier entry"))).toBe(true);
	});
});

describe("PR #26 invalid evidence precedes accounting contradiction", () => {
	it.each([
		"missing assistant",
		"missing usage",
		"disconnected path",
		"protocol failure",
		"wrong capture",
		"partial set",
	])("leaves durable bases unverified for %s", (attack) => {
		const { rpc, acp } = controls();
		const run = acp.find((r) => r.provenance.scenario === "simple")!;
		const file = run.files[0]!;
		const assistant = file.find((e) => e.role === "assistant")!;
		if (attack === "missing assistant") file.splice(file.indexOf(assistant), 1);
		else if (attack === "missing usage") Reflect.deleteProperty(assistant, "usage");
		else {
			Object.assign(assistant.usage!, { output: assistant.usage!.output + 1 });
			if (attack === "disconnected path") Object.assign(assistant, { parentId: null });
			if (attack === "protocol failure") run.protocolErrors.push("ACP protocol failed");
			if (attack === "wrong capture")
				for (const item of [...rpc, ...acp]) Object.assign(item.provenance, { endophasiaCommit: "0".repeat(40) });
			if (attack === "partial set")
				acp.splice(
					acp.findIndex((r) => r.provenance.scenario === "tool-run"),
					1,
				);
		}
		const dir = mkdtempSync(join(tmpdir(), "prime-invalid-basis-"));
		try {
			const report = writePrime097Diagnostics(join(dir, ".artifacts"), rpc, acp, baseline);
			expect(report.assessment.invalid.length + report.assessment.unpublishable.length).toBeGreaterThan(0);
			expect(report.acp.facts.providerUsageDecodedExactly).toBe(false);
			for (const c of report.capabilities) expect(c.durable.basis).toBe("unverified");
			expect(readdirSync(join(dir, ".artifacts")).sort()).toEqual(["evidence.json", "report.json"]);
			expect(() => publishPrime097(join(dir, "reference"), rpc, acp, baseline)).toThrow("refused");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("keeps complete numeric drift contradicted only for dependent capabilities", () => {
		const { rpc, acp } = controls();
		const assistant = acp
			.find((r) => r.provenance.scenario === "simple")!
			.files[0]!.find((e) => e.role === "assistant")!;
		Object.assign(assistant.usage!, { output: assistant.usage!.output + 1 });
		const report = buildPrime097Report(rpc, acp, baseline);
		expect(report.assessment).toEqual({ invalid: [], unpublishable: [] });
		for (const c of report.capabilities)
			expect(c.durable.basis).toBe(
				["RuntimeMetricsV0", "UsageLedgerRowV0"].includes(c.contract) ? "contradicted" : "established",
			);
	});
});

describe("PR #26 mandatory RPC envelope arrays before writes", () => {
	it.each(
		RPC_EVIDENCE_ARRAYS.flatMap((key) =>
			["current", "baseline"].flatMap((boundary) =>
				["deleted", "undefined", "null", "object", "string", "number"].map((attack) => ({ key, boundary, attack })),
			),
		),
	)("rejects $boundary $key $attack and preserves existing evidence", ({ key, boundary, attack }) => {
		const { rpc, acp } = controls();
		const history = structuredClone(baseline);
		const dir = mkdtempSync(join(tmpdir(), "prime-arrays-"));
		try {
			writePrime097Diagnostics(join(dir, ".artifacts"), rpc, acp, history);
			publishPrime097(join(dir, "reference"), rpc, acp, history);
			const paths = [
				join(dir, ".artifacts", "evidence.json"),
				join(dir, ".artifacts", "report.json"),
				join(dir, "reference", "0.9.7", "report.json"),
			];
			const before = paths.map((path) => readFileSync(path));
			const run = boundary === "current" ? rpc[0]! : history[0]!;
			if (attack === "deleted") Reflect.deleteProperty(run, key);
			else
				Object.assign(run, {
					[key]:
						attack === "undefined"
							? undefined
							: attack === "null"
								? null
								: attack === "object"
									? {}
									: attack === "string"
										? "private_without_sentinel"
										: 1,
				});
			expect(rpcPrivacyShapeProblems(run).length).toBeGreaterThan(0);
			if (boundary === "current") expect(assessPrime097(rpc, acp).invalid.length).toBeGreaterThan(0);
			for (const target of [join(dir, ".artifacts"), join(dir, "new-diagnostics")])
				expect(() => writePrime097Diagnostics(target, rpc, acp, history)).toThrow("nothing written");
			for (const target of [join(dir, "reference"), join(dir, "new-reference")])
				expect(() => publishPrime097(target, rpc, acp, history)).toThrow("refused");
			expect(paths.map((path) => readFileSync(path))).toEqual(before);
			expect(readdirSync(dir).sort()).toEqual([".artifacts", "reference"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("publishes readable complete envelopes with byte-identical report regeneration", () => {
		const { rpc, acp } = controls();
		const dir = mkdtempSync(join(tmpdir(), "prime-readback-"));
		try {
			publishPrime097(dir, rpc, acp, baseline);
			const path = join(dir, "0.9.7");
			const regenerated = buildPrime097Report(
				readPrimeFixturesV0(join(path, "rpc")),
				readAcpFixtures(join(path, "acp")),
				baseline,
			);
			expect(`${JSON.stringify(regenerated, null, "\t")}\n`).toBe(readFileSync(join(path, "report.json"), "utf8"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
