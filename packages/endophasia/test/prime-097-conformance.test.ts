// Every test uses committed, payload-minimal evidence. Normal CI never resolves or executes Prime.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AcpScenarioEvidence } from "../research/prime-conformance/acp-evidence.ts";
import { ACP_SCENARIOS } from "../research/prime-conformance/acp-probe.ts";
import { acpEvidenceProblems, acpUsageScriptMatches } from "../research/prime-conformance/acp-validation.ts";
import { auditedProvenance, PRIME_097 } from "../research/prime-conformance/audited.ts";
import {
	assessPrime097,
	buildPrime097Report,
	CAPABILITIES,
	publishPrime097,
	readAcpFixtures,
} from "../research/prime-conformance/comparison.ts";
import type { PrimeProvenanceV0, PrimeScenarioEvidenceV0 } from "../research/prime-conformance/evidence.ts";
import { SENTINELS } from "../research/prime-conformance/fake-provider.ts";
import { researchInstrumentHash } from "../research/prime-conformance/instrument.ts";
import { scenarioInvariantProblemsV0 } from "../research/prime-conformance/invariants.ts";
import {
	buildPrimeConformanceReportV0,
	readPrimeFixturesV0,
	scanForSentinelsV0,
	writePrimeFixturesV0,
} from "../research/prime-conformance/report.ts";

const root = fileURLToPath(new URL("./fixtures/prime", import.meta.url));
const baseline = readPrimeFixturesV0(join(root, "0.9.6"));
const rpc = readPrimeFixturesV0(join(root, "0.9.7", "rpc"));
const acp = readAcpFixtures(join(root, "0.9.7", "acp"));
function fixture(name: string): AcpScenarioEvidence {
	return structuredClone(acp.find((r) => r.provenance.scenario === name)!);
}
function replace(run: AcpScenarioEvidence): AcpScenarioEvidence[] {
	return acp.map((r) => (r.provenance.scenario === run.provenance.scenario ? run : structuredClone(r)));
}
function provenance(change: Partial<PrimeProvenanceV0>) {
	return rpc.map((r) => ({ ...structuredClone(r), provenance: { ...r.provenance, ...change } }));
}

describe("audited historical/current profiles", () => {
	it("keeps both reference profiles established without retagging history", () => {
		expect(baseline.every((r) => r.provenance.probeVersion === "0.13.0" && auditedProvenance(r.provenance))).toBe(
			true,
		);
		expect(rpc.every((r) => r.provenance.probeVersion === "0.14.4" && auditedProvenance(r.provenance))).toBe(true);
		for (const set of [baseline, rpc])
			expect(buildPrimeConformanceReportV0(set).findings.every((f) => f.basis === "established")).toBe(true);
		expect(buildPrimeConformanceReportV0(rpc, { reference: baseline[0]!.provenance }).drift).toMatchObject({
			runtime: "different",
			probe: "different",
			environment: "different",
		});
	});
	it("binds the captured research build to the committed probe source", () => {
		expect(rpc[0]!.provenance.researchHash).toBe(researchInstrumentHash());
	});
	it.each([
		["same version, wrong commit", { commit: "0".repeat(40) }],
		["historical commit on new version", { commit: baseline[0]!.provenance.commit }],
		["historical probe on new version", { probeVersion: "0.13.0" }],
		["missing artifact identity", { artifactsHash: undefined }],
		["missing research identity", { researchHash: undefined }],
		["dirty Endophasia instrument", { endophasiaBuild: "dirty-checkout" }],
		["missing Endophasia cleanliness", { endophasiaBuild: undefined }],
		["old 0.14.0 instrument", { probeVersion: "0.14.0" }],
		["old 0.14.2 instrument", { probeVersion: "0.14.2" }],
		["old 0.14.3 instrument", { probeVersion: "0.14.3" }],
		["dirty checkout", { build: "dirty-checkout" }],
		["unknown checkout", { build: "unverified-checkout" }],
		["unverified executable", { build: "binary", commit: undefined }],
	] as const)("withdraws classifications and publication for %s", (_name, change) => {
		const set = provenance(change as Partial<PrimeProvenanceV0>);
		expect(buildPrimeConformanceReportV0(set).findings.every((f) => f.basis === "unverified")).toBe(true);
		expect(assessPrime097(set, acp).unpublishable.length).toBeGreaterThan(0);
	});
	it("rejects version/probe swaps in both directions", () => {
		const toOld = provenance({ version: "0.9.6", commit: baseline[0]!.provenance.commit });
		expect(buildPrimeConformanceReportV0(toOld).facts.auditedRevision).toBeUndefined();
		const toNew = baseline.map((r) => ({ ...r, provenance: { ...r.provenance, ...PRIME_097 } }));
		expect(buildPrimeConformanceReportV0(toNew).facts.auditedRevision).toBeUndefined();
		expect(assessPrime097([...rpc.slice(1), baseline[0]!], acp).invalid.length).toBeGreaterThan(0);
	});
	it("never decodes one boundary as the other", () => {
		expect(() => readPrimeFixturesV0(join(root, "0.9.7", "acp"))).toThrow();
		expect(() => readAcpFixtures(join(root, "0.9.7", "rpc"))).toThrow();
		expect(() => buildPrimeConformanceReportV0(acp as unknown as PrimeScenarioEvidenceV0[])).toThrow();
		expect(acpEvidenceProblems(rpc[0])).not.toEqual([]);
	});
});

