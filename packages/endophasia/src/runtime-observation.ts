// Runtime observation boundary v0: the narrow capabilities through which Endophasia's observation services read a
// runtime. Each is defined in Endophasia's own v0 semantics, never a runtime's native vocabulary, and each is separate:
// a runtime implements only the capabilities it can provide truthfully. Presence means the exact v0 semantics are met;
// "something similar" is not an implementation. Runtime-specific adapters (e.g. pi-runtime-observation.ts) sit below.
import type { Context } from "@earendil-works/chord";
import type { MissionTraceEventV0 } from "./mission-trace-service.ts";
import type { OperationOutcomeV0, RuntimeMetricsV0 } from "./runtime-facts-service.ts";
import type { UsageLedgerPageV0, UsageLedgerQueryV0, UsageLedgerRowV0 } from "./usage-service.ts";

/**
 * Mission Trace v0 events as they happen, for the observing process's lifetime. The source owns the translation from
 * the runtime's native lifecycle.
 */
export interface RuntimeMissionTraceSourceV0 {
	/**
	 * Stream finished Mission Trace v0 events to one listener, numbered from sequence 1 in delivery order, without
	 * retaining them. A listener that throws must not stop the stream: later events are still numbered and delivered.
	 * The returned function stops observing and may be called repeatedly.
	 */
	observe(listener: (event: MissionTraceEventV0) => void): () => void;
}

/** Fresh reads of the Session's cumulative accounting, with the exact RuntimeMetricsV0 semantics. */
export interface RuntimeMetricsSourceV0 {
	/** Read failures propagate. */
	read(context: Context): Promise<RuntimeMetricsV0>;
}

/**
 * Lookup of an operation's immutable terminal result by its stable operation ID. A separate capability from metrics:
 * a runtime can account for usage without keeping any durable, identity-keyed operation result.
 */
export interface RuntimeOperationOutcomeSourceV0 {
	/**
	 * `null` means only that no durable terminal result exists for this ID at this read: it may be unknown or not yet
	 * terminal. Read failures propagate.
	 */
	read(operationId: string, context: Context): Promise<OperationOutcomeV0 | null>;
}

/** The latest durable usage rows, and whether any row precedes them. */
export interface RuntimeUsageTailV0 {
	/** At most the requested number of the latest rows, ascending by sequence. */
	rows: UsageLedgerRowV0[];
	/** True exactly when durable usage rows exist before the first row returned. */
	hasEarlierRows: boolean;
}

export type UsageFeedListenerV0 = (row: UsageLedgerRowV0) => void | Promise<void>;

export interface UsageFeedSubscriptionV0 {
	/** Greatest usage sequence whose listener invocation completed successfully: a safe resume cursor. */
	readonly afterSequence: number;
	/** False after unsubscribe() or after a listener failure. */
	readonly active: boolean;
	/** Idempotent. Stops future delivery. */
	unsubscribe(): void;
}

/**
 * The Session's durable usage ledger, in UsageLedgerRowV0 terms: session-global sequences with normal gaps, forward
 * pages after an exclusive cursor, and a gap-safe live feed. Which native reads and events serve it is the adapter's.
 */
export interface RuntimeUsageSourceV0 {
	/** The latest `limit` rows (a positive safe integer), for seeding a bounded window without replaying the ledger. */
	tail(limit: number, context: Context): Promise<RuntimeUsageTailV0>;
	/**
	 * A forward page of durable rows after an exclusive sequence cursor, with the UsageLedgerQueryV0 defaults and
	 * range checks. Not an atomic snapshot of the ledger. Read failures propagate.
	 */
	page(query: UsageLedgerQueryV0 | undefined, context: Context): Promise<UsageLedgerPageV0>;
	/**
	 * Attach a gap-safe feed of durable rows with sequence strictly greater than `afterSequence`, delivered one at a
	 * time in increasing sequence: committed rows first, then live rows, with no gap and no duplicate within one healthy
	 * attachment. Resolves once caught up and live. Across reconnects delivery is at-least-once: resume from the last
	 * applied row's sequence. A listener failure stops the feed without advancing past the failed row.
	 */
	attach(afterSequence: number, listener: UsageFeedListenerV0, context: Context): Promise<UsageFeedSubscriptionV0>;
}

/**
 * The observation capabilities one runtime provides. Every member is optional and independent: a runtime supplies
 * exactly those it can provide with the exact v0 semantics, and no capability implies another. A consumer that needs
 * one capability receives that capability alone, never this aggregate.
 */
export interface RuntimeObservationSourcesV0 {
	readonly missionTrace?: RuntimeMissionTraceSourceV0;
	readonly runtimeMetrics?: RuntimeMetricsSourceV0;
	readonly operationOutcome?: RuntimeOperationOutcomeSourceV0;
	readonly usage?: RuntimeUsageSourceV0;
}
