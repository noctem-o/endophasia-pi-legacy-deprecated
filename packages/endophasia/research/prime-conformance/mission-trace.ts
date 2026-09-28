// Research-only (Prime Runtime Conformance v0). An experimental mapping from sanitized Prime RPC evidence to candidate
// MissionTraceEventV0 records. It is not the Endophasia Mission Trace and must not be wired into any runtime path.
import type { MissionTraceEventV0 } from "../../src/mission-trace.ts";
import type { PrimeEvidenceEventV0 } from "./protocol.ts";

/**
 * The lane written into candidate events. Prime's RPC stream belongs to one root AgentSession and names no lane, so
 * this is an adapter label, deliberately not Pi's "main": a Pi lane is a named, durable branch pointer inside one
 * Session, while a Prime root session is a whole session tree whose RLM children run as separate child sessions.
 */
export const PRIME_ROOT_LANE_LABEL = "prime:root";

/** Identities the adapter assigned; Prime's public events carry none of these. */
export const ADAPTER_ID_PREFIX = "adapter:";

/** A MissionTraceEventV0 before numbering, distributed over the union so each kind keeps its own fields. */
type TraceInputV0 = MissionTraceEventV0 extends infer Event
	? Event extends MissionTraceEventV0
		? Omit<Event, "schemaVersion" | "sequence">
		: never
	: never;

export type TerminalBasisV0 =
	/** The final assistant message's own stop reason established it. */
	| "native-stop-reason"
	/** The adapter itself requested the abort; Prime's final stop reason did not say "aborted". */
	| "adapter-abort-request"
	/** No terminal status can be established truthfully. */
	| "ambiguous";

export interface CandidateTerminalV0 {
	readonly runId: string;
	readonly status: "completed" | "aborted" | "failed" | undefined;
	readonly basis: TerminalBasisV0;
	/** The final assistant stop reason Prime reported, when there was one. */
	readonly finalStopReason?: string;
	readonly note?: string;
}

export interface MissionTraceMappingV0 {
	readonly events: readonly MissionTraceEventV0[];
	readonly terminals: readonly CandidateTerminalV0[];
	/** Prime evidence the mapping could not place without inventing facts. */
	readonly unmapped: readonly string[];
}

export interface MissionTraceMappingInputV0 {
	readonly evidence: readonly PrimeEvidenceEventV0[];
	/** Indexes into `evidence` after which the adapter sent an RPC abort, for runs it aborted itself. */
	readonly abortRequestedAfter?: readonly number[];
}

/**
 * Map one Prime root session's sanitized event stream. Run and turn identities are adapter-owned counters, valid only
 * for this observation: they are not Prime identifiers, do not survive a new process, and cannot be recovered after
 * reconnect because Prime's events carry nothing to rebuild them from.
 */
export function mapPrimeMissionTraceV0(input: MissionTraceMappingInputV0): MissionTraceMappingV0 {
	const events: MissionTraceEventV0[] = [];
	const terminals: CandidateTerminalV0[] = [];
	const unmapped: string[] = [];
	const abortAfter = [...(input.abortRequestedAfter ?? [])];
	let sequence = 0;
	let runCount = 0;
	let run: { id: string; turns: number; turnId?: string; abortRequested: boolean } | undefined;
	const lane = PRIME_ROOT_LANE_LABEL;
	const push = (event: TraceInputV0): void => {
		events.push({ ...event, schemaVersion: "mission-trace.v0", sequence: ++sequence } as MissionTraceEventV0);
	};

	for (const [index, item] of input.evidence.entries()) {
		if (run !== undefined && abortAfter.some((after) => after < index)) {
			run.abortRequested = true;
		}
		switch (item.type) {
			case "agent_start": {
				runCount += 1;
				run = { id: `${ADAPTER_ID_PREFIX}run-${runCount}`, turns: 0, abortRequested: false };
				// Abort requests before this run belong to earlier runs.
				for (let i = abortAfter.length - 1; i >= 0; i--) if (abortAfter[i]! < index) abortAfter.splice(i, 1);
				push({ kind: "mission.started", lane, runId: run.id });
				continue;
			}
			case "turn_start": {
				if (run === undefined) {
					unmapped.push(`turn_start outside a run at ${index}`);
					continue;
				}
				run.turns += 1;
				run.turnId = `${run.id}/turn-${run.turns}`;
				push({ kind: "turn.started", lane, runId: run.id, turnId: run.turnId });
				continue;
			}
			case "message_end": {
				if (item.role !== "assistant" || item.assistant === undefined) continue;
				if (run === undefined) {
					unmapped.push(`assistant message_end outside a run at ${index}`);
					continue;
				}
				push({ kind: "model.completed", lane, runId: run.id });
				continue;
			}
			case "tool_execution_start": {
				if (run?.turnId === undefined) {
					unmapped.push(`${item.type} outside a turn at ${index}`);
					continue;
				}
				const { toolCallId, toolName } = item;
				push({ kind: "tool.started", lane, runId: run.id, turnId: run.turnId, toolCallId, toolName });
				continue;
			}
			case "tool_execution_end": {
				if (run?.turnId === undefined) {
					unmapped.push(`${item.type} outside a turn at ${index}`);
					continue;
				}
				const { toolCallId, toolName, isError } = item;
				push({ kind: "tool.finished", lane, runId: run.id, turnId: run.turnId, toolCallId, toolName, isError });
				continue;
			}
			case "turn_end": {
				if (run?.turnId === undefined) {
					unmapped.push(`turn_end outside a turn at ${index}`);
					continue;
				}
				push({ kind: "turn.finished", lane, runId: run.id, turnId: run.turnId });
				continue;
			}
			case "agent_end": {
				if (run === undefined) {
					unmapped.push(`agent_end outside a run at ${index}`);
					continue;
				}
				const terminal = classifyTerminal(run.id, item.assistantStopReasons.at(-1), run.abortRequested);
				terminals.push(terminal);
				if (terminal.status !== undefined) push({ kind: `mission.${terminal.status}`, lane, runId: run.id });
				run = undefined;
				continue;
			}
			case "unknown":
				unmapped.push(`unknown Prime event ${item.primeType}`);
				continue;
			default:
				continue;
		}
	}
	if (run !== undefined) unmapped.push(`run ${run.id} had no agent_end`);
	return { events, terminals, unmapped };
}

function classifyTerminal(
	runId: string,
	finalStopReason: string | undefined,
	abortRequested: boolean,
): CandidateTerminalV0 {
	const reason = finalStopReason === undefined ? {} : { finalStopReason };
	switch (finalStopReason) {
		case "stop":
			return abortRequested
				? {
						runId,
						status: undefined,
						basis: "ambiguous",
						...reason,
						note: "abort requested but the run ended with stop",
					}
				: { runId, status: "completed", basis: "native-stop-reason", ...reason };
		case "error":
			return { runId, status: "failed", basis: "native-stop-reason", ...reason };
		case "aborted":
			return { runId, status: "aborted", basis: "native-stop-reason", ...reason };
		case "length":
			return {
				runId,
				status: undefined,
				basis: "ambiguous",
				...reason,
				note: "output-length stop: the run ended without the model finishing",
			};
		default:
			// e.g. toolUse: the run ended between turns (an abort during tool execution, or a terminating tool).
			return abortRequested
				? { runId, status: "aborted", basis: "adapter-abort-request", ...reason }
				: { runId, status: undefined, basis: "ambiguous", ...reason, note: "run ended without a final answer" };
	}
}
