// Pi-specific: projects Pi harness lifecycle events onto the runtime-neutral Mission Trace v0 schema.
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { MissionTraceEventV0 } from "./mission-trace-service.ts";

// The schema is the runtime-neutral contract's; re-exported for the modules that already import it from here.
export type { MissionTraceEventV0 };

type TraceInputV0 = MissionTraceEventV0 extends infer Event
	? Event extends MissionTraceEventV0
		? Omit<Event, "schemaVersion" | "sequence">
		: never
	: never;

export interface MissionTraceAttachmentV0 {
	/** Copies of the recorded events after the cursor: 0 starts with sequence 1, 5 with sequence 6. */
	sinceSequence(from: number): MissionTraceEventV0[];
	/**
	 * Replay the recorded events after the cursor (as sinceSequence) synchronously, then deliver each later event in
	 * sequence order, with no gap between the two. Each listener receives its own copy. The returned function stops
	 * delivery and may be called repeatedly.
	 *
	 * Replay runs inside subscribe(): if the listener throws during replay, the exception propagates from subscribe()
	 * and no subscription is installed; the recorded trace is unchanged. After the subscription is installed, a
	 * listener that throws during live delivery does not affect the recorded trace or other listeners; the harness
	 * event bus's existing isolation reports the failure as a handler_error.
	 */
	subscribe(from: number, listener: (event: MissionTraceEventV0) => void): () => void;
	detach(): void;
}

/**
 * Stream Mission Trace v0 events to one listener as they are observed, numbered from sequence 1, without retaining any
 * of them. Only the selected public harness lifecycle events are observed. The returned function stops observing and
 * may be called repeatedly. A listener that throws is reported by the harness event bus's existing isolation as a
 * handler_error; later events are still numbered and delivered.
 */
export function observeMissionTraceV0(
	harness: Pick<AgentHarness, "events">,
	listener: (event: MissionTraceEventV0) => void,
): () => void {
	let sequence = 0;
	let active = true;
	const unsubscribe = [
		harness.events.on("run_start", ({ lane, runId }) => emit({ kind: "mission.started", lane, runId })),
		harness.events.on("run_resume", ({ lane, runId }) => emit({ kind: "mission.resumed", lane, runId })),
		harness.events.on("run_suspend", ({ lane, runId }) => emit({ kind: "mission.suspended", lane, runId })),
		harness.events.on("turn_start", ({ lane, runId, turnId }) => emit({ kind: "turn.started", lane, runId, turnId })),
		harness.events.on("message_end", ({ lane, runId, message }) => {
			if (message.role === "assistant" && runId !== undefined) {
				emit({ kind: "model.completed", lane, runId });
			}
		}),
		harness.events.on("tool_start", ({ lane, runId, turnId, toolCallId, toolName }) =>
			emit({ kind: "tool.started", lane, runId, turnId, toolCallId, toolName }),
		),
		harness.events.on("tool_end", ({ lane, runId, turnId, toolCallId, toolName, isError }) =>
			emit({ kind: "tool.finished", lane, runId, turnId, toolCallId, toolName, isError }),
		),
		harness.events.on("turn_end", ({ lane, runId, turnId }) => emit({ kind: "turn.finished", lane, runId, turnId })),
		harness.events.on("run_end", ({ lane, runId, status }) => {
			const kind = {
				completed: "mission.completed",
				aborted: "mission.aborted",
				failed: "mission.failed",
			} as const;
			emit({ kind: kind[status], lane, runId });
		}),
	];

	function emit(event: TraceInputV0): void {
		if (!active) return;
		sequence += 1;
		listener({ ...event, schemaVersion: "mission-trace.v0", sequence } as MissionTraceEventV0);
	}

	return () => {
		if (!active) return;
		active = false;
		for (const remove of unsubscribe) remove();
	};
}

/** Observe only the selected public harness lifecycle events during this attachment's lifetime, recording each. */
export function attachMissionTraceV0(harness: Pick<AgentHarness, "events">): MissionTraceAttachmentV0 {
	const recorded: MissionTraceEventV0[] = [];
	const subscribers = new Set<(event: MissionTraceEventV0) => void>();
	let active = true;
	const stop = observeMissionTraceV0(harness, (recordedEvent) => {
		recorded.push(recordedEvent);
		// The event is recorded before any listener runs, so a failing listener cannot lose or reorder it.
		const failures: unknown[] = [];
		for (const deliver of [...subscribers]) {
			// A listener removed while this event is being delivered does not receive it.
			if (!subscribers.has(deliver)) continue;
			try {
				deliver(recordedEvent);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Mission Trace listeners failed");
	});

	return {
		sinceSequence(from) {
			assertCursor(from);
			return recorded.slice(from).map((event) => ({ ...event }));
		},
		subscribe(from, listener) {
			assertCursor(from);
			// Events at or before the cursor are never delivered, including ones recorded later.
			const deliver = (event: MissionTraceEventV0): void => {
				if (event.sequence > from) listener({ ...event });
			};
			// Replay and registration run in one synchronous step, so no event can fall between them. A detached trace
			// still replays what it recorded but delivers nothing further.
			for (const event of recorded.slice(from)) listener({ ...event });
			if (!active) return () => {};
			subscribers.add(deliver);
			return () => {
				subscribers.delete(deliver);
			};
		},
		detach() {
			if (!active) return;
			active = false;
			subscribers.clear();
			stop();
		},
	};
}

function assertCursor(from: number): void {
	if (!Number.isSafeInteger(from) || from < 0) throw new RangeError("Invalid Mission Trace cursor");
}
