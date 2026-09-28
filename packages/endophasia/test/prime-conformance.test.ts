// Offline tests for the research-only Prime Runtime Conformance v0 classification side: Mission Trace mapping,
// projections, exact fact predicates, scenario invariants, drift, the publication gate and the command's
// privacy-before-persistence ordering. They run on the committed sanitized fixtures; no Prime installation is needed.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkAdapterIdentitiesV0,
	classifyPrimeConformanceV0,
	derivePrimeFactsV0,
} from "../research/prime-conformance/classification.ts";
import {
	type PrimeConformanceCommandDepsV0,
	parsePrimeConformanceArgsV0,
	runPrimeConformanceCommandV0,
} from "../research/prime-conformance/command.ts";
import {
	PROBE_VERSION,
	type PrimeProvenanceV0,
	type PrimeScenarioEvidenceV0,
	type PrimeStatsEvidenceV0,
} from "../research/prime-conformance/evidence.ts";
import { SENTINEL_PATTERN, SENTINELS } from "../research/prime-conformance/fake-provider.ts";
import { scenarioInvariantProblemsV0 } from "../research/prime-conformance/invariants.ts";
import { mapPrimeMissionTraceV0, PRIME_ROOT_LANE_LABEL } from "../research/prime-conformance/mission-trace.ts";
import { SCENARIOS } from "../research/prime-conformance/probe.ts";
import { projectPrimeUsageRowsV0, rebuildPrimeRuntimeMetricsV0 } from "../research/prime-conformance/projection.ts";
import { assessPrimeEvidenceV0, isPublishableV0 } from "../research/prime-conformance/publication.ts";
import {
	buildPrimeConformanceReportV0,
	checkPrimeDriftV0,
	readPrimeFixturesV0,
	writePrimeFixturesV0,
} from "../research/prime-conformance/report.ts";

const fixtureRoot = fileURLToPath(new URL("./fixtures/prime", import.meta.url));
const fixtureDir = join(fixtureRoot, "0.9.6");
const cli = fileURLToPath(new URL("../research/prime-conformance/cli.ts", import.meta.url));
const fixtures = readPrimeFixturesV0(fixtureDir);
const scenarioNames = SCENARIOS.map((scenario) => scenario.name);

function fixture(scenario: string): PrimeScenarioEvidenceV0 {
	const found = fixtures.find((item) => item.provenance.scenario === scenario);
	if (found === undefined) throw new Error(`missing fixture ${scenario}`);
	return structuredClone(found);
}

/** The full fixture set with one scenario replaced. */
function withScenario(replacement: PrimeScenarioEvidenceV0): PrimeScenarioEvidenceV0[] {
	return fixtures.map((item) =>
		item.provenance.scenario === replacement.provenance.scenario ? replacement : structuredClone(item),
	);
}

function withProvenance(evidence: readonly PrimeScenarioEvidenceV0[], change: Partial<PrimeProvenanceV0>) {
	return evidence.map((item) => ({ ...structuredClone(item), provenance: { ...item.provenance, ...change } }));
}

function withStats(
	run: PrimeScenarioEvidenceV0,
	label: string,
	change: (stats: PrimeStatsEvidenceV0) => PrimeStatsEvidenceV0,
): PrimeScenarioEvidenceV0 {
	return { ...run, stats: run.stats.map((item) => (item.label === label ? change(item) : item)) };
}

function assess(evidence: readonly PrimeScenarioEvidenceV0[], requested: readonly string[] = scenarioNames) {
	return assessPrimeEvidenceV0({ report: buildPrimeConformanceReportV0(evidence), requestedScenarios: requested });
}

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
		// After turn_end the turn is closed: a late tool event is unmapped, never attached to the finished turn.
		const late = mapPrimeMissionTraceV0({
			evidence: [
				{ type: "agent_start" },
				{ type: "turn_start" },
				fixture("simple").events.find((e) => e.type === "turn_end")!,
				{ type: "tool_execution_end", toolCallId: "call_1", toolName: "probe_tool", isError: false },
			],
		});
		expect(late.unmapped).toContain("tool_execution_end outside a turn at 3");
		expect(late.events.some((event) => event.kind === "tool.finished")).toBe(false);
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

