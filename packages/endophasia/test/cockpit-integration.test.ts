import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { parseBootstrap } from "../cockpit/bootstrap.ts";
import { type EndophasiaPresentationClientV0, openEndophasiaPresentationClientV0 } from "../presentation/client.ts";
import { type BrowserWebSocket, createBrowserWebSocketTransportFactory } from "../presentation/websocket-transport.ts";
import { buildCockpitAssets, type RunningEndophasiaCockpit, startEndophasiaCockpit } from "../runtime/cockpit.ts";
import type { CockpitAssets } from "../runtime/cockpit-host.ts";

const directories: string[] = [];
const cockpits: RunningEndophasiaCockpit[] = [];
const presentations: EndophasiaPresentationClientV0[] = [];
const workerModel = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;
let assets: CockpitAssets | undefined;

beforeEach(async () => {
	const agentDir = await temporaryDirectory("endophasia-cockpit-agent-");
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), {
		mode: 0o600,
	});
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	await createSessions(join(agentDir, "experimental", "sessions"), ["observed"]);
});

afterEach(async () => {
	for (const presentation of presentations.splice(0)) await presentation.dispose();
	for (const cockpit of cockpits.splice(0)) await cockpit.close();
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
			const session = await repo.create({ id, cwd: process.cwd() }, BACKGROUND_CONTEXT);
			const main = await session.createBranch("main", null, BACKGROUND_CONTEXT);
			await main.appendMessage({ role: "user", content: "cockpit-sentinel", timestamp: 1 }, BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await repo.close(BACKGROUND_CONTEXT);
		await fileSystem.cleanup(BACKGROUND_CONTEXT);
	}
}

function get(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const outgoing = request(url, (incoming) => {
			let body = "";
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk) => {
				body += chunk;
			});
			incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
		});
		outgoing.on("error", reject);
		outgoing.end();
	});
}

/** A browser page served by the cockpit sends the cockpit's origin; Node's global WebSocket sends none. */
function pageTransport(url: string, origin: string) {
	return createBrowserWebSocketTransportFactory({
		url,
		webSocketFactory: (socketUrl): BrowserWebSocket => new WebSocket(socketUrl, { origin, perMessageDeflate: false }),
	});
}

async function startCockpit(): Promise<RunningEndophasiaCockpit> {
	assets ??= await buildCockpitAssets();
	const cockpit = await startEndophasiaCockpit({
		...workerModel,
		directory: await temporaryDirectory("endophasia-cockpit-server-"),
		assets,
	});
	cockpits.push(cockpit);
	return cockpit;
}

describe("Standard Cockpit integration", () => {
	it("bootstraps the real Presentation Client over the Pi WebSocket from the cockpit host", async () => {
		const cockpit = await startCockpit();
		const origin = new URL(cockpit.url).origin;
		const shell = await get(cockpit.url);
		expect(shell.status).toBe(200);
		expect(shell.body).toContain('<script type="module" src="app.js"></script>');
		expect((await get(`${origin}/app.js`)).body.length).toBeGreaterThan(1_000);

		const bootstrapResponse = await get(`${origin}/bootstrap.json`);
		const bootstrap = parseBootstrap(JSON.parse(bootstrapResponse.body));
		expect(bootstrap).toEqual({ serverId: cockpit.server.serverId, websocketUrl: cockpit.server.browser.url });

		const presentation = await openEndophasiaPresentationClientV0({
			serverId: bootstrap.serverId,
			transportFactory: pageTransport(bootstrap.websocketUrl, origin),
		});
		presentations.push(presentation);
		expect(presentation.connection.value).toMatchObject({ status: "connected" });
		expect(presentation.sessions.value?.sessions.map((session) => session.sessionId)).toEqual(["observed"]);

		await presentation.attach("observed", BACKGROUND_CONTEXT);
		const snapshot = presentation.transcript.value?.snapshot;
		expect(snapshot?.lane).toBe("main");
		expect(snapshot?.transcript).toEqual([
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({ content: "cockpit-sentinel" }),
			}),
		]);
		expect(await presentation.sessionOverview(BACKGROUND_CONTEXT)).toMatchObject({
			schemaVersion: "session-overview.v0",
			consistency: "per-lane",
			lanes: [{ name: "main", tipId: snapshot?.tipId, operation: null }],
		});
	});

	it("admits only the cockpit's own origin to the Pi WebSocket", async () => {
		const cockpit = await startCockpit();
		const bootstrap = parseBootstrap(JSON.parse((await get(`${new URL(cockpit.url).origin}/bootstrap.json`)).body));
		await expect(
			openEndophasiaPresentationClientV0({
				serverId: bootstrap.serverId,
				transportFactory: pageTransport(bootstrap.websocketUrl, "http://127.0.0.1:1"),
			}),
		).rejects.toThrow("WebSocket transport failed");
	});

	it("stops the host and the runtime together, idempotently", async () => {
		const cockpit = await startCockpit();
		const origin = new URL(cockpit.url).origin;
		const closing = cockpit.close();
		expect(cockpit.close()).toBe(closing);
		await closing;
		await cockpit.closed;
		await expect(get(cockpit.url)).rejects.toMatchObject({ code: "ECONNREFUSED" });
		await expect(
			openEndophasiaPresentationClientV0({
				serverId: cockpit.server.serverId,
				transportFactory: pageTransport(cockpit.server.browser.url, origin),
			}),
		).rejects.toThrow();
	});

	it("closes the cockpit host when the runtime fails to start", async () => {
		assets ??= await buildCockpitAssets();
		const parent = await temporaryDirectory("endophasia-cockpit-fail-");
		const blocker = join(parent, "file");
		await writeFile(blocker, "");
		const reserved = await startEndophasiaCockpit({
			...workerModel,
			directory: await temporaryDirectory("endophasia-cockpit-port-"),
			assets,
		});
		const port = Number(new URL(reserved.url).port);
		await reserved.close();

		await expect(
			startEndophasiaCockpit({ ...workerModel, directory: join(blocker, "server"), assets, port }),
		).rejects.toThrow();
		await expect(get(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: "ECONNREFUSED" });
		expect(await readdir(parent)).toEqual(["file"]);
	});
});

describe("Standard Cockpit source boundaries", () => {
	const cockpitFiles = ["bootstrap.ts", "controller.ts", "main.ts", "view-model.ts", "view.ts"];

	it("never writes untrusted text through HTML parsing sinks", async () => {
		for (const file of cockpitFiles) {
			const source = await readFile(new URL(`../cockpit/${file}`, import.meta.url), "utf8");
			expect(source, file).not.toMatch(
				/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/,
			);
		}
	});

	it("reaches the runtime only through Presentation Client v0 and the browser transport", async () => {
		for (const file of cockpitFiles) {
			const source = await readFile(new URL(`../cockpit/${file}`, import.meta.url), "utf8");
			const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)].map((match) => ({
				typeOnly: match[1] !== undefined,
				specifier: match[2]!,
			}));
			for (const { typeOnly, specifier } of imports) {
				const allowed =
					specifier.startsWith("./") ||
					specifier === "../presentation/client.ts" ||
					specifier === "../presentation/websocket-transport.ts" ||
					specifier === "@earendil-works/chord/context" ||
					// Types only: Pi's replicated state shapes and the Session Overview schema.
					(typeOnly &&
						(specifier === "@earendil-works/chord" ||
							specifier === "../src/session-overview.ts" ||
							specifier.startsWith("@earendil-works/pi-coding-agent/experimental/services/")));
				expect(allowed, `${file} imports ${typeOnly ? "type " : ""}${specifier}`).toBe(true);
			}
		}
	});
});
