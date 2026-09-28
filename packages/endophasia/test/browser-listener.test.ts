import { request } from "node:http";
import { networkInterfaces } from "node:os";
import type { ServerListener } from "@earendil-works/pi-server";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
	type BrowserWebSocketListener,
	createBrowserWebSocketListener,
	loopbackAuthority,
} from "../runtime/browser-listener.ts";

type ByteConnectionAcceptor = Parameters<ServerListener["start"]>[0];
type ByteConnection = Parameters<ByteConnectionAcceptor>[0];

const ORIGIN = "http://127.0.0.1:5173";
const listeners: BrowserWebSocketListener[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.terminate();
	for (const listener of listeners.splice(0)) await listener.close();
});

interface Accepted {
	readonly connection: ByteConnection;
	readonly events: string[];
	readonly data: Uint8Array[];
	readonly errors: Error[];
}

async function startListener(
	options: { port?: number; maxFrameLength?: number; maxPendingBytes?: number; gracefulCloseTimeoutMs?: number } = {},
): Promise<{ listener: BrowserWebSocketListener; accepted: Accepted[]; nextAccepted(): Promise<Accepted> }> {
	const listener = createBrowserWebSocketListener({ allowedOrigins: [ORIGIN, "https://app.example"], ...options });
	listeners.push(listener);
	const accepted: Accepted[] = [];
	const waiters: ((accepted: Accepted) => void)[] = [];
	await listener.start((connection) => {
		const record: Accepted = { connection, events: [], data: [], errors: [] };
		accepted.push(record);
		waiters.shift()?.(record);
		return {
			onData: (chunk) => {
				record.events.push("data");
				record.data.push(chunk);
			},
			onClose: () => record.events.push("close"),
			onError: (error) => {
				record.events.push("error");
				record.errors.push(error);
			},
		};
	});
	return {
		listener,
		accepted,
		nextAccepted: () =>
			accepted.length > 0
				? Promise.resolve(accepted[accepted.length - 1]!)
				: new Promise((resolve) => waiters.push(resolve)),
	};
}

function connect(
	url: string,
	options: { origin?: string; headers?: Record<string, string>; perMessageDeflate?: boolean } = {},
): WebSocket {
	const client = new WebSocket(url, {
		...(options.origin === undefined ? {} : { origin: options.origin }),
		headers: options.headers,
		perMessageDeflate: options.perMessageDeflate ?? false,
	});
	clients.push(client);
	return client;
}

function opened(client: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		client.once("open", () => resolve());
		client.once("error", reject);
	});
}

/** Resolve with the HTTP status of a refused WebSocket upgrade. */
function refusedStatus(client: WebSocket): Promise<number> {
	return new Promise((resolve, reject) => {
		client.once("open", () => reject(new Error("upgrade was accepted")));
		client.once("unexpected-response", (_request, response) => {
			resolve(response.statusCode ?? 0);
			response.resume();
		});
		client.once("error", () => {});
	});
}

function closedWith(client: WebSocket): Promise<{ code: number; messages: Buffer[] }> {
	const messages: Buffer[] = [];
	client.on("message", (data) => messages.push(Buffer.from(data as Buffer)));
	return new Promise((resolve) => client.once("close", (code) => resolve({ code, messages })));
}

function capabilityOf(url: string): string {
	return new URL(url).pathname.slice("/pi/".length);
}

