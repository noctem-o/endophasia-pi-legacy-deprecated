// Every diagnostic write passes this narrow privacy/shape gate, independently of scenario success.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcpScenarioEvidence } from "./acp-evidence.ts";
import { acpPrivacyShapeProblems } from "./acp-validation.ts";
import { buildPrime097Report } from "./comparison.ts";
import type { PrimeScenarioEvidenceV0 } from "./evidence.ts";
import { assertPlainEvidence } from "./plain-data.ts";
import { rpcPrivacyShapeProblems } from "./privacy-shape.ts";
import { scanForSentinelsV0 } from "./report.ts";

export function writePrime097Diagnostics(
	directory: string,
	rpc: readonly PrimeScenarioEvidenceV0[],
	acp: readonly AcpScenarioEvidence[],
	baseline: readonly PrimeScenarioEvidenceV0[],
) {
	try {
		assertPlainEvidence({ rpc, acp, baseline });
	} catch {
		throw new Error("privacy/shape violation; nothing written");
	}
	if (
		rpc.flatMap(rpcPrivacyShapeProblems).length ||
		acp.flatMap(acpPrivacyShapeProblems).length ||
		baseline.flatMap(rpcPrivacyShapeProblems).length ||
		scanForSentinelsV0("joint evidence and baseline", { rpc, acp, baseline }).length
	)
		throw new Error("privacy/shape violation; nothing written");
	const report = buildPrime097Report(rpc, acp, baseline);
	if (report.privacyViolations.length) throw new Error("report privacy violation; nothing written");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "evidence.json"), `${JSON.stringify({ rpc, acp }, null, "\t")}\n`);
	writeFileSync(join(directory, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);
	return report;
}
