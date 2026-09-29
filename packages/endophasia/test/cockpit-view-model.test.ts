import { describe, expect, it } from "vitest";
import type { EntryView, VisibleEntryCache } from "../cockpit/view-model.ts";
import {
	boundText,
	CONTINUITY_ENTRY_ROW_LIMIT,
	formatClock,
	formatExactNumber,
	formatStructuredPreview,
	MISSION_TRACE_ROW_LIMIT,
	PREVIEW_LIMIT,
	projectAttachment,
	projectConnection,
	projectContinuity,
	projectContinuityEntry,
	projectMessage,
	projectMissionTrace,
	projectMissionTraceEvent,
	projectModels,
	projectOperation,
	projectQueues,
	projectRuntimeMetrics,
	projectRuntimeProfile,
	projectSessionOverview,
	projectSessions,
	projectTranscriptEntry,
	projectUsage,
	projectUsageRow,
	projectVisibleTranscript,
	UNRECOGNIZED_CAPABILITY_ROW_LIMIT,
	USAGE_ROW_LIMIT,
} from "../cockpit/view-model.ts";
import type { ContinuityEntryV0, ContinuitySnapshotV0 } from "../src/continuity-service.ts";
import type { RuntimeMetricsV0 } from "../src/runtime-facts-service.ts";
import type { RuntimeProfileV0 } from "../src/runtime-profile-service.ts";
import type { SessionOverviewV0 } from "../src/session-overview.ts";
import type { UsageLedgerRowV0 } from "../src/usage-service.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} };

/** Project an entry that must be for display. */
function visible(source: unknown): EntryView {
	const view = projectTranscriptEntry(source);
	if (view === undefined) throw new Error("Expected a displayed entry");
	return view;
}

function entry(fields: Record<string, unknown>): Record<string, unknown> {
	return { id: "entry-1", parentId: null, seq: 1, timestamp: Date.UTC(2026, 0, 1, 12, 0, 0), ...fields };
}

describe("cockpit status projections", () => {
	it("labels connection and attachment states with glyphs and words, not colour alone", () => {
		expect(projectConnection(undefined)).toMatchObject({ glyph: "◌", label: "Starting" });
		expect(projectConnection({ status: "connecting", attempt: 2 })).toMatchObject({
			tone: "pending",
			label: "Connecting",
			detail: "attempt 2",
		});
		expect(projectConnection({ status: "connected", since: "2026-01-01T00:00:00.000Z" })).toMatchObject({
			tone: "live",
			glyph: "●",
			label: "Connected",
		});
		expect(
			projectConnection({
				status: "disconnected",
				since: "2026-01-01T00:00:00.000Z",
				reason: "closed",
				retryAt: null,
			}),
		).toMatchObject({ tone: "warn", glyph: "○", label: "Disconnected", detail: "closed · reload to reconnect" });

		expect(projectAttachment({ status: "detached" })).toMatchObject({ glyph: "○", label: "Detached" });
		expect(projectAttachment({ status: "attaching", sessionId: "a" })).toMatchObject({ glyph: "◌", detail: "a" });
		expect(projectAttachment({ status: "attached", sessionId: "a" })).toMatchObject({
			glyph: "●",
			label: "Attached",
		});
		expect(projectAttachment({ status: "degraded", sessionId: "a" })).toMatchObject({
			glyph: "△",
			label: "Degraded",
		});
	});

	it("keeps Pi's attachment authoritative over the local pending selection", () => {
		const directory = {
			revision: 1,
			sessions: [
				{ serverId: "s", sessionId: "old", createdAt: 1 },
				{ serverId: "s", sessionId: "new", createdAt: 2 },
			],
		};
		expect(projectSessions(directory, { status: "attached", sessionId: "old" }, "new")).toMatchObject([
			{ sessionId: "new", state: "requested" },
			{ sessionId: "old", state: "attached" },
		]);
		// A pending request for the Session Pi reports as attaching shows Pi's state, not local intent.
		expect(projectSessions(directory, { status: "attaching", sessionId: "new" }, "new")[0]).toMatchObject({
			state: "attaching",
		});
		expect(projectSessions(directory, { status: "degraded", sessionId: "new" }, undefined)[0]).toMatchObject({
			state: "degraded",
		});
		expect(projectSessions(undefined, undefined, undefined)).toEqual([]);
	});

	it("reports the configured model, not a model an operation captured", () => {
		expect(projectModels(undefined)).toBeUndefined();
		expect(
			projectModels({
				catalog: { revision: 1, availableModels: [{ provider: "p", modelId: "m", name: "M", reasoning: false }] },
				configuration: { model: { provider: "anthropic", modelId: "configured" }, thinkingLevel: "high" },
				refresh: { status: "idle" },
			}),
		).toEqual({
			configuredModel: "anthropic/configured",
			thinkingLevel: "high",
			availableModels: 1,
			refresh: "idle",
		});

		const overview: SessionOverviewV0 = {
			schemaVersion: "session-overview.v0",
			consistency: "per-lane",
			lanes: [
				{
					name: "main",
					tipId: "tip",
					operation: {
						operationId: "op",
						kind: "run",
						status: "running",
						startedAt: 0,
						capturedModel: { provider: "anthropic", modelId: "captured" },
					},
				},
				{ name: "side", tipId: null, operation: null },
			],
			counts: { lanes: 2, activeOperations: 1, abortingOperations: 0 },
		};
		const view = projectSessionOverview(overview, Date.UTC(2026, 0, 1));
		expect(view.lanes[0]).toMatchObject({
			name: "main",
			operation: "run · running",
			capturedModel: "anthropic/captured",
		});
		expect(view.lanes[1]).toEqual({ name: "side", tipId: "empty" });
		expect(view).toMatchObject({ consistency: "per-lane", counts: "2 lanes · 1 active · 0 aborting" });
		expect(view.capturedAt).toBe(formatClock(Date.UTC(2026, 0, 1)));
		expect(projectSessionOverview({ ...overview, counts: { ...overview.counts, lanes: 1 } }, 0).counts).toMatch(
			/^1 lane ·/,
		);
	});
});

