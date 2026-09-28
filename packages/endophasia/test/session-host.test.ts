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
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness, type AgentHarness as AgentHarnessType } from "../../agent/src/harness/agent-harness.ts";
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
	captureSessionOverviewV0,
	createEndophasiaInspectorFacetV0,
	createEndophasiaMissionTraceFacetV0,
	EndophasiaInspectorV0,
	EndophasiaMissionTraceV0,
	type MissionTraceObservationV0,
	type SessionOverviewV0,
} from "../src/index.ts";

const sessions: Session[] = [];
const workers: SessionWorkerServices[] = [];
const scope = { serverConnectionId: "server-1", attachmentId: "attachment-1" };
const sessionOverviewCall = { serviceId: EndophasiaInspectorV0.id, member: "sessionOverview", args: [] };

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
	return { harness, faux };
}

/**
 * Compose the worker as `run()` and runEndophasiaSessionWorker do: the application acquires its lane and builds the
 * trusted Endophasia host facets, each given only the harness capability it needs.
 */
async function worker(
	harness: AgentHarnessType,
	options: {
		readonly observed?: Pick<AgentHarnessType, "lanes">;
		readonly withInspector?: boolean;
		readonly plugin?: Parameters<typeof defineFacet>[0];
	} = {},
): Promise<SessionWorkerServices> {
	const services = await createSessionWorkerServices({
		lane: await harness.lane("main", BACKGROUND_CONTEXT),
		modelRuntime: undefined,
		hostFacets:
			options.withInspector === false
				? []
				: [
						createEndophasiaInspectorFacetV0(options.observed ?? harness),
						createEndophasiaMissionTraceFacetV0(harness),
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
	it("adds exactly the Inspector and Mission Trace services to the worker's generated catalogue", async () => {
		const { harness } = await fixture();
		const without = await catalogueIds(await worker(harness, { withInspector: false }));
		const withEndophasia = await catalogueIds(await worker(harness));
		expect(without).not.toContain(EndophasiaInspectorV0.id);
		expect(without).not.toContain(EndophasiaMissionTraceV0.id);
		expect(withEndophasia.filter((id) => !without.includes(id)).sort()).toEqual(
			[EndophasiaInspectorV0.id, EndophasiaMissionTraceV0.id].sort(),
		);
		expect(withEndophasia.filter((id) => id === EndophasiaInspectorV0.id)).toHaveLength(1);
		expect(withEndophasia.filter((id) => id === EndophasiaMissionTraceV0.id)).toHaveLength(1);
		expect(withEndophasia).toHaveLength(without.length + 2);
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
});
