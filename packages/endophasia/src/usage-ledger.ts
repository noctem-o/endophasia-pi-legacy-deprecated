// Pi-specific: reads Pi's durable session usage ledger and projects its rows onto the runtime-neutral usage schema.
import type { Context, Session, UsageRow } from "@earendil-works/pi-agent-core";
import type { RuntimeUsageTailV0 } from "./runtime-observation.ts";
import type { UsageLedgerPageV0, UsageLedgerQueryV0, UsageLedgerRowV0 } from "./usage-service.ts";

// The schemas are the runtime-neutral contract's; re-exported for the modules that already import them from here.
export type { UsageLedgerPageV0, UsageLedgerQueryV0, UsageLedgerRowV0 };

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

/** Package-internal: the one payload-minimal projection shared by the ledger inspector and the usage feed. */
export function projectUsageLedgerRowV0(row: UsageRow): UsageLedgerRowV0 {
	const { usage } = row;
	return {
		id: row.id,
		sequence: row.seq,
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

/** Page forward through Pi's durable session usage ledger. Read failures propagate. */
export async function readUsageLedgerV0(
	session: Pick<Session, "scanUsage">,
	query: UsageLedgerQueryV0 | undefined,
	context: Context,
): Promise<UsageLedgerPageV0> {
	const afterSequence = query?.afterSequence ?? 0;
	const limit = query?.limit ?? DEFAULT_LIMIT;
	if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
		throw new RangeError("Invalid usage ledger cursor");
	}
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new RangeError("Invalid usage ledger limit");
	}
	// Pi's fromSeq is inclusive; afterSequence is exclusive.
	const rows =
		afterSequence === Number.MAX_SAFE_INTEGER
			? []
			: (await session.scanUsage({ fromSeq: afterSequence + 1, order: "asc", limit }, context)).map(
					projectUsageLedgerRowV0,
				);
	return {
		schemaVersion: "usage-ledger.v0",
		scope: "session",
		order: "ascending",
		rows,
		nextAfterSequence: rows.length === 0 ? afterSequence : rows[rows.length - 1]!.sequence,
	};
}

/**
 * Read the latest `limit` rows of Pi's durable session usage ledger, ascending, and whether any row precedes them, from
 * one descending read of limit + 1 rows: the whole ledger is never replayed. Read failures propagate.
 */
export async function readUsageLedgerTailV0(
	session: Pick<Session, "scanUsage">,
	limit: number,
	context: Context,
): Promise<RuntimeUsageTailV0> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) {
		throw new RangeError("Invalid usage tail limit");
	}
	const recent = await session.scanUsage({ order: "desc", limit: limit + 1 }, context);
	return {
		rows: recent.slice(0, limit).reverse().map(projectUsageLedgerRowV0),
		hasEarlierRows: recent.length > limit,
	};
}
