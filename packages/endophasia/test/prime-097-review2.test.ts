// PR #26 second Codex review: every finding has a hostile mutation, with safe semantic drift as the control.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpPrivacyShapeProblems } from "../research/prime-conformance/acp-validation.ts";
import { auditedProvenance } from "../research/prime-conformance/audited.ts";
import { assessPrime097, buildPrime097Report, publishPrime097 } from "../research/prime-conformance/comparison.ts";
import { writePrime097Diagnostics } from "../research/prime-conformance/diagnostics.ts";
import { PROBE_VERSION } from "../research/prime-conformance/evidence.ts";
import { rpcPrivacyShapeProblems } from "../research/prime-conformance/privacy-shape.ts";
import { buildPrimeConformanceReportV0 } from "../research/prime-conformance/report.ts";
import { baseline, controls } from "./prime-097-controls.ts";

describe("PR #26 exact audited subject build", () => {
	it.each(["artifactsHash", "launcherHash", "lockHash"] as const)(
		"refuses a uniform forged %s across every boundary",
		(key) => {
			const { rpc, acp } = controls();
			expect(assessPrime097(rpc, acp)).toEqual({ invalid: [], unpublishable: [] });
			for (const run of [...rpc, ...acp]) Object.assign(run.provenance, { [key]: "0".repeat(64) });
			expect(rpc.every((run) => !auditedProvenance(run.provenance))).toBe(true);
			expect(buildPrimeConformanceReportV0(rpc).findings.every((f) => f.basis === "unverified")).toBe(true);
			expect(assessPrime097(rpc, acp).unpublishable.length).toBeGreaterThan(0);
		},
	);
	it("renders the current probe identity when the audited requirement is missing", () => {
		const { rpc } = controls();
		for (const run of rpc) Object.assign(run.provenance, { artifactsHash: "0".repeat(64) });
		for (const finding of buildPrimeConformanceReportV0(rpc).findings) {
			expect(finding.missing).toContain(
				`Prime 0.9.7 @ 08ff1b2e (the audited revision), clean checkout and probe ${PROBE_VERSION}`,
			);
			expect(finding.missing.join(" ")).not.toContain("0.14.0");
		}
	});
});

