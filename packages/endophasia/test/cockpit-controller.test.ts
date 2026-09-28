import type { ReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	ServerConnectionState,
	SessionAttachmentState,
} from "@earendil-works/pi-coding-agent/experimental/services/connection";
import type { ModelsState } from "@earendil-works/pi-coding-agent/experimental/services/models";
import type { SessionDirectoryState } from "@earendil-works/pi-coding-agent/experimental/services/sessions";
import type { TranscriptState } from "@earendil-works/pi-coding-agent/experimental/services/transcript";
import { describe, expect, it } from "vitest";
import { CockpitController, type CockpitPresentation, type CockpitRegion } from "../cockpit/controller.ts";
import { projectAttachment, projectSessions } from "../cockpit/view-model.ts";
import type { MissionTraceEventV0, MissionTraceObservationV0 } from "../src/index.ts";
import type { SessionOverviewV0 } from "../src/session-overview.ts";

type Listener<T> = Parameters<ReplicatedState<T>["subscribe"]>[0];

class FakeState<T> implements ReplicatedState<T> {
	value: T | undefined;
	readonly listeners = new Set<Listener<T>>();
	private sequence = 0;

	constructor(value?: T) {
		this.value = value;
	}

	subscribe(listener: Listener<T>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	set(value: T): void {
		this.value = value;
		const delivery = { kind: "update" as const, sequence: ++this.sequence };
		for (const listener of this.listeners) listener(value, BACKGROUND_CONTEXT, delivery);
	}
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function overview(tipId: string): SessionOverviewV0 {
	return {
		schemaVersion: "session-overview.v0",
		consistency: "per-lane",
		lanes: [{ name: "main", tipId, operation: null }],
		counts: { lanes: 1, activeOperations: 0, abortingOperations: 0 },
	};
}

function fixture() {
	const connection = new FakeState<ServerConnectionState>({ status: "connected", since: "2026-01-01T00:00:00.000Z" });
	const attachment = new FakeState<SessionAttachmentState>({ status: "detached" });
	const sessions = new FakeState<SessionDirectoryState>();
	const transcript = new FakeState<TranscriptState>();
	const models = new FakeState<ModelsState>();
	const missionTrace = new FakeState<MissionTraceObservationV0>();
	const attachCalls: string[] = [];
	const attaches: Deferred<void>[] = [];
	const overviews: Deferred<SessionOverviewV0>[] = [];
	const presentation: CockpitPresentation = {
		connection,
		attachment,
		sessions,
		transcript,
		models,
		missionTrace,
		attach(sessionId) {
			attachCalls.push(sessionId);
			const next = deferred<void>();
			attaches.push(next);
			return next.promise;
		},
		async detach() {
			attachment.set({ status: "detached" });
		},
		sessionOverview() {
			const next = deferred<SessionOverviewV0>();
			overviews.push(next);
			return next.promise;
		},
	};
	const scheduled: (() => void)[] = [];
	const renders: Set<CockpitRegion>[] = [];
	const controller = new CockpitController({
		presentation,
		render: (regions) => renders.push(new Set(regions)),
		schedule: (callback) => scheduled.push(callback),
		now: () => 1_000,
		context: BACKGROUND_CONTEXT,
	});
	const flush = (): void => {
		for (const callback of scheduled.splice(0)) callback();
	};
	/** Complete the attach() for sessionId the way Pi does: state first, then the call resolves. */
	const completeAttach = async (index: number, sessionId: string): Promise<void> => {
		attachment.set({ status: "attached", sessionId });
		attaches[index]!.resolve();
		await settle();
	};
	return {
		connection,
		attachment,
		sessions,
		transcript,
		models,
		missionTrace,
		attachCalls,
		attaches,
		overviews,
		controller,
		scheduled,
		renders,
		flush,
		completeAttach,
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("Standard Cockpit controller", () => {
	it("coalesces a burst of replicated-state updates into one render", () => {
		const { controller, connection, models, transcript, scheduled, renders, flush } = fixture();
		flush();
		expect(renders).toHaveLength(1);

		connection.set({ status: "connecting", attempt: 1 });
		transcript.set({ snapshot: null, event: null });
		transcript.set({ snapshot: null, event: null });
		models.set({
			catalog: { revision: 1, availableModels: [] },
			configuration: { model: null, thinkingLevel: "off" },
			refresh: { status: "idle" },
		});
		expect(scheduled).toHaveLength(1);
		flush();
		expect(renders).toHaveLength(2);
		expect([...renders[1]!].sort()).toEqual(["inspector", "status", "transcript"]);
		controller.dispose();
	});

	it("unsubscribes every state listener on dispose and renders nothing afterwards", () => {
		const { controller, connection, attachment, sessions, transcript, models, scheduled, renders, flush } = fixture();
		flush();
		controller.dispose();
		controller.dispose();
		for (const state of [connection, attachment, sessions, transcript, models]) expect(state.listeners.size).toBe(0);
		connection.set({ status: "connecting", attempt: 1 });
		expect(scheduled).toHaveLength(0);
		expect(renders).toHaveLength(1);
	});

	it("serializes attach requests and keeps only the latest queued selection", async () => {
		const { controller, attachCalls, completeAttach } = fixture();
		controller.select("a");
		controller.select("b");
		controller.select("c");
		expect(attachCalls).toEqual(["a"]);
		expect(controller.pendingSelection).toBe("a");

		await completeAttach(0, "a");
		expect(attachCalls).toEqual(["a", "c"]);
		expect(controller.pendingSelection).toBe("c");
		await completeAttach(1, "c");
		expect(controller.pendingSelection).toBeUndefined();

		// Selecting the attached Session is a no-op.
		controller.select("c");
		expect(attachCalls).toEqual(["a", "c"]);
		controller.dispose();
	});

	it("shows Pi's attachment as authoritative while local intent is pending", async () => {
		const { controller, attachment, attaches } = fixture();
		attachment.set({ status: "attached", sessionId: "old" });
		controller.select("new");
		const directory: SessionDirectoryState = {
			revision: 1,
			sessions: [
				{ serverId: "s", sessionId: "old", createdAt: 1 },
				{ serverId: "s", sessionId: "new", createdAt: 2 },
			],
		};
		expect(projectSessions(directory, attachment.value, controller.pendingSelection)).toMatchObject([
			{ sessionId: "new", state: "requested" },
			{ sessionId: "old", state: "attached" },
		]);

		// A failed attach leaves Pi's state in charge and reports a presentation diagnostic.
		attachment.set({ status: "degraded", sessionId: "new" });
		attaches[0]!.reject(new Error("rebind failed"));
		await settle();
		expect(controller.pendingSelection).toBeUndefined();
		expect(controller.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["rebind failed"]);
		expect(projectSessions(directory, attachment.value, controller.pendingSelection)[0]).toMatchObject({
			state: "degraded",
		});
		controller.dispose();
	});

	it("captures an overview after attaching and clears it when the observed Session changes", async () => {
		const { controller, attachment, overviews, completeAttach } = fixture();
		controller.select("a");
		await completeAttach(0, "a");
		expect(controller.overview).toEqual({ status: "capturing", sessionId: "a" });
		overviews[0]!.resolve(overview("tip-a"));
		await settle();
		expect(controller.overview).toMatchObject({ status: "captured", sessionId: "a", capturedAt: 1_000 });

		attachment.set({ status: "attaching", sessionId: "b" });
		expect(controller.overview).toEqual({ status: "none" });
		controller.dispose();
	});

	it("never shows a late overview for Session A under Session B", async () => {
		const { controller, attachment, overviews } = fixture();
		attachment.set({ status: "attached", sessionId: "a" });
		const lateA = controller.refreshOverview();
		attachment.set({ status: "attached", sessionId: "b" });
		const currentB = controller.refreshOverview();

		overviews[1]!.resolve(overview("tip-b"));
		await currentB;
		overviews[0]!.resolve(overview("tip-a"));
		await lateA;
		expect(controller.overview).toMatchObject({ status: "captured", sessionId: "b" });
		expect(controller.overview.status === "captured" && controller.overview.overview.lanes[0]!.tipId).toBe("tip-b");

		// A late result is also dropped when no newer capture replaced it.
		const lateB = controller.refreshOverview();
		attachment.set({ status: "detached" });
		overviews[2]!.resolve(overview("tip-b-late"));
		await lateB;
		expect(controller.overview).toEqual({ status: "none" });
		controller.dispose();
	});

	it("keeps an overview failure local to the overview panel", async () => {
		const { controller, attachment, overviews } = fixture();
		attachment.set({ status: "attached", sessionId: "a" });
		const capture = controller.refreshOverview();
		overviews[0]!.reject(new Error("worker busy"));
		await capture;
		expect(controller.overview).toEqual({ status: "failed", sessionId: "a", message: "worker busy" });
		expect(attachment.value).toEqual({ status: "attached", sessionId: "a" });
		expect(controller.diagnostics).toEqual([]);
		controller.dispose();
	});

	it("detaches a degraded attachment without treating it as attached", async () => {
		const { controller, attachment, attaches, renders, flush } = fixture();
		expect(controller.canDetach).toBe(false);
		attachment.set({ status: "attaching", sessionId: "a" });
		expect(controller.canDetach).toBe(false);

		// Session services failed to hydrate: Pi still holds the attachment, so it can and must be released.
		attachment.set({ status: "degraded", sessionId: "a" });
		expect(controller.canDetach).toBe(true);
		expect(projectAttachment(attachment.value)).toMatchObject({ tone: "warn", glyph: "△", label: "Degraded" });
		// Overview capture stays reserved for an attached Session.
		await controller.refreshOverview();
		expect(controller.overview).toEqual({ status: "none" });

		// A pending selection blocks Detach until Pi settles it.
		controller.select("b");
		expect(controller.canDetach).toBe(false);
		await controller.detach();
		expect(attachment.value).toEqual({ status: "degraded", sessionId: "a" });
		flush();
		renders.length = 0;
		attaches[0]!.reject(new Error("still degraded"));
		await settle();
		flush();
		// Pi's state did not change, so only the settled request re-enables Detach, and it must redraw the inspector.
		expect(renders.some((regions) => regions.has("inspector"))).toBe(true);

		expect(controller.canDetach).toBe(true);
		await controller.detach();
		expect(attachment.value).toEqual({ status: "detached" });
		expect(controller.canDetach).toBe(false);
		controller.dispose();
		attachment.set({ status: "degraded", sessionId: "a" });
		expect(controller.canDetach).toBe(false);
	});

	it("contains render failures and bounds diagnostics without breaking the lifecycle", () => {
		const { connection, attachment, sessions, transcript, models, missionTrace } = fixture();
		const scheduled: (() => void)[] = [];
		let calls = 0;
		const controller = new CockpitController({
			presentation: {
				connection,
				attachment,
				sessions,
				transcript,
				models,
				missionTrace,
				attach: async () => {},
				detach: async () => {},
				sessionOverview: async () => overview("x"),
			},
			render: () => {
				calls++;
				if (calls === 1) throw new Error("render exploded");
			},
			schedule: (callback) => scheduled.push(callback),
		});
		for (const callback of scheduled.splice(0)) callback();
		expect(controller.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["render exploded"]);
		// The diagnostic itself schedules the next render, which succeeds.
		for (const callback of scheduled.splice(0)) callback();
		expect(calls).toBe(2);

		for (let i = 0; i < 10; i++) controller.report(new Error(`e${i}`));
		expect(controller.diagnostics).toHaveLength(5);
		expect(controller.diagnostics[0]!.message).toBe("e9");
		controller.report("x".repeat(2_000));
		expect(controller.diagnostics[0]!.message.length).toBeLessThanOrEqual(501);
		controller.dispose();
		expect(() => controller.report(new Error("after dispose"))).not.toThrow();
	});

	describe("Mission Trace", () => {
		const event = (sequence: number, runId: string): MissionTraceEventV0 => ({
			schemaVersion: "mission-trace.v0",
			sequence,
			kind: "mission.started",
			lane: "main",
			runId,
		});
		const observation = (...events: MissionTraceEventV0[]): MissionTraceObservationV0 => ({
			schemaVersion: "mission-trace-observation.v0",
			scope: "session-worker-lifetime",
			events,
		});

		it("renders only the trace region for a Mission Trace update", () => {
			const { controller, missionTrace, renders, flush } = fixture();
			flush();
			renders.length = 0;
			missionTrace.set(observation(event(1, "a")));
			missionTrace.set(observation(event(1, "a"), event(2, "a")));
			flush();
			expect(renders.map((regions) => [...regions])).toEqual([["trace"]]);
			controller.dispose();
			expect(missionTrace.listeners.size).toBe(0);
		});

		it("never presents Session A's trace while Session B is being selected or attached", async () => {
			const { controller, attachment, missionTrace, completeAttach, attaches } = fixture();
			controller.select("a");
			await completeAttach(0, "a");
			missionTrace.set(observation(event(1, "run-of-a")));
			expect(controller.missionTrace).toMatchObject({ status: "visible", sessionId: "a" });

			// Select B: Pi still reports A attached and the replicated value is still A's trace.
			controller.select("b");
			expect(attachment.value).toEqual({ status: "attached", sessionId: "a" });
			expect(missionTrace.value?.events[0]?.runId).toBe("run-of-a");
			expect(controller.missionTrace).toEqual({ status: "hidden", reason: "switching" });

			// Pi moves to attaching B while A's trace lingers.
			attachment.set({ status: "attaching", sessionId: "b" });
			expect(controller.missionTrace).toEqual({ status: "hidden", reason: "switching" });

			// B attaches and hydrates its own trace; only then is a trace shown, and it is B's.
			missionTrace.set(observation(event(1, "run-of-b")));
			attachment.set({ status: "attached", sessionId: "b" });
			attaches[1]!.resolve();
			await settle();
			const visible = controller.missionTrace;
			expect(visible).toMatchObject({ status: "visible", sessionId: "b" });
			expect(visible.status === "visible" && visible.observation.events[0]?.runId).toBe("run-of-b");
			controller.dispose();
		});

		it("hides a lingering trace for attaching, degraded, detached and unhydrated states", () => {
			const { controller, attachment, missionTrace } = fixture();
			missionTrace.set(observation(event(1, "stale")));
			expect(controller.missionTrace).toEqual({ status: "hidden", reason: "detached" });
			attachment.set({ status: "attaching", sessionId: "x" });
			expect(controller.missionTrace).toEqual({ status: "hidden", reason: "attaching" });
			attachment.set({ status: "degraded", sessionId: "x" });
			expect(controller.missionTrace).toEqual({ status: "hidden", reason: "degraded" });
			attachment.set({ status: "detached" });
			expect(controller.missionTrace).toEqual({ status: "hidden", reason: "detached" });

			const unhydrated = fixture();
			unhydrated.attachment.set({ status: "attached", sessionId: "y" });
			expect(unhydrated.controller.missionTrace).toEqual({ status: "hidden", reason: "hydrating" });
			// A real trace with zero events is shown as such, not confused with an absent service.
			unhydrated.missionTrace.set(observation());
			expect(unhydrated.controller.missionTrace).toMatchObject({
				status: "visible",
				observation: { events: [] },
			});
			controller.dispose();
			unhydrated.controller.dispose();
		});
	});
});