describe("Endophasia browser WebSocket listener", () => {
	it("binds 127.0.0.1 and issues an unguessable capability URL", async () => {
		const first = (await startListener()).listener;
		const second = (await startListener()).listener;
		const url = new URL(first.url);
		expect(url.protocol).toBe("ws:");
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.pathname).toMatch(/^\/pi\/[A-Za-z0-9_-]{43}$/);
		expect(url.search).toBe("");
		expect(capabilityOf(first.url)).not.toBe(capabilityOf(second.url));

		// Not reachable through any other interface of this host.
		const external = Object.values(networkInterfaces())
			.flat()
			.find((address) => address !== undefined && !address.internal && address.family === "IPv4");
		if (external !== undefined) {
			const refused = await new Promise<string | undefined>((resolve) => {
				const outgoing = request({ host: external.address, port: url.port, path: "/" }, (incoming) => {
					incoming.resume();
					resolve(undefined);
				});
				outgoing.on("error", (error: NodeJS.ErrnoException) => resolve(error.code));
				outgoing.end();
			});
			expect(refused).toBe("ECONNREFUSED");
		}
	});

	it("rejects missing, wildcard, null, pattern and non-canonical allowed origins at creation", () => {
		for (const allowedOrigins of [
			[],
			["*"],
			["null"],
			["http://localhost:*"],
			["http://127.0.0.1:5173/"],
			["http://127.0.0.1:5173/app"],
			["HTTP://127.0.0.1:5173"],
			["http://user@127.0.0.1:5173"],
			["file:///index.html"],
			["ws://127.0.0.1:5173"],
			["127.0.0.1:5173"],
		]) {
			expect(() => createBrowserWebSocketListener({ allowedOrigins }), JSON.stringify(allowedOrigins)).toThrow(
				TypeError,
			);
		}
		expect(() => createBrowserWebSocketListener({ allowedOrigins: [ORIGIN], port: 70_000 })).toThrow(TypeError);
		expect(() =>
			createBrowserWebSocketListener({ allowedOrigins: [ORIGIN], maxFrameLength: 8, maxPendingBytes: 11 }),
		).toThrow(TypeError);
	});

	it("admits an allowlisted origin at the capability path and carries binary chunks both ways", async () => {
		const { listener, nextAccepted } = await startListener();
		const client = connect(listener.url, { origin: ORIGIN });
		await opened(client);
		const accepted = await nextAccepted();
		expect(client.extensions).toBe("");
		expect(client.protocol).toBe("");

		client.send(new Uint8Array([1, 2, 3]));
		await expect.poll(() => accepted.data).toEqual([new Uint8Array([1, 2, 3])]);

		const received = new Promise<Buffer>((resolve) => client.once("message", (data) => resolve(data as Buffer)));
		await accepted.connection.send(new Uint8Array([4, 5]));
		expect([...(await received)]).toEqual([4, 5]);
	});

	it("refuses origins that are missing, null, unexpected or only similar to an allowed origin", async () => {
		const { listener, accepted } = await startListener();
		for (const origin of [
			undefined,
			"null",
			"http://127.0.0.1:5174",
			"http://localhost:5173",
			"https://127.0.0.1:5173",
			"http://127.0.0.1:5173.evil.test",
			"http://evil.test",
			"https://app.example.evil.test",
			"https://evil-app.example",
			"http://127.0.0.1:5173/",
			"*",
		]) {
			expect(await refusedStatus(connect(listener.url, { origin })), String(origin)).toBe(403);
		}
		expect(accepted).toEqual([]);
	});

	it("refuses a Host other than the issued loopback address", async () => {
		const { listener, accepted } = await startListener();
		const port = new URL(listener.url).port;
		for (const host of [`localhost:${port}`, `evil.test:${port}`, "127.0.0.1"]) {
			expect(await refusedStatus(connect(listener.url, { origin: ORIGIN, headers: { host } })), host).toBe(403);
		}
		expect(accepted).toEqual([]);
	});

	it("expects the Host header browsers send, without the default port", () => {
		expect(loopbackAuthority(80)).toBe("127.0.0.1");
		expect(loopbackAuthority(5173)).toBe("127.0.0.1:5173");
		expect(loopbackAuthority(443)).toBe("127.0.0.1:443");
	});

	it("admits browser upgrades on the default port 80", async (context) => {
		let started: Awaited<ReturnType<typeof startListener>>;
		try {
			started = await startListener({ port: 80 });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EADDRINUSE") context.skip(`port 80 is unavailable (${code})`);
			throw error;
		}
		const { listener, nextAccepted } = started;
		// Browsers, like ws, drop the default port from both the URL and the Host header.
		expect(listener.url).toMatch(/^ws:\/\/127\.0\.0\.1\/pi\//);
		await opened(connect(listener.url, { origin: ORIGIN }));
		await nextAccepted();
		expect(await refusedStatus(connect(listener.url, { origin: ORIGIN, headers: { host: "127.0.0.1:80" } }))).toBe(
			403,
		);
	});

	it("upgrades only the exact capability path", async () => {
		const { listener, accepted } = await startListener();
		const base = new URL(listener.url);
		const capability = capabilityOf(listener.url);
		for (const path of [
			"/ws",
			"/pi",
			"/pi/",
			`/pi/${capability}/`,
			`/pi/${capability}x`,
			`/pi/${capability.slice(0, -1)}`,
			`/pi/${capability}?x=1`,
			`/PI/${capability}`,
			`/other/${capability}`,
		]) {
			expect(await refusedStatus(connect(`ws://${base.host}${path}`, { origin: ORIGIN })), path).toBe(404);
		}
		expect(accepted).toEqual([]);
	});

	it("answers ordinary HTTP requests with an empty 404 and no CORS headers", async () => {
		const { listener } = await startListener();
		const url = new URL(listener.url);
		for (const path of [url.pathname, "/", "/pi"]) {
			const response = await new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
				(resolve, reject) => {
					const outgoing = request(
						{ host: "127.0.0.1", port: url.port, path, headers: { origin: ORIGIN } },
						(incoming) => {
							let body = "";
							incoming.on("data", (chunk) => {
								body += String(chunk);
							});
							incoming.on("end", () =>
								resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }),
							);
						},
					);
					outgoing.on("error", reject);
					outgoing.end();
				},
			);
			expect(response.status).toBe(404);
			expect(response.body).toBe("");
			expect(Object.keys(response.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
		}
	});

	it("negotiates no per-message compression even when the client offers it", async () => {
		const { listener } = await startListener();
		const client = connect(listener.url, { origin: ORIGIN, perMessageDeflate: true });
		await opened(client);
		expect(client.extensions).toBe("");
	});

	it("rejects a text message with one error and closes with 1003", async () => {
		const { listener, nextAccepted } = await startListener();
		const client = connect(listener.url, { origin: ORIGIN });
		await opened(client);
		const accepted = await nextAccepted();
		const closed = closedWith(client);
		client.send("text frame");
		expect((await closed).code).toBe(1003);
		await expect.poll(() => accepted.connection.closed).toBe(true);
		expect(accepted.events).toEqual(["error"]);
		expect(accepted.errors[0]).toBeInstanceOf(TypeError);
		await expect(accepted.connection.send(new Uint8Array([1]))).rejects.toThrow("WebSocket connection is closed");
	});

	it("rejects a message larger than one Pi frame with one error", async () => {
		const { listener, nextAccepted } = await startListener({ maxFrameLength: 16 });
		// A frame and its 4-byte length prefix fit exactly; one more byte does not.
		const client = connect(listener.url, { origin: ORIGIN });
		await opened(client);
		const accepted = await nextAccepted();
		const closed = closedWith(client);
		client.send(new Uint8Array(20));
		await expect.poll(() => accepted.data.map((chunk) => chunk.byteLength)).toEqual([20]);
		client.send(new Uint8Array(21));
		expect((await closed).code).toBe(1009);
		await expect.poll(() => accepted.connection.closed).toBe(true);
		expect(accepted.events).toEqual(["data", "error"]);
	});

	it("reports an orderly remote close exactly once", async () => {
		const { listener, nextAccepted } = await startListener();
		const client = connect(listener.url, { origin: ORIGIN });
		await opened(client);
		const accepted = await nextAccepted();
		client.close(1000);
		await expect.poll(() => accepted.connection.closed).toBe(true);
		expect(accepted.events).toEqual(["close"]);
	});

	it("copies, orders and bounds outgoing chunks", async () => {
		const { listener, nextAccepted } = await startListener({ maxFrameLength: 8, maxPendingBytes: 12 });
		const client = connect(listener.url, { origin: ORIGIN });
		await opened(client);
		const accepted = await nextAccepted();
		const messages: number[][] = [];
		client.on("message", (data) => messages.push([...(data as Buffer)]));

		await expect(accepted.connection.send("text" as unknown as Uint8Array)).rejects.toBeInstanceOf(TypeError);
		const chunk = new Uint8Array([1, 1, 1, 1, 1, 1]);
		const sends = [accepted.connection.send(chunk), accepted.connection.send(new Uint8Array([2, 2, 2, 2, 2, 2]))];
		chunk.fill(9);
		await expect(accepted.connection.send(new Uint8Array([3]))).rejects.toThrow("pending byte limit");
		await Promise.all(sends);
		await expect
			.poll(() => messages)
			.toEqual([
				[1, 1, 1, 1, 1, 1],
				[2, 2, 2, 2, 2, 2],
			]);
	});

	it("closes after queued writes and the final chunk, and repeated close is harmless", async () => {
		const { listener, nextAccepted } = await startListener();
		const client = connect(listener.url, { origin: ORIGIN });
		await opened(client);
		const accepted = await nextAccepted();
		const closed = closedWith(client);

		const sends = [1, 2, 3].map((value) => accepted.connection.send(new Uint8Array([value])));
		const finalChunk = new Uint8Array([4]);
		const closing = accepted.connection.close(finalChunk);
		finalChunk.fill(9);
		expect(accepted.connection.close()).toBe(closing);
		await expect(accepted.connection.send(new Uint8Array([5]))).rejects.toThrow("WebSocket connection is closed");
		await Promise.all(sends);
		await closing;
		const { code, messages } = await closed;
		expect(code).toBe(1000);
		expect(messages.map((message) => [...message])).toEqual([[1], [2], [3], [4]]);
		expect(accepted.connection.closed).toBe(true);
		await accepted.connection.close();
		expect(accepted.events).toEqual(["close"]);
	});

	it("terminates a peer that does not complete the close handshake", async () => {
		const { listener, nextAccepted } = await startListener({ gracefulCloseTimeoutMs: 50 });
		const client = connect(listener.url, { origin: ORIGIN });
		await opened(client);
		const accepted = await nextAccepted();
		// Stop reading, so the client never answers the server's close frame.
		(client as unknown as { _socket: { pause(): void } })._socket.pause();
		await accepted.connection.close();
		expect(accepted.connection.closed).toBe(true);
	});

	it("closes its connections and stops listening, idempotently", async () => {
		const { listener, nextAccepted } = await startListener();
		const client = connect(listener.url, { origin: ORIGIN });
		await opened(client);
		const accepted = await nextAccepted();
		const closed = closedWith(client);
		const url = listener.url;

		const closing = listener.close();
		expect(listener.close()).toBe(closing);
		await closing;
		expect((await closed).code).toBe(1000);
		expect(accepted.connection.closed).toBe(true);
		await expect(opened(connect(url, { origin: ORIGIN }))).rejects.toThrow();
		await expect(listener.start(() => ({ onData() {}, onClose() {}, onError() {} }))).rejects.toThrow();
	});
});
