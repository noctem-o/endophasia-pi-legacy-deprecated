// Test-only Session worker: every Endophasia service except Continuity, to prove Presentation Client v0 requires
// Continuity itself. Launched through startServer's sessionWorkerEntryUrl, like runtime/session-worker.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createEndophasiaInspectorFacetV0 } from "../../src/inspector-service.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../../src/mission-trace-service.ts";
import { createPiRuntimeObservationSourcesV0 } from "../../src/pi-runtime-observation.ts";
import { createEndophasiaRuntimeFactsFacetV0 } from "../../src/runtime-facts-service.ts";
import { createEndophasiaUsageFacetV0 } from "../../src/usage-facet.ts";

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Test Session worker requires an internal session-worker invocation");
	void runCodingAgentSessionWorker(process.argv.slice(2), {
		createHostFacets: async ({ harness, usageReader }) => {
			const main = await harness.lane("main", BACKGROUND_CONTEXT);
			const pi = createPiRuntimeObservationSourcesV0({ harness, lane: main, usageReader });
			return [
				createEndophasiaInspectorFacetV0(harness),
				createEndophasiaMissionTraceFacetV0(pi.missionTrace),
				createEndophasiaRuntimeFactsFacetV0({
					runtimeMetrics: pi.runtimeMetrics,
					operationOutcome: pi.operationOutcome,
				}),
				createEndophasiaUsageFacetV0(pi.usage),
			];
		},
	}).catch(() => process.exit(1));
}
