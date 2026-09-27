import type { ByteTransport, ByteTransportHandlers } from "@earendil-works/pi-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BrowserWebSocket, createBrowserWebSocketTransportFactory } from "../presentation/websocket-transport.ts";

type EventType = "open" | "message" | "error" | "close";

class FakeWebSocket implements BrowserWebSocket {
	binaryType = "blob";
	bufferedAmount = 0;
	readyState = 0;
	readonly sent: Uint8Array[] = [];
	readonly closes: (number | undefined)[] = [];
	private readonly listeners = new Map<EventType, ((event: { readonly data: unknown }) => void)[]>();

	send(data: Uint8Array): void {
		if (this.readyState !== 1) throw new Error("fake socket is not open");
		this.sent.push(data);
	}

	close(code?: number): void {
		this.closes.push(code);
		if (this.readyState < 2) this.readyState = 2;
	}

	addEventListener(type: EventType, listener: (event: { readonly data: unknown }) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	emit(type: EventType, event: { readonly data: unknown } = { data: undefined }): void {
		if (type === "open") this.readyState = 1;
		if (type === "close") this.readyState = 3;
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

interface Recorded {
	readonly handlers: ByteTransportHandlers;
	readonly events: string[];
	readonly data: Uint8Array[];
	readonly errors: Error[];
}

function recordHandlers(): Recorded {
	const events: string[] = [];
	const data: Uint8Array[] = [];
	const errors: Error[] = [];
	return {
		events,
		data,
		errors,
		handlers: {
			onData: (chunk) => {
				events.push("data");
				data.push(chunk);
			},
			onClose: () => events.push("close"),
			onError: (error) => {
				events.push("error");
				errors.push(error);
			},
		},
	};
}

function factoryFor(options: { maxPendingBytes?: number; maxBufferedAmount?: number } = {}): {
	sockets: FakeWebSocket[];
	urls: string[];
	open(recorded?: Recorded): Promise<ByteTransport>;
} {
	const sockets: FakeWebSocket[] = [];
	const urls: string[] = [];
	const factory = createBrowserWebSocketTransportFactory({
		url: "ws://127.0.0.1:1234/pi/capability",
		...options,
		webSocketFactory(url) {
			urls.push(url);
			const socket = new FakeWebSocket();
			sockets.push(socket);
			return socket;
		},
	});
	return { sockets, urls, open: (recorded = recordHandlers()) => Promise.resolve(factory(recorded.handlers)) };
}

async function opened(recorded = recordHandlers(), options = {}) {
	const harness = factoryFor(options);
	const pending = harness.open(recorded);
	const socket = harness.sockets[0]!;
	socket.emit("open");
	return { ...harness, socket, transport: await pending, recorded };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("browser WebSocket ByteTransport", () => {
	it("opens one arraybuffer socket per call at the configured URL and never reconnects", async () => {
		const { sockets, urls, socket, recorded } = await opened();
		expect(urls).toEqual(["ws://127.0.0.1:1234/pi/capability"]);
		expect(socket.binaryType).toBe("arraybuffer");

		socket.emit("close");
		await Promise.resolve();
		expect(recorded.events).toEqual(["close"]);
		expect(sockets).toHaveLength(1);
	});

	it("uses the platform WebSocket constructor by default", async () => {
		const constructed: string[] = [];
		const socket = new FakeWebSocket();
		vi.stubGlobal(
			"WebSocket",
			class {
				constructor(url: string) {
					constructed.push(url);
					// biome-ignore lint/correctness/noConstructorReturn: the stub hands back a controllable fake socket.
					return socket;
				}
			},
		);
		const pending = createBrowserWebSocketTransportFactory({ url: "ws://127.0.0.1:1/pi/x" })(
			recordHandlers().handlers,
		);
		socket.emit("open");
		await pending;
		expect(constructed).toEqual(["ws://127.0.0.1:1/pi/x"]);
	});

	it("rejects the factory when the socket closes or fails before it opens", async () => {
		const closedEarly = factoryFor();
		const closedRecord = recordHandlers();
		const closedPending = closedEarly.open(closedRecord);
		closedEarly.sockets[0]!.emit("close");
		await expect(closedPending).rejects.toThrow("WebSocket transport closed before it opened");

		const failedEarly = factoryFor();
		const failedRecord = recordHandlers();
		const failedPending = failedEarly.open(failedRecord);
		failedEarly.sockets[0]!.emit("error");
		failedEarly.sockets[0]!.emit("close");
		await expect(failedPending).rejects.toThrow("WebSocket transport failed");
		expect([...closedRecord.events, ...failedRecord.events]).toEqual([]);
	});

	it("delivers each binary message as one chunk", async () => {
		const { socket, recorded } = await opened();
		socket.emit("message", { data: new Uint8Array([1, 2]).buffer });
		socket.emit("message", { data: new Uint8Array([3]).buffer });
		expect(recorded.data).toEqual([new Uint8Array([1, 2]), new Uint8Array([3])]);
	});

	it("rejects a text message with one error and closes the socket", async () => {
		const { socket, recorded, transport } = await opened();
		socket.emit("message", { data: "not binary" });
		socket.emit("message", { data: new Uint8Array([1]).buffer });
		socket.emit("close");
		expect(recorded.events).toEqual(["error"]);
		expect(recorded.errors[0]).toBeInstanceOf(TypeError);
		expect(socket.closes).toEqual([1003]);
		await expect(transport.send(new Uint8Array([1]))).rejects.toThrow("WebSocket transport is closed");
	});

	it("reports error followed by close exactly once", async () => {
		const { socket, recorded } = await opened();
		socket.emit("error");
		socket.emit("close");
		socket.emit("error");
		expect(recorded.events).toEqual(["error"]);
	});

	it("reports an orderly remote close exactly once", async () => {
		const { socket, recorded } = await opened();
		socket.emit("close");
		socket.emit("close");
		socket.emit("error");
		expect(recorded.events).toEqual(["close"]);
	});

	it("accepts only Uint8Array chunks", async () => {
		const { transport, socket } = await opened();
		await expect(transport.send("text" as unknown as Uint8Array)).rejects.toBeInstanceOf(TypeError);
		await expect(transport.send(new Uint8Array([1]).buffer as unknown as Uint8Array)).rejects.toBeInstanceOf(
			TypeError,
		);
		expect(socket.sent).toEqual([]);
	});

	it("copies outgoing bytes before any asynchronous use", async () => {
		const { transport, socket } = await opened();
		const chunk = new Uint8Array([1, 2, 3]);
		const sent = transport.send(chunk);
		chunk.fill(9);
		await sent;
		expect(socket.sent).toEqual([new Uint8Array([1, 2, 3])]);
		expect(socket.sent[0]).not.toBe(chunk);
	});

	it("preserves send order", async () => {
		const { transport, socket } = await opened();
		await Promise.all([1, 2, 3, 4].map((value) => transport.send(new Uint8Array([value]))));
		expect(socket.sent.map((chunk) => chunk[0])).toEqual([1, 2, 3, 4]);
	});

	it("bounds bytes accepted but not yet handed to the socket", async () => {
		const { transport, socket } = await opened(recordHandlers(), { maxPendingBytes: 4 });
		const first = transport.send(new Uint8Array(3));
		await expect(transport.send(new Uint8Array(2))).rejects.toThrow("pending byte limit");
		await first;
		await transport.send(new Uint8Array(4));
		expect(socket.sent.map((chunk) => chunk.byteLength)).toEqual([3, 4]);
	});

	it("applies backpressure from bufferedAmount without busy-waiting", async () => {
		vi.useFakeTimers();
		const { transport, socket } = await opened(recordHandlers(), { maxBufferedAmount: 10 });
		socket.bufferedAmount = 11;
		let settled = false;
		const first = transport.send(new Uint8Array([1])).then(() => {
			settled = true;
		});
		const second = transport.send(new Uint8Array([2]));
		await vi.advanceTimersByTimeAsync(20);
		expect(settled).toBe(false);
		expect(socket.sent.map((chunk) => chunk[0])).toEqual([1]);
		// Draining is polled by timers only: one poll per interval, not a synchronous spin.
		expect(vi.getTimerCount()).toBe(1);

		socket.bufferedAmount = 0;
		await vi.advanceTimersByTimeAsync(5);
		await first;
		await second;
		expect(socket.sent.map((chunk) => chunk[0])).toEqual([1, 2]);
	});

	it("fails a send waiting on backpressure when the socket closes", async () => {
		vi.useFakeTimers();
		const { transport, socket, recorded } = await opened();
		socket.bufferedAmount = Number.MAX_SAFE_INTEGER;
		const waiting = transport.send(new Uint8Array([1]));
		const queued = transport.send(new Uint8Array([2]));
		const expectations = [
			expect(waiting).rejects.toThrow("WebSocket transport is closed"),
			expect(queued).rejects.toThrow("WebSocket transport is closed"),
		];
		socket.emit("close");
		await vi.advanceTimersByTimeAsync(5);
		await Promise.all(expectations);
		expect(recorded.events).toEqual(["close"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("closes locally once, without callbacks, and rejects later sends", async () => {
		const { transport, socket, recorded } = await opened();
		transport.close();
		transport.close();
		socket.emit("close");
		socket.emit("error");
		expect(socket.closes).toEqual([1000]);
		expect(recorded.events).toEqual([]);
		await expect(transport.send(new Uint8Array([1]))).rejects.toThrow("WebSocket transport is closed");
		expect(socket.sent).toEqual([]);
	});

	it("validates its limits", () => {
		const url = "ws://127.0.0.1:1/pi/x";
		expect(() => createBrowserWebSocketTransportFactory({ url, maxPendingBytes: 0 })).toThrow(TypeError);
		expect(() => createBrowserWebSocketTransportFactory({ url, maxPendingBytes: 1.5 })).toThrow(TypeError);
		expect(() => createBrowserWebSocketTransportFactory({ url, maxBufferedAmount: -1 })).toThrow(TypeError);
	});
});
