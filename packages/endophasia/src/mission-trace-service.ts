import { defineFacet, defineService, type Facet, type ReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { RuntimeMissionTraceSourceV0 } from "./runtime-observation.ts";

interface TraceBaseV0 {
	schemaVersion: "mission-trace.v0";
	sequence: number;
	lane: string;
}

interface RunTraceBaseV0 extends TraceBaseV0 {
	runId: string;
}

interface TurnTraceBaseV0 extends RunTraceBaseV0 {
	turnId: string;
}

interface ToolTraceBaseV0 extends TurnTraceBaseV0 {
	toolCallId: string;
	toolName: string;
}

export type MissionTraceEventV0 =
	| (RunTraceBaseV0 & { kind: "mission.started" })
	| (RunTraceBaseV0 & { kind: "mission.resumed" })
	| (RunTraceBaseV0 & { kind: "mission.suspended" })
	| (TurnTraceBaseV0 & { kind: "turn.started" })
	| (RunTraceBaseV0 & { kind: "model.completed" })
	| (ToolTraceBaseV0 & { kind: "tool.started" })
	| (ToolTraceBaseV0 & { kind: "tool.finished"; isError: boolean })
	| (TurnTraceBaseV0 & { kind: "turn.finished" })
	| (RunTraceBaseV0 & { kind: "mission.completed" })
	| (RunTraceBaseV0 & { kind: "mission.aborted" })
	| (RunTraceBaseV0 & { kind: "mission.failed" });

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
 * The event as the v0 schema defines it, field for field and in its field order: whatever else a source's object
 * carries (a payload, a runtime-native field) never crosses the service boundary.
 */
function missionTraceEventV0(event: MissionTraceEventV0): MissionTraceEventV0 {
	const { schemaVersion, sequence } = event;
	switch (event.kind) {
		case "turn.started":
		case "turn.finished":
			return {
				kind: event.kind,
				lane: event.lane,
				runId: event.runId,
				turnId: event.turnId,
				schemaVersion,
				sequence,
			};
		case "tool.started":
			return {
				kind: event.kind,
				lane: event.lane,
				runId: event.runId,
				turnId: event.turnId,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				schemaVersion,
				sequence,
			};
		case "tool.finished":
			return {
				kind: event.kind,
				lane: event.lane,
				runId: event.runId,
				turnId: event.turnId,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				schemaVersion,
				sequence,
			};
		default:
			return { kind: event.kind, lane: event.lane, runId: event.runId, schemaVersion, sequence };
	}
}

/**
 * Provide EndophasiaMissionTraceV0 from one Mission Trace source for the facet's lifetime. Nothing but the replicated
 * state's bounded trailing window is retained, so memory stays bounded however long the worker lives. The host owns
 * the authoritative state; consumers receive immutable replicated revisions. The facet knows nothing of how a runtime
 * produces its lifecycle: the source delivers finished Mission Trace v0 events.
 */
export function createEndophasiaMissionTraceFacetV0(source: RuntimeMissionTraceSourceV0): Facet {
	// An absent capability is never replaced by an empty trace: a runtime without one does not install this facet.
	if (source === undefined || source === null) throw new TypeError("A Mission Trace source is required");
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
			const stop = source.observe((event) => {
				const retained = missionTraceEventV0(event);
				state.change(BACKGROUND_CONTEXT, (draft) => {
					// Dropping the oldest event and appending the newest replicates as two small splices, not the window.
					if (draft.events.length >= MISSION_TRACE_REPLICATED_EVENT_LIMIT) {
						draft.events.splice(0, draft.events.length - MISSION_TRACE_REPLICATED_EVENT_LIMIT + 1);
					}
					draft.events.push(retained);
				});
			});
			env.own(stop);
		},
	});
}
