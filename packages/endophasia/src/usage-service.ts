// The Usage contract only: schemas and the service handle, free of runtime reads, so presentations can bind it without
// bundling the ledger or feed implementation. The host facet is in usage-facet.ts.
import { type Context, defineService, type ReplicatedState } from "@earendil-works/chord";
import type { UsageLedgerPageV0, UsageLedgerQueryV0, UsageLedgerRowV0 } from "./usage-ledger.ts";

/**
 * Maximum number of durable usage rows retained in the replicated observation. A new or reconnecting consumer receives
 * the whole observation in one subscription snapshot, which must fit in one Pi frame (16 MiB by default); a saturated
 * window stays far below that. Older rows stay durable and are read with page().
 */
export const USAGE_REPLICATED_ROW_LIMIT = 1024;

/** A bounded, live view of the most recent durable usage records of one Session. */
export interface UsageObservationV0 {
	schemaVersion: "usage-observation.v0";
	/** Durable Session history, not the lifetime of the observing process: a new observer reseeds from the ledger. */
	scope: "session";
	/**
	 * True when durable usage rows exist before the first row retained here. Usage sequences are session-global and
	 * shared with other records, so a gap before the first row does not by itself mean rows were left out. Once true,
	 * it stays true.
	 */
	hasEarlierRows: boolean;
	/** The ascending trailing window of at most USAGE_REPLICATED_ROW_LIMIT durable rows, with their own sequences. */
	rows: UsageLedgerRowV0[];
}

/** Durable usage records of the attached Session: a bounded live observation, and forward page reads of the ledger. */
export interface EndophasiaUsageV0 {
	readonly state: ReplicatedState<UsageObservationV0>;
	/**
	 * A forward page of durable usage rows after an exclusive sequence cursor. Not an atomic snapshot of the ledger.
	 * Remote arguments are JSON, so the query is always an object; `{}` reads from the start with the default limit.
	 */
	page(query: UsageLedgerQueryV0, context: Context): Promise<UsageLedgerPageV0>;
}

export const EndophasiaUsageV0 = defineService<EndophasiaUsageV0>("endophasia.usage.v0");
