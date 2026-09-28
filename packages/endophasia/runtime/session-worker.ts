// Source-only Endophasia application runtime, built on coding-agent's experimental Session worker. It is not part of
// the @endophasia/core build or package exports. spawnInternalProcess() preloads coding-agent's source resolver for
// this entry, which resolves its @earendil-works/* imports through tsconfig paths.
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createEndophasiaInspectorFacetV0 } from "../src/inspector-service.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../src/mission-trace-service.ts";

/**
 * Run the standard coding-agent Session worker with the read-only Endophasia Inspector and Mission Trace as trusted
 * host facets, each given only the harness capability it needs.
 */
export function runEndophasiaSessionWorker(args: readonly string[]): Promise<void> {
	return runCodingAgentSessionWorker(args, {
		createHostFacets: ({ harness }) => [
			createEndophasiaInspectorFacetV0(harness),
			createEndophasiaMissionTraceFacetV0(harness),
		],
	});
}

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") {
		throw new Error("Endophasia Session worker requires an internal session-worker invocation");
	}
	void runEndophasiaSessionWorker(process.argv.slice(2)).catch(() => process.exit(1));
}