describe("committed 0.9.7 evidence and capability matrix", () => {
	it("offline regeneration is byte-identical, including with reversed boundary inputs", () => {
		const committed = readFileSync(join(root, "0.9.7", "report.json"), "utf8").replace(/\r\n/g, "\n");
		for (const [r, a] of [
			[rpc, acp],
			[[...rpc].reverse(), [...acp].reverse()],
		] as const)
			expect(`${JSON.stringify(buildPrime097Report(r, a, baseline), null, "\t")}\n`).toBe(committed);
		expect(
			execFileSync(
				process.execPath,
				[fileURLToPath(new URL("../research/prime-conformance/offline-097.ts", import.meta.url))],
				{ encoding: "utf8" },
			),
		).toBe(committed);
	});
	it.each(rpc.map((r) => [r.provenance.scenario, r] as const))(
		"RPC %s retains every old scenario invariant",
		(_name, run) => expect(scenarioInvariantProblemsV0(run)).toEqual([]),
	);
	it.each(acp.map((r) => [r.provenance.scenario, r] as const))(
		"ACP %s passes structure, correlation, scripts and privacy",
		(_name, run) => {
			expect(acpEvidenceProblems(run)).toEqual([]);
			expect(acpUsageScriptMatches(run)).toBe(true);
			expect(scanForSentinelsV0("ACP", run)).toEqual([]);
		},
	);
	it("contains every requested scenario with one shared build", () => {
		expect(acp.map((r) => r.provenance.scenario).sort()).toEqual(ACP_SCENARIOS.map((s) => s.name).sort());
		expect(assessPrime097(rpc, acp)).toEqual({ invalid: [], unpublishable: [] });
	});
	it("reports all six existing capabilities on separate boundaries and admits none", () => {
		const report = buildPrime097Report(rpc, acp, baseline);
		expect(report.capabilities.map((c) => c.contract)).toEqual(CAPABILITIES);
		expect(
			report.capabilities.every(
				(c) =>
					c.rpc.basis === "established" &&
					c.acp.basis === "established" &&
					c.missing.length > 0 &&
					c.durable.exactProjection === "unverified",
			),
		).toBe(true);
		expect(report.capabilities.some((c) => c.rpc.semanticFit === "exact" || c.acp.semanticFit === "exact")).toBe(
			false,
		);
		expect(report.candidateForPR27).toEqual([]);
		expect(report.privacyViolations).toEqual([]);
		expect(report.acp.facts).toMatchObject({
			lengthStop: "end_turn",
			providerFailure: "error",
			tokenLimitStop: "max_tokens",
			turnLimitStop: "max_turn_requests",
			gateFailureObserved: true,
			providerUsageDecodedExactly: true,
			closeRecreate: { acpSessions: 2, durableSessions: 1 },
		});
		expect(report.acp.facts.initialize?.capabilityFlags.loadSession).toBe(false);
		expect(report.acp.facts.initialize?.primeMetaKeys).toEqual([]);
	});
	it("does not invent durable ids, cursors, model completions or terminal success", () => {
		const recreate = fixture("close-recreate");
		expect(recreate.updates.filter((u) => u.eventSequence === 1).length).toBe(2);
		expect(new Set(recreate.updates.map((u) => u.promptTurnId))).toEqual(new Set([1]));
		expect(fixture("reasoning-usage").updates.map((u) => u.kind)).toContain("agent_thought_chunk");
		for (const name of ["cancel-stream", "cancel-tool"])
			expect(fixture(name).updates.some((u) => u.phase === "terminalQuiescence")).toBe(false);
		const gate = fixture("gate-failure");
		expect(gate.prompts[0]?.response).toBe("result");
		expect(gate.updates.at(-1)?.quiescence?.remainingAutonomousContinuations).toBeGreaterThan(0);
	});
	it("treats valid changed numbers/stop reasons as drift evidence", () => {
		const changed = fixture("simple");
		changed.prompts[0]!.stopReason = "refusal";
		const assistant = changed.files.flat().find((e) => e.role === "assistant")!;
		const copy = { ...assistant, usage: { ...assistant.usage!, output: 41 } };
		changed.files = changed.files.map((file) => file.map((e) => (e === assistant ? copy : e)));
		expect(acpEvidenceProblems(changed)).toEqual([]);
		expect(acpUsageScriptMatches(changed)).toBe(false);
		expect(assessPrime097(rpc, replace(changed))).toEqual({ invalid: [], unpublishable: [] });
		expect(
			buildPrime097Report(rpc, replace(changed), baseline).capabilities.find(
				(c) => c.contract === "RuntimeMetricsV0",
			)?.durable.basis,
		).toBe("contradicted");
	});
});