describe("committed reference fixtures", () => {
	it("are one homogeneous, verified, current-probe evidence set", () => {
		expect(fixtures.map((run) => run.provenance.scenario).sort()).toEqual([...scenarioNames].sort());
		for (const run of fixtures) {
			expect(run.provenance).toMatchObject({
				source: "prime-agent",
				version: "0.9.6",
				commit: "2d24ad4e6b2d1ee8e6919af6f108e980a14d550e",
				build: "clean-checkout",
				mode: "rpc",
				generatedBy: "prime-conformance-v0",
				probeVersion: PROBE_VERSION,
			});
		}
	});

	it("contain no probe sentinel", () => {
		for (const name of readdirSync(fixtureDir)) {
			expect(readFileSync(join(fixtureDir, name), "utf8"), name).not.toMatch(SENTINEL_PATTERN);
		}
	});

	it("satisfy every scenario invariant and pass the publication gate", () => {
		for (const run of fixtures) {
			expect(run.failures, run.provenance.scenario).toEqual([]);
			expect(scenarioInvariantProblemsV0(run), run.provenance.scenario).toEqual([]);
		}
		const assessment = assess(fixtures);
		expect(assessment).toEqual({ invalid: [], unpublishable: [] });
		expect(isPublishableV0(assessment)).toBe(true);
	});
});

