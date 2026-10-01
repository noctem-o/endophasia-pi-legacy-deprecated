// Research report and the joint 0.9.7 publication gate. Never consumed by Runtime Profile or production ports.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcpScenarioEvidence } from "./acp-evidence.ts";
import { ACP_SCENARIOS } from "./acp-probe.ts";
import { acpEvidenceProblems, acpPrivacyShapeProblems, acpUsageScriptMatches } from "./acp-validation.ts";
import { auditedProvenance, PRIME_097 } from "./audited.ts";
import type { PrimeScenarioEvidenceV0 } from "./evidence.ts";
import { PROBE_NAME, PROBE_VERSION } from "./evidence.ts";
import { SCENARIO_NAMES_WITH_INVARIANTS } from "./invariants.ts";
import { assertPlainEvidence } from "./plain-data.ts";
import { rpcPrivacyShapeProblems } from "./privacy-shape.ts";
import { assessPrimeEvidenceV0, type PrimeEvidenceAssessmentV0 } from "./publication.ts";
import { installReferenceDirectory } from "./reference-swap.ts";
import { buildPrimeConformanceReportV0, scanForSentinelsV0 } from "./report.ts";

export const CAPABILITIES = [
	"SessionOverviewV0",
	"MissionTraceEventV0",
	"RuntimeMetricsV0",
	"OperationOutcomeV0",
	"UsageLedgerRowV0",
	"ContinuitySnapshotV0",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
const MISSING: Record<Capability, readonly string[]> = {
	SessionOverviewV0: [
		"atomic per-lane tip/operation topology",
		"durable operation id, kind, status, startedAt and captured model",
		"lane counts and aborting count",
	],
	MissionTraceEventV0: [
		"truthful complete worker-lifetime lifecycle including resume/suspend",
		"model completion and turn boundaries on ACP",
		"length termination distinct from successful completion",
	],
	RuntimeMetricsV0: [
		"cumulative spend survives compaction, retries, fork and reopen",
		"reported total is preserved separately from component arithmetic",
		"absent reasoning/cacheWrite1h stays absent; signed corrections and concurrency remain unproved",
	],
	OperationOutcomeV0: [
		"durable immutable registry keyed by native operation identity",
		"start/finish times, from/tip ids and machine error code",
		"null only for unknown or nonterminal operation, lookup after reopen",
	],
	UsageLedgerRowV0: [
		"session-global committed sequence across values and entries",
		"exclusive cursor pages, exact hasEarlier and race-free tail/live handoff",
		"stable allocation across fork, restart, whole-file rewrite and concurrent writers",
	],
	ContinuitySnapshotV0: [
		"Pi compaction-bounded source-entry context rather than assembled transcript",
		"retained-tail semantics and exact stable source sequences",
		"durable captured settings, topology, counts and timestamp identity",
	],
};

function identity(value: {
	provenance: PrimeScenarioEvidenceV0["provenance"] | AcpScenarioEvidence["provenance"];
}): string {
	const { mode: _mode, scenario: _scenario, ...p } = value.provenance;
	return JSON.stringify(Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))));
}

