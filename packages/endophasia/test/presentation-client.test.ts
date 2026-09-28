import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { type RunningServer, startServer } from "@earendil-works/pi-coding-agent/experimental/server";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { type EndophasiaPresentationClientV0, openEndophasiaPresentationClientV0 } from "../presentation/client.ts";
import { startEndophasiaServer } from "../runtime/server.ts";
import type { OperationOutcomeV0, RuntimeMetricsV0, UsageLedgerPageV0, UsageLedgerQueryV0 } from "../src/index.ts";

const directories: string[] = [];
const servers: RunningServer[] = [];
const presentations: EndophasiaPresentationClientV0[] = [];
const workerModel = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;

beforeEach(async () => {
	// The standard worker resolves its configured model offline from a local API-key credential.
	const agentDir = await temporaryDirectory("endophasia-presentation-agent-");
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), {
		mode: 0o600,
	});
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	await createSessions(join(agentDir, "experimental", "sessions"), ["observed", "other"]);
});

afterEach(async () => {
	for (const presentation of presentations.splice(0)) await presentation.dispose();
	for (const server of servers.splice(0)) await server.close();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join("/tmp", prefix));
	directories.push(directory);
	return directory;
}

async function createSessions(sessionsRoot: string, ids: readonly string[]): Promise<void> {
	await mkdir(sessionsRoot, { recursive: true });
	const fileSystem = new NodeExecutionEnv({ cwd: process.cwd() });
	const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot });
	try {
		for (const id of ids) {
			await (await repo.create({ id, cwd: process.cwd() }, BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT);
		}
	} finally {
		await repo.close(BACKGROUND_CONTEXT);
		await fileSystem.cleanup(BACKGROUND_CONTEXT);
	}
}

async function open(server: RunningServer, errors: Error[] = []): Promise<EndophasiaPresentationClientV0> {
	const presentation = await openEndophasiaPresentationClientV0({
		serverId: server.serverId,
		transportFactory: createUnixTransportFactory({ path: server.socketPath }),
		onError: (error) => errors.push(error),
	});
	presentations.push(presentation);
	return presentation;
}