describe("classification", () => {
	it("classifies the four contracts on two axes, from fully verified facts", () => {
		const report = buildPrimeConformanceReportV0(fixtures);
		expect(report.findings.map((finding) => [finding.contract, finding.support, finding.semanticFit])).toEqual([
			["MissionTraceEventV0", "adapter-state", "qualified"],
			["RuntimeMetricsV0", "adapter-state", "qualified"],
			["OperationOutcomeV0", "unavailable", "incompatible"],
			["UsageLedgerRowV0", "adapter-state", "qualified"],
		]);
		expect(report.findings.every((finding) => finding.basis === "established")).toBe(true);
		expect(report.findings.flatMap((finding) => [...finding.missing, ...finding.contradictions])).toEqual([]);
		expect(report.facts).toMatchObject({
			providerUsageDecodedExactly: true,
			toolCallIdentityNative: true,
			abortToolStop: "toolUse",
			statsDropAfterCompaction: true,
			compactionUsageDurable: true,
			compactionUsageInStats: false,
			rebuildIncludesCompactionUsage: true,
			rebuildMatchesStatsOnSinglePath: true,
			reopenStatsEqual: true,
			childUsageFoldedIntoStats: true,
			childFoldTotals: { statsTokensTotal: 1470, aggregateTotalTokens: 1050 },
			childUsageRewritesEarlierRow: true,
			reasoningFieldReported: false,
			plainPromptAfterAbortAdmitted: false,
			plainPromptAfterCompactionAdmitted: false,
			protocolErrors: 0,
		});
		for (const finding of report.findings) {
			expect(
				finding.evidence.some((item) => item.includes("unverified")),
				finding.contract,
			).toBe(false);
		}
	});

	it("does not claim a classification whose facts were not all observed", () => {
		const findings = classifyPrimeConformanceV0([fixture("simple")]);
		for (const finding of findings) {
			expect(finding, finding.contract).toMatchObject({
				support: "undetermined",
				semanticFit: "undetermined",
				basis: "unverified",
			});
			expect(finding.missing.length, finding.contract).toBeGreaterThan(0);
		}
		expect(findings[0]!.baseline).toEqual({ support: "adapter-state", semanticFit: "qualified" });
	});

	it("withdraws a classification that valid evidence contradicts", () => {
		const run = fixture("tool-run");
		const renamed = {
			...run,
			events: run.events.map((event) =>
				event.type === "tool_execution_end" ? { ...event, toolName: "other_tool" } : event,
			),
		};
		const trace = buildPrimeConformanceReportV0(withScenario(renamed)).findings[0]!;
		expect(trace).toMatchObject({
			support: "undetermined",
			basis: "contradicted",
			contradictions: ["toolCallIdentityNative = true"],
		});

		// A consistent usage misparse: session entries and stats agree with each other, but not with the provider.
		const simple = fixture("simple");
		const zeroed = {
			...simple,
			events: simple.events.map((event) =>
				event.type === "message_end" && event.assistant !== undefined
					? { ...event, assistant: { ...event.assistant, usage: { ...event.assistant.usage, output: 0 } } }
					: event,
			),
		};
		const report = buildPrimeConformanceReportV0(withScenario(zeroed));
		expect(report.facts.providerUsageDecodedExactly).toBe(false);
		expect(
			report.findings.filter((finding) => finding.basis === "contradicted").map((finding) => finding.contract),
		).toEqual(["RuntimeMetricsV0", "UsageLedgerRowV0"]);
	});

	it("says unverified instead of guessing when a scenario did not run", () => {
		const facts = derivePrimeFactsV0([fixture("simple")]);
		expect(facts.statsDropAfterCompaction).toBeUndefined();
		const findings = classifyPrimeConformanceV0([fixture("simple")], facts);
		expect(findings.find((finding) => finding.contract === "RuntimeMetricsV0")!.evidence).toContain(
			"probe:compaction: get_session_stats totals decrease after compaction: unverified (scenario not run)",
		);
	});

	it("checks every tool execution phase, not only the end", () => {
		const run = fixture("tool-run");
		const wrongStart = {
			...run,
			events: run.events.map((event) =>
				event.type === "tool_execution_start" ? { ...event, toolName: "other_tool" } : event,
			),
		};
		expect(derivePrimeFactsV0([wrongStart]).toolCallIdentityNative).toBe(false);
	});

	it("matches tool identity on the (id, name) pair", () => {
		const run = fixture("tool-run");
		const renamed = {
			...run,
			events: run.events.map((event) =>
				event.type === "tool_execution_end" ? { ...event, toolName: "other_tool" } : event,
			),
		};
		expect(derivePrimeFactsV0([renamed]).toolCallIdentityNative).toBe(false);
	});

	it("compares every stable stats field across reopen", () => {
		const changes: ((stats: PrimeStatsEvidenceV0) => PrimeStatsEvidenceV0)[] = [
			(s) => ({ ...s, userMessages: s.userMessages + 1 }),
			(s) => ({ ...s, assistantMessages: s.assistantMessages + 1 }),
			(s) => ({ ...s, toolCalls: s.toolCalls + 1 }),
			(s) => ({ ...s, toolResults: s.toolResults + 1 }),
			(s) => ({ ...s, totalMessages: s.totalMessages - 1 }),
			(s) => ({ ...s, tokens: { ...s.tokens, cacheWrite: s.tokens.cacheWrite + 1 } }),
			(s) => ({ ...s, cost: s.cost + 0.5 }),
		];
		for (const change of changes) {
			expect(
				derivePrimeFactsV0([withStats(fixture("multi-turn-reopen"), "after-reopen", change)]).reopenStatsEqual,
			).toBe(false);
		}
		// The context-window estimate is deliberately excluded: it is recomputed per process.
		const volatile = withStats(fixture("multi-turn-reopen"), "after-reopen", (s) => ({
			...s,
			contextUsageTokens: null,
		}));
		expect(derivePrimeFactsV0([volatile]).reopenStatsEqual).toBe(true);
	});

	it("requires every shared dimension before claiming child usage was folded", () => {
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const skewed = withStats(fixture("child-usage-replay"), "after-open", (s) => ({
				...s,
				tokens: { ...s.tokens, [key]: s.tokens[key] + 1 },
			}));
			expect(derivePrimeFactsV0([skewed]).childUsageFoldedIntoStats, key).toBe(false);
		}
		const costly = withStats(fixture("child-usage-replay"), "after-open", (s) => ({ ...s, cost: s.cost + 1 }));
		expect(derivePrimeFactsV0([costly]).childUsageFoldedIntoStats).toBe(false);
	});

	it("detects a single-path rebuild mismatch in any shared usage dimension", () => {
		const skewed = withStats(fixture("multi-turn-reopen"), "after-reopen", (s) => ({
			...s,
			tokens: { ...s.tokens, cacheRead: s.tokens.cacheRead + 1 },
		}));
		expect(derivePrimeFactsV0([skewed]).rebuildMatchesStatsOnSinglePath).toBe(false);
	});

	it("proves compaction retention from the snapshots, uncontaminated by the later prompt", () => {
		const run = fixture("compaction");
		// The final file (after the later prompt) plays no part.
		expect(derivePrimeFactsV0([{ ...run, sessionEntries: [] }]).rebuildIncludesCompactionUsage).toBe(true);
		const lossy = {
			...run,
			entrySnapshots: run.entrySnapshots.map((snapshot) =>
				snapshot.label === "after-compaction"
					? {
							...snapshot,
							entries: snapshot.entries.filter(
								(_entry, index) => index !== snapshot.entries.findIndex((item) => item.role === "assistant"),
							),
						}
					: snapshot,
			),
		};
		expect(derivePrimeFactsV0([lossy]).rebuildIncludesCompactionUsage).toBe(false);
		expect(derivePrimeFactsV0([{ ...run, entrySnapshots: [] }]).rebuildIncludesCompactionUsage).toBeUndefined();
	});

	it("decides compaction summary accounting from the kept path in the post-compaction snapshot", () => {
		const run = fixture("compaction");
		const after = run.stats.find((item) => item.label === "after-compaction")!;
		const summary = run.entrySnapshots
			.find((snapshot) => snapshot.label === "after-compaction")!
			.entries.find((entry) => entry.type === "compaction")!.usage!.cost.total;
		expect(derivePrimeFactsV0([run]).compactionUsageInStats).toBe(false);
		const counted = withStats(run, "after-compaction", (s) => ({ ...s, cost: after.cost + summary }));
		expect(derivePrimeFactsV0([counted]).compactionUsageInStats).toBe(true);
		const other = withStats(run, "after-compaction", (s) => ({ ...s, cost: after.cost + 1 }));
		expect(derivePrimeFactsV0([other]).compactionUsageInStats).toBeUndefined();
	});
});

