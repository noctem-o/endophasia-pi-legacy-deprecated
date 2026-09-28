import { defineFacet, type Facet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { attachUsageFeedV0, type UsageFeedSourceV0 } from "./usage-feed.ts";
import {
	projectUsageLedgerRowV0,
	readUsageLedgerV0,
	type UsageLedgerQueryV0,
	type UsageLedgerRowV0,
} from "./usage-ledger.ts";
import { EndophasiaUsageV0, USAGE_REPLICATED_ROW_LIMIT, type UsageObservationV0 } from "./usage-service.ts";

/**
 * Accept a remote page query only as sent: a plain object with optional numeric afterSequence and limit (undefined is
 * accepted from in-process callers). Anything else is rejected rather than coerced or read as the default query; the
 * numeric ranges are checked by readUsageLedgerV0.
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

/**
 * Provide EndophasiaUsageV0 from one Session's durable usage ledger. The facet needs only usage events and durable
 * usage reads, which MUST belong to the same Session (see UsageFeedSourceV0).
 *
 * On activation it seeds the window from the latest rows alone, never replaying the whole ledger, then attaches the
 * gap-safe usage feed after the last seeded row: a row committed after the seed read is still found by the feed's own
 * catch-up. If either step fails, activation fails instead of presenting an empty ledger. Memory stays bounded to the
 * window, and the feed is unsubscribed when the facet is disposed.
 */
export function createEndophasiaUsageFacetV0(source: UsageFeedSourceV0): Facet {
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
				page: (query, context) => readUsageLedgerV0(source.session, parseUsageLedgerQuery(query), context),
			});
			env.onActivate(async () => {
				const recent = await source.session.scanUsage(
					{ order: "desc", limit: USAGE_REPLICATED_ROW_LIMIT + 1 },
					BACKGROUND_CONTEXT,
				);
				const rows = recent.slice(0, USAGE_REPLICATED_ROW_LIMIT).reverse().map(projectUsageLedgerRowV0);
				state.replace(BACKGROUND_CONTEXT, {
					schemaVersion: "usage-observation.v0",
					scope: "session",
					hasEarlierRows: recent.length > USAGE_REPLICATED_ROW_LIMIT,
					rows,
				});
				const feed = await attachUsageFeedV0(
					source,
					{ afterSequence: rows.at(-1)?.sequence ?? 0 },
					(row) => append(row),
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
