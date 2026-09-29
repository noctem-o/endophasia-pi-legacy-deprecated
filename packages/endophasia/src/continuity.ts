import type { AgentLane, Context, Entry, LaneSnapshot } from "@earendil-works/pi-agent-core";
import type { ContinuityEntryV0, ContinuitySnapshotV0 } from "./continuity-service.ts";

function projectEntry(entry: Entry): ContinuityEntryV0 {
	const base = { id: entry.id, parentId: entry.parentId, seq: entry.seq, timestamp: entry.timestamp };
	switch (entry.type) {
		case "message":
			return {
				...base,
				type: "message",
				role: entry.message.role,
				...(entry.message.role === "assistant" ? { stopReason: entry.message.stopReason } : {}),
				terminate: entry.terminate === true,
			};
		case "compaction":
			return {
				...base,
				type: "compaction",
				tokensBefore: entry.tokensBefore,
				retainedTailCount: entry.retainedTail.length,
				fromHook: entry.fromHook,
				hasSummary: entry.summary.length > 0,
			};
		case "branch_summary":
			return {
				...base,
				type: "branch_summary",
				fromId: entry.fromId,
				fromHook: entry.fromHook,
				hasSummary: entry.summary.length > 0,
			};
		case "custom":
			return { ...base, type: "custom", customType: entry.customType, hasData: entry.data !== undefined };
	}
}

function projectContinuity(point: LaneSnapshot, ancestry: Entry[]): ContinuitySnapshotV0 {
	const boundary = point.transcript[0];
	return {
		schemaVersion: "continuity.v0",
		lane: point.lane,
		tipId: point.tipId,
		configuration: {
			model: { provider: point.configuration.model.provider, modelId: point.configuration.model.modelId },
			thinkingLevel: point.configuration.thinkingLevel,
			activeToolNames: [...point.configuration.activeToolNames],
		},
		activePath: ancestry.map(projectEntry),
		contextWindow: point.transcript.map(projectEntry),
		compaction:
			boundary?.type === "compaction"
				? {
						entryId: boundary.id,
						tokensBefore: boundary.tokensBefore,
						retainedTailCount: boundary.retainedTail.length,
						fromHook: boundary.fromHook,
					}
				: null,
		counts: {
			activePathEntries: ancestry.length,
			contextWindowEntries: point.transcript.length,
			beforeContextWindow: ancestry.length - point.transcript.length,
		},
	};
}

/** Capture a payload-minimal, read-only explanation of one lane at one durable tip. */
export async function captureContinuityV0(
	lane: Pick<AgentLane, "watch" | "findEntries">,
	context: Context,
): Promise<ContinuitySnapshotV0> {
	const watch = await lane.watch(context);
	try {
		const point = watch.snapshot;
		const ancestry =
			point.tipId === null ? [] : await lane.findEntries({ start: point.tipId, order: "oldestFirst" }, context);
		return projectContinuity(point, ancestry);
	} finally {
		watch.unsubscribe();
	}
}
