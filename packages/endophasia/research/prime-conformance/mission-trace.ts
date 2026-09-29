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
	/**
	 * The subset of `unmapped` that is a known event outside its lifecycle (or a run that never ended). Unknown event
	 * types are forward compatibility; a misplaced known event means the evidence does not describe a coherent run.
	 */
	readonly misplaced: readonly string[];
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
	const misplaced: string[] = [];
	const misplace = (problem: string): void => {
		unmapped.push(problem);
		misplaced.push(problem);
	};
	const abortAfter = [...(input.abortRequestedAfter ?? [])];
	let sequence = 0;
	let runCount = 0;
	let run:
		| {
				id: string;
				turns: number;
				turnId: string | undefined;
				abortRequested: boolean;
				tools: Set<string>;
				turnToolIds: Set<string>;
		  }
		| undefined;
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
				run = {
					id: `${ADAPTER_ID_PREFIX}run-${runCount}`,
					turns: 0,
					turnId: undefined,
					abortRequested: false,
					tools: new Set(),
					turnToolIds: new Set(),
				};
				// Abort requests before this run belong to earlier runs.
				for (let i = abortAfter.length - 1; i >= 0; i--) if (abortAfter[i]! < index) abortAfter.splice(i, 1);
				push({ kind: "mission.started", lane, runId: run.id });
				continue;
			}
			case "turn_start": {
				if (run === undefined) {
					misplace(`turn_start outside a run at ${index}`);
					continue;
				}
				// A turn never nests: replacing the active turn would leave it unfinished.
				if (run.turnId !== undefined) {
					misplace(`turn_start inside an active turn at ${index}`);
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
					misplace(`assistant message_end outside a run at ${index}`);
					continue;
				}
				push({ kind: "model.completed", lane, runId: run.id });
				continue;
			}
			case "tool_execution_start": {
				if (run?.turnId === undefined) {
					misplace(`${item.type} outside a turn at ${index}`);
					continue;
				}
				const { toolCallId, toolName } = item;
				// One assistant-declared call executes once per turn: a reused id could hide a double execution.
				if (run.turnToolIds.has(toolCallId)) {
					misplace(`tool_execution_start repeated for a tool call id already used in this turn at ${index}`);
					continue;
				}
				run.tools.add(toolCallId);
				run.turnToolIds.add(toolCallId);
				push({ kind: "tool.started", lane, runId: run.id, turnId: run.turnId, toolCallId, toolName });
				continue;
			}
			case "tool_execution_end": {
				if (run?.turnId === undefined) {
					misplace(`${item.type} outside a turn at ${index}`);
					continue;
				}
				const { toolCallId, toolName, isError } = item;
				// A completion is mapped only for a call that started: an end alone would claim a lifecycle never seen.
				if (!run.tools.delete(toolCallId)) {
					misplace(`tool_execution_end without its tool_execution_start at ${index}`);
					continue;
				}
				push({ kind: "tool.finished", lane, runId: run.id, turnId: run.turnId, toolCallId, toolName, isError });
				continue;
			}
			case "turn_end": {
				if (run?.turnId === undefined) {
					misplace(`turn_end outside a turn at ${index}`);
					continue;
				}
				// Tool calls belong to their turn: one still open at turn_end could otherwise finish in a later turn.
				if (run.tools.size > 0) misplace(`turn_end with ${run.tools.size} tool call(s) still active at ${index}`);
				run.tools.clear();
				run.turnToolIds.clear();
				push({ kind: "turn.finished", lane, runId: run.id, turnId: run.turnId });
				// A finished turn accepts no more events: anything before the next turn_start is unmapped.
				run.turnId = undefined;
				continue;
			}
			case "agent_end": {
				if (run === undefined) {
					misplace(`agent_end outside a run at ${index}`);
					continue;
				}
				// A run ends after its turns: an active turn here would be a turn.started never finished.
				if (run.turnId !== undefined) misplace(`agent_end inside an active turn at ${index}`);
				const terminal = classifyTerminal(run.id, item.assistantStopReasons.at(-1), run.abortRequested);
				terminals.push(terminal);
				if (terminal.status !== undefined) push({ kind: `mission.${terminal.status}`, lane, runId: run.id });
				run = undefined;
				continue;
			}
			case "tool_execution_update": {
				// Not mapped to a trace event, but still part of the tool lifecycle: only for a call active in this turn.
				if (run?.turnId === undefined || !run.tools.has(item.toolCallId))
					misplace(`tool_execution_update outside its active tool call at ${index}`);
				continue;
			}
			case "unknown":
				unmapped.push(`unknown Prime event ${item.primeType}`);
				continue;
			default:
				continue;
		}
	}
	if (run !== undefined) misplace(`run ${run.id} had no agent_end`);
	return { events, terminals, unmapped, misplaced };
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
