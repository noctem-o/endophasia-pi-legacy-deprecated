// Research-only (Prime Runtime Conformance v0). Assembles the machine-readable conformance report from sanitized
// evidence, re-checks that evidence (structure, scenario invariants, privacy), and reads and writes the fixtures.
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
import {
	evidenceProblemsV0,
	PROBE_NAME,
	type PrimeObservationsV0,
	type PrimeProvenanceV0,
	type PrimeScenarioEvidenceV0,
} from "./evidence.ts";
import { SENTINEL_PATTERN } from "./fake-provider.ts";
import { scenarioInvariantProblemsV0 } from "./invariants.ts";
import type { CandidateTerminalV0 } from "./mission-trace.ts";
import { projectPrimeUsageRowsV0, rebuildPrimeRuntimeMetricsV0 } from "./projection.ts";

export const REPORT_SCHEMA_VERSION = "prime-conformance-report.v0";

/**
 * How this run's evidence relates to a reference (the committed fixtures). Three independent axes: the Prime that ran,
 * the probe that observed it, and the environment it ran in. "no-reference" when there is nothing to compare with.
 */
export interface PrimeDriftV0 {
	/**
	 * same: same version and the same verified commit. different: another version or commit. unverifiable: same
	 * version, but this run's build cannot be matched to the reference commit (a binary, a dirty or unverified checkout).
	 */
	readonly runtime: "same" | "different" | "unverifiable" | "no-reference";
	/** A different probe name or version means the reference was produced by another instrument. */
	readonly probe: "same" | "different" | "no-reference";
	readonly environment: "same" | "different" | "no-reference";
	/** Whether this run's own build is verified source provenance (a clean checkout at a known commit). */
	readonly provenanceVerified: boolean;
	readonly evidence: { readonly version: string; readonly commit?: string; readonly probeVersion: string };
	readonly reference?: { readonly version: string; readonly commit?: string; readonly probeVersion: string };
}

export interface PrimeScenarioReportV0 {
	readonly scenario: string;
	readonly description: string;
	readonly eventTypes: readonly string[];
	readonly missionTraceKinds: readonly string[];
	readonly terminals: readonly CandidateTerminalV0[];
	readonly unmapped: readonly string[];
	readonly observations: PrimeObservationsV0;
	/** Failures recorded while probing, plus invariant violations found when re-checking the evidence. */
	readonly failures: readonly string[];
	readonly identityProblems: readonly string[];
	/** Structure decode.ts would not have produced (missing identity, flag or usage; non-finite number). */
	readonly evidenceProblems: readonly string[];
	readonly protocolErrors: readonly string[];
}

/** Where probe sentinels were found, and how many: never which sentinel or what surrounded it. */
export interface PrimePrivacyViolationV0 {
	readonly surface: string;
	readonly matches: number;
}

export interface PrimeConformanceReportV0 {
	readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
	readonly generatedBy: typeof PROBE_NAME;
	readonly provenance: PrimeProvenanceV0;
	readonly drift: PrimeDriftV0;
	readonly scenarios: readonly PrimeScenarioReportV0[];
	readonly facts: PrimeFactsV0;
	readonly findings: readonly PrimeConformanceFindingV0[];
	/** Must be empty. A report with any violation must never be persisted. */
	readonly privacyViolations: readonly PrimePrivacyViolationV0[];
}

export function isVerifiedProvenanceV0(provenance: PrimeProvenanceV0): boolean {
	return (
		provenance.build === "clean-checkout" && typeof provenance.commit === "string" && provenance.commit.length > 0
	);
}

export function checkPrimeDriftV0(evidence: PrimeProvenanceV0, reference: PrimeProvenanceV0 | undefined): PrimeDriftV0 {
	const verified = isVerifiedProvenanceV0(evidence);
	const identity = (provenance: PrimeProvenanceV0) => ({
		version: provenance.version,
		...(provenance.commit === undefined ? {} : { commit: provenance.commit }),
		probeVersion: provenance.probeVersion,
	});
	if (reference === undefined) {
		return {
			runtime: "no-reference",
			probe: "no-reference",
			environment: "no-reference",
			provenanceVerified: verified,
			evidence: identity(evidence),
		};
	}
	const runtime =
		reference.version !== evidence.version ||
		(reference.commit !== undefined && evidence.commit !== undefined && reference.commit !== evidence.commit)
			? "different"
			: verified && evidence.commit === reference.commit
				? "same"
				: "unverifiable";
	return {
		runtime,
		probe:
			reference.generatedBy === evidence.generatedBy && reference.probeVersion === evidence.probeVersion
				? "same"
				: "different",
		environment: reference.platform === evidence.platform && reference.node === evidence.node ? "same" : "different",
		provenanceVerified: verified,
		evidence: identity(evidence),
		reference: identity(reference),
	};
}

