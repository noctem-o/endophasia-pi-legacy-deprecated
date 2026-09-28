// Offline tests for the research-only Prime Runtime Conformance v0 classification: Mission Trace mapping, projections,
// the conformance report, provenance, drift and privacy. They run on the committed sanitized fixtures; no Prime
// installation is needed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	checkAdapterIdentitiesV0,
	classifyPrimeConformanceV0,
	derivePrimeFactsV0,
} from "../research/prime-conformance/classification.ts";
import { SENTINEL_PATTERN, SENTINELS } from "../research/prime-conformance/fake-provider.ts";
import { mapPrimeMissionTraceV0, PRIME_ROOT_LANE_LABEL } from "../research/prime-conformance/mission-trace.ts";
import { projectPrimeUsageRowsV0, rebuildPrimeRuntimeMetricsV0 } from "../research/prime-conformance/projection.ts";
import {
	buildPrimeConformanceReportV0,
	checkPrimeDriftV0,
	readPrimeFixturesV0,
	writePrimeFixturesV0,
} from "../research/prime-conformance/report.ts";

const fixtureDir = fileURLToPath(new URL("./fixtures/prime/0.9.6", import.meta.url));
const cli = fileURLToPath(new URL("../research/prime-conformance/cli.ts", import.meta.url));
const fixtures = readPrimeFixturesV0(fixtureDir);
const fixture = (scenario: string) => {
	const found = fixtures.find((item) => item.provenance.scenario === scenario);
	if (found === undefined) throw new Error(`missing fixture ${scenario}`);
	return found;
};

describe("Mission Trace mapping", () => {
	it("maps a tool run with native tool identities and adapter-owned run and turn identities", () => {
		const { events, terminals, unmapped } = mapPrimeMissionTraceV0({ evidence: fixture("tool-run").events });
		expect(events.map((event) => event.kind)).toEqual([
			"mission.started",
			"turn.started",
			"model.completed",
			"tool.started",
			"tool.finished",
			"turn.finished",
			"turn.started",
			"model.completed",
			"turn.finished",
			"mission.completed",
		]);
		expect(new Set(events.map((event) => event.lane))).toEqual(new Set([PRIME_ROOT_LANE_LABEL]));
		expect(events.find((event) => event.kind === "tool.finished")).toMatchObject({
			runId: "adapter:run-1",
			turnId: "adapter:run-1/turn-1",
			toolCallId: "call_probe_1",
			toolName: "probe_tool",
			isError: false,
		});
		expect(terminals).toEqual([
			{ runId: "adapter:run-1", status: "completed", basis: "native-stop-reason", finalStopReason: "stop" },
		]);
		expect(unmapped).toEqual([]);
	});

	it("keeps the terminal kinds apart and never claims what Prime did not say", () => {
		const terminal = (scenario: string) => {
			const run = fixture(scenario);
			return mapPrimeMissionTraceV0({ evidence: run.events, abortRequestedAfter: run.abortRequestedAfter })
				.terminals;
		};
		expect(terminal("tool-error")[0]).toMatchObject({ status: "completed", basis: "native-stop-reason" });
		expect(terminal("provider-failure")[0]).toMatchObject({ status: "failed", basis: "native-stop-reason" });
		expect(terminal("abort-stream")[0]).toMatchObject({ status: "aborted", basis: "native-stop-reason" });
		expect(terminal("abort-tool")[0]).toMatchObject({
			status: "aborted",
			basis: "adapter-abort-request",
			finalStopReason: "toolUse",
		});
		expect(terminal("length-stop")[0]).toMatchObject({ status: undefined, basis: "ambiguous" });
		// Without the adapter's own abort record, the same Prime events do not establish an abort.
		expect(mapPrimeMissionTraceV0({ evidence: fixture("abort-tool").events }).terminals[0]).toMatchObject({
			status: undefined,
			basis: "ambiguous",
		});
		// An abort that belonged to an earlier run does not leak into the next one.
		expect(terminal("abort-stream")[1]).toMatchObject({ status: "completed", basis: "native-stop-reason" });
	});

	it("assigns unique, correlated, gap-free adapter identities for every fixture", () => {
		for (const run of fixtures) {
			const mapping = mapPrimeMissionTraceV0({ evidence: run.events, abortRequestedAfter: run.abortRequestedAfter });
			expect(checkAdapterIdentitiesV0(mapping), run.provenance.scenario).toEqual([]);
			expect(
				mapping.events.some((event) => event.kind === "mission.resumed" || event.kind === "mission.suspended"),
			).toBe(false);
		}
		const runs = mapPrimeMissionTraceV0({ evidence: fixture("multi-turn-reopen").events }).events.filter(
			(event) => event.kind === "mission.started",
		);
		expect(runs.map((event) => event.runId)).toEqual(["adapter:run-1", "adapter:run-2", "adapter:run-3"]);
	});

	it("flags events it cannot place and tolerates unknown event types", () => {
		const { events, unmapped } = mapPrimeMissionTraceV0({
			evidence: [{ type: "turn_start" }, { type: "unknown", primeType: "brand_new_event" }, { type: "agent_start" }],
		});
		expect(events.map((event) => event.kind)).toEqual(["mission.started"]);
		expect(unmapped).toEqual([
			"turn_start outside a run at 0",
			"unknown Prime event brand_new_event",
			"run adapter:run-1 had no agent_end",
		]);
		expect(checkAdapterIdentitiesV0(mapPrimeMissionTraceV0({ evidence: fixture("compaction").events }))).toEqual([]);
	});
});

