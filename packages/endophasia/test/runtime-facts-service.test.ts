import {
	type Context,
	createFacetHost,
	createRemoteServiceBinding,
	createServiceCatalogueCall,
	type FacetHost,
	parseServiceCatalogue,
	type RemoteServiceBinding,
} from "@earendil-works/chord";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxThinking,
	fauxToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessType,
	type AgentLane,
	type HarnessEventType,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { OperationResultRecord, Session, SessionStats } from "../../agent/src/harness/session/types.ts";
import type { AgentHarnessTool } from "../../agent/src/harness/types.ts";
import {
	captureContinuityV0,
	captureOperationOutcomeV0,
	captureRuntimeMetricsV0,
	captureSessionOverviewV0,
	captureSteeringStateV0,
	createEndophasiaRuntimeFactsFacetV0,
	EndophasiaRuntimeFactsV0,
	queueFollowUpV0,
	stopV0,
} from "../src/index.ts";
import { exactUsageProvider, usage } from "./exact-usage-provider.ts";
import { connectStrictJson, HOST_REQUEST } from "./strict-json-transport.ts";

const SENTINELS = [
	"prompt-sentinel",
	"assistant-text-sentinel",
	"reasoning-sentinel",
	"tool-args-sentinel",
	"tool-result-sentinel",
	"error-message-sentinel",
	"details-sentinel",
];
const SENTINEL_PATTERN = new RegExp(SENTINELS.join("|"));

const ALL_EVENT_TYPES: HarnessEventType[] = [
	"compaction_end",
	"compaction_start",
	"config_update",
	"entry_added",
	"fault",
	"handler_error",
	"lane_created",
	"message_end",
	"message_start",
	"message_update",
	"navigation_end",
	"navigation_start",
	"operation_abort",
	"queue_update",
	"retry_end",
	"retry_scheduled",
	"retry_start",
	"run_end",
	"run_resume",
	"run_start",
	"run_suspend",
	"tool_end",
	"tool_start",
	"tool_update",
	"turn_end",
	"turn_start",
	"usage",
	"value_update",
];

const A = usage(11, 7, 13, 5, 41, [0.5, 0.25, 0.125, 0.0625, 0.9375]);
const B = usage(17, 3, 2, 19, 43, [1.5, 0.75, 0.375, 0.1875, 2.8125], { reasoning: 2, cacheWrite1h: 4 });
const C = usage(29, 23, 31, 37, 120, [2, 4, 8, 16, 30]);