describe("Endophasia Presentation Client v0", () => {
	it("observes a real Endophasia Session over the Pi protocol", async () => {
		const server = await startEndophasiaServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-presentation-server-"),
		});
		servers.push(server);
		const errors: Error[] = [];
		const presentation = await open(server, errors);

		expect(presentation.connection.value).toMatchObject({ status: "connected" });
		expect(presentation.attachment.value).toEqual({ status: "detached" });
		expect(presentation.sessions.value?.sessions.map((session) => session.sessionId).sort()).toEqual([
			"observed",
			"other",
		]);

		const observe = async (sessionId: string): Promise<void> => {
			await presentation.attach(sessionId, BACKGROUND_CONTEXT);
			expect(presentation.attachment.value).toEqual({ status: "attached", sessionId });
			expect(presentation.transcript.value?.snapshot).toMatchObject({
				lane: "main",
				operation: null,
				configuration: { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } },
			});
			expect(presentation.models.value?.configuration.model).toEqual({
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(presentation.missionTrace.value).toMatchObject({
				schemaVersion: "mission-trace-observation.v0",
				scope: "session-worker-lifetime",
				events: expect.any(Array),
			});
			const overview = await presentation.sessionOverview(BACKGROUND_CONTEXT);
			expect(overview).toMatchObject({
				schemaVersion: "session-overview.v0",
				consistency: "per-lane",
				lanes: [{ name: "main", operation: null }],
				counts: { lanes: 1, activeOperations: 0, abortingOperations: 0 },
			});
			// Runtime Facts are request/response reads of this Session: its zero baseline, and no unknown outcome.
			expect(await presentation.runtimeMetrics(BACKGROUND_CONTEXT)).toMatchObject({
				schemaVersion: "runtime-metrics.v0",
				scope: "session",
				messageCount: 0,
				usage: { totalTokens: 0, cost: { total: 0 } },
			});
			expect(await presentation.operationOutcome("no-such-operation", BACKGROUND_CONTEXT)).toBeNull();
			// A fresh Session's durable usage: an empty, complete observation, and an empty first page.
			expect(presentation.usage.value).toEqual({
				schemaVersion: "usage-observation.v0",
				scope: "session",
				hasEarlierRows: false,
				rows: [],
			});
			expect(await presentation.usagePage(undefined, BACKGROUND_CONTEXT)).toEqual({
				schemaVersion: "usage-ledger.v0",
				scope: "session",
				order: "ascending",
				rows: [],
				nextAfterSequence: 0,
			});
			expect(await presentation.usagePage({ afterSequence: 7, limit: 1 }, BACKGROUND_CONTEXT)).toMatchObject({
				rows: [],
				nextAfterSequence: 7,
			});
		};
		await observe("observed");

		await presentation.detach(BACKGROUND_CONTEXT);
		expect(presentation.attachment.value).toEqual({ status: "detached" });
		await expect(Promise.resolve().then(() => presentation.sessionOverview(BACKGROUND_CONTEXT))).rejects.toThrow();
		// Detached, there is no Session to read: no zero metrics or null outcome is fabricated.
		await expect(Promise.resolve().then(() => presentation.runtimeMetrics(BACKGROUND_CONTEXT))).rejects.toThrow();
		await expect(
			Promise.resolve().then(() => presentation.operationOutcome("no-such-operation", BACKGROUND_CONTEXT)),
		).rejects.toThrow();
		await expect(
			Promise.resolve().then(() => presentation.usagePage(undefined, BACKGROUND_CONTEXT)),
		).rejects.toThrow();

		// Later attachment generations rebind every Session service, including the Inspector.
		await observe("other");
		await presentation.detach(BACKGROUND_CONTEXT);
		// Re-attach "observed" once its idle worker has stopped: a re-attach that races Pi's idle-worker shutdown
		// currently fails with an internal server error, independent of this client.
		await expect.poll(() => server.workerPids.size, { timeout: 10_000 }).toBe(0);
		await observe("observed");
		expect(errors).toEqual([]);

		// Concurrent and later callers all wait on the same cleanup and observe its result.
		const disposal = presentation.dispose();
		expect(presentation.dispose()).toBe(disposal);
		await disposal;
		expect(presentation.dispose()).toBe(disposal);
		await expect(Promise.resolve().then(() => presentation.sessionOverview(BACKGROUND_CONTEXT))).rejects.toThrow();
		// The server releases the disposed client's attachment, so the idle worker stops.
		await expect.poll(() => server.workerPids.size, { timeout: 10_000 }).toBe(0);
	});

	it("exposes no agent control, model mutation or Session management", () => {
		expectTypeOf<keyof EndophasiaPresentationClientV0>().toEqualTypeOf<
			| "connection"
			| "attachment"
			| "sessions"
			| "transcript"
			| "models"
			| "missionTrace"
			| "usage"
			| "attach"
			| "detach"
			| "sessionOverview"
			| "runtimeMetrics"
			| "operationOutcome"
			| "usagePage"
			| "dispose"
		>();
		// Usage is read-only replicated state plus a durable page read, not the underlying service object.
		expectTypeOf<keyof EndophasiaPresentationClientV0["usage"]>().toEqualTypeOf<"value" | "subscribe">();
		expectTypeOf<EndophasiaPresentationClientV0["usagePage"]>().toEqualTypeOf<
			(query: UsageLedgerQueryV0 | undefined, context: Context) => Promise<UsageLedgerPageV0>
		>();
		// Runtime Facts are read-only requests returning their schemas, not the underlying service object.
		expectTypeOf<EndophasiaPresentationClientV0["runtimeMetrics"]>().toEqualTypeOf<
			(context: Context) => Promise<RuntimeMetricsV0>
		>();
		expectTypeOf<EndophasiaPresentationClientV0["operationOutcome"]>().toEqualTypeOf<
			(operationId: string, context: Context) => Promise<OperationOutcomeV0 | null>
		>();
		expectTypeOf<keyof EndophasiaPresentationClientV0["models"]>().toEqualTypeOf<"value" | "subscribe">();
		expectTypeOf<keyof EndophasiaPresentationClientV0["transcript"]>().toEqualTypeOf<"value" | "subscribe">();
		expectTypeOf<keyof EndophasiaPresentationClientV0["sessions"]>().toEqualTypeOf<"value" | "subscribe">();
		// Mission Trace is read-only replicated state: no mutation, attachment or harness access.
		expectTypeOf<keyof EndophasiaPresentationClientV0["missionTrace"]>().toEqualTypeOf<"value" | "subscribe">();
	});

	it("reports a degraded attachment instead of an Endophasia view on a plain Pi server", async () => {
		const server = await startServer({ ...workerModel, directory: await temporaryDirectory("endophasia-plain-") });
		servers.push(server);
		const presentation = await open(server);
		expect(presentation.connection.value).toMatchObject({ status: "connected" });
		expect(presentation.sessions.value?.sessions.map((session) => session.sessionId)).toContain("observed");

		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			"Remote service endophasia.inspector.v0 is not allowlisted",
		);
		expect(presentation.attachment.value).toEqual({ status: "degraded", sessionId: "observed" });
	});

	it("requires Mission Trace: an Inspector-only worker degrades instead of showing an empty trace", async () => {
		const server = await startServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-inspector-only-"),
			sessionWorkerEntryUrl: new URL("./fixtures/inspector-only-session-worker.ts", import.meta.url),
		});
		servers.push(server);
		const presentation = await open(server);
		// The worker lacks Mission Trace, Runtime Facts and Usage; any missing service degrades the attachment.
		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			/Remote service endophasia\.(mission-trace|runtime-facts|usage)\.v0 is not allowlisted/,
		);
		expect(presentation.attachment.value).toEqual({ status: "degraded", sessionId: "observed" });
		// A missing capability is not reported as a real trace with zero events.
		expect(presentation.missionTrace.value).toBeUndefined();
	});

	it("requires Runtime Facts: a worker without them degrades instead of fabricating zero metrics", async () => {
		const server = await startServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-no-facts-"),
			sessionWorkerEntryUrl: new URL("./fixtures/inspector-and-trace-session-worker.ts", import.meta.url),
		});
		servers.push(server);
		const presentation = await open(server);
		// The worker lacks Runtime Facts and Usage; either missing service degrades the attachment.
		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			/Remote service endophasia\.(runtime-facts|usage)\.v0 is not allowlisted/,
		);
		expect(presentation.attachment.value).toEqual({ status: "degraded", sessionId: "observed" });
		// A missing capability is never reported as zero accounting or as "no durable result".
		await expect(Promise.resolve().then(() => presentation.runtimeMetrics(BACKGROUND_CONTEXT))).rejects.toThrow();
		await expect(
			Promise.resolve().then(() => presentation.operationOutcome("any", BACKGROUND_CONTEXT)),
		).rejects.toThrow();
	});

	it("requires Usage: a worker without it degrades instead of fabricating an empty usage history", async () => {
		const server = await startServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-no-usage-"),
			sessionWorkerEntryUrl: new URL("./fixtures/no-usage-session-worker.ts", import.meta.url),
		});
		servers.push(server);
		const presentation = await open(server);
		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			"Remote service endophasia.usage.v0 is not allowlisted",
		);
		expect(presentation.attachment.value).toEqual({ status: "degraded", sessionId: "observed" });
		// A missing capability is never reported as a Session with no usage rows.
		expect(presentation.usage.value).toBeUndefined();
		await expect(
			Promise.resolve().then(() => presentation.usagePage(undefined, BACKGROUND_CONTEXT)),
		).rejects.toThrow();
	});

	it("contains a throwing diagnostic observer without changing the attachment lifecycle", async () => {
		const server = await startServer({ ...workerModel, directory: await temporaryDirectory("endophasia-observer-") });
		servers.push(server);
		let observed!: (error: Error) => void;
		const firstError = new Promise<Error>((resolve) => {
			observed = resolve;
		});
		const presentation = await openEndophasiaPresentationClientV0({
			serverId: server.serverId,
			transportFactory: createUnixTransportFactory({ path: server.socketPath }),
			onError(error) {
				observed(error);
				throw new Error("observer exploded");
			},
		});
		presentations.push(presentation);

		// The missing Inspector fails the Session rebind, a real service-source error routed to the observer.
		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			"Remote service endophasia.inspector.v0 is not allowlisted",
		);
		await expect(firstError).resolves.toBeInstanceOf(Error);
		expect(presentation.attachment.value).toEqual({ status: "degraded", sessionId: "observed" });
		expect(presentation.connection.value).toMatchObject({ status: "connected" });
		await expect(presentation.dispose()).resolves.toBeUndefined();
	});

	it("loads in plain Node with coding-agent's source resolver preloaded, without Vitest aliases", async () => {
		const resolver = new URL("../../coding-agent/src/experimental/source-resolver.ts", import.meta.url);
		const client = new URL("../presentation/client.ts", import.meta.url);
		const script = `
			import { openEndophasiaPresentationClientV0 } from ${JSON.stringify(client.href)};
			console.log(typeof openEndophasiaPresentationClientV0);
		`;
		const { stdout } = await promisify(execFile)(process.execPath, [
			"--import",
			resolver.href,
			"--input-type=module",
			"--eval",
			script,
		]);
		expect(stdout.trim()).toBe("function");
	});
});