describe("cockpit transcript projections", () => {
	it("projects user, assistant and tool-result messages as distinct cards", () => {
		expect(visible(entry({ type: "message", message: { role: "user", content: "hi", timestamp: 1 } }))).toMatchObject(
			{ kind: "user", title: "User", blocks: [{ kind: "text", text: { text: "hi" } }] },
		);

		const assistant = visible(
			entry({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "answer" },
						{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage,
					stopReason: "toolUse",
					errorMessage: "partial failure",
					timestamp: 1,
				},
			}),
		);
		expect(assistant).toMatchObject({ kind: "assistant", meta: [expect.any(String), "claude", "toolUse"] });
		expect(assistant.blocks.map((block) => block.kind)).toEqual(["text", "tool-call", "error"]);
		expect(assistant.blocks[1]).toMatchObject({ toolName: "bash", args: { text: expect.stringContaining('"ls"') } });

		const result = visible(
			entry({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [
						{ type: "text", text: "out" },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
					isError: true,
					timestamp: 1,
				},
			}),
		);
		expect(result).toMatchObject({ kind: "tool-result", title: "Tool result · bash" });
		expect(result.meta).toContain("failed");
		expect(result.blocks).toEqual([
			{ kind: "preview", label: "Output", text: { text: "out", truncated: false, totalLength: 3 } },
			{ kind: "image", mimeType: "image/png" },
		]);
		// Image data is never carried into the display model.
		expect(JSON.stringify(result)).not.toContain("AAAA");
	});

	it("never projects reasoning text, only a neutral reasoning marker", () => {
		const secret = "PRIVATE-REASONING-SENTINEL";
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: secret, thinkingSignature: secret },
				{ type: "thinking", thinking: secret, redacted: true },
				{ type: "text", text: "visible" },
			],
			api: "x",
			provider: "p",
			model: "m",
			usage,
			stopReason: "stop",
			timestamp: 1,
		};
		const durable = visible(entry({ type: "message", message }));
		const streaming = projectMessage("streaming", message)!;
		for (const view of [durable, streaming]) {
			expect(view.blocks.map((block) => block.kind)).toEqual(["reasoning", "reasoning", "text"]);
			expect(JSON.stringify(view)).not.toContain(secret);
		}
	});

	it("renders compaction and branch summaries from their own fields", () => {
		expect(
			visible(
				entry({
					type: "compaction",
					summary: "what happened",
					retainedTail: [{}, {}],
					tokensBefore: 123456,
					fromHook: false,
				}),
			),
		).toMatchObject({
			kind: "compaction",
			title: "Compaction",
			meta: [expect.any(String), "123,456 tokens before", "2 retained messages"],
			blocks: [{ kind: "text", text: { text: "what happened" } }],
		});
		expect(
			visible(entry({ type: "branch_summary", fromId: "abc", summary: "branch", fromHook: true })),
		).toMatchObject({
			kind: "branch-summary",
			title: "Branch summary",
			meta: [expect.any(String), "from abc", "from hook"],
			blocks: [{ kind: "text", text: { text: "branch" } }],
		});
		expect(visible(entry({ type: "branch_summary", fromId: null, summary: "" })).meta).toContain("from root");
	});

	it("renders custom and unknown entries and content generically without crashing", () => {
		expect(visible(entry({ type: "custom", customType: "x.note", data: { a: 1 } }))).toMatchObject({
			kind: "custom",
			title: "Custom · x.note",
			blocks: [{ kind: "preview", label: "Data", text: { text: '{\n  "a": 1\n}' } }],
		});
		expect(visible(entry({ type: "future_kind" }))).toMatchObject({
			kind: "unsupported",
			title: "Unsupported entry · future_kind",
		});
		expect(visible(null)).toMatchObject({ kind: "unsupported" });
		expect(visible(entry({ type: "message", message: { role: "hologram" } }))).toMatchObject({
			kind: "unsupported",
			title: "Unsupported message · hologram",
		});
		expect(
			visible(entry({ type: "message", message: { role: "user", content: [{ type: "video" }, 7], timestamp: 1 } }))
				.blocks,
		).toEqual([
			{ kind: "unsupported", label: "Unsupported content · video" },
			{ kind: "unsupported", label: "Unsupported content" },
		]);
		expect(
			visible(
				entry({
					type: "message",
					message: {
						role: "bashExecution",
						command: "ls",
						output: "a",
						exitCode: 0,
						cancelled: false,
						timestamp: 1,
					},
				}),
			),
		).toMatchObject({ kind: "shell", meta: [expect.any(String), "exit 0"] });
	});

	it("omits custom messages Pi does not display, as its interactive renderer does", () => {
		const secret = "SECRET_SENTINEL_d41d8cd9";
		const hidden = (display: unknown) =>
			entry({
				id: `hidden-${String(display)}`,
				type: "message",
				message: {
					role: "custom",
					customType: "plan-mode-context",
					content: [{ type: "text", text: secret }],
					display,
					details: { secret },
					timestamp: 1,
				},
			});
		const shown = entry({
			id: "shown",
			type: "message",
			message: { role: "custom", customType: "note", content: "visible note", display: true, timestamp: 1 },
		});
		const transcript = [hidden(false), hidden(undefined), hidden("true"), shown];

		for (const source of transcript.slice(0, 3)) expect(projectTranscriptEntry(source)).toBeUndefined();
		expect(projectMessage("streaming", (hidden(false) as { message: unknown }).message)).toBeUndefined();
		const presented = projectVisibleTranscript(transcript);
		expect(presented.map(({ view }) => view.id)).toEqual(["shown"]);
		expect(presented[0]!.view).toMatchObject({
			kind: "custom-message",
			title: "Custom message · note",
			blocks: [{ kind: "text", text: { text: "visible note" } }],
		});
		expect(JSON.stringify(presented.map(({ view }) => view))).not.toContain(secret);
		// The presentation keeps a reference to the displayed source only.
		expect(presented[0]!.source).toBe(shown);
	});

	it("keeps rendering durable custom entries, which have no display flag", () => {
		expect(visible(entry({ type: "custom", customType: "x.state", data: { value: "durable" } }))).toMatchObject({
			kind: "custom",
			blocks: [{ kind: "preview", text: { text: expect.stringContaining("durable") } }],
		});
	});

	it("marks shell output the source already truncated", () => {
		const shell = (fields: Record<string, unknown>) =>
			visible(
				entry({
					type: "message",
					message: {
						role: "bashExecution",
						command: "make",
						output: "partial",
						exitCode: 0,
						cancelled: false,
						timestamp: 1,
						...fields,
					},
				}),
			);
		const truncated = shell({ truncated: true, fullOutputPath: "/tmp/pi-output-1.log" });
		expect(truncated.meta).toContain("output truncated");
		expect(truncated.blocks.at(-1)).toEqual({
			kind: "note",
			text: "Output truncated at source · full output: /tmp/pi-output-1.log",
		});
		expect(shell({ truncated: true }).blocks.at(-1)).toEqual({ kind: "note", text: "Output truncated at source" });
		const complete = shell({ truncated: false });
		expect(complete.meta).not.toContain("output truncated");
		expect(complete.blocks.map((block) => block.kind)).toEqual(["preview", "preview"]);
	});

	it("projects each immutable entry once across streamed updates", () => {
		const first = entry({ id: "a", type: "custom", customType: "x", data: { n: 1 } });
		const second = entry({ id: "b", type: "message", message: { role: "user", content: "hi", timestamp: 1 } });
		const cache: VisibleEntryCache = new WeakMap();
		const before = projectVisibleTranscript([first], cache);
		const after = projectVisibleTranscript([first, second], cache);
		expect(after[0]!.view).toBe(before[0]!.view);
		expect(after.map(({ view }) => view.id)).toEqual(["a", "b"]);
		// A replaced entry is a new object and is projected afresh.
		const replaced = { ...first, data: { n: 2 } };
		expect(projectVisibleTranscript([replaced, second], cache)[0]!.view).not.toBe(before[0]!.view);
	});

	it("bounds previews without changing the source value", () => {
		const long = "x".repeat(PREVIEW_LIMIT + 10);
		const data = { long };
		const preview = formatStructuredPreview(data);
		expect(preview.truncated).toBe(true);
		expect(preview.text).toHaveLength(PREVIEW_LIMIT);
		expect(preview.totalLength).toBeGreaterThan(PREVIEW_LIMIT);
		expect(data.long).toHaveLength(PREVIEW_LIMIT + 10);
		expect(boundText("short")).toEqual({ text: "short", truncated: false, totalLength: 5 });
		expect(formatStructuredPreview(10n)).toEqual({ text: "Unserializable value", truncated: false, totalLength: 20 });
		expect(formatStructuredPreview(undefined).text).toBe("undefined");
	});

	it("keeps markup in untrusted text as literal characters", () => {
		const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
		const view = visible(entry({ type: "message", message: { role: "user", content: markup } }));
		expect(view.blocks).toEqual([
			{ kind: "text", text: { text: markup, truncated: false, totalLength: markup.length } },
		]);
	});
});

