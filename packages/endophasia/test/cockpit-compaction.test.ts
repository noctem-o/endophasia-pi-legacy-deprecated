import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session } from "../../agent/src/harness/session/types.ts";
import { projectVisibleTranscript } from "../cockpit/view-model.ts";

const HIDDEN_SENTINEL = "SECRET_SENTINEL_retained_hidden_5b1e";
const sessions: Session[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("Standard Cockpit after a real compaction", () => {
	it("shows the messages a compaction retained, under the same display rules", async () => {
		const session = new StorageBackedSession(
			{ id: "compacted", createdAt: 1, storageVersion: 1 },
			new MemoryStorage(),
		);
		sessions.push(session);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await lane.appendMessage({ role: "user", content: "retained-user-message", timestamp: 1 }, BACKGROUND_CONTEXT);
		await lane.appendMessage(
			{ role: "custom", customType: "plan-mode-context", content: HIDDEN_SENTINEL, display: false, timestamp: 2 },
			BACKGROUND_CONTEXT,
		);
		faux.setResponses([fauxAssistantMessage("compaction-summary")]);
		expect(await lane.compact(undefined, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
		await lane.appendMessage({ role: "user", content: "after-compaction", timestamp: 3 }, BACKGROUND_CONTEXT);

		const handle = await lane.watch(BACKGROUND_CONTEXT);
		const snapshot = JSON.parse(JSON.stringify(handle.snapshot)) as typeof handle.snapshot;
		handle.unsubscribe();

		// Pi's main-lane transcript starts at the compaction; retained messages exist only in its retainedTail.
		expect(snapshot.transcript.map((entry) => entry.type)).toEqual(["compaction", "message"]);
		expect(JSON.stringify(snapshot.transcript)).not.toMatch(/"type":"message"[^}]*retained-user-message/);

		const visible = projectVisibleTranscript(snapshot.transcript);
		expect(visible.map(({ view }) => [view.kind, view.meta.includes("retained by compaction")])).toEqual([
			["compaction", false],
			["user", true],
			["user", false],
		]);
		expect(visible[1]!.view.blocks).toEqual([
			{ kind: "text", text: { text: "retained-user-message", truncated: false, totalLength: 21 } },
		]);
		expect(JSON.stringify(visible.map(({ view }) => view))).not.toContain(HIDDEN_SENTINEL);
	});
});
