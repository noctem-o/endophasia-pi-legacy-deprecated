// Source-only loopback WebSocket ServerListener for browser presentations of an Endophasia server. It admits a
// connection only on 127.0.0.1, at one unguessable capability path, from an exactly allowlisted Origin, and then
// carries Pi's ordinary framed-CBOR bytes unchanged as binary WebSocket messages. The capability is transport
// admission only: the Pi handshake still verifies the serverId, and the connection gains no authority beyond an
// ordinary Pi client's. Load it with coding-agent's source resolver preloaded (see server.ts).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import type { ServerListener } from "@earendil-works/pi-server";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

// pi-server exports ServerListener but not the connection types its start() uses.
type ByteConnectionAcceptor = Parameters<ServerListener["start"]>[0];
type ByteConnection = Parameters<ByteConnectionAcceptor>[0];

const LOOPBACK_HOST = "127.0.0.1";
const CAPABILITY_PATH_PREFIX = "/pi/";
const CAPABILITY_BYTES = 32;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;
const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
const MAX_UINT32 = 0xffff_ffff;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 16 * 1024;

export interface BrowserWebSocketListenerOptions {
	/**
	 * Exact browser origins allowed to connect, such as "http://127.0.0.1:5173". Each must be a canonical http or
	 * https origin; wildcards, "null", paths and patterns are rejected.
	 */
	readonly allowedOrigins: readonly string[];
	/** Loopback port; defaults to an ephemeral port. */
	readonly port?: number;
	/** Largest Pi frame accepted; one binary message may carry at most one frame and its 4-byte length prefix. */
	readonly maxFrameLength?: number;
	/** Bytes accepted by send() and not yet written to the socket. Defaults to four frames. */
	readonly maxPendingBytes?: number;
	readonly gracefulCloseTimeoutMs?: number;
	/** Observes listener-level errors. Exceptions it throws are ignored. */
	readonly onError?: (error: Error) => void;
}

export interface BrowserWebSocketListener extends ServerListener {
	/** The capability URL, ws://127.0.0.1:<port>/pi/<capability>. Available once started. */
	readonly url: string;
}

interface ResolvedOptions {
	readonly allowedOrigins: ReadonlySet<string>;
	readonly port: number;
	readonly maxFrameLength: number;
	readonly maxPendingBytes: number;
	readonly gracefulCloseTimeoutMs: number;
	readonly onError?: (error: Error) => void;
}

/** Create a loopback WebSocket listener to pass to startServer's additionalListeners. */
export function createBrowserWebSocketListener(options: BrowserWebSocketListenerOptions): BrowserWebSocketListener {
	return new LoopbackWebSocketListener(resolveOptions(options));
}

class LoopbackWebSocketListener implements BrowserWebSocketListener {
	private readonly options: ResolvedOptions;
	private readonly capabilityPath = `${CAPABILITY_PATH_PREFIX}${randomBytes(CAPABILITY_BYTES).toString("base64url")}`;
	private readonly connections = new Set<WebSocketByteConnection>();
	private readonly webSocketServer: WebSocketServer;
	private httpServer?: HttpServer;
	/** The canonical host[:port] authority, as browsers send it in the Host header. */
	private authority?: string;
	private started = false;
	private closing = false;
	private closePromise?: Promise<void>;

	constructor(options: ResolvedOptions) {
		this.options = options;
		this.webSocketServer = new WebSocketServer({
			noServer: true,
			clientTracking: false,
			perMessageDeflate: false,
			maxPayload: options.maxFrameLength + 4,
			// Pi needs no subprotocol; never select one a client offers.
			handleProtocols: () => false,
		});
	}