describe("cockpit operation projections", () => {
	it("shows only the real fields of the live main-lane operation", () => {
		expect(projectOperation(null)).toEqual({ idle: true, label: "Idle", meta: [], tools: [] });
		expect(
			projectOperation(null, { operationId: "o", kind: "run", status: "completed", endedAt: 0, startedAt: 0 }).meta,
		).toEqual(["last run completed", `ended ${formatClock(0)}`]);

		const view = projectOperation({
			id: "op",
			kind: "run",
			startedAt: 0,
			fromTipId: null,
			status: "running",
			retry: { attempt: 2, maxAttempts: 3, nextAttemptAt: 0 },
			runningTools: [
				{ status: "running", toolCallId: "a", toolName: "bash", args: { command: "sleep 1" } },
				{ status: "settled", toolCallId: "b", toolName: "read", args: {}, result: {}, isError: false },
				{ status: "settled", toolCallId: "c", toolName: "edit", args: {}, result: {}, isError: true },
			],
		});
		expect(view.idle).toBe(false);
		expect(view.label).toBe("run · running");
		expect(view.meta).toEqual([`started ${formatClock(0)}`, `retry 2/3 at ${formatClock(0)}`]);
		expect(view.tools.map((tool) => [tool.toolName, tool.status])).toEqual([
			["bash", "running"],
			["read", "completed"],
			["edit", "failed"],
		]);
	});

	it("summarizes queues read-only", () => {
		expect(projectQueues([])).toBeUndefined();
		expect(
			projectQueues([
				{ entryId: "1", kind: "steer", type: "message", message: {} },
				{ entryId: "2", kind: "followUp", type: "message", message: {} },
				{ entryId: "3", kind: "followUp", type: "message", message: {} },
			]),
		).toBe("3 queued · 1 steer, 2 followUp");
	});
});

