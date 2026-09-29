// Pi-specific: projects Pi's maintained session accounting onto the runtime-neutral RuntimeMetricsV0 schema.
import type { AgentLane, Context, SessionStats } from "@earendil-works/pi-agent-core";
import type { RuntimeMetricsV0 } from "./runtime-facts-service.ts";

// The schema is the runtime-neutral contract's; re-exported for the modules that already import it from here.
export type { RuntimeMetricsV0 };

function projectStats(stats: SessionStats): RuntimeMetricsV0 {
	const { usage } = stats;
	return {
		schemaVersion: "runtime-metrics.v0",
		scope: "session",
		messageCount: stats.messageCount,
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

/**
 * Capture Pi's maintained, session-wide accounting with a short-lived watch of a lane. The lane is only the access
 * route; these totals are not attributable to it. Read failures propagate.
 */
export async function captureRuntimeMetricsV0(
	lane: Pick<AgentLane, "watch">,
	context: Context,
): Promise<RuntimeMetricsV0> {
	const watch = await lane.watch(context);
	try {
		return projectStats(watch.snapshot.stats);
	} finally {
		watch.unsubscribe();
	}
}
