// Source-only Endophasia application runtime, built on coding-agent's experimental Session worker. It is not part of
// the @endophasia/core build or package exports. spawnInternalProcess() preloads coding-agent's source resolver for
// this entry, which resolves its @earendil-works/* imports through tsconfig paths.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createEndophasiaInspectorFacetV0 } from "../src/inspector-service.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../src/mission-trace-service.ts";
import { createEndophasiaRuntimeFactsFacetV0 } from "../src/runtime-facts-service.ts";
import { createEndophasiaUsageFacetV0 } from "../src/usage-facet.ts";

/**
 * Run the standard coding-agent Session worker with the read-only Endophasia Inspector, Mission Trace, Runtime Facts and
 * Usage as trusted host facets, each given only the harness, lane or Session capability it needs.
 */
export function runEndophasiaSessionWorker(args: readonly string[]): Promise<void> {
	return runCodingAgentSessionWorker(args, {
		createHostFacets: async ({ harness, usageReader }) => {
			// The standard worker has already established the main lane, so this returns that lane without creating one.
			const main = await harness.lane("main", BACKGROUND_CONTEXT);
			return [
				createEndophasiaInspectorFacetV0(harness),
				createEndophasiaMissionTraceFacetV0(harness),
				createEndophasiaRuntimeFactsFacetV0({
					watch: (context) => main.watch(context),
					getResult: (operationId, context) => main.getResult(operationId, context),
				}),
				// The worker's usage events and usage reader come from the same harness and Session, as the usage feed
				// requires; the facet can subscribe to events and read usage rows, nothing more.
				createEndophasiaUsageFacetV0({
					events: { on: harness.events.on.bind(harness.events) },
					session: usageReader,
				}),
			];
		},
	});
}

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") {
		throw new Error("Endophasia Session worker requires an internal session-worker invocation");
	}
	void runEndophasiaSessionWorker(process.argv.slice(2)).catch(() => process.exit(1));
}
