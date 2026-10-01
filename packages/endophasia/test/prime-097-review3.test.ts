// Third Codex review: hostile mutations are rejected independently of cross-run consistency.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ResearchAcpClient } from "../research/prime-conformance/acp-client.ts";
import { ACP_NAMESPACE } from "../research/prime-conformance/acp-evidence.ts";
import { acpPrivacyShapeProblems } from "../research/prime-conformance/acp-validation.ts";
import {
	assessPrime097,
	buildPrime097Report,
	publishPrime097,
	readAcpFixtures,
} from "../research/prime-conformance/comparison.ts";
import { writePrime097Diagnostics } from "../research/prime-conformance/diagnostics.ts";
import { rpcPrivacyShapeProblems } from "../research/prime-conformance/privacy-shape.ts";
import { readPrimeFixturesV0 } from "../research/prime-conformance/report.ts";
import { baseline, controls } from "./prime-097-controls.ts";

describe("PR #26 pinned instrument and complete provenance", () => {
	it("withdraws every boundary for a uniformly forged instrument hash", () => {
		const { rpc, acp } = controls();
		for (const run of [...rpc, ...acp]) Object.assign(run.provenance, { researchHash: "0".repeat(64) });
		expect(assessPrime097(rpc, acp).unpublishable.length).toBeGreaterThan(0);
		expect(
			buildPrime097Report(rpc, acp, baseline).capabilities.every(
				(c) => c.rpc.basis === "unverified" && c.acp.basis === "unverified",
			),
		).toBe(true);
		const dir = mkdtempSync(join(tmpdir(), "prime-forged-instrument-"));
		try {
			expect(() => publishPrime097(join(dir, "fixtures"), rpc, acp, baseline)).toThrow("refused");
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each(["source", "version", "build", "mode", "generatedBy", "probeVersion", "platform", "node", "scenario"])(
		"rejects absent/empty/nonstring required %s before persistence",
		(key) => {
			for (const next of [undefined, "", 17]) {
				const { rpc, acp } = controls();
				for (const run of [...rpc, ...acp]) {
					if (next === undefined) Reflect.deleteProperty(run.provenance, key);
					else Reflect.set(run.provenance, key, next);
				}
				expect(rpc.flatMap(rpcPrivacyShapeProblems).length).toBeGreaterThan(0);
				expect(acp.flatMap(acpPrivacyShapeProblems).length).toBeGreaterThan(0);
				expect(assessPrime097(rpc, acp).invalid.length).toBeGreaterThan(0);
				const dir = mkdtempSync(join(tmpdir(), "prime-required-provenance-"));
				try {
					expect(() => writePrime097Diagnostics(join(dir, ".artifacts"), rpc, acp, baseline)).toThrow(
						"nothing written",
					);
					expect(() => publishPrime097(join(dir, "fixtures"), rpc, acp, baseline)).toThrow("refused");
					expect(readdirSync(dir)).toEqual([]);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}
		},
	);
	it("published complete provenance reloads both boundaries and reproduces its report", () => {
		const { rpc, acp } = controls();
		const dir = mkdtempSync(join(tmpdir(), "prime-reload-"));
		try {
			publishPrime097(dir, rpc, acp, baseline);
			const r = readPrimeFixturesV0(join(dir, "0.9.7", "rpc"));
			const a = readAcpFixtures(join(dir, "0.9.7", "acp"));
			expect(assessPrime097(r, a)).toEqual({ invalid: [], unpublishable: [] });
			expect(`${JSON.stringify(buildPrime097Report(r, a, baseline), null, "\t")}\n`).toBe(
				readFileSync(join(dir, "0.9.7", "report.json"), "utf8"),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("PR #26 ACP inventories must substantiate their own retained observations", () => {
	it.each(["all keys", "sessionUpdate", "_meta", "content", "messageId", "toolCallId", "kind", "status", "duplicate"])(
		"rejects missing/duplicate update inventory: %s",
		(key) => {
			const { rpc, acp } = controls();
			for (const run of acp)
				for (const u of run.updates) {
					if (key === "all keys") u.keys = [];
					else if (key === "duplicate") u.keys.push(u.keys[0]!);
					else u.keys = u.keys.filter((k) => k !== key);
				}
			expect(
				assessPrime097(rpc, acp).invalid.some((p) =>
					p.includes("update keys contradict retained wire observations"),
				),
			).toBe(true);
		},
	);
	it.each(["toolCallId", "toolKind", "status", "messageId"] as const)(
		"rejects a %s key with its retained value deleted",
		(field) => {
			const { rpc, acp } = controls();
			for (const run of acp) for (const u of run.updates) Reflect.deleteProperty(u, field);
			expect(
				assessPrime097(rpc, acp).invalid.some((p) =>
					p.includes("update keys contradict retained wire observations"),
				),
			).toBe(true);
		},
	);
	it.each(["fields", "name", "version", "namespace", "parent", "boolean parent", "duplicate"])(
		"rejects uniformly contradictory initialize %s",
		(attack) => {
			const { rpc, acp } = controls();
			for (const run of acp) {
				const init = run.initialize!;
				if (attack === "fields") init.capabilityFields = [];
				if (attack === "name" || attack === "version")
					init.agentInfoKeys = init.agentInfoKeys.filter((k) => k !== attack);
				if (attack === "namespace") init.metaNamespaces = init.metaNamespaces.filter((k) => k !== ACP_NAMESPACE);
				if (attack === "parent")
					init.capabilityFields = init.capabilityFields.filter((k) => k !== "promptCapabilities");
				if (attack === "boolean parent") init.capabilityFlags.promptCapabilities = true;
				if (attack === "duplicate") init.capabilityFields.push(init.capabilityFields[0]!);
			}
			expect(
				assessPrime097(rpc, acp).invalid.some(
					(p) => p.includes("inventories contradict") || p.includes("boolean/group traversal"),
				),
			).toBe(true);
		},
	);
	it("preserves payload-only wire keys and legitimate empty capability groups", () => {
		const { rpc, acp } = controls();
		for (const run of acp) {
			expect(run.initialize!.capabilityFields).toContain("sessionCapabilities.close");
			expect(run.initialize!.capabilityFlags["sessionCapabilities.close"]).toBeUndefined();
		}
		const u = acp.find((r) => r.provenance.scenario === "tool-run")!.updates.find((u) => u.kind === "tool_call")!;
		expect(u.keys).toContain("rawInput");
		expect(assessPrime097(rpc, acp)).toEqual({ invalid: [], unpublishable: [] });
	});
	it("keeps structurally safe contradictory inventories available as diagnostics", () => {
		const { rpc, acp } = controls();
		acp[0]!.updates[0]!.keys = [];
		expect(acpPrivacyShapeProblems(acp[0])).toEqual([]);
		expect(assessPrime097(rpc, acp).invalid.length).toBeGreaterThan(0);
		const dir = mkdtempSync(join(tmpdir(), "prime-inventory-diagnostic-"));
		try {
			writePrime097Diagnostics(join(dir, ".artifacts"), rpc, acp, baseline);
			expect(readdirSync(dir)).toEqual([".artifacts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("PR #26 ACP bounded drain", () => {
	it("settles close and invalidates the protocol when a detached descendant holds stdout", async () => {
		const c = new ResearchAcpClient({
			command: process.execPath,
			args: [fileURLToPath(new URL("./fixtures/prime/fake-acp-server.mjs", import.meta.url)), "descendant-stdout"],
			cwd: process.cwd(),
			env: { PATH: process.env.PATH },
			onUpdate: () => {
				throw new Error("unexpected update");
			},
		});
		let pid: number | undefined;
		try {
			const result = (await c.request("initialize", {})) as { descendantPid: number };
			pid = result.descendantPid;
			expect(Number.isSafeInteger(pid)).toBe(true);
			const start = performance.now();
			const closing = c.close();
			expect(c.close()).toBe(closing);
			expect((await closing).code).toBe(0);
			expect(performance.now() - start).toBeLessThan(5_000);
			expect(c.drainTimedOut).toBe(true);
			expect(c.protocolErrors).toContain("ACP stdout did not drain after process exit");
			expect(() => process.kill(pid!, 0)).not.toThrow();
			await expect(c.notify("session/cancel", {})).rejects.toThrow("connection closed");
			const { rpc, acp } = controls();
			acp[0]!.protocolErrors.push(...c.protocolErrors.map(() => "ACP protocol failed"));
			expect(acpPrivacyShapeProblems(acp[0])).toEqual([]);
			expect(assessPrime097(rpc, acp).invalid).toEqual(["ACP protocol failed"]);
		} finally {
			if (pid !== undefined) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* Already ended: only this test's own child is targeted. */
				}
			}
			await c.close();
		}
	}, 7_000);
});
