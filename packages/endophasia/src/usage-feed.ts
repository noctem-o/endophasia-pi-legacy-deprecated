// Pi-specific: the gap-safe feed over Pi's usage events and durable usage reads.
import type { Context, Events, Session, UsageRow } from "@earendil-works/pi-agent-core";
import type { UsageFeedListenerV0, UsageFeedSubscriptionV0 } from "./runtime-observation.ts";
import { projectUsageLedgerRowV0 } from "./usage-ledger.ts";

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 10_000;

/**
 * Trusted precondition: `events` and `session` MUST belong to the same Pi harness and session.
 * A usage event carries no session identity, so Endophasia cannot verify the pairing; gap safety holds only for a correct pair.
 */
export interface UsageFeedSourceV0 {
	events: Pick<Events, "on">;
	session: Pick<Session, "scanUsage">;
}

export interface UsageFeedOptionsV0 {
	/** Last durably applied Pi usage sequence; rows strictly greater are delivered. Default 0. */
	afterSequence?: number;
	/** Durable catch-up page size. Default 1000, maximum 10000. */
	pageSize?: number;
}

/**
 * Attach a gap-safe feed of durable usage rows, delivered as the same payload-minimal rows as readUsageLedgerV0.
 *
 * Order: subscribe to `usage` events (buffering) → read the durable high-water H → replay rows in
 * (afterSequence, H] in bounded pages → freeze the buffered events into one handoff batch and switch to live →
 * deliver that batch, all deduplicated by `seq > cursor`. Resolves once the handoff batch is delivered; later events
 * queue behind it. Rows are delivered one at a time, in increasing sequence.
 *
 * Within one healthy attachment no committed row is missed or delivered twice. Across reconnects delivery is
 * at-least-once: persist `row.sequence` after applying a row, and resume from it.
 *
 * A listener failure stops the feed without advancing past the failed row: during attachment the promise rejects;
 * when live, the error propagates to Pi's event bus (reported as `handler_error`).
 * Live delivery is awaited by Pi's event bus, so a slow listener backpressures harness event delivery, and a listener
 * must not await a Pi command that emits harness events (that command waits for its own queued delivery).
 */
export async function attachUsageFeedV0(
	source: UsageFeedSourceV0,
	options: UsageFeedOptionsV0 | undefined,
	listener: UsageFeedListenerV0,
	context: Context,
): Promise<UsageFeedSubscriptionV0> {
	const afterSequence = options?.afterSequence ?? 0;
	const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
	if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
		throw new RangeError("Invalid usage feed cursor");
	}
	if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
		throw new RangeError("Invalid usage feed page size");
	}

	let cursor = afterSequence;
	let state: "catching-up" | "live" | "stopped" = "catching-up";
	let buffered: UsageRow[] = [];
	let liveTail: Promise<void> = Promise.resolve();
	let removeListener: (() => void) | undefined;

	const stop = (): void => {
		if (state === "stopped") return;
		state = "stopped";
		buffered = [];
		removeListener?.();
		removeListener = undefined;
	};

	const deliver = async (row: UsageRow): Promise<void> => {
		if (state === "stopped" || row.seq <= cursor) return;
		try {
			await listener(projectUsageLedgerRowV0(row));
		} catch (error) {
			stop();
			throw error;
		}
		cursor = row.seq;
	};

	// Subscribe before the first durable read: every later commit binds this listener.
	removeListener = source.events.on("usage", (event) => {
		if (state === "catching-up") {
			buffered.push(event.row);
			return;
		}
		if (state !== "live") return;
		const delivery = liveTail.then(() => deliver(event.row));
		liveTail = delivery.catch(() => {});
		return delivery;
	});

	try {
		const [newest] = await source.session.scanUsage({ order: "desc", limit: 1 }, context);
		if (newest !== undefined) {
			// Finite boundary: rows after H arrive through the already-installed listener.
			const highWater = newest.seq;
			while (cursor < highWater) {
				const page = await source.session.scanUsage(
					{ fromSeq: cursor + 1, toSeq: highWater, order: "asc", limit: pageSize },
					context,
				);
				for (const row of page) await deliver(row);
				if (page.length < pageSize) break;
			}
		}
		// Freeze the rows buffered so far into one finite handoff batch, put it on the serialized live tail, and switch
		// to live with no await in between: every event is in the batch or queued behind it, never neither. Events
		// arriving while the batch delivers queue behind it (backpressuring their producer) instead of refilling a buffer.
		const handoff = buffered;
		buffered = [];
		const handoffDelivery = liveTail.then(async () => {
			for (const row of handoff) await deliver(row);
		});
		liveTail = handoffDelivery.catch(() => {});
		state = "live";
		await handoffDelivery;
	} catch (error) {
		stop();
		throw error;
	}

	return {
		get afterSequence() {
			return cursor;
		},
		get active() {
			return state === "live";
		},
		unsubscribe: stop,
	};
}
