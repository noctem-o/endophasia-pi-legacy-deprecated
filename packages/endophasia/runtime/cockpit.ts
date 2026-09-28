// Source-only Standard Cockpit v0 launcher: builds the browser assets in memory, starts the loopback cockpit host,
// then starts the Endophasia browser server with exactly the host's Origin allowlisted. Load it with coding-agent's
// source resolver preloaded (see server.ts).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
	type EndophasiaBrowserServerOptions,
	type RunningEndophasiaBrowserServer,
	startEndophasiaBrowserServer,
} from "./browser-server.ts";
import { type CockpitAssets, type CockpitHost, startCockpitHost } from "./cockpit-host.ts";

const COCKPIT_DIRECTORY = new URL("../cockpit/", import.meta.url);
const REPOSITORY_ROOT = new URL("../../../", import.meta.url);

/** Bundle the cockpit browser entry and read its shell and stylesheet. Nothing is written to disk. */
export async function buildCockpitAssets(): Promise<CockpitAssets> {
	const [bundle, html, css] = await Promise.all([
		build({
			entryPoints: [fileURLToPath(new URL("main.ts", COCKPIT_DIRECTORY))],
			absWorkingDir: fileURLToPath(REPOSITORY_ROOT),
			tsconfig: fileURLToPath(new URL("tsconfig.json", REPOSITORY_ROOT)),
			bundle: true,
			platform: "browser",
			format: "esm",
			target: "es2022",
			legalComments: "none",
			logLevel: "silent",
			write: false,
			outfile: "app.js",
		}),
		readFile(new URL("index.html", COCKPIT_DIRECTORY), "utf8"),
		readFile(new URL("styles.css", COCKPIT_DIRECTORY), "utf8"),
	]);
	const js = bundle.outputFiles.find((file) => file.path.endsWith("app.js"));
	if (js === undefined) throw new Error("Cockpit bundle produced no app.js");
	return { html, js: js.text, css };
}

export interface EndophasiaCockpitOptions extends Omit<EndophasiaBrowserServerOptions, "browser"> {
	/** Cockpit host port; defaults to an ephemeral loopback port. */
	readonly port?: number;
	/** Prebuilt assets; built from source when omitted. */
	readonly assets?: CockpitAssets;
	readonly onError?: (error: Error) => void;
}

export interface RunningEndophasiaCockpit {
	/** The page to open, http://127.0.0.1:<port>/. */
	readonly url: string;
	readonly server: RunningEndophasiaBrowserServer;
	/** Resolves when the Endophasia server has closed, whether by close() or on its own. */
	readonly closed: Promise<void>;
	/** Stop the host and the server. Every call returns the same promise. */
	close(): Promise<void>;
}

export async function startEndophasiaCockpit(
	options: EndophasiaCockpitOptions = {},
): Promise<RunningEndophasiaCockpit> {
	const { port, assets, onError, ...serverOptions } = options;
	const host: CockpitHost = await startCockpitHost({ assets: assets ?? (await buildCockpitAssets()), port, onError });
	let server: RunningEndophasiaBrowserServer;
	try {
		server = await startEndophasiaBrowserServer({ ...serverOptions, browser: { allowedOrigins: [host.origin] } });
	} catch (error) {
		await closeAll([host.close()], error);
		throw error;
	}
	host.setBootstrap({ serverId: server.serverId, websocketUrl: server.browser.url });

	let closePromise: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closePromise ??= closeAll([server.close(), host.close()]);
		return closePromise;
	};
	// A server that stops on its own takes the host with it, so no page keeps offering a dead capability.
	void server.closed.then(
		() => host.close(),
		() => host.close(),
	);
	return { url: `${host.origin}/`, server, closed: server.closed, close };
}

/** Settle every cleanup; one failure rethrows as is, several as an AggregateError. */
async function closeAll(cleanups: readonly Promise<void>[], cause?: unknown): Promise<void> {
	const errors = (await Promise.allSettled(cleanups)).flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (cause !== undefined) {
		if (errors.length > 0) throw new AggregateError([cause, ...errors], "Cockpit startup and cleanup failed");
		return;
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Failed to close the Endophasia cockpit");
}
