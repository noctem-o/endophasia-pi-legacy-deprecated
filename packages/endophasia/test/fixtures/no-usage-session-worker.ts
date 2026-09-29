// Test-only Session worker: every Endophasia service except Usage, to prove Presentation Client v0 requires Usage
// itself. Its Runtime Profile truthfully advertises what it installs, without Usage. Launched through startServer's
// sessionWorkerEntryUrl, like runtime/session-worker.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createEndophasiaContinuityFacetV0 } from "../../src/continuity-facet.ts";
import { createEndophasiaInspectorFacetV0 } from "../../src/inspector-service.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../../src/mission-trace-service.ts";
import {
	createPiMissionTraceSourceV0,
	createPiOperationOutcomeSourceV0,
	createPiRuntimeMetricsSourceV0,
} from "../../src/pi-runtime-observation.ts";
import { createEndophasiaRuntimeFactsFacetV0 } from "../../src/runtime-facts-service.ts";
import { createEndophasiaRuntimeProfileFacetV0 } from "../../src/runtime-profile-facet.ts";

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Test Session worker requires an internal session-worker invocation");
	void runCodingAgentSessionWorker(process.argv.slice(2), {
		createHostFacets: async ({ harness }) => {
			const main = await harness.lane("main", BACKGROUND_CONTEXT);
			return [
				createEndophasiaRuntimeProfileFacetV0({
					schemaVersion: "runtime-profile.v0",
					scope: "session-worker-lifetime",
					runtimeFamily: "pi",
					adapterProfileId: "endophasia.test.no-usage.v0",
					capabilities: [
						"endophasia.session-overview.v0",
						"endophasia.mission-trace.v0",
						"endophasia.runtime-metrics.v0",
						"endophasia.operation-outcome.v0",
						"endophasia.continuity.v0",
					],
				}),
				createEndophasiaInspectorFacetV0(harness),
				createEndophasiaMissionTraceFacetV0(createPiMissionTraceSourceV0(harness)),
				createEndophasiaRuntimeFactsFacetV0({
					runtimeMetrics: createPiRuntimeMetricsSourceV0(main),
					operationOutcome: createPiOperationOutcomeSourceV0(main),
				}),
				createEndophasiaContinuityFacetV0(main),
			];
		},
	}).catch(() => process.exit(1));
}