	get url(): string {
		if (this.authority === undefined) throw new Error("Browser WebSocket listener has not started");
		return `ws://${this.authority}${this.capabilityPath}`;
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.started) throw new Error("Browser WebSocket listener is already started");
		if (this.closing) throw new Error("Browser WebSocket listener is closing or closed");
		this.started = true;
		const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (_request, response) => {
			// Only the upgrade path is served; ordinary requests get an empty 404 without CORS headers.
			response.writeHead(404, { "content-length": "0", connection: "close" });
			response.end();
		});
		server.headersTimeout = HTTP_TIMEOUT_MS;
		server.requestTimeout = HTTP_TIMEOUT_MS;
		server.on("upgrade", (request, socket, head) => this.upgrade(accept, request, socket, head));
		server.on("clientError", (_error, socket) => socket.destroy());
		server.on("error", (error) => this.reportError(error));
		this.httpServer = server;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.options.port, LOOPBACK_HOST);
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("Browser WebSocket listener has no port");
		this.authority = loopbackAuthority(address.port);
	}

	close(): Promise<void> {
		this.closing = true;
		this.closePromise ??= this.closeInternal();
		return this.closePromise;
	}

	private upgrade(accept: ByteConnectionAcceptor, request: IncomingMessage, socket: Duplex, head: Buffer): void {
		socket.on("error", () => socket.destroy());
		if (this.closing) {
			socket.destroy();
			return;
		}
		const origin = request.headers.origin;
		if (request.headers.host !== this.authority || origin === undefined || !this.options.allowedOrigins.has(origin)) {
			rejectUpgrade(socket, 403, "Forbidden");
			return;
		}
		if (!this.isCapabilityPath(request.url)) {
			rejectUpgrade(socket, 404, "Not Found");
			return;
		}
		this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
			if (this.closing) {
				webSocket.terminate();
				return;
			}
			this.acceptWebSocket(accept, webSocket);
		});
	}

	private isCapabilityPath(path: string | undefined): boolean {
		if (path === undefined) return false;
		const actual = Buffer.from(path);
		const expected = Buffer.from(this.capabilityPath);
		return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
	}

	private acceptWebSocket(accept: ByteConnectionAcceptor, webSocket: WebSocket): void {
		const connection = new WebSocketByteConnection(
			webSocket,
			this.options.gracefulCloseTimeoutMs,
			this.options.maxPendingBytes,
		);
		this.connections.add(connection);
		const handler = accept(connection);
		// Exactly one of onError or onClose reaches the Pi server, and no data follows it.
		let terminal = false;
		const fail = (error: Error): void => {
			if (terminal) return;
			terminal = true;
			connection.markClosing();
			handler.onError(error);
		};
		webSocket.on("message", (data, isBinary) => {
			if (terminal) return;
			if (!isBinary) {
				webSocket.close(1003, "Binary messages only");
				fail(new TypeError("WebSocket connection accepts only binary messages"));
				return;
			}
			handler.onData(rawDataBytes(data));
		});
		webSocket.on("error", (error) => {
			webSocket.terminate();
			fail(error);
		});
		webSocket.once("close", () => {
			connection.markClosed();
			this.connections.delete(connection);
			if (terminal) return;
			terminal = true;
			handler.onClose();
		});
	}

	private async closeInternal(): Promise<void> {
		const server = this.httpServer;
		const serverClosed =
			server?.listening === true
				? new Promise<void>((resolve) => {
						server.close((error) => {
							if (error) this.reportError(error);
							resolve();
						});
					})
				: Promise.resolve();
		server?.closeIdleConnections();
		await Promise.all([...this.connections].map((connection) => connection.close()));
		server?.closeAllConnections();
		await serverClosed;
		this.connections.clear();
		await new Promise<void>((resolve) => this.webSocketServer.close(() => resolve()));
	}

	private reportError(error: unknown): void {
		try {
			this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Error observers cannot affect listener state.
		}
	}
}

/** @internal Exported only for transport-level verification. */
export class WebSocketByteConnection implements ByteConnection {
	private readonly webSocket: WebSocket;
	private readonly gracefulCloseTimeoutMs: number;
	private readonly maxPendingBytes: number;
	private pendingBytes = 0;
	private closedValue = false;
	private closing = false;
	private writeTail: Promise<void> = Promise.resolve();
	private closePromise?: Promise<void>;
	private resolveClose?: () => void;

	constructor(webSocket: WebSocket, gracefulCloseTimeoutMs: number, maxPendingBytes: number) {
		this.webSocket = webSocket;
		this.gracefulCloseTimeoutMs = gracefulCloseTimeoutMs;
		this.maxPendingBytes = maxPendingBytes;
	}