describe("projections", () => {
	it("rebuilds cumulative usage that compaction does not reduce", () => {
		const run = fixture("compaction");
		const before = run.stats.find((item) => item.label === "before-compaction")!;
		const rebuilt = rebuildPrimeRuntimeMetricsV0(run.sessionEntries);
		expect(rebuilt.usage.input).toBeGreaterThan(before.tokens.input);
		expect(rebuilt.usage.reasoning).toBeUndefined();
		expect(rebuilt.usage.cacheWrite1h).toBeUndefined();
	});

	it("projects usage rows in file order with adapter sequences and no adjustments", () => {
		const rows = projectPrimeUsageRowsV0(fixture("child-usage-replay").sessionEntries);
		expect(rows.map((row) => [row.id, row.entryId, row.usage.input])).toEqual([
			["a0000002", "a0000002", 1_000],
			["a0000003", "a0000002", 400],
		]);
		expect(
			rows.every(
				(row, index) => row.adjustment === false && (index === 0 || row.sequence > rows[index - 1]!.sequence),
			),
		).toBe(true);
	});
});

describe("conformance report", () => {
	it("carries provenance on every fixture", () => {
		for (const run of fixtures) {
			expect(run.provenance).toMatchObject({
				source: "prime-agent",
				version: "0.9.6",
				commit: "2d24ad4e6b2d1ee8e6919af6f108e980a14d550e",
				mode: "rpc",
				generatedBy: "prime-conformance-v0",
			});
		}
		expect(fixtures.map((run) => run.provenance.scenario).sort()).toEqual(
			readdirSync(fixtureDir)
				.map((name) => name.replace(/\.json$/, ""))
				.sort(),
		);
	});

	it("contains no probe sentinel in any committed fixture", () => {
		for (const name of readdirSync(fixtureDir)) {
			expect(readFileSync(join(fixtureDir, name), "utf8"), name).not.toMatch(SENTINEL_PATTERN);
		}
	});

	it("classifies the four contracts on two axes", () => {
		const report = buildPrimeConformanceReportV0(fixtures);
		expect(report.findings.map((finding) => [finding.contract, finding.support, finding.semanticFit])).toEqual([
			["MissionTraceEventV0", "adapter-state", "qualified"],
			["RuntimeMetricsV0", "adapter-state", "qualified"],
			["OperationOutcomeV0", "unavailable", "incompatible"],
			["UsageLedgerRowV0", "adapter-state", "qualified"],
		]);
		expect(report.privacyViolations).toEqual([]);
		expect(report.drift.stale).toBe(false);
		expect(report.facts).toMatchObject({
			abortToolStop: "toolUse",
			statsDropAfterCompaction: true,
			compactionUsageInStats: false,
			rebuildIncludesCompactionUsage: true,
			childUsageRewritesEarlierRow: true,
			reasoningFieldReported: false,
			plainPromptAfterAbortAdmitted: false,
			undocumentedEventTypes: ["refine_failed"],
			protocolErrors: 0,
		});
		for (const finding of report.findings) {
			expect(finding.evidence.length, finding.contract).toBeGreaterThan(0);
			expect(
				finding.evidence.some((item) => item.includes("unverified")),
				finding.contract,
			).toBe(false);
		}
	});

	it("detects a rebuild mismatch in any shared usage dimension", () => {
		const reopen = fixture("multi-turn-reopen");
		const skewed = {
			...reopen,
			stats: reopen.stats.map((item) =>
				item.label === "after-reopen"
					? { ...item, tokens: { ...item.tokens, cacheRead: item.tokens.cacheRead + 1 } }
					: item,
			),
		};
		expect(derivePrimeFactsV0([reopen]).rebuildMatchesStatsOnSinglePath).toBe(true);
		expect(derivePrimeFactsV0([skewed]).rebuildMatchesStatsOnSinglePath).toBe(false);
	});

	it("decides compaction summary accounting from the kept path, not the pre-compaction total", () => {
		const run = fixture("compaction");
		const after = run.stats.find((item) => item.label === "after-compaction")!;
		const summary = run.sessionEntries.find((entry) => entry.type === "compaction")!.usage!.cost.total;
		expect(derivePrimeFactsV0([run]).compactionUsageInStats).toBe(false);
		// Had stats counted the summary, the kept path plus the summary is what they would show.
		const counted = {
			...run,
			stats: run.stats.map((item) =>
				item.label === "after-compaction" ? { ...item, cost: after.cost + summary } : item,
			),
		};
		expect(derivePrimeFactsV0([counted]).compactionUsageInStats).toBe(true);
		const other = {
			...run,
			stats: run.stats.map((item) => (item.label === "after-compaction" ? { ...item, cost: after.cost + 1 } : item)),
		};
		expect(derivePrimeFactsV0([other]).compactionUsageInStats).toBeUndefined();
	});

	it("prunes fixtures of vanished scenarios only on a full refresh", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-fixtures-"));
		try {
			writeFileSync(join(directory, "renamed-away.json"), "{}");
			writePrimeFixturesV0(directory, [fixture("simple")]);
			expect(readdirSync(directory).sort()).toEqual(["renamed-away.json", "simple.json"]);
			writePrimeFixturesV0(directory, [fixture("simple")], { prune: true });
			expect(readdirSync(directory)).toEqual(["simple.json"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("says unverified instead of guessing when a scenario did not run", () => {
		const facts = derivePrimeFactsV0([fixture("simple")]);
		expect(facts.statsDropAfterCompaction).toBeUndefined();
		const findings = classifyPrimeConformanceV0([fixture("simple")], facts);
		expect(findings.find((finding) => finding.contract === "RuntimeMetricsV0")!.evidence).toContain(
			"probe:compaction: get_session_stats totals decrease after compaction: unverified (scenario not run)",
		);
	});

	it("reports stale evidence when the Prime version or commit drifts", () => {
		const current = fixture("simple").provenance;
		expect(checkPrimeDriftV0(current, current).stale).toBe(false);
		expect(checkPrimeDriftV0({ ...current, version: "0.9.7" }, current)).toMatchObject({
			stale: true,
			evidenceVersion: "0.9.7",
			referenceVersion: "0.9.6",
		});
		expect(checkPrimeDriftV0({ ...current, commit: "0".repeat(40) }, current).stale).toBe(true);
		// A same-version binary without a commit is not a verified match against a commit-pinned reference.
		const { commit: _commit, ...binaryRun } = current;
		expect(checkPrimeDriftV0(binaryRun, current)).toMatchObject({ stale: false, unverified: true });
		expect(checkPrimeDriftV0(current, current).unverified).toBe(false);
		expect(() =>
			buildPrimeConformanceReportV0([
				fixture("simple"),
				{ ...fixture("tool-run"), provenance: { ...fixture("tool-run").provenance, version: "0.9.7" } },
			]),
		).toThrow("mixes Prime versions");
		expect(() =>
			buildPrimeConformanceReportV0([
				fixture("simple"),
				{ ...fixture("tool-run"), provenance: { ...fixture("tool-run").provenance, probeVersion: "9.9.9" } },
			]),
		).toThrow("mixes probe versions");
	});

	it("reports a leaked sentinel instead of hiding it", () => {
		const leaked = { ...fixture("simple"), notes: [`note ${SENTINELS.toolResult}`] };
		expect(buildPrimeConformanceReportV0([leaked]).privacyViolations).toContain("evidence: TOOL_RESULT_SENTINEL");
	});
});

describe("isolation", () => {
	it("fails clearly when no Prime Agent is configured", () => {
		const result = spawnSync(process.execPath, [cli], { env: { PATH: process.env.PATH }, encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no Prime Agent configured");
	});
});
