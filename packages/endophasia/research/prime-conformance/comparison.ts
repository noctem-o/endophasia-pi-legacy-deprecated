// Research report and the joint 0.9.7 publication gate. Never consumed by Runtime Profile or production ports.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AcpScenarioEvidence } from "./acp-evidence.ts";
import { ACP_SCENARIOS } from "./acp-probe.ts";
import { acpEvidenceProblems, acpUsageScriptMatches } from "./acp-validation.ts";
import { auditedProvenance, PRIME_097 } from "./audited.ts";
import type { PrimeScenarioEvidenceV0 } from "./evidence.ts";
import { PROBE_NAME, PROBE_VERSION } from "./evidence.ts";
import { SCENARIO_NAMES_WITH_INVARIANTS } from "./invariants.ts";
import { rpcPrivacyShapeProblems } from "./privacy-shape.ts";
import { assessPrimeEvidenceV0, type PrimeEvidenceAssessmentV0 } from "./publication.ts";
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
	const invalid: string[] = rpc.flatMap(rpcPrivacyShapeProblems);
	const unpublishable: string[] = [];
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
	const assessment = assessPrime097(rpc, acp);
	const rpcReport = buildPrimeConformanceReportV0(rpc, { reference: baseline[0]?.provenance });
	const oldReport = buildPrimeConformanceReportV0(baseline);
	const established = assessment.invalid.length === 0 && assessment.unpublishable.length === 0;
	const scenario = (name: string) => acp.find((run) => run.provenance.scenario === name);
	const facts = {
		initialize: acp[0]?.initialize,
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
				basis: !facts.providerUsageDecodedExactly ? "contradicted" : established ? "established" : "unverified",
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
	baseline?: readonly PrimeScenarioEvidenceV0[],
): void {
	const assessment = assessPrime097(rpc, acp);
	if (assessment.invalid.length || assessment.unpublishable.length)
		throw new Error("joint fixture publication refused");
	const report = baseline === undefined ? undefined : buildPrime097Report(rpc, acp, baseline);
	if (report?.privacyViolations.length) throw new Error("joint report privacy violation");
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
		if (report) writeFileSync(join(staging, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);
		const backup = `${staging}-previous`;
		if (existsSync(target)) renameSync(target, backup);
		try {
			renameSync(staging, target);
		} catch (error) {
			if (existsSync(backup)) renameSync(backup, target);
			throw error;
		}
		rmSync(backup, { recursive: true, force: true });
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
