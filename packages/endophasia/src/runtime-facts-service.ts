import { type Context, defineFacet, defineService, type Facet } from "@earendil-works/chord";
import type { AgentLane } from "@earendil-works/pi-agent-core";
import { captureOperationOutcomeV0, type OperationOutcomeV0 } from "./durable-outcomes.ts";
import { captureRuntimeMetricsV0, type RuntimeMetricsV0 } from "./runtime-metrics.ts";

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

/**
 * Provide EndophasiaRuntimeFactsV0 by delegating each call to the existing Endophasia projections. It needs only a
 * lane's read capabilities, which serve as the access route to session-wide facts; it keeps no state between calls.
 */
export function createEndophasiaRuntimeFactsFacetV0(lane: Pick<AgentLane, "watch" | "getResult">): Facet {
	return defineFacet({
		id: "@endophasia/runtime-facts",
		setup(env) {
			env.provide(EndophasiaRuntimeFactsV0, {
				runtimeMetrics: (context) => captureRuntimeMetricsV0(lane, context),
				operationOutcome: async (operationId, context) => {
					// Remote arguments are only JSON: reject a non-string ID rather than pass it to the runtime.
					if (typeof operationId !== "string") throw new TypeError("Operation ID must be a string");
					return captureOperationOutcomeV0(lane, operationId, context);
				},
			});
		},
	});
}
