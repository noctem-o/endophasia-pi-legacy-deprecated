import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Context,
	createFacetHost,
	createRemoteServiceBinding,
	type Facet,
	type FacetHost,
	isJsonValue,
} from "@earendil-works/chord";
import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness, type AgentHarness as AgentHarnessType } from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { OperationResultRecord, Session, TerminalStatus } from "../../agent/src/harness/session/types.ts";
import {
	captureOperationOutcomeV0,
	captureRuntimeMetricsV0,
	createEndophasiaMissionTraceFacetV0,
	createEndophasiaRuntimeFactsFacetV0,
	createEndophasiaUsageFacetV0,
	EndophasiaMissionTraceV0,
	EndophasiaRuntimeFactsV0,
	EndophasiaUsageV0,
	MISSION_TRACE_REPLICATED_EVENT_LIMIT,
	type MissionTraceEventV0,
	type OperationOutcomeV0,
	observeMissionTraceV0,
	type RuntimeMetricsSourceV0,
	type RuntimeMetricsV0,
	type RuntimeMissionTraceSourceV0,
	type RuntimeObservationSourcesV0,
	type RuntimeOperationOutcomeSourceV0,
	type RuntimeUsageSourceV0,
	readUsageLedgerV0,
	USAGE_REPLICATED_ROW_LIMIT,
	type UsageFeedListenerV0,
	type UsageFeedSourceV0,
	type UsageLedgerRowV0,
} from "../src/index.ts";
import {
	createPiMissionTraceSourceV0,
	createPiOperationOutcomeSourceV0,
	createPiRuntimeMetricsSourceV0,
	createPiRuntimeObservationSourcesV0,
	createPiUsageSourceV0,
} from "../src/pi-runtime-observation.ts";
import { exactUsageProvider, usage } from "./exact-usage-provider.ts";
import { connectStrictJson } from "./strict-json-transport.ts";

const SENTINEL_PATTERN =
	/prompt-sentinel|assistant-text-sentinel|reasoning-sentinel|tool-args-sentinel|tool-result-sentinel|details-sentinel|error-message-sentinel/;

