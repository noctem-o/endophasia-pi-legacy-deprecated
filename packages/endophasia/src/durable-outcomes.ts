// Pi-specific: projects Pi's immutable terminal result record onto the runtime-neutral OperationOutcomeV0 schema.
import type { AgentLane, Context } from "@earendil-works/pi-agent-core";
import type { OperationOutcomeV0 } from "./runtime-facts-service.ts";

/**
 * Read Pi's durable terminal result for an operation ID.
 * `null` means only that getResult returned no record at this read: the ID may be unknown or not yet terminal.
 * Failures from getResult (closed or faulted harness) propagate.
 */
export async function captureOperationOutcomeV0(
	lane: Pick<AgentLane, "getResult">,
	operationId: string,
	context: Context,
): Promise<OperationOutcomeV0 | null> {
	const result = await lane.getResult(operationId, context);
	if (result === undefined) return null;
	return {
		schemaVersion: "operation-outcome.v0",
		operationId: result.operationId,
		kind: result.kind,
		status: result.status,
		fromTipId: result.fromTipId,
		tipId: result.tipId,
		startedAt: result.startedAt,
		endedAt: result.endedAt,
		...(result.error === undefined ? {} : { errorCode: result.error.code }),
	};
}
