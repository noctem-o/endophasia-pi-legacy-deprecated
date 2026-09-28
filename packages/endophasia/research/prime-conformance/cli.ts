// Research-only (Prime Runtime Conformance v0). Opt-in live probe: `PRIME_AGENT_BIN=... npm run check:prime-conformance`.
// Never downloads Prime and never runs in CI. Writes .artifacts/prime-conformance/report.json (outside git).
//
// Flags: --scenario <name> (repeatable), --write-fixtures (refresh test/fixtures/prime/<version>/; needs a clean
// PRIME_AGENT_ROOT checkout and a fully valid run), --retain (keep the temporary Prime environments for inspection).
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPrimeConformanceCommandV0 } from "./command.ts";
import { resolvePrimeBinaryV0 } from "./environment.ts";
import { describePrimeV0, runPrimeProbeV0, SCENARIOS } from "./probe.ts";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

process.exitCode = await runPrimeConformanceCommandV0(process.argv.slice(2), {
	env: process.env,
	fixtureRoot: join(packageRoot, "test", "fixtures", "prime"),
	artifactDir: join(repoRoot, ".artifacts", "prime-conformance"),
	scenarios: SCENARIOS.map((scenario) => scenario.name),
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	resolveBinary: resolvePrimeBinaryV0,
	describe: describePrimeV0,
	probe: runPrimeProbeV0,
});
