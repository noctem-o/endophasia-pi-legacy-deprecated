import {
	createFacetHost,
	createRemoteServiceBinding,
	createServiceCatalogueCall,
	type FacetHost,
	isJsonValue,
	parseServiceCatalogue,
	type RemoteServiceBinding,
} from "@earendil-works/chord";
import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_FRAME_LENGTH, encodeCbor } from "@earendil-works/pi-protocol";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessType,
	type Events,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { HarnessEventBus } from "../../agent/src/harness/events.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session } from "../../agent/src/harness/session/types.ts";
import {
	attachMissionTraceV0,
	createEndophasiaMissionTraceFacetV0,
	EndophasiaMissionTraceV0,
	MISSION_TRACE_REPLICATED_EVENT_LIMIT,
	type MissionTraceObservationV0,
} from "../src/index.ts";
import { createPiMissionTraceSourceV0 } from "../src/pi-runtime-observation.ts";
import { connectStrictJson } from "./strict-json-transport.ts";

const SENTINELS = [
	"user-prompt-sentinel",
	"assistant-text-sentinel",
	"private-reasoning-sentinel",
	"tool-args-sentinel",
	"tool-result-sentinel",
	"partial-output-sentinel",
];
const SENTINEL_PATTERN = new RegExp(SENTINELS.join("|"));

