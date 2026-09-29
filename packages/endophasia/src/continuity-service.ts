// The Continuity contract only: the v0 schema and the service handle, free of Pi runtime reads, so presentations can
// bind it without bundling the capture. The Pi-backed capture is in continuity.ts and the host facet in
// continuity-facet.ts.
import { type Context, defineService } from "@earendil-works/chord";
import type { Entry, ThinkingLevel } from "@earendil-works/pi-agent-core";

interface ContinuityEntryBaseV0 {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
}

export type ContinuityEntryV0 =
	| (ContinuityEntryBaseV0 & {
			type: "message";
			role: Extract<Entry, { type: "message" }>["message"]["role"];
			stopReason?: string;
			terminate: boolean;
	  })
	| (ContinuityEntryBaseV0 & {
			type: "compaction";
			tokensBefore: number;
			retainedTailCount: number;
			fromHook: boolean;
			hasSummary: boolean;
	  })
	| (ContinuityEntryBaseV0 & {
			type: "branch_summary";
			fromId: string | null;
			fromHook: boolean;
			hasSummary: boolean;
	  })
	| (ContinuityEntryBaseV0 & {
			type: "custom";
			customType: string;
			hasData: boolean;
	  });

export interface ContinuitySnapshotV0 {
	schemaVersion: "continuity.v0";
	lane: string;
	tipId: string | null;
	configuration: {
		model: { provider: string; modelId: string };
		thinkingLevel: ThinkingLevel;
		activeToolNames: string[];
	};
	/** Committed ancestry of the captured tip, including history before compaction. */
	activePath: ContinuityEntryV0[];
	/** Pi's compaction-bounded source entries, not the final provider-visible prompt. */
	contextWindow: ContinuityEntryV0[];
	compaction: null | {
		entryId: string;
		tokensBefore: number;
		retainedTailCount: number;
		fromHook: boolean;
	};
	counts: {
		activePathEntries: number;
		contextWindowEntries: number;
		beforeContextWindow: number;
	};
}

/**
 * Largest Continuity snapshot, in UTF-8 bytes of its JSON, that the service returns. activePath is the tip's whole
 * durable ancestry and is unbounded; a larger snapshot fails the read instead of being truncated. A service result
 * reaches a Pi client in one frame (16 MiB by default), and a frame over the limit closes the client's whole
 * connection, so this leaves half the frame for the envelope and the encoding.
 */
export const CONTINUITY_REMOTE_BYTE_LIMIT = 8 * 1024 * 1024;

/** A read-only explanation of the attached Session's main lane at one durable tip. */
export interface EndophasiaContinuityV0 {
	/**
	 * A fresh Continuity v0 capture of the main lane on every call: nothing is cached and nothing is live. Fails, rather
	 * than returning part of the ancestry, when the snapshot exceeds CONTINUITY_REMOTE_BYTE_LIMIT.
	 */
	snapshot(context: Context): Promise<ContinuitySnapshotV0>;
}

export const EndophasiaContinuityV0 = defineService<EndophasiaContinuityV0>("endophasia.continuity.v0");
