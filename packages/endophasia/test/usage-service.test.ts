import {
	type Context,
	createFacetHost,
	createRemoteServiceBinding,
	createServiceCatalogueCall,
	defineFacet,
	type Facet,
	type FacetHost,
	isJsonValue,
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
import { DEFAULT_MAX_FRAME_LENGTH, encodeCbor } from "@earendil-works/pi-protocol";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentHarness,
	type AgentLane,
	type EventListener,
	type Events,
	type HarnessEvent,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session, UsageRow, UsageScan } from "../../agent/src/harness/session/types.ts";
import type { AgentHarnessTool } from "../../agent/src/harness/types.ts";
import {
	attachUsageFeedV0,
	createEndophasiaUsageFacetV0,
	EndophasiaUsageV0,
	readUsageLedgerV0,
	USAGE_REPLICATED_ROW_LIMIT,
	type UsageFeedSourceV0,
	type UsageLedgerRowV0,
	type UsageObservationV0,
} from "../src/index.ts";
import { exactUsageProvider, usage } from "./exact-usage-provider.ts";
import { connectStrictJson, HOST_REQUEST } from "./strict-json-transport.ts";

const LIMIT = USAGE_REPLICATED_ROW_LIMIT;
const SENTINELS = [
	"prompt-sentinel",
	"assistant-text-sentinel",
	"reasoning-sentinel",
	"tool-args-sentinel",
	"tool-result-sentinel",
	"summary-sentinel",
	"details-sentinel",
	"error-message-sentinel",
];
const SENTINEL_PATTERN = new RegExp(SENTINELS.join("|"));

const A = usage(11, 7, 13, 5, 41, [0.5, 0.25, 0.125, 0.0625, 0.9375]);
const B = usage(17, 3, 2, 19, 43, [1.5, 0.75, 0.375, 0.1875, 2.8125], { reasoning: 2, cacheWrite1h: 4 });
const C = usage(29, 23, 31, 37, 120, [2, 4, 8, 16, 30]);

