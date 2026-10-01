// PR #26 review 5377775683: accounting coverage, durable prompt roles, required RPC description.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpEvidenceProblems, acpUsageScriptMatches } from "../research/prime-conformance/acp-validation.ts";
import { assessPrime097, buildPrime097Report, publishPrime097 } from "../research/prime-conformance/comparison.ts";
import { decodePrimeSessionLineV0 } from "../research/prime-conformance/decode.ts";
import { writePrime097Diagnostics } from "../research/prime-conformance/diagnostics.ts";
import { entryProblems } from "../research/prime-conformance/evidence.ts";
import { rpcPrivacyShapeProblems } from "../research/prime-conformance/privacy-shape.ts";
import { baseline, controls } from "./prime-097-controls.ts";

describe("PR #26 unretained outer accounting", () => {
	it.each(
		["rpc", "acp"].flatMap((mode) =>
			["session", "message"].flatMap((type) =>
				["usage", "cost", "childUsage", "aggregateUsage"].map((key) => ({ mode, type, key })),
			),
		),
	)("rejects $mode $type wire $key", ({ mode, type, key }) => {
		const { rpc, acp } = controls();
		const entries = mode === "rpc" ? rpc[0]!.sessionEntries : acp[0]!.files.flat();
		for (const entry of entries.filter((e) => e.type === type)) Object.assign(entry, { keys: [...entry.keys, key] });
		expect(assessPrime097(rpc, acp).invalid.some((p) => p.includes("unretained accounting"))).toBe(true);
	});
	it.each(
		[
			"session",
			"message",
			"compaction",
			"branch_summary",
			"child_usage_attributed",
			"model_change",
			"service_tier_change",
			"session_state",
			"thinking_level_change",
			"custom_message",
			"new_entry",
		].flatMap((type) =>
			["usage", "cost", "childUsage", "aggregateUsage"]
				.filter(
					(key) =>
						!(["compaction", "branch_summary"].includes(type) && key === "usage") &&
						!(type === "child_usage_attributed" && ["childUsage", "aggregateUsage"].includes(key)),
				)
				.map((key) => ({ type, key })),
		),
	)("decoder and evidence reject $type $key before dropping its value", ({ type, key }) => {
		const raw = { type, id: "00000001", parentId: null, [key]: { private: "non_sentinel_value" } };
		expect(() => decodePrimeSessionLineV0(JSON.stringify(raw), 1)).toThrow("unretained accounting");
		expect(
			entryProblems("attack", [{ type, id: "00000001", parentId: null, keys: Object.keys(raw) }]).some((p) =>
				p.includes("unretained accounting"),
			),
		).toBe(true);
	});
});

describe("PR #26 complete ACP accounting dependency", () => {
	it.each(["branch_summary", "child_usage_attributed", "user usage"])(
		"detects unscripted %s and isolates numeric contradiction",
		(type) => {
			const { rpc, acp } = controls();
			const run = acp.find((r) => r.provenance.scenario === "simple")!;
			const file = run.files[0]!;
			const usage = structuredClone(file.find((e) => e.role === "assistant")!.usage!);
			if (type === "user usage") Object.assign(file.find((e) => e.role === "user")!, { usage });
			else
				file.push(
					type === "branch_summary"
						? {
								type,
								id: "ffffffff",
								parentId: file.at(-1)!.id,
								usage,
								keys: ["type", "id", "parentId", "usage"],
							}
						: {
								type,
								id: "ffffffff",
								parentId: file.at(-1)!.id,
								targetId: file.at(-1)!.id,
								childUsage: usage,
								aggregateUsage: usage,
								keys: ["type", "id", "parentId", "targetId", "childUsage", "aggregateUsage"],
							},
				);
			expect(acpUsageScriptMatches(run)).toBe(false);
			if (type === "user usage") {
				expect(acpEvidenceProblems(run).some((p) => p.includes("no decoded accounting source"))).toBe(true);
				return;
			}
			expect(acpEvidenceProblems(run)).toEqual([]); // Complete numeric drift remains inspectable evidence.
			const report = buildPrime097Report(rpc, acp, baseline);
			expect(report.acp.facts.providerUsageDecodedExactly).toBe(false);
			for (const capability of report.capabilities)
				expect(capability.durable.basis).toBe(
					["RuntimeMetricsV0", "UsageLedgerRowV0"].includes(capability.contract) ? "contradicted" : "established",
				);
		},
	);
});

describe("PR #26 ACP durable messages witness each scripted prompt", () => {
	const cases = controls().acp.flatMap((run) =>
		run.files.flatMap((file, fileIndex) =>
			file.flatMap((entry, index) =>
				entry.type === "message" ? [{ scenario: run.provenance.scenario, fileIndex, index, role: entry.role }] : [],
			),
		),
	);
	it.each(cases)(
		"rejects deleting $scenario $role at $index even after repairing parents",
		({ scenario, fileIndex, index }) => {
			const { rpc, acp } = controls();
			const run = acp.find((r) => r.provenance.scenario === scenario)!;
			const file = run.files[fileIndex]!;
			const [removed] = file.splice(index, 1);
			for (const entry of file)
				if (entry.parentId === removed!.id) Object.assign(entry, { parentId: removed!.parentId });
			expect(acpEvidenceProblems(run)).toContain("ACP durable message roles do not witness the scripted prompts");
			expect(assessPrime097(rpc, acp).invalid.length).toBeGreaterThan(0);
		},
	);
	it.each(["tool-run", "multi-prompt", "close-recreate", "compaction"])(
		"rejects reordered roles in %s",
		(scenario) => {
			const { acp } = controls();
			const run = acp.find((r) => r.provenance.scenario === scenario)!;
			const messages = run.files.flat().filter((e) => e.type === "message");
			const first = messages[0]!.role;
			Object.assign(messages[0]!, { role: messages[1]!.role });
			Object.assign(messages[1]!, { role: first });
			expect(acpEvidenceProblems(run)).toContain("ACP durable message roles do not witness the scripted prompts");
		},
	);
});

describe("PR #26 required RPC description before any persistence", () => {
	it.each(["deleted", "undefined", "null", "number"])(
		"rejects %s description without writing diagnostics or references",
		(attack) => {
			const { rpc, acp } = controls();
			if (attack === "deleted") Reflect.deleteProperty(rpc[0]!, "description");
			else
				Object.assign(rpc[0]!, { description: attack === "undefined" ? undefined : attack === "null" ? null : 1 });
			expect(rpcPrivacyShapeProblems(rpc[0]!).length).toBeGreaterThan(0);
			expect(assessPrime097(rpc, acp).invalid.length).toBeGreaterThan(0);
			const dir = mkdtempSync(join(tmpdir(), "prime-description-"));
			try {
				expect(() => writePrime097Diagnostics(join(dir, ".artifacts"), rpc, acp, baseline)).toThrow(
					"nothing written",
				);
				expect(() => publishPrime097(join(dir, "reference"), rpc, acp, baseline)).toThrow("refused");
				expect(readdirSync(dir)).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