describe("cockpit Mission Trace projection", () => {
	const RUN = "0192f3c4-aaaa-7bbb-8ccc-000000000001";
	const TURN = "0192f3c4-dddd-7eee-8fff-000000000002";
	const CALL = "toolu_01ABCDEFGHIJKLMNOPQRSTUV";
	const base = { schemaVersion: "mission-trace.v0", lane: "main", runId: RUN };
	const events = [
		{ ...base, sequence: 1, kind: "mission.started" },
		{ ...base, sequence: 2, kind: "turn.started", turnId: TURN },
		{ ...base, sequence: 3, kind: "model.completed" },
		{ ...base, sequence: 4, kind: "tool.started", turnId: TURN, toolCallId: CALL, toolName: "read" },
		{ ...base, sequence: 5, kind: "tool.finished", turnId: TURN, toolCallId: CALL, toolName: "read", isError: false },
		{ ...base, sequence: 6, kind: "tool.finished", turnId: TURN, toolCallId: CALL, toolName: "bash", isError: true },
		{ ...base, sequence: 7, kind: "turn.finished", turnId: TURN },
		{ ...base, sequence: 8, kind: "mission.suspended" },
		{ ...base, sequence: 9, kind: "mission.resumed" },
		{ ...base, sequence: 10, kind: "mission.completed" },
		{ ...base, sequence: 11, kind: "mission.aborted" },
		{ ...base, sequence: 12, kind: "mission.failed" },
	];

	it("labels every event kind in sequence order, with lane, compact IDs and tool outcome", () => {
		const view = projectMissionTrace({ events });
		expect(view.total).toBe(12);
		expect(view.window).toBeUndefined();
		expect(view.truncated).toBeUndefined();
		expect(view.rows.map((row) => [row.sequence, row.label, row.family, row.depth, row.tone, row.subject])).toEqual([
			["#1", "Mission started", "mission", 0, "live", "main"],
			["#2", "Turn started", "turn", 1, "idle", "main"],
			["#3", "Model completed", "model", 1, "idle", "main"],
			["#4", "Tool started", "tool", 2, "pending", "read"],
			["#5", "Tool finished", "tool", 2, "live", "read"],
			["#6", "Tool finished", "tool", 2, "warn", "bash"],
			["#7", "Turn finished", "turn", 1, "idle", "main"],
			["#8", "Mission suspended", "mission", 0, "pending", "main"],
			["#9", "Mission resumed", "mission", 0, "live", "main"],
			["#10", "Mission completed", "mission", 0, "live", "main"],
			["#11", "Mission aborted", "mission", 0, "warn", "main"],
			["#12", "Mission failed", "mission", 0, "warn", "main"],
		]);
		expect(view.rows[0]!.meta).toEqual(["run 0192f3c4…"]);
		expect(view.rows[1]!.meta).toEqual(["turn 0192f3c4…"]);
		expect(view.rows[3]!.meta).toEqual(["main", "call toolu_01…"]);
		expect(view.rows[4]!.meta).toEqual(["main", "call toolu_01…", "ok"]);
		expect(view.rows[5]!.meta).toEqual(["main", "call toolu_01…", "error"]);
		// The full identifiers stay available, secondary to the row.
		expect(view.rows[3]!.title).toBe(`run ${RUN} · turn ${TURN} · call ${CALL}`);
		expect(view.rows[2]!.title).toBe(`run ${RUN}`);
	});

	it("keeps the source order rather than sorting, and projects no payload or time fields", () => {
		const shuffled = [events[4], events[0], events[2]];
		const rows = projectMissionTrace({ events: shuffled }).rows;
		expect(rows.map((row) => row.sequence)).toEqual(["#5", "#1", "#3"]);
		const hostile = {
			...events[4],
			arguments: { secret: "tool-args-sentinel" },
			result: "tool-result-sentinel",
			text: "assistant-text-sentinel",
			thinking: "private-reasoning-sentinel",
			prompt: "user-prompt-sentinel",
			error: "failure-detail-sentinel",
			timestamp: 1_700_000_000_000,
		};
		const row = projectMissionTraceEvent(hostile);
		expect(Object.keys(row).sort()).toEqual([
			"depth",
			"family",
			"label",
			"meta",
			"sequence",
			"subject",
			"title",
			"tone",
		]);
		expect(JSON.stringify(row)).not.toMatch(/sentinel|1700000000000|:\d\d/);
	});

	it("shows an unknown or malformed event neutrally without interpreting its fields", () => {
		expect(projectMissionTraceEvent({ sequence: 13, kind: "mission.teleported", lane: "main", note: "x" })).toEqual({
			sequence: "#13",
			label: "Unknown trace event",
			family: "unknown",
			depth: 0,
			tone: "idle",
			subject: "",
			meta: [],
			title: "",
		});
		expect(projectMissionTraceEvent(null).label).toBe("Unknown trace event");
		expect(projectMissionTraceEvent({ kind: "toString" }).label).toBe("Unknown trace event");
		expect(projectMissionTraceEvent({ kind: "__proto__" }).label).toBe("Unknown trace event");
	});

	it("renders only the latest rows of the replicated window", () => {
		const many = Array.from({ length: 312 }, (_, index) => ({
			...base,
			sequence: index + 1,
			kind: "turn.started",
			turnId: "t",
		}));
		const view = projectMissionTrace({ events: many });
		expect(view.total).toBe(312);
		expect(view.rows).toHaveLength(MISSION_TRACE_ROW_LIMIT);
		expect(view.rows[0]!.sequence).toBe(`#${312 - MISSION_TRACE_ROW_LIMIT + 1}`);
		expect(view.rows.at(-1)!.sequence).toBe("#312");
		expect(view.window).toBe(`Showing latest ${MISSION_TRACE_ROW_LIMIT} of 312 replicated events`);
		// The window still starts at sequence 1, so nothing was dropped.
		expect(view.truncated).toBeUndefined();
		expect(many).toHaveLength(312);
	});

	it("says when the replicated window no longer holds the start of the trace, without offering older events", () => {
		const recent = Array.from({ length: 1024 }, (_, index) => ({
			...base,
			sequence: index + 2_001,
			kind: "turn.started",
			turnId: "t",
		}));
		const view = projectMissionTrace({ events: recent });
		expect(view.truncated).toBe("Earlier worker-lifetime trace events are outside the replicated window.");
		expect(view.window).toBe(`Showing latest ${MISSION_TRACE_ROW_LIMIT} of 1024 replicated events`);
		expect(view.rows[0]!.sequence).toBe(`#${3_024 - MISSION_TRACE_ROW_LIMIT + 1}`);
		expect(view.rows.at(-1)!.sequence).toBe("#3024");
		// A short window that has already dropped its start is also marked, even when every row is shown.
		const short = projectMissionTrace({ events: recent.slice(-3) });
		expect(short.window).toBeUndefined();
		expect(short.truncated).toBe("Earlier worker-lifetime trace events are outside the replicated window.");
		expect(projectMissionTrace({ events: [] }).truncated).toBeUndefined();
	});
});