const sessions: Session[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

async function fixture(): Promise<{
	session: StorageBackedSession;
	harness: AgentHarness;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
	reported: Usage[];
}> {
	const session = new StorageBackedSession(
		{ id: `usage-service-${sessions.length}`, createdAt: 1, storageVersion: 1 },
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
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { session, harness, lane, faux, reported };
}

async function record(lane: AgentLane, value: Usage, details?: UsageRow["details"]): Promise<void> {
	const result = await lane.recordUsage(value, details === undefined ? undefined : { details }, BACKGROUND_CONTEXT);
	if (!result.ok) throw result.error;
}

async function ledger(session: Pick<Session, "scanUsage">): Promise<UsageLedgerRowV0[]> {
	return (await readUsageLedgerV0(session, { limit: 10_000 }, BACKGROUND_CONTEXT)).rows;
}

async function connect(
	source: UsageFeedSourceV0,
	extraFacets: readonly Facet[] = [],
): Promise<{
	usageService: EndophasiaUsageV0;
	host: FacetHost;
	binding: RemoteServiceBinding;
	connection: ReturnType<typeof connectStrictJson>;
}> {
	const host = await createFacetHost({ facets: [createEndophasiaUsageFacetV0(source), ...extraFacets] });
	cleanups.push(() => host.dispose());
	const connection = connectStrictJson(host.services);
	const errors: Error[] = [];
	const binding = createRemoteServiceBinding({
		services: [EndophasiaUsageV0],
		transport: connection.transport,
		onError: (error) => errors.push(error),
	});
	cleanups.push(async () => {
		await binding.dispose(BACKGROUND_CONTEXT);
		connection.dispose();
		expect(errors).toEqual([]);
	});
	const usageService = binding.use(EndophasiaUsageV0);
	await binding.ready(BACKGROUND_CONTEXT);
	return { usageService, host, binding, connection };
}

function observation(service: EndophasiaUsageV0): UsageObservationV0 {
	const value = service.state.value;
	if (value === undefined) throw new Error("Usage observation is not hydrated");
	return value;
}

function sequences(rows: readonly UsageLedgerRowV0[]): number[] {
	return rows.map(({ sequence }) => sequence);
}

/** A real source whose scanUsage can run hooks around each durable read, as the facet and its feed perform them. */
function hooked(
	harness: AgentHarness,
	session: Session,
	hooks: { before?: (call: number, query: UsageScan) => Promise<void>; after?: (call: number) => Promise<void> },
) {
	const calls: UsageScan[] = [];
	return {
		calls,
		source: {
			events: harness.events,
			session: {
				async scanUsage(query: UsageScan, context: Context) {
					const call = calls.length;
					calls.push(query);
					await hooks.before?.(call, query);
					const rows = await session.scanUsage(query, context);
					await hooks.after?.(call);
					return rows;
				},
			},
		} satisfies UsageFeedSourceV0,
	};
}

/** A representative durable row: UUID-sized identities, an entry association and every usage field. */
function fakeRow(seq: number, overrides: Partial<UsageRow> = {}): UsageRow {
	return {
		id: `0192f3c4-5e6f-7a8b-9c0d-${String(seq).padStart(12, "0")}`,
		seq,
		adjustment: false,
		entryId: `0192f3c4-aaaa-7bbb-8ccc-${String(seq).padStart(12, "0")}`,
		usage: usage(123_456, 7_890, 98_765, 4_321, 234_432, [0.370368, 0.11835, 0.0296295, 0.01620375, 0.53455125], {
			reasoning: 1_234,
			cacheWrite1h: 321,
		}),
		details: { note: "details-sentinel" },
		...overrides,
	};
}

/** A fake source over in-memory rows exposing only events.on("usage") and scanUsage, recording every read. */
function fakeSource(initial: UsageRow[] = []) {
	const rows = [...initial];
	const listeners = new Set<EventListener>();
	const calls: UsageScan[] = [];
	const contexts: Context[] = [];
	const events: Pick<Events, "on"> = {
		on: ((type: string, listener: EventListener) => {
			expect(type).toBe("usage");
			listeners.add(listener);
			return () => listeners.delete(listener);
		}) as Events["on"],
	};
	const session = {
		scanUsage: async (query: UsageScan, context: Context) => {
			calls.push(query);
			contexts.push(context);
			const selected = rows
				.filter(
					(row) =>
						(query.fromSeq === undefined || row.seq >= query.fromSeq) &&
						(query.toSeq === undefined || row.seq <= query.toSeq),
				)
				.sort((left, right) => (query.order === "desc" ? right.seq - left.seq : left.seq - right.seq));
			return structuredClone(query.limit === undefined ? selected : selected.slice(0, query.limit));
		},
	};
	return {
		source: { events, session } satisfies UsageFeedSourceV0,
		calls,
		contexts,
		listenerCount: () => listeners.size,
		async commit(row: UsageRow) {
			rows.push(row);
			const event = { type: "usage", lane: "fake", row, totals: row.usage } as HarnessEvent;
			for (const listener of [...listeners]) await listener(structuredClone(event), BACKGROUND_CONTEXT);
		},
	};
}

/** Rows at every third sequence, as when other durable records interleave with usage. */
function gappedRows(count: number): UsageRow[] {
	return Array.from({ length: count }, (_, index) => fakeRow(3 * (index + 1)));
}

describe("Endophasia Usage v0 service", () => {
	it("is published in the host's generated catalogue as one remote singleton", async () => {
		const { harness, session } = await fixture();
		const { host, connection } = await connect({ events: harness.events, session });
		const expected = [{ serviceId: "endophasia.usage.v0", mode: "singleton" }];
		expect(host.services.catalogue).toEqual(expected);
		expect(
			parseServiceCatalogue(await connection.transport.invoke(createServiceCatalogueCall(), BACKGROUND_CONTEXT)),
		).toEqual(expected);
	});

	describe("durable seeding", () => {
		it("starts an empty Session as an empty observation with no earlier rows", async () => {
			const { harness, session, lane } = await fixture();
			const { usageService } = await connect({ events: harness.events, session });
			expect(observation(usageService)).toEqual({
				schemaVersion: "usage-observation.v0",
				scope: "session",
				hasEarlierRows: false,
				rows: [],
			});
			await record(lane, A);
			await expect.poll(() => observation(usageService).rows.length).toBe(1);
			expect(observation(usageService).hasEarlierRows).toBe(false);
		});

		it("seeds existing rows ascending with their session-global sequence gaps, not read as truncation", async () => {
			const { harness, session, lane } = await fixture();
			await record(lane, A);
			await lane.appendMessage({ role: "user", content: "gap", timestamp: 1 }, BACKGROUND_CONTEXT);
			await lane.appendMessage({ role: "user", content: "gap", timestamp: 2 }, BACKGROUND_CONTEXT);
			await record(lane, B);
			const durable = await ledger(session);
			const { usageService } = await connect({ events: harness.events, session });
			const seeded = observation(usageService);
			expect(seeded.rows).toEqual(durable);
			expect(seeded.hasEarlierRows).toBe(false);
			const [first, second] = sequences(seeded.rows);
			// Other durable records sit between the rows and before the first: the window is still complete.
			expect(first).toBeGreaterThan(1);
			expect(second! - first!).toBeGreaterThan(1);
		});

		it("keeps exactly the limit without earlier rows, and the newest limit with earlier rows past it", async () => {
			const exact = fakeSource(gappedRows(LIMIT));
			const atLimit = await connect(exact.source);
			expect(observation(atLimit.usageService).rows).toHaveLength(LIMIT);
			expect(observation(atLimit.usageService).hasEarlierRows).toBe(false);
			expect(observation(atLimit.usageService).rows[0]?.sequence).toBe(3);

			const over = fakeSource(gappedRows(LIMIT + 1));
			const pastLimit = await connect(over.source);
			const seeded = observation(pastLimit.usageService);
			expect(seeded.rows).toHaveLength(LIMIT);
			expect(seeded.hasEarlierRows).toBe(true);
			expect(sequences(seeded.rows)).toEqual(
				gappedRows(LIMIT + 1)
					.slice(1)
					.map(({ seq }) => seq),
			);
		});

		it("reads only the latest limit + 1 rows of a large ledger, never replaying history", async () => {
			const fake = fakeSource(gappedRows(50_000));
			const { usageService } = await connect(fake.source);
			const seeded = observation(usageService);
			expect(seeded.hasEarlierRows).toBe(true);
			expect(seeded.rows).toHaveLength(LIMIT);
			expect(seeded.rows.at(-1)?.sequence).toBe(150_000);
			expect(fake.calls[0]).toEqual({ order: "desc", limit: LIMIT + 1 });
			// Only the feed's high-water read follows: nothing reads from before the seeded window.
			expect(fake.calls.slice(1)).toEqual([{ order: "desc", limit: 1 }]);
		});
	});

	describe("live observation", () => {
		it("appends a live row once, and rolls a saturated window without renumbering", async () => {
			const fake = fakeSource(gappedRows(LIMIT - 1));
			const { usageService, connection } = await connect(fake.source);
			expect(observation(usageService).hasEarlierRows).toBe(false);

			await fake.commit(fakeRow(3 * LIMIT));
			await expect.poll(() => observation(usageService).rows.length).toBe(LIMIT);
			expect(observation(usageService).hasEarlierRows).toBe(false);
			expect(sequences(observation(usageService).rows).filter((sequence) => sequence === 3 * LIMIT)).toHaveLength(1);

			const updatesBefore = connection.wire.updates.length;
			await fake.commit(fakeRow(3 * LIMIT + 7));
			await expect.poll(() => observation(usageService).rows.at(-1)?.sequence).toBe(3 * LIMIT + 7);
			const rolled = observation(usageService);
			expect(rolled.rows).toHaveLength(LIMIT);
			expect(rolled.hasEarlierRows).toBe(true);
			expect(rolled.rows[0]?.sequence).toBe(6);
			expect(sequences(rolled.rows)).toEqual([
				...gappedRows(LIMIT)
					.slice(1)
					.map(({ seq }) => seq),
				3 * LIMIT + 7,
			]);

			// The rollover replicates the dropped and appended rows, never the retained window.
			const rollover = connection.wire.updates.slice(updatesBefore);
			const rolloverBytes = rollover.reduce<number>((total, update) => total + encodeCbor(update).byteLength, 0);
			const windowBytes = encodeCbor(rolled).byteLength;
			expect(rolloverBytes).toBeLessThan(1_024);
			expect(rolloverBytes * 100).toBeLessThan(windowBytes);
		});

		it("hydrates a saturated window far below Pi's frame limit", async () => {
			const fake = fakeSource(gappedRows(4 * LIMIT));
			const { connection } = await connect(fake.source);
			const snapshot = encodeCbor(connection.wire.snapshots[0]).byteLength;
			// A representative saturated window is a few hundred KiB, far under the 16 MiB default frame.
			expect(snapshot).toBeLessThan(DEFAULT_MAX_FRAME_LENGTH / 16);
			expect(snapshot).toBeGreaterThan(LIMIT * 100);
		});

		it("preserves adjustments, negative and zero values, optional fields and entry IDs exactly", async () => {
			const fake = fakeSource();
			const { usageService } = await connect(fake.source);
			const negative = fakeRow(5, {
				adjustment: true,
				entryId: undefined,
				usage: usage(-9, 0, -1, 0, -20, [-1, 0, -4, 0, -15]),
			});
			delete negative.entryId;
			const tiny = fakeRow(9, { usage: usage(1e-21, -1e-21, 0, 0, 0, [0, 0, 0, 0, 1e-21]) });
			await fake.commit(negative);
			await fake.commit(tiny);
			await expect.poll(() => observation(usageService).rows.length).toBe(2);
			const [first, second] = observation(usageService).rows;
			expect(first).toEqual({
				id: negative.id,
				sequence: 5,
				adjustment: true,
				usage: { ...negative.usage },
			});
			expect(first).not.toHaveProperty("entryId");
			expect(first?.usage).not.toHaveProperty("reasoning");
			expect(first?.usage).not.toHaveProperty("cacheWrite1h");
			expect(second?.usage).toEqual(tiny.usage);
			expect(second?.adjustment).toBe(false);
			// The entry association is copied as an identifier only.
			expect(second?.entryId).toBe(tiny.entryId);
			expect(Object.keys(second ?? {}).sort()).toEqual(["adjustment", "entryId", "id", "sequence", "usage"]);
			expect(JSON.stringify(observation(usageService))).not.toMatch(SENTINEL_PATTERN);
		});

		it("keeps delivering when an in-process state subscriber throws", async () => {
			const fake = fakeSource();
			let throwOnce = true;
			const reader = defineFacet({
				id: "@test/throwing-usage-reader",
				setup(env) {
					const usageService = env.use(EndophasiaUsageV0);
					env.onActivate(() => {
						usageService.state.subscribe((_value, _context, delivery) => {
							if (delivery.kind === "update" && throwOnce) {
								throwOnce = false;
								throw new Error("subscriber exploded");
							}
						});
					});
				},
			});
			const { usageService } = await connect(fake.source, [reader]);
			await fake.commit(fakeRow(3));
			await fake.commit(fakeRow(6));
			await expect.poll(() => sequences(observation(usageService).rows)).toEqual([3, 6]);
			expect(throwOnce).toBe(false);
		});
	});

	describe("seed to feed handoff", () => {
		it("delivers a row committed after the seed read, before the feed subscribes, exactly once", async () => {
			const { harness, session, lane } = await fixture();
			await record(lane, A);
			const { source, calls } = hooked(harness, session, {
				after: async (call) => {
					if (call === 0) await record(lane, B);
				},
			});
			const { usageService } = await connect(source);
			expect(calls[0]).toEqual({ order: "desc", limit: LIMIT + 1 });
			const durable = await ledger(session);
			expect(durable).toHaveLength(2);
			expect(observation(usageService).rows).toEqual(durable);
		});

		it("delivers rows committed around the feed's high-water read exactly once, then later rows in order", async () => {
			const { harness, session, lane } = await fixture();
			await record(lane, A);
			const { source, calls } = hooked(harness, session, {
				// Call 1 is the feed's high-water read, made after it subscribed to usage events.
				before: async (call) => {
					if (call === 1) await record(lane, B);
				},
				after: async (call) => {
					if (call === 1) await record(lane, C);
				},
			});
			const { usageService } = await connect(source);
			expect(calls[1]).toEqual({ order: "desc", limit: 1 });
			await record(lane, A);
			const durable = await ledger(session);
			expect(durable).toHaveLength(4);
			await expect.poll(() => observation(usageService).rows.length).toBe(4);
			const observed = observation(usageService).rows;
			expect(observed).toEqual(durable);
			expect(new Set(sequences(observed)).size).toBe(4);
			expect(sequences(observed)).toEqual([...sequences(observed)].sort((left, right) => left - right));
		});
	});

	describe("page()", () => {
		it("returns durable pages exactly as readUsageLedgerV0, beyond the replicated window", async () => {
			const fake = fakeSource(gappedRows(LIMIT + 10));
			const { usageService } = await connect(fake.source);
			const first = await usageService.page({ limit: 5 }, BACKGROUND_CONTEXT);
			expect(first).toEqual(await readUsageLedgerV0(fake.source.session, { limit: 5 }, BACKGROUND_CONTEXT));
			expect(sequences(first.rows)).toEqual([3, 6, 9, 12, 15]);
			expect(sequences(observation(usageService).rows)).not.toContain(3);
			const next = await usageService.page({ afterSequence: first.nextAfterSequence, limit: 2 }, BACKGROUND_CONTEXT);
			expect(sequences(next.rows)).toEqual([18, 21]);
			expect(await usageService.page({}, BACKGROUND_CONTEXT)).toEqual(
				await readUsageLedgerV0(fake.source.session, undefined, BACKGROUND_CONTEXT),
			);
			expect(JSON.stringify(first)).not.toMatch(SENTINEL_PATTERN);
		});

		it("reads with each host call's own Context", async () => {
			const fake = fakeSource(gappedRows(3));
			const { usageService, connection } = await connect(fake.source);
			const before = fake.contexts.length;
			await usageService.page({}, BACKGROUND_CONTEXT);
			await usageService.page({ afterSequence: 3 }, BACKGROUND_CONTEXT);
			const pageContexts = fake.contexts.slice(before);
			expect(pageContexts).toHaveLength(2);
			for (const context of pageContexts) expect(connection.hostContexts).toContain(context);
			expect(pageContexts[0]?.value(HOST_REQUEST)).not.toBe(pageContexts[1]?.value(HOST_REQUEST));
		});

		it("rejects malformed remote queries without coercion or a default read", async () => {
			const fake = fakeSource(gappedRows(3));
			const { usageService } = await connect(fake.source);
			const before = fake.calls.length;
			const untyped = usageService.page as (query: unknown, context: Context) => Promise<unknown>;
			for (const query of [null, 5, "afterSequence", [], [1], true]) {
				await expect(untyped(query, BACKGROUND_CONTEXT), JSON.stringify(query)).rejects.toThrow(
					"Usage ledger query must be a plain object",
				);
			}
			await expect(untyped({ afterSequence: "1" }, BACKGROUND_CONTEXT)).rejects.toThrow("cursor must be a number");
			await expect(untyped({ limit: true }, BACKGROUND_CONTEXT)).rejects.toThrow("limit must be a number");
			await expect(untyped({ offset: 1 }, BACKGROUND_CONTEXT)).rejects.toThrow("Unknown usage ledger query field");
			expect(fake.calls.length).toBe(before);
			for (const query of [{ afterSequence: -1 }, { afterSequence: 1.5 }, { limit: 0 }, { limit: 10_001 }]) {
				// readUsageLedgerV0's own range checks; the RangeError crosses the wire as its message.
				await expect(untyped(query, BACKGROUND_CONTEXT), JSON.stringify(query)).rejects.toThrow(
					/Invalid usage ledger (cursor|limit)/,
				);
			}
			expect(fake.calls.length).toBe(before);
		});
	});

	it("carries no payload through feed, state or page: only payload-minimal durable rows", async () => {
		const { harness, session, lane, faux, reported } = await fixture();
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
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "error-message-sentinel" }),
			fauxAssistantMessage("summary-sentinel"),
		]);
		reported.push(A, B, C, A);
		const direct: UsageLedgerRowV0[] = [];
		const feed = await attachUsageFeedV0(
			{ events: harness.events, session },
			undefined,
			(row) => void direct.push(row),
			BACKGROUND_CONTEXT,
		);
		const { usageService } = await connect({ events: harness.events, session });
		await lane.prompt("prompt-sentinel", undefined, BACKGROUND_CONTEXT);
		await lane.prompt("prompt-sentinel", undefined, BACKGROUND_CONTEXT);
		const compaction = await lane.compact(undefined, BACKGROUND_CONTEXT);
		if (!compaction.ok) throw compaction.error;
		await record(lane, C, { note: "details-sentinel" });
		const durable = await ledger(session);
		expect(durable.length).toBeGreaterThanOrEqual(5);
		// Pi's own rows do carry private detail; none of it crosses.
		const raw = await session.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(JSON.stringify(raw)).toContain("details-sentinel");
		await expect.poll(() => observation(usageService).rows.length).toBe(durable.length);
		expect(observation(usageService).rows).toEqual(durable);
		expect(direct).toEqual(durable);
		const page = await usageService.page({}, BACKGROUND_CONTEXT);
		expect(page.rows).toEqual(durable);
		expect(durable.some((row) => row.usage.reasoning === 2)).toBe(true);
		for (const value of [durable, direct, observation(usageService), page]) {
			expect(JSON.stringify(value)).not.toMatch(SENTINEL_PATTERN);
			expect(isJsonValue(value)).toBe(true);
		}
		for (const row of observation(usageService).rows) {
			expect(
				Object.keys(row).every((key) => ["id", "sequence", "adjustment", "entryId", "usage"].includes(key)),
			).toBe(true);
		}
		feed.unsubscribe();
	});

	describe("lifecycle", () => {
		it("fails activation instead of presenting an empty ledger when seeding cannot read", async () => {
			const fake = fakeSource();
			const failing = {
				events: fake.source.events,
				session: {
					scanUsage: async () => {
						throw new Error("usage ledger unavailable");
					},
				},
			};
			await expect(createFacetHost({ facets: [createEndophasiaUsageFacetV0(failing)] })).rejects.toThrow(
				"usage ledger unavailable",
			);
			expect(fake.listenerCount()).toBe(0);
		});

		it("fails activation when the feed cannot attach, leaving no usage listener behind", async () => {
			const fake = fakeSource(gappedRows(2));
			let calls = 0;
			const failing = {
				events: fake.source.events,
				session: {
					scanUsage: async (query: UsageScan, context: Context) => {
						if (++calls === 2) throw new Error("high-water read failed");
						return fake.source.session.scanUsage(query, context);
					},
				},
			};
			await expect(createFacetHost({ facets: [createEndophasiaUsageFacetV0(failing)] })).rejects.toThrow(
				"high-water read failed",
			);
			expect(fake.listenerCount()).toBe(0);
		});

		it("holds one usage listener while active and removes it on disposal", async () => {
			const fake = fakeSource(gappedRows(2));
			const { usageService, host } = await connect(fake.source);
			expect(fake.listenerCount()).toBe(1);
			expect(sequences(observation(usageService).rows)).toEqual([3, 6]);
			await host.dispose();
			expect(fake.listenerCount()).toBe(0);
			// A later commit reaches no disposed feed.
			await expect(fake.commit(fakeRow(9))).resolves.toBeUndefined();
		});

		it("uses only events.on and scanUsage", async () => {
			const fake = fakeSource(gappedRows(2));
			const guard = <T extends object>(target: T, allowed: string): T =>
				new Proxy(target, {
					get(object, property, receiver) {
						if (property !== allowed) throw new Error(`Unexpected access: ${String(property)}`);
						return Reflect.get(object, property, receiver);
					},
				});
			const { usageService } = await connect({
				events: guard(fake.source.events, "on"),
				session: guard(fake.source.session, "scanUsage"),
			});
			await fake.commit(fakeRow(9));
			await expect.poll(() => sequences(observation(usageService).rows)).toEqual([3, 6, 9]);
			expect((await usageService.page({}, BACKGROUND_CONTEXT)).rows).toHaveLength(3);
		});
	});
});
