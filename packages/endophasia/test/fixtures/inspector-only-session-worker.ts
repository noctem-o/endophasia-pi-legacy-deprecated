// Test-only Session worker: the Endophasia Inspector without Mission Trace, to prove Presentation Client v0 requires
// both. Launched through startServer's sessionWorkerEntryUrl, like runtime/session-worker.ts.
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createEndophasiaInspectorFacetV0 } from "../../src/inspector-service.ts";

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Test Session worker requires an internal session-worker invocation");
	void runCodingAgentSessionWorker(process.argv.slice(2), {
		createHostFacets: ({ harness }) => [createEndophasiaInspectorFacetV0(harness)],
	}).catch(() => process.exit(1));
}
