// Research-only (Prime Runtime Conformance v0). The one policy that decides what evidence may become the committed
// reference. Three outcomes are kept apart:
// - Prime behaved differently than expected: structurally valid evidence of that is conformance evidence.
// - The probe cannot establish what happened (failures, protocol errors, invalid structure, privacy leak): invalid.
// - Provenance is uncertain (a binary, a dirty checkout, another probe revision, a mixed fixture set): the run may be
//   inspected, but it cannot certify or refresh the reference.
import { PROBE_NAME, PROBE_VERSION, type PrimeProvenanceV0, type PrimeScenarioEvidenceV0 } from "./evidence.ts";
import { buildPrimeConformanceReportV0, isVerifiedProvenanceV0, type PrimeConformanceReportV0 } from "./report.ts";

export interface PrimeEvidenceAssessmentV0 {
	/** Why the probe cannot establish what happened. Non-empty: the run is invalid evidence for any use. */
	readonly invalid: readonly string[];
	/** Why otherwise valid evidence may not become the reference. */
	readonly unpublishable: readonly string[];
}

export interface PrimeEvidenceAssessmentInputV0 {
	readonly report: PrimeConformanceReportV0;
	/** The scenarios the run was asked to produce, in any order. */
	readonly requestedScenarios: readonly string[];
	/**
	 * For a partial refresh: the committed fixtures that stay in place. Their provenance must equal the new evidence's,
	 * or the refreshed set would mix builds, probes or environments.
	 */
	readonly retainedFixtures?: readonly PrimeScenarioEvidenceV0[];
}

function sameProvenance(a: PrimeProvenanceV0, b: PrimeProvenanceV0): boolean {
	return (
		a.version === b.version &&
		a.commit === b.commit &&
		a.build === b.build &&
		a.artifactsHash === b.artifactsHash &&
		a.generatedBy === b.generatedBy &&
		a.probeVersion === b.probeVersion &&
		a.platform === b.platform &&
		a.node === b.node
	);
}

export function assessPrimeEvidenceV0(input: PrimeEvidenceAssessmentInputV0): PrimeEvidenceAssessmentV0 {
	const { report } = input;
	const produced = report.scenarios.map((scenario) => scenario.scenario);
	const invalid = [
		...input.requestedScenarios
			.filter((name) => !produced.includes(name))
			.map((name) => `${name}: requested but not produced`),
		...produced
			.filter((name) => !input.requestedScenarios.includes(name))
			.map((name) => `${name}: produced but not requested`),
		...reportProblems(report),
	];
	const { provenance } = report;
	const unpublishable = [
		...(isVerifiedProvenanceV0(provenance)
			? []
			: [
					`provenance is ${provenance.build}${provenance.commit === undefined ? " without a commit" : ""}: fixtures require a clean PRIME_AGENT_ROOT checkout at a known commit`,
				]),
		...(provenance.generatedBy === PROBE_NAME && provenance.probeVersion === PROBE_VERSION
			? []
			: [`evidence was produced by probe ${provenance.probeVersion}, not the current ${PROBE_VERSION}`]),
		...retainedProblems(input.retainedFixtures ?? [], provenance),
	];
	return { invalid, unpublishable };
}

/** Everything that makes a report's evidence invalid: failures, protocol, structure, identity and privacy. */
function reportProblems(report: PrimeConformanceReportV0): string[] {
	return [
		...report.scenarios.flatMap((scenario) => [
			...scenario.failures.map((item) => `${scenario.scenario}: failure: ${item}`),
			...scenario.protocolErrors.map((item) => `${scenario.scenario}: protocol: ${item}`),
			...scenario.evidenceProblems.map((item) => `${scenario.scenario}: evidence: ${item}`),
			...scenario.identityProblems.map((item) => `${scenario.scenario}: identity: ${item}`),
		]),
		...report.privacyViolations.map(
			(violation) => `privacy: ${violation.matches} probe sentinel match(es) in ${violation.surface}`,
		),
	];
}

/**
 * A partial refresh keeps the other fixtures, so the resulting set is only publishable if they share this run's
 * provenance and are themselves valid evidence: they are re-assessed, not trusted.
 */
function retainedProblems(retained: readonly PrimeScenarioEvidenceV0[], provenance: PrimeProvenanceV0): string[] {
	const mismatched = retained
		.filter((fixture) => !sameProvenance(fixture.provenance, provenance))
		.map(
			(fixture) =>
				`${fixture.provenance.scenario}: retained fixture has other provenance; a partial refresh would mix evidence (run a full refresh)`,
		);
	if (retained.length === 0 || mismatched.length > 0) return mismatched;
	let report: PrimeConformanceReportV0;
	try {
		report = buildPrimeConformanceReportV0(retained);
	} catch {
		return ["the retained fixtures do not form one consistent evidence set (run a full refresh)"];
	}
	return reportProblems(report).map((problem) => `retained ${problem}`);
}

/** Whether the assessed evidence may become the committed reference. */
export function isPublishableV0(assessment: PrimeEvidenceAssessmentV0): boolean {
	return assessment.invalid.length === 0 && assessment.unpublishable.length === 0;
}
