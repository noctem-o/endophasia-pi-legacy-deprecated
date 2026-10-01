// PR #26 fourth Codex review: baseline privacy and decoder-derived metadata uniqueness.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpPrivacyShapeProblems } from "../research/prime-conformance/acp-validation.ts";
import { assessPrime097, publishPrime097 } from "../research/prime-conformance/comparison.ts";
import { writePrime097Diagnostics } from "../research/prime-conformance/diagnostics.ts";
import { SENTINELS } from "../research/prime-conformance/fake-provider.ts";
import { rpcPrivacyShapeProblems } from "../research/prime-conformance/privacy-shape.ts";
import { baseline, controls } from "./prime-097-controls.ts";

type Attack = { index: number; path: (string | number)[]; label: string };
const attacks: Attack[] = [];
const seen = new Set<string>();
for (const [index, run] of baseline.entries()) {
	const walk = (value: unknown, path: (string | number)[]): void => {
		if (typeof value === "string") {
			const label = path.filter((part) => typeof part === "string").join(".");
			if (!seen.has(label)) {
				seen.add(label);
				attacks.push({ index, path, label });
			}
		} else if (Array.isArray(value))
			value.forEach((item, i) => {
				walk(item, [...path, i]);
			});
		else if (value !== null && typeof value === "object")
			for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
	};
	walk(run, []);
}

describe("PR #26 every baseline input passes the diagnostic privacy boundary", () => {
	it.each(attacks)("refuses nonsentinel private baseline $label before any filesystem mutation", ({ index, path }) => {
		const b = structuredClone(baseline);
		const { rpc, acp } = controls();
		let target: object = b[index]!;
		for (const part of path.slice(0, -1)) target = Reflect.get(target, part) as object;
		Reflect.set(target, path.at(-1)!, "private_customer_value");
		expect(b.flatMap(rpcPrivacyShapeProblems).length).toBeGreaterThan(0);
		const dir = mkdtempSync(join(tmpdir(), "prime-baseline-private-"));
		try {
			expect(() => writePrime097Diagnostics(join(dir, ".artifacts"), rpc, acp, b)).toThrow(
				"privacy/shape violation; nothing written",
			);
			expect(() => publishPrime097(join(dir, "reference"), rpc, acp, b)).toThrow("refused");
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each(["provider stop reason", "sentinel", "private field", "empty failure list", "empty protocol list"])(
		"preserves existing diagnostic bytes on baseline attack: %s",
		(attack) => {
			const b = structuredClone(baseline);
			const { rpc, acp } = controls();
			const failed = b.find((run) => run.provenance.scenario === "provider-failure")!;
			const end = failed.events.find((event) => event.type === "agent_end")!;
			if (attack === "provider stop reason" && end.type === "agent_end")
				Reflect.set(end, "assistantStopReasons", ["private_customer_value"]);
			if (attack === "sentinel") Object.assign(failed, { description: SENTINELS.prompt });
			if (attack === "private field") Object.assign(failed, { privateField: "private_customer_value" });
			if (attack === "empty failure list") Object.assign(failed, { failures: ["private_customer_value"] });
			if (attack === "empty protocol list") Object.assign(failed, { protocolErrors: ["private_customer_value"] });
			const dir = mkdtempSync(join(tmpdir(), "prime-baseline-existing-"));
			try {
				const output = join(dir, ".artifacts");
				writePrime097Diagnostics(output, rpc, acp, baseline);
				const bytes = ["evidence.json", "report.json"].map((name) => readFileSync(join(output, name)));
				expect(() => writePrime097Diagnostics(output, rpc, acp, b)).toThrow("nothing written");
				expect(readdirSync(output).sort()).toEqual(["evidence.json", "report.json"]);
				for (const [i, name] of ["evidence.json", "report.json"].entries())
					expect(readFileSync(join(output, name))).toEqual(bytes[i]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
	it("keeps safe semantic failures available for diagnostic comparison", () => {
		const b = structuredClone(baseline);
		const { rpc, acp } = controls();
		Object.assign(b[0]!, { observations: { ...b[0]!.observations, providerRequests: 999 } });
		acp[0]!.providerRequests = 999;
		expect(b.flatMap(rpcPrivacyShapeProblems)).toEqual([]);
		expect(acp.flatMap(acpPrivacyShapeProblems)).toEqual([]);
		const dir = mkdtempSync(join(tmpdir(), "prime-baseline-safe-failure-"));
		try {
			const report = writePrime097Diagnostics(join(dir, ".artifacts"), rpc, acp, b);
			expect(report.assessment.invalid.length).toBeGreaterThan(0);
			expect(report.privacyViolations).toEqual([]);
			expect(readdirSync(join(dir, ".artifacts")).sort()).toEqual(["evidence.json", "report.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const metadataFields = [...new Set(controls().acp.flatMap((run) => run.updates.flatMap((update) => update.metaKeys)))];
describe("PR #26 ACP metadata inventory matches Object.keys uniqueness", () => {
	it.each(metadataFields)("rejects duplicated %s even when repeated uniformly", (field) => {
		const { rpc, acp } = controls();
		for (const run of acp)
			for (const update of run.updates) if (update.metaKeys.includes(field)) update.metaKeys.push(field);
		expect(acp.flatMap(acpPrivacyShapeProblems)).toEqual([]);
		expect(
			assessPrime097(rpc, acp).invalid.some((problem) =>
				problem.includes("ACP metadata inventory contains duplicate keys"),
			),
		).toBe(true);
		const dir = mkdtempSync(join(tmpdir(), "prime-duplicate-meta-"));
		try {
			expect(() => publishPrime097(join(dir, "reference"), rpc, acp, baseline)).toThrow("refused");
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("accepts unique inventories in any order", () => {
		const { rpc, acp } = controls();
		for (const run of acp) for (const update of run.updates) update.metaKeys.reverse();
		expect(assessPrime097(rpc, acp)).toEqual({ invalid: [], unpublishable: [] });
	});
});
