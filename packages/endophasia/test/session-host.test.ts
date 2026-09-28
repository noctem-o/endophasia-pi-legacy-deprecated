import {
	type Context,
	createServiceCatalogueCall,
	createStaticFacetLoader,
	defineFacet,
	type FacetEnvironment,
	isJsonValue,
	parseServiceCatalogue,
} from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessType,
	type Events,
	type HarnessEventType,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session } from "../../agent/src/harness/session/types.ts";
import { deferred } from "../../agent/test/harness/runtime/test-utils.ts";
import { SessionPlugins } from "../../coding-agent/src/experimental/services/plugins.ts";
import {
	createSessionWorkerServices,
	type SessionWorkerServices,
} from "../../coding-agent/src/experimental/services/worker.ts";
import {
	captureOperationOutcomeV0,
	captureRuntimeMetricsV0,
	captureSessionOverviewV0,
	createEndophasiaInspectorFacetV0,
	createEndophasiaMissionTraceFacetV0,
	createEndophasiaRuntimeFactsFacetV0,
	createEndophasiaUsageFacetV0,
	EndophasiaInspectorV0,
	EndophasiaMissionTraceV0,
	EndophasiaRuntimeFactsV0,
	EndophasiaUsageV0,
	type MissionTraceObservationV0,
	readUsageLedgerV0,
	type SessionOverviewV0,
	type UsageObservationV0,
} from "../src/index.ts";

const sessions: Session[] = [];
/** The Session behind each fixture harness, which a real worker pairs with it for the Usage facet. */
const sessionOf = new WeakMap<AgentHarnessType, Session>();
const workers: SessionWorkerServices[] = [];
const scope = { serverConnectionId: "server-1", attachmentId: "attachment-1" };
const sessionOverviewCall = { serviceId: EndophasiaInspectorV0.id, member: "sessionOverview", args: [] };
const runtimeMetricsCall = { serviceId: EndophasiaRuntimeFactsV0.id, member: "runtimeMetrics", args: [] };
const operationOutcomeCall = (operationId: string) => ({
	serviceId: EndophasiaRuntimeFactsV0.id,
	member: "operationOutcome",
	args: [operationId],
});

afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

