import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
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
import { EndophasiaInspectorV0, EndophasiaMissionTraceV0 } from "../src/index.ts";

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
		for (const service of [AgentController, Models, Transcript, SessionPlugins]) {
			expect(catalogue).toContain(service.id);
		}

		const source = createSessionServiceSource(client);
		const services = source.open({ services: [EndophasiaInspectorV0], assertAccess() {}, onError() {} });
		const inspector = services.use(EndophasiaInspectorV0);
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
		} finally {
			await services.dispose(BACKGROUND_CONTEXT);
			await source.dispose(BACKGROUND_CONTEXT);
		}

		// Compared with a plain Pi server's worker, the Endophasia worker adds exactly the Inspector and Mission Trace.
		const plain = await startServer({ ...workerModel, directory: await temporaryDirectory("endophasia-plain-") });
		servers.push(plain);
		const plainCatalogue = await sessionCatalogue(await attach(plain, "plain"));
		expect(plainCatalogue).not.toContain(EndophasiaInspectorV0.id);
		expect(plainCatalogue).not.toContain(EndophasiaMissionTraceV0.id);
		// The Endophasia worker adds exactly its two trusted host services, no more and no less.
		expect(catalogue.filter((id) => !plainCatalogue.includes(id)).sort()).toEqual(
			[EndophasiaInspectorV0.id, EndophasiaMissionTraceV0.id].sort(),
		);
		expect(plainCatalogue.filter((id) => !catalogue.includes(id))).toEqual([]);
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
