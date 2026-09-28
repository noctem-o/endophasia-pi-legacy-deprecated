// Source-only loopback HTTP host for Standard Cockpit v0. It serves exactly four fixed routes: the page shell, its
// script, its stylesheet and a bootstrap naming the Pi server and its WebSocket capability URL. All four live under
// an unguessable per-launch path, because the bootstrap reveals the WebSocket capability: another local process that
// finds the port must not be able to read it. It is presentation plumbing, not a runtime API: Session, transcript and
// model data cross the Pi WebSocket only. Load it with coding-agent's source resolver preloaded (see server.ts).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loopbackAuthority } from "./browser-listener.ts";

const LOOPBACK_HOST = "127.0.0.1";
const HTTP_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 16 * 1024;
const PAGE_TOKEN_BYTES = 32;

export interface CockpitAssets {
	readonly html: string;
	readonly js: string;
	readonly css: string;
}

export interface CockpitBootstrap {
	readonly serverId: string;
	readonly websocketUrl: string;
}

export interface CockpitHostOptions {
	readonly assets: CockpitAssets;
	/** Loopback port; defaults to an ephemeral port. */
	readonly port?: number;
	/** Observes host-level errors. Exceptions it throws are ignored. */
	readonly onError?: (error: Error) => void;
}

export interface CockpitHost {
	/** The exact browser Origin of pages this host serves, e.g. http://127.0.0.1:48123. */
	readonly origin: string;
	/** The page URL, http://127.0.0.1:<port>/c/<per-launch token>/. It is a credential: print it only to its user. */
	readonly url: string;
	/** Publish the bootstrap once the Endophasia browser server is running; until then bootstrap.json is 503. */
	setBootstrap(bootstrap: CockpitBootstrap): void;
	close(): Promise<void>;
}

/** Start the cockpit host on 127.0.0.1. */
export async function startCockpitHost(options: CockpitHostOptions): Promise<CockpitHost> {
	const port = options.port ?? 0;
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new TypeError("Cockpit host port must be an integer between 0 and 65535");
	}
	const reportError = (error: unknown): void => {
		try {
			options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Error observers cannot affect host state.
		}
	};
	let authority: string | undefined;
	let bootstrap: CockpitBootstrap | undefined;
	const pagePath = `/c/${randomBytes(PAGE_TOKEN_BYTES).toString("base64url")}/`;
	const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
		try {
			handleRequest(request, response, options.assets, authority, pagePath, bootstrap);
		} catch (error) {
			reportError(error);
			if (!response.headersSent) respond(response, 500, "text/plain; charset=utf-8", "", undefined);
			else response.destroy();
		}
	});
	server.headersTimeout = HTTP_TIMEOUT_MS;
	server.requestTimeout = HTTP_TIMEOUT_MS;
	// The host never upgrades; the Pi WebSocket is served by the Endophasia browser listener.
	server.on("upgrade", (_request, socket) => socket.destroy());
	server.on("clientError", (_error, socket) => socket.destroy());
	server.on("error", reportError);
	await listen(server, port);
	const address = server.address();
	if (address === null || typeof address === "string") {
		await closeServer(server);
		throw new Error("Cockpit host has no port");
	}
	authority = loopbackAuthority(address.port);
	const origin = `http://${authority}`;

	let closePromise: Promise<void> | undefined;
	return {
		origin,
		url: `${origin}${pagePath}`,
		setBootstrap(value) {
			bootstrap = { serverId: value.serverId, websocketUrl: value.websocketUrl };
		},
		close() {
			closePromise ??= (async () => {
				bootstrap = undefined;
				await closeServer(server);
			})();
			return closePromise;
		},
	};
}

function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	assets: CockpitAssets,
	authority: string | undefined,
	pagePath: string,
	bootstrap: CockpitBootstrap | undefined,
): void {
	// Only the exact loopback authority is served, which also defeats DNS rebinding.
	if (authority === undefined || request.headers.host !== authority) {
		respond(response, 403, "text/plain; charset=utf-8", "", undefined);
		return;
	}
	// Every route sits under the per-launch page path; anything else, including the bare origin, is 404.
	const path = request.url ?? "";
	const route = hasPrefix(path, pagePath) ? ROUTES[path.slice(pagePath.length)] : undefined;
	if (route === undefined) {
		respond(response, 404, "text/plain; charset=utf-8", "", undefined);
		return;
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.setHeader("allow", "GET, HEAD");
		respond(response, 405, "text/plain; charset=utf-8", "", undefined);
		return;
	}
	const connectSource = bootstrap === undefined ? undefined : new URL(bootstrap.websocketUrl).origin;
	let body: string;
	switch (route) {
		case "html":
			body = assets.html;
			break;
		case "js":
			body = assets.js;
			break;
		case "css":
			body = assets.css;
			break;
		case "bootstrap":
			if (bootstrap === undefined) {
				respond(response, 503, "text/plain; charset=utf-8", "", connectSource);
				return;
			}
			body = JSON.stringify({ serverId: bootstrap.serverId, websocketUrl: bootstrap.websocketUrl });
			break;
	}
	respond(response, 200, CONTENT_TYPES[route], body, connectSource, request.method === "HEAD");
}

type Route = "html" | "js" | "css" | "bootstrap";

const ROUTES: Readonly<Record<string, Route>> = Object.assign(Object.create(null), {
	"": "html",
	"app.js": "js",
	"app.css": "css",
	"bootstrap.json": "bootstrap",
});

/** Constant-time prefix check, so response timing does not reveal the page token. */
function hasPrefix(path: string, prefix: string): boolean {
	const actual = Buffer.from(path.slice(0, prefix.length));
	const expected = Buffer.from(prefix);
	return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

const CONTENT_TYPES: Readonly<Record<Route, string>> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	bootstrap: "application/json; charset=utf-8",
};

/** The page may load only its own script and stylesheet and connect only to itself and the Pi WebSocket origin. */
export function cockpitContentSecurityPolicy(websocketOrigin: string | undefined): string {
	return [
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self'",
		`connect-src 'self'${websocketOrigin === undefined ? "" : ` ${websocketOrigin}`}`,
		"img-src 'self' data:",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");
}

function respond(
	response: ServerResponse,
	status: number,
	contentType: string,
	body: string,
	websocketOrigin: string | undefined,
	headOnly = false,
): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": Buffer.byteLength(body),
		// The bootstrap carries an ephemeral capability, and assets are rebuilt per launch: nothing is cached.
		"cache-control": "no-store",
		"content-security-policy": cockpitContentSecurityPolicy(websocketOrigin),
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"cross-origin-opener-policy": "same-origin",
		"cross-origin-resource-policy": "same-origin",
		"x-frame-options": "DENY",
	});
	response.end(headOnly ? undefined : body);
}

function listen(server: HttpServer, port: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
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
		server.listen(port, LOOPBACK_HOST);
	});
}

function closeServer(server: HttpServer): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}