export function assessPrime097(
	rpc: readonly PrimeScenarioEvidenceV0[],
	acp: readonly AcpScenarioEvidence[],
): PrimeEvidenceAssessmentV0 {
	try {
		assertPlainEvidence({ rpc, acp });
	} catch {
		return { invalid: ["evidence is not plain data"], unpublishable: [] };
	}
	const invalid: string[] = rpc.flatMap(rpcPrivacyShapeProblems);
	const unpublishable: string[] = [];
	invalid.push(...acp.flatMap(acpPrivacyShapeProblems));
	if (invalid.length) return { invalid: [...new Set(invalid)], unpublishable };
	try {
		const report = buildPrimeConformanceReportV0(rpc);
		const assessment = assessPrimeEvidenceV0({ report, requestedScenarios: SCENARIO_NAMES_WITH_INVARIANTS });
		invalid.push(...assessment.invalid);
		unpublishable.push(...assessment.unpublishable);
	} catch {
		invalid.push("RPC set is not one valid evidence set");
	}
	const names = acp.map((run) => run.provenance.scenario);
	if (
		names.length !== ACP_SCENARIOS.length ||
		new Set(names).size !== names.length ||
		ACP_SCENARIOS.some((s) => !names.includes(s.name))
	)
		invalid.push("ACP set must contain every scenario exactly once");
	for (const run of acp) {
		invalid.push(...acpEvidenceProblems(run).map((p) => `ACP ${run.provenance.scenario}: ${p}`));
		invalid.push(
			...run.failures.map(() => "ACP scenario failed"),
			...run.protocolErrors.map(() => "ACP protocol failed"),
		);
		if (scanForSentinelsV0("ACP evidence", run).length) invalid.push("ACP privacy violation");
	}
	if (!consistentInitialize(acp)) invalid.push("ACP initialize capabilities/metadata differ across scenarios");
	const all = [...rpc, ...acp];
	if (all.length === 0 || all.some((run) => identity(run) !== identity(all[0]!)))
		unpublishable.push("mixed Prime/probe/research/build/environment provenance across boundaries");
	for (const run of all) {
		const p = run.provenance;
		if (
			p.version !== PRIME_097.version ||
			p.commit !== PRIME_097.commit ||
			p.probeVersion !== PROBE_VERSION ||
			p.generatedBy !== PROBE_NAME ||
			!auditedProvenance({ ...p, mode: "rpc" }) ||
			!/^[0-9a-f]{40}$/.test(p.endophasiaCommit ?? "")
		)
			unpublishable.push("0.9.7 requires the audited clean source and current identified research build");
	}
	if (
		acp.some(
			(run) =>
				run.initialize?.agentName !== "prime-agent" ||
				run.initialize?.agentVersion !== PRIME_097.version ||
				run.initialize?.protocolVersion !== 1,
		)
	)
		unpublishable.push("ACP initialize identity/protocol differs from the audited build");
	return { invalid: [...new Set(invalid)], unpublishable: [...new Set(unpublishable)] };
}

