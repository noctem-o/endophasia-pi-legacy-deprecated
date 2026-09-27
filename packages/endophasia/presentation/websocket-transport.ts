// Source-only, browser-safe Pi ByteTransport over the platform WebSocket API. It carries Pi's ordinary framed-CBOR
// bytes unchanged as binary WebSocket messages; it knows nothing about Pi messages or services. Do not import Node
// modules here: scripts/check-browser-smoke.mjs bundles this file for the browser.
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "@earendil-works/pi-client";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";

const WEBSOCKET_OPEN = 1;
const DEFAULT_MAX_BUFFERED_AMOUNT = 1024 * 1024;
const DRAIN_POLL_MS = 5;

/** The subset of the browser WebSocket API this transport uses. */
export interface BrowserWebSocket {
	binaryType: string;
	readonly bufferedAmount: number;
	readonly readyState: number;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	addEventListener(type: "open" | "error" | "close", listener: () => void): void;
}

export interface BrowserWebSocketTransportOptions {
	/** The host-issued capability URL, for example ws://127.0.0.1:<port>/pi/<capability>. */
	readonly url: string;
	/** Bytes accepted by send() and not yet handed to the socket. Defaults to four Pi frames. */
	readonly maxPendingBytes?: number;
	/** Each send() settles only once the socket's bufferedAmount is at or below this. Defaults to 1 MiB. */
	readonly maxBufferedAmount?: number;
	/** Creates the socket; defaults to the platform WebSocket constructor. */
	readonly webSocketFactory?: (url: string) => BrowserWebSocket;
}

/**
 * Create a Pi ByteTransportFactory backed by a native browser WebSocket. Each call opens a fresh socket; the factory
 * never reconnects or replays. Exactly one of onClose or onError follows a successful open, and none after close().
 */
export function createBrowserWebSocketTransportFactory(
	options: BrowserWebSocketTransportOptions,
): ByteTransportFactory {
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_FRAME_LENGTH * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("WebSocket transport maxPendingBytes must be a positive safe integer");
	}
	const maxBufferedAmount = options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT;
	if (!Number.isSafeInteger(maxBufferedAmount) || maxBufferedAmount < 0) {
		throw new TypeError("WebSocket transport maxBufferedAmount must be a non-negative safe integer");
	}
	const createSocket = options.webSocketFactory ?? createPlatformWebSocket;
	return (handlers) => openTransport(createSocket(options.url), handlers, maxPendingBytes, maxBufferedAmount);
}

function openTransport(
	socket: BrowserWebSocket,
	handlers: ByteTransportHandlers,
	maxPendingBytes: number,
	maxBufferedAmount: number,
): Promise<ByteTransport> {
	socket.binaryType = "arraybuffer";
	return new Promise<ByteTransport>((resolve, reject) => {
		let opened = false;
		// Set by the first terminal event or by a local close; nothing is reported afterwards.
		let terminal = false;
		let pendingBytes = 0;
		let writeTail: Promise<void> = Promise.resolve();

		const finish = (error: Error | undefined): void => {
			if (terminal) return;
			terminal = true;
			if (!opened) reject(error ?? new Error("WebSocket transport closed before it opened"));
			else if (error) handlers.onError(error);
			else handlers.onClose();
		};
		const assertWritable = (): void => {
			if (terminal || socket.readyState !== WEBSOCKET_OPEN) throw new Error("WebSocket transport is closed");
		};

		const transport: ByteTransport = {
			send(chunk) {
				if (!(chunk instanceof Uint8Array)) {
					return Promise.reject(new TypeError("WebSocket transport chunks must be Uint8Array"));
				}
				if (terminal) return Promise.reject(new Error("WebSocket transport is closed"));
				if (pendingBytes + chunk.byteLength > maxPendingBytes) {
					return Promise.reject(new Error("WebSocket transport exceeded its pending byte limit"));
				}
				pendingBytes += chunk.byteLength;
				const bytes = chunk.slice();
				const write = writeTail.then(async () => {
					assertWritable();
					socket.send(bytes);
					// The browser API has no write callback; wait for its buffer to drain instead.
					while (socket.bufferedAmount > maxBufferedAmount) {
						await new Promise<void>((resume) => setTimeout(resume, DRAIN_POLL_MS));
						assertWritable();
					}
				});
				const tracked = write.finally(() => {
					pendingBytes -= bytes.byteLength;
				});
				writeTail = tracked.catch(() => {});
				return tracked;
			},
			close() {
				if (terminal) return;
				terminal = true;
				socket.close(1000);
			},
		};

		socket.addEventListener("open", () => {
			if (terminal) return;
			opened = true;
			resolve(transport);
		});
		socket.addEventListener("message", (event) => {
			if (terminal) return;
			if (!(event.data instanceof ArrayBuffer)) {
				finish(new TypeError("WebSocket transport accepts only binary messages"));
				socket.close(1003);
				return;
			}
			handlers.onData(new Uint8Array(event.data));
		});
		socket.addEventListener("error", () => finish(new Error("WebSocket transport failed")));
		socket.addEventListener("close", () => finish(undefined));
	});
}

function createPlatformWebSocket(url: string): BrowserWebSocket {
	const WebSocketConstructor = (globalThis as { readonly WebSocket?: new (url: string) => BrowserWebSocket })
		.WebSocket;
	if (WebSocketConstructor === undefined) throw new Error("This platform has no WebSocket implementation");
	return new WebSocketConstructor(url);
}