const sessions: Session[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

async function fixture(options: { retries?: number } = {}): Promise<{
	harness: AgentHarnessType;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
	reported: Usage[];
}> {
	const session = new StorageBackedSession(
		{ id: `runtime-facts-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const reported: Usage[] = [];
	const models = createModels();
	models.setProvider(exactUsageProvider(faux, reported));
	const schema = Type.Object({ value: Type.String() });
	const echo: AgentHarnessTool<undefined, typeof schema> = {
		name: "echo",
		label: "echo",
		description: "echo",
		parameters: schema,
		execute: async () => ({ content: [{ type: "text", text: "tool-result-sentinel" }], details: {} }),
	};
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			tools: [echo],
			activeToolNames: ["echo"],
			retry: { enabled: options.retries !== undefined, maxRetries: options.retries ?? 0, baseDelayMs: 0 },
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { harness, lane, faux, reported };
}

async function connect(lane: Pick<AgentLane, "watch" | "getResult">): Promise<{
	facts: EndophasiaRuntimeFactsV0;
	host: FacetHost;
	binding: RemoteServiceBinding;
	connection: ReturnType<typeof connectStrictJson>;
}> {
	const host = await createFacetHost({ facets: [createEndophasiaRuntimeFactsFacetV0(lane)] });
	const connection = connectStrictJson(host.services);
	const errors: Error[] = [];
	const binding = createRemoteServiceBinding({
		services: [EndophasiaRuntimeFactsV0],
		transport: connection.transport,
		onError: (error) => errors.push(error),
	});
	cleanups.push(async () => {
		await binding.dispose(BACKGROUND_CONTEXT);
		connection.dispose();
		await host.dispose();
		expect(errors).toEqual([]);
	});
	const facts = binding.use(EndophasiaRuntimeFactsV0);
	await binding.ready(BACKGROUND_CONTEXT);
	return { facts, host, binding, connection };
}

async function rawStats(lane: AgentLane): Promise<SessionStats> {
	const watch = await lane.watch(BACKGROUND_CONTEXT);
	try {
		return structuredClone(watch.snapshot.stats);
	} finally {
		watch.unsubscribe();
	}
}

async function raw(lane: AgentLane, operationId: string): Promise<OperationResultRecord> {
	const record = await lane.getResult(operationId, BACKGROUND_CONTEXT);
	if (record === undefined) throw new Error("Expected a durable result");
	return record;
}

describe("Endophasia Runtime Facts v0 service", () => {
	it("is published in the host's generated catalogue as one remote singleton", async () => {
		const { lane } = await fixture();
		const { host, connection } = await connect(lane);
		const expected = [{ serviceId: "endophasia.runtime-facts.v0", mode: "singleton" }];
		expect(host.services.catalogue).toEqual(expected);
		expect(
			parseServiceCatalogue(await connection.transport.invoke(createServiceCatalogueCall(), BACKGROUND_CONTEXT)),
		).toEqual(expected);
	});

	describe("runtimeMetrics()", () => {
		it("reports the zero baseline of a fresh session, exactly as the direct projection", async () => {
			const { lane } = await fixture();
			const { facts } = await connect(lane);
			const remote = await facts.runtimeMetrics(BACKGROUND_CONTEXT);
			expect(remote).toEqual(await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT));
			expect(remote).toEqual({
				schemaVersion: "runtime-metrics.v0",
				scope: "session",
				messageCount: 0,
				usage: usage(0, 0, 0, 0, 0, [0, 0, 0, 0, 0]),
			});
		});

		it("reports exact accounted totals of a real tool-using run, without any payload", async () => {
			const { lane, faux, reported } = await fixture();
			const { facts } = await connect(lane);
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxThinking("reasoning-sentinel"),
						{ type: "text", text: "assistant-text-sentinel" },
						fauxToolCall("echo", { value: "tool-args-sentinel" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("assistant-text-sentinel"),
			]);
			reported.push(A, B);
			expect(await lane.prompt("prompt-sentinel", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				value: { status: "completed" },
			});
			const remote = await facts.runtimeMetrics(BACKGROUND_CONTEXT);
			expect(remote).toEqual(await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT));
			expect(remote).toEqual({ schemaVersion: "runtime-metrics.v0", scope: "session", ...(await rawStats(lane)) });
			expect(remote.usage.totalTokens).toBe(A.totalTokens + B.totalTokens);
			expect(remote.usage.reasoning).toBe(2);
			expect(remote.usage.cacheWrite1h).toBe(4);
			expect(Object.keys(remote).sort()).toEqual(["messageCount", "schemaVersion", "scope", "usage"]);
			expect(remote).not.toHaveProperty("lane");
			expect(JSON.stringify(remote)).not.toMatch(SENTINEL_PATTERN);
		});

		it("keeps usage already accounted for a failed attempt that was retried", async () => {
			const { lane, faux, reported } = await fixture({ retries: 1 });
			const { facts } = await connect(lane);
			faux.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded error-message-sentinel" }),
				fauxAssistantMessage("assistant-text-sentinel"),
			]);
			reported.push(A, C);
			expect(await lane.prompt("prompt-sentinel", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				value: { status: "completed" },
			});
			expect(faux.state.callCount).toBe(2);
			const remote = await facts.runtimeMetrics(BACKGROUND_CONTEXT);
			expect(remote).toEqual(await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT));
			expect(remote.usage.totalTokens).toBe(A.totalTokens + C.totalTokens);
			expect(remote.usage.cost.total).toBe(A.cost.total + C.cost.total);
			expect(JSON.stringify(remote)).not.toMatch(SENTINEL_PATTERN);
		});

		it("passes a negative adjustment through unchanged: totals are not monotonic", async () => {
			const { lane } = await fixture();
			const { facts } = await connect(lane);
			await lane.recordUsage(C, { details: { note: "details-sentinel" } }, BACKGROUND_CONTEXT);
			const before = await facts.runtimeMetrics(BACKGROUND_CONTEXT);
			const correction = usage(-9, -3, -1, -7, -200, [-1, -2, -4, -8, -45]);
			expect(await lane.recordUsage(correction, undefined, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
			const after = await facts.runtimeMetrics(BACKGROUND_CONTEXT);
			expect(after).toEqual(await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT));
			expect(after.usage.totalTokens).toBe(-80);
			expect(after.usage.cost.total).toBe(-15);
			expect(after.usage.totalTokens).toBeLessThan(before.usage.totalTokens);
			expect(JSON.stringify(after)).not.toMatch(SENTINEL_PATTERN);
		});
	});

	describe("operationOutcome()", () => {
		it("returns null for an unknown ID and for an admitted, non-terminal operation", async () => {
			const { lane } = await fixture();
			const { facts } = await connect(lane);
			expect(await facts.operationOutcome("never-admitted", BACKGROUND_CONTEXT)).toBeNull();
			const admitted = await lane.accept(
				{ kind: "prompt", operationId: "open-run", prompt: "p" },
				BACKGROUND_CONTEXT,
			);
			if (!admitted.ok) throw admitted.error;
			expect(await facts.operationOutcome("open-run", BACKGROUND_CONTEXT)).toBeNull();
		});

		it("returns a completed run's immutable outcome exactly as the direct projection, without payloads", async () => {
			const { lane, faux, reported } = await fixture();
			const { facts } = await connect(lane);
			faux.setResponses([
				fauxAssistantMessage([
					fauxThinking("reasoning-sentinel"),
					{ type: "text", text: "assistant-text-sentinel" },
				]),
			]);
			reported.push(A);
			const result = await lane.prompt("prompt-sentinel", undefined, BACKGROUND_CONTEXT);
			if (!result.ok) throw result.error;
			const operationId = result.value.operationId;
			const record = await raw(lane, operationId);
			const remote = await facts.operationOutcome(operationId, BACKGROUND_CONTEXT);
			expect(remote).toEqual(await captureOperationOutcomeV0(lane, operationId, BACKGROUND_CONTEXT));
			expect(remote).toEqual({
				schemaVersion: "operation-outcome.v0",
				operationId,
				kind: "run",
				status: "completed",
				fromTipId: record.fromTipId,
				tipId: record.tipId,
				startedAt: record.startedAt,
				endedAt: record.endedAt,
			});
			// Read through the main lane, which is only the access route: no lane is claimed.
			expect(remote).not.toHaveProperty("lane");
			expect(JSON.stringify(remote)).not.toMatch(SENTINEL_PATTERN);
		});

		it("reports no outcome for an accepted STOP, and aborted only after terminal settlement", async () => {
			const { lane } = await fixture();
			const { facts } = await connect(lane);
			const admitted = await lane.accept(
				{ kind: "prompt", operationId: "stop-run", prompt: "prompt-sentinel" },
				BACKGROUND_CONTEXT,
			);
			if (!admitted.ok) throw admitted.error;
			expect(await stopV0(lane, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				receipt: { kind: "stop.requested", operationId: "stop-run" },
			});
			expect((await lane.inspectExecution(BACKGROUND_CONTEXT)).current?.status).toBe("aborting");
			expect(await facts.operationOutcome("stop-run", BACKGROUND_CONTEXT)).toBeNull();
			await lane.drive({ operationId: "stop-run" }, BACKGROUND_CONTEXT);
			const settled = await facts.operationOutcome("stop-run", BACKGROUND_CONTEXT);
			expect(settled).toEqual(await captureOperationOutcomeV0(lane, "stop-run", BACKGROUND_CONTEXT));
			expect(settled).toMatchObject({ operationId: "stop-run", kind: "run", status: "aborted" });
			expect(JSON.stringify(settled)).not.toMatch(SENTINEL_PATTERN);
		});

		it("carries only the error code of a failed run across the boundary, never its message or details", async () => {
			const { lane } = await fixture();
			const { facts } = await connect(lane);
			await lane.setModel({ provider: "details-sentinel", modelId: "error-message-sentinel" }, BACKGROUND_CONTEXT);
			const result = await lane.prompt("prompt-sentinel", undefined, BACKGROUND_CONTEXT);
			if (!result.ok || result.value.status !== "failed") throw new Error("Expected a failed run");
			const record = await raw(lane, result.value.operationId);
			// Pi's own record does carry private detail; the outcome must not.
			expect(JSON.stringify(record.error)).toMatch(SENTINEL_PATTERN);
			const remote = await facts.operationOutcome(result.value.operationId, BACKGROUND_CONTEXT);
			expect(remote).toEqual(await captureOperationOutcomeV0(lane, result.value.operationId, BACKGROUND_CONTEXT));
			expect(remote).toMatchObject({ kind: "run", status: "failed", errorCode: record.error?.code });
			expect(Object.keys(remote ?? {}).sort()).toEqual(
				[
					"endedAt",
					"errorCode",
					"fromTipId",
					"kind",
					"operationId",
					"schemaVersion",
					"startedAt",
					"status",
					"tipId",
				].sort(),
			);
			expect(JSON.stringify(remote)).not.toMatch(SENTINEL_PATTERN);
			expect(JSON.stringify(remote)).not.toMatch(/message|details|stack/);
		});

		it("keeps the structural kinds of compaction and navigation", async () => {
			const { lane, faux, reported } = await fixture();
			const { facts } = await connect(lane);
			faux.setResponses([
				fauxAssistantMessage("one"),
				fauxAssistantMessage("two"),
				fauxAssistantMessage("summary-sentinel"),
			]);
			reported.push(A, B, C);
			const first = await lane.prompt("one", undefined, BACKGROUND_CONTEXT);
			if (!first.ok || first.value.status !== "completed") throw new Error("Expected a completed run");
			await lane.prompt("two", undefined, BACKGROUND_CONTEXT);
			const compaction = await lane.compact(undefined, BACKGROUND_CONTEXT);
			if (!compaction.ok) throw compaction.error;
			const navigation = await lane.navigateTree(first.value.tipId, { summarize: false }, BACKGROUND_CONTEXT);
			if (!navigation.ok) throw navigation.error;
			const compacted = await facts.operationOutcome(compaction.value.compaction.operationId, BACKGROUND_CONTEXT);
			const navigated = await facts.operationOutcome(navigation.value.navigation.operationId, BACKGROUND_CONTEXT);
			expect(compacted).toMatchObject({ kind: "compaction", status: "completed" });
			expect(navigated).toMatchObject({ kind: "navigation", status: "completed" });
			expect(navigated).toEqual(
				await captureOperationOutcomeV0(lane, navigation.value.navigation.operationId, BACKGROUND_CONTEXT),
			);
			expect(JSON.stringify([compacted, navigated])).not.toContain("summary-sentinel");
		});

		it("rejects a non-string operation ID instead of passing it to the runtime", async () => {
			const getResult = vi.fn(async () => undefined);
			const { facts } = await connect({ getResult, watch: vi.fn() });
			const untyped = facts.operationOutcome as (operationId: unknown, context: Context) => Promise<unknown>;
			await expect(untyped(42, BACKGROUND_CONTEXT)).rejects.toThrow("Operation ID must be a string");
			expect(getResult).not.toHaveBeenCalled();
		});
	});

	it("captures fresh per call, with no cache, each host call using its own Context", async () => {
		const stats: SessionStats = { messageCount: 1, usage: A };
		let record: OperationResultRecord | undefined;
		const seen: Context[] = [];
		const lane = {
			watch: vi.fn(async (context: Context) => {
				seen.push(context);
				return {
					snapshot: { stats: structuredClone(stats) } as Awaited<ReturnType<AgentLane["watch"]>>["snapshot"],
					start: () => {},
					resnapshot: async () => {
						throw new Error("unused");
					},
					unsubscribe: () => {},
				};
			}),
			getResult: vi.fn(async (_operationId: string, context: Context) => {
				seen.push(context);
				return record;
			}),
		};
		// Any other lane capability (prompting, steering, setters, transcript reads) would throw here.
		const narrowed = new Proxy(lane, {
			get(target, property, receiver) {
				if (property !== "watch" && property !== "getResult") {
					throw new Error(`Unexpected lane access: ${String(property)}`);
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const { facts, connection } = await connect(narrowed);
		expect(lane.watch).not.toHaveBeenCalled();
		expect(lane.getResult).not.toHaveBeenCalled();

		expect((await facts.runtimeMetrics(BACKGROUND_CONTEXT)).usage).toEqual(A);
		stats.usage = B;
		expect((await facts.runtimeMetrics(BACKGROUND_CONTEXT)).usage).toEqual(B);
		expect(await facts.operationOutcome("op", BACKGROUND_CONTEXT)).toBeNull();
		record = {
			operationId: "op",
			kind: "run",
			status: "completed",
			fromTipId: null,
			tipId: "t",
			startedAt: 1,
			endedAt: 2,
		};
		expect(await facts.operationOutcome("op", BACKGROUND_CONTEXT)).toMatchObject({ status: "completed" });
		expect(lane.watch).toHaveBeenCalledTimes(2);
		expect(lane.getResult).toHaveBeenCalledTimes(2);
		expect(new Set(seen).size).toBe(4);
		for (const context of seen) expect(connection.hostContexts).toContain(context);
		expect(new Set(seen.map((context) => context.value(HOST_REQUEST))).size).toBe(4);
	});

	it("propagates a failed read instead of fabricating zero metrics or a null outcome", async () => {
		const { harness, lane } = await fixture();
		const { facts } = await connect(lane);
		await facts.runtimeMetrics(BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);
		await expect(facts.runtimeMetrics(BACKGROUND_CONTEXT)).rejects.toThrow();
		await expect(facts.operationOutcome("any", BACKGROUND_CONTEXT)).rejects.toThrow();
	});

	it("is read-only: no events, entries, tips, operations, queues, configuration, or lanes change", async () => {
		const { harness, lane, faux, reported } = await fixture();
		const { facts } = await connect(lane);
		faux.setResponses([fauxAssistantMessage("ok")]);
		reported.push(A);
		const run = await lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		if (!run.ok) throw run.error;
		const admitted = await lane.accept({ kind: "prompt", operationId: "open", prompt: "q" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		await queueFollowUpV0(lane, "queued", BACKGROUND_CONTEXT);
		const anyEvent = vi.fn();
		const unsubscribe = ALL_EVENT_TYPES.map((type) => harness.events.on(type, anyEvent));
		const observe = async () => ({
			continuity: await captureContinuityV0(lane, BACKGROUND_CONTEXT),
			overview: await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT),
			steering: await captureSteeringStateV0(lane, BACKGROUND_CONTEXT),
			entries: await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
			stats: await rawStats(lane),
			model: await lane.getModel(BACKGROUND_CONTEXT),
			tools: await lane.getActiveTools(BACKGROUND_CONTEXT),
		});
		const before = await observe();
		await facts.runtimeMetrics(BACKGROUND_CONTEXT);
		await facts.operationOutcome(run.value.operationId, BACKGROUND_CONTEXT);
		await facts.operationOutcome("open", BACKGROUND_CONTEXT);
		await facts.operationOutcome("unknown", BACKGROUND_CONTEXT);
		expect(await observe()).toEqual(before);
		expect(before.overview.lanes.map(({ name }) => name)).toEqual(["main"]);
		expect(anyEvent).not.toHaveBeenCalled();
		for (const remove of unsubscribe) remove();
	});

	it("stops serving when the host is disposed", async () => {
		const { lane } = await fixture();
		const { facts, host } = await connect(lane);
		await facts.runtimeMetrics(BACKGROUND_CONTEXT);
		await host.dispose();
		await expect(facts.runtimeMetrics(BACKGROUND_CONTEXT)).rejects.toThrow();
		await expect(facts.operationOutcome("x", BACKGROUND_CONTEXT)).rejects.toThrow();
	});
});
