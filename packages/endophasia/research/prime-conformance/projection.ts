// Research-only (Prime Runtime Conformance v0). Candidate projections of Prime's durable session entries into the
// Endophasia v0 usage and metrics shapes, built the only way the probe found truthful: by an adapter reading the
// session file itself. They exist to test that route (and to be scanned for leaked payloads), not to be consumed.
import type { RuntimeMetricsV0 } from "../../src/runtime-metrics.ts";
import type { UsageLedgerRowV0 } from "../../src/usage-ledger.ts";
import type { PrimeSessionEntryEvidenceV0 } from "./evidence.ts";
import type { PrimeUsageEvidenceV0 } from "./protocol.ts";

function rowUsage(usage: PrimeUsageEvidenceV0): UsageLedgerRowV0["usage"] {
	// Prime reports neither reasoning nor cacheWrite1h, so both stay absent rather than zero.
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { ...usage.cost },
	};
}

/**
 * One candidate row per durable usage-bearing entry, in file order. `sequence` is the adapter-assigned line ordinal
 * (1-based) in the append-only session file, not a Prime cursor. Assistant rows use the usage as written in the file:
 * Prime's reload-time child folding is not applied, and each child_usage_attributed entry is its own row.
 */
export function projectPrimeUsageRowsV0(entries: readonly PrimeSessionEntryEvidenceV0[]): UsageLedgerRowV0[] {
	const rows: UsageLedgerRowV0[] = [];
	entries.forEach((entry, index) => {
		const usage = entry.type === "child_usage_attributed" ? entry.childUsage : entry.usage;
		if (usage === undefined) return;
		rows.push({
			id: entry.id,
			sequence: index + 1,
			adjustment: false,
			entryId: entry.type === "child_usage_attributed" && entry.targetId !== undefined ? entry.targetId : entry.id,
			usage: rowUsage(usage),
		});
	});
	return rows;
}

/**
 * Cumulative session accounting rebuilt from one session file's entries: every usage row summed, so compaction does not
 * reduce it. `messageCount` counts persisted `message` entries of any role.
 */
export function rebuildPrimeRuntimeMetricsV0(entries: readonly PrimeSessionEntryEvidenceV0[]): RuntimeMetricsV0 {
	const total = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const row of projectPrimeUsageRowsV0(entries)) {
		total.input += row.usage.input;
		total.output += row.usage.output;
		total.cacheRead += row.usage.cacheRead;
		total.cacheWrite += row.usage.cacheWrite;
		total.totalTokens += row.usage.totalTokens;
		total.cost.input += row.usage.cost.input;
		total.cost.output += row.usage.cost.output;
		total.cost.cacheRead += row.usage.cost.cacheRead;
		total.cost.cacheWrite += row.usage.cost.cacheWrite;
		total.cost.total += row.usage.cost.total;
	}
	return {
		schemaVersion: "runtime-metrics.v0",
		scope: "session",
		messageCount: entries.filter((entry) => entry.type === "message").length,
		usage: total,
	};
}