export function buildPrime097Report(
	rpc: readonly PrimeScenarioEvidenceV0[],
	acp: readonly AcpScenarioEvidence[],
	baseline: readonly PrimeScenarioEvidenceV0[],
) {
	// Canonicalize at construction, regardless of live execution, filesystem or caller order.
	rpc = canonicalScenarios(rpc, SCENARIO_NAMES_WITH_INVARIANTS);
	acp = canonicalScenarios(
		acp,
		ACP_SCENARIOS.map((s) => s.name),
	);
	const assessment = assessPrime097(rpc, acp);
	const rpcReport = buildPrimeConformanceReportV0(rpc, { reference: baseline[0]?.provenance });
	const oldReport = buildPrimeConformanceReportV0(baseline);
	const established = assessment.invalid.length === 0 && assessment.unpublishable.length === 0;
	const scenario = (name: string) => acp.find((run) => run.provenance.scenario === name);
	const facts = {
		initialize: consistentInitialize(acp) ? acp[0]?.initialize : undefined,
		initializeConsistent: consistentInitialize(acp),
		providerUsageDecodedExactly: acp.length > 0 && acp.every(acpUsageScriptMatches),
		lengthStop: scenario("length-stop")?.prompts[0]?.stopReason,
		providerFailure: scenario("provider-failure")?.prompts[0]?.response,
		cancelStreamStop: scenario("cancel-stream")?.prompts[0]?.stopReason,
		cancelToolStop: scenario("cancel-tool")?.prompts[0]?.stopReason,
		tokenLimitStop: scenario("token-limit")?.prompts[0]?.stopReason,
		turnLimitStop: scenario("turn-limit")?.prompts[0]?.stopReason,
		gateFailureObserved: scenario("gate-failure")?.updates.some((u) => u.autonomous?.hasGateFailure),
		closeRecreate: {
			acpSessions: scenario("close-recreate")?.sessionIds.length,
			durableSessions: scenario("close-recreate")?.files.length,
			promptTurnIds: scenario("close-recreate")?.updates.map((u) => u.promptTurnId),
			eventSequences: scenario("close-recreate")?.updates.map((u) => u.eventSequence),
		},
		updateKinds: [...new Set(acp.flatMap((run) => run.updates.map((u) => u.kind)))].sort(),
		metaFields: [...new Set(acp.flatMap((run) => run.updates.flatMap((u) => u.metaKeys)))].sort(),
	};
	const capabilities = CAPABILITIES.map((contract) => {
		const finding = rpcReport.findings.find((f) => f.contract === contract);
		return {
			contract,
			rpc: finding ?? {
				support: "adapter-state",
				semanticFit: "incompatible",
				basis: established ? "established" : "unverified",
			},
			acp: {
				support: ["RuntimeMetricsV0", "OperationOutcomeV0", "UsageLedgerRowV0"].includes(contract)
					? "unavailable"
					: "adapter-state",
				semanticFit: contract === "MissionTraceEventV0" ? "qualified" : "incompatible",
				basis: established ? "established" : "unverified",
			},
			durable: {
				support: ["RuntimeMetricsV0", "UsageLedgerRowV0", "ContinuitySnapshotV0"].includes(contract)
					? "adapter-state"
					: "unavailable",
				semanticFit: ["RuntimeMetricsV0", "UsageLedgerRowV0", "ContinuitySnapshotV0"].includes(contract)
					? "qualified"
					: "incompatible",
				basis:
					(contract === "RuntimeMetricsV0" || contract === "UsageLedgerRowV0") &&
					!facts.providerUsageDecodedExactly
						? "contradicted"
						: established
							? "established"
							: "unverified",
				exactProjection: "unverified",
				boundary: "durable-session-files, separately observed",
			},
			adapterState:
				contract === "MissionTraceEventV0"
					? [
							"RPC lane/run/turn/sequence labels",
							"local cancel request correlation",
							"ACP prompt/sequence counters cannot become durable operation or Usage cursors",
						]
					: ["Any new allocator/registry/projection would require an independent implementation and audit"],
			missing: MISSING[contract],
		};
	});
	const report = {
		schemaVersion: "prime-097-comparison.v0",
		assessment,
		rpc: rpcReport,
		baseline: { provenance: oldReport.provenance, findings: oldReport.findings },
		acp: {
			facts,
			scenarios: acp.map((run) => ({
				scenario: run.provenance.scenario,
				provenance: run.provenance,
				initialize: run.initialize,
				prompts: run.prompts,
				evidenceProblems: acpEvidenceProblems(run),
			})),
		},
		capabilities,
		candidateForPR27: [] as Capability[],
		boundaryDrift: { rpc: "rpc", acp: "acp", sameBoundary: false, combinedRuntimeInterface: false },
		sourceReferences: {
			primeCommit: PRIME_097.commit,
			rpc: "packages/agent/src/agent-loop.ts:310-449; packages/coding-agent/src/core/agent-session.ts:14776-14824",
			acp: "packages/coding-agent/src/modes/acp/acp-mode.ts:186-337,736-906,919-1030; acp-events.ts:147-323; acp-stop-reason.ts:1-29",
			durable: "packages/coding-agent/src/core/session-manager.ts:54-167,446-575,1893-1911,2544-2615",
			sdk: "package-lock.json: @agentclientprotocol/sdk 1.3.0; JSON-RPC 2.0 NDJSON, protocol 1",
		},
		qualifications: [
			"Research evidence only; no production Runtime Profile or capability admission",
			"ACP durable files are a separate boundary, not ACP-native Usage or Continuity",
			"No existing Endophasia capability is exact on either boundary",
		],
	};
	return { ...report, privacyViolations: scanForSentinelsV0("comparison report", report) };
}

