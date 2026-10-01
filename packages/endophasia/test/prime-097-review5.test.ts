// PR #26 review 5376872017: executable serializers, exact capture pin, durable inventories, exchange, linked builds.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acpPrivacyShapeProblems } from "../research/prime-conformance/acp-validation.ts";
import { AUDITED_INSTRUMENT_097 } from "../research/prime-conformance/audited.ts";
import { assessPrime097, buildPrime097Report, publishPrime097 } from "../research/prime-conformance/comparison.ts";
import { writePrime097Diagnostics } from "../research/prime-conformance/diagnostics.ts";
import { rpcPrivacyShapeProblems } from "../research/prime-conformance/privacy-shape.ts";
import { hashBuildOutputV0 } from "../research/prime-conformance/probe.ts";
import { installReferenceDirectory } from "../research/prime-conformance/reference-swap.ts";
import { baseline, controls } from "./prime-097-controls.ts";

const slots = [
	"rpc set",
	"acp set",
	"baseline set",
	"rpc run",
	"acp run",
	"baseline run",
	"RPC failures",
	"ACP failures",
	"baseline failures",
	"usage cost",
];
describe("PR #26 plain data before all persistence and assessment", () => {
	it.each(
		slots.flatMap((slot) =>
			["hidden serializer", "inherited serializer", "getter", "symbol", "proxy"].map((attack) => ({ slot, attack })),
		),
	)("rejects $attack on $slot without invoking caller code", ({ slot, attack }) => {
		const { rpc, acp } = controls();
		const b = structuredClone(baseline);
		let parent: object;
		let key: string | number;
		const inputs = { rpc, acp, baseline: b };
		if (slot.endsWith(" set")) {
			parent = inputs;
			key = slot.split(" ")[0]!;
		} else if (slot.endsWith(" run")) {
			parent = slot.startsWith("rpc") ? rpc : slot.startsWith("acp") ? acp : b;
			key = 0;
		} else if (slot === "usage cost") {
			parent = acp.find((r) => r.provenance.scenario === "simple")!.files[0]!.find((e) => e.role === "assistant")!
				.usage!;
			key = "cost";
		} else {
			parent = slot.startsWith("RPC") ? rpc[0]! : slot.startsWith("ACP") ? acp[0]! : b[0]!;
			key = "failures";
		}
		const original = Reflect.get(parent, key) as object;
		let invocations = 0;
		const hostile = () => {
			invocations++;
			return ["private_customer_value"];
		};
		if (attack === "hidden serializer") Object.defineProperty(original, "toJSON", { value: hostile });
		if (attack === "inherited serializer")
			Object.setPrototypeOf(
				original,
				Object.create(Object.getPrototypeOf(original), { toJSON: { value: hostile } }),
			);
		if (attack === "getter") Object.defineProperty(original, "privateField", { enumerable: true, get: hostile });
		if (attack === "symbol") Object.defineProperty(original, Symbol("private_customer_value"), { value: hostile });
		if (attack === "proxy")
			Reflect.set(
				parent,
				key,
				new Proxy(original, {
					ownKeys() {
						hostile();
						return Reflect.ownKeys(original);
					},
				}),
			);
		const dir = mkdtempSync(join(tmpdir(), "prime-plain-boundary-"));
		try {
			expect(() =>
				writePrime097Diagnostics(join(dir, ".artifacts"), inputs.rpc, inputs.acp, inputs.baseline),
			).toThrow("nothing written");
			expect(() => publishPrime097(join(dir, "reference"), inputs.rpc, inputs.acp, inputs.baseline)).toThrow(
				"refused",
			);
			if (!slot.startsWith("baseline"))
				expect(assessPrime097(inputs.rpc, inputs.acp).invalid.length).toBeGreaterThan(0);
			expect(invocations).toBe(0);
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("preserves existing diagnostic and reference bytes on the reported failures.toJSON attack", () => {
		const { rpc, acp } = controls();
		const dir = mkdtempSync(join(tmpdir(), "prime-existing-plain-"));
		try {
			writePrime097Diagnostics(join(dir, ".artifacts"), rpc, acp, baseline);
			publishPrime097(dir, rpc, acp, baseline);
			const paths = [
				join(dir, ".artifacts", "evidence.json"),
				join(dir, ".artifacts", "report.json"),
				join(dir, "0.9.7", "report.json"),
			];
			const before = paths.map((path) => readFileSync(path));
			Object.defineProperty(acp[0]!.failures, "toJSON", { value: () => ["private_customer_value"] });
			expect(acpPrivacyShapeProblems(acp[0]).length).toBeGreaterThan(0);
			expect(() => writePrime097Diagnostics(join(dir, ".artifacts"), rpc, acp, baseline)).toThrow("nothing written");
			expect(() => publishPrime097(dir, rpc, acp, baseline)).toThrow("refused");
			expect(paths.map((path) => readFileSync(path))).toEqual(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("PR #26 exact capture commit is a publication dependency", () => {
	it.each(["0".repeat(40), "f".repeat(40), "08068242aa5e115ea947e996b88b11107eea9a0d"])(
		"withdraws uniformly forged capture %s despite matching instrument hash",
		(endophasiaCommit) => {
			const { rpc, acp } = controls();
			expect(endophasiaCommit).not.toBe(AUDITED_INSTRUMENT_097.endophasiaCommit);
			for (const run of [...rpc, ...acp]) Object.assign(run.provenance, { endophasiaCommit });
			expect(rpc.flatMap(rpcPrivacyShapeProblems)).toEqual([]);
			expect(acp.flatMap(acpPrivacyShapeProblems)).toEqual([]);
			expect(assessPrime097(rpc, acp).unpublishable.length).toBeGreaterThan(0);
			expect(
				buildPrime097Report(rpc, acp, baseline).capabilities.every(
					(c) => c.rpc.basis === "unverified" && c.acp.basis === "unverified" && c.durable.basis === "unverified",
				),
			).toBe(true);
			const dir = mkdtempSync(join(tmpdir(), "prime-capture-pin-"));
			try {
				expect(() => publishPrime097(dir, rpc, acp, baseline)).toThrow("refused");
				expect(readdirSync(dir)).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

const durableKeys = ["all", "duplicate", "type", "id", "parentId", "message", "firstKeptEntryId", "usage"];
describe("PR #26 durable inventories substantiate retained wire fields", () => {
	it.each(durableKeys)("rejects ACP inventory attack %s", (key) => {
		const { rpc, acp } = controls();
		for (const run of acp)
			for (const entry of run.files.flat()) {
				if (key === "all") Object.assign(entry, { keys: [] });
				else if (key === "duplicate") Object.assign(entry, { keys: [...entry.keys, entry.keys[0]!] });
				else Object.assign(entry, { keys: entry.keys.filter((k) => k !== key) });
			}
		expect(acp.flatMap(acpPrivacyShapeProblems)).toEqual([]);
		expect(assessPrime097(rpc, acp).invalid.some((p) => p.includes("durable key inventory contradicts"))).toBe(true);
	});
	it("accepts reversed unique inventories including payload keys without values", () => {
		const { rpc, acp } = controls();
		for (const run of acp)
			for (const entry of run.files.flat()) Object.assign(entry, { keys: [...entry.keys].reverse() });
		expect(assessPrime097(rpc, acp)).toEqual({ invalid: [], unpublishable: [] });
	});
	it("rejects a summary usage wire key with its retained usage deleted", () => {
		const { rpc, acp } = controls();
		for (const entry of acp.find((r) => r.provenance.scenario === "compaction")!.files.flat())
			if (entry.type === "compaction") Reflect.deleteProperty(entry, "usage");
		expect(assessPrime097(rpc, acp).invalid.some((p) => p.includes("durable usage key contradicts"))).toBe(true);
	});
});

describe("PR #26 build roots cannot redirect execution outside checkout", () => {
	it.each(["checkout", "packages", "package", "dist", "nested", "file", "dangling dist"])(
		"rejects linked %s even with identical audited bytes",
		(slot) => {
			const dir = mkdtempSync(join(tmpdir(), "prime-build-links-"));
			try {
				const root = join(dir, "checkout");
				const dist = join(root, "packages", "agent", "dist");
				mkdirSync(join(dist, "nested"), { recursive: true });
				writeFileSync(join(dist, "nested", "index.js"), "export const audited = true;\n");
				expect(hashBuildOutputV0(root)).toMatch(/^[0-9a-f]{64}$/);
				const path =
					slot === "checkout"
						? root
						: slot === "packages"
							? join(root, "packages")
							: slot === "package"
								? join(root, "packages", "agent")
								: slot === "dist" || slot === "dangling dist"
									? dist
									: slot === "nested"
										? join(dist, "nested")
										: join(dist, "nested", "index.js");
				const external = join(dir, "external");
				if (slot !== "dangling dist") cpSync(path, external, { recursive: true });
				rmSync(path, { recursive: true, force: true });
				symlinkSync(external, path);
				expect(hashBuildOutputV0(root)).toBeUndefined();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

const swapChild = fileURLToPath(new URL("./fixtures/prime/fake-reference-swap.mjs", import.meta.url));
function stagePair(dir: string) {
	const staging = join(dir, "staging");
	const target = join(dir, "0.9.7");
	for (const [path, label] of [
		[staging, "new"],
		[target, "old"],
	] as const) {
		mkdirSync(path);
		writeFileSync(join(path, "report.json"), `${JSON.stringify(label)}\n`);
		for (let i = 0; i < 27; i++) writeFileSync(join(path, `${i}.json`), `${JSON.stringify(label)}\n`);
	}
	return { staging, target };
}
describe("PR #26 atomic reference exchange", () => {
	it.each(["before", "after"])("SIGKILL %s exchange leaves a complete visible reference", async (mode) => {
		const dir = mkdtempSync(join(tmpdir(), "prime-swap-crash-"));
		const { staging, target } = stagePair(dir);
		const child = spawn(process.execPath, [swapChild, mode, staging, target], { stdio: ["ignore", "pipe", "pipe"] });
		const closed = once(child, "close");
		try {
			await once(child.stdout!, "data");
			child.kill("SIGKILL");
			await closed;
			expect(readdirSync(target).length).toBe(28);
			for (const name of readdirSync(target))
				expect(readFileSync(join(target, name), "utf8")).toBe(
					`${JSON.stringify(mode === "before" ? "old" : "new")}\n`,
				);
		} finally {
			child.kill("SIGKILL");
			await closed;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("concurrent pathname readers never see an absent or partial report during repeated exchanges", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-swap-reader-"));
		const { staging, target } = stagePair(dir);
		const child = spawn(process.execPath, [swapChild, "reader", staging, target], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const closed = once(child, "close");
		let output = "";
		child.stdout!.on("data", (data: Buffer) => {
			output += data.toString();
		});
		try {
			await once(child.stdout!, "data");
			for (let i = 0; i < 25; i++) installReferenceDirectory(staging, target);
			await closed;
			const result = JSON.parse(output.trim().split("\n").at(-1)!) as { reads: number; failures: string[] };
			expect(result.reads).toBeGreaterThan(0);
			expect(result.failures).toEqual([]);
		} finally {
			child.kill("SIGKILL");
			await closed;
			rmSync(dir, { recursive: true, force: true });
		}
	}, 5_000);
});
