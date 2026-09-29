import { defineFacet, type Facet } from "@earendil-works/chord";
import type { AgentLane } from "@earendil-works/pi-agent-core";
import { captureContinuityV0 } from "./continuity.ts";
import {
	CONTINUITY_REMOTE_BYTE_LIMIT,
	type ContinuitySnapshotV0,
	EndophasiaContinuityV0,
} from "./continuity-service.ts";

/** Fail a snapshot whose JSON exceeds the remote byte limit. It is never truncated into a complete-looking snapshot. */
function withinRemoteLimit(snapshot: ContinuitySnapshotV0): ContinuitySnapshotV0 {
	const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
	if (bytes > CONTINUITY_REMOTE_BYTE_LIMIT) {
		throw new RangeError(
			`Continuity snapshot of lane ${snapshot.lane} is ${bytes} bytes with ${snapshot.counts.activePathEntries} active-path entries, over the ${CONTINUITY_REMOTE_BYTE_LIMIT}-byte remote limit; it is not truncated`,
		);
	}
	return snapshot;
}

/**
 * Provide EndophasiaContinuityV0 from one Pi lane, by design Pi-backed: each call is a fresh captureContinuityV0 of
 * that lane, which releases its temporary watcher, and nothing is held between calls. The facet receives only the
 * lane's watch and findEntries reads, never mutation authority. A failed capture fails the call; it is never replaced
 * by an empty snapshot.
 */
export function createEndophasiaContinuityFacetV0(lane: Pick<AgentLane, "watch" | "findEntries">): Facet {
	if (lane === undefined || lane === null) throw new TypeError("A Continuity lane is required");
	const reads: Pick<AgentLane, "watch" | "findEntries"> = {
		watch: (context) => lane.watch(context),
		findEntries: (query, context) => lane.findEntries(query, context),
	};
	return defineFacet({
		id: "@endophasia/continuity",
		setup(env) {
			env.provide(EndophasiaContinuityV0, {
				snapshot: async (context) => withinRemoteLimit(await captureContinuityV0(reads, context)),
			});
		},
	});
}
