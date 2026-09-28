// Test-only Session worker: the Endophasia Inspector, Mission Trace and Runtime Facts without Usage, to prove
// Presentation Client v0 requires Usage too. Launched through startServer's sessionWorkerEntryUrl, like
// runtime/session-worker.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createEndophasiaInspectorFacetV0 } from "../../src/inspector-service.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../../src/mission-trace-service.ts";
import { createEndophasiaRuntimeFactsFacetV0 } from "../../src/runtime-facts-service.ts";

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Test Session worker requires an internal session-worker invocation");
	void runCodingAgentSessionWorker(process.argv.slice(2), {
		createHostFacets: async ({ harness }) => {
			const main = await harness.lane("main", BACKGROUND_CONTEXT);
			return [
				createEndophasiaInspectorFacetV0(harness),
				createEndophasiaMissionTraceFacetV0(harness),
				createEndophasiaRuntimeFactsFacetV0(main),
			];
		},
	}).catch(() => process.exit(1));
}
