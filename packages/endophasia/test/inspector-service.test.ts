import {
	type Context,
	createFacetHost,
	createRemoteServiceBinding,
	createServiceCatalogueCall,
	type FacetHost,
	parseServiceCatalogue,
	type RemoteServiceBinding,
} from "@earendil-works/chord";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness, type AgentHarness as AgentHarnessType } from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session } from "../../agent/src/harness/session/types.ts";
import { deferred } from "../../agent/test/harness/runtime/test-utils.ts";
import {
	captureSessionOverviewV0,
	createEndophasiaInspectorFacetV0,
	EndophasiaInspectorV0,
	type SessionOverviewV0,
} from "../src/index.ts";
import { connectStrictJson, HOST_REQUEST } from "./strict-json-transport.ts";

const sessions: Session[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

async function fixture(): Promise<{ harness: AgentHarnessType; faux: ReturnType<typeof fauxProvider> }> {
	const session = new StorageBackedSession(
		{ id: `inspector-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
	return { harness, faux };
}

async function connect(harness: Pick<AgentHarnessType, "lanes">): Promise<{
	inspector: EndophasiaInspectorV0;
	host: FacetHost;
	binding: RemoteServiceBinding;
	connection: ReturnType<typeof connectStrictJson>;
}> {
	const host = await createFacetHost({ facets: [createEndophasiaInspectorFacetV0(harness)] });
	const connection = connectStrictJson(host.services);
	const errors: Error[] = [];
	const binding = createRemoteServiceBinding({
		services: [EndophasiaInspectorV0],
		transport: connection.transport,
		onError: (error) => errors.push(error),
	});
	cleanups.push(async () => {
		await binding.dispose(BACKGROUND_CONTEXT);
		connection.dispose();
		await host.dispose();
		expect(errors).toEqual([]);
	});
	const inspector = binding.use(EndophasiaInspectorV0);
	await binding.ready(BACKGROUND_CONTEXT);
	return { inspector, host, binding, connection };
}

function laneInfo(name: string): Awaited<ReturnType<AgentHarnessType["lanes"]>>[number] {
	return { name, tipId: null, operation: null };
}

describe("Endophasia Inspector v0 service", () => {
	it("is published in the host's generated catalogue as one remote singleton", async () => {
		const { harness } = await fixture();
		const { host, connection } = await connect(harness);
		const expected = [{ serviceId: "endophasia.inspector.v0", mode: "singleton" }];
		expect(host.services.catalogue).toEqual(expected);
		expect(
			parseServiceCatalogue(await connection.transport.invoke(createServiceCatalogueCall(), BACKGROUND_CONTEXT)),
		).toEqual(expected);
	});

	it("returns exactly the direct Session Overview across strict JSON, with and without a captured model", async () => {
		const { harness, faux } = await fixture();
		const busy = await harness.lane("busy", BACKGROUND_CONTEXT);
		const admitted = await harness.lane("admitted", BACKGROUND_CONTEXT);
		await harness.lane("idle", BACKGROUND_CONTEXT);
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("late");
			},
		]);
		const running = busy.prompt("work", undefined, BACKGROUND_CONTEXT);
		await started.promise;
		// Admitted but never driven: Pi has not captured a model for this operation.
		const accepted = await admitted.accept({ kind: "prompt", operationId: "held", prompt: "x" }, BACKGROUND_CONTEXT);
		if (!accepted.ok) throw accepted.error;
		try {
			const { inspector } = await connect(harness);
			const direct = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
			const remote = await inspector.sessionOverview(BACKGROUND_CONTEXT);
			expect(remote).toEqual(direct);
			expect(remote).not.toBe(direct);
			expect(remote.schemaVersion).toBe("session-overview.v0");
			expect(remote.consistency).toBe("per-lane");
			expect(remote.lanes.map((lane) => lane.name)).toEqual(["admitted", "busy", "idle"]);
			const model = faux.getModel();
			expect(remote.lanes[1]?.operation?.capturedModel).toEqual({ provider: model.provider, modelId: model.id });
			expect(remote.lanes[0]?.operation).toMatchObject({ operationId: "held", status: "open" });
			expect(remote.lanes[0]?.operation).not.toHaveProperty("capturedModel");
			expect(remote.counts).toEqual({ lanes: 3, activeOperations: 2, abortingOperations: 0 });
		} finally {
			release.resolve();
		}
		expect(await running).toMatchObject({ ok: true, value: { status: "completed" } });
	});

	it("captures fresh Pi state on every request instead of retaining an overview", async () => {
		const { harness } = await fixture();
		const { inspector } = await connect(harness);
		const first = await inspector.sessionOverview(BACKGROUND_CONTEXT);
		expect(first).toEqual(await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT));
		expect(first.lanes).toEqual([]);

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const accepted = await lane.accept({ kind: "prompt", operationId: "run-1", prompt: "x" }, BACKGROUND_CONTEXT);
		if (!accepted.ok) throw accepted.error;
		await lane.requestAbort("run-1", BACKGROUND_CONTEXT);
		const second = await inspector.sessionOverview(BACKGROUND_CONTEXT);
		expect(second).toEqual(await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT));
		expect(second.lanes[0]?.operation).toMatchObject({ operationId: "run-1", status: "aborting" });
		expect(second.counts).toEqual({ lanes: 1, activeOperations: 1, abortingOperations: 1 });
		expect(first.lanes).toEqual([]);
	});

	it("uses only harness.lanes, never eagerly, with each host call's Context", async () => {
		const seen: Context[] = [];
		let lanes = [laneInfo("b"), laneInfo("a")];
		const lanesOnly = {
			lanes: async (context: Context) => {
				seen.push(context);
				return lanes;
			},
		};
		// Any other harness capability (lane acquisition, events, setters, watchSession) would throw here.
		const harness = new Proxy(lanesOnly, {
			get(target, property, receiver) {
				if (property !== "lanes") throw new Error(`Unexpected harness access: ${String(property)}`);
				return Reflect.get(target, property, receiver);
			},
		});
		const { inspector, connection } = await connect(harness);
		expect(seen).toEqual([]);

		expect((await inspector.sessionOverview(BACKGROUND_CONTEXT)).lanes.map((lane) => lane.name)).toEqual(["a", "b"]);
		lanes = [laneInfo("c")];
		expect((await inspector.sessionOverview(BACKGROUND_CONTEXT)).lanes.map((lane) => lane.name)).toEqual(["c"]);

		expect(seen).toHaveLength(2);
		const [firstCall, secondCall] = seen;
		expect(connection.hostContexts).toContain(firstCall);
		expect(connection.hostContexts).toContain(secondCall);
		expect(firstCall).not.toBe(secondCall);
		expect(firstCall?.value(HOST_REQUEST)).not.toBe(secondCall?.value(HOST_REQUEST));
	});

	it("propagates a failed Pi observation instead of fabricating or replaying an overview", async () => {
		let failure: Error | undefined;
		const harness = {
			lanes: async () => {
				if (failure !== undefined) throw failure;
				return [laneInfo("main")];
			},
		};
		const { inspector } = await connect(harness);
		const healthy = await inspector.sessionOverview(BACKGROUND_CONTEXT);
		expect(healthy.counts.lanes).toBe(1);

		failure = new Error("lanes unavailable");
		await expect(inspector.sessionOverview(BACKGROUND_CONTEXT)).rejects.toThrow("lanes unavailable");

		failure = undefined;
		expect(await inspector.sessionOverview(BACKGROUND_CONTEXT)).toEqual(healthy);
	});

	it("stops serving when the host or the binding is disposed, without touching Pi", async () => {
		let calls = 0;
		const harness = {
			lanes: async () => {
				calls++;
				return [laneInfo("main")];
			},
		};
		const { inspector, host, binding } = await connect(harness);
		const overview: SessionOverviewV0 = await inspector.sessionOverview(BACKGROUND_CONTEXT);
		expect(overview.lanes).toHaveLength(1);

		await host.dispose();
		await expect(inspector.sessionOverview(BACKGROUND_CONTEXT)).rejects.toThrow();
		await binding.dispose(BACKGROUND_CONTEXT);
		expect(() => inspector.sessionOverview(BACKGROUND_CONTEXT)).toThrow("Remote service binding is disposed");
		expect(calls).toBe(1);
	});
});
