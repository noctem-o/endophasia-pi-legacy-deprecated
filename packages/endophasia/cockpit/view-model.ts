// Pure display projections for Standard Cockpit v0. Each function derives only what the cockpit renders from Pi's
// replicated state or an explicit capture: no network, no mutation of inputs, no retained copies.
// Transcript values are read defensively as unknown JSON, so newer entry or content kinds degrade to a neutral
// preview instead of breaking the cockpit.
import type {
	ServerConnectionState,
	SessionAttachmentState,
} from "@earendil-works/pi-coding-agent/experimental/services/connection";
import type { ModelsState } from "@earendil-works/pi-coding-agent/experimental/services/models";
import type { SessionDirectoryState } from "@earendil-works/pi-coding-agent/experimental/services/sessions";
import type { ContinuityEntryV0, ContinuitySnapshotV0 } from "../src/continuity-service.ts";
import type { RuntimeMetricsV0 } from "../src/runtime-facts-service.ts";
import type { EndophasiaRuntimeCapabilityIdV0 } from "../src/runtime-profile-service.ts";
import type { SessionOverviewV0 } from "../src/session-overview.ts";
import type { UsageLedgerRowV0, UsageObservationV0 } from "../src/usage-service.ts";

/** Upper bound for tool arguments, tool output and custom payload previews. */
export const PREVIEW_LIMIT = 2_000;
/** Upper bound for summaries and message text, which are the primary reading surface. */
export const TEXT_LIMIT = 20_000;

export type Tone = "live" | "pending" | "warn" | "idle";

/** A state label that never relies on colour alone: glyph plus words. */
export interface StatusView {
	readonly tone: Tone;
	readonly glyph: string;
	readonly label: string;
	readonly detail?: string;
}

export interface BoundedText {
	readonly text: string;
	readonly truncated: boolean;
	readonly totalLength: number;
}

export function boundText(text: string, limit = PREVIEW_LIMIT): BoundedText {
	if (text.length <= limit) return { text, truncated: false, totalLength: text.length };
	return { text: text.slice(0, limit), truncated: true, totalLength: text.length };
}

/** Bounded, display-only rendering of a structured value. Strings are shown as they are; others as JSON. */
export function formatStructuredPreview(value: unknown, limit = PREVIEW_LIMIT): BoundedText {
	if (typeof value === "string") return boundText(value, limit);
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = "Unserializable value";
	}
	return boundText(text, limit);
}