type Mutation = readonly [string, string, (run: PrimeScenarioEvidenceV0) => PrimeScenarioEvidenceV0];

const INVARIANT_MUTATIONS: readonly Mutation[] = [
	["fork", "no new session file", (r) => ({ ...r, observations: { ...r.observations, forkCreatedNewFile: false } })],
	["fork", "no fork target", (r) => ({ ...r, observations: { ...r.observations, forkTargets: 0 } })],
	["fork", "fork never succeeded", (r) => ({ ...r, commands: r.commands.filter((c) => c.command !== "fork") })],
	[
		"multi-turn-reopen",
		"another session reopened",
		(r) => ({ ...r, observations: { ...r.observations, reopenedIntendedSession: false } }),
	],
	[
		"multi-turn-reopen",
		"messages never counted",
		(r) => ({ ...r, observations: { ...r.observations, messagesAfterReopen: undefined } }),
	],
	["compaction", "no snapshots", (r) => ({ ...r, entrySnapshots: [] })],
	[
		"compaction",
		"no compaction entry",
		(r) => ({
			...r,
			entrySnapshots: r.entrySnapshots.map((s) => ({
				...s,
				entries: s.entries.filter((e) => e.type !== "compaction"),
			})),
		}),
	],
	[
		"compaction",
		"pre-compaction rows changed",
		(r) => ({
			...r,
			entrySnapshots: r.entrySnapshots.map((s) =>
				s.label === "after-compaction" ? { ...s, entries: s.entries.slice(1) } : s,
			),
		}),
	],
	[
		"abort-stream",
		"refusal of another category",
		(r) => ({
			...r,
			commands: r.commands.map((c) => (c.success ? c : { ...c, errorKind: "other" as const })),
		}),
	],
	["abort-stream", "abort never requested", (r) => ({ ...r, abortRequestedAfter: [] })],
	[
		"compaction",
		"an extra row besides the compaction entry",
		(r) => ({
			...r,
			entrySnapshots: r.entrySnapshots.map((s) =>
				s.label === "after-compaction"
					? { ...s, entries: [...s.entries, { type: "session_state", id: "extra001", parentId: null, keys: [] }] }
					: s,
			),
		}),
	],
	[
		"simple",
		"an assistant from another model",
		(r) => ({
			...r,
			events: r.events.map((e) =>
				e.type === "message_end" && e.assistant !== undefined
					? { ...e, assistant: { ...e.assistant, model: "other" } }
					: e,
			),
		}),
	],
	[
		"fork",
		"a fork whose success is not a boolean",
		(r) => ({
			...r,
			commands: r.commands.map((c) =>
				c.command === "fork" ? ({ ...c, success: "true" } as unknown as typeof c) : c,
			),
		}),
	],
	["abort-tool", "abort not at a tool start", (r) => ({ ...r, abortRequestedAfter: [0] })],
	[
		"tool-run",
		"no tool execution",
		(r) => ({ ...r, events: r.events.filter((e) => e.type !== "tool_execution_end") }),
	],
	[
		"child-usage-replay",
		"no child attribution read",
		(r) => ({ ...r, sessionEntries: r.sessionEntries.filter((e) => e.type !== "child_usage_attributed") }),
	],
	[
		"simple",
		"an unexpected refusal",
		(r) => ({
			...r,
			commands: [...r.commands, { command: "get_messages", success: false, dataKeys: [], errorKind: "other" }],
		}),
	],
	["simple", "provider request count missing", (r) => ({ ...r, observations: {} })],
	["simple", "a run that never ended", (r) => ({ ...r, events: r.events.filter((e) => e.type !== "agent_end") })],
];

