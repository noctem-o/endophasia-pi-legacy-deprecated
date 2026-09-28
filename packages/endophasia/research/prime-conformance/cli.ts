// Research-only (Prime Runtime Conformance v0). Opt-in live probe: `PRIME_AGENT_BIN=... npm run check:prime-conformance`.
// Never downloads Prime and never runs in CI. Writes .artifacts/prime-conformance/report.json (outside git).
//
// Flags: --scenario <name> (repeatable), --write-fixtures (refresh test/fixtures/prime/<version>/), --retain (keep the
// temporary Prime environments for inspection).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePrimeBinaryV0 } from "./environment.ts";
import { describePrimeV0, runPrimeProbeV0, SCENARIOS } from "./probe.ts";
import { buildPrimeConformanceReportV0, readPrimeFixturesV0, writePrimeFixturesV0 } from "./report.ts";

/** The Prime version the committed fixtures were generated from. */
export const FIXTURE_PRIME_VERSION = "0.9.6";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtureRoot = join(packageRoot, "test", "fixtures", "prime");

function fail(message: string): never {
	process.stderr.write(`check:prime-conformance: ${message}\n`);
	process.exit(1);
}

const args = process.argv.slice(2);
const only = args.flatMap((arg, index) =>
	arg === "--scenario" && args[index + 1] !== undefined ? [args[index + 1]!] : [],
);
const unknownScenario = only.find((name) => !SCENARIOS.some((scenario) => scenario.name === name));
if (unknownScenario !== undefined) fail(`unknown scenario ${unknownScenario}`);

const binary = resolvePrimeBinaryV0(process.env);
if (binary === undefined) {
	fail(
		"no Prime Agent configured. Set PRIME_AGENT_BIN to a prime-agent executable, or PRIME_AGENT_ROOT to a built " +
			"prime-agent source checkout. The probe never downloads Prime.",
	);
}
if (binary.command.includes("/") && !existsSync(binary.command)) fail(`Prime Agent not found at ${binary.command}`);

const provenance = describePrimeV0(binary);
if (provenance.version === "unknown") fail(`could not read a version from ${binary.description} --version`);
process.stdout.write(`Prime Agent ${provenance.version}${provenance.commit ? ` @ ${provenance.commit}` : ""}\n`);

const evidence = await runPrimeProbeV0({
	binary,
	provenance,
	retain: args.includes("--retain"),
	...(only.length > 0 ? { only } : {}),
	log: (message) => process.stdout.write(`  ${message}\n`),
});

const referenceDir = join(fixtureRoot, FIXTURE_PRIME_VERSION);
const reference = existsSync(referenceDir) ? readPrimeFixturesV0(referenceDir)[0]?.provenance : undefined;
const report = buildPrimeConformanceReportV0(evidence, { ...(reference === undefined ? {} : { reference }) });

const artifactDir = join(repoRoot, ".artifacts", "prime-conformance");
mkdirSync(artifactDir, { recursive: true });
const reportPath = join(artifactDir, "report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, "\t")}\n`);

const problems = [
	...report.privacyViolations.map((item) => `privacy: ${item}`),
	...report.scenarios.flatMap((scenario) => [
		...scenario.protocolErrors.map((item) => `${scenario.scenario}: protocol: ${item}`),
		...scenario.identityProblems.map((item) => `${scenario.scenario}: identity: ${item}`),
		...scenario.notes
			.filter((item) => item.startsWith("scenario error"))
			.map((item) => `${scenario.scenario}: ${item}`),
	]),
];
// Fixtures are written only from a clean run: a failed or malformed live run must not replace committed evidence.
if (args.includes("--write-fixtures")) {
	if (problems.length > 0) fail(`refusing to write fixtures from a run with problems:\n${problems.join("\n")}`);
	// A full run replaces the directory's contents; a --scenario run refreshes only its own fixtures.
	writePrimeFixturesV0(join(fixtureRoot, provenance.version), evidence, { prune: only.length === 0 });
	process.stdout.write(`fixtures written to ${join(fixtureRoot, provenance.version)}\n`);
}

for (const finding of report.findings) {
	process.stdout.write(`${finding.contract.padEnd(22)} ${finding.support.padEnd(14)} ${finding.semanticFit}\n`);
}
if (report.drift.stale) {
	process.stdout.write(
		`STALE: committed fixtures are from Prime ${report.drift.referenceVersion}${report.drift.referenceCommit ? ` @ ${report.drift.referenceCommit}` : ""}; ` +
			`this run used ${report.drift.evidenceVersion}. Review the findings and refresh with --write-fixtures.\n`,
	);
}
if (report.drift.unverified) {
	process.stdout.write(
		`UNVERIFIED: committed fixtures are pinned to Prime ${report.drift.referenceVersion} @ ${report.drift.referenceCommit}; ` +
			"this binary reports the same version but no commit, so the build cannot be confirmed.\n",
	);
}
process.stdout.write(`report: ${reportPath}\n`);

if (problems.length > 0) fail(`\n${problems.join("\n")}`);