const sessions: Session[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

async function piFixture(): Promise<{
	harness: AgentHarnessType;
	session: Session;
	faux: ReturnType<typeof fauxProvider>;
	reported: ReturnType<typeof usage>[];
}> {
	const session = new StorageBackedSession(
		{ id: `runtime-observation-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const reported: ReturnType<typeof usage>[] = [];
	const models = createModels();
	models.setProvider(exactUsageProvider(faux, reported));
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			tools: [
				{
					name: "echo",
					label: "echo",
					description: "echo",
					parameters: Type.Object({ value: Type.String() }),
					execute: async () => ({
						content: [{ type: "text" as const, text: "tool-result-sentinel" }],
						details: {},
					}),
				},
			],
			activeToolNames: ["echo"],
		},
		BACKGROUND_CONTEXT,
	);
	return { harness, session, faux, reported };
}

/** Host the facets and bind their services through the strict JSON transport, as a remote consumer would. */
async function host(facets: readonly Facet[], services: Parameters<typeof createRemoteServiceBinding>[0]["services"]) {
	const facetHost: FacetHost = await createFacetHost({ facets: [...facets] });
	const connection = connectStrictJson(facetHost.services);
	const errors: Error[] = [];
	const binding = createRemoteServiceBinding({
		services,
		transport: connection.transport,
		onError: (error) => errors.push(error),
	});
	cleanups.push(async () => {
		await binding.dispose(BACKGROUND_CONTEXT);
		connection.dispose();
		await facetHost.dispose();
		expect(errors).toEqual([]);
	});
	await binding.ready(BACKGROUND_CONTEXT);
	return { facetHost, binding };
}

describe("Pi runtime observation adapter parity", () => {
	it("delivers exactly the direct Pi Mission Trace projection, in order, without payloads", async () => {
		const { harness, faux, reported } = await piFixture();
		reported.push(usage(1, 1, 0, 0, 2, [1, 1, 0, 0, 2]), usage(2, 1, 0, 0, 3, [1, 1, 0, 0, 2]));
		const direct: MissionTraceEventV0[] = [];
		const viaSource: MissionTraceEventV0[] = [];
		const stopDirect = observeMissionTraceV0(harness, (event) => direct.push(event));
		const stopSource = createPiMissionTraceSourceV0(harness).observe((event) => viaSource.push(event));
		const { binding } = await host(
			[createEndophasiaMissionTraceFacetV0(createPiMissionTraceSourceV0(harness))],
			[EndophasiaMissionTraceV0],
		);
		const trace = binding.use(EndophasiaMissionTraceV0);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("reasoning-sentinel"),
					{ type: "text", text: "assistant-text-sentinel" },
					fauxToolCall("echo", { value: "tool-args-sentinel" }, { id: "pi-call-1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("assistant-text-sentinel"),
		]);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		expect(await lane.prompt("prompt-sentinel", undefined, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
		stopDirect();
		stopSource();
		expect(direct.length).toBeGreaterThan(0);
		// Byte-equal, not only structurally equal: same fields in the same order.
		expect(JSON.stringify(viaSource)).toBe(JSON.stringify(direct));
		await expect.poll(() => trace.state.value?.events.length).toBe(direct.length);
		expect(JSON.stringify(trace.state.value?.events)).toBe(JSON.stringify(direct));
		expect(direct.map(({ kind }) => kind)).toContain("tool.finished");
		expect(JSON.stringify(trace.state.value)).not.toMatch(SENTINEL_PATTERN);
	});

	it("reads exactly the direct Runtime Metrics and Operation Outcome projections", async () => {
		const { harness, faux, reported } = await piFixture();
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const metrics = createPiRuntimeMetricsSourceV0(lane);
		const outcomes = createPiOperationOutcomeSourceV0(lane);
		faux.setResponses([
			fauxAssistantMessage([fauxThinking("reasoning-sentinel"), { type: "text", text: "assistant-text-sentinel" }]),
		]);
		reported.push(usage(17, 3, 2, 19, 43, [1.5, 0.75, 0.375, 0.1875, 2.8125], { reasoning: 2, cacheWrite1h: 4 }));
		const result = await lane.prompt("prompt-sentinel", undefined, BACKGROUND_CONTEXT);
		if (!result.ok) throw result.error;
		await lane.recordUsage(usage(-9, -3, -1, -7, -200, [-1, -2, -4, -8, -45]), undefined, BACKGROUND_CONTEXT);

		const direct = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(JSON.stringify(await metrics.read(BACKGROUND_CONTEXT))).toBe(JSON.stringify(direct));
		expect(direct.usage).toMatchObject({ reasoning: 2, cacheWrite1h: 4 });
		const known = await captureOperationOutcomeV0(lane, result.value.operationId, BACKGROUND_CONTEXT);
		expect(known).not.toBeNull();
		expect(JSON.stringify(await outcomes.read(result.value.operationId, BACKGROUND_CONTEXT))).toBe(
			JSON.stringify(known),
		);
		expect(await outcomes.read("never-admitted", BACKGROUND_CONTEXT)).toBeNull();

		const { binding } = await host(
			[createEndophasiaRuntimeFactsFacetV0({ runtimeMetrics: metrics, operationOutcome: outcomes })],
			[EndophasiaRuntimeFactsV0],
		);
		const facts = binding.use(EndophasiaRuntimeFactsV0);
		expect(await facts.runtimeMetrics(BACKGROUND_CONTEXT)).toEqual(direct);
		expect(await facts.operationOutcome(result.value.operationId, BACKGROUND_CONTEXT)).toEqual(known);
		expect(await facts.operationOutcome("never-admitted", BACKGROUND_CONTEXT)).toBeNull();
	});

	it("pages, seeds and tails exactly as the Pi ledger, gaps included", async () => {
		const { harness, session } = await piFixture();
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		for (let index = 0; index < 5; index++) {
			await lane.recordUsage(
				usage(index + 1, 1, 0, 0, index + 2, [1, 1, 0, 0, 2]),
				{ details: { note: "details-sentinel" } },
				BACKGROUND_CONTEXT,
			);
		}
		const source = createPiUsageSourceV0({ events: harness.events, session });
		const all = (await readUsageLedgerV0(session, { limit: 10_000 }, BACKGROUND_CONTEXT)).rows;
		expect(all).toHaveLength(5);
		expect(JSON.stringify(await source.page({ afterSequence: all[1]!.sequence, limit: 2 }, BACKGROUND_CONTEXT))).toBe(
			JSON.stringify(
				await readUsageLedgerV0(session, { afterSequence: all[1]!.sequence, limit: 2 }, BACKGROUND_CONTEXT),
			),
		);
		expect(await source.tail(3, BACKGROUND_CONTEXT)).toEqual({ rows: all.slice(-3), hasEarlierRows: true });
		expect(await source.tail(5, BACKGROUND_CONTEXT)).toEqual({ rows: all, hasEarlierRows: false });
		await expect(source.tail(0, BACKGROUND_CONTEXT)).rejects.toThrow(RangeError);

		const delivered: UsageLedgerRowV0[] = [];
		const feed = await source.attach(all[2]!.sequence, (row) => void delivered.push(row), BACKGROUND_CONTEXT);
		expect(delivered).toEqual(all.slice(3));
		await lane.recordUsage(usage(9, 9, 0, 0, 18, [1, 1, 0, 0, 2]), undefined, BACKGROUND_CONTEXT);
		await expect.poll(() => delivered.length).toBe(3);
		const live = (await readUsageLedgerV0(session, { afterSequence: all[4]!.sequence }, BACKGROUND_CONTEXT)).rows;
		expect(delivered).toEqual([...all.slice(3), ...live]);
		expect(feed.afterSequence).toBe(live[0]!.sequence);
		feed.unsubscribe();
		expect(JSON.stringify(delivered)).not.toMatch(SENTINEL_PATTERN);
	});

	it("supplies all four capabilities for the Pi Session worker", async () => {
		const { harness, session } = await piFixture();
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const pi = createPiRuntimeObservationSourcesV0({ harness, lane, usageReader: session });
		expect(Object.keys(pi).sort()).toEqual(["missionTrace", "operationOutcome", "runtimeMetrics", "usage"]);
		for (const capability of Object.values(pi)) expect(capability).toBeTypeOf("object");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Fake runtimes: no Pi object anywhere. The facets must work from the runtime-neutral capabilities alone.

function fakeMissionTrace() {
	let deliver: ((event: MissionTraceEventV0) => void) | undefined;
	let stopped = 0;
	const source: RuntimeMissionTraceSourceV0 = {
		observe(listener) {
			deliver = listener;
			return () => {
				stopped += 1;
				deliver = undefined;
			};
		},
	};
	return {
		source,
		emit: (event: MissionTraceEventV0) => deliver?.(event),
		stopped: () => stopped,
		observing: () => deliver !== undefined,
	};
}

const LEAK = { prompt: "prompt-sentinel", reasoning: "reasoning-sentinel", args: "tool-args-sentinel" };

function fakeRow(sequence: number): UsageLedgerRowV0 {
	return {
		id: `fake-${sequence}`,
		sequence,
		adjustment: sequence % 2 === 0,
		entryId: `entry-${sequence}`,
		usage: {
			input: sequence,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: sequence + 1,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		},
	};
}

function fakeUsage(initial: UsageLedgerRowV0[]) {
	const rows = [...initial];
	let listener: UsageFeedListenerV0 | undefined;
	const attaches: number[] = [];
	const source: RuntimeUsageSourceV0 = {
		async tail(limit) {
			return { rows: rows.slice(-limit).map((row) => ({ ...row, ...LEAK })), hasEarlierRows: rows.length > limit };
		},
		async page(query) {
			const after = query?.afterSequence ?? 0;
			const selected = rows.filter((row) => row.sequence > after).slice(0, query?.limit ?? 1000);
			return {
				schemaVersion: "usage-ledger.v0",
				scope: "session",
				order: "ascending",
				rows: selected.map((row) => ({ ...row, details: { note: "details-sentinel" } })),
				nextAfterSequence: selected.at(-1)?.sequence ?? after,
			};
		},
		async attach(afterSequence, deliver) {
			attaches.push(afterSequence);
			listener = deliver;
			let cursor = afterSequence;
			for (const row of rows.filter((row) => row.sequence > afterSequence)) {
				await deliver(row);
				cursor = row.sequence;
			}
			return {
				get afterSequence() {
					return cursor;
				},
				get active() {
					return listener !== undefined;
				},
				unsubscribe: () => {
					listener = undefined;
				},
			};
		},
	};
	return {
		source,
		attaches,
		attached: () => listener !== undefined,
		async commit(row: UsageLedgerRowV0) {
			rows.push(row);
			await listener?.({ ...row, ...LEAK });
		},
	};
}

describe("runtime-neutral host facets over a fake runtime", () => {
	it("hosts Mission Trace from a fake source: bounded window, original sequences, no payload, stopped on disposal", async () => {
		const fake = fakeMissionTrace();
		const { facetHost, binding } = await host(
			[createEndophasiaMissionTraceFacetV0(fake.source)],
			[EndophasiaMissionTraceV0],
		);
		const trace = binding.use(EndophasiaMissionTraceV0);
		expect(fake.observing()).toBe(true);
		const total = MISSION_TRACE_REPLICATED_EVENT_LIMIT + 5;
		for (let sequence = 1; sequence <= total; sequence++) {
			fake.emit({
				kind: sequence % 2 === 0 ? "tool.finished" : "mission.started",
				lane: "fake-lane",
				runId: "fake-run",
				turnId: "fake-turn",
				toolCallId: "fake-call",
				toolName: "fake-tool",
				isError: false,
				schemaVersion: "mission-trace.v0",
				sequence,
				...LEAK,
			} as MissionTraceEventV0);
		}
		await expect.poll(() => trace.state.value?.events.at(-1)?.sequence).toBe(total);
		const events = trace.state.value!.events;
		expect(events).toHaveLength(MISSION_TRACE_REPLICATED_EVENT_LIMIT);
		expect(events[0]!.sequence).toBe(6);
		// Only the schema fields of each kind cross the boundary: a run event carries no turn or tool fields either.
		expect(Object.keys(events.find((event) => event.kind === "mission.started")!)).toEqual([
			"kind",
			"lane",
			"runId",
			"schemaVersion",
			"sequence",
		]);
		expect(JSON.stringify(trace.state.value)).not.toMatch(SENTINEL_PATTERN);
		expect(isJsonValue(trace.state.value)).toBe(true);
		await facetHost.dispose();
		expect(fake.stopped()).toBe(1);
	});

	it("serves Runtime Facts from two independent fake capabilities, with payload-minimal outcomes", async () => {
		const reads: Context[] = [];
		const runtimeMetrics: RuntimeMetricsSourceV0 = {
			async read(context) {
				reads.push(context);
				return {
					schemaVersion: "runtime-metrics.v0",
					scope: "session",
					messageCount: 2,
					usage: {
						input: 1,
						output: 2,
						cacheRead: 3,
						cacheWrite: 4,
						totalTokens: 10,
						cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
					},
					...LEAK,
				} as RuntimeMetricsV0;
			},
		};
		const operationOutcome: RuntimeOperationOutcomeSourceV0 = {
			async read(operationId) {
				if (operationId !== "known") return null;
				return {
					schemaVersion: "operation-outcome.v0",
					operationId,
					kind: "run",
					status: "failed",
					fromTipId: null,
					tipId: "tip",
					startedAt: 1,
					endedAt: 2,
					errorCode: "provider_error",
					error: { message: "error-message-sentinel", details: "details-sentinel" },
				} as OperationOutcomeV0;
			},
		};
		const { binding } = await host(
			[createEndophasiaRuntimeFactsFacetV0({ runtimeMetrics, operationOutcome })],
			[EndophasiaRuntimeFactsV0],
		);
		const facts = binding.use(EndophasiaRuntimeFactsV0);
		const metrics = await facts.runtimeMetrics(BACKGROUND_CONTEXT);
		expect(Object.keys(metrics)).toEqual(["schemaVersion", "scope", "messageCount", "usage"]);
		expect(metrics.usage).not.toHaveProperty("reasoning");
		expect(reads).toHaveLength(1);
		const outcome = await facts.operationOutcome("known", BACKGROUND_CONTEXT);
		expect(outcome).toEqual({
			schemaVersion: "operation-outcome.v0",
			operationId: "known",
			kind: "run",
			status: "failed",
			fromTipId: null,
			tipId: "tip",
			startedAt: 1,
			endedAt: 2,
			errorCode: "provider_error",
		});
		expect(await facts.operationOutcome("unknown", BACKGROUND_CONTEXT)).toBeNull();
		expect(JSON.stringify([metrics, outcome])).not.toMatch(SENTINEL_PATTERN);
	});

	it("hosts Usage from a fake source: seeded tail, gap-safe attach from the last seeded row, payload-minimal pages", async () => {
		const initial = [
			1,
			4,
			9,
			...Array.from({ length: USAGE_REPLICATED_ROW_LIMIT }, (_, index) => 20 + index * 3),
		].map(fakeRow);
		const fake = fakeUsage(initial);
		const { facetHost, binding } = await host([createEndophasiaUsageFacetV0(fake.source)], [EndophasiaUsageV0]);
		const usageService = binding.use(EndophasiaUsageV0);
		await expect.poll(() => usageService.state.value?.rows.length).toBe(USAGE_REPLICATED_ROW_LIMIT);
		const seeded = usageService.state.value!;
		expect(seeded.hasEarlierRows).toBe(true);
		expect(seeded.rows).toHaveLength(USAGE_REPLICATED_ROW_LIMIT);
		expect(seeded.rows[0]!.sequence).toBe(20);
		// The feed attaches after the last seeded row, never from zero and never skipping ahead.
		expect(fake.attaches).toEqual([seeded.rows.at(-1)!.sequence]);
		const next = seeded.rows.at(-1)!.sequence + 7;
		await fake.commit(fakeRow(next));
		await expect.poll(() => usageService.state.value?.rows.at(-1)?.sequence).toBe(next);
		expect(usageService.state.value!.rows).toHaveLength(USAGE_REPLICATED_ROW_LIMIT);
		expect(usageService.state.value!.rows.at(-1)).toEqual(fakeRow(next));
		const page = await usageService.page({ afterSequence: 1, limit: 2 }, BACKGROUND_CONTEXT);
		expect(page.rows).toEqual([fakeRow(4), fakeRow(9)]);
		expect(page.nextAfterSequence).toBe(9);
		expect(JSON.stringify([usageService.state.value, page])).not.toMatch(SENTINEL_PATTERN);
		await facetHost.dispose();
		expect(fake.attached()).toBe(false);
	});

	it("never synthesizes an absent capability: a facet without its source is not constructible", () => {
		const metricsOnly: RuntimeObservationSourcesV0 = {
			runtimeMetrics: { read: async () => Promise.reject(new Error("unused")) },
		};
		expect(metricsOnly.operationOutcome).toBeUndefined();
		expect(() =>
			createEndophasiaRuntimeFactsFacetV0({
				runtimeMetrics: metricsOnly.runtimeMetrics!,
				operationOutcome: metricsOnly.operationOutcome as unknown as RuntimeOperationOutcomeSourceV0,
			}),
		).toThrow("An Operation Outcome source is required");
		expect(() => createEndophasiaMissionTraceFacetV0(undefined as unknown as RuntimeMissionTraceSourceV0)).toThrow(
			TypeError,
		);
		expect(() => createEndophasiaUsageFacetV0(undefined as unknown as RuntimeUsageSourceV0)).toThrow(TypeError);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Compile-time guards: `tsc` fails if the neutral boundary starts accepting Pi objects or couples capabilities.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(_value: T): void {}

describe("compile-time boundary guards", () => {
	it("keeps the neutral capabilities free of Pi types and independent of each other", async () => {
		const { harness, session } = await piFixture();
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const piUsage: UsageFeedSourceV0 = { events: harness.events, session };
		// Never invoked: these only have to fail to compile.
		const rejected = [
			// @ts-expect-error The Mission Trace facet takes a runtime-neutral source, never Pi's AgentHarness.
			() => createEndophasiaMissionTraceFacetV0(harness),
			// @ts-expect-error The Runtime Facts facet takes two capabilities, never a Pi AgentLane.
			() => createEndophasiaRuntimeFactsFacetV0(lane),
			// @ts-expect-error The Usage facet takes the neutral Usage source, never Pi's events + Session.scanUsage pair.
			() => createEndophasiaUsageFacetV0(piUsage),
			// @ts-expect-error Runtime Metrics does not imply Operation Outcome: metrics alone cannot serve Runtime Facts.
			() => createEndophasiaRuntimeFactsFacetV0({ runtimeMetrics: createPiRuntimeMetricsSourceV0(lane) }),
		];
		expect(rejected).toHaveLength(4);
		// Every capability of the aggregate is optional; none is required by another.
		assertType<Equal<RuntimeObservationSourcesV0, Partial<RuntimeObservationSourcesV0>>>(true);
		assertType<Equal<keyof RuntimeMetricsSourceV0, "read">>(true);
		// The neutral Usage source speaks UsageLedgerRowV0, never Pi's UsageRow (seq, details).
		type AttachedRow = Parameters<Parameters<RuntimeUsageSourceV0["attach"]>[1]>[0];
		assertType<Equal<AttachedRow, UsageLedgerRowV0>>(true);
		assertType<Equal<Awaited<ReturnType<RuntimeUsageSourceV0["tail"]>>["rows"][number], UsageLedgerRowV0>>(true);
		// The Pi-free OperationOutcomeV0 unions are exactly Pi's today: a change on either side fails to compile.
		assertType<Equal<OperationOutcomeV0["kind"], OperationResultRecord["kind"]>>(true);
		assertType<Equal<OperationOutcomeV0["status"], TerminalStatus>>(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Import graph: the neutral contracts and host facets reach no Pi package and no runtime-specific module, including
// through type imports; the composition root reaches Pi's projections only through the Pi adapter.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g;

async function importGraph(entry: string): Promise<{ files: Set<string>; packages: Set<string> }> {
	const files = new Set<string>();
	const packages = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop()!;
		if (files.has(file)) continue;
		files.add(file);
		for (const match of (await readFile(file, "utf8")).matchAll(SPECIFIER)) {
			const specifier = match[1]!;
			if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
			else packages.add(specifier);
		}
	}
	return { files, packages };
}

const NEUTRAL_MODULES = [
	"runtime-observation.ts",
	"mission-trace-service.ts",
	"runtime-facts-service.ts",
	"usage-facet.ts",
	"usage-service.ts",
];
const RUNTIME_SPECIFIC_MODULES = [
	"pi-runtime-observation.ts",
	"mission-trace.ts",
	"runtime-metrics.ts",
	"durable-outcomes.ts",
	"usage-feed.ts",
	"usage-ledger.ts",
];

describe("runtime observation import graph", () => {
	it.each(NEUTRAL_MODULES)("%s reaches no Pi package and no runtime-specific module, even by type", async (module) => {
		const { files, packages } = await importGraph(resolve(SRC, module));
		const reached = [...files].map((file) => file.slice(SRC.length + 1));
		for (const specific of RUNTIME_SPECIFIC_MODULES) expect(reached, module).not.toContain(specific);
		expect(
			reached.filter((file) => file.includes("research/")),
			module,
		).toEqual([]);
		expect(
			[...packages].filter((name) => /^@earendil-works\/pi-(agent-core|coding-agent)(\/|$)/.test(name)),
			module,
		).toEqual([]);
		expect(
			[...packages].every((name) => name.startsWith("@earendil-works/chord")),
			module,
		).toBe(true);
	});

	it("keeps the Pi knowledge in the Pi adapter and the Session worker composition root", async () => {
		const adapter = await importGraph(resolve(SRC, "pi-runtime-observation.ts"));
		expect(adapter.packages).toContain("@earendil-works/pi-agent-core");
		const worker = await readFile(resolve(SRC, "../runtime/session-worker.ts"), "utf8");
		const workerImports = [...worker.matchAll(SPECIFIER)].map((match) => match[1]!);
		expect(workerImports).toContain("../src/pi-runtime-observation.ts");
		// The worker never bypasses the adapter to reach a Pi projection directly.
		for (const specific of RUNTIME_SPECIFIC_MODULES.filter((module) => module !== "pi-runtime-observation.ts")) {
			expect(workerImports).not.toContain(`../src/${specific}`);
		}
		// Production code never depends on the Prime research probe.
		for (const module of [...NEUTRAL_MODULES, ...RUNTIME_SPECIFIC_MODULES]) {
			const { files } = await importGraph(resolve(SRC, module));
			expect(
				[...files].filter((file) => file.includes("/research/")),
				module,
			).toEqual([]);
		}
	});

	it("keeps the service IDs and schema versions of the three observation services", async () => {
		const catalogue = await createFacetHost({
			facets: [
				createEndophasiaMissionTraceFacetV0(fakeMissionTrace().source),
				createEndophasiaRuntimeFactsFacetV0({
					runtimeMetrics: { read: () => Promise.reject(new Error("unused")) },
					operationOutcome: { read: () => Promise.reject(new Error("unused")) },
				}),
				createEndophasiaUsageFacetV0(fakeUsage([]).source),
			],
		});
		cleanups.push(() => catalogue.dispose());
		expect(catalogue.services.catalogue.map(({ serviceId }) => serviceId).sort()).toEqual([
			"endophasia.mission-trace.v0",
			"endophasia.runtime-facts.v0",
			"endophasia.usage.v0",
		]);
		const contracts = await Promise.all(
			["mission-trace-service.ts", "runtime-facts-service.ts", "usage-service.ts"].map((module) =>
				readFile(resolve(SRC, module), "utf8"),
			),
		);
		for (const version of [
			'"mission-trace.v0"',
			'"mission-trace-observation.v0"',
			'"runtime-metrics.v0"',
			'"operation-outcome.v0"',
			'"usage-ledger.v0"',
			'"usage-observation.v0"',
		]) {
			expect(contracts.join("\n")).toContain(version);
		}
	});
});
