// Source-only Endophasia application runtime, built on coding-agent's experimental Session worker. It is not part of
// the @endophasia/core build or package exports. spawnInternalProcess() preloads coding-agent's source resolver for
// this entry, which resolves its @earendil-works/* imports through tsconfig paths.

import type { Facet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import {
	type CodingAgentSessionWorkerHostRuntime,
	runCodingAgentSessionWorker,
} from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createEndophasiaContinuityFacetV0 } from "../src/continuity-facet.ts";
import { createEndophasiaInspectorFacetV0 } from "../src/inspector-service.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../src/mission-trace-service.ts";
import { createPiRuntimeObservationSourcesV0 } from "../src/pi-runtime-observation.ts";
import { createEndophasiaRuntimeFactsFacetV0 } from "../src/runtime-facts-service.ts";
import { createEndophasiaRuntimeProfileFacetV0, type RuntimeProfileClaimV0 } from "../src/runtime-profile-facet.ts";
import { createEndophasiaUsageFacetV0 } from "../src/usage-facet.ts";

/**
 * The standard worker's Runtime Profile: Endophasia's claim about this composition, not a Pi build identity or a
 * runtime self-report. Each capability is listed because createEndophasiaSessionWorkerFacetsV0 installs an
 * implementation of its exact v0 semantics; none is derived from the runtime family.
 */
export const PI_STANDARD_RUNTIME_PROFILE_V0: RuntimeProfileClaimV0 = Object.freeze({
	schemaVersion: "runtime-profile.v0",
	scope: "session-worker-lifetime",
	runtimeFamily: "pi",
	adapterProfileId: "endophasia.pi-standard.v0",
	capabilities: Object.freeze([
		// Inspector: Session Overview, read from Pi lanes outside the runtime observation boundary.
		"endophasia.session-overview.v0",
		// Mission Trace, Runtime Facts (two capabilities) and Usage, through Pi's runtime observation ports.
		"endophasia.mission-trace.v0",
		"endophasia.runtime-metrics.v0",
		"endophasia.operation-outcome.v0",
		"endophasia.usage.v0",
		// Continuity, Pi-backed on the main lane outside the runtime observation boundary.
		"endophasia.continuity.v0",
	] as const),
});

/**
 * The standard worker's trusted Endophasia host facets: the Runtime Profile, and the read-only Inspector, Mission
 * Trace, Runtime Facts, Usage and Continuity it advertises. This composition root is the one place that knows the
 * worker's runtime is Pi: it builds Pi's runtime observation capabilities, gives each facet only the capability it
 * needs, and states the profile explicitly. Continuity is Pi-backed by design and reads the main lane directly, not
 * through a runtime observation port.
 */
export async function createEndophasiaSessionWorkerFacetsV0({
	harness,
	usageReader,
}: CodingAgentSessionWorkerHostRuntime): Promise<Facet[]> {
	// The standard worker has already established the main lane, so this returns that lane without creating one.
	const main = await harness.lane("main", BACKGROUND_CONTEXT);
	// The worker's usage events and usage reader come from the same harness and Session, as Pi's usage feed requires.
	const pi = createPiRuntimeObservationSourcesV0({ harness, lane: main, usageReader });
	return [
		createEndophasiaRuntimeProfileFacetV0(PI_STANDARD_RUNTIME_PROFILE_V0),
		createEndophasiaInspectorFacetV0(harness),
		createEndophasiaMissionTraceFacetV0(pi.missionTrace),
		createEndophasiaRuntimeFactsFacetV0({
			runtimeMetrics: pi.runtimeMetrics,
			operationOutcome: pi.operationOutcome,
		}),
		createEndophasiaUsageFacetV0(pi.usage),
		// Only the main lane's watch and findEntries reads, the capability Continuity v0 capture needs.
		createEndophasiaContinuityFacetV0(main),
	];
}

/** Run the standard coding-agent Session worker with the Endophasia host facets. */
export function runEndophasiaSessionWorker(args: readonly string[]): Promise<void> {
	return runCodingAgentSessionWorker(args, { createHostFacets: createEndophasiaSessionWorkerFacetsV0 });
}

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") {
		throw new Error("Endophasia Session worker requires an internal session-worker invocation");
	}
	void runEndophasiaSessionWorker(process.argv.slice(2)).catch(() => process.exit(1));
}