	get closed(): boolean {
		return this.closedValue;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("WebSocket connection chunks must be Uint8Array"));
		}
		if (this.closedValue || this.closing) return Promise.reject(new Error("WebSocket connection is closed"));
		if (this.pendingBytes + chunk.byteLength > this.maxPendingBytes) {
			return Promise.reject(new Error("WebSocket connection exceeded its pending byte limit"));
		}
		this.pendingBytes += chunk.byteLength;
		const bytes = chunk.slice();
		const write = this.writeTail.then(() => this.write(bytes));
		const tracked = write.finally(() => {
			this.pendingBytes -= bytes.byteLength;
		});
		this.writeTail = tracked.catch(() => {});
		return tracked;
	}

	/** Write queued sends, then finalChunk, then the WebSocket close frame. */
	close(finalChunk?: Uint8Array): Promise<void> {
		if (this.closedValue || this.webSocket.readyState === WEBSOCKET_CLOSED) {
			this.markClosed();
			return Promise.resolve();
		}
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		const finalBytes = finalChunk?.slice();
		this.closePromise = new Promise<void>((resolve) => {
			this.resolveClose = resolve;
			const timer = setTimeout(() => {
				this.webSocket.terminate();
				this.markClosed();
			}, this.gracefulCloseTimeoutMs);
			timer.unref();
			this.webSocket.once("close", () => clearTimeout(timer));
			void this.writeTail.then(() => {
				if (this.webSocket.readyState !== WEBSOCKET_OPEN) return;
				try {
					if (finalBytes) this.webSocket.send(finalBytes, { binary: true, compress: false });
					this.webSocket.close(1000);
				} catch {
					this.webSocket.terminate();
				}
			});
		});
		return this.closePromise;
	}

	/** Reject further sends after a transport failure; the close event still settles close(). */
	markClosing(): void {
		this.closing = true;
	}

	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closing = true;
		this.resolveClose?.();
		this.resolveClose = undefined;
	}

	private write(chunk: Uint8Array): Promise<void> {
		// Writes queued before close() still go out ahead of its final chunk; a failed socket is no longer open.
		if (this.closedValue || this.webSocket.readyState !== WEBSOCKET_OPEN) {
			return Promise.reject(new Error("WebSocket connection is closed"));
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const onClose = (): void => finish(new Error("WebSocket connection closed during write"));
			const finish = (error?: Error | null): void => {
				if (settled) return;
				settled = true;
				this.webSocket.off("close", onClose);
				if (error) reject(error);
				else resolve();
			};
			this.webSocket.once("close", onClose);
			try {
				// The callback runs once the frame is written to the socket, which bounds buffered output.
				this.webSocket.send(chunk, { binary: true, compress: false }, finish);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
}

/**
 * @internal The ws: authority for a loopback port, canonicalized as browsers do: the default port 80 is omitted,
 * so its Host header is "127.0.0.1", not "127.0.0.1:80".
 */
export function loopbackAuthority(port: number): string {
	return new URL(`ws://${LOOPBACK_HOST}:${port}`).host;
}

function rawDataBytes(data: RawData): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	const buffer = Array.isArray(data) ? Buffer.concat(data) : data;
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
	socket.once("finish", () => socket.destroy());
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function resolveOptions(options: BrowserWebSocketListenerOptions): ResolvedOptions {
	const allowedOrigins = new Set<string>();
	for (const origin of options.allowedOrigins) allowedOrigins.add(normalizeAllowedOrigin(origin));
	if (allowedOrigins.size === 0)
		throw new TypeError("Browser WebSocket listener requires at least one allowed origin");
	const port = options.port ?? 0;
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new TypeError("Browser WebSocket listener port must be an integer between 0 and 65535");
	}
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`Browser WebSocket listener maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const maxPendingBytes = options.maxPendingBytes ?? maxFrameLength * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < maxFrameLength + 4) {
		throw new TypeError(
			"Browser WebSocket listener maxPendingBytes must be a safe integer at least maxFrameLength + 4",
		);
	}
	const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(gracefulCloseTimeoutMs) ||
		gracefulCloseTimeoutMs <= 0 ||
		gracefulCloseTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(
			`Browser WebSocket listener gracefulCloseTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`,
		);
	}
	return { allowedOrigins, port, maxFrameLength, maxPendingBytes, gracefulCloseTimeoutMs, onError: options.onError };
}

/** Accept only a canonical http(s) origin, exactly as a browser sends it in the Origin header. */
function normalizeAllowedOrigin(origin: string): string {
	let parsed: URL | undefined;
	try {
		parsed = new URL(origin);
	} catch {
		parsed = undefined;
	}
	if (
		parsed === undefined ||
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.origin !== origin
	) {
		throw new TypeError(`Browser WebSocket listener allowed origin must be an exact http(s) origin: ${origin}`);
	}
	return origin;
}
