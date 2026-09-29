import { defineFacet, type Facet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { RuntimeUsageSourceV0 } from "./runtime-observation.ts";
import {
	EndophasiaUsageV0,
	USAGE_REPLICATED_ROW_LIMIT,
	type UsageLedgerPageV0,
	type UsageLedgerQueryV0,
	type UsageLedgerRowV0,
	type UsageObservationV0,
} from "./usage-service.ts";

/**
 * Accept a remote page query only as sent: a plain object with optional numeric afterSequence and limit (undefined is
 * accepted from in-process callers). Anything else is rejected rather than coerced or read as the default query; the
 * numeric ranges are checked by the source's page read.
 */
function parseUsageLedgerQuery(query: unknown): UsageLedgerQueryV0 | undefined {
	if (query === undefined) return undefined;
	if (query === null || typeof query !== "object" || Object.getPrototypeOf(query) !== Object.prototype) {
		throw new TypeError("Usage ledger query must be a plain object");
	}
	const record = query as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "afterSequence" && key !== "limit") throw new TypeError(`Unknown usage ledger query field: ${key}`);
	}
	const { afterSequence, limit } = record;
	if (afterSequence !== undefined && typeof afterSequence !== "number") {
		throw new TypeError("Usage ledger cursor must be a number");
	}
	if (limit !== undefined && typeof limit !== "number") throw new TypeError("Usage ledger limit must be a number");
	return {
		...(afterSequence === undefined ? {} : { afterSequence }),
		...(limit === undefined ? {} : { limit }),
	};
}

/** The row as the v0 schema defines it, field for field: details or native fields never cross the boundary. */
function usageLedgerRowV0(row: UsageLedgerRowV0): UsageLedgerRowV0 {
	const { usage } = row;
	return {
		id: row.id,
		sequence: row.sequence,
		adjustment: row.adjustment,
		...(row.entryId === undefined ? {} : { entryId: row.entryId }),
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

function usageLedgerPageV0(page: UsageLedgerPageV0): UsageLedgerPageV0 {
	return {
		schemaVersion: page.schemaVersion,
		scope: page.scope,
		order: page.order,
		rows: page.rows.map(usageLedgerRowV0),
		nextAfterSequence: page.nextAfterSequence,
	};
}

/**
 * Provide EndophasiaUsageV0 from one Session's durable usage ledger, through the runtime's Usage source alone.
 *
 * On activation it seeds the window from the latest rows alone, never replaying the whole ledger, then attaches the
 * gap-safe usage feed after the last seeded row: a row committed after the seed read is still found by the feed's own
 * catch-up. If either step fails, activation fails instead of presenting an empty ledger. Memory stays bounded to the
 * window, and the feed is unsubscribed when the facet is disposed. An absent capability is never replaced by an empty
 * ledger: a runtime without one does not install this facet.
 */
export function createEndophasiaUsageFacetV0(source: RuntimeUsageSourceV0): Facet {
	if (source === undefined || source === null) throw new TypeError("A Usage source is required");
	return defineFacet({
		id: "@endophasia/usage",
		setup(env) {
			const state = env.replicatedState<UsageObservationV0>({
				schemaVersion: "usage-observation.v0",
				scope: "session",
				hasEarlierRows: false,
				rows: [],
			});
			env.provide(EndophasiaUsageV0, {
				state,
				page: async (query, context) => usageLedgerPageV0(await source.page(parseUsageLedgerQuery(query), context)),
			});
			env.onActivate(async () => {
				const tail = await source.tail(USAGE_REPLICATED_ROW_LIMIT, BACKGROUND_CONTEXT);
				// The window stays bounded even if a source returns more rows than asked; the extra rows are then earlier.
				const rows = tail.rows.slice(-USAGE_REPLICATED_ROW_LIMIT).map(usageLedgerRowV0);
				state.replace(BACKGROUND_CONTEXT, {
					schemaVersion: "usage-observation.v0",
					scope: "session",
					hasEarlierRows: tail.hasEarlierRows === true || tail.rows.length > USAGE_REPLICATED_ROW_LIMIT,
					rows,
				});
				const feed = await source.attach(
					rows.at(-1)?.sequence ?? 0,
					(row) => append(usageLedgerRowV0(row)),
					BACKGROUND_CONTEXT,
				);
				env.own(() => feed.unsubscribe());
			});

			function append(row: UsageLedgerRowV0): void {
				try {
					state.change(BACKGROUND_CONTEXT, (draft) => {
						// Dropping the oldest row and appending the newest replicates as two small splices, not the window.
						if (draft.rows.length >= USAGE_REPLICATED_ROW_LIMIT) {
							draft.rows.splice(0, draft.rows.length - USAGE_REPLICATED_ROW_LIMIT + 1);
							draft.hasEarlierRows = true;
						}
						draft.rows.push(row);
					});
				} catch (error) {
					// A failing state subscriber is reported after the row was adopted; it must not stop the durable feed.
					if (state.value.rows.at(-1)?.sequence !== row.sequence) throw error;
				}
			}
		},
	});
}
