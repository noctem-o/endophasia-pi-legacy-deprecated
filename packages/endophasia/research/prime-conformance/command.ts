// Research-only (Prime Runtime Conformance v0). The check:prime-conformance command, with its I/O injected so the
// ordering guarantees are testable offline:
//   parse arguments strictly (nothing runs on a malformed command line)
//   -> probe -> build the report in memory -> privacy scan
//   -> privacy violation: persist nothing, print only surfaces and counts, fail
//   -> write the report -> publication gate -> fixtures only when publishable
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PrimeBinaryV0 } from "./environment.ts";
import type { PrimeProvenanceV0, PrimeScenarioEvidenceV0 } from "./evidence.ts";
import type { PrimeProbeOptionsV0 } from "./probe.ts";
import { assessPrimeEvidenceV0, isPublishableV0 } from "./publication.ts";
import { buildPrimeConformanceReportV0, readPrimeFixturesV0, writePrimeFixturesV0 } from "./report.ts";

/** The Prime version the committed reference fixtures were generated from. */
export const FIXTURE_PRIME_VERSION = "0.9.6";

export interface PrimeConformanceArgsV0 {
	readonly only: readonly string[];
	readonly writeFixtures: boolean;
	readonly retain: boolean;
}

/** Strict flags: --scenario <name> (repeatable), --write-fixtures, --retain. Anything else is an error. */
export function parsePrimeConformanceArgsV0(
	args: readonly string[],
	scenarios: readonly string[],
): { readonly ok: true; readonly args: PrimeConformanceArgsV0 } | { readonly ok: false; readonly error: string } {
	const only: string[] = [];
	let writeFixtures = false;
	let retain = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--write-fixtures") writeFixtures = true;
		else if (arg === "--retain") retain = true;
		else if (arg === "--scenario") {
			const name = args[++index];
			// A trailing or flag-followed --scenario must not silently become a full (pruning) refresh.
			if (name === undefined || name.startsWith("--"))
				return { ok: false, error: "--scenario needs a scenario name" };
			if (!scenarios.includes(name)) return { ok: false, error: `unknown scenario ${name}` };
			if (only.includes(name)) return { ok: false, error: `scenario ${name} given twice` };
			only.push(name);
		} else if (arg.startsWith("--scenario=")) {
			return { ok: false, error: "use --scenario <name>, not --scenario=<name>" };
		} else return { ok: false, error: `unknown argument ${arg}` };
	}
	return { ok: true, args: { only, writeFixtures, retain } };
}

export interface PrimeConformanceCommandDepsV0 {
	readonly env: NodeJS.ProcessEnv;
	/** test/fixtures/prime: holds one directory per Prime version. */
	readonly fixtureRoot: string;
	/** .artifacts/prime-conformance: receives report.json. */
	readonly artifactDir: string;
	readonly scenarios: readonly string[];
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly resolveBinary: (env: NodeJS.ProcessEnv) => PrimeBinaryV0 | undefined;
	readonly describe: (binary: PrimeBinaryV0) => PrimeProvenanceV0;
	readonly probe: (options: PrimeProbeOptionsV0) => Promise<PrimeScenarioEvidenceV0[]>;
}

