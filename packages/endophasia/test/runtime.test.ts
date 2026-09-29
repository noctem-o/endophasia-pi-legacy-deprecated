import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentHarness, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { type RunningServer, startServer } from "@earendil-works/pi-coding-agent/experimental/server";
import { AgentController } from "@earendil-works/pi-coding-agent/experimental/services/agent-controller";
import {
	createServerServiceSource,
	createSessionServiceSource,
} from "@earendil-works/pi-coding-agent/experimental/services/connection";
import { Models } from "@earendil-works/pi-coding-agent/experimental/services/models";
import { SessionPlugins } from "@earendil-works/pi-coding-agent/experimental/services/plugins";
import { SessionManagement } from "@earendil-works/pi-coding-agent/experimental/services/sessions";
import { Transcript } from "@earendil-works/pi-coding-agent/experimental/services/transcript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EndophasiaServerOptions, startEndophasiaServer } from "../runtime/server.ts";
import {
	EndophasiaContinuityV0,
	EndophasiaInspectorV0,
	EndophasiaMissionTraceV0,
	EndophasiaRuntimeFactsV0,
	EndophasiaRuntimeProfileV0,
	EndophasiaUsageV0,
	type RuntimeProfileV0,
	type UsageObservationV0,
} from "../src/index.ts";

const directories: string[] = [];
const servers: RunningServer[] = [];
const clients: Client[] = [];
const workerModel = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;

beforeEach(async () => {
	// The standard worker resolves its configured model offline from a local API-key credential.
	const agentDir = await temporaryDirectory("endophasia-agent-");
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), {
		mode: 0o600,
	});
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	await createSessions(join(agentDir, "experimental", "sessions"), ["plain", "endophasia"]);
});

afterEach(async () => {
	for (const client of clients.splice(0)) await client.dispose();
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
		for (const id of ids)
			await (await repo.create({ id, cwd: process.cwd() }, BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT);
	} finally {
		await repo.close(BACKGROUND_CONTEXT);
		await fileSystem.cleanup(BACKGROUND_CONTEXT);
	}
}

/** Connect an ordinary Pi client over the Unix transport and attach one Session through SessionManagement. */
async function attach(server: RunningServer, sessionId: string): Promise<Client> {
	const client = await Client.connect({
		serverId: server.serverId,
		transportFactory: createUnixTransportFactory({ path: server.socketPath }),
	});
	clients.push(client);
	const source = createServerServiceSource(client);
	const services = source.open({ services: [SessionManagement], assertAccess() {}, onError() {} });
	try {
		await services.ready(BACKGROUND_CONTEXT);
		await services.use(SessionManagement).attach(sessionId, BACKGROUND_CONTEXT);
	} finally {
		await services.dispose(BACKGROUND_CONTEXT);
		await source.dispose(BACKGROUND_CONTEXT);
	}
	return client;
}

async function sessionCatalogue(client: Client): Promise<string[]> {
	const source = createSessionServiceSource(client);
	try {
		return (await source.catalogue(BACKGROUND_CONTEXT)).map((entry) => entry.serviceId);
	} finally {
		await source.dispose(BACKGROUND_CONTEXT);
	}
}

/** Record usage rows durably in a stored Session through a short-lived local harness, while no worker holds it. */
async function recordDurableUsage(agentDir: string, sessionId: string, totals: readonly number[]): Promise<void> {
	const fileSystem = new NodeExecutionEnv({ cwd: process.cwd() });
	const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: join(agentDir, "experimental", "sessions") });
	try {
		const metadata = (await repo.list({ cwd: process.cwd() }, BACKGROUND_CONTEXT)).find(({ id }) => id === sessionId);
		if (metadata === undefined) throw new Error(`Unknown Session ${sessionId}`);
		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
		try {
			const lane = await harness.lane("main", BACKGROUND_CONTEXT);
			for (const totalTokens of totals) {
				const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
				const recorded = await lane.recordUsage(
					{ input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost },
					undefined,
					BACKGROUND_CONTEXT,
				);
				if (!recorded.ok) throw recorded.error;
			}
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await repo.close(BACKGROUND_CONTEXT);
		await fileSystem.cleanup(BACKGROUND_CONTEXT);
	}
}

/** Read the attached Session worker's hydrated Runtime Profile through an ordinary Pi client. */
async function runtimeProfile(client: Client, sessionId: string): Promise<RuntimeProfileV0 | undefined> {
	const source = createSessionServiceSource(client);
	const services = source.open({ services: [EndophasiaRuntimeProfileV0], assertAccess() {}, onError() {} });
	try {
		await services.ready(BACKGROUND_CONTEXT);
		await source.whenAttached(sessionId, BACKGROUND_CONTEXT);
		const state = services.use(EndophasiaRuntimeProfileV0).state;
		await expect.poll(() => state.value, { timeout: 10_000 }).toBeDefined();
		return state.value;
	} finally {
		await services.dispose(BACKGROUND_CONTEXT);
		await source.dispose(BACKGROUND_CONTEXT);
	}
}