// One mutation for every distinct approved string/list-string slot, including nested entries and initializer fields.
type Attack = { boundary: "rpc" | "acp"; index: number; path: (string | number)[]; label: string };
const stringAttacks: Attack[] = [];
const seen = new Set<string>();
for (const boundary of ["rpc", "acp"] as const) {
	for (const [index, run] of controls()[boundary].entries()) {
		const walk = (value: unknown, path: (string | number)[]): void => {
			if (typeof value === "string") {
				const label = `${boundary}.${path.filter((p) => typeof p === "string").join(".")}`;
				if (!seen.has(label)) {
					seen.add(label);
					stringAttacks.push({ boundary, index, path, label });
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
}
describe("PR #26 approved-slot privacy attacks", () => {
	it.each(stringAttacks)("never persists private text in $label", ({ boundary, index, path }) => {
		const { rpc, acp } = controls();
		let target: object = (boundary === "rpc" ? rpc : acp)[index]!;
		for (const part of path.slice(0, -1)) target = Reflect.get(target, part) as object;
		Reflect.set(target, path.at(-1)!, "private prompt without a sentinel");
		expect(
			(boundary === "rpc" ? rpc.flatMap(rpcPrivacyShapeProblems) : acp.flatMap(acpPrivacyShapeProblems)).length,
		).toBeGreaterThan(0);
		const temp = mkdtempSync(join(tmpdir(), "prime-scalar-"));
		try {
			expect(() => writePrime097Diagnostics(join(temp, ".artifacts"), rpc, acp, baseline)).toThrow(
				"nothing written",
			);
			expect(() => publishPrime097(join(temp, "fixtures"), rpc, acp, baseline)).toThrow("refused");
			expect(readdirSync(temp)).toEqual([]);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
	it("refuses an arbitrary capability flag key", () => {
		const { acp } = controls();
		acp[0]!.initialize!.capabilityFlags["private prompt without a sentinel"] = true;
		expect(acpPrivacyShapeProblems(acp[0])).not.toEqual([]);
	});
	it.each([
		"RPC failures",
		"RPC protocolErrors",
		"RPC extraKeys",
		"ACP failures",
		"ACP protocolErrors",
		"ACP extraKeys",
		"ACP primeMetaKeys",
	])("refuses private text in initially empty %s lists", (slot) => {
		const { rpc, acp } = controls();
		const secret = "private prompt without a sentinel";
		if (slot === "RPC failures") Object.assign(rpc[0]!, { failures: [secret] });
		if (slot === "RPC protocolErrors") Object.assign(rpc[0]!, { protocolErrors: [secret] });
		if (slot === "RPC extraKeys")
			Object.assign(rpc[0]!.sessionEntries.find((e) => e.usage)!.usage!, { extraKeys: [secret] });
		if (slot === "ACP failures") acp[0]!.failures.push(secret);
		if (slot === "ACP protocolErrors") acp[0]!.protocolErrors.push(secret);
		if (slot === "ACP extraKeys")
			Object.assign(acp[0]!.files.flat().find((e) => e.usage)!.usage!, { extraKeys: [secret] });
		if (slot === "ACP primeMetaKeys") acp[0]!.initialize!.primeMetaKeys.push(secret);
		const temp = mkdtempSync(join(tmpdir(), "prime-empty-private-"));
		try {
			expect(() => writePrime097Diagnostics(join(temp, ".artifacts"), rpc, acp, baseline)).toThrow(
				"nothing written",
			);
			expect(readdirSync(temp)).toEqual([]);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});

describe("PR #26 ACP lifecycle and unsupported request witnesses", () => {
	it.each([
		"missing new",
		"duplicate new",
		"swapped slots",
		"missing prompt",
		"wrong prompt slot",
		"wrong ordinal",
		"wrong response",
		"extra initialize",
	])("rejects %s", (attack) => {
		const { rpc, acp } = controls();
		const run = acp.find((r) => r.provenance.scenario === "close-recreate")!;
		const news = run.commands.filter((c) => c.method === "session/new");
		const prompt = run.commands.find((c) => c.method === "session/prompt")!;
		if (attack === "missing new") run.commands = run.commands.filter((c) => c.method !== "session/new");
		if (attack === "duplicate new") run.commands.splice(1, 0, { ...news[0]! });
		if (attack === "swapped slots") {
			news[0]!.sessionId = run.sessionIds[1];
			news[1]!.sessionId = run.sessionIds[0];
		}
		if (attack === "missing prompt") run.commands = run.commands.filter((c) => c !== prompt);
		if (attack === "wrong prompt slot") prompt.sessionId = run.sessionIds[1];
		if (attack === "wrong ordinal") prompt.ordinal = 2;
		if (attack === "wrong response") {
			prompt.success = false;
			prompt.errorCode = -32603;
		}
		if (attack === "extra initialize") run.commands.unshift({ method: "initialize", success: true });
		expect(assessPrime097(rpc, acp).invalid).toContain(
			"ACP close-recreate: ACP request lifecycle/prompt/rejection witnesses incomplete or uncorrelated",
		);
	});
	it.each(["session/new", "session/load", "session/prompt"])(
		"requires the exact unsupported %s method, slot and error",
		(method) => {
			for (const attack of ["method", "code", "session", "missing", "duplicate"]) {
				const { rpc, acp } = controls();
				const run = acp.find((r) => r.provenance.scenario === "unsupported-requests")!;
				const command = run.commands.find((c) => c.method === method && !c.success)!;
				if (attack === "method") command.method = method === "session/load" ? "session/new" : "session/load";
				if (attack === "code") command.errorCode = -32602;
				if (attack === "session") command.sessionId = "00000000-0000-4000-8000-000000000001";
				if (attack === "missing") run.commands = run.commands.filter((c) => c !== command);
				if (attack === "duplicate") run.commands.push({ ...command });
				expect(assessPrime097(rpc, acp).invalid).toContain(
					"ACP unsupported-requests: ACP request lifecycle/prompt/rejection witnesses incomplete or uncorrelated",
				);
			}
		},
	);
});

describe("PR #26 ACP initialize consistency and bilateral metadata", () => {
	it.each(["flag", "capability field", "agentInfo keys", "namespace", "Prime meta key"])(
		"rejects later initialize %s drift and reports it explicitly",
		(attack) => {
			const { rpc, acp } = controls();
			const init = acp.find((r) => r.provenance.scenario === "tool-run")!.initialize!;
			if (attack === "flag") init.capabilityFlags.loadSession = true;
			if (attack === "capability field") init.capabilityFields.push("promptCapabilities.audio");
			if (attack === "agentInfo keys") init.agentInfoKeys = ["name", "version"];
			if (attack === "namespace") init.metaNamespaces = [];
			if (attack === "Prime meta key") init.primeMetaKeys.push("autonomous");
			expect(assessPrime097(rpc, acp).invalid).toContain(
				"ACP initialize capabilities/metadata differ across scenarios",
			);
			const report = buildPrime097Report(rpc, acp, baseline);
			expect(report.acp.facts.initialize).toBeUndefined();
			expect(report.acp.facts.initializeConsistent).toBe(false);
			expect(report.acp.scenarios.find((r) => r.scenario === "tool-run")!.initialize).toEqual(init);
		},
	);
	it("keeps a consistent changed capability flag as inspectable evidence", () => {
		const { rpc, acp } = controls();
		for (const run of acp) run.initialize!.capabilityFlags.loadSession = true;
		expect(assessPrime097(rpc, acp)).toEqual({ invalid: [], unpublishable: [] });
		expect(buildPrime097Report(rpc, acp, baseline).acp.facts.initialize?.capabilityFlags.loadSession).toBe(true);
	});
	it("initialize comparison is independent of map and inventory order", () => {
		const { rpc, acp } = controls();
		for (const run of acp) {
			const init = run.initialize!;
			init.capabilityFlags = Object.fromEntries(Object.entries(init.capabilityFlags).reverse());
			init.capabilityFields.reverse();
		}
		expect(assessPrime097(rpc, acp)).toEqual({ invalid: [], unpublishable: [] });
	});
	it.each(["outcome", "terminalQuiescenceExpected", "autonomous", "quiescence", "compaction"] as const)(
		"requires %s presence in metadata in both directions",
		(field) => {
			for (const attack of ["missing key", "missing value", "invented key"]) {
				const { rpc, acp } = controls();
				const run = acp.find(
					(r) => r.provenance.scenario === (field === "compaction" ? "compaction" : "gate-failure"),
				)!;
				const u = run.updates.find((update) => update[field] !== undefined)!;
				if (attack === "missing key") u.metaKeys = u.metaKeys.filter((key) => key !== field);
				if (attack === "missing value") Reflect.deleteProperty(u, field);
				if (attack === "invented key") {
					const first = run.updates.find((update) => update[field] === undefined)!;
					first.metaKeys.push(field);
				}
				expect(assessPrime097(rpc, acp).invalid).toContain(
					`ACP ${run.provenance.scenario}: ACP metadata keys contradict recorded fields`,
				);
			}
		},
	);
});

describe("PR #26 indivisible fixture/report publication", () => {
	it.each([false, true])("rejects missing/invalid baseline before filesystem mutation (existing=%s)", (existing) => {
		const { rpc, acp } = controls();
		const temp = mkdtempSync(join(tmpdir(), "prime-baseline-"));
		const output = join(temp, "reference");
		try {
			if (existing) publishPrime097(output, rpc, acp, baseline);
			const report = existing ? readFileSync(join(output, "0.9.7", "report.json"), "utf8") : undefined;
			for (const bad of [undefined, [], baseline.slice(1), [{ ...baseline[0]!, description: "private text" }]]) {
				expect(() => Reflect.apply(publishPrime097, undefined, [output, rpc, acp, bad])).toThrow("refused");
				expect(existsSync(output)).toBe(existing);
				expect(readdirSync(temp)).toEqual(existing ? ["reference"] : []);
				if (existing) {
					expect(readFileSync(join(output, "0.9.7", "report.json"), "utf8")).toBe(report);
					expect(readdirSync(output)).toEqual(["0.9.7"]);
					expect(readdirSync(join(output, "0.9.7", "rpc"))).toHaveLength(12);
					expect(readdirSync(join(output, "0.9.7", "acp"))).toHaveLength(15);
				}
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
