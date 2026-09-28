// Research-only (Prime Runtime Conformance v0). Assembles the machine-readable conformance report from sanitized
// evidence, checks it for leaked probe payloads, and reads and writes the committed fixtures.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	checkAdapterIdentitiesV0,
	classifyPrimeConformanceV0,
	derivePrimeFactsV0,
	mapScenarioMissionTracesV0,
	observedEventTypesV0,
	type PrimeConformanceFindingV0,
	type PrimeFactsV0,
} from "./classification.ts";
import { evidenceProblemsV0, PROBE_NAME, type PrimeProvenanceV0, type PrimeScenarioEvidenceV0 } from "./evidence.ts";
import { SENTINEL_PATTERN } from "./fake-provider.ts";
import type { CandidateTerminalV0 } from "./mission-trace.ts";
import { projectPrimeUsageRowsV0, rebuildPrimeRuntimeMetricsV0 } from "./projection.ts";

export const REPORT_SCHEMA_VERSION = "prime-conformance-report.v0";

export interface PrimeDriftV0 {
	/** True when the evidence was produced by a different Prime than the reference (e.g. the committed fixtures). */
	readonly stale: boolean;
	/**
	 * True when the reference is pinned to a commit but the evidence has none (a PRIME_AGENT_BIN run): the version
	 * matches, but whether it is the same build cannot be verified. Never reported as a match.
	 */
	readonly unverified: boolean;
	readonly evidenceVersion: string;
	readonly evidenceCommit?: string;
	readonly referenceVersion?: string;
	readonly referenceCommit?: string;
}

export interface PrimeScenarioReportV0 {
	readonly scenario: string;
	readonly description: string;
	readonly eventTypes: readonly string[];
	readonly missionTraceKinds: readonly string[];
	readonly terminals: readonly CandidateTerminalV0[];
	readonly unmapped: readonly string[];
	readonly identityProblems: readonly string[];
	/** Values the sanitizers could only substitute (missing identities, non-finite numbers); must be empty. */
	readonly evidenceProblems: readonly string[];
	readonly notes: readonly string[];
	readonly protocolErrors: readonly string[];
}

export interface PrimeConformanceReportV0 {
	readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
	readonly generatedBy: typeof PROBE_NAME;
	readonly provenance: PrimeProvenanceV0;
	readonly drift: PrimeDriftV0;
	readonly scenarios: readonly PrimeScenarioReportV0[];
	readonly facts: PrimeFactsV0;
	readonly findings: readonly PrimeConformanceFindingV0[];
	/** Probe sentinels found in evidence, candidate traces, projections or the report itself; must be empty. */
	readonly privacyViolations: readonly string[];
}

export function checkPrimeDriftV0(evidence: PrimeProvenanceV0, reference: PrimeProvenanceV0 | undefined): PrimeDriftV0 {
	return {
		stale:
			reference !== undefined &&
			(reference.version !== evidence.version ||
				(reference.commit !== undefined && evidence.commit !== undefined && reference.commit !== evidence.commit)),
		unverified:
			reference !== undefined &&
			reference.version === evidence.version &&
			reference.commit !== undefined &&
			evidence.commit === undefined,
		evidenceVersion: evidence.version,
		...(evidence.commit === undefined ? {} : { evidenceCommit: evidence.commit }),
		...(reference === undefined ? {} : { referenceVersion: reference.version }),
		...(reference?.commit === undefined ? {} : { referenceCommit: reference.commit }),
	};
}

/** Every probe sentinel in a serialized value, labelled by where it was found. */
export function scanForSentinelsV0(label: string, value: unknown): string[] {
	const text = JSON.stringify(value) ?? "";
	const matches = text.match(new RegExp(SENTINEL_PATTERN, "g")) ?? [];
	return [...new Set(matches)].map((match) => `${label}: ${match}`);
}