describe("Session Accounting projection", () => {
	const base: RuntimeMetricsV0 = {
		schemaVersion: "runtime-metrics.v0",
		scope: "session",
		messageCount: 47,
		usage: {
			input: 128_400,
			output: 18_700,
			cacheRead: 91_200,
			cacheWrite: 12_100,
			totalTokens: 154_800,
			cost: { input: 0.5, output: 0.25, cacheRead: 0.125, cacheWrite: 0.0625, total: 0.9375 },
		},
	};

	it("shows the reported values exactly, with grouped counts and a currency-free cost", () => {
		const view = projectRuntimeMetrics(base, new Date(2026, 0, 1, 9, 5, 7).getTime());
		expect(view.capturedAt).toBe("09:05:07");
		expect(view.rows).toEqual([
			{ label: "Persisted messages", value: "47" },
			{ label: "Input tokens", value: "128,400" },
			{ label: "Output tokens", value: "18,700" },
			{ label: "Cache read", value: "91,200" },
			{ label: "Cache write", value: "12,100" },
			{ label: "Reported total", value: "154,800" },
			{ label: "Accounted cost", value: "0.9375" },
		]);
		// The reported total is shown as reported, even though it is not the sum of the components.
		expect(base.usage.input + base.usage.output + base.usage.cacheRead + base.usage.cacheWrite).not.toBe(154_800);
	});

	it("shows reasoning and 1h cache write only when present", () => {
		const withOptional = projectRuntimeMetrics(
			{ ...base, usage: { ...base.usage, reasoning: 7_400, cacheWrite1h: 3_200 } },
			0,
		);
		expect(withOptional.rows.map((row) => row.label)).toEqual([
			"Persisted messages",
			"Input tokens",
			"Output tokens",
			"Cache read",
			"Cache write",
			"Reasoning",
			"1h cache write",
			"Reported total",
			"Accounted cost",
		]);
		expect(withOptional.rows.find((row) => row.label === "Reasoning")?.value).toBe("7,400");
		expect(withOptional.rows.find((row) => row.label === "1h cache write")?.value).toBe("3,200");
		expect(projectRuntimeMetrics(base, 0).rows.map((row) => row.label)).not.toContain("Reasoning");
		// Zero is a reported value, not an absent one.
		expect(
			projectRuntimeMetrics({ ...base, usage: { ...base.usage, reasoning: 0 } }, 0).rows.find(
				(row) => row.label === "Reasoning",
			)?.value,
		).toBe("0");
	});

	it("renders negative corrections as reported, assuming nothing is monotonic", () => {
		const view = projectRuntimeMetrics(
			{
				...base,
				usage: {
					...base.usage,
					input: -9,
					totalTokens: -1_280,
					cost: { ...base.usage.cost, total: -15.125 },
				},
			},
			0,
		);
		expect(view.rows.find((row) => row.label === "Input tokens")?.value).toBe("-9");
		expect(view.rows.find((row) => row.label === "Reported total")?.value).toBe("-1,280");
		expect(view.rows.find((row) => row.label === "Accounted cost")?.value).toBe("-15.125");
	});

	it("never rounds, adds a currency, a percentage, a lane or a context claim", () => {
		const view = projectRuntimeMetrics(
			{ ...base, usage: { ...base.usage, input: 1_234.5, cost: { ...base.usage.cost, total: 0.000123456789 } } },
			0,
		);
		expect(view.rows.find((row) => row.label === "Input tokens")?.value).toBe("1,234.5");
		expect(view.rows.find((row) => row.label === "Accounted cost")?.value).toBe("0.000123456789");
		// Tiny and huge adjustments keep their exact round-trippable form instead of rounding to 0 or -0.
		const extremes = projectRuntimeMetrics(
			{
				...base,
				usage: { ...base.usage, input: 1e-21, output: -1e-21, cacheRead: 1e21, cacheWrite: 0.1 + 0.2 },
			},
			0,
		);
		const value = (label: string) => extremes.rows.find((row) => row.label === label)?.value;
		expect(value("Input tokens")).toBe("1e-21");
		expect(value("Output tokens")).toBe("-1e-21");
		expect(value("Cache read")).toBe("1e+21");
		expect(value("Cache write")).toBe("0.30000000000000004");
		expect(Number(value("Reported total")?.replaceAll(",", ""))).toBe(base.usage.totalTokens);
		const text = JSON.stringify(view);
		expect(text).not.toMatch(/[$£€%]|main|lane|context|invoice|bill/i);
	});
});

describe("exact number formatting", () => {
	it("keeps the reported value, grouping only the integer part of plain decimals", () => {
		expect(formatExactNumber(154_800)).toBe("154,800");
		expect(formatExactNumber(-1_280)).toBe("-1,280");
		expect(formatExactNumber(1_234.5)).toBe("1,234.5");
		expect(formatExactNumber(0)).toBe("0");
		expect(formatExactNumber(999)).toBe("999");
		expect(formatExactNumber(1e-21)).toBe("1e-21");
		expect(formatExactNumber(-1e-21)).toBe("-1e-21");
		expect(formatExactNumber(1e21)).toBe("1e+21");
		expect(formatExactNumber(0.1 + 0.2)).toBe("0.30000000000000004");
	});
});

