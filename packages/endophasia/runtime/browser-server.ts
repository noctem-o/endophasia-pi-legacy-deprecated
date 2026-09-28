// Source-only Endophasia server with an additional loopback WebSocket listener for browser presentations. The Unix
// listener and the Endophasia Session worker are unchanged; both transports serve the same Pi server. Load it with
// coding-agent's source resolver preloaded (see server.ts).
import type { RunningServer } from "@earendil-works/pi-coding-agent/experimental/server";
import { createBrowserWebSocketListener } from "./browser-listener.ts";
import { type EndophasiaServerOptions, startEndophasiaServer } from "./server.ts";

export interface EndophasiaBrowserServerOptions extends Omit<EndophasiaServerOptions, "additionalListeners"> {
	readonly browser: {
		/** Exact browser origins allowed to connect, such as "http://127.0.0.1:5173". */
		readonly allowedOrigins: readonly string[];
	};
}

export interface RunningEndophasiaBrowserServer extends RunningServer {
	readonly browser: {
		/** The capability URL a trusted browser presentation passes to its WebSocket transport. */
		readonly url: string;
	};
}

/** Start an Endophasia server that also accepts Pi connections from allowlisted local browser origins. */
export async function startEndophasiaBrowserServer(
	options: EndophasiaBrowserServerOptions,
): Promise<RunningEndophasiaBrowserServer> {
	const { browser, ...serverOptions } = options;
	const listener = createBrowserWebSocketListener({ allowedOrigins: browser.allowedOrigins });
	const server = await startEndophasiaServer({ ...serverOptions, additionalListeners: [listener] });
	let url: string;
	try {
		url = listener.url;
	} catch (error) {
		await server.close();
		throw error;
	}
	return { ...server, browser: { url } };
}