describe("scenario invariants", () => {
	it.each(INVARIANT_MUTATIONS)("%s: %s makes the scenario invalid and unpublishable", (scenario, _case, change) => {
		const mutated = change(fixture(scenario));
		expect(scenarioInvariantProblemsV0(mutated)).not.toEqual([]);
		const assessment = assess(withScenario(mutated));
		expect(assessment.invalid.some((item) => item.startsWith(`${scenario}: failure:`))).toBe(true);
		expect(isPublishableV0(assessment)).toBe(false);
	});

	it("rejects a scenario without defined invariants", () => {
		const run = fixture("simple");
		expect(scenarioInvariantProblemsV0({ ...run, provenance: { ...run.provenance, scenario: "invented" } })).toEqual([
			"no invariants are defined for scenario invented",
		]);
	});
});

describe("publication gate", () => {
	const cases: readonly (readonly [string, () => PrimeScenarioEvidenceV0[], "invalid" | "unpublishable"])[] = [
		[
			"a recorded scenario failure",
			() => withScenario({ ...fixture("simple"), failures: ["prompt simple did not end"] }),
			"invalid",
		],
		[
			"a protocol error",
			() => withScenario({ ...fixture("simple"), protocolErrors: ["Duplicate response for probe-1"] }),
			"invalid",
		],
		[
			"a missing assistant usage object",
			() => {
				const run = fixture("simple");
				const events = run.events.map((event) =>
					event.type === "message_end" && event.assistant !== undefined
						? ({ ...event, assistant: { ...event.assistant, usage: undefined } } as unknown as typeof event)
						: event,
				);
				return withScenario({ ...run, events });
			},
			"invalid",
		],
		[
			"a non-boolean isError",
			() => {
				const run = fixture("tool-run");
				const events = run.events.map((event) =>
					event.type === "tool_execution_end" ? ({ ...event, isError: null } as unknown as typeof event) : event,
				);
				return withScenario({ ...run, events });
			},
			"invalid",
		],
		["a probe sentinel", () => withScenario({ ...fixture("simple"), stateKeys: [SENTINELS.prompt] }), "invalid"],
		[
			"a repeated entry id",
			() => {
				const run = fixture("simple");
				return withScenario({ ...run, sessionEntries: [...run.sessionEntries, run.sessionEntries.at(-1)!] });
			},
			"invalid",
		],
		[
			"an empty parent id",
			() => {
				const run = fixture("simple");
				return withScenario({
					...run,
					sessionEntries: run.sessionEntries.map((e, i) => (i === 2 ? { ...e, parentId: "" } : e)),
				});
			},
			"invalid",
		],
		["a missing requested scenario", () => fixtures.filter((run) => run.provenance.scenario !== "fork"), "invalid"],
		["binary provenance", () => withProvenance(fixtures, { build: "binary", commit: undefined }), "unpublishable"],
		["a dirty checkout", () => withProvenance(fixtures, { build: "dirty-checkout" }), "unpublishable"],
		[
			"an unverified checkout",
			() => withProvenance(fixtures, { build: "unverified-checkout", commit: undefined }),
			"unpublishable",
		],
		["an older probe version", () => withProvenance(fixtures, { probeVersion: "0.2.0" }), "unpublishable"],
	];

	it.each(cases)("refuses %s", (_case, evidence, kind) => {
		const assessment = assess(evidence());
		expect(assessment[kind]).not.toEqual([]);
		expect(isPublishableV0(assessment)).toBe(false);
	});

	it("refuses a partial refresh that would mix provenance with the fixtures it keeps", () => {
		const refreshed = [fixture("simple")];
		const kept = withProvenance(
			fixtures.filter((run) => run.provenance.scenario !== "simple"),
			{ node: "v99.0.0" },
		);
		const assessment = assessPrimeEvidenceV0({
			report: buildPrimeConformanceReportV0(refreshed),
			requestedScenarios: ["simple"],
			retainedFixtures: kept,
		});
		expect(assessment.unpublishable.length).toBe(kept.length);
		const consistent = assessPrimeEvidenceV0({
			report: buildPrimeConformanceReportV0(refreshed),
			requestedScenarios: ["simple"],
			retainedFixtures: fixtures.filter((run) => run.provenance.scenario !== "simple"),
		});
		expect(isPublishableV0(consistent)).toBe(true);
	});

	it("never mixes builds, probes or environments in one report", () => {
		const [first, ...rest] = fixtures;
		const mixed = (change: Partial<PrimeProvenanceV0>) => [first!, ...withProvenance(rest, change)];
		expect(() => buildPrimeConformanceReportV0(mixed({ version: "0.9.7" }))).toThrow("mixes Prime builds");
		expect(() => buildPrimeConformanceReportV0(mixed({ commit: "0".repeat(40) }))).toThrow("mixes Prime builds");
		expect(() => buildPrimeConformanceReportV0(mixed({ build: "dirty-checkout" }))).toThrow("mixes Prime builds");
		expect(() => buildPrimeConformanceReportV0(mixed({ probeVersion: "9.9.9" }))).toThrow("mixes probe versions");
		expect(() => buildPrimeConformanceReportV0(mixed({ platform: "darwin-arm64" }))).toThrow("mixes environments");
		expect(() => buildPrimeConformanceReportV0(mixed({ node: "v99.0.0" }))).toThrow("mixes environments");
		expect(() => buildPrimeConformanceReportV0([first!, structuredClone(first!)])).toThrow("repeats scenario");
	});
});