describe("Usage Activity projection", () => {
	const row = (sequence: number, overrides: Partial<UsageLedgerRowV0> = {}): UsageLedgerRowV0 => ({
		id: `u${sequence}`,
		sequence,
		adjustment: false,
		entryId: "entry-1",
		usage: {
			input: 6_500,
			output: 800,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 7_300,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
		},
		...overrides,
	});

	it("shows a neutral usage record with its sequence, reported total and currency-free cost", () => {
		expect(projectUsageRow(row(3182))).toEqual({
			sequence: "#3182",
			label: "usage record",
			totals: "7,300 total · 6,500 in · 800 out",
			cost: "cost 0.0123",
			detail: "0 cache read · 0 cache write",
		});
	});

	it("labels an adjustment, and shows negative and tiny values exactly", () => {
		const view = projectUsageRow(
			row(3191, {
				adjustment: true,
				usage: {
					input: -9,
					output: -1e-21,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: -20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: -15 },
				},
			}),
		);
		expect(view).toMatchObject({
			sequence: "#3191",
			label: "adjustment",
			totals: "-20 total · -9 in · -1e-21 out",
			cost: "cost -15",
		});
	});

	it("shows reasoning and 1h cache write only when reported", () => {
		const reported = projectUsageRow(
			row(7, {
				usage: { ...row(7).usage, cacheRead: 91_200, cacheWrite: 12_100, reasoning: 7_400, cacheWrite1h: 0 },
			}),
		);
		expect(reported.detail).toBe("91,200 cache read · 12,100 cache write · 0 1h cache write · 7,400 reasoning");
		expect(projectUsageRow(row(8)).detail).not.toMatch(/reasoning|1h/);
	});

	it("implies no time, model, provider, lane, run, operation, attempt, tool or cause, and no payload", () => {
		const hostile = {
			...row(9),
			timestamp: 1_700_000_000_000,
			model: "model-sentinel",
			provider: "provider-sentinel",
			lane: "main",
			runId: "run-sentinel",
			details: { note: "details-sentinel" },
			prompt: "prompt-sentinel",
		} as UsageLedgerRowV0;
		const view = projectUsageRow(hostile);
		expect(Object.keys(view).sort()).toEqual(["cost", "detail", "label", "sequence", "totals"]);
		const text = JSON.stringify(view);
		expect(text).not.toMatch(/sentinel|1700000000000|main|run|model|provider|lane|operation|attempt|tool|entry/i);
		expect(text).not.toMatch(/[$£€]|:\d\d/);
		expect(view.label).toBe("usage record");
	});

	it("renders the latest rows in ascending durable order, and says when earlier durable rows exist", () => {
		const rows = Array.from({ length: 30 }, (_, index) => row(10 + 3 * index));
		const view = projectUsage({
			schemaVersion: "usage-observation.v0",
			scope: "session",
			hasEarlierRows: true,
			rows,
		});
		expect(view.rows).toHaveLength(USAGE_ROW_LIMIT);
		expect(view.rows[0]?.sequence).toBe(`#${10 + 3 * 10}`);
		expect(view.rows.at(-1)?.sequence).toBe(`#${10 + 3 * 29}`);
		expect(view.window).toBe(`Showing latest ${USAGE_ROW_LIMIT} of 30 rows in the live window`);
		expect(view.earlier).toBe("Earlier durable usage rows are outside the live window.");

		// A window starting after sequence 1 is complete unless the observation says otherwise.
		const complete = projectUsage({
			schemaVersion: "usage-observation.v0",
			scope: "session",
			hasEarlierRows: false,
			rows: [row(3182)],
		});
		expect(complete.earlier).toBeUndefined();
		expect(complete.window).toBeUndefined();
		expect(JSON.stringify(complete)).not.toMatch(/lost|dropped/i);
	});
});