/** Local wall-clock time of a millisecond timestamp, for compact metadata. */
export function formatClock(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "unknown time";
	const date = new Date(timestamp);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatDate(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "unknown date";
	const date = new Date(timestamp);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(timestamp)}`;
}

export function formatModel(model: { readonly provider: string; readonly modelId: string } | null | undefined): string {
	return model ? `${model.provider}/${model.modelId}` : "none";
}

// ---------------------------------------------------------------------------------------------------------------
// Connection, attachment, models and Sessions

export function projectConnection(state: ServerConnectionState | undefined): StatusView {
	if (state === undefined) return { tone: "pending", glyph: "◌", label: "Starting" };
	switch (state.status) {
		case "connecting":
			return { tone: "pending", glyph: "◌", label: "Connecting", detail: `attempt ${state.attempt}` };
		case "connected":
			return {
				tone: "live",
				glyph: "●",
				label: "Connected",
				detail: `since ${formatClock(Date.parse(state.since))}`,
			};
		case "disconnected":
			// Pi's client does not reconnect by itself; neither does the cockpit.
			return { tone: "warn", glyph: "○", label: "Disconnected", detail: `${state.reason} · reload to reconnect` };
	}
}

export function projectAttachment(state: SessionAttachmentState | undefined): StatusView {
	if (state === undefined || state.status === "detached") return { tone: "idle", glyph: "○", label: "Detached" };
	switch (state.status) {
		case "attaching":
			return { tone: "pending", glyph: "◌", label: "Attaching", detail: state.sessionId };
		case "attached":
			return { tone: "live", glyph: "●", label: "Attached", detail: state.sessionId };
		case "degraded":
			return { tone: "warn", glyph: "△", label: "Degraded", detail: state.sessionId };
	}
}

export interface ModelConfigurationView {
	/** The configured model for new operations; an open operation may have captured a different one. */
	readonly configuredModel: string;
	readonly thinkingLevel: string;
	readonly availableModels: number;
	readonly refresh: string;
}

export function projectModels(state: ModelsState | undefined): ModelConfigurationView | undefined {
	if (state === undefined) return undefined;
	return {
		configuredModel: formatModel(state.configuration.model),
		thinkingLevel: state.configuration.thinkingLevel,
		availableModels: state.catalog.availableModels.length,
		refresh: state.refresh.status,
	};
}

export type SessionRowState = "attached" | "attaching" | "degraded" | "requested" | "available";

export interface SessionRowView {
	readonly sessionId: string;
	readonly created: string;
	/** Pi's attachment state wins; "requested" is only local intent while attach() is pending. */
	readonly state: SessionRowState;
}

export function projectSessions(
	directory: SessionDirectoryState | undefined,
	attachment: SessionAttachmentState | undefined,
	pendingSelection: string | undefined,
): SessionRowView[] {
	if (directory === undefined) return [];
	return [...directory.sessions]
		.sort((a, b) => b.createdAt - a.createdAt || (a.sessionId < b.sessionId ? -1 : 1))
		.map((session) => {
			let state: SessionRowState = "available";
			if (
				attachment !== undefined &&
				attachment.status !== "detached" &&
				attachment.sessionId === session.sessionId
			) {
				state = attachment.status;
			} else if (pendingSelection === session.sessionId) {
				state = "requested";
			}
			return { sessionId: session.sessionId, created: formatDate(session.createdAt), state };
		});
}

// ---------------------------------------------------------------------------------------------------------------
// Transcript entries

export type ContentBlockView =
	| { readonly kind: "text"; readonly text: BoundedText }
	/** Reasoning is shown only as an activity marker; its text is never projected. */
	| { readonly kind: "reasoning" }
	| { readonly kind: "tool-call"; readonly toolName: string; readonly args: BoundedText }
	| { readonly kind: "image"; readonly mimeType: string }
	| { readonly kind: "preview"; readonly label: string; readonly text: BoundedText }
	| { readonly kind: "error"; readonly text: BoundedText }
	/** A fact about the source itself, such as output the source already truncated. */
	| { readonly kind: "note"; readonly text: string }
	| { readonly kind: "unsupported"; readonly label: string };

export type EntryKind =
	| "user"
	| "assistant"
	| "tool-result"
	| "shell"
	| "system"
	| "custom-message"
	| "summary-message"
	| "compaction"
	| "branch-summary"
	| "custom"
	| "unsupported";

export interface EntryView {
	readonly id: string;
	readonly kind: EntryKind;
	readonly title: string;
	readonly meta: readonly string[];
	readonly blocks: readonly ContentBlockView[];
}

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: JsonRecord, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectContent(content: unknown): ContentBlockView[] {
	if (typeof content === "string") return [{ kind: "text", text: boundText(content, TEXT_LIMIT) }];
	if (!Array.isArray(content))
		return content === undefined ? [] : [{ kind: "unsupported", label: "Unsupported content" }];
	return content.map((block): ContentBlockView => {
		if (!isRecord(block)) return { kind: "unsupported", label: "Unsupported content" };
		switch (block.type) {
			case "text":
				return { kind: "text", text: boundText(stringField(block, "text") ?? "", TEXT_LIMIT) };
			case "thinking":
				return { kind: "reasoning" };
			case "toolCall":
				return {
					kind: "tool-call",
					toolName: stringField(block, "name") ?? "unknown tool",
					args: formatStructuredPreview(block.arguments),
				};
			case "image":
				return { kind: "image", mimeType: stringField(block, "mimeType") ?? "unknown type" };
			default:
				return { kind: "unsupported", label: `Unsupported content · ${String(block.type)}` };
		}
	});
}

/**
 * Project one message, durable or streaming, into a transcript card, or undefined when it is not for display. As in
 * Pi's interactive renderer, a custom message is shown only when it sets display: true; others carry context-only
 * extension material.
 */
export function projectMessage(id: string, message: unknown, timestamp?: number): EntryView | undefined {
	const meta = timestamp === undefined ? [] : [formatClock(timestamp)];
	if (!isRecord(message)) return { id, kind: "unsupported", title: "Unsupported message", meta, blocks: [] };
	switch (message.role) {
		case "user":
			return { id, kind: "user", title: "User", meta, blocks: projectContent(message.content) };
		case "assistant": {
			const model = stringField(message, "model");
			const stopReason = stringField(message, "stopReason");
			const blocks = projectContent(message.content);
			const errorMessage = stringField(message, "errorMessage");
			if (errorMessage !== undefined) blocks.push({ kind: "error", text: boundText(errorMessage) });
			return {
				id,
				kind: "assistant",
				title: "Assistant",
				meta: [...meta, ...(model === undefined ? [] : [model]), ...(stopReason === undefined ? [] : [stopReason])],
				blocks,
			};
		}
		case "toolResult": {
			const failed = message.isError === true;
			return {
				id,
				kind: "tool-result",
				title: `Tool result · ${stringField(message, "toolName") ?? "unknown tool"}`,
				meta: [...meta, failed ? "failed" : "completed"],
				blocks: projectContent(message.content).map((block) =>
					block.kind === "text" ? { kind: "preview", label: "Output", text: boundText(block.text.text) } : block,
				),
			};
		}
		case "bashExecution": {
			const exitCode = numberField(message, "exitCode");
			const fullOutputPath = stringField(message, "fullOutputPath");
			// Pi retains partial output for long commands; the card must not present it as complete.
			const sourceTruncated: ContentBlockView[] =
				message.truncated === true
					? [
							{
								kind: "note",
								text: `Output truncated at source${fullOutputPath === undefined ? "" : ` · full output: ${fullOutputPath}`}`,
							},
						]
					: [];
			return {
				id,
				kind: "shell",
				title: "Shell",
				meta: [
					...meta,
					exitCode === undefined ? "no exit code" : `exit ${exitCode}`,
					...(message.cancelled === true ? ["cancelled"] : []),
					...(message.truncated === true ? ["output truncated"] : []),
				],
				blocks: [
					{ kind: "preview", label: "Command", text: boundText(stringField(message, "command") ?? "") },
					{ kind: "preview", label: "Output", text: boundText(stringField(message, "output") ?? "") },
					...sourceTruncated,
				],
			};
		}
		case "system":
			return {
				id,
				kind: "system",
				title: "System message",
				meta,
				blocks: projectContent(message.content).map((block) =>
					block.kind === "text"
						? { kind: "preview", label: "Instructions", text: boundText(block.text.text) }
						: block,
				),
			};
		case "custom":
			if (message.display !== true) return undefined;
			return {
				id,
				kind: "custom-message",
				title: `Custom message · ${stringField(message, "customType") ?? "unknown"}`,
				meta,
				blocks: projectContent(message.content),
			};
		case "compactionSummary":
		case "branchSummary":
			return {
				id,
				kind: "summary-message",
				title: message.role === "compactionSummary" ? "Compaction summary message" : "Branch summary message",
				meta,
				blocks: [{ kind: "text", text: boundText(stringField(message, "summary") ?? "", TEXT_LIMIT) }],
			};
		default:
			return { id, kind: "unsupported", title: `Unsupported message · ${String(message.role)}`, meta, blocks: [] };
	}
}

/** Project one durable main-lane transcript entry, or undefined when it is not for display. */
export function projectTranscriptEntry(entry: unknown): EntryView | undefined {
	if (!isRecord(entry))
		return { id: "unknown", kind: "unsupported", title: "Unsupported entry", meta: [], blocks: [] };
	const id = stringField(entry, "id") ?? "unknown";
	const timestamp = numberField(entry, "timestamp");
	const time = timestamp === undefined ? [] : [formatClock(timestamp)];
	switch (entry.type) {
		case "message":
			return projectMessage(id, entry.message, timestamp);
		case "compaction": {
			const tokensBefore = numberField(entry, "tokensBefore");
			const retained = Array.isArray(entry.retainedTail) ? entry.retainedTail.length : undefined;
			return {
				id,
				kind: "compaction",
				title: "Compaction",
				meta: [
					...time,
					...(tokensBefore === undefined ? [] : [`${tokensBefore.toLocaleString("en-US")} tokens before`]),
					...(retained === undefined ? [] : [`${retained} retained messages`]),
					...(entry.fromHook === true ? ["from hook"] : []),
				],
				blocks: [{ kind: "text", text: boundText(stringField(entry, "summary") ?? "", TEXT_LIMIT) }],
			};
		}
		case "branch_summary": {
			const fromId = entry.fromId;
			return {
				id,
				kind: "branch-summary",
				title: "Branch summary",
				meta: [
					...time,
					typeof fromId === "string" ? `from ${fromId}` : "from root",
					...(entry.fromHook === true ? ["from hook"] : []),
				],
				blocks: [{ kind: "text", text: boundText(stringField(entry, "summary") ?? "", TEXT_LIMIT) }],
			};
		}
		case "custom":
			return {
				id,
				kind: "custom",
				title: `Custom · ${stringField(entry, "customType") ?? "unknown"}`,
				meta: time,
				blocks:
					entry.data === undefined
						? []
						: [{ kind: "preview", label: "Data", text: formatStructuredPreview(entry.data) }],
			};
		default:
			return { id, kind: "unsupported", title: `Unsupported entry · ${String(entry.type)}`, meta: time, blocks: [] };
	}
}

export interface VisibleEntry {
	/** The immutable source entry, for identity-based reconciliation. */
	readonly source: unknown;
	readonly view: EntryView;
}

/** Visible cards for one immutable source entry, keyed by that entry's identity. */
export type VisibleEntryCache = WeakMap<object, readonly VisibleEntry[]>;

/**
 * The main-lane transcript as the cockpit shows it: every entry for display, in order. Pi's main-lane transcript
 * starts at the latest compaction, and the messages that compaction retained live only in its retainedTail, so they
 * follow its card, under the same display rules as ordinary messages. Entries are immutable, so a cache keyed by entry
 * identity lets a streamed update project only new or replaced entries.
 */
export function projectVisibleTranscript(transcript: readonly unknown[], cache?: VisibleEntryCache): VisibleEntry[] {
	return transcript.flatMap((source) => {
		const cached = isRecord(source) ? cache?.get(source) : undefined;
		if (cached !== undefined) return cached;
		const visible = projectEntryCards(source);
		if (isRecord(source)) cache?.set(source, visible);
		return visible;
	});
}

function projectEntryCards(source: unknown): VisibleEntry[] {
	const view = projectTranscriptEntry(source);
	const cards: VisibleEntry[] = view === undefined ? [] : [{ source, view }];
	if (view?.kind === "compaction" && isRecord(source) && Array.isArray(source.retainedTail)) {
		source.retainedTail.forEach((message, index) => {
			const timestamp = isRecord(message) ? numberField(message, "timestamp") : undefined;
			const retained = projectMessage(`${view.id}:retained:${index}`, message, timestamp);
			if (retained !== undefined) {
				cards.push({ source: message, view: { ...retained, meta: [...retained.meta, "retained by compaction"] } });
			}
		});
	}
	return cards;
}

// ---------------------------------------------------------------------------------------------------------------
// Main-lane operation and queues

export interface ToolActivityView {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly status: "running" | "completed" | "failed";
	readonly args: BoundedText;
}

export interface OperationView {
	readonly idle: boolean;
	readonly label: string;
	readonly meta: readonly string[];
	readonly tools: readonly ToolActivityView[];
}

export function projectOperation(operation: unknown, lastResult?: unknown): OperationView {
	if (!isRecord(operation)) {
		const meta: string[] = [];
		if (isRecord(lastResult)) {
			const status = stringField(lastResult, "status");
			const endedAt = numberField(lastResult, "endedAt");
			if (status !== undefined) {
				meta.push(`last ${stringField(lastResult, "kind") ?? "operation"} ${status}`);
				if (endedAt !== undefined) meta.push(`ended ${formatClock(endedAt)}`);
			}
		}
		return { idle: true, label: "Idle", meta, tools: [] };
	}
	const meta: string[] = [];
	const startedAt = numberField(operation, "startedAt");
	if (startedAt !== undefined) meta.push(`started ${formatClock(startedAt)}`);
	if (isRecord(operation.retry)) {
		const attempt = numberField(operation.retry, "attempt");
		const maxAttempts = numberField(operation.retry, "maxAttempts");
		const nextAttemptAt = numberField(operation.retry, "nextAttemptAt");
		meta.push(
			`retry ${attempt ?? "?"}/${maxAttempts ?? "?"}${nextAttemptAt === undefined ? "" : ` at ${formatClock(nextAttemptAt)}`}`,
		);
	}
	if (operation.deferred !== undefined) meta.push("deferred");
	const tools = (Array.isArray(operation.runningTools) ? operation.runningTools : []).filter(isRecord).map(
		(tool): ToolActivityView => ({
			toolCallId: stringField(tool, "toolCallId") ?? "unknown",
			toolName: stringField(tool, "toolName") ?? "unknown tool",
			status: tool.status === "running" ? "running" : tool.isError === true ? "failed" : "completed",
			args: formatStructuredPreview(tool.args),
		}),
	);
	return {
		idle: false,
		label: `${stringField(operation, "kind") ?? "operation"} · ${stringField(operation, "status") ?? "unknown"}`,
		meta,
		tools,
	};
}

export function projectQueues(queues: unknown): string | undefined {
	if (!Array.isArray(queues) || queues.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const item of queues) {
		const kind = isRecord(item) ? (stringField(item, "kind") ?? "unknown") : "unknown";
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	return `${queues.length} queued · ${[...counts].map(([kind, count]) => `${count} ${kind}`).join(", ")}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Session Overview v0

export interface OverviewLaneView {
	readonly name: string;
	readonly tipId: string;
	readonly operation?: string;
	readonly startedAt?: string;
	/** The model the open operation captured; distinct from the configured model. */
	readonly capturedModel?: string;
}

export interface OverviewView {
	readonly capturedAt: string;
	readonly consistency: string;
	readonly counts: string;
	readonly lanes: readonly OverviewLaneView[];
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** capturedAt is when this cockpit received the capture, not an atomic server-side instant. */
export function projectSessionOverview(overview: SessionOverviewV0, capturedAt: number): OverviewView {
	return {
		capturedAt: formatClock(capturedAt),
		consistency: overview.consistency,
		counts: `${plural(overview.counts.lanes, "lane")} · ${overview.counts.activeOperations} active · ${overview.counts.abortingOperations} aborting`,
		lanes: overview.lanes.map((lane) => ({
			name: lane.name,
			tipId: lane.tipId ?? "empty",
			...(lane.operation === null
				? {}
				: {
						operation: `${lane.operation.kind} · ${lane.operation.status}`,
						startedAt: formatClock(lane.operation.startedAt),
						...(lane.operation.capturedModel === undefined
							? {}
							: { capturedModel: formatModel(lane.operation.capturedModel) }),
					}),
		})),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Session Accounting (Runtime Metrics v0)

export interface AccountingRowView {
	readonly label: string;
	readonly value: string;
}

export interface AccountingView {
	readonly capturedAt: string;
	readonly rows: readonly AccountingRowView[];
}

/**
 * A number exactly as reported: JavaScript's round-trippable form, with en-US grouping added only to the integer part
 * of a plain decimal. Exponent forms such as 1e-21 are kept as they are, so no value is rounded.
 */
export function formatExactNumber(value: number): string {
	const text = String(value);
	const plain = /^(-?)(\d+)(\.\d+)?$/.exec(text);
	if (plain === null) return text;
	const [, sign, integer = "", fraction = ""] = plain;
	return `${sign}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction}`;
}

/**
 * Session-wide cumulative accounting as reported, captured explicitly. Values are shown exactly, negative ones
 * included: totals are not assumed monotonic, nothing is recomputed, and cost carries no currency. capturedAt is when
 * this cockpit received the capture. Optional fields appear only when present.
 */
export function projectRuntimeMetrics(metrics: RuntimeMetricsV0, capturedAt: number): AccountingView {
	const { usage } = metrics;
	return {
		capturedAt: formatClock(capturedAt),
		rows: [
			{ label: "Persisted messages", value: formatExactNumber(metrics.messageCount) },
			{ label: "Input tokens", value: formatExactNumber(usage.input) },
			{ label: "Output tokens", value: formatExactNumber(usage.output) },
			{ label: "Cache read", value: formatExactNumber(usage.cacheRead) },
			{ label: "Cache write", value: formatExactNumber(usage.cacheWrite) },
			...(usage.reasoning === undefined ? [] : [{ label: "Reasoning", value: formatExactNumber(usage.reasoning) }]),
			...(usage.cacheWrite1h === undefined
				? []
				: [{ label: "1h cache write", value: formatExactNumber(usage.cacheWrite1h) }]),
			{ label: "Reported total", value: formatExactNumber(usage.totalTokens) },
			{ label: "Accounted cost", value: String(usage.cost.total) },
		],
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Mission Trace v0

/** Rows the cockpit renders at most, from the replicated observation's own bounded window. */
export const MISSION_TRACE_ROW_LIMIT = 50;

export type MissionTraceFamily = "mission" | "turn" | "model" | "tool" | "unknown";

export interface MissionTraceRowView {
	/** Pi's sequence, which orders events; it is not a time. */
	readonly sequence: string;
	readonly label: string;
	readonly family: MissionTraceFamily;
	/** Illustrative nesting only: model.completed carries no turn ID, so no exact parent is implied. */
	readonly depth: 0 | 1 | 2;
	readonly tone: Tone;
	/** The lane, or the tool name for tool events. */
	readonly subject: string;
	/** Compact identifiers and the tool outcome Pi reported. */
	readonly meta: readonly string[];
	/** The exact identifiers, for a tooltip. */
	readonly title: string;
}

export interface MissionTraceView {
	readonly total: number;
	readonly rows: readonly MissionTraceRowView[];
	/** Present when only the latest rows are shown. */
	readonly window?: string;
	/** Present when the replicated window no longer holds the start of the worker-lifetime trace. */
	readonly truncated?: string;
}

const MISSION_TRACE_KINDS: Readonly<
	Record<
		string,
		{ readonly label: string; readonly family: MissionTraceFamily; readonly depth: 0 | 1 | 2; readonly tone: Tone }
	>
> = {
	"mission.started": { label: "Mission started", family: "mission", depth: 0, tone: "live" },
	"mission.resumed": { label: "Mission resumed", family: "mission", depth: 0, tone: "live" },
	"mission.suspended": { label: "Mission suspended", family: "mission", depth: 0, tone: "pending" },
	"mission.completed": { label: "Mission completed", family: "mission", depth: 0, tone: "live" },
	"mission.aborted": { label: "Mission aborted", family: "mission", depth: 0, tone: "warn" },
	"mission.failed": { label: "Mission failed", family: "mission", depth: 0, tone: "warn" },
	"turn.started": { label: "Turn started", family: "turn", depth: 1, tone: "idle" },
	"turn.finished": { label: "Turn finished", family: "turn", depth: 1, tone: "idle" },
	"model.completed": { label: "Model completed", family: "model", depth: 1, tone: "idle" },
	"tool.started": { label: "Tool started", family: "tool", depth: 2, tone: "pending" },
	"tool.finished": { label: "Tool finished", family: "tool", depth: 2, tone: "live" },
};

function compactId(id: string): string {
	return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Project one Mission Trace v0 event. Only the schema's own identity fields are read: the trace carries no payloads,
 * and an unknown future kind becomes a neutral row instead of being interpreted.
 */
export function projectMissionTraceEvent(event: unknown): MissionTraceRowView {
	const record = isRecord(event) ? event : {};
	const sequence = numberField(record, "sequence");
	const kind = stringField(record, "kind");
	const known =
		kind === undefined ? undefined : Object.hasOwn(MISSION_TRACE_KINDS, kind) ? MISSION_TRACE_KINDS[kind] : undefined;
	const sequenceLabel = sequence === undefined ? "#?" : `#${sequence}`;
	if (known === undefined) {
		return {
			sequence: sequenceLabel,
			label: "Unknown trace event",
			family: "unknown",
			depth: 0,
			tone: "idle",
			subject: "",
			meta: [],
			title: "",
		};
	}
	const lane = stringField(record, "lane") ?? "unknown lane";
	const runId = stringField(record, "runId");
	const turnId = stringField(record, "turnId");
	const toolCallId = stringField(record, "toolCallId");
	const toolName = stringField(record, "toolName");
	const failedTool = kind === "tool.finished" && record.isError === true;
	const meta: string[] = [];
	if (known.family === "tool") {
		meta.push(lane);
		if (toolCallId !== undefined) meta.push(`call ${compactId(toolCallId)}`);
		if (kind === "tool.finished") meta.push(failedTool ? "error" : "ok");
	} else if (known.family === "turn" && turnId !== undefined) {
		meta.push(`turn ${compactId(turnId)}`);
	} else if (runId !== undefined) {
		meta.push(`run ${compactId(runId)}`);
	}
	const title = [
		runId === undefined ? undefined : `run ${runId}`,
		turnId === undefined ? undefined : `turn ${turnId}`,
		toolCallId === undefined ? undefined : `call ${toolCallId}`,
	]
		.filter((part) => part !== undefined)
		.join(" · ");
	return {
		sequence: sequenceLabel,
		label: known.label,
		family: known.family,
		depth: known.depth,
		tone: failedTool ? "warn" : known.tone,
		subject: known.family === "tool" ? (toolName ?? "unknown tool") : lane,
		meta,
		title,
	};
}

/** The latest rows of a Mission Trace observation, in its own sequence order. */
export function projectMissionTrace(
	observation: { readonly events: readonly unknown[] },
	limit = MISSION_TRACE_ROW_LIMIT,
): MissionTraceView {
	const total = observation.events.length;
	const shown = total > limit ? observation.events.slice(total - limit) : observation.events;
	const first = observation.events[0];
	const firstSequence = isRecord(first) ? numberField(first, "sequence") : undefined;
	return {
		total,
		rows: shown.map(projectMissionTraceEvent),
		...(total > limit ? { window: `Showing latest ${limit} of ${total} replicated events` } : {}),
		// Sequences start at 1 for each worker, so a later first sequence means the window dropped earlier events.
		...(firstSequence !== undefined && firstSequence > 1
			? { truncated: "Earlier worker-lifetime trace events are outside the replicated window." }
			: {}),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Usage Activity (Usage Observation v0)

/** Usage rows the cockpit renders at most; the replicated observation holds a larger trailing window. */
export const USAGE_ROW_LIMIT = 20;

export interface UsageRowView {
	/** The durable, session-global accounting sequence: an order, not a time. */
	readonly sequence: string;
	/** "adjustment" only when the row was recorded as one; otherwise a neutral "usage record". */
	readonly label: "usage record" | "adjustment";
	readonly totals: string;
	readonly cost: string;
	/** Cache counts, and reasoning and 1h cache write only when reported. */
	readonly detail: string;
}

export interface UsageView {
	readonly rows: readonly UsageRowView[];
	/** Present when only the latest rows of the observation are shown. */
	readonly window?: string;
	/** Present when durable rows exist before the observation's window; they stay readable as durable pages. */
	readonly earlier?: string;
}

/**
 * Project one durable usage row. Only its own fields are shown: a usage row establishes no time, model, provider,
 * lane, run, operation, attempt, tool or cause, so none is implied. The reported total is shown, never recomputed.
 */
export function projectUsageRow(row: UsageLedgerRowV0): UsageRowView {
	const { usage } = row;
	const detail = [
		`${formatExactNumber(usage.cacheRead)} cache read`,
		`${formatExactNumber(usage.cacheWrite)} cache write`,
		...(usage.cacheWrite1h === undefined ? [] : [`${formatExactNumber(usage.cacheWrite1h)} 1h cache write`]),
		...(usage.reasoning === undefined ? [] : [`${formatExactNumber(usage.reasoning)} reasoning`]),
	];
	return {
		sequence: `#${row.sequence}`,
		label: row.adjustment ? "adjustment" : "usage record",
		totals: `${formatExactNumber(usage.totalTokens)} total · ${formatExactNumber(usage.input)} in · ${formatExactNumber(usage.output)} out`,
		cost: `cost ${String(usage.cost.total)}`,
		detail: detail.join(" · "),
	};
}

/** The latest rows of a usage observation, in its ascending durable order. */
export function projectUsage(observation: UsageObservationV0, limit = USAGE_ROW_LIMIT): UsageView {
	const total = observation.rows.length;
	const shown = total > limit ? observation.rows.slice(total - limit) : observation.rows;
	return {
		rows: shown.map(projectUsageRow),
		...(total > limit ? { window: `Showing latest ${limit} of ${total} rows in the live window` } : {}),
		...(observation.hasEarlierRows ? { earlier: "Earlier durable usage rows are outside the live window." } : {}),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Continuity v0

/** Entry rows the cockpit renders at most per list; the capture itself holds every entry. */
export const CONTINUITY_ENTRY_ROW_LIMIT = 100;

export interface ContinuityFieldView {
	readonly label: string;
	readonly value: string;
}

export interface ContinuityEntryRowView {
	/** Pi's durable entry sequence: an order, not a time. */
	readonly sequence: string;
	/** The exact entry ID. */
	readonly id: string;
	readonly label: string;
	/** Only the structural fields the v0 entry carries. */
	readonly meta: readonly string[];
}

export interface ContinuityEntriesView {
	readonly total: number;
	readonly rows: readonly ContinuityEntryRowView[];
	/** Present when only the latest rows of the captured list are shown. */
	readonly window?: string;
}

export interface ContinuityView {
	readonly capturedAt: string;
	readonly fields: readonly ContinuityFieldView[];
	/** The compaction boundary of the context window, or undefined when it starts at no compaction. */
	readonly compaction?: readonly ContinuityFieldView[];
	readonly contextWindow: ContinuityEntriesView;
	readonly activePath: ContinuityEntriesView;
}

/**
 * Project one Continuity v0 entry from its own structural fields. Payload was never captured, so only its presence is
 * shown where the schema records it (hasSummary, hasData); timestamps and parents are left to the capture.
 */
export function projectContinuityEntry(entry: ContinuityEntryV0): ContinuityEntryRowView {
	const row = { sequence: `#${entry.seq}`, id: entry.id };
	switch (entry.type) {
		case "message":
			return {
				...row,
				label: `Message · ${entry.role}`,
				meta: [
					...(entry.stopReason === undefined ? [] : [`stop ${entry.stopReason}`]),
					...(entry.terminate ? ["terminate"] : []),
				],
			};
		case "compaction":
			return {
				...row,
				label: "Compaction",
				meta: [
					`${formatExactNumber(entry.tokensBefore)} tokens before`,
					`${formatExactNumber(entry.retainedTailCount)} retained`,
					...(entry.fromHook ? ["from hook"] : []),
					entry.hasSummary ? "summary not shown" : "empty summary",
				],
			};
		case "branch_summary":
			return {
				...row,
				label: "Branch summary",
				meta: [
					entry.fromId === null ? "from root" : `from ${entry.fromId}`,
					...(entry.fromHook ? ["from hook"] : []),
					entry.hasSummary ? "summary not shown" : "empty summary",
				],
			};
		case "custom":
			return {
				...row,
				label: `Custom · ${entry.customType}`,
				meta: [entry.hasData ? "data not shown" : "no data"],
			};
		default:
			// Not part of Continuity v0; shown neutrally rather than interpreted.
			return { ...row, label: "Unknown entry", meta: [] };
	}
}

function projectContinuityEntries(entries: readonly ContinuityEntryV0[], limit: number): ContinuityEntriesView {
	const total = entries.length;
	const shown = total > limit ? entries.slice(total - limit) : entries;
	return {
		total,
		rows: shown.map(projectContinuityEntry),
		...(total > limit ? { window: `Showing latest ${limit} of ${total} captured entries` } : {}),
	};
}

/**
 * One explicit Continuity capture, field for field. Counts are the snapshot's own; nothing is recomputed, joined to
 * other surfaces or read as token occupancy. capturedAt is when this cockpit received the capture.
 */
export function projectContinuity(
	snapshot: ContinuitySnapshotV0,
	capturedAt: number,
	limit = CONTINUITY_ENTRY_ROW_LIMIT,
): ContinuityView {
	const { configuration, counts, compaction } = snapshot;
	return {
		capturedAt: formatClock(capturedAt),
		fields: [
			{ label: "Lane", value: snapshot.lane },
			{ label: "Tip", value: snapshot.tipId ?? "empty" },
			{ label: "Configured model", value: formatModel(configuration.model) },
			{ label: "Thinking level", value: configuration.thinkingLevel },
			{
				label: "Active tools",
				value: configuration.activeToolNames.length === 0 ? "none" : configuration.activeToolNames.join(", "),
			},
			{ label: "Active-path entries", value: formatExactNumber(counts.activePathEntries) },
			{ label: "Context-window entries", value: formatExactNumber(counts.contextWindowEntries) },
			{ label: "Before context window", value: formatExactNumber(counts.beforeContextWindow) },
		],
		...(compaction === null
			? {}
			: {
					compaction: [
						{ label: "Entry", value: compaction.entryId },
						{ label: "Tokens before", value: formatExactNumber(compaction.tokensBefore) },
						{ label: "Retained tail", value: formatExactNumber(compaction.retainedTailCount) },
						{ label: "From hook", value: compaction.fromHook ? "yes" : "no" },
					],
				}),
		contextWindow: projectContinuityEntries(snapshot.contextWindow, limit),
		activePath: projectContinuityEntries(snapshot.activePath, limit),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Runtime Profile v0

/** Identifiers outside the v0 catalogue are shown at most this long. */
const PROFILE_TEXT_LIMIT = 200;
/** Identifiers outside the v0 catalogue the cockpit renders at most; a hostile profile can list many thousands. */
export const UNRECOGNIZED_CAPABILITY_ROW_LIMIT = 20;

type RuntimeCapabilityGroup = "observation-boundary" | "outside-boundary";

/**
 * Display metadata for the closed v0 catalogue. The group records where a capability's semantics sit in Endophasia's
 * architecture today, not whether any runtime could provide it.
 */
const RUNTIME_CAPABILITY_VIEW = {
	"endophasia.session-overview.v0": { label: "Session Overview", group: "outside-boundary" },
	"endophasia.mission-trace.v0": { label: "Mission Trace", group: "observation-boundary" },
	"endophasia.runtime-metrics.v0": { label: "Runtime Metrics", group: "observation-boundary" },
	"endophasia.operation-outcome.v0": { label: "Operation Outcome", group: "observation-boundary" },
	"endophasia.usage.v0": { label: "Usage", group: "observation-boundary" },
	"endophasia.continuity.v0": { label: "Continuity", group: "outside-boundary" },
} as const satisfies Record<
	EndophasiaRuntimeCapabilityIdV0,
	{ readonly label: string; readonly group: RuntimeCapabilityGroup }
>;

const RUNTIME_CAPABILITY_GROUPS: readonly {
	readonly group: RuntimeCapabilityGroup;
	readonly title: string;
	readonly note: string;
}[] = [
	{
		group: "observation-boundary",
		title: "Runtime Observation Boundary v0",
		note: "Served through Endophasia's runtime-neutral observation ports",
	},
	{
		group: "outside-boundary",
		title: "Outside that boundary today",
		note: "Semantics not yet behind the runtime observation ports",
	},
];

export interface RuntimeCapabilityRowView {
	readonly id: string;
	readonly label: string;
	/** Absence means only that this worker does not advertise the capability. */
	readonly status: "advertised" | "not advertised";
}

export interface RuntimeCapabilityGroupView {
	readonly title: string;
	readonly note: string;
	readonly rows: readonly RuntimeCapabilityRowView[];
}

export interface RuntimeProfileView {
	readonly runtimeFamily: string;
	readonly adapterProfileId: string;
	readonly scope: string;
	/** Present when the profile's schema version is not runtime-profile.v0. */
	readonly schemaNote?: string;
	readonly advertised: string;
	readonly groups: readonly RuntimeCapabilityGroupView[];
	/**
	 * The first distinct advertised identifiers outside the v0 catalogue, verbatim and bounded in length and number; no
	 * meaning is assigned to them.
	 */
	readonly unrecognized: readonly string[];
	/** Present when more distinct unrecognized identifiers were advertised than are shown. */
	readonly unrecognizedWindow?: string;
}

function isKnownCapability(id: string): id is EndophasiaRuntimeCapabilityIdV0 {
	return Object.hasOwn(RUNTIME_CAPABILITY_VIEW, id);
}

/**
 * Project a Runtime Profile, read defensively as unknown JSON. Each known v0 capability is advertised exactly when its
 * identifier is listed: nothing is inferred from the runtime family, the adapter profile ID or any other service.
 */
export function projectRuntimeProfile(profile: unknown): RuntimeProfileView {
	const record = isRecord(profile) ? profile : {};
	const listed = Array.isArray(record.capabilities)
		? record.capabilities.filter((id): id is string => typeof id === "string")
		: [];
	const advertised = new Set(listed.filter(isKnownCapability));
	// Counted by reference to the received strings; only the shown few are copied and truncated.
	const unknown = new Set(listed.filter((id) => !isKnownCapability(id)));
	const unrecognized: string[] = [];
	for (const id of unknown) {
		if (unrecognized.length === UNRECOGNIZED_CAPABILITY_ROW_LIMIT) break;
		unrecognized.push(id.length > PROFILE_TEXT_LIMIT ? `${id.slice(0, PROFILE_TEXT_LIMIT)}…` : id);
	}
	const catalogue = Object.keys(RUNTIME_CAPABILITY_VIEW) as EndophasiaRuntimeCapabilityIdV0[];
	const scope = stringField(record, "scope");
	const schemaVersion = stringField(record, "schemaVersion");
	return {
		runtimeFamily: stringField(record, "runtimeFamily") ?? "not reported",
		adapterProfileId: stringField(record, "adapterProfileId") ?? "not reported",
		scope: scope === "session-worker-lifetime" ? "Session worker lifetime" : (scope ?? "not reported"),
		...(schemaVersion === "runtime-profile.v0"
			? {}
			: { schemaNote: `Unrecognized schema version · ${schemaVersion ?? "none"}` }),
		advertised: `${advertised.size} of ${catalogue.length} Endophasia v0 capabilities advertised`,
		groups: RUNTIME_CAPABILITY_GROUPS.map(({ group, title, note }) => ({
			title,
			note,
			rows: catalogue
				.filter((id) => RUNTIME_CAPABILITY_VIEW[id].group === group)
				.map((id) => ({
					id,
					label: RUNTIME_CAPABILITY_VIEW[id].label,
					status: advertised.has(id) ? "advertised" : "not advertised",
				})),
		})),
		unrecognized,
		...(unknown.size > unrecognized.length
			? { unrecognizedWindow: `Showing first ${unrecognized.length} of ${unknown.size} unrecognized identifiers` }
			: {}),
	};
}