const sessions: Session[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

async function fixture(options: { deferred?: boolean } = {}): Promise<{
	harness: AgentHarnessType;
	faux: ReturnType<typeof fauxProvider>;
}> {
	const session = new StorageBackedSession(
		{ id: `mission-trace-service-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			...(options.deferred ? { streamOptions: { deferred: true } } : {}),
			tools: [
				{
					name: "echo",
					label: "echo",
					description: "echo",
					parameters: Type.Object({ value: Type.String() }),
					execute: async (
						_id: string,
						_args: { value: string },
						onUpdate: (result: { content: Array<{ type: "text"; text: string }>; details: object }) => void,
					) => {
						onUpdate({ content: [{ type: "text", text: "partial-output-sentinel" }], details: {} });
						return { content: [{ type: "text" as const, text: "tool-result-sentinel" }], details: {} };
					},
				},
			],
			activeToolNames: ["echo"],
		},
		BACKGROUND_CONTEXT,
	);
	return { harness, faux };
}

async function connect(harness: Pick<AgentHarnessType, "events">): Promise<{
	trace: EndophasiaMissionTraceV0;
	host: FacetHost;
	binding: RemoteServiceBinding;
	connection: ReturnType<typeof connectStrictJson>;
}> {
	const host = await createFacetHost({
		facets: [createEndophasiaMissionTraceFacetV0(createPiMissionTraceSourceV0(harness))],
	});
	cleanups.push(() => host.dispose());
	return { host, ...(await bind(host)) };
}

/** A new remote consumer of an existing host, hydrated from one subscription snapshot. */
async function bind(host: FacetHost): Promise<{
	trace: EndophasiaMissionTraceV0;
	binding: RemoteServiceBinding;
	connection: ReturnType<typeof connectStrictJson>;
}> {
	const connection = connectStrictJson(host.services);
	const errors: Error[] = [];
	const binding = createRemoteServiceBinding({
		services: [EndophasiaMissionTraceV0],
		transport: connection.transport,
		onError: (error) => errors.push(error),
	});
	cleanups.push(async () => {
		await binding.dispose(BACKGROUND_CONTEXT);
		connection.dispose();
		expect(errors).toEqual([]);
	});
	const trace = binding.use(EndophasiaMissionTraceV0);
	await binding.ready(BACKGROUND_CONTEXT);
	return { trace, binding, connection };
}

function remoteEvents(trace: EndophasiaMissionTraceV0): MissionTraceObservationV0["events"] {
	return trace.state.value?.events ?? [];
}

describe("Endophasia Mission Trace v0 service", () => {
	it("is published in the host's generated catalogue as one remote singleton", async () => {
		const { harness } = await fixture();
		const { host, connection } = await connect(harness);
		const expected = [{ serviceId: "endophasia.mission-trace.v0", mode: "singleton" }];
		expect(host.services.catalogue).toEqual(expected);
		expect(
			parseServiceCatalogue(await connection.transport.invoke(createServiceCatalogueCall(), BACKGROUND_CONTEXT)),
		).toEqual(expected);
	});

	it("starts as an empty worker-lifetime observation", async () => {
		const { harness } = await fixture();
		const { trace } = await connect(harness);
		expect(trace.state.value).toEqual({
			schemaVersion: "mission-trace-observation.v0",
			scope: "session-worker-lifetime",
			events: [],
		});
	});

	it("replicates exactly the direct Mission Trace of a real tool-using run, without payloads", async () => {
		const { harness, faux } = await fixture();
		const direct = attachMissionTraceV0(harness);
		const { trace } = await connect(harness);
		const revisions: number[] = [];
		trace.state.subscribe((value) => revisions.push(value.events.length));
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("private-reasoning-sentinel"),
					{ type: "text", text: "assistant-text-sentinel" },
					fauxToolCall("echo", { value: "tool-args-sentinel" }, { id: "pi-call-9" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("assistant-text-sentinel"),
		]);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		expect(await lane.prompt("user-prompt-sentinel", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "completed" },
		});

		const expected = direct.sinceSequence(0);
		await expect.poll(() => remoteEvents(trace).length).toBe(expected.length);
		expect(remoteEvents(trace)).toEqual(expected);
		expect(remoteEvents(trace).map(({ sequence }) => sequence)).toEqual(expected.map((_, index) => index + 1));
		const toolEvents = remoteEvents(trace).filter((event) => event.kind.startsWith("tool."));
		expect(toolEvents).toEqual([
			expect.objectContaining({ kind: "tool.started", toolCallId: "pi-call-9", toolName: "echo" }),
			expect.objectContaining({ kind: "tool.finished", toolCallId: "pi-call-9", toolName: "echo", isError: false }),
		]);
		for (const event of toolEvents) {
			expect(Object.keys(event).sort()).toEqual(
				[
					"kind",
					"lane",
					"runId",
					"schemaVersion",
					"sequence",
					"toolCallId",
					"toolName",
					"turnId",
					...(event.kind === "tool.finished" ? ["isError"] : []),
				].sort(),
			);
		}
		expect(JSON.stringify(trace.state.value)).not.toMatch(SENTINEL_PATTERN);
		expect(isJsonValue(trace.state.value)).toBe(true);
		// Updates arrive through state subscription, one revision per appended event.
		expect(revisions.at(-1)).toBe(expected.length);
	});

	it("keeps one run ID across a real suspension and resume", async () => {
		const { harness, faux } = await fixture({ deferred: true });
		const { trace } = await connect(harness);
		faux.setResponses([fauxAssistantMessage("later")]);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const suspended = await lane.prompt("defer", undefined, BACKGROUND_CONTEXT);
		if (!suspended.ok || suspended.value.status !== "suspended") throw new Error("Expected suspension");
		expect(await lane.resume(BACKGROUND_CONTEXT)).toMatchObject({ ok: true, value: { status: "completed" } });
		await expect.poll(() => remoteEvents(trace).at(-1)?.kind).toBe("mission.completed");
		const missions = remoteEvents(trace).filter((event) => event.kind.startsWith("mission."));
		expect(missions.map(({ kind }) => kind)).toEqual([
			"mission.started",
			"mission.suspended",
			"mission.resumed",
			"mission.completed",
		]);
		expect(new Set(missions.map(({ runId }) => runId))).toEqual(new Set([suspended.value.operationId]));
	});

	it("reports aborted and failed runs with their terminal kinds and no failure detail", async () => {
		const { harness } = await fixture();
		const { trace } = await connect(harness);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const admitted = await lane.accept(
			{ kind: "prompt", operationId: "abort-id", prompt: "abort" },
			BACKGROUND_CONTEXT,
		);
		if (!admitted.ok) throw admitted.error;
		await lane.requestAbort("abort-id", BACKGROUND_CONTEXT);
		await lane.drive({ operationId: "abort-id" }, BACKGROUND_CONTEXT);
		await lane.setModel({ provider: "missing", modelId: "missing-model" }, BACKGROUND_CONTEXT);
		expect(await lane.prompt("fail", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "failed" },
		});
		await expect.poll(() => remoteEvents(trace).at(-1)?.kind).toBe("mission.failed");
		expect(remoteEvents(trace).filter((event) => event.kind === "mission.aborted")).toEqual([
			expect.objectContaining({ runId: "abort-id" }),
		]);
		expect(JSON.stringify(trace.state.value)).not.toMatch(/model_unavailable|missing-model/);
	});

	it("uses only harness.events and removes every listener on disposal", async () => {
		const bus = new HarnessEventBus();
		let listeners = 0;
		const events: Events = {
			on(type, listener) {
				listeners++;
				const off = bus.on(type, listener);
				let removed = false;
				return () => {
					if (!removed) listeners--;
					removed = true;
					off();
				};
			},
		};
		// Any other harness capability (lanes, lane acquisition, setters, watchSession) would throw here.
		const harness = new Proxy(
			{ events },
			{
				get(target, property, receiver) {
					if (property !== "events") throw new Error(`Unexpected harness access: ${String(property)}`);
					return Reflect.get(target, property, receiver);
				},
			},
		);
		const { trace, host } = await connect(harness);
		expect(listeners).toBeGreaterThan(0);
		await bus.emit({ type: "run_start", lane: "main", runId: "r", startedAt: 1 }, BACKGROUND_CONTEXT);
		await expect.poll(() => remoteEvents(trace).map(({ kind }) => kind)).toEqual(["mission.started"]);

		await host.dispose();
		expect(listeners).toBe(0);
	});
});

describe("Endophasia Mission Trace v0 replicated window", () => {
	const LIMIT = MISSION_TRACE_REPLICATED_EVENT_LIMIT;
	// Representative identifiers: UUID-sized run and turn IDs and a provider-sized tool call ID.
	const RUN = "0192f3c4-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
	const TURN = "0192f3c4-aaaa-7bbb-8ccc-dddddddddddd";

	/** Emit tool_end events; each becomes exactly one tool.finished trace event with a unique call ID. */
	async function emitToolEnds(bus: HarnessEventBus, count: number): Promise<void> {
		for (let index = 0; index < count; index++) {
			await bus.emit(
				{
					type: "tool_end",
					lane: "main",
					runId: RUN,
					turnId: TURN,
					toolCallId: `toolu_01${String(index).padStart(24, "0")}`,
					toolName: "bash",
					result: { content: [{ type: "text", text: "tool-result-sentinel" }], details: {} },
					isError: false,
					terminate: false,
				},
				BACKGROUND_CONTEXT,
			);
		}
	}

	function sequences(trace: EndophasiaMissionTraceV0): number[] {
		return remoteEvents(trace).map(({ sequence }) => sequence);
	}

	function range(first: number, last: number): number[] {
		return Array.from({ length: last - first + 1 }, (_, index) => first + index);
	}

	it("retains every event up to the limit, then trims the oldest while keeping original sequences", async () => {
		const bus = new HarnessEventBus();
		const direct = attachMissionTraceV0({ events: bus });
		const { trace, connection } = await connect({ events: bus });
		let largest = 0;
		trace.state.subscribe((value) => {
			largest = Math.max(largest, value.events.length);
		});

		await emitToolEnds(bus, LIMIT - 1);
		await expect.poll(() => remoteEvents(trace).length).toBe(LIMIT - 1);
		expect(sequences(trace)).toEqual(range(1, LIMIT - 1));

		await emitToolEnds(bus, 1);
		await expect.poll(() => remoteEvents(trace).at(-1)?.sequence).toBe(LIMIT);
		expect(sequences(trace)).toEqual(range(1, LIMIT));

		// One past the limit drops #1, not the newest event, and renumbers nothing.
		await emitToolEnds(bus, 1);
		await expect.poll(() => remoteEvents(trace).at(-1)?.sequence).toBe(LIMIT + 1);
		expect(sequences(trace)).toEqual(range(2, LIMIT + 1));

		await emitToolEnds(bus, LIMIT + 7);
		const total = 2 * LIMIT + 8;
		await expect.poll(() => remoteEvents(trace).at(-1)?.sequence).toBe(total);
		expect(sequences(trace)).toEqual(range(total - LIMIT + 1, total));
		expect(largest).toBe(LIMIT);

		// The local trace keeps its complete worker-lifetime history; the service publishes its trailing window.
		const history = direct.sinceSequence(0);
		expect(history.map(({ sequence }) => sequence)).toEqual(range(1, total));
		expect(remoteEvents(trace)).toEqual(history.slice(-LIMIT));
		expect(JSON.stringify(trace.state.value)).not.toMatch(SENTINEL_PATTERN);

		// Rolling the full window publishes only the dropped and appended events, never the retained window.
		const rolled = connection.wire.updates.slice(LIMIT);
		expect(rolled).toHaveLength(LIMIT + 8);
		const largestUpdate = Math.max(...rolled.map((update) => JSON.stringify(update).length));
		const window = JSON.stringify(remoteEvents(trace)).length;
		expect(largestUpdate).toBeLessThan(1_024);
		expect(largestUpdate * 100).toBeLessThan(window);
	});

	it("hydrates a fresh consumer with a bounded snapshot far below Pi's frame limit", async () => {
		const bus = new HarnessEventBus();
		const direct = attachMissionTraceV0({ events: bus });
		const { host } = await connect({ events: bus });
		const snapshotBytes = (connection: ReturnType<typeof connectStrictJson>): number =>
			encodeCbor(connection.wire.snapshots[0]).byteLength;

		await emitToolEnds(bus, LIMIT);
		const atLimit = await bind(host);
		expect(sequences(atLimit.trace)).toEqual(range(1, LIMIT));

		const total = 4 * LIMIT + 5;
		await emitToolEnds(bus, total - LIMIT);
		const fresh = await bind(host);
		expect(fresh.connection.wire.snapshots).toHaveLength(1);
		expect(remoteEvents(fresh.trace)).toHaveLength(LIMIT);
		expect(remoteEvents(fresh.trace)[0]?.sequence).toBe(total - LIMIT + 1);
		expect(remoteEvents(fresh.trace).at(-1)?.sequence).toBe(total);
		expect(remoteEvents(fresh.trace)).toEqual(direct.sinceSequence(total - LIMIT));
		expect(JSON.stringify(fresh.trace.state.value)).not.toMatch(SENTINEL_PATTERN);

		// The published snapshot no longer grows with the worker's lifetime, while the local history still does.
		const bounded = snapshotBytes(fresh.connection);
		expect(bounded).toBeLessThan(snapshotBytes(atLimit.connection) * 1.05);
		const history = encodeCbor(direct.sinceSequence(0)).byteLength;
		expect(history).toBeGreaterThan(3 * bounded);
		// Unbounded, this trace would cross Pi's default frame limit after a finite, reachable number of events; the
		// bounded snapshot stays under 1/16 of it however long the worker lives.
		const eventsPerFrame = DEFAULT_MAX_FRAME_LENGTH / (history / total);
		expect(eventsPerFrame).toBeLessThan(200_000);
		expect(bounded).toBeLessThan(DEFAULT_MAX_FRAME_LENGTH / 16);
	});
});
