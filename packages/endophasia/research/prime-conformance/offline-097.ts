// Rebuild the report only from committed fixtures; never resolve or launch a Prime executable.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrime097Report, readAcpFixtures } from "./comparison.ts";
import { readPrimeFixturesV0 } from "./report.ts";

const root = fileURLToPath(new URL("../../test/fixtures/prime", import.meta.url));
const report = buildPrime097Report(
	readPrimeFixturesV0(join(root, "0.9.7", "rpc")),
	readAcpFixtures(join(root, "0.9.7", "acp")),
	readPrimeFixturesV0(join(root, "0.9.6")),
);
if (report.privacyViolations.length) throw new Error("report privacy violation");
process.stdout.write(`${JSON.stringify(report, null, "\t")}\n`);
process.exitCode = report.assessment.invalid.length || report.assessment.unpublishable.length ? 1 : 0;
