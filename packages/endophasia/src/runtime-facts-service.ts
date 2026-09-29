import { type Context, defineFacet, defineService, type Facet } from "@earendil-works/chord";
import type { RuntimeMetricsSourceV0, RuntimeOperationOutcomeSourceV0 } from "./runtime-observation.ts";

/**
 * A Session's maintained, session-wide accounting at one snapshot. It is not attributable to any lane.
 * Cumulative accounting, not current context-window occupancy. Recorded/accounted cost, not a provider invoice.
 * Totals include usage from failed, retried, and aborted attempts, plus caller adjustments, which may be negative.
 */
export interface RuntimeMetricsV0 {
	schemaVersion: "runtime-metrics.v0";
	scope: "session";
	/** Number of persisted `message` entries in the session, of any role. */
	messageCount: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		/** Present only once some accounted row reported it. Subset of cacheWrite. */
		cacheWrite1h?: number;
		/** Present only once some accounted row reported it. Subset of output. */
		reasoning?: number;
		/** Sum of reported totalTokens; not recomputed from the components. */
		totalTokens: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};
}

/**
 * Payload-minimal projection of the immutable terminal result record for one operation ID.
 * It carries no lane: the result lookup is keyed by operation ID only, so the lane used for the read does not
 * establish which lane ran the operation.
 */
export interface OperationOutcomeV0 {
	schemaVersion: "operation-outcome.v0";
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	status: "completed" | "declined" | "aborted" | "failed";
	fromTipId: string | null;
	tipId: string | null;
	startedAt: number;
	endedAt: number;
	/** The machine-readable error code only; message and details are never exposed. */
	errorCode?: string;
}

/**
 * Read-only runtime facts, each captured fresh per request and exposed through Chord's remote service boundary.
 * They are separate facts, not one snapshot: neither is live, and nothing joins them.
 */
export interface EndophasiaRuntimeFactsV0 {
	/**
	 * Cumulative session accounting at this read. Not attributable to any lane, not current context occupancy, not a
	 * provider invoice, and not guaranteed monotonic.
	 */
	runtimeMetrics(context: Context): Promise<RuntimeMetricsV0>;
	/**
	 * The durable terminal outcome of one operation. `null` means only that the runtime returned no durable result for
	 * this ID at this read: the ID may be unknown or not yet terminal.
	 */
	operationOutcome(operationId: string, context: Context): Promise<OperationOutcomeV0 | null>;
}

export const EndophasiaRuntimeFactsV0 = defineService<EndophasiaRuntimeFactsV0>("endophasia.runtime-facts.v0");

/** The two capabilities this combined service needs. They are independent: neither implies the other. */
export interface EndophasiaRuntimeFactsSourcesV0 {
	readonly runtimeMetrics: RuntimeMetricsSourceV0;
	readonly operationOutcome: RuntimeOperationOutcomeSourceV0;
}

/** The metrics as the v0 schema defines them, field for field: nothing else a source attaches crosses the boundary. */
function runtimeMetricsV0(metrics: RuntimeMetricsV0): RuntimeMetricsV0 {
	const { usage } = metrics;
	return {
		schemaVersion: metrics.schemaVersion,
		scope: metrics.scope,
		messageCount: metrics.messageCount,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
			...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
			totalTokens: usage.totalTokens,
			cost: {
				input: usage.cost.input,
				output: usage.cost.output,
				cacheRead: usage.cost.cacheRead,
				cacheWrite: usage.cost.cacheWrite,
				total: usage.cost.total,
			},
		},
	};
}

/** The outcome as the v0 schema defines it: an error message or details a source attaches never cross the boundary. */
function operationOutcomeV0(outcome: OperationOutcomeV0): OperationOutcomeV0 {
	return {
		schemaVersion: outcome.schemaVersion,
		operationId: outcome.operationId,
		kind: outcome.kind,
		status: outcome.status,
		fromTipId: outcome.fromTipId,
		tipId: outcome.tipId,
		startedAt: outcome.startedAt,
		endedAt: outcome.endedAt,
		...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
	};
}

/**
 * Provide EndophasiaRuntimeFactsV0 from two separate capabilities, delegating each call; it keeps no state between
 * calls. Both are required: this combined service is installed only where a runtime truthfully provides both, and an
 * absent capability is never replaced by a synthesized empty or zero one.
 */
export function createEndophasiaRuntimeFactsFacetV0(sources: EndophasiaRuntimeFactsSourcesV0): Facet {
	const { runtimeMetrics, operationOutcome } = sources ?? {};
	if (runtimeMetrics === undefined || runtimeMetrics === null)
		throw new TypeError("A Runtime Metrics source is required");
	if (operationOutcome === undefined || operationOutcome === null) {
		throw new TypeError("An Operation Outcome source is required");
	}
	return defineFacet({
		id: "@endophasia/runtime-facts",
		setup(env) {
			env.provide(EndophasiaRuntimeFactsV0, {
				runtimeMetrics: async (context) => runtimeMetricsV0(await runtimeMetrics.read(context)),
				operationOutcome: async (operationId, context) => {
					// Remote arguments are only JSON: reject a non-string ID rather than pass it to the runtime.
					if (typeof operationId !== "string") throw new TypeError("Operation ID must be a string");
					const outcome = await operationOutcome.read(operationId, context);
					return outcome === null ? null : operationOutcomeV0(outcome);
				},
			});
		},
	});
}