/** Run the command; returns the process exit code. */
export async function runPrimeConformanceCommandV0(
	argv: readonly string[],
	deps: PrimeConformanceCommandDepsV0,
): Promise<number> {
	const fail = (message: string): number => {
		deps.stderr(`check:prime-conformance: ${message}\n`);
		return 1;
	};
	const parsed = parsePrimeConformanceArgsV0(argv, deps.scenarios);
	if (!parsed.ok) return fail(parsed.error);
	const { only, writeFixtures, retain } = parsed.args;

	const binary = deps.resolveBinary(deps.env);
	if (binary === undefined) {
		return fail(
			"no Prime Agent configured. Set PRIME_AGENT_BIN to a prime-agent executable, or PRIME_AGENT_ROOT to a built " +
				"prime-agent source checkout. The probe never downloads Prime.",
		);
	}
	if (isAbsolute(binary.command) && !existsSync(binary.command))
		return fail(`Prime Agent not found at ${binary.command}`);
	const provenance = deps.describe(binary);
	if (provenance.version === "unknown") return fail(`could not read a version from ${binary.description} --version`);
	deps.stdout(
		`Prime Agent ${provenance.version}${provenance.commit ? ` @ ${provenance.commit}` : ""} (${provenance.build})\n`,
	);

	const evidence = await deps.probe({
		binary,
		provenance,
		retain,
		...(only.length > 0 ? { only } : {}),
		log: (message) => deps.stdout(`  ${message}\n`),
	});

	const referenceDir = join(deps.fixtureRoot, FIXTURE_PRIME_VERSION);
	let reference: PrimeProvenanceV0 | undefined;
	if (existsSync(referenceDir)) {
		try {
			reference = readPrimeFixturesV0(referenceDir)[0]?.provenance;
		} catch {
			// Typically fixtures from an older probe revision, in an older format: there is no comparable reference.
			deps.stderr(
				"check:prime-conformance: the committed fixtures cannot be read by this probe version; drift has no reference\n",
			);
		}
	}
	const report = buildPrimeConformanceReportV0(evidence, reference === undefined ? {} : { reference });

	// Privacy before persistence: a report that contains a probe sentinel may carry the leaked payload anywhere, so
	// nothing of it is written, and the diagnostic names only surfaces and counts.
	if (report.privacyViolations.length > 0) {
		return fail(
			`privacy violation: probe sentinels reached ${report.privacyViolations
				.map((violation) => `${violation.surface} (${violation.matches})`)
				.join(", ")}. No report or fixture was written.`,
		);
	}
	mkdirSync(deps.artifactDir, { recursive: true });
	const reportPath = join(deps.artifactDir, "report.json");
	writeFileSync(reportPath, `${JSON.stringify(report, null, "\t")}\n`);

	const requestedScenarios = only.length > 0 ? only : deps.scenarios;
	const fixtureDir = join(deps.fixtureRoot, provenance.version);
	let retainedFixtures: PrimeScenarioEvidenceV0[] = [];
	if (writeFixtures && only.length > 0 && existsSync(fixtureDir)) {
		try {
			retainedFixtures = readPrimeFixturesV0(fixtureDir).filter(
				(fixture) => !only.includes(fixture.provenance.scenario),
			);
		} catch {
			return fail("the fixtures a partial refresh would keep cannot be read; run a full refresh");
		}
	}
	const assessment = assessPrimeEvidenceV0({ report, requestedScenarios, retainedFixtures });

	for (const finding of report.findings) {
		deps.stdout(
			`${finding.contract.padEnd(22)} ${finding.support.padEnd(14)} ${finding.semanticFit.padEnd(13)} ${finding.basis}\n`,
		);
	}
	const { drift } = report;
	deps.stdout(
		`drift: runtime ${drift.runtime}, probe ${drift.probe}, environment ${drift.environment}, provenance ${drift.provenanceVerified ? "verified" : "unverified"}\n`,
	);
	deps.stdout(`report: ${reportPath}\n`);

	if (writeFixtures) {
		if (!isPublishableV0(assessment)) {
			return fail(`refusing to write fixtures:\n${[...assessment.invalid, ...assessment.unpublishable].join("\n")}`);
		}
		// A full run replaces the directory's contents; a --scenario run refreshes only its own fixtures.
		writePrimeFixturesV0(fixtureDir, evidence, { prune: only.length === 0 });
		deps.stdout(`fixtures written to ${fixtureDir}\n`);
	}
	if (assessment.invalid.length > 0) return fail(`\n${assessment.invalid.join("\n")}`);
	// Valid evidence that contradicts a classification means Prime changed: the check fails until it is re-analysed.
	const contradicted = report.findings.filter((finding) => finding.basis === "contradicted");
	if (contradicted.length > 0) {
		return fail(
			`Prime contradicts the recorded classification:\n${contradicted
				.map((finding) => `${finding.contract}: ${finding.contradictions.join(", ")}`)
				.join("\n")}`,
		);
	}
	return 0;
}
