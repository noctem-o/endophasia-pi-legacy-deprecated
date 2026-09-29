// Test-only Session worker: the Endophasia Inspector and Mission Trace without Runtime Facts (or Usage), to prove
// Presentation Client v0 requires Runtime Facts. Launched through startServer's sessionWorkerEntryUrl, like runtime/session-worker.ts.
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createEndophasiaInspectorFacetV0 } from "../../src/inspector-service.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../../src/mission-trace-service.ts";
import { createPiMissionTraceSourceV0 } from "../../src/pi-runtime-observation.ts";

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Test Session worker requires an internal session-worker invocation");
	void runCodingAgentSessionWorker(process.argv.slice(2), {
		createHostFacets: ({ harness }) => [
			createEndophasiaInspectorFacetV0(harness),
			createEndophasiaMissionTraceFacetV0(createPiMissionTraceSourceV0(harness)),
		],
	}).catch(() => process.exit(1));
}
