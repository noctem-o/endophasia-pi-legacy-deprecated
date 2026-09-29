import {
	type Context,
	createServiceCatalogueCall,
	type Facet,
	isJsonValue,
	parseServiceCatalogue,
} from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
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
import type { Session } from "../../agent/src/harness/session/types.ts";
import {
	createSessionWorkerServices,
	type SessionWorkerServices,
} from "../../coding-agent/src/experimental/services/worker.ts";
import {
	CONTINUITY_REMOTE_BYTE_LIMIT,
	type ContinuitySnapshotV0,
	captureContinuityV0,
	createEndophasiaContinuityFacetV0,
	EndophasiaContinuityV0,
} from "../src/index.ts";
import {
	type ContinuityReads,
	largestSyntheticCountWithinLimit,
	syntheticContinuityLane,
} from "./continuity-synthetic.ts";

const sessions: Session[] = [];
const workers: SessionWorkerServices[] = [];
const scope = { serverConnectionId: "server-1", attachmentId: "attachment-1" };
const snapshotCall = { serviceId: EndophasiaContinuityV0.id, member: "snapshot", args: [] };
const SENTINELS =
	/user-prompt-sentinel|assistant-sentinel|thinking-sentinel|tool-args-sentinel|partial-output-sentinel|tool-result-sentinel|compaction-summary-sentinel|branch-summary-sentinel|custom-data-sentinel|old-history-sentinel/;

afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