/** Probe sentinels in a serialized value, as a count per surface. */
export function scanForSentinelsV0(surface: string, value: unknown): PrimePrivacyViolationV0[] {
	const matches = (JSON.stringify(value) ?? "").match(new RegExp(SENTINEL_PATTERN, "g"))?.length ?? 0;
	return matches === 0 ? [] : [{ surface, matches }];
}

/**
 * One report describes one Prime build, one probe and one environment. Evidence mixing any of them is refused rather
 * than labelled with the first scenario's provenance.
 */
function assertHomogeneous(evidence: readonly PrimeScenarioEvidenceV0[]): PrimeProvenanceV0 {
	const first = evidence[0];
	if (first === undefined) throw new Error("No Prime evidence to report on");
	const { scenario: _scenario, ...provenance } = first.provenance;
	for (const item of evidence) {
		const other = item.provenance;
		if (
			other.version !== provenance.version ||
			other.commit !== provenance.commit ||
			other.build !== provenance.build
		) {
			throw new Error(`Evidence mixes Prime builds (${provenance.version} and ${other.version})`);
		}
		if (other.generatedBy !== provenance.generatedBy || other.probeVersion !== provenance.probeVersion) {
			throw new Error(`Evidence mixes probe versions (${provenance.probeVersion} and ${other.probeVersion})`);
		}
		if (other.platform !== provenance.platform || other.node !== provenance.node) {
			throw new Error(
				`Evidence mixes environments (${provenance.platform} ${provenance.node} and ${other.platform} ${other.node})`,
			);
		}
	}
	const names = evidence.map((item) => item.provenance.scenario);
	const duplicate = names.find((name, index) => names.indexOf(name) !== index);
	if (duplicate !== undefined) throw new Error(`Evidence repeats scenario ${duplicate}`);
	return provenance;
}

export function buildPrimeConformanceReportV0(
	evidence: readonly PrimeScenarioEvidenceV0[],
	options: { readonly reference?: PrimeProvenanceV0 } = {},
): PrimeConformanceReportV0 {
	const provenance = assertHomogeneous(evidence);
	const traces = mapScenarioMissionTracesV0(evidence);
	const facts = derivePrimeFactsV0(evidence);
	const scenarios = evidence.map((item, index): PrimeScenarioReportV0 => {
		const { mapping } = traces[index]!;
		// Re-checked here too, so a fixture read from disk is held to the live probe's invariants.
		const invariantFailures = scenarioInvariantProblemsV0(item).filter((problem) => !item.failures.includes(problem));
		return {
			scenario: item.provenance.scenario,
			description: item.description,
			eventTypes: observedEventTypesV0(item.events),
			missionTraceKinds: mapping.events.map((event) => event.kind),
			terminals: mapping.terminals,
			unmapped: mapping.unmapped,
			observations: item.observations,
			failures: [...item.failures, ...invariantFailures],
			identityProblems: checkAdapterIdentitiesV0(mapping),
			evidenceProblems: evidenceProblemsV0(item),
			protocolErrors: item.protocolErrors,
		};
	});
	const privacyViolations = [
		...evidence.flatMap((item) => scanForSentinelsV0(`evidence:${item.provenance.scenario}`, item)),
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
 * Callers must pass the publication gate first (publication.ts).
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

const EVIDENCE_ARRAYS = [
	"events",
	"abortRequestedAfter",
	"commands",
	"stats",
	"sessionEntries",
	"entrySnapshots",
	"stateKeys",
	"protocolErrors",
	"failures",
] as const;

/** Read committed fixtures. The envelope is validated here; the contents are re-checked by the report. */
export function readPrimeFixturesV0(directory: string): PrimeScenarioEvidenceV0[] {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const value: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
			const fixture = (value ?? {}) as Record<string, unknown>;
			const provenance = (fixture.provenance ?? {}) as Record<string, unknown>;
			const valid =
				provenance.source === "prime-agent" &&
				provenance.mode === "rpc" &&
				provenance.generatedBy === PROBE_NAME &&
				["version", "probeVersion", "platform", "node", "scenario", "build"].every(
					(key) => typeof provenance[key] === "string",
				) &&
				`${provenance.scenario}.json` === name &&
				typeof fixture.description === "string" &&
				fixture.observations !== null &&
				typeof fixture.observations === "object" &&
				EVIDENCE_ARRAYS.every((key) => Array.isArray(fixture[key]));
			if (!valid) throw new Error(`Invalid Prime fixture ${name}`);
			return value as PrimeScenarioEvidenceV0;
		});
}