describe("drift", () => {
	const reference = fixtures[0]!.provenance;
	it.each([
		[
			"the same verified build",
			{},
			{ runtime: "same", probe: "same", environment: "same", provenanceVerified: true },
		],
		["another Prime version", { version: "0.9.7" }, { runtime: "different" }],
		["another commit", { commit: "0".repeat(40) }, { runtime: "different" }],
		[
			"a commit-less binary",
			{ build: "binary", commit: undefined },
			{ runtime: "unverifiable", provenanceVerified: false },
		],
		[
			"a dirty checkout at the same commit",
			{ build: "dirty-checkout" },
			{ runtime: "unverifiable", provenanceVerified: false },
		],
		["another probe version", { probeVersion: "9.9.9" }, { runtime: "same", probe: "different" }],
		["another Node version", { node: "v99.0.0" }, { environment: "different" }],
	] as const)("reports %s", (_case, change, expected) => {
		expect(checkPrimeDriftV0({ ...reference, ...change } as PrimeProvenanceV0, reference)).toMatchObject(expected);
	});

	it("has no reference when there are no comparable fixtures", () => {
		expect(checkPrimeDriftV0(reference, undefined)).toMatchObject({ runtime: "no-reference", probe: "no-reference" });
	});
});

describe("fixture writing", () => {
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
});

