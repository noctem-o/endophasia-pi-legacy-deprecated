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
import {
	CONTINUITY_REMOTE_BYTE_LIMIT,
	type ContinuitySnapshotV0,
	type OperationOutcomeV0,
	type RuntimeMetricsV0,
	type RuntimeProfileV0,
	type UsageLedgerPageV0,
	type UsageLedgerQueryV0,
} from "../src/index.ts";

const directories: string[] = [];
const servers: RunningServer[] = [];
const presentations: EndophasiaPresentationClientV0[] = [];
const workerModel = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;
const PI_STANDARD_PROFILE: RuntimeProfileV0 = {
	schemaVersion: "runtime-profile.v0",
	scope: "session-worker-lifetime",
	runtimeFamily: "pi",
	adapterProfileId: "endophasia.pi-standard.v0",
	capabilities: [
		"endophasia.session-overview.v0",
		"endophasia.mission-trace.v0",
		"endophasia.runtime-metrics.v0",
		"endophasia.operation-outcome.v0",
		"endophasia.usage.v0",
		"endophasia.continuity.v0",
	],
};

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
			// The worker's composition claim, hydrated with the attachment.
			expect(presentation.runtimeProfile.value).toEqual(PI_STANDARD_PROFILE);
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
			// A fresh Session's main lane: an empty tip, captured by the worker on request.
			expect(await presentation.continuitySnapshot(BACKGROUND_CONTEXT)).toEqual({
				schemaVersion: "continuity.v0",
				lane: "main",
				tipId: null,
				configuration: {
					model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
					thinkingLevel: expect.any(String),
					activeToolNames: expect.any(Array),
				},
				activePath: [],
				contextWindow: [],
				compaction: null,
				counts: { activePathEntries: 0, contextWindowEntries: 0, beforeContextWindow: 0 },
			});
		};
		await observe("observed");

		await presentation.detach(BACKGROUND_CONTEXT);
		expect(presentation.attachment.value).toEqual({ status: "detached" });
		// Detached, no worker is attached, so no profile is kept or synthesized.
		expect(presentation.runtimeProfile.value).toBeUndefined();
		await expect(Promise.resolve().then(() => presentation.sessionOverview(BACKGROUND_CONTEXT))).rejects.toThrow();
		// Detached, there is no Session to read: no zero metrics or null outcome is fabricated.
		await expect(Promise.resolve().then(() => presentation.runtimeMetrics(BACKGROUND_CONTEXT))).rejects.toThrow();
		await expect(
			Promise.resolve().then(() => presentation.operationOutcome("no-such-operation", BACKGROUND_CONTEXT)),
		).rejects.toThrow();
		await expect(
			Promise.resolve().then(() => presentation.usagePage(undefined, BACKGROUND_CONTEXT)),
		).rejects.toThrow();
		// Nor a synthetic empty Continuity snapshot.
		await expect(Promise.resolve().then(() => presentation.continuitySnapshot(BACKGROUND_CONTEXT))).rejects.toThrow();

		// Later attachment generations rebind every Session service, including the Inspector.
		await observe("other");
		// Switch straight from "other" to "observed" once the latter's idle worker has stopped. Pi publishes "attaching"
		// and then, in the same turn, clears every Session binding before rebinding: past that notification, "other"'s
		// profile is gone, and whatever hydrates next belongs to "observed".
		await expect.poll(() => server.workerPids.has("observed"), { timeout: 10_000 }).toBe(false);
		const duringAttach: (RuntimeProfileV0 | undefined)[] = [];
		const stopRecording = presentation.attachment.subscribe(async (state) => {
			if (state.status !== "attaching") return;
			await Promise.resolve();
			duringAttach.push(presentation.runtimeProfile.value);
		});
		expect(presentation.runtimeProfile.value).toEqual(PI_STANDARD_PROFILE);
		await presentation.attach("observed", BACKGROUND_CONTEXT);
		stopRecording();
		expect(duringAttach).toEqual([undefined]);
		expect(presentation.runtimeProfile.value).toEqual(PI_STANDARD_PROFILE);
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
		// Disposal releases the profile binding with the others: it can no longer be read.
		expect(() => presentation.runtimeProfile.value).toThrow("Remote service binding is disposed");
		await expect(Promise.resolve().then(() => presentation.sessionOverview(BACKGROUND_CONTEXT))).rejects.toThrow();
		await expect(Promise.resolve().then(() => presentation.continuitySnapshot(BACKGROUND_CONTEXT))).rejects.toThrow();
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
			| "runtimeProfile"
			| "attach"
			| "detach"
			| "sessionOverview"
			| "runtimeMetrics"
			| "operationOutcome"
			| "usagePage"
			| "continuitySnapshot"
			| "dispose"
		>();
		// Continuity is one fresh read returning its schema: not the service object, lane or harness.
		expectTypeOf<EndophasiaPresentationClientV0["continuitySnapshot"]>().toEqualTypeOf<
			(context: Context) => Promise<ContinuitySnapshotV0>
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
		// The Runtime Profile is read-only replicated state, not the service object or its host facet.
		expectTypeOf<keyof EndophasiaPresentationClientV0["runtimeProfile"]>().toEqualTypeOf<"value" | "subscribe">();
		expectTypeOf<EndophasiaPresentationClientV0["runtimeProfile"]["value"]>().toEqualTypeOf<
			RuntimeProfileV0 | undefined
		>();
		// Mission Trace is read-only replicated state: no mutation, attachment or harness access.
		expectTypeOf<keyof EndophasiaPresentationClientV0["missionTrace"]>().toEqualTypeOf<"value" | "subscribe">();
	});

	it("reports a degraded attachment instead of an Endophasia view on a plain Pi server", async () => {
		const server = await startServer({ ...workerModel, directory: await temporaryDirectory("endophasia-plain-") });
		servers.push(server);
		const presentation = await open(server);
		expect(presentation.connection.value).toMatchObject({ status: "connected" });
		expect(presentation.sessions.value?.sessions.map((session) => session.sessionId)).toContain("observed");

		// The Inspector and the Runtime Profile bindings fail independently; either may report first.
		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			/Remote service endophasia\.(inspector|runtime-profile)\.v0 is not allowlisted/,
		);
		expect(presentation.attachment.value).toEqual({ status: "degraded", sessionId: "observed" });
		// A plain Pi worker is never assigned a synthetic "pi" profile.
		expect(presentation.runtimeProfile.value).toBeUndefined();
	});

	it("requires Mission Trace: an Inspector-only worker degrades instead of showing an empty trace", async () => {
		const server = await startServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-inspector-only-"),
			sessionWorkerEntryUrl: new URL("./fixtures/inspector-only-session-worker.ts", import.meta.url),
		});
		servers.push(server);
		const presentation = await open(server);
		// The worker lacks the Runtime Profile, Mission Trace, Runtime Facts, Usage and Continuity; any missing service
		// degrades the attachment.
		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			/Remote service endophasia\.(mission-trace|runtime-facts|usage|continuity|runtime-profile)\.v0 is not allowlisted/,
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
		// The worker lacks the Runtime Profile, Runtime Facts, Usage and Continuity; any missing service degrades the
		// attachment.
		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			/Remote service endophasia\.(runtime-facts|usage|continuity|runtime-profile)\.v0 is not allowlisted/,
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

	it("requires Continuity: a worker without it degrades instead of fabricating an empty snapshot", async () => {
		const server = await startServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-no-continuity-"),
			sessionWorkerEntryUrl: new URL("./fixtures/no-continuity-session-worker.ts", import.meta.url),
		});
		servers.push(server);
		const presentation = await open(server);
		// Every other Endophasia service is present, so only Continuity can be the missing one.
		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			"Remote service endophasia.continuity.v0 is not allowlisted",
		);
		expect(presentation.attachment.value).toEqual({ status: "degraded", sessionId: "observed" });
		await expect(Promise.resolve().then(() => presentation.continuitySnapshot(BACKGROUND_CONTEXT))).rejects.toThrow();
		// Its own binding hydrated: the worker's truthful profile stays readable as a diagnostic, advertising no
		// Continuity, while the attachment stays degraded.
		await expect.poll(() => presentation.runtimeProfile.value, { timeout: 10_000 }).toBeDefined();
		expect(presentation.runtimeProfile.value).toEqual({
			...PI_STANDARD_PROFILE,
			adapterProfileId: "endophasia.test.no-continuity.v0",
			capabilities: PI_STANDARD_PROFILE.capabilities.filter((id) => id !== "endophasia.continuity.v0"),
		});
		expect(presentation.attachment.value).toEqual({ status: "degraded", sessionId: "observed" });
	});

	it("requires the Runtime Profile: a worker without one degrades and is never assigned a guessed profile", async () => {
		const server = await startServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-no-profile-"),
			sessionWorkerEntryUrl: new URL("./fixtures/no-runtime-profile-session-worker.ts", import.meta.url),
		});
		servers.push(server);
		const presentation = await open(server);
		// Every other Endophasia service is present and hydrates; the profile is not inferred from them.
		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			"Remote service endophasia.runtime-profile.v0 is not allowlisted",
		);
		expect(presentation.attachment.value).toEqual({ status: "degraded", sessionId: "observed" });
		expect(presentation.runtimeProfile.value).toBeUndefined();
		expect(await presentation.runtimeMetrics(BACKGROUND_CONTEXT)).toMatchObject({ scope: "session" });
		expect(presentation.runtimeProfile.value).toBeUndefined();
	});

	it("carries a Continuity snapshot at the remote byte limit whole, and fails a larger one without disconnecting", async () => {
		const sizes: Record<string, ContinuitySnapshotV0 | Error> = {};
		// Each server attaches its own Session, so neither waits on the other's worker to release it.
		for (const [mode, sessionId] of [
			["at-limit", "observed"],
			["over-limit", "other"],
		] as const) {
			vi.stubEnv("ENDOPHASIA_TEST_CONTINUITY", mode);
			const server = await startServer({
				...workerModel,
				directory: await temporaryDirectory(`endophasia-continuity-${mode}-`),
				sessionWorkerEntryUrl: new URL("./fixtures/large-continuity-session-worker.ts", import.meta.url),
			});
			servers.push(server);
			const errors: Error[] = [];
			const presentation = await open(server, errors);
			await presentation.attach(sessionId, BACKGROUND_CONTEXT);
			sizes[mode] = await presentation.continuitySnapshot(BACKGROUND_CONTEXT).catch((error: Error) => error);
			// A refused read is local to the call: the connection, the attachment and other services stay usable.
			expect(presentation.connection.value).toMatchObject({ status: "connected" });
			expect(presentation.attachment.value).toEqual({ status: "attached", sessionId });
			expect(await presentation.runtimeMetrics(BACKGROUND_CONTEXT)).toMatchObject({ scope: "session" });
			expect(errors).toEqual([]);
		}
		const whole = sizes["at-limit"];
		if (!whole || whole instanceof Error) throw whole ?? new Error("No at-limit capture");
		const bytes = new TextEncoder().encode(JSON.stringify(whole)).byteLength;
		expect(bytes).toBeLessThanOrEqual(CONTINUITY_REMOTE_BYTE_LIMIT);
		expect(bytes).toBeGreaterThan(CONTINUITY_REMOTE_BYTE_LIMIT - 1_200);
		expect(whole.activePath).toHaveLength(whole.counts.activePathEntries);
		// The read is refused, not shortened. Pi's server does not forward a service's own error text, so a remote
		// reader sees its generic internal error; the worker endpoint's exact reason is covered in continuity-service.
		const refused = sizes["over-limit"];
		expect(refused).toBeInstanceOf(Error);
		expect((refused as Error).message).toBe("Internal server error");
		// Two worker processes and an 8 MiB response.
	}, 60_000);

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

		// The missing Inspector and Runtime Profile fail the Session rebind, a real service-source error routed to the
		// observer.
		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			/Remote service endophasia\.(inspector|runtime-profile)\.v0 is not allowlisted/,
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
