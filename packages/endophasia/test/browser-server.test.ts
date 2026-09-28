import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { RunningServer } from "@earendil-works/pi-coding-agent/experimental/server";
import { AgentController } from "@earendil-works/pi-coding-agent/experimental/services/agent-controller";
import {
	createServerServiceSource,
	createSessionServiceSource,
} from "@earendil-works/pi-coding-agent/experimental/services/connection";
import { SessionManagement } from "@earendil-works/pi-coding-agent/experimental/services/sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type EndophasiaPresentationClientV0, openEndophasiaPresentationClientV0 } from "../presentation/client.ts";
import { type BrowserWebSocket, createBrowserWebSocketTransportFactory } from "../presentation/websocket-transport.ts";
import { type RunningEndophasiaBrowserServer, startEndophasiaBrowserServer } from "../runtime/browser-server.ts";

const ORIGIN = "http://127.0.0.1:5173";
const directories: string[] = [];
const servers: RunningServer[] = [];
const presentations: EndophasiaPresentationClientV0[] = [];
const workerModel = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;

beforeEach(async () => {
	// The standard worker resolves its configured model offline from a local API-key credential.
	const agentDir = await temporaryDirectory("endophasia-browser-agent-");
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), {
		mode: 0o600,
	});
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	await createSessions(join(agentDir, "experimental", "sessions"), ["browser", "unix"]);
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

async function startBrowserServer(): Promise<RunningEndophasiaBrowserServer> {
	const server = await startEndophasiaBrowserServer({
		...workerModel,
		directory: await temporaryDirectory("endophasia-browser-server-"),
		browser: { allowedOrigins: [ORIGIN] },
	});
	servers.push(server);
	return server;
}

/** Node's global WebSocket sends no Origin header; tests stand in for a browser page served from ORIGIN. */
function browserTransport(url: string, origin = ORIGIN) {
	return createBrowserWebSocketTransportFactory({
		url,
		webSocketFactory: (socketUrl): BrowserWebSocket => new WebSocket(socketUrl, { origin, perMessageDeflate: false }),
	});
}

async function openPresentation(
	serverId: string,
	transportFactory: Parameters<typeof openEndophasiaPresentationClientV0>[0]["transportFactory"],
	errors: Error[],
): Promise<EndophasiaPresentationClientV0> {
	const presentation = await openEndophasiaPresentationClientV0({
		serverId,
		transportFactory,
		onError: (error) => errors.push(error),
	});
	presentations.push(presentation);
	return presentation;
}

async function observe(presentation: EndophasiaPresentationClientV0, sessionId: string): Promise<void> {
	await presentation.attach(sessionId, BACKGROUND_CONTEXT);
	expect(presentation.attachment.value).toEqual({ status: "attached", sessionId });
	expect(presentation.transcript.value?.snapshot).toMatchObject({ lane: "main", operation: null });
	expect(presentation.models.value?.configuration.model).toEqual({
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
	});
	expect(await presentation.sessionOverview(BACKGROUND_CONTEXT)).toMatchObject({
		schemaVersion: "session-overview.v0",
		consistency: "per-lane",
		lanes: [{ name: "main", operation: null }],
		counts: { lanes: 1, activeOperations: 0, abortingOperations: 0 },
	});
}

/**
 * Start an Endophasia browser server whose worker model is a local endpoint on a closed loopback port, so a real run
 * fails locally and no request leaves the machine.
 */
async function startClosedLocalServer(prefix: string): Promise<RunningEndophasiaBrowserServer> {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir === undefined) throw new Error("PI_CODING_AGENT_DIR is not set");
	const closedPort = await new Promise<number>((resolve, reject) => {
		const probe = createNetServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 9));
		});
	});
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"closed-local": {
					baseUrl: `http://127.0.0.1:${closedPort}/v1`,
					api: "openai-completions",
					apiKey: "unused",
					models: [{ id: "closed-model" }],
				},
			},
		}),
	);
	const server = await startEndophasiaBrowserServer({
		provider: "closed-local",
		model: "closed-model",
		directory: await temporaryDirectory(prefix),
		browser: { allowedOrigins: [ORIGIN] },
	});
	servers.push(server);
	return server;
}