/** Read the attached Session's hydrated Usage observation through an ordinary Pi client. */
async function usageObservation(client: Client, sessionId: string): Promise<UsageObservationV0 | undefined> {
	const source = createSessionServiceSource(client);
	const services = source.open({ services: [EndophasiaUsageV0], assertAccess() {}, onError() {} });
	try {
		await services.ready(BACKGROUND_CONTEXT);
		await source.whenAttached(sessionId, BACKGROUND_CONTEXT);
		const state = services.use(EndophasiaUsageV0).state;
		await expect.poll(() => state.value, { timeout: 10_000 }).toBeDefined();
		return state.value;
	} finally {
		await services.dispose(BACKGROUND_CONTEXT);
		await source.dispose(BACKGROUND_CONTEXT);
	}
}

describe("Endophasia runtime v0", () => {
	it("serves endophasia.inspector.v0 from a real Endophasia Session worker process", async () => {
		// An untyped caller cannot replace the Endophasia worker entry: this module does not exist.
		const override = { sessionWorkerEntryUrl: new URL("./missing-session-worker.ts", import.meta.url) };
		const endophasia = await startEndophasiaServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-server-"),
			...(override as EndophasiaServerOptions),
		});
		servers.push(endophasia);
		const client = await attach(endophasia, "endophasia");
		expect(endophasia.workerPids.get("endophasia")).toEqual(expect.any(Number));

		const catalogue = await sessionCatalogue(client);
		expect(catalogue.filter((id) => id === EndophasiaInspectorV0.id)).toHaveLength(1);
		expect(catalogue.filter((id) => id === EndophasiaMissionTraceV0.id)).toHaveLength(1);
		expect(catalogue.filter((id) => id === EndophasiaRuntimeFactsV0.id)).toHaveLength(1);
		expect(catalogue.filter((id) => id === EndophasiaUsageV0.id)).toHaveLength(1);
		expect(catalogue.filter((id) => id === EndophasiaContinuityV0.id)).toHaveLength(1);
		expect(catalogue.filter((id) => id === EndophasiaRuntimeProfileV0.id)).toHaveLength(1);
		for (const service of [AgentController, Models, Transcript, SessionPlugins]) {
			expect(catalogue).toContain(service.id);
		}

		const source = createSessionServiceSource(client);
		const services = source.open({
			services: [EndophasiaInspectorV0, EndophasiaRuntimeFactsV0, EndophasiaContinuityV0],
			assertAccess() {},
			onError() {},
		});
		const inspector = services.use(EndophasiaInspectorV0);
		const facts = services.use(EndophasiaRuntimeFactsV0);
		const continuity = services.use(EndophasiaContinuityV0);
		try {
			await services.ready(BACKGROUND_CONTEXT);
			await source.whenAttached("endophasia", BACKGROUND_CONTEXT);
			const overview = await inspector.sessionOverview(BACKGROUND_CONTEXT);
			expect(overview).toMatchObject({
				schemaVersion: "session-overview.v0",
				consistency: "per-lane",
				lanes: [{ name: "main", operation: null }],
				counts: { lanes: 1, activeOperations: 0, abortingOperations: 0 },
			});
			// A fresh Session: Pi's zero accounting baseline, and no durable result for an unknown operation.
			expect(await facts.runtimeMetrics(BACKGROUND_CONTEXT)).toEqual({
				schemaVersion: "runtime-metrics.v0",
				scope: "session",
				messageCount: 0,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			expect(await facts.operationOutcome("no-such-operation", BACKGROUND_CONTEXT)).toBeNull();
			// Continuity reads the worker's established main lane: a fresh Session's empty tip.
			expect(await continuity.snapshot(BACKGROUND_CONTEXT)).toMatchObject({
				schemaVersion: "continuity.v0",
				lane: "main",
				tipId: null,
				configuration: { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } },
				activePath: [],
				contextWindow: [],
				compaction: null,
			});
			// Reacquiring the main lane for Runtime Facts and Continuity did not create another lane.
			expect((await inspector.sessionOverview(BACKGROUND_CONTEXT)).lanes.map(({ name }) => name)).toEqual(["main"]);
		} finally {
			await services.dispose(BACKGROUND_CONTEXT);
			await source.dispose(BACKGROUND_CONTEXT);
		}

		// Compared with a plain Pi server's worker, the Endophasia worker adds exactly Inspector, Mission Trace, Runtime
		// Facts, Usage, Continuity and the Runtime Profile.
		const plain = await startServer({ ...workerModel, directory: await temporaryDirectory("endophasia-plain-") });
		servers.push(plain);
		const plainCatalogue = await sessionCatalogue(await attach(plain, "plain"));
		expect(plainCatalogue).not.toContain(EndophasiaInspectorV0.id);
		expect(plainCatalogue).not.toContain(EndophasiaMissionTraceV0.id);
		expect(plainCatalogue).not.toContain(EndophasiaRuntimeFactsV0.id);
		expect(plainCatalogue).not.toContain(EndophasiaUsageV0.id);
		expect(plainCatalogue).not.toContain(EndophasiaContinuityV0.id);
		expect(plainCatalogue).not.toContain(EndophasiaRuntimeProfileV0.id);
		// The Endophasia worker adds exactly its six trusted host services, no more and no less.
		expect(catalogue.filter((id) => !plainCatalogue.includes(id)).sort()).toEqual(
			[
				EndophasiaInspectorV0.id,
				EndophasiaMissionTraceV0.id,
				EndophasiaRuntimeFactsV0.id,
				EndophasiaUsageV0.id,
				EndophasiaContinuityV0.id,
				EndophasiaRuntimeProfileV0.id,
			].sort(),
		);
		expect(plainCatalogue.filter((id) => !catalogue.includes(id))).toEqual([]);
	});

	it("serves each worker's Runtime Profile for that worker's lifetime", async () => {
		const server = await startEndophasiaServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-profile-restart-"),
		});
		servers.push(server);
		const expected = {
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
		const first = await attach(server, "endophasia");
		const firstPid = server.workerPids.get("endophasia");
		expect(await runtimeProfile(first, "endophasia")).toEqual(expected);
		clients.splice(clients.indexOf(first), 1);
		await first.dispose();
		await expect.poll(() => server.workerPids.size, { timeout: 10_000 }).toBe(0);

		// A new worker process publishes its own profile: an equal claim, not a value carried over.
		const second = await attach(server, "endophasia");
		expect(server.workerPids.get("endophasia")).not.toBe(firstPid);
		expect(await runtimeProfile(second, "endophasia")).toEqual(expected);
	});

	it("reseeds a new worker's Usage observation from the durable ledger, not from worker memory", async () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR;
		if (agentDir === undefined) throw new Error("PI_CODING_AGENT_DIR is not set");
		await recordDurableUsage(agentDir, "endophasia", [3, 5]);
		const server = await startEndophasiaServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-usage-restart-"),
		});
		servers.push(server);

		const first = await attach(server, "endophasia");
		const firstPid = server.workerPids.get("endophasia");
		const seededByA = await usageObservation(first, "endophasia");
		expect(seededByA?.rows.map((row) => row.usage.totalTokens)).toEqual([3, 5]);
		expect(seededByA?.hasEarlierRows).toBe(false);
		clients.splice(clients.indexOf(first), 1);
		await first.dispose();
		await expect.poll(() => server.workerPids.size, { timeout: 10_000 }).toBe(0);

		// Written while no worker runs: only the durable ledger can carry it to the next worker.
		await recordDurableUsage(agentDir, "endophasia", [8]);
		const second = await attach(server, "endophasia");
		expect(server.workerPids.get("endophasia")).not.toBe(firstPid);
		const seededByB = await usageObservation(second, "endophasia");
		expect(seededByB?.rows.map((row) => row.usage.totalTokens)).toEqual([3, 5, 8]);
		expect(seededByB?.rows.slice(0, 2)).toEqual(seededByA?.rows);
		expect(seededByB?.hasEarlierRows).toBe(false);
	});

	it("loads in plain Node with coding-agent's source resolver preloaded, without Vitest aliases", async () => {
		const resolver = new URL("../../coding-agent/src/experimental/source-resolver.ts", import.meta.url);
		const script = `
			import { startEndophasiaServer } from ${JSON.stringify(new URL("../runtime/server.ts", import.meta.url).href)};
			import { runEndophasiaSessionWorker } from ${JSON.stringify(new URL("../runtime/session-worker.ts", import.meta.url).href)};
			console.log(typeof startEndophasiaServer, typeof runEndophasiaSessionWorker);
		`;
		const { stdout } = await promisify(execFile)(process.execPath, [
			"--import",
			resolver.href,
			"--input-type=module",
			"--eval",
			script,
		]);
		expect(stdout.trim()).toBe("function function");
	});
});
