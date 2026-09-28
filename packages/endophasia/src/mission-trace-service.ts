import { defineFacet, defineService, type Facet, type ReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import { type MissionTraceEventV0, observeMissionTraceV0 } from "./mission-trace.ts";

/**
 * Maximum number of Mission Trace events retained in the replicated observation. Every new or reconnecting consumer
 * receives the whole observation in one subscription snapshot, which must fit in one Pi frame (16 MiB by default).
 * A retained event is a few hundred bytes, so this window stays well under 1 MiB, while it is still far larger than
 * any consumer's view (the Standard Cockpit shows the latest 50 events).
 */
export const MISSION_TRACE_REPLICATED_EVENT_LIMIT = 1024;

/**
 * A bounded recent window of the Mission Trace a Session worker has observed since it activated. It is not durable
 * Session history: events from before activation or from a previous worker process are absent, and a new worker starts
 * again at sequence 1. Event order is the sequence order; the trace carries no event times.
 */
export interface MissionTraceObservationV0 {
	schemaVersion: "mission-trace-observation.v0";
	/**
	 * The lifetime being observed: the current Session worker's. It does not promise that every event of that lifetime
	 * is still retained here.
	 */
	scope: "session-worker-lifetime";
	/**
	 * The trailing window of at most MISSION_TRACE_REPLICATED_EVENT_LIMIT events, unchanged, with their original
	 * sequences and in sequence order. Older events are dropped from this window and cannot be retrieved through it; a
	 * first retained sequence above 1 means earlier events were dropped.
	 */
	events: MissionTraceEventV0[];
}

/** Live, read-only Mission Trace v0 observations exposed through Chord's remote service boundary. */
export interface EndophasiaMissionTraceV0 {
	readonly state: ReplicatedState<MissionTraceObservationV0>;
}

export const EndophasiaMissionTraceV0 = defineService<EndophasiaMissionTraceV0>("endophasia.mission-trace.v0");

/**
 * Provide EndophasiaMissionTraceV0 from one streaming Mission Trace observer for the facet's lifetime. Nothing but the
 * replicated state's bounded trailing window is retained, so memory stays bounded however long the worker lives. The
 * host owns the authoritative state; consumers receive immutable replicated revisions. It needs only the harness event
 * bus.
 */
export function createEndophasiaMissionTraceFacetV0(harness: Pick<AgentHarness, "events">): Facet {
	return defineFacet({
		id: "@endophasia/mission-trace",
		setup(env) {
			const state = env.replicatedState<MissionTraceObservationV0>({
				schemaVersion: "mission-trace-observation.v0",
				scope: "session-worker-lifetime",
				events: [],
			});
			env.provide(EndophasiaMissionTraceV0, { state });
			// Observe from setup, before any other worker service runs, so the trace covers the whole worker lifetime.
			const stop = observeMissionTraceV0(harness, (event) => {
				state.change(BACKGROUND_CONTEXT, (draft) => {
					// Dropping the oldest event and appending the newest replicates as two small splices, not the window.
					if (draft.events.length >= MISSION_TRACE_REPLICATED_EVENT_LIMIT) {
						draft.events.splice(0, draft.events.length - MISSION_TRACE_REPLICATED_EVENT_LIMIT + 1);
					}
					draft.events.push(event);
				});
			});
			env.own(stop);
		},
	});
}