/** Run one prompt through a separate, trusted Pi client over the Unix socket; the presentation only observes. */
async function promptFromControlClient(
	server: RunningEndophasiaBrowserServer,
	sessionId: string,
	message: string,
): Promise<{ operationId: string; dispose(): Promise<void> }> {
	const control = await Client.connect({
		serverId: server.serverId,
		transportFactory: createUnixTransportFactory({ path: server.socketPath }),
	});
	const serverSource = createServerServiceSource(control);
	const sessionSource = createSessionServiceSource(control);
	const dispose = async (): Promise<void> => {
		await sessionSource.dispose(BACKGROUND_CONTEXT);
		await serverSource.dispose(BACKGROUND_CONTEXT);
		await control.dispose();
	};
	try {
		const management = serverSource.open({ services: [SessionManagement], assertAccess() {}, onError() {} });
		const agent = sessionSource.open({ services: [AgentController], assertAccess() {}, onError() {} });
		await management.ready(BACKGROUND_CONTEXT);
		await management.use(SessionManagement).attach(sessionId, BACKGROUND_CONTEXT);
		await sessionSource.whenAttached(sessionId, BACKGROUND_CONTEXT);
		await agent.ready(BACKGROUND_CONTEXT);
		const response = await agent.use(AgentController).prompt({ message, images: null }, BACKGROUND_CONTEXT);
		expect(response).toMatchObject({ accepted: true });
		if (response.operationId === null) throw new Error("Expected an accepted operation ID");
		return { operationId: response.operationId, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}

describe("Endophasia browser server", () => {
	it("serves the Presentation Client over loopback WebSocket beside the unchanged Unix listener", async () => {
		const server = await startBrowserServer();
		expect(server.browser.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/pi\/[A-Za-z0-9_-]{43}$/);
		expect(server.socketPath).toEqual(expect.any(String));

		const errors: Error[] = [];
		const browser = await openPresentation(server.serverId, browserTransport(server.browser.url), errors);
		const unix = await openPresentation(
			server.serverId,
			createUnixTransportFactory({ path: server.socketPath }),
			errors,
		);
		for (const presentation of [browser, unix]) {
			expect(presentation.connection.value).toMatchObject({ status: "connected" });
			expect(presentation.sessions.value?.sessions.map((session) => session.sessionId).sort()).toEqual([
				"browser",
				"unix",
			]);
		}

		// Both transports reach the same Pi server and its Endophasia Session workers at once.
		await Promise.all([observe(browser, "browser"), observe(unix, "unix")]);
		expect([...server.workerPids.keys()].sort()).toEqual(["browser", "unix"]);

		await browser.detach(BACKGROUND_CONTEXT);
		expect(browser.attachment.value).toEqual({ status: "detached" });
		await expect.poll(() => [...server.workerPids.keys()], { timeout: 10_000 }).toEqual(["unix"]);
		expect(unix.attachment.value).toEqual({ status: "attached", sessionId: "unix" });

		await browser.dispose();
		await unix.dispose();
		expect(errors).toEqual([]);
		await expect.poll(() => server.workerPids.size, { timeout: 10_000 }).toBe(0);
	});

	it("delivers the live Mission Trace over the WebSocket while a separate client runs work", async () => {
		const server = await startClosedLocalServer("endophasia-browser-trace-");
		const errors: Error[] = [];
		const browser = await openPresentation(server.serverId, browserTransport(server.browser.url), errors);
		await browser.attach("browser", BACKGROUND_CONTEXT);
		expect(browser.missionTrace.value).toEqual({
			schemaVersion: "mission-trace-observation.v0",
			scope: "session-worker-lifetime",
			events: [],
		});
		const revisions: number[] = [];
		browser.missionTrace.subscribe((value) => revisions.push(value.events.length));

		// A trusted, ordinary Pi client drives the Session; the presentation only observes.
		const control = await promptFromControlClient(server, "browser", "user-prompt-sentinel");
		try {
			// The provider refuses the connection, so the real run fails; its lifecycle still arrives live.
			await expect
				.poll(() => browser.missionTrace.value?.events.at(-1)?.kind, { timeout: 20_000 })
				.toBe("mission.failed");
			const events = browser.missionTrace.value?.events ?? [];
			// The failure came from the local closed endpoint; its detail lives in the transcript, never in the trace.
			expect(browser.transcript.value?.snapshot?.transcript.at(-1)).toMatchObject({
				type: "message",
				message: { role: "assistant", provider: "closed-local", stopReason: "error" },
			});
			expect(events[0]).toMatchObject({ kind: "mission.started", lane: "main", sequence: 1 });
			expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index + 1));
			expect(new Set(events.map(({ runId }) => runId))).toEqual(new Set([control.operationId]));
			expect(JSON.stringify(browser.missionTrace.value)).not.toMatch(/user-prompt-sentinel|test-key|error/i);
			// Revisions arrived one by one through state subscription, not as a single refresh.
			expect(revisions.length).toBeGreaterThanOrEqual(2);
			expect(revisions.at(-1)).toBe(events.length);
		} finally {
			await control.dispose();
		}
		expect(errors).toEqual([]);
	});

	it("serves Runtime Facts over the WebSocket for a real settled operation, metadata only", async () => {
		const server = await startClosedLocalServer("endophasia-browser-facts-");
		const errors: Error[] = [];
		const browser = await openPresentation(server.serverId, browserTransport(server.browser.url), errors);
		await browser.attach("browser", BACKGROUND_CONTEXT);
		const baseline = await browser.runtimeMetrics(BACKGROUND_CONTEXT);
		expect(baseline).toMatchObject({ schemaVersion: "runtime-metrics.v0", scope: "session", messageCount: 0 });

		const control = await promptFromControlClient(server, "browser", "user-prompt-sentinel");
		try {
			// Nothing is live: poll the durable result the way a caller would, by exact operation ID.
			await expect
				.poll(() => browser.operationOutcome(control.operationId, BACKGROUND_CONTEXT), { timeout: 20_000 })
				.not.toBeNull();
			const outcome = await browser.operationOutcome(control.operationId, BACKGROUND_CONTEXT);
			expect(outcome).toMatchObject({
				schemaVersion: "operation-outcome.v0",
				operationId: control.operationId,
				kind: "run",
				status: "failed",
				errorCode: expect.any(String),
			});
			expect(outcome).not.toHaveProperty("lane");
			expect(outcome?.startedAt).toBeLessThanOrEqual(outcome?.endedAt ?? 0);

			// The same Session's replicated transcript is Pi's own view; accounting must match its stats exactly.
			await expect.poll(() => browser.transcript.value?.snapshot?.operation, { timeout: 20_000 }).toBeNull();
			const snapshot = browser.transcript.value?.snapshot;
			const metrics = await browser.runtimeMetrics(BACKGROUND_CONTEXT);
			expect(metrics).toEqual({ schemaVersion: "runtime-metrics.v0", scope: "session", ...snapshot?.stats });
			expect(metrics.messageCount).toBeGreaterThan(baseline.messageCount);
			expect(metrics).not.toHaveProperty("lane");

			// The failure detail exists in Pi's transcript, but only the error code crosses the Runtime Facts boundary.
			const failed = snapshot?.transcript.at(-1);
			expect(failed).toMatchObject({
				type: "message",
				message: { role: "assistant", stopReason: "error", errorMessage: expect.any(String) },
			});
			const detail =
				failed?.type === "message" && failed.message.role === "assistant" ? failed.message.errorMessage : undefined;
			expect(detail?.length).toBeGreaterThan(0);
			for (const fact of [JSON.stringify(outcome), JSON.stringify(metrics)]) {
				expect(fact).not.toMatch(/user-prompt-sentinel|test-key|closed-local|127\.0\.0\.1/);
				if (detail !== undefined) expect(fact).not.toContain(detail);
			}
			expect(JSON.stringify(outcome)).not.toMatch(/message|details|stack/);
		} finally {
			await control.dispose();
		}
		expect(errors).toEqual([]);
	});

	it("admits the transport by capability but still verifies the Pi server identity", async () => {
		const server = await startBrowserServer();
		// The capability URL admits the bytes; the Pi handshake then refuses a different, well-formed server identity.
		const handshake = Client.connect({
			serverId: randomUUID(),
			transportFactory: browserTransport(server.browser.url),
		});
		await expect(handshake).rejects.toThrow();
		await expect(handshake).rejects.not.toThrow("WebSocket transport");

		const client = await Client.connect({
			serverId: server.serverId,
			transportFactory: browserTransport(server.browser.url),
		});
		await client.dispose();
	});

	it("refuses unlisted origins, Origin-less clients and other capabilities", async () => {
		const server = await startBrowserServer();
		const url = new URL(server.browser.url);
		await expect(
			Client.connect({
				serverId: server.serverId,
				transportFactory: browserTransport(server.browser.url, "http://127.0.0.1:5174"),
			}),
		).rejects.toThrow("WebSocket transport failed");
		// The default factory uses the platform WebSocket, which in Node sends no Origin.
		await expect(
			Client.connect({
				serverId: server.serverId,
				transportFactory: createBrowserWebSocketTransportFactory({ url: server.browser.url }),
			}),
		).rejects.toThrow("WebSocket transport failed");
		await expect(
			Client.connect({
				serverId: server.serverId,
				transportFactory: browserTransport(`ws://${url.host}/pi/${"A".repeat(43)}`),
			}),
		).rejects.toThrow("WebSocket transport failed");

		// A second browser server issues a different capability, which this one does not accept.
		const other = await startBrowserServer();
		await expect(
			Client.connect({
				serverId: server.serverId,
				transportFactory: browserTransport(`ws://${url.host}${new URL(other.browser.url).pathname}`),
			}),
		).rejects.toThrow("WebSocket transport failed");
	});

	it("rejects invalid origins before starting the server", async () => {
		const directory = await temporaryDirectory("endophasia-browser-invalid-");
		await expect(
			startEndophasiaBrowserServer({ ...workerModel, directory, browser: { allowedOrigins: ["*"] } }),
		).rejects.toThrow(TypeError);
		await expect(
			startEndophasiaBrowserServer({ ...workerModel, directory, browser: { allowedOrigins: [] } }),
		).rejects.toThrow(TypeError);
		expect(await readdir(directory)).toEqual([]);
	});

	it("stops accepting browser connections when the server closes", async () => {
		const server = await startBrowserServer();
		const client = await Client.connect({
			serverId: server.serverId,
			transportFactory: browserTransport(server.browser.url),
		});
		await server.close();
		await expect.poll(() => client.connectionState).not.toBe("connected");
		await client.dispose();
		await expect(
			Client.connect({ serverId: server.serverId, transportFactory: browserTransport(server.browser.url) }),
		).rejects.toThrow();
	});

	it("loads in plain Node with coding-agent's source resolver preloaded, without Vitest aliases", async () => {
		const resolver = new URL("../../coding-agent/src/experimental/source-resolver.ts", import.meta.url);
		const script = `
			import { startEndophasiaBrowserServer } from ${JSON.stringify(new URL("../runtime/browser-server.ts", import.meta.url).href)};
			import { createBrowserWebSocketTransportFactory } from ${JSON.stringify(new URL("../presentation/websocket-transport.ts", import.meta.url).href)};
			console.log(typeof startEndophasiaBrowserServer, typeof createBrowserWebSocketTransportFactory);
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