async function fixture(): Promise<{
	harness: AgentHarnessType;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
	session: Session;
}> {
	const session = new StorageBackedSession(
		{ id: `continuity-service-${sessions.length}`, createdAt: 1, storageVersion: 1 },
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
	return { harness, lane: await harness.lane("main", BACKGROUND_CONTEXT), faux, session };
}

/** A Session worker endpoint with the given host facets, as runEndophasiaSessionWorker composes one. */
async function worker(lane: AgentLane, hostFacets: readonly Facet[]): Promise<SessionWorkerServices> {
	const services = await createSessionWorkerServices({
		lane,
		modelRuntime: undefined,
		hostFacets,
		facetLoader: undefined,
		publish: async () => {},
	});
	workers.push(services);
	return services;
}

/** Invoke the remote snapshot method, requiring a strict JSON result as the Pi protocol carries it. */
async function remoteSnapshot(
	services: SessionWorkerServices,
	context = BACKGROUND_CONTEXT,
): Promise<ContinuitySnapshotV0> {
	const result = await services.invoke(snapshotCall, scope, context);
	if (!isJsonValue(result)) throw new Error("Continuity snapshot is not strict JSON");
	return result as unknown as ContinuitySnapshotV0;
}

/** Only the two reads the facet is given, each call counted and its watcher release observed. */
function countedReads(lane: ContinuityReads): {
	reads: ContinuityReads;
	calls: { watch: number; findEntries: number; unsubscribe: number; contexts: Context[] };
} {
	const calls = { watch: 0, findEntries: 0, unsubscribe: 0, contexts: [] as Context[] };
	return {
		calls,
		reads: {
			async watch(context) {
				calls.watch++;
				calls.contexts.push(context);
				const watch = await lane.watch(context);
				return {
					...watch,
					unsubscribe: () => {
						calls.unsubscribe++;
						watch.unsubscribe();
					},
				};
			},
			findEntries(query, context) {
				calls.findEntries++;
				calls.contexts.push(context);
				return lane.findEntries(query, context);
			},
		},
	};
}

describe("Continuity Remote v0", () => {
	it("is one Pi-backed snapshot method under endophasia.continuity.v0", async () => {
		const { lane } = await fixture();
		expect(EndophasiaContinuityV0.id).toBe("endophasia.continuity.v0");
		const without = await worker(lane, []);
		const services = await worker(lane, [createEndophasiaContinuityFacetV0(lane)]);
		const ids = async (endpoint: SessionWorkerServices) =>
			parseServiceCatalogue(await endpoint.invoke(createServiceCatalogueCall(), scope, BACKGROUND_CONTEXT)).map(
				(entry) => entry.serviceId,
			);
		const plain = await ids(without);
		const withContinuity = await ids(services);
		expect(plain).not.toContain(EndophasiaContinuityV0.id);
		expect(withContinuity.filter((id) => !plain.includes(id))).toEqual([EndophasiaContinuityV0.id]);
		expect(() => createEndophasiaContinuityFacetV0(undefined as unknown as AgentLane)).toThrow(TypeError);
		expect(() => createEndophasiaContinuityFacetV0(null as unknown as AgentLane)).toThrow(TypeError);
	});

	it("serves an empty lane exactly as captureContinuityV0 captures it", async () => {
		const { lane, faux } = await fixture();
		const services = await worker(lane, [createEndophasiaContinuityFacetV0(lane)]);
		const remote = await remoteSnapshot(services);
		expect(remote).toEqual(await captureContinuityV0(lane, BACKGROUND_CONTEXT));
		expect(remote).toEqual({
			schemaVersion: "continuity.v0",
			lane: "main",
			tipId: null,
			configuration: {
				model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
				thinkingLevel: "off",
				activeToolNames: ["echo"],
			},
			activePath: [],
			contextWindow: [],
			compaction: null,
			counts: { activePathEntries: 0, contextWindowEntries: 0, beforeContextWindow: 0 },
		});
	});

	it("serves ordinary messages and tool use with no prompt, answer, reasoning or tool payload", async () => {
		const { lane, faux } = await fixture();
		const services = await worker(lane, [createEndophasiaContinuityFacetV0(lane)]);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("thinking-sentinel"),
					fauxToolCall("echo", { value: "tool-args-sentinel" }, { id: "call-1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("assistant-sentinel"),
		]);
		expect(await lane.prompt("user-prompt-sentinel", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "completed" },
		});
		const remote = await remoteSnapshot(services);
		expect(remote).toEqual(await captureContinuityV0(lane, BACKGROUND_CONTEXT));
		expect(remote.tipId).toBe(await lane.getTipId(BACKGROUND_CONTEXT));
		expect(
			remote.activePath.map((entry) => (entry.type === "message" ? [entry.role, entry.stopReason] : [])),
		).toEqual([
			["user", undefined],
			["assistant", "toolUse"],
			["toolResult", undefined],
			["assistant", "stop"],
		]);
		expect(JSON.stringify(remote)).not.toMatch(SENTINELS);
		expect(JSON.stringify(remote)).not.toMatch(
			/"(content|arguments|details|thinking|text|summary|data|errorMessage)":/,
		);
	});

	it("serves real compaction: full ancestry, the compaction boundary and no summary", async () => {
		const { lane, faux } = await fixture();
		const services = await worker(lane, [createEndophasiaContinuityFacetV0(lane)]);
		const oldId = await lane.appendMessage(
			{ role: "user", content: "old-history-sentinel", timestamp: 1 },
			BACKGROUND_CONTEXT,
		);
		faux.setResponses([fauxAssistantMessage("compaction-summary-sentinel")]);
		expect(await lane.compact(undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { compaction: { status: "completed" } },
		});
		const remote = await remoteSnapshot(services);
		expect(remote).toEqual(await captureContinuityV0(lane, BACKGROUND_CONTEXT));
		expect(remote.activePath.map(({ id }) => id)).toContain(oldId);
		expect(remote.contextWindow.map(({ id }) => id)).not.toContain(oldId);
		expect(remote.compaction).toMatchObject({ entryId: remote.contextWindow[0]?.id, fromHook: false });
		expect(remote.contextWindow[0]).toMatchObject({ type: "compaction", hasSummary: true });
		expect(remote.counts.beforeContextWindow).toBe(remote.activePath.length - remote.contextWindow.length);
		expect(remote.counts.beforeContextWindow).toBeGreaterThan(0);
		expect(JSON.stringify(remote)).not.toMatch(SENTINELS);
	});

	it("follows a navigated tip and serves branch summaries structurally", async () => {
		const { lane, session, faux } = await fixture();
		const services = await worker(lane, [createEndophasiaContinuityFacetV0(lane)]);
		const rootId = await lane.appendMessage({ role: "user", content: "root", timestamp: 1 }, BACKGROUND_CONTEXT);
		const sourceId = await lane.appendMessage({ role: "user", content: "source", timestamp: 2 }, BACKGROUND_CONTEXT);
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						{
							kind: "entry",
							entry: {
								id: "target",
								parentId: rootId,
								type: "message",
								message: { role: "user", content: "target", timestamp: 3 },
							},
						},
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const before = await remoteSnapshot(services);
		faux.setResponses([fauxAssistantMessage("branch-summary-sentinel")]);
		expect(await lane.navigateTree("target", { summarize: true, label: "chosen" }, BACKGROUND_CONTEXT)).toMatchObject(
			{
				ok: true,
				value: { navigation: { status: "completed" } },
			},
		);
		const after = await remoteSnapshot(services);
		expect(before.tipId).toBe(sourceId);
		expect(after).toEqual(await captureContinuityV0(lane, BACKGROUND_CONTEXT));
		expect(after.activePath.map(({ id }) => id)).toContain("target");
		expect(after.activePath.map(({ id }) => id)).not.toContain(sourceId);
		expect(after.activePath).toContainEqual(
			expect.objectContaining({ type: "branch_summary", fromId: sourceId, hasSummary: true }),
		);
		expect(JSON.stringify(after)).not.toMatch(SENTINELS);
	});

	it("serves the current model, thinking and tool configuration on each fresh capture", async () => {
		const { lane } = await fixture();
		const services = await worker(lane, [createEndophasiaContinuityFacetV0(lane)]);
		const first = await remoteSnapshot(services);
		await lane.setModel({ provider: "other", modelId: "selected" }, BACKGROUND_CONTEXT);
		await lane.setThinkingLevel("high", BACKGROUND_CONTEXT);
		await lane.setActiveTools([], BACKGROUND_CONTEXT);
		const second = await remoteSnapshot(services);
		expect(first.configuration.thinkingLevel).toBe("off");
		expect(second.configuration).toEqual({
			model: { provider: "other", modelId: "selected" },
			thinkingLevel: "high",
			activeToolNames: [],
		});
	});

	it("serves custom entry membership without its data", async () => {
		const { lane } = await fixture();
		const services = await worker(lane, [createEndophasiaContinuityFacetV0(lane)]);
		const withData = await lane.appendCustomEntry("app-note", { secret: "custom-data-sentinel" }, BACKGROUND_CONTEXT);
		const withoutData = await lane.appendCustomEntry("marker", undefined, BACKGROUND_CONTEXT);
		const remote = await remoteSnapshot(services);
		expect(remote).toEqual(await captureContinuityV0(lane, BACKGROUND_CONTEXT));
		expect(remote.activePath).toEqual([
			expect.objectContaining({ id: withData, type: "custom", customType: "app-note", hasData: true }),
			expect.objectContaining({ id: withoutData, type: "custom", customType: "marker", hasData: false }),
		]);
		expect(JSON.stringify(remote)).not.toMatch(SENTINELS);
	});

	it("captures afresh on every call, reading only watch and findEntries and releasing each watcher", async () => {
		const { lane } = await fixture();
		const { reads, calls } = countedReads(lane);
		const services = await worker(lane, [createEndophasiaContinuityFacetV0(reads)]);
		// Installing the facet reads nothing: there is no seed, cache or subscription.
		expect(calls).toMatchObject({ watch: 0, findEntries: 0 });

		const empty = await remoteSnapshot(services);
		expect(calls).toMatchObject({ watch: 1, findEntries: 0, unsubscribe: 1 });
		const firstId = await lane.appendMessage({ role: "user", content: "first", timestamp: 1 }, BACKGROUND_CONTEXT);
		const one = await remoteSnapshot(services);
		const secondId = await lane.appendMessage({ role: "user", content: "second", timestamp: 2 }, BACKGROUND_CONTEXT);
		const two = await remoteSnapshot(services);
		expect(calls).toMatchObject({ watch: 3, findEntries: 2, unsubscribe: 3 });
		expect([empty.tipId, one.tipId, two.tipId]).toEqual([null, firstId, secondId]);
		expect(two.activePath.map(({ id }) => id)).toEqual([firstId, secondId]);
		// A returned value is the caller's own: changing it changes no later capture.
		two.activePath.pop();
		two.configuration.activeToolNames.push("tampered");
		expect(await remoteSnapshot(services)).toEqual(await captureContinuityV0(lane, BACKGROUND_CONTEXT));
	});

	it("is read-only: no Pi mutation, lane creation or configuration change", async () => {
		const { harness, lane } = await fixture();
		await lane.appendMessage({ role: "user", content: "message", timestamp: 1 }, BACKGROUND_CONTEXT);
		const services = await worker(lane, [createEndophasiaContinuityFacetV0(lane)]);
		const mutations: HarnessEventType[] = [
			"lane_created",
			"entry_added",
			"config_update",
			"queue_update",
			"value_update",
			"run_start",
			"compaction_start",
			"navigation_start",
		];
		const events = vi.fn();
		const unsubscribe = mutations.map((type) => harness.events.on(type, events));
		const before = {
			lanes: await harness.lanes(BACKGROUND_CONTEXT),
			entries: await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
			execution: await lane.inspectExecution(BACKGROUND_CONTEXT),
		};
		for (let i = 0; i < 3; i++) await remoteSnapshot(services);
		expect({
			lanes: await harness.lanes(BACKGROUND_CONTEXT),
			entries: await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
			execution: await lane.inspectExecution(BACKGROUND_CONTEXT),
		}).toEqual(before);
		expect(events).not.toHaveBeenCalled();
		for (const remove of unsubscribe) remove();
	});

	it("passes the invocation Context to both reads", async () => {
		const { lane } = await fixture();
		await lane.appendMessage({ role: "user", content: "message", timestamp: 1 }, BACKGROUND_CONTEXT);
		const { reads, calls } = countedReads(lane);
		const services = await worker(lane, [createEndophasiaContinuityFacetV0(reads)]);
		const context = withAbortSignal(new AbortController().signal, BACKGROUND_CONTEXT);
		await remoteSnapshot(services, context);
		expect(calls.contexts).toHaveLength(2);
		for (const seen of calls.contexts) expect(seen).toBe(context);
	});

	it("propagates capture failures instead of serving an empty snapshot, and releases the watcher", async () => {
		const { lane } = await fixture();
		await lane.appendMessage({ role: "user", content: "message", timestamp: 1 }, BACKGROUND_CONTEXT);
		const unsubscribe = vi.fn();
		const failingHistory = await worker(lane, [
			createEndophasiaContinuityFacetV0({
				watch: async (context) => ({ ...(await lane.watch(context)), unsubscribe }),
				findEntries: async () => {
					throw new Error("history unavailable");
				},
			}),
		]);
		await expect(remoteSnapshot(failingHistory)).rejects.toThrow("history unavailable");
		expect(unsubscribe).toHaveBeenCalledOnce();

		const failingWatch = await worker(lane, [
			createEndophasiaContinuityFacetV0({
				watch: async () => {
					throw new Error("lane unavailable");
				},
				findEntries: (query, context) => lane.findEntries(query, context),
			}),
		]);
		await expect(remoteSnapshot(failingWatch)).rejects.toThrow("lane unavailable");
	});

	it("serves a snapshot up to the remote byte limit whole, and fails one entry beyond it", async () => {
		const { lane } = await fixture();
		const { count, bytes } = await largestSyntheticCountWithinLimit(lane, BACKGROUND_CONTEXT);
		expect(bytes).toBeLessThanOrEqual(CONTINUITY_REMOTE_BYTE_LIMIT);
		expect(bytes).toBeGreaterThan(CONTINUITY_REMOTE_BYTE_LIMIT - 1_200);

		const atLimit = await worker(lane, [createEndophasiaContinuityFacetV0(syntheticContinuityLane(lane, count))]);
		const whole = await remoteSnapshot(atLimit);
		expect(new TextEncoder().encode(JSON.stringify(whole)).byteLength).toBe(bytes);
		expect(whole.activePath).toHaveLength(count);
		expect(whole.counts.activePathEntries).toBe(count);

		const overLimit = await worker(lane, [
			createEndophasiaContinuityFacetV0(syntheticContinuityLane(lane, count + 1)),
		]);
		// Never a shortened activePath that claims to be the tip's whole ancestry.
		await expect(remoteSnapshot(overLimit)).rejects.toThrow(
			new RegExp(`${count + 1} active-path entries, over the ${CONTINUITY_REMOTE_BYTE_LIMIT}-byte remote limit`),
		);
	});
});
