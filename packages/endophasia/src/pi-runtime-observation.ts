// Pi runtime observation adapter v0: Pi's implementations of the runtime-neutral observation capabilities. This is the
// only place the observation services meet Pi's harness, lanes, events and Session usage reads; each capability
// delegates to the existing, tested Pi projection, so there is one source of truth per surface. Package-internal: a
// runtime composition root (the Endophasia Session worker) builds these and hands each facet only its capability.
import type { AgentHarness, AgentLane, Session } from "@earendil-works/pi-agent-core";
import { captureOperationOutcomeV0 } from "./durable-outcomes.ts";
import { observeMissionTraceV0 } from "./mission-trace.ts";
import { captureRuntimeMetricsV0 } from "./runtime-metrics.ts";
import type {
	RuntimeMetricsSourceV0,
	RuntimeMissionTraceSourceV0,
	RuntimeObservationSourcesV0,
	RuntimeOperationOutcomeSourceV0,
	RuntimeUsageSourceV0,
} from "./runtime-observation.ts";
import { attachUsageFeedV0, type UsageFeedSourceV0 } from "./usage-feed.ts";
import { readUsageLedgerTailV0, readUsageLedgerV0 } from "./usage-ledger.ts";

/** Mission Trace from the harness's public lifecycle events, through the Pi Mission Trace projection. */
export function createPiMissionTraceSourceV0(harness: Pick<AgentHarness, "events">): RuntimeMissionTraceSourceV0 {
	return { observe: (listener) => observeMissionTraceV0(harness, listener) };
}

/** Pi's maintained session accounting, read through a lane's watch(); the lane is only the access route. */
export function createPiRuntimeMetricsSourceV0(lane: Pick<AgentLane, "watch">): RuntimeMetricsSourceV0 {
	return { read: (context) => captureRuntimeMetricsV0(lane, context) };
}

/** Pi's immutable terminal result records, looked up by operation ID through a lane's getResult(). */
export function createPiOperationOutcomeSourceV0(lane: Pick<AgentLane, "getResult">): RuntimeOperationOutcomeSourceV0 {
	return { read: (operationId, context) => captureOperationOutcomeV0(lane, operationId, context) };
}

/**
 * Pi's durable session usage ledger. Pi's usage event carries no Session identity, so `events` and `session` MUST come
 * from the same harness and Session (see UsageFeedSourceV0): that trusted pairing stays below the neutral boundary.
 */
export function createPiUsageSourceV0(source: UsageFeedSourceV0): RuntimeUsageSourceV0 {
	return {
		tail: (limit, context) => readUsageLedgerTailV0(source.session, limit, context),
		page: (query, context) => readUsageLedgerV0(source.session, query, context),
		attach: (afterSequence, listener, context) => attachUsageFeedV0(source, { afterSequence }, listener, context),
	};
}

export interface PiRuntimeObservationInputV0 {
	/** The worker's harness, whose event bus carries both lifecycle and usage events. */
	readonly harness: Pick<AgentHarness, "events">;
	/** Any lane of that harness: its reads are the access route to session-wide facts. */
	readonly lane: Pick<AgentLane, "watch" | "getResult">;
	/** Durable usage reads of the same harness's Session. */
	readonly usageReader: Pick<Session, "scanUsage">;
}

/**
 * Pi supplies all four observation capabilities with the exact v0 semantics. Each is given only the Pi capability it
 * needs: the lane's watch or getResult, the event bus's `on`, the Session's scanUsage.
 */
export function createPiRuntimeObservationSourcesV0(
	input: PiRuntimeObservationInputV0,
): Required<RuntimeObservationSourcesV0> {
	const { harness, lane, usageReader } = input;
	return {
		missionTrace: createPiMissionTraceSourceV0(harness),
		runtimeMetrics: createPiRuntimeMetricsSourceV0({ watch: (context) => lane.watch(context) }),
		operationOutcome: createPiOperationOutcomeSourceV0({
			getResult: (operationId, context) => lane.getResult(operationId, context),
		}),
		usage: createPiUsageSourceV0({ events: { on: harness.events.on.bind(harness.events) }, session: usageReader }),
	};
}
