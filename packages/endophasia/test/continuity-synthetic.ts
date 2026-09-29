// Test-only: a lane read capability whose captured tip has a synthetic, arbitrarily long durable ancestry, to measure
// Continuity's remote size limit without writing tens of thousands of real entries. Configuration and the context
// window come from a real lane; only the tip and its ancestry are synthetic.
import type { AgentLane, Context, Entry } from "@earendil-works/pi-agent-core";
import { captureContinuityV0 } from "../src/continuity.ts";
import { CONTINUITY_REMOTE_BYTE_LIMIT } from "../src/continuity-service.ts";

export type ContinuityReads = Pick<AgentLane, "watch" | "findEntries">;

/** Every synthetic entry projects to the same number of JSON bytes: fixed-width IDs and sequences. */
function syntheticAncestry(count: number): Entry[] {
	return Array.from(
		{ length: count },
		(_, index) =>
			({
				id: `e${String(index).padStart(7, "0")}`,
				parentId: `p${String(index).padStart(7, "0")}`,
				seq: 1_000_000 + index,
				timestamp: 1,
				type: "custom",
				customType: "x".repeat(1_000),
			}) as unknown as Entry,
	);
}

export function syntheticContinuityLane(lane: ContinuityReads, count: number): ContinuityReads {
	const ancestry = syntheticAncestry(count);
	return {
		watch: async (context) => {
			const watch = await lane.watch(context);
			return {
				snapshot: { ...watch.snapshot, tipId: ancestry.at(-1)?.id ?? null },
				unsubscribe: () => watch.unsubscribe(),
			} as typeof watch;
		},
		findEntries: async () => ancestry,
	};
}

async function snapshotBytes(lane: ContinuityReads, count: number, context: Context): Promise<number> {
	const snapshot = await captureContinuityV0(syntheticContinuityLane(lane, count), context);
	return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
}

/** The largest synthetic ancestry whose snapshot is at most CONTINUITY_REMOTE_BYTE_LIMIT bytes, and its exact size. */
export async function largestSyntheticCountWithinLimit(
	lane: ContinuityReads,
	context: Context,
): Promise<{ count: number; bytes: number }> {
	const one = await snapshotBytes(lane, 1, context);
	const perEntry = (await snapshotBytes(lane, 2, context)) - one;
	// An estimate: the counts' digits also grow with the ancestry, so settle on the exact boundary by measurement.
	let count = Math.floor((CONTINUITY_REMOTE_BYTE_LIMIT - one) / perEntry) + 1;
	let bytes = await snapshotBytes(lane, count, context);
	while (bytes > CONTINUITY_REMOTE_BYTE_LIMIT) bytes = await snapshotBytes(lane, --count, context);
	for (;;) {
		const next = await snapshotBytes(lane, count + 1, context);
		if (next > CONTINUITY_REMOTE_BYTE_LIMIT) return { count, bytes };
		count++;
		bytes = next;
	}
}