describe("Continuity projection", () => {
	const base = { parentId: "parent", timestamp: 1_790_000_000_000 };
	const entries: ContinuityEntryV0[] = [
		{ ...base, id: "u1", seq: 3, type: "message", role: "user", terminate: false },
		{ ...base, id: "a1", seq: 9, type: "message", role: "assistant", stopReason: "toolUse", terminate: false },
		{ ...base, id: "t1", seq: 12, type: "message", role: "toolResult", terminate: true },
		{
			...base,
			id: "c1",
			seq: 20,
			type: "compaction",
			tokensBefore: 154_800,
			retainedTailCount: 0,
			fromHook: true,
			hasSummary: true,
		},
		{ ...base, id: "b1", seq: 21, type: "branch_summary", fromId: null, fromHook: false, hasSummary: false },
		{ ...base, id: "b2", seq: 22, type: "branch_summary", fromId: "src", fromHook: true, hasSummary: true },
		{ ...base, id: "x1", seq: 30, type: "custom", customType: "app-note", hasData: true },
		{ ...base, id: "x2", seq: 31, type: "custom", customType: "", hasData: false },
	];

	function snapshot(overrides: Partial<ContinuitySnapshotV0> = {}): ContinuitySnapshotV0 {
		return {
			schemaVersion: "continuity.v0",
			lane: "main",
			tipId: "x2",
			configuration: {
				model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				thinkingLevel: "high",
				activeToolNames: ["read", "bash"],
			},
			activePath: entries,
			contextWindow: entries.slice(3),
			compaction: { entryId: "c1", tokensBefore: 154_800, retainedTailCount: 0, fromHook: true },
			counts: { activePathEntries: 8, contextWindowEntries: 5, beforeContextWindow: 3 },
			...overrides,
		};
	}

	it("projects each entry from its own structural fields only", () => {
		expect(entries.map(projectContinuityEntry)).toEqual([
			{ sequence: "#3", id: "u1", label: "Message · user", meta: [] },
			{ sequence: "#9", id: "a1", label: "Message · assistant", meta: ["stop toolUse"] },
			{ sequence: "#12", id: "t1", label: "Message · toolResult", meta: ["terminate"] },
			{
				sequence: "#20",
				id: "c1",
				label: "Compaction",
				meta: ["154,800 tokens before", "0 retained", "from hook", "summary not shown"],
			},
			{ sequence: "#21", id: "b1", label: "Branch summary", meta: ["from root", "empty summary"] },
			{ sequence: "#22", id: "b2", label: "Branch summary", meta: ["from src", "from hook", "summary not shown"] },
			{ sequence: "#30", id: "x1", label: "Custom · app-note", meta: ["data not shown"] },
			{ sequence: "#31", id: "x2", label: "Custom · ", meta: ["no data"] },
		]);
	});

	it("shows the snapshot's own configuration, counts and compaction boundary exactly", () => {
		const view = projectContinuity(snapshot(), Date.UTC(2026, 0, 1, 12, 0, 0));
		expect(view.capturedAt).toBe(formatClock(Date.UTC(2026, 0, 1, 12, 0, 0)));
		expect(view.fields).toEqual([
			{ label: "Lane", value: "main" },
			{ label: "Tip", value: "x2" },
			{ label: "Configured model", value: "anthropic/claude-sonnet-4-5" },
			{ label: "Thinking level", value: "high" },
			{ label: "Active tools", value: "read, bash" },
			{ label: "Active-path entries", value: "8" },
			{ label: "Context-window entries", value: "5" },
			{ label: "Before context window", value: "3" },
		]);
		expect(view.compaction).toEqual([
			{ label: "Entry", value: "c1" },
			{ label: "Tokens before", value: "154,800" },
			{ label: "Retained tail", value: "0" },
			{ label: "From hook", value: "yes" },
		]);
		expect(view.activePath).toEqual({ total: 8, rows: entries.map(projectContinuityEntry) });
		expect(view.contextWindow).toEqual({ total: 5, rows: entries.slice(3).map(projectContinuityEntry) });
	});

	it("shows an empty lane, no compaction and no tools as such", () => {
		const view = projectContinuity(
			snapshot({
				tipId: null,
				configuration: { model: { provider: "p", modelId: "m" }, thinkingLevel: "off", activeToolNames: [] },
				activePath: [],
				contextWindow: [],
				compaction: null,
				counts: { activePathEntries: 0, contextWindowEntries: 0, beforeContextWindow: 0 },
			}),
			0,
		);
		expect(view.fields.find(({ label }) => label === "Tip")?.value).toBe("empty");
		expect(view.fields.find(({ label }) => label === "Active tools")?.value).toBe("none");
		expect(view).not.toHaveProperty("compaction");
		expect(view.activePath).toEqual({ total: 0, rows: [] });
		expect(view.contextWindow).toEqual({ total: 0, rows: [] });
	});

	it("reports the snapshot's counts as given, never recomputed from the lists", () => {
		// Counts are the capture's facts; the cockpit does not reconcile them with the list lengths.
		const view = projectContinuity(
			snapshot({ counts: { activePathEntries: 1_234_567, contextWindowEntries: 0, beforeContextWindow: -1 } }),
			0,
		);
		expect(view.fields.slice(5)).toEqual([
			{ label: "Active-path entries", value: "1,234,567" },
			{ label: "Context-window entries", value: "0" },
			{ label: "Before context window", value: "-1" },
		]);
		expect(view.activePath.total).toBe(8);
	});

	it("renders only the latest rows of a long list and says the capture holds them all", () => {
		const long: ContinuityEntryV0[] = Array.from({ length: CONTINUITY_ENTRY_ROW_LIMIT + 5 }, (_, index) => ({
			...base,
			id: `e${index}`,
			seq: index,
			type: "message",
			role: "user",
			terminate: false,
		}));
		const view = projectContinuity(snapshot({ activePath: long }), 0);
		expect(view.activePath.total).toBe(CONTINUITY_ENTRY_ROW_LIMIT + 5);
		expect(view.activePath.rows).toHaveLength(CONTINUITY_ENTRY_ROW_LIMIT);
		expect(view.activePath.rows[0]?.id).toBe("e5");
		expect(view.activePath.rows.at(-1)?.id).toBe(`e${CONTINUITY_ENTRY_ROW_LIMIT + 4}`);
		expect(view.activePath.window).toBe(
			`Showing latest ${CONTINUITY_ENTRY_ROW_LIMIT} of ${CONTINUITY_ENTRY_ROW_LIMIT + 5} captured entries`,
		);
		expect(view.contextWindow.window).toBeUndefined();
	});

	it("never renders payload fields, timestamps, parents or joins, even when a value carries them", () => {
		// A hostile or future snapshot with payload fields beside the schema's: none may reach the rendered view.
		const hostile = entries.map((entry) => ({
			...entry,
			content: "PAYLOAD_SENTINEL",
			summary: "PAYLOAD_SENTINEL",
			data: { secret: "PAYLOAD_SENTINEL" },
			arguments: "PAYLOAD_SENTINEL",
			message: { content: "PAYLOAD_SENTINEL" },
		})) as unknown as ContinuityEntryV0[];
		const view = projectContinuity(
			snapshot({ activePath: hostile, contextWindow: hostile, ...({ prompt: "PAYLOAD_SENTINEL" } as object) }),
			0,
		);
		const rendered = JSON.stringify(view);
		expect(rendered).not.toContain("PAYLOAD_SENTINEL");
		expect(rendered).not.toContain("parent");
		expect(rendered).not.toContain(String(base.timestamp));
		expect(rendered).not.toMatch(/run|turn|usage|cost|occupan|remember|provider-visible/i);
	});

	it("shows an unknown entry type neutrally rather than interpreting it", () => {
		const unknown = {
			...base,
			id: "q",
			seq: 1,
			type: "future",
			payload: "PAYLOAD_SENTINEL",
		} as unknown as ContinuityEntryV0;
		expect(projectContinuityEntry(unknown)).toEqual({ sequence: "#1", id: "q", label: "Unknown entry", meta: [] });
	});
});

