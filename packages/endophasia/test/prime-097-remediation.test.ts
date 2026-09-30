// PR #26: adversarial checker tests. Controls are synthetic in memory, never a substitute for a fresh live capture.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AcpScenarioEvidence } from "../research/prime-conformance/acp-evidence.ts";
import { acpPrivacyShapeProblems, acpUsageScriptMatches } from "../research/prime-conformance/acp-validation.ts";
import {
	assessPrime097,
	buildPrime097Report,
	publishPrime097,
	readAcpFixtures,
} from "../research/prime-conformance/comparison.ts";
import { writePrime097Diagnostics } from "../research/prime-conformance/diagnostics.ts";
import { PROBE_VERSION } from "../research/prime-conformance/evidence.ts";
import { SENTINELS } from "../research/prime-conformance/fake-provider.ts";
import {
	assertInstrumentSources,
	describeResearchInstrument,
	researchInstrumentHash,
} from "../research/prime-conformance/instrument.ts";
import { readPrimeFixturesV0 } from "../research/prime-conformance/report.ts";

const root = fileURLToPath(new URL("./fixtures/prime", import.meta.url));
const baseline = readPrimeFixturesV0(join(root, "0.9.6"));
function controls() {
	const rpc = readPrimeFixturesV0(join(root, "0.9.7", "rpc"));
	const acp = readdirSync(join(root, "0.9.7", "acp")).map(
		(name) => JSON.parse(readFileSync(join(root, "0.9.7", "acp", name), "utf8")) as AcpScenarioEvidence,
	);
	// Lets mutation tests run before fixture refresh. This is a checker control only, not audited/live provenance.
	const legacyControl = rpc[0]!.provenance.probeVersion === "0.14.0";
	for (const run of legacyControl ? [...rpc, ...acp] : [])
		Object.assign(run.provenance, { probeVersion: PROBE_VERSION, endophasiaBuild: "clean-checkout" });
	for (const run of legacyControl ? acp : [])
		for (const command of run.commands.filter((c) => c.method === "session/cancel"))
			Object.assign(command, {
				sessionId: run.updates[run.cancelAfter[0]!]!.sessionId,
				triggerIndex: run.cancelAfter[0],
			});
	return { rpc, acp };
}

