import type { Context, Session, UsageRow, UsageScan } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createSessionUsageReader } from "../src/experimental/session-worker.ts";

describe("Session usage reader for trusted host facets", () => {
	it("forwards scanUsage faithfully and exposes nothing else of the Session", async () => {
		const rows = [{ id: "u1", seq: 3 }] as unknown as UsageRow[];
		const session = {
			scanUsage: vi.fn(async function (this: unknown, _query: UsageScan, _context: Context) {
				// The Session method still runs with the Session as its receiver.
				expect(this).toBe(session);
				return rows;
			}),
			appendMessage: vi.fn(),
			mutate: vi.fn(),
			close: vi.fn(),
			metadata: { cwd: "/secret" },
		};
		const reader = createSessionUsageReader(session as unknown as Session);
		const query: UsageScan = { order: "desc", limit: 2 };
		await expect(reader.scanUsage(query, BACKGROUND_CONTEXT)).resolves.toBe(rows);
		expect(session.scanUsage).toHaveBeenCalledExactlyOnceWith(query, BACKGROUND_CONTEXT);

		expect(reader).not.toBe(session);
		expect(Object.keys(reader)).toEqual(["scanUsage"]);
		expect(Object.getPrototypeOf(reader)).toBe(Object.prototype);
		expect(Object.isFrozen(reader)).toBe(true);
		const untyped = reader as unknown as Record<string, unknown>;
		for (const property of ["appendMessage", "mutate", "close", "metadata"]) {
			expect(untyped[property]).toBeUndefined();
		}
		expect(() => {
			untyped.appendMessage = session.appendMessage;
		}).toThrow(TypeError);
		expect(session.appendMessage).not.toHaveBeenCalled();
		expect(session.mutate).not.toHaveBeenCalled();
	});

	it("propagates a failed read", async () => {
		const reader = createSessionUsageReader({
			scanUsage: async () => {
				throw new Error("usage read failed");
			},
		});
		await expect(reader.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).rejects.toThrow("usage read failed");
	});
});