describe("Runtime Profile projection", () => {
	const ALL: RuntimeProfileV0["capabilities"] = [
		"endophasia.session-overview.v0",
		"endophasia.mission-trace.v0",
		"endophasia.runtime-metrics.v0",
		"endophasia.operation-outcome.v0",
		"endophasia.usage.v0",
		"endophasia.continuity.v0",
	];

	function profile(overrides: Partial<RuntimeProfileV0> = {}): RuntimeProfileV0 {
		return {
			schemaVersion: "runtime-profile.v0",
			scope: "session-worker-lifetime",
			runtimeFamily: "pi",
			adapterProfileId: "endophasia.pi-standard.v0",
			capabilities: ALL,
			...overrides,
		};
	}

	/** Each group's rows as [label, status] pairs. */
	function statuses(view: ReturnType<typeof projectRuntimeProfile>) {
		return view.groups.map((group) => [group.title, group.rows.map((row) => [row.label, row.status])]);
	}

	it("shows the standard Pi profile: family, adapter profile, scope and all six capabilities in two groups", () => {
		const view = projectRuntimeProfile(profile());
		expect(view).toMatchObject({
			runtimeFamily: "pi",
			adapterProfileId: "endophasia.pi-standard.v0",
			scope: "Session worker lifetime",
			advertised: "6 of 6 Endophasia v0 capabilities advertised",
			unrecognized: [],
		});
		expect(view).not.toHaveProperty("schemaNote");
		expect(statuses(view)).toEqual([
			[
				"Runtime Observation Boundary v0",
				[
					["Mission Trace", "advertised"],
					["Runtime Metrics", "advertised"],
					["Operation Outcome", "advertised"],
					["Usage", "advertised"],
				],
			],
			[
				"Outside that boundary today",
				[
					["Session Overview", "advertised"],
					["Continuity", "advertised"],
				],
			],
		]);
		expect(view.groups[0]?.rows.map((row) => row.id)).toEqual([
			"endophasia.mission-trace.v0",
			"endophasia.runtime-metrics.v0",
			"endophasia.operation-outcome.v0",
			"endophasia.usage.v0",
		]);
	});

	it("shows an omitted known capability only as not advertised", () => {
		const view = projectRuntimeProfile(
			profile({ capabilities: ["endophasia.mission-trace.v0", "endophasia.usage.v0"] }),
		);
		expect(view.advertised).toBe("2 of 6 Endophasia v0 capabilities advertised");
		expect(statuses(view)).toEqual([
			[
				"Runtime Observation Boundary v0",
				[
					["Mission Trace", "advertised"],
					["Runtime Metrics", "not advertised"],
					["Operation Outcome", "not advertised"],
					["Usage", "advertised"],
				],
			],
			[
				"Outside that boundary today",
				[
					["Session Overview", "not advertised"],
					["Continuity", "not advertised"],
				],
			],
		]);
		expect(projectRuntimeProfile(profile({ capabilities: [] })).advertised).toBe(
			"0 of 6 Endophasia v0 capabilities advertised",
		);
	});

	it("never words absence, or the boundary groups, more strongly than not advertised", () => {
		const rendered = JSON.stringify([
			projectRuntimeProfile(profile({ capabilities: [] })),
			projectRuntimeProfile(profile()),
			projectRuntimeProfile({}),
		]);
		expect(rendered).not.toMatch(/unsupported|incompatible|unavailable|impossible|fail|pi-only|non-portable|cannot/i);
	});

	it("derives no capability from the runtime family or the adapter profile ID", () => {
		const subset = ["endophasia.usage.v0"] as RuntimeProfileV0["capabilities"];
		const expected = statuses(projectRuntimeProfile(profile({ capabilities: subset })));
		for (const overrides of [
			{ runtimeFamily: "pi" },
			{ runtimeFamily: "prime" },
			{ runtimeFamily: "anything" },
			{ adapterProfileId: "endophasia.pi-standard.v0" },
			{ adapterProfileId: "endophasia.prime-full.v0" },
		]) {
			expect(statuses(projectRuntimeProfile(profile({ ...overrides, capabilities: subset })))).toEqual(expected);
		}
		// The standard family and adapter ID with an empty list advertise nothing.
		expect(
			projectRuntimeProfile(profile({ capabilities: [] }))
				.groups.flatMap((group) => group.rows)
				.every((row) => row.status === "not advertised"),
		).toBe(true);
	});

	it("shows unknown or hostile identifiers neutrally, without a label or a known status", () => {
		const hostile = {
			...profile({ capabilities: ["endophasia.usage.v0"] }),
			capabilities: [
				"endophasia.usage.v0",
				"endophasia.acp.v0",
				"endophasia.acp.v0",
				"__proto__",
				"toString",
				"x".repeat(1_000),
				7,
				null,
				{ id: "endophasia.continuity.v0" },
			],
		};
		const view = projectRuntimeProfile(hostile);
		expect(view.advertised).toBe("1 of 6 Endophasia v0 capabilities advertised");
		expect(view.unrecognized).toEqual(["endophasia.acp.v0", "__proto__", "toString", `${"x".repeat(200)}…`]);
		expect(view.groups.flatMap((group) => group.rows).find((row) => row.label === "Continuity")?.status).toBe(
			"not advertised",
		);
	});

	it("bounds how many unrecognized identifiers it projects, and says how many were left out", () => {
		const many = Array.from({ length: 50_000 }, (_, index) => `x.${index}`);
		const view = projectRuntimeProfile({
			...profile({ capabilities: ["endophasia.usage.v0"] }),
			capabilities: ["endophasia.usage.v0", ...many, ...many],
		});
		expect(view.unrecognized).toEqual(many.slice(0, UNRECOGNIZED_CAPABILITY_ROW_LIMIT));
		expect(view.unrecognizedWindow).toBe(
			`Showing first ${UNRECOGNIZED_CAPABILITY_ROW_LIMIT} of 50000 unrecognized identifiers`,
		);
		expect(view.advertised).toBe("1 of 6 Endophasia v0 capabilities advertised");
		const atLimit = projectRuntimeProfile({
			...profile(),
			capabilities: many.slice(0, UNRECOGNIZED_CAPABILITY_ROW_LIMIT),
		});
		expect(atLimit.unrecognized).toHaveLength(UNRECOGNIZED_CAPABILITY_ROW_LIMIT);
		expect(atLimit).not.toHaveProperty("unrecognizedWindow");
	});

	it("survives a malformed profile without crashing or inventing values", () => {
		for (const malformed of [undefined, null, 7, "pi", [], {}, { capabilities: "endophasia.usage.v0" }]) {
			const view = projectRuntimeProfile(malformed);
			expect(view.runtimeFamily).toBe("not reported");
			expect(view.adapterProfileId).toBe("not reported");
			expect(view.advertised).toBe("0 of 6 Endophasia v0 capabilities advertised");
			expect(view.schemaNote).toBe("Unrecognized schema version · none");
		}
		expect(
			projectRuntimeProfile({ ...profile(), schemaVersion: "runtime-profile.v9", scope: "session" }),
		).toMatchObject({ schemaNote: "Unrecognized schema version · runtime-profile.v9", scope: "session" });
	});
});
