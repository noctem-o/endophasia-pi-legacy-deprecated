// PR #26 checker controls only. Legacy captures are augmented in memory so gates can be tested before live refresh.
// These values are never reference provenance and must never be written to the repository's fixture directory.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpScenarioEvidence } from "../research/prime-conformance/acp-evidence.ts";
import { AUDITED_INSTRUMENT_097 } from "../research/prime-conformance/audited.ts";
import { PROBE_VERSION } from "../research/prime-conformance/evidence.ts";
import { readPrimeFixturesV0 } from "../research/prime-conformance/report.ts";

const root = fileURLToPath(new URL("./fixtures/prime", import.meta.url));
export const baseline = readPrimeFixturesV0(join(root, "0.9.6"));
export function controls() {
	const rpc = readPrimeFixturesV0(join(root, "0.9.7", "rpc"));
	const acp = readdirSync(join(root, "0.9.7", "acp")).map(
		(name) => JSON.parse(readFileSync(join(root, "0.9.7", "acp", name), "utf8")) as AcpScenarioEvidence,
	);
	const legacy = rpc[0]!.provenance.probeVersion !== PROBE_VERSION;
	for (const run of legacy ? [...rpc, ...acp] : [])
		Object.assign(run.provenance, {
			probeVersion: PROBE_VERSION,
			researchHash: AUDITED_INSTRUMENT_097.researchHash,
			endophasiaCommit: AUDITED_INSTRUMENT_097.endophasiaCommit,
			endophasiaBuild: "clean-checkout",
		});
	for (const run of legacy ? acp : []) {
		let session = 0;
		let ordinal = 0;
		for (const command of run.commands) {
			if (command.method === "session/new" && command.success) command.sessionId = run.sessionIds[session++];
			else if (command.method !== "initialize") command.sessionId = run.sessionIds[session - 1];
			if (command.method === "session/prompt" && run.provenance.scenario !== "unsupported-requests")
				command.ordinal = ++ordinal;
			if (command.method === "session/prompt" && run.provenance.scenario === "unsupported-requests")
				command.sessionId = "00000000-0000-0000-0000-000000000000";
			if (command.method === "session/cancel")
				Object.assign(command, {
					sessionId: run.updates[run.cancelAfter[0]!]!.sessionId,
					triggerIndex: run.cancelAfter[0],
				});
		}
	}
	return { rpc, acp };
}
