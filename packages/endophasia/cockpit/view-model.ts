// Pure display projections for Standard Cockpit v0. Each function derives only what the cockpit renders from Pi's
// replicated state or an explicit Session Overview capture: no network, no mutation of inputs, no retained copies.
// Transcript values are read defensively as unknown JSON, so newer entry or content kinds degrade to a neutral
// preview instead of breaking the cockpit.
import type {
	ServerConnectionState,
	SessionAttachmentState,
} from "@earendil-works/pi-coding-agent/experimental/services/connection";
import type { ModelsState } from "@earendil-works/pi-coding-agent/experimental/services/models";
import type { SessionDirectoryState } from "@earendil-works/pi-coding-agent/experimental/services/sessions";
import type { SessionOverviewV0 } from "../src/session-overview.ts";

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
			return {
				id,
				kind: "shell",
				title: "Shell",
				meta: [
					...meta,
					exitCode === undefined ? "no exit code" : `exit ${exitCode}`,
					...(message.cancelled === true ? ["cancelled"] : []),
				],
				blocks: [
					{ kind: "preview", label: "Command", text: boundText(stringField(message, "command") ?? "") },
					{ kind: "preview", label: "Output", text: boundText(stringField(message, "output") ?? "") },
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

/** The main-lane transcript as the cockpit shows it: every entry for display, in order. */
export function projectVisibleTranscript(transcript: readonly unknown[]): VisibleEntry[] {
	return transcript.flatMap((source) => {
		const view = projectTranscriptEntry(source);
		return view === undefined ? [] : [{ source, view }];
	});
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