describe("ACP publication adversaries", () => {
	const mutations: [string, string, (run: AcpScenarioEvidence) => void][] = [
		[
			"simple",
			"duplicate producer sequence",
			(r) => {
				r.updates[1]!.eventSequence = 1;
			},
		],
		[
			"simple",
			"sequence gap",
			(r) => {
				r.updates[1]!.eventSequence = 9;
			},
		],
		[
			"simple",
			"missing response boundary",
			(r) => {
				r.updates = r.updates.filter((u) => u.phase !== "responseBoundary");
			},
		],
		[
			"simple",
			"contradictory terminal",
			(r) => {
				r.updates.at(-1)!.outcome = "error";
			},
		],
		[
			"simple",
			"unknown prompt identity",
			(r) => {
				r.updates[0]!.promptTurnId = 99;
			},
		],
		[
			"simple",
			"unknown session identity",
			(r) => {
				r.updates[0]!.sessionId = "00000000-0000-4000-8000-000000000001";
			},
		],
		[
			"simple",
			"late update after terminal",
			(r) => {
				r.updates.push({ ...r.updates[0]!, eventSequence: 5 });
			},
		],
		[
			"simple",
			"unreconciled child",
			(r) => {
				r.updates.at(-1)!.quiescence!.outstandingSubagents = 1;
			},
		],
		[
			"simple",
			"missing terminal promise",
			(r) => {
				r.updates[1]!.terminalQuiescenceExpected = false;
			},
		],
		[
			"simple",
			"missing close",
			(r) => {
				r.commands = r.commands.filter((c) => c.method !== "session/close");
			},
		],
		[
			"simple",
			"missing prompt result",
			(r) => {
				r.prompts = [];
			},
		],
		[
			"simple",
			"provider request mismatch",
			(r) => {
				r.providerRequests = 17;
			},
		],
		[
			"simple",
			"missing durable file",
			(r) => {
				r.files = [];
			},
		],
		[
			"tool-run",
			"tool completion without start",
			(r) => {
				r.updates[0]!.kind = "session_info_update";
			},
		],
		[
			"tool-run",
			"cross-prompt tool",
			(r) => {
				r.updates[1]!.promptTurnId = 0;
			},
		],
		[
			"tool-run",
			"missing tool identity",
			(r) => {
				delete r.updates[0]!.toolCallId;
			},
		],
		[
			"cancel-stream",
			"missing local cancel witness",
			(r) => {
				r.cancelAfter = [];
			},
		],
		[
			"compaction",
			"missing compaction summary count",
			(r) => {
				r.summaryRequests = 0;
			},
		],
		[
			"simple",
			"protocol failure",
			(r) => {
				r.protocolErrors.push("bad framing");
			},
		],
		[
			"simple",
			"scenario failure",
			(r) => {
				r.failures.push("request timed out");
			},
		],
		[
			"simple",
			"sentinel in structural names",
			(r) => {
				r.updates[0]!.metaKeys.push(SENTINELS.prompt);
			},
		],
	];
	it.each(mutations)("refuses %s: %s", (name, _why, mutate) => {
		const run = fixture(name);
		mutate(run);
		expect(assessPrime097(rpc, replace(run)).invalid.length).toBeGreaterThan(0);
	});
	it.each([
		"artifactsHash",
		"launcherHash",
		"lockHash",
		"researchHash",
		"endophasiaCommit",
		"commit",
		"probeVersion",
		"node",
		"platform",
	] as const)("rejects cross-boundary %s mismatch", (key) => {
		const run = fixture("simple");
		run.provenance = { ...run.provenance, [key]: "different" };
		const result = assessPrime097(rpc, replace(run));
		expect(result.invalid.length + result.unpublishable.length).toBeGreaterThan(0);
	});
	it.each(["content", "rawInput", "rawOutput", "summary", "error", "arbitraryMeta"])(
		"rejects unapproved payload slot %s even without a sentinel",
		(field) => {
			const run = fixture("simple");
			const poisoned = { ...run, [field]: "private content" };
			expect(acpEvidenceProblems(poisoned)).not.toEqual([]);
		},
	);
	it.each(["content", "arguments", "summary", "rawInput", "payload"])(
		"refuses RPC payload slot %s without requiring a sentinel",
		(field) => {
			const poisoned = rpc.map((run, i) => (i === 0 ? { ...run, [field]: "private content" } : run));
			expect(assessPrime097(poisoned, acp).invalid.length).toBeGreaterThan(0);
		},
	);
	it("refuses partial, mixed and duplicate fixture sets before filesystem writes", () => {
		const dir = join(mkdtempSync(join(tmpdir(), "prime-joint-")), "fixtures");
		try {
			for (const set of [acp.slice(1), [...acp, acp[0]!]])
				expect(() => publishPrime097(dir, rpc, set, baseline)).toThrow("refused");
			expect(existsSync(dir)).toBe(false);
			expect(() => writePrimeFixturesV0(dir, rpc)).toThrow("joint");
			expect(existsSync(dir)).toBe(false);
		} finally {
			rmSync(join(dir, ".."), { recursive: true, force: true });
		}
	});
	it("publishes and refreshes only a whole assessed set, preserving 0.9.6", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-joint-"));
		try {
			publishPrime097(dir, rpc, acp, baseline);
			publishPrime097(dir, rpc, acp, baseline);
			expect(readAcpFixtures(join(dir, "0.9.7", "acp"))).toEqual(acp);
			expect(readPrimeFixturesV0(join(dir, "0.9.7", "rpc"))).toEqual(rpc);
			expect(readdirSync(dir)).toEqual(["0.9.7"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