describe("PR #26 diagnostic persistence boundary", () => {
	it.each(["RPC private field", "ACP private field", "RPC sentinel", "ACP sentinel", "nested ACP private field"])(
		"writes nothing for %s",
		(attack) => {
			const { rpc, acp } = controls();
			if (attack === "RPC private field") Object.assign(rpc[0]!, { private: "non-sentinel private text" });
			if (attack === "ACP private field") Object.assign(acp[0]!, { private: "non-sentinel private text" });
			if (attack === "nested ACP private field")
				Object.assign(acp[0]!.updates[0]!, { private: "non-sentinel private text" });
			if (attack === "RPC sentinel") Object.assign(rpc[0]!, { failures: [SENTINELS.prompt] });
			if (attack === "ACP sentinel") acp[0]!.failures.push(SENTINELS.prompt);
			const temp = mkdtempSync(join(tmpdir(), "prime-private-"));
			try {
				const output = join(temp, ".artifacts", "prime-conformance-097");
				expect(() => writePrime097Diagnostics(output, rpc, acp, baseline)).toThrow("nothing written");
				expect(readdirSync(temp)).toEqual([]);
				expect(() => publishPrime097(join(temp, "fixtures"), rpc, acp, baseline)).toThrow("refused");
				expect(readdirSync(temp)).toEqual([]);
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		},
	);
	it("persists closed sanitized evidence when an ordinary scenario invariant fails", () => {
		const { rpc, acp } = controls();
		acp.find((r) => r.provenance.scenario === "simple")!.providerRequests = 9;
		expect(acp.flatMap(acpPrivacyShapeProblems)).toEqual([]);
		const temp = mkdtempSync(join(tmpdir(), "prime-diagnostic-"));
		try {
			const output = join(temp, "diagnostics");
			const report = writePrime097Diagnostics(output, rpc, acp, baseline);
			expect(report.assessment.invalid).toContain("ACP simple: ACP provider witness missing");
			expect(JSON.parse(readFileSync(join(output, "evidence.json"), "utf8"))).toEqual({ rpc, acp });
			expect(() => publishPrime097(join(temp, "fixtures"), rpc, acp)).toThrow("refused");
			expect(existsSync(join(temp, "fixtures"))).toBe(false);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});

describe("PR #26 ACP witness mutations", () => {
	it.each(["input", "output", "cacheRead", "cacheWrite", "totalTokens", "extraKeys"])(
		"rejects omitted summary %s",
		(field) => {
			const { acp } = controls();
			const run = acp.find((r) => r.provenance.scenario === "compaction")!;
			Reflect.deleteProperty(run.files.flat().find((e) => e.type === "compaction")!.usage!, field);
			expect(acpUsageScriptMatches(run)).toBe(false);
			expect(acpPrivacyShapeProblems(run)).not.toEqual([]);
		},
	);
	it.each([1, 2])("accounts for %s summary request(s) across the entire usage shape", (count) => {
		const { acp } = controls();
		const run = acp.find((r) => r.provenance.scenario === "compaction")!;
		const usage = run.files.flat().find((e) => e.type === "compaction")!.usage!;
		const scale = count / run.summaryRequests;
		for (const record of [usage, usage.cost])
			for (const [key, value] of Object.entries(record))
				if (typeof value === "number") Object.assign(record, { [key]: value * scale });
		run.summaryRequests = count;
		expect(acpUsageScriptMatches(run)).toBe(true);
		run.summaryRequests++;
		expect(acpUsageScriptMatches(run)).toBe(false);
	});
	it.each(["cancel-stream", "cancel-tool"])("requires exactly one correlated local-send command for %s", (name) => {
		for (const attack of ["missing", "duplicate", "failed", "wrong trigger", "wrong session"]) {
			const { rpc, acp } = controls();
			expect(assessPrime097(rpc, acp)).toEqual({ invalid: [], unpublishable: [] });
			const run = acp.find((r) => r.provenance.scenario === name)!;
			const cancel = run.commands.find((c) => c.method === "session/cancel")!;
			if (attack === "missing") run.commands = run.commands.filter((c) => c !== cancel);
			if (attack === "duplicate") run.commands.push({ ...cancel });
			if (attack === "failed") cancel.success = false;
			if (attack === "wrong trigger") cancel.triggerIndex = 99;
			if (attack === "wrong session") cancel.sessionId = "00000000-0000-4000-8000-000000000001";
			expect(assessPrime097(rpc, acp).invalid).toContain(
				`ACP ${name}: ACP successful local cancellation emission missing or uncorrelated`,
			);
		}
	});
	it("rejects an untriggered cancel in a non-cancellation scenario", () => {
		const { rpc, acp } = controls();
		acp.find((r) => r.provenance.scenario === "simple")!.commands.push({ method: "session/cancel", success: true });
		expect(assessPrime097(rpc, acp).invalid).toContain("ACP simple: unexpected ACP cancellation");
	});
	it.each(["agent_message_chunk", "tool_call", "tool_call_update"])(
		"rejects zero and unknown positive prompt identity on %s",
		(kind) => {
			for (const turn of [0, 99]) {
				const { rpc, acp } = controls();
				const run = acp.find(
					(r) => r.provenance.scenario === (kind === "agent_message_chunk" ? "simple" : "tool-run"),
				)!;
				run.updates.find((u) => u.kind === kind)!.promptTurnId = turn;
				expect(assessPrime097(rpc, acp).invalid).toContain(
					`ACP ${run.provenance.scenario}: ACP update names an unknown prompt`,
				);
			}
		},
	);
	it.each([
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"totalTokens",
		"cost.input",
		"cost.output",
		"cost.cacheRead",
		"cost.cacheWrite",
		"cost.total",
		"extraKeys",
	])("compares every summary field: %s", (field) => {
		const { rpc, acp } = controls();
		const run = acp.find((r) => r.provenance.scenario === "compaction")!;
		expect(acpUsageScriptMatches(run)).toBe(true);
		const usage = run.files.flat().find((e) => e.type === "compaction")!.usage!;
		const record = (field.startsWith("cost.") ? usage.cost : usage) as unknown as Record<string, unknown>;
		const key = field.split(".").at(-1)!;
		record[key] = key === "extraKeys" ? ["future_usage"] : (record[key] as number) + 1;
		expect(acpUsageScriptMatches(run)).toBe(false);
		const report = buildPrime097Report(rpc, acp, baseline);
		expect(report.acp.facts.providerUsageDecodedExactly).toBe(false);
		for (const c of report.capabilities)
			expect(c.durable.basis).toBe(
				["RuntimeMetricsV0", "UsageLedgerRowV0"].includes(c.contract) ? "contradicted" : "established",
			);
	});
	it.each(["cacheRead", "cacheWrite", "input", "output", "total"])(
		"does not accept omitted summary cost.%s",
		(field) => {
			const { acp } = controls();
			const run = acp.find((r) => r.provenance.scenario === "compaction")!;
			const cost = run.files.flat().find((e) => e.type === "compaction")!.usage!.cost;
			Reflect.deleteProperty(cost, field);
			expect(acpUsageScriptMatches(run)).toBe(false);
			expect(acpPrivacyShapeProblems(run)).not.toEqual([]);
		},
	);
	it("report order is independent of scenario/file creation order", () => {
		const { rpc, acp } = controls();
		const expected = JSON.stringify(buildPrime097Report(rpc, acp, baseline));
		const temp = mkdtempSync(join(tmpdir(), "prime-order-"));
		try {
			publishPrime097(temp, [...rpc].reverse(), [...acp].reverse(), baseline);
			const fromFiles = buildPrime097Report(
				readPrimeFixturesV0(join(temp, "0.9.7", "rpc")),
				readAcpFixtures(join(temp, "0.9.7", "acp")),
				baseline,
			);
			expect(JSON.stringify(fromFiles)).toBe(expected);
			expect(JSON.stringify(buildPrime097Report([...rpc].reverse(), [...acp].reverse(), baseline))).toBe(expected);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});

describe("PR #26 instrument identity attacks", () => {
	const entry = "packages/endophasia/research/prime-conformance/cli-097.ts";
	const transitive = "packages/endophasia/runtime/prime/process-group.ts";
	function put(root: string, name: string, content: string) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), content);
	}
	function git(root: string, ...args: string[]) {
		return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
	}
	it("binds transitive source and refuses tracked dirt before or after a run", () => {
		const temp = mkdtempSync(join(tmpdir(), "prime-instrument-"));
		const script = join(temp, "check.mjs");
		const repo = join(temp, "repo");
		mkdirSync(repo);
		try {
			git(repo, "init");
			put(repo, entry, 'import "../../runtime/prime/process-group.ts";');
			put(repo, transitive, "export const keeper = 1;");
			git(repo, "add", entry, transitive);
			git(
				repo,
				"-c",
				"user.name=Probe",
				"-c",
				"user.email=probe@example.invalid",
				"commit",
				"-m",
				"instrument control",
			);
			const module = new URL("../research/prime-conformance/instrument.ts", import.meta.url).href;
			writeFileSync(
				script,
				`import { requireCleanResearchInstrument } from ${JSON.stringify(module)}; requireCleanResearchInstrument(process.argv[2]);`,
			);
			const before = describeResearchInstrument(repo);
			execFileSync(process.execPath, [script, repo], { env: { PATH: process.env.PATH } });
			put(repo, transitive, "export const keeper = 2;");
			const after = describeResearchInstrument(repo);
			expect(after.endophasiaCommit).toBe(before.endophasiaCommit);
			expect(after.endophasiaBuild).toBe("dirty-checkout");
			expect(researchInstrumentHash(repo)).not.toBe(before.researchHash);
			expect(() =>
				execFileSync(process.execPath, [script, repo], { env: { PATH: process.env.PATH }, stdio: "pipe" }),
			).toThrow();
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
	it("rejects ignored/generated imports even in a clean tracked worktree", () => {
		const repo = mkdtempSync(join(tmpdir(), "prime-generated-"));
		try {
			git(repo, "init");
			put(repo, entry, 'import "./generated.ts";');
			put(repo, ".gitignore", "generated.ts\n");
			put(repo, "packages/endophasia/research/prime-conformance/generated.ts", "export const forged = true;");
			git(repo, "add", entry, ".gitignore");
			git(
				repo,
				"-c",
				"user.name=Probe",
				"-c",
				"user.email=probe@example.invalid",
				"commit",
				"-m",
				"ignored import control",
			);
			expect(describeResearchInstrument(repo).endophasiaBuild).toBe("clean-checkout");
			expect(() => assertInstrumentSources(repo, entry)).toThrow("untracked, generated or linked");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