describe("command ordering", () => {
	const temps: string[] = [];
	afterEach(() => {
		for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	function harness(evidence: PrimeScenarioEvidenceV0[], build: Partial<PrimeProvenanceV0> = {}) {
		const root = mkdtempSync(join(tmpdir(), "prime-command-"));
		temps.push(root);
		const fixtures = join(root, "fixtures");
		cpSync(fixtureRoot, fixtures, { recursive: true });
		const artifactDir = join(root, "artifacts");
		const stderr: string[] = [];
		const probe = vi.fn(async () => evidence);
		const { scenario: _scenario, ...provenance } = evidence[0]!.provenance;
		const deps: PrimeConformanceCommandDepsV0 = {
			env: {},
			fixtureRoot: fixtures,
			artifactDir,
			scenarios: scenarioNames,
			stdout: () => {},
			stderr: (text) => stderr.push(text),
			resolveBinary: () => ({ command: "prime-agent", leadingArgs: [], description: "prime-agent" }),
			describe: () => ({ ...provenance, ...build }),
			probe,
		};
		const referenceDir = join(fixtures, "0.9.6");
		const fixtureState = () =>
			Object.fromEntries(
				readdirSync(referenceDir).map((name) => [name, readFileSync(join(referenceDir, name), "utf8")]),
			);
		return { deps, probe, stderr, reportPath: join(artifactDir, "report.json"), fixtureState, artifactDir };
	}

	it("writes the report for a valid run, and fixtures only when asked and publishable", async () => {
		const run = harness(fixtures.map((item) => structuredClone(item)));
		const before = run.fixtureState();
		expect(await runPrimeConformanceCommandV0([], run.deps)).toBe(0);
		expect(existsSync(run.reportPath)).toBe(true);
		expect(run.fixtureState()).toEqual(before);
		expect(await runPrimeConformanceCommandV0(["--write-fixtures"], run.deps)).toBe(0);
	});

	it("persists nothing when a probe sentinel reaches the evidence, and names no sentinel", async () => {
		const leaked = withScenario({ ...fixture("simple"), stateKeys: [SENTINELS.toolResult] });
		const fresh = harness(leaked);
		const before = fresh.fixtureState();
		expect(await runPrimeConformanceCommandV0(["--write-fixtures"], fresh.deps)).toBe(1);
		expect(existsSync(fresh.reportPath)).toBe(false);
		expect(fresh.fixtureState()).toEqual(before);
		expect(fresh.stderr.join("")).toContain("evidence:simple (1)");
		expect(fresh.stderr.join("")).not.toMatch(SENTINEL_PATTERN);

		// A report from an earlier run is left untouched, not overwritten with contaminated content.
		const earlier = harness(leaked);
		cpSync(fixtureDir, earlier.artifactDir, { recursive: true });
		writeFileSync(earlier.reportPath, "earlier report\n");
		expect(await runPrimeConformanceCommandV0([], earlier.deps)).toBe(1);
		expect(readFileSync(earlier.reportPath, "utf8")).toBe("earlier report\n");
	});

	it("allows inspection but refuses fixture writes from unverified provenance", async () => {
		const binary = harness(withProvenance(fixtures, { build: "binary", commit: undefined }));
		const before = binary.fixtureState();
		expect(await runPrimeConformanceCommandV0([], binary.deps)).toBe(0);
		expect(await runPrimeConformanceCommandV0(["--write-fixtures"], binary.deps)).toBe(1);
		expect(existsSync(binary.reportPath)).toBe(true);
		expect(binary.fixtureState()).toEqual(before);
		expect(binary.stderr.join("")).toContain("provenance is binary");
	});

	it("fails the check when valid evidence contradicts a classification", async () => {
		const run = fixture("tool-run");
		const renamed = {
			...run,
			events: run.events.map((event) =>
				event.type === "tool_execution_start" ? { ...event, toolName: "other_tool" } : event,
			),
		};
		const contradicted = harness(withScenario(renamed));
		expect(await runPrimeConformanceCommandV0([], contradicted.deps)).toBe(1);
		expect(existsSync(contradicted.reportPath)).toBe(true);
		expect(contradicted.stderr.join("")).toContain("MissionTraceEventV0: toolCallIdentityNative = true");
	});

	it("refuses fixture writes from an invalid run", async () => {
		const invalid = harness(
			withScenario({ ...fixture("fork"), failures: ["get_fork_messages.data.messages is empty"] }),
		);
		const before = invalid.fixtureState();
		expect(await runPrimeConformanceCommandV0(["--write-fixtures"], invalid.deps)).toBe(1);
		expect(invalid.fixtureState()).toEqual(before);
	});

	it.each([
		[["--scenario", "--write-fixtures"]],
		[["--write-fixtures", "--scenario"]],
		[["--scenario"]],
		[["--bogus"]],
	])("fails %j before probing or touching fixtures", async (argv) => {
		const run = harness(fixtures.map((item) => structuredClone(item)));
		const before = run.fixtureState();
		expect(await runPrimeConformanceCommandV0(argv, run.deps)).toBe(1);
		expect(run.probe).not.toHaveBeenCalled();
		expect(existsSync(run.reportPath)).toBe(false);
		expect(run.fixtureState()).toEqual(before);
	});

	it("parses flags strictly", () => {
		expect(parsePrimeConformanceArgsV0(["--scenario", "fork", "--retain"], scenarioNames)).toEqual({
			ok: true,
			args: { only: ["fork"], writeFixtures: false, retain: true },
		});
		expect(parsePrimeConformanceArgsV0(["--scenario", "no-such"], scenarioNames)).toEqual({
			ok: false,
			error: "unknown scenario no-such",
		});
		expect(parsePrimeConformanceArgsV0(["--scenario", "fork", "--scenario", "fork"], scenarioNames).ok).toBe(false);
		expect(parsePrimeConformanceArgsV0(["--scenario=fork"], scenarioNames).ok).toBe(false);
		expect(parsePrimeConformanceArgsV0(["--retain=yes"], scenarioNames).ok).toBe(false);
	});

	it("fails clearly from the real entry point when no Prime Agent is configured", () => {
		const result = spawnSync(process.execPath, [cli], { env: { PATH: process.env.PATH }, encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no Prime Agent configured");
		const malformed = spawnSync(process.execPath, [cli, "--scenario"], {
			env: { PATH: process.env.PATH },
			encoding: "utf8",
		});
		expect(malformed.status).toBe(1);
		expect(malformed.stderr).toContain("--scenario needs a scenario name");
	});
});
