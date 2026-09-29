// Opt-in only: independently exercise both actual process entrypoints, then the joint publication gate.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAcpProbe } from "./acp-probe.ts";
import { assessPrime097, buildPrime097Report, publishPrime097 } from "./comparison.ts";
import { resolvePrimeBinaryV0 } from "./environment.ts";
import { describePrimeV0, runPrimeProbeV0 } from "./probe.ts";
import { readPrimeFixturesV0, scanForSentinelsV0 } from "./report.ts";

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	if (args.length > 1 || args.some((arg) => arg !== "--write-fixtures"))
		throw new Error("usage: check:prime-conformance:097 [--write-fixtures]; full set only");
	const binary = resolvePrimeBinaryV0(process.env);
	if (!binary)
		throw new Error("set PRIME_AGENT_ROOT to the exact freshly built clean 0.9.7 source; never downloads Prime");
	const provenance = describePrimeV0(binary);
	const log = (message: string) => process.stdout.write(`${message}\n`);
	log(`Prime ${provenance.version} @ ${provenance.commit ?? "unknown"}; probe ${provenance.probeVersion}`);
	const rpc = await runPrimeProbeV0({ binary, provenance, log });
	const acp = await runAcpProbe(binary, provenance, log);
	const after = describePrimeV0(binary);
	if (JSON.stringify(after) !== JSON.stringify(provenance))
		throw new Error("build/research provenance changed during the run");
	// Nothing containing a sentinel is persisted, including failed-run diagnostics.
	if (scanForSentinelsV0("joint evidence", { rpc, acp }).length)
		throw new Error("privacy violation; no report or fixture written");
	const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
	const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
	const fixtureRoot = join(packageRoot, "test", "fixtures", "prime");
	const baseline = readPrimeFixturesV0(join(fixtureRoot, "0.9.6"));
	const report = buildPrime097Report(rpc, acp, baseline);
	if (report.privacyViolations.length) throw new Error("report privacy violation; nothing written");
	const artifacts = join(repoRoot, ".artifacts", "prime-conformance-097");
	mkdirSync(artifacts, { recursive: true });
	writeFileSync(join(artifacts, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);
	// Sanitized diagnostics allow inspection of invalid evidence without certifying it as a reference.
	writeFileSync(join(artifacts, "evidence.json"), `${JSON.stringify({ rpc, acp }, null, "\t")}\n`);
	const assessment = assessPrime097(rpc, acp);
	log(JSON.stringify(assessment));
	if (args.includes("--write-fixtures")) publishPrime097(fixtureRoot, rpc, acp, baseline);
	if (assessment.invalid.length || assessment.unpublishable.length) return 1;
	for (const capability of report.capabilities)
		log(
			`${capability.contract}: RPC ${capability.rpc.semanticFit}; ACP ${capability.acp.semanticFit}; durable exact unverified`,
		);
	log("candidate for PR #27: none exact");
	return 0;
}
try {
	process.exitCode = await main();
} catch (error) {
	// Internal diagnostics contain no raw protocol payloads.
	console.error(error instanceof Error ? error.message : "research probe failed");
	process.exitCode = 1;
}
