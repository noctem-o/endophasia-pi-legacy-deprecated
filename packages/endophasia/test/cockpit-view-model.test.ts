import { describe, expect, it } from "vitest";
import type { EntryView } from "../cockpit/view-model.ts";
import {
	boundText,
	formatClock,
	formatStructuredPreview,
	PREVIEW_LIMIT,
	projectAttachment,
	projectConnection,
	projectMessage,
	projectModels,
	projectOperation,
	projectQueues,
	projectSessionOverview,
	projectSessions,
	projectTranscriptEntry,
	projectVisibleTranscript,
} from "../cockpit/view-model.ts";
import type { SessionOverviewV0 } from "../src/session-overview.ts";

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