function canonicalScenarios<T extends { provenance: { scenario: string } }>(
	runs: readonly T[],
	names: readonly string[],
): T[] {
	return [...runs].sort((a, b) => {
		const rank = (name: string) => (names.includes(name) ? names.indexOf(name) : names.length);
		return (
			rank(a.provenance.scenario) - rank(b.provenance.scenario) ||
			a.provenance.scenario.localeCompare(b.provenance.scenario)
		);
	});
}

function consistentInitialize(acp: readonly AcpScenarioEvidence[]): boolean {
	const canonical = (value: unknown): string => {
		if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort());
		if (value !== null && typeof value === "object")
			return JSON.stringify(
				Object.entries(value)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, item]) => [key, canonical(item)]),
			);
		return JSON.stringify(value) ?? "undefined";
	};
	return (
		acp.length > 0 &&
		acp.every((run) => run.initialize !== undefined && canonical(run.initialize) === canonical(acp[0]!.initialize))
	);
}

export function readAcpFixtures(directory: string): AcpScenarioEvidence[] {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const value: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
			if (acpEvidenceProblems(value).length) throw new Error("invalid ACP fixture");
			const fixture = value as AcpScenarioEvidence;
			if (`${fixture.provenance.scenario}.json` !== name) throw new Error("ACP fixture name mismatch");
			return fixture;
		});
}

/** Full-set writes only. Validate before creating even a staging directory; publication never accepts a partial run. */
export function publishPrime097(
	root: string,
	rpc: readonly PrimeScenarioEvidenceV0[],
	acp: readonly AcpScenarioEvidence[],
	baseline: readonly PrimeScenarioEvidenceV0[],
): void {
	try {
		assertPlainEvidence({ rpc, acp, baseline });
	} catch {
		throw new Error("joint fixture publication refused: nonplain evidence");
	}
	// The comparison is part of the indivisible reference. Missing/invalid history must not erase an existing report.
	if (!Array.isArray(baseline) || baseline.some((run) => run.provenance.version !== "0.9.6"))
		throw new Error("joint fixture publication refused: baseline required");
	if (baseline.flatMap(rpcPrivacyShapeProblems).length)
		throw new Error("joint fixture publication refused: invalid baseline");
	let baselineAssessment: PrimeEvidenceAssessmentV0;
	try {
		baselineAssessment = assessPrimeEvidenceV0({
			report: buildPrimeConformanceReportV0(baseline),
			requestedScenarios: SCENARIO_NAMES_WITH_INVARIANTS,
		});
	} catch {
		throw new Error("joint fixture publication refused: invalid baseline");
	}
	if (baselineAssessment.invalid.length || baselineAssessment.unpublishable.length)
		throw new Error("joint fixture publication refused: invalid baseline");
	const assessment = assessPrime097(rpc, acp);
	if (assessment.invalid.length || assessment.unpublishable.length)
		throw new Error("joint fixture publication refused");
	const report = buildPrime097Report(rpc, acp, baseline);
	if (report.privacyViolations.length) throw new Error("joint report privacy violation");
	mkdirSync(root, { recursive: true });
	const target = join(root, PRIME_097.version);
	const staging = mkdtempSync(join(root, ".prime-097-"));
	try {
		for (const [mode, evidence] of [
			["rpc", rpc],
			["acp", acp],
		] as const) {
			mkdirSync(join(staging, mode));
			for (const run of evidence)
				writeFileSync(
					join(staging, mode, `${run.provenance.scenario}.json`),
					`${JSON.stringify(run, null, "\t")}\n`,
				);
		}
		writeFileSync(join(staging, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);
		installReferenceDirectory(staging, target);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