async function fixture(): Promise<{ harness: AgentHarnessType; faux: ReturnType<typeof fauxProvider> }> {
	const session = new StorageBackedSession(
		{ id: `session-host-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
	sessionOf.set(harness, session);
	return { harness, faux };
}

/**
 * Compose the worker as `run()` and runEndophasiaSessionWorker do: the application acquires its lane and builds the
 * trusted Endophasia host facets, each given only the harness or lane capability it needs. Runtime Facts reads through
 * the reacquired, already established main lane.
 */
async function worker(
	harness: AgentHarnessType,
	options: {
		readonly observed?: Pick<AgentHarnessType, "lanes">;
		readonly withInspector?: boolean;
		readonly plugin?: Parameters<typeof defineFacet>[0];
		readonly usageEvents?: Pick<Events, "on">;
	} = {},
): Promise<SessionWorkerServices> {
	const session = sessionOf.get(harness);
	if (session === undefined) throw new Error("Unknown fixture harness");
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	const main = await harness.lane("main", BACKGROUND_CONTEXT);
	const services = await createSessionWorkerServices({
		lane,
		modelRuntime: undefined,
		hostFacets:
			options.withInspector === false
				? []
				: [
						createEndophasiaInspectorFacetV0(options.observed ?? harness),
						createEndophasiaMissionTraceFacetV0(harness),
						createEndophasiaRuntimeFactsFacetV0(main),
						// As the worker's host runtime provides them: events of this harness, usage reads of its Session.
						createEndophasiaUsageFacetV0({
							events: options.usageEvents ?? harness.events,
							session: { scanUsage: (query, context) => session.scanUsage(query, context) },
						}),
					],
		facetLoader: options.plugin === undefined ? undefined : createStaticFacetLoader([defineFacet(options.plugin)]),
		publish: async () => {},
	});
	workers.push(services);
	return services;
}

async function catalogueIds(services: SessionWorkerServices): Promise<string[]> {
	const catalogue = parseServiceCatalogue(
		await services.invoke(createServiceCatalogueCall(), scope, BACKGROUND_CONTEXT),
	);
	return catalogue.map((entry) => entry.serviceId);
}

async function remoteOverview(services: SessionWorkerServices, context: Context): Promise<SessionOverviewV0> {
	const result = await services.invoke(sessionOverviewCall, scope, context);
	if (!isJsonValue(result)) throw new Error("Session Overview is not strict JSON");
	return result as unknown as SessionOverviewV0;
}

describe("Endophasia Inspector v0 in a Session worker", () => {
	it("adds exactly the Endophasia host services to the worker's generated catalogue", async () => {
		const { harness } = await fixture();
		const without = await catalogueIds(await worker(harness, { withInspector: false }));
		const withEndophasia = await catalogueIds(await worker(harness));
		const endophasia = [
			EndophasiaInspectorV0.id,
			EndophasiaMissionTraceV0.id,
			EndophasiaRuntimeFactsV0.id,
			EndophasiaUsageV0.id,
		];
		for (const id of endophasia) {
			expect(without).not.toContain(id);
			expect(withEndophasia.filter((entry) => entry === id)).toHaveLength(1);
		}
		expect(withEndophasia.filter((id) => !without.includes(id)).sort()).toEqual(endophasia.sort());
		expect(withEndophasia).toHaveLength(without.length + 4);
	});

	it("reacquires the established main lane for Runtime Facts without creating a lane or mutating Pi", async () => {
		const { harness } = await fixture();
		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		const events = vi.fn();
		const mutations: HarnessEventType[] = [
			"lane_created",
			"entry_added",
			"config_update",
			"queue_update",
			"value_update",
		];
		const unsubscribe = mutations.map((type) => harness.events.on(type, events));
		const before = {
			lanes: await harness.lanes(BACKGROUND_CONTEXT),
			entries: await main.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
			execution: await main.inspectExecution(BACKGROUND_CONTEXT),
		};
		expect(await harness.lane("main", BACKGROUND_CONTEXT)).toBe(main);
		await worker(harness);
		expect({
			lanes: await harness.lanes(BACKGROUND_CONTEXT),
			entries: await main.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
			execution: await main.inspectExecution(BACKGROUND_CONTEXT),
		}).toEqual(before);
		expect(before.lanes.map(({ name }) => name)).toEqual(["main"]);
		expect(events).not.toHaveBeenCalled();
		for (const remove of unsubscribe) remove();
	});

	it("serves fresh Runtime Facts through the worker endpoint and keeps them across plugin reloads", async () => {
		const { harness, faux } = await fixture();
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const services = await worker(harness, { plugin: { id: "@test/reloadable-facts", setup() {} } });
		const baseline = await services.invoke(runtimeMetricsCall, scope, BACKGROUND_CONTEXT);
		expect(baseline).toEqual(await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT));
		expect(await services.invoke(operationOutcomeCall("unknown"), scope, BACKGROUND_CONTEXT)).toBeNull();

		faux.setResponses([fauxAssistantMessage("one")]);
		const run = await lane.prompt("first", undefined, BACKGROUND_CONTEXT);
		if (!run.ok) throw run.error;
		await services.invoke({ serviceId: SessionPlugins.id, member: "reload", args: [] }, scope, BACKGROUND_CONTEXT);
		expect((await catalogueIds(services)).filter((id) => id === EndophasiaRuntimeFactsV0.id)).toHaveLength(1);
		// Nothing is held across the reload: each call is a fresh capture from Pi.
		const metrics = await services.invoke(runtimeMetricsCall, scope, BACKGROUND_CONTEXT);
		expect(metrics).toEqual(await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT));
		expect(metrics).not.toEqual(baseline);
		expect(await services.invoke(operationOutcomeCall(run.value.operationId), scope, BACKGROUND_CONTEXT)).toEqual(
			await captureOperationOutcomeV0(lane, run.value.operationId, BACKGROUND_CONTEXT),
		);
	});

	it("serves fresh Session Overview captures through the worker endpoint", async () => {
		const { harness, faux } = await fixture();
		const services = await worker(harness);
		const idle = await remoteOverview(services, BACKGROUND_CONTEXT);
		expect(idle).toEqual(await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT));
		expect(idle.lanes.map((lane) => [lane.name, lane.operation])).toEqual([["main", null]]);

		const research = await harness.lane("research", BACKGROUND_CONTEXT);
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("late");
			},
		]);
		const running = research.prompt("work", undefined, BACKGROUND_CONTEXT);
		await started.promise;
		try {
			const busy = await remoteOverview(services, BACKGROUND_CONTEXT);
			expect(busy).toEqual(await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT));
			expect(busy.schemaVersion).toBe("session-overview.v0");
			expect(busy.consistency).toBe("per-lane");
			const model = faux.getModel();
			expect(busy.lanes.map((lane) => [lane.name, lane.operation?.capturedModel])).toEqual([
				["main", undefined],
				["research", { provider: model.provider, modelId: model.id }],
			]);
			expect(busy.counts).toEqual({ lanes: 2, activeOperations: 1, abortingOperations: 0 });
		} finally {
			release.resolve();
		}
		expect(await running).toMatchObject({ ok: true, value: { status: "completed" } });
		expect((await remoteOverview(services, BACKGROUND_CONTEXT)).counts.activeOperations).toBe(0);
	});

	it("passes the worker invocation Context to the Pi observation", async () => {
		const { harness } = await fixture();
		const seen: Context[] = [];
		const observed = {
			lanes(context: Context) {
				seen.push(context);
				return harness.lanes(context);
			},
		};
		const services = await worker(harness, { observed });
		expect(seen).toEqual([]);
		const context = withAbortSignal(new AbortController().signal, BACKGROUND_CONTEXT);
		await remoteOverview(services, context);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBe(context);
	});

	it("gives plugin facets only Chord's facet API and the read-only overview", async () => {
		const { harness } = await fixture();
		let pluginEnvironment: FacetEnvironment | undefined;
		let pluginOverview: SessionOverviewV0 | undefined;
		const services = await worker(harness, {
			plugin: {
				id: "@test/curious-plugin",
				setup(env) {
					pluginEnvironment = env;
					const inspector = env.use(EndophasiaInspectorV0);
					env.onActivate(async () => {
						pluginOverview = await inspector.sessionOverview(BACKGROUND_CONTEXT);
					});
				},
			},
		});
		expect(Object.keys(pluginEnvironment ?? {}).sort()).toEqual([
			"observe",
			"onActivate",
			"onDeactivate",
			"own",
			"provide",
			"provideMany",
			"replicatedState",
			"use",
		]);
		expect(pluginOverview).toEqual(await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT));
		expect(await remoteOverview(services, BACKGROUND_CONTEXT)).toEqual(pluginOverview);
	});

	it("keeps serving the same host provider across plugin reloads and stops on disposal", async () => {
		const { harness } = await fixture();
		let calls = 0;
		const observed = {
			lanes(context: Context) {
				calls++;
				return harness.lanes(context);
			},
		};
		const services = await worker(harness, { observed, plugin: { id: "@test/reloadable", setup() {} } });
		const before = await remoteOverview(services, BACKGROUND_CONTEXT);
		await services.invoke({ serviceId: SessionPlugins.id, member: "reload", args: [] }, scope, BACKGROUND_CONTEXT);
		expect((await catalogueIds(services)).filter((id) => id === EndophasiaInspectorV0.id)).toHaveLength(1);
		expect(await remoteOverview(services, BACKGROUND_CONTEXT)).toEqual(before);
		expect(calls).toBe(2);

		workers.splice(workers.indexOf(services), 1);
		await services.dispose();
		await expect(remoteOverview(services, BACKGROUND_CONTEXT)).rejects.toThrow();
		expect(calls).toBe(2);
	});

	it("keeps the host Mission Trace, its events and its sequence across plugin reloads", async () => {
		const { harness, faux } = await fixture();
		const seen: MissionTraceObservationV0[] = [];
		const services = await worker(harness, {
			plugin: {
				id: "@test/trace-reader",
				setup(env) {
					const trace = env.use(EndophasiaMissionTraceV0);
					env.onActivate(() => {
						if (trace.state.value !== undefined) seen.push(trace.state.value);
					});
				},
			},
		});
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		expect(await lane.prompt("first", undefined, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });

		await services.invoke({ serviceId: SessionPlugins.id, member: "reload", args: [] }, scope, BACKGROUND_CONTEXT);
		expect((await catalogueIds(services)).filter((id) => id === EndophasiaMissionTraceV0.id)).toHaveLength(1);
		// The reloaded plugin reads the same host state: the first run's events survived the reload.
		const afterReload = seen.at(-1);
		expect(afterReload?.events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);

		expect(await lane.prompt("second", undefined, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
		await services.invoke({ serviceId: SessionPlugins.id, member: "reload", args: [] }, scope, BACKGROUND_CONTEXT);
		const afterSecond = seen.at(-1);
		expect(afterSecond?.events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(afterSecond?.events.slice(0, 5)).toEqual(afterReload?.events);
		expect(new Set(afterSecond?.events.map(({ runId }) => runId)).size).toBe(2);
	});

	it("keeps one host Usage feed across plugin reloads, continuing from the durable ledger", async () => {
		const { harness } = await fixture();
		const session = sessionOf.get(harness)!;
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		let usageListeners = 0;
		const usageEvents: Pick<Events, "on"> = {
			on: ((type: HarnessEventType, listener: Parameters<Events["on"]>[1]) => {
				if (type === "usage") usageListeners++;
				const off = harness.events.on(type, listener);
				return () => {
					if (type === "usage") usageListeners--;
					off();
				};
			}) as Events["on"],
		};
		const seen: UsageObservationV0[] = [];
		const services = await worker(harness, {
			usageEvents,
			plugin: {
				id: "@test/usage-reader",
				setup(env) {
					const usageService = env.use(EndophasiaUsageV0);
					env.onActivate(() => {
						if (usageService.state.value !== undefined) seen.push(usageService.state.value);
					});
				},
			},
		});
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		await lane.recordUsage({ ...usage, cost }, undefined, BACKGROUND_CONTEXT);
		expect(usageListeners).toBe(1);

		const reload = () =>
			services.invoke({ serviceId: SessionPlugins.id, member: "reload", args: [] }, scope, BACKGROUND_CONTEXT);
		await reload();
		expect((await catalogueIds(services)).filter((id) => id === EndophasiaUsageV0.id)).toHaveLength(1);
		expect(usageListeners).toBe(1);
		const durableAfterFirst = (await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).rows;
		expect(seen.at(-1)?.rows).toEqual(durableAfterFirst);

		await lane.recordUsage({ ...usage, totalTokens: 5, cost }, undefined, BACKGROUND_CONTEXT);
		await reload();
		expect(usageListeners).toBe(1);
		const durable = (await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).rows;
		// Identity is the durable row and its sequence: the same rows, once each, in ledger order.
		expect(durable).toHaveLength(2);
		expect(seen.at(-1)?.rows).toEqual(durable);

		workers.splice(workers.indexOf(services), 1);
		await services.dispose();
		expect(usageListeners).toBe(0);
	});
});
