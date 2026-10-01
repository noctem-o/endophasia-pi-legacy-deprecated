// PR #27: mechanical trust boundaries, with no runtime or provider execution.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertDigest, canonicalJson, sha256 } from "../research/conformance/json.ts";
import { orderScenarios } from "../research/conformance/order.ts";
import { publishReference, verifyReference } from "../research/conformance/reference.ts";
import { cleanRepositoryIdentity, sourceDigestAtCommit } from "../research/conformance/repository.ts";

const input = [
	{ path: "report.json", bytes: canonicalJson({ value: "new" }) },
	{ path: "runs/a.json", bytes: "{}\n" },
];
const manifest = input.map((m) => ({ path: m.path, sha256: sha256(m.bytes) }));

describe("Conformance Lab plain JSON boundary", () => {
	it.each([
		"toJSON",
		"hidden toJSON",
		"getter",
		"hidden",
		"symbol",
		"prototype",
		"array property",
		"sparse",
		"proxy",
		"cycle",
		"undefined",
		"nonfinite",
		"bigint",
	])("rejects %s before caller code or writes", (attack) => {
		let calls = 0;
		const payload: Record<string, unknown> = { safe: true };
		let value: unknown = payload;
		const spy = () => {
			calls++;
			return "private";
		};
		if (attack === "toJSON") payload.toJSON = spy;
		if (attack === "hidden toJSON") Object.defineProperty(payload, "toJSON", { value: spy });
		if (attack === "getter") Object.defineProperty(payload, "secret", { get: spy, enumerable: true });
		if (attack === "hidden") Object.defineProperty(payload, "secret", { value: "private" });
		if (attack === "symbol") Object.assign(payload, { [Symbol("secret")]: "private" });
		if (attack === "prototype") Object.setPrototypeOf(payload, { toJSON: spy });
		if (attack === "array property") value = Object.assign([1], { secret: "private" });
		if (attack === "sparse") value = Array(2);
		if (attack === "proxy")
			value = new Proxy(payload, {
				ownKeys() {
					calls++;
					return [];
				},
			});
		if (attack === "cycle") payload.self = payload;
		if (attack === "undefined") payload.absent = undefined;
		if (attack === "nonfinite") payload.number = Infinity;
		if (attack === "bigint") payload.number = 1n;
		expect(() => canonicalJson(value)).toThrow();
		const dir = mkdtempSync(join(tmpdir(), "lab-json-"));
		try {
			expect(() => publishReference(dir, "reference", value, input)).toThrow();
			expect(() => publishReference(dir, "reference", manifest, value)).toThrow();
			expect(readdirSync(dir)).toEqual([]);
			expect(calls).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("canonicalizes keys without prototype assignment, preserving arrays and input", () => {
		const a = JSON.parse('{"z":[2,1],"__proto__":{"private":false},"a":1}');
		const before = JSON.stringify(a);
		expect(canonicalJson(a)).toBe(canonicalJson({ a: 1, ...a }));
		expect(JSON.parse(canonicalJson(a))).toEqual(a);
		expect(JSON.stringify(a)).toBe(before);
		expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
		expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
	it.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), `${"a".repeat(64)}\n`, null, 1])(
		"refuses malformed digest %s",
		(value) => expect(() => assertDigest(value)).toThrow(),
	);
});

describe("Conformance Lab complete deterministic scenario sets", () => {
	it("uses declared order independently of filesystem order", () => {
		const dir = mkdtempSync(join(tmpdir(), "lab-order-"));
		try {
			for (const id of ["third", "first", "second"]) writeFileSync(join(dir, `${id}.json`), canonicalJson({ id }));
			const runs = readdirSync(dir).map(
				(name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as { id: string },
			);
			for (const list of [runs, [...runs].reverse()])
				expect(orderScenarios(list, ["second", "third", "first"], (r) => r.id).map((r) => r.id)).toEqual([
					"second",
					"third",
					"first",
				]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each(["missing", "duplicate run", "duplicate declaration", "unknown", "empty"])(
		"refuses %s scenarios",
		(attack) => {
			const runs = [{ id: "a" }, { id: "b" }];
			let declared = ["a", "b"];
			if (attack === "missing") runs.pop();
			if (attack === "duplicate run") runs[1] = { id: "a" };
			if (attack === "duplicate declaration") declared = ["a", "a"];
			if (attack === "unknown") runs[1] = { id: "c" };
			if (attack === "empty") declared = [];
			expect(() => orderScenarios(runs, declared, (r) => r.id)).toThrow();
		},
	);
});

describe("Conformance Lab byte references and publication", () => {
	it("publishes complete bytes and verifies independently of manifest/capture order", () => {
		const dir = mkdtempSync(join(tmpdir(), "lab-reference-"));
		try {
			publishReference(dir, "reference", manifest, [...input].reverse());
			const first = verifyReference(join(dir, "reference"), manifest);
			expect(verifyReference(join(dir, "reference"), [...manifest].reverse())).toEqual(first);
			publishReference(dir, "reference", manifest, input);
			expect(verifyReference(join(dir, "reference"), manifest)).toEqual(first);
			expect(readdirSync(dir)).toEqual(["reference"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		"partial",
		"duplicate",
		"digest",
		"changed report",
		"missing member",
		"extra member",
		"metadata",
		"oversize",
	])("refuses %s, preserving the installed complete bundle", (attack) => {
		const dir = mkdtempSync(join(tmpdir(), "lab-invalid-"));
		try {
			publishReference(dir, "reference", manifest, input);
			const changed = structuredClone(input);
			const pins = structuredClone(manifest);
			if (attack === "partial") changed.pop();
			if (attack === "duplicate") changed[1] = changed[0]!;
			if (attack === "digest") pins[0]!.sha256 = "z".repeat(64);
			if (attack === "changed report") changed[0]!.bytes += " ";
			if (attack === "missing member") pins.push({ path: "missing.json", sha256: sha256("{}") });
			if (attack === "extra member") changed.push({ path: "extra.json", bytes: "{}" });
			if (attack === "metadata") Object.assign(pins[0]!, { judgment: "exact" });
			if (attack === "oversize") {
				changed[0]!.bytes = "x".repeat(16 * 1024 * 1024);
				pins[0]!.sha256 = sha256(changed[0]!.bytes);
			}
			expect(() => publishReference(dir, "reference", pins, changed)).toThrow();
			expect(verifyReference(join(dir, "reference"), manifest).members).toBe(2);
			expect(readFileSync(join(dir, "reference", "report.json"), "utf8")).toBe(input[0]!.bytes);
			expect(readdirSync(dir)).toEqual(["reference"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		"report bytes",
		"missing",
		"extra",
		"extra empty directory",
		"linked file",
		"linked directory",
		"linked root",
		"linked ancestor",
	])("detects on-disk %s", (attack) => {
		const dir = mkdtempSync(join(tmpdir(), "lab-tamper-"));
		try {
			publishReference(dir, "reference", manifest, input);
			let root = join(dir, "reference");
			const report = join(root, "report.json");
			if (attack === "report bytes") writeFileSync(report, `${input[0]!.bytes} `);
			if (attack === "missing") rmSync(report);
			if (attack === "extra") writeFileSync(join(root, "extra.json"), "{}");
			if (attack === "extra empty directory") mkdirSync(join(root, "extra"));
			if (attack === "linked file") {
				const copy = join(dir, "external.json");
				writeFileSync(copy, input[0]!.bytes);
				rmSync(report);
				symlinkSync(copy, report);
			}
			if (attack === "linked directory") {
				const copy = join(dir, "external");
				mkdirSync(copy);
				writeFileSync(join(copy, "a.json"), input[1]!.bytes);
				rmSync(join(root, "runs"), { recursive: true });
				symlinkSync(copy, join(root, "runs"));
			}
			if (attack === "linked root") {
				const link = join(dir, "linked");
				symlinkSync(root, link);
				root = link;
			}
			if (attack === "linked ancestor") {
				symlinkSync(dir, join(dir, "link"));
				root = join(dir, "link", "reference");
			}
			expect(() => verifyReference(root, manifest)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("refuses nonadjacent overlapping inventory paths before staging", () => {
		const dir = mkdtempSync(join(tmpdir(), "lab-overlap-"));
		try {
			const bytes = ["a", "a-b", "a/b"].map((path) => ({ path, bytes: "{}" }));
			expect(() =>
				publishReference(
					dir,
					"reference",
					bytes.map((m) => ({ path: m.path, sha256: sha256(m.bytes) })),
					bytes,
				),
			).toThrow("overlapping");
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each(["../outside", "/absolute", "nested/../outside", "a\\b", "bad\n", "", "nested//file"])(
		"refuses unsafe path %s before staging",
		(path) => {
			const dir = mkdtempSync(join(tmpdir(), "lab-path-"));
			try {
				expect(() =>
					publishReference(dir, "reference", [{ path, sha256: sha256("{}") }], [{ path, bytes: "{}" }]),
				).toThrow();
				expect(() => publishReference(dir, path, manifest, input)).toThrow();
				expect(readdirSync(dir)).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
	it.each(["linked parent", "linked target", "dangling target"])("refuses %s publication", (attack) => {
		const dir = mkdtempSync(join(tmpdir(), "lab-target-"));
		try {
			const external = join(dir, "external");
			mkdirSync(external);
			let parent = dir;
			if (attack === "linked parent") {
				parent = join(dir, "linked");
				symlinkSync(external, parent);
			} else symlinkSync(attack === "dangling target" ? join(dir, "absent") : external, join(dir, "reference"));
			expect(() => publishReference(parent, "reference", manifest, input)).toThrow();
			expect(readdirSync(external)).toEqual([]);
			expect(readdirSync(dir).some((name) => name.startsWith(".conformance-"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Conformance Lab repository identity", () => {
	it.each([
		"tracked edit",
		"transitive edit",
		"untracked",
		"hidden tracked edit",
		"hidden configuration edit",
		"linked source",
		"linked root",
	])("refuses %s instrumentation", (attack) => {
		const dir = mkdtempSync(join(tmpdir(), "lab-git-"));
		const git = (args: string[]) =>
			execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf8" }).trim();
		try {
			git(["init"]);
			writeFileSync(join(dir, "probe.ts"), "export const probe = 1;\n");
			writeFileSync(join(dir, "dependency.ts"), "export const dependency = 1;\n");
			writeFileSync(join(dir, "configuration.json"), "{}\n");
			git(["add", "probe.ts", "dependency.ts", "configuration.json"]);
			git(["-c", "user.name=Lab Test", "-c", "user.email=lab@example.invalid", "commit", "-m", "fixture"]);
			const identity = cleanRepositoryIdentity(dir);
			expect(identity.sourceDigest).toBe(sourceDigestAtCommit(dir, identity.commit));
			expect(cleanRepositoryIdentity(dir)).toEqual(identity);
			let root = dir;
			if (attack === "tracked edit") writeFileSync(join(dir, "probe.ts"), "changed");
			if (attack === "transitive edit") writeFileSync(join(dir, "dependency.ts"), "changed");
			if (attack === "untracked") writeFileSync(join(dir, "other.ts"), "changed");
			if (attack === "hidden tracked edit") {
				git(["update-index", "--skip-worktree", "dependency.ts"]);
				writeFileSync(join(dir, "dependency.ts"), "changed");
				expect(git(["status", "--porcelain"])).toBe("");
			}
			if (attack === "hidden configuration edit") {
				git(["update-index", "--skip-worktree", "configuration.json"]);
				writeFileSync(join(dir, "configuration.json"), '{"injected":true}');
				expect(git(["status", "--porcelain"])).toBe("");
			}
			if (attack === "linked source") {
				rmSync(join(dir, "probe.ts"));
				symlinkSync(join(dir, "dependency.ts"), join(dir, "probe.ts"));
				git(["add", "probe.ts"]);
				git(["-c", "user.name=Lab Test", "-c", "user.email=lab@example.invalid", "commit", "-m", "link"]);
			}
			if (attack === "linked root") {
				root = `${dir}-link`;
				symlinkSync(dir, root);
			}
			expect(() => cleanRepositoryIdentity(root)).toThrow();
			expect(sourceDigestAtCommit(dir, identity.commit)).toBe(identity.sourceDigest); // Working changes cannot retag historical objects.
			if (root !== dir) rmSync(root);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const childPath = fileURLToPath(new URL("./fixtures/conformance/publication-child.mjs", import.meta.url));
describe("Conformance Lab publication interruption", () => {
	it.each(["before", "after", "failed-before", "failed-after"])(
		"%s exchange retains a complete visible target",
		async (mode) => {
			const dir = mkdtempSync(join(tmpdir(), "lab-crash-"));
			const old = input.map((m) => ({ ...m, bytes: '"old"\n' }));
			const oldPins = old.map((m) => ({ path: m.path, sha256: sha256(m.bytes) }));
			publishReference(dir, "reference", oldPins, old);
			const child = spawn(process.execPath, [childPath, mode, dir], { stdio: ["ignore", "pipe", "pipe"] });
			const closed = once(child, "close");
			try {
				if (!mode.startsWith("failed")) {
					await Promise.race([
						once(child.stdout!, "data"),
						closed.then(() => {
							throw new Error("publication child exited before the interruption witness");
						}),
					]);
					child.kill("SIGKILL");
				}
				const [code] = await closed;
				if (mode.startsWith("failed")) expect(code).toBe(1);
				const pins = mode.endsWith("after") ? manifest : oldPins;
				expect(verifyReference(join(dir, "reference"), pins).members).toBe(2);
				expect(existsSync(join(dir, "reference", "report.json"))).toBe(true);
			} finally {
				child.kill("SIGKILL");
				await closed;
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
