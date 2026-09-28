import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { ServerListener } from "@earendil-works/pi-server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type RunningServer, startServer } from "../src/experimental/server.ts";
import { configureExperimentalWorkerModel } from "./experimental-session-support.ts";

type ByteConnectionAcceptor = Parameters<ServerListener["start"]>[0];
type ByteConnection = Parameters<ByteConnectionAcceptor>[0];

const directories: string[] = [];
const servers: RunningServer[] = [];

beforeEach(async () => {
	const agentDir = await temporaryDirectory("pi-listeners-agent-");
	await configureExperimentalWorkerModel(agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join("/tmp", prefix));
	directories.push(directory);
	return directory;
}

function recordingListener(start?: () => Promise<void>): {
	listener: ServerListener;
	events: string[];
	accept(): ByteConnectionAcceptor;
} {
	const events: string[] = [];
	let accept: ByteConnectionAcceptor | undefined;
	return {
		events,
		listener: {
			async start(acceptor) {
				events.push("start");
				await start?.();
				accept = acceptor;
			},
			async close() {
				events.push("close");
			},
		},
		accept() {
			if (accept === undefined) throw new Error("Listener has not started");
			return accept;
		},
	};
}

async function connectUnix(server: RunningServer): Promise<void> {
	const client = await Client.connect({
		serverId: server.serverId,
		transportFactory: createUnixTransportFactory({ path: server.socketPath }),
	});
	await client.dispose();
}

describe("experimental server additional listeners", () => {
	test.each([
		{ label: "undefined", additionalListeners: undefined },
		{ label: "empty", additionalListeners: [] },
	])("keeps the ordinary Unix listener with $label additionalListeners", async ({ additionalListeners }) => {
		const server = await startServer({
			directory: await temporaryDirectory("pi-listeners-"),
			additionalListeners,
		});
		servers.push(server);
		await connectUnix(server);
	});

	test("starts and closes additional listeners with the server beside its Unix listener", async () => {
		const extra = recordingListener();
		const server = await startServer({
			directory: await temporaryDirectory("pi-listeners-"),
			additionalListeners: [extra.listener],
		});
		servers.push(server);
		expect(extra.events).toEqual(["start"]);
		await connectUnix(server);

		await server.close();
		expect(extra.events).toEqual(["start", "close"]);
	});

	test("cleans up the started Unix listener when an additional listener fails to start", async () => {
		const directory = await temporaryDirectory("pi-listeners-");
		const failing = recordingListener(async () => {
			throw new Error("additional listener failed");
		});
		await expect(startServer({ directory, additionalListeners: [failing.listener] })).rejects.toThrow(
			"additional listener failed",
		);
		// The already-started Unix listener removed its socket (the coordinator's own sockets are separate).
		expect((await readdir(directory)).filter((name) => name.startsWith("server-"))).toEqual([]);

		const server = await startServer({ directory });
		servers.push(server);
		await connectUnix(server);
	});

	test("counts additional-listener connections in the server connection lifetime", async () => {
		const extra = recordingListener();
		const server = await startServer({
			directory: await temporaryDirectory("pi-listeners-"),
			keepAlive: false,
			additionalListeners: [extra.listener],
		});
		servers.push(server);
		const connection: ByteConnection = { closed: false, send: async () => {}, close: () => {} };
		const handler = extra.accept()(connection);
		handler.onClose();
		// The counted connection releases the 10s startup hold, so its close retires the idle server after the 1s grace.
		const closedAt = Date.now();
		await server.closed;
		expect(Date.now() - closedAt).toBeLessThan(5_000);
		expect(extra.events).toEqual(["start", "close"]);
	});
});