export function buildPrimeConformanceReportV0(
	evidence: readonly PrimeScenarioEvidenceV0[],
	options: { readonly reference?: PrimeProvenanceV0 } = {},
): PrimeConformanceReportV0 {
	const first = evidence[0];
	if (first === undefined) throw new Error("No Prime evidence to report on");
	const { scenario: _scenario, ...provenance } = first.provenance;
	const mismatched = evidence.find(
		(item) => item.provenance.version !== provenance.version || item.provenance.commit !== provenance.commit,
	);
	if (mismatched !== undefined) {
		throw new Error(`Evidence mixes Prime versions (${provenance.version} and ${mismatched.provenance.version})`);
	}
	// Evidence from another probe revision may differ in sanitization or scenario logic, so it cannot be combined either.
	const otherProbe = evidence.find(
		(item) =>
			item.provenance.generatedBy !== provenance.generatedBy ||
			item.provenance.probeVersion !== provenance.probeVersion,
	);
	if (otherProbe !== undefined) {
		throw new Error(
			`Evidence mixes probe versions (${provenance.generatedBy} ${provenance.probeVersion} and ${otherProbe.provenance.generatedBy} ${otherProbe.provenance.probeVersion})`,
		);
	}
	const traces = mapScenarioMissionTracesV0(evidence);
	const facts = derivePrimeFactsV0(evidence);
	const scenarios = evidence.map((item, index): PrimeScenarioReportV0 => {
		const { mapping } = traces[index]!;
		return {
			scenario: item.provenance.scenario,
			description: item.description,
			eventTypes: observedEventTypesV0(item.events),
			missionTraceKinds: mapping.events.map((event) => event.kind),
			terminals: mapping.terminals,
			unmapped: mapping.unmapped,
			identityProblems: checkAdapterIdentitiesV0(mapping),
			evidenceProblems: evidenceProblemsV0(item),
			notes: item.notes,
			protocolErrors: item.protocolErrors,
		};
	});
	const privacyViolations = [
		...scanForSentinelsV0("evidence", evidence),
		...traces.flatMap(({ scenario, mapping }) => scanForSentinelsV0(`mission-trace:${scenario}`, mapping)),
		...evidence.flatMap((item) => [
			...scanForSentinelsV0(
				`usage-projection:${item.provenance.scenario}`,
				projectPrimeUsageRowsV0(item.sessionEntries),
			),
			...scanForSentinelsV0(
				`metrics-projection:${item.provenance.scenario}`,
				rebuildPrimeRuntimeMetricsV0(item.sessionEntries),
			),
		]),
	];
	const report: PrimeConformanceReportV0 = {
		schemaVersion: REPORT_SCHEMA_VERSION,
		generatedBy: PROBE_NAME,
		provenance,
		drift: checkPrimeDriftV0(provenance, options.reference),
		scenarios,
		facts,
		findings: classifyPrimeConformanceV0(evidence, facts),
		privacyViolations,
	};
	const leaked = scanForSentinelsV0("report", report);
	return leaked.length === 0 ? report : { ...report, privacyViolations: [...privacyViolations, ...leaked] };
}

/**
 * Write one fixture per scenario: `<dir>/<scenario>.json`, each carrying its own provenance. With `prune` (a full
 * refresh), fixtures of scenarios this run did not produce are removed, so stale evidence cannot outlive its scenario.
 */
export function writePrimeFixturesV0(
	directory: string,
	evidence: readonly PrimeScenarioEvidenceV0[],
	options: { readonly prune?: boolean } = {},
): void {
	mkdirSync(directory, { recursive: true });
	if (options.prune === true) {
		const produced = new Set(evidence.map((item) => `${item.provenance.scenario}.json`));
		for (const name of readdirSync(directory)) {
			if (name.endsWith(".json") && !produced.has(name)) rmSync(join(directory, name));
		}
	}
	for (const item of evidence) {
		writeFileSync(join(directory, `${item.provenance.scenario}.json`), `${JSON.stringify(item, null, "\t")}\n`);
	}
}

/** Read committed fixtures, validating only what the report depends on. */
export function readPrimeFixturesV0(directory: string): PrimeScenarioEvidenceV0[] {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const value: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
			const fixture = value as Partial<PrimeScenarioEvidenceV0> | null;
			const provenance = fixture?.provenance;
			if (
				provenance?.source !== "prime-agent" ||
				provenance.mode !== "rpc" ||
				provenance.generatedBy !== PROBE_NAME ||
				typeof provenance.version !== "string" ||
				typeof provenance.scenario !== "string" ||
				!Array.isArray(fixture?.events) ||
				!Array.isArray(fixture?.stats) ||
				!Array.isArray(fixture?.sessionEntries)
			) {
				throw new Error(`Invalid Prime fixture ${name}`);
			}
			return fixture as PrimeScenarioEvidenceV0;
		});
}
