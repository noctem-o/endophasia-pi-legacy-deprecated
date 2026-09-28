// Browser entry for Standard Cockpit v0. It reads the host's bootstrap (serverId and the ephemeral WebSocket
// capability URL), opens Presentation Client v0 over Browser ByteTransport v0 and mounts the cockpit. There is no
// reconnect: after a disconnect or startup failure, reloading the page starts afresh, as does a page restored from the
// back-forward cache.
import { type EndophasiaPresentationClientV0, openEndophasiaPresentationClientV0 } from "../presentation/client.ts";
import { createBrowserWebSocketTransportFactory } from "../presentation/websocket-transport.ts";
import { parseBootstrap } from "./bootstrap.ts";
import { CockpitController } from "./controller.ts";
import { bindPageLifecycle } from "./lifecycle.ts";
import { mountCockpit, renderNotice } from "./view.ts";

const MAX_ERROR_LENGTH = 500;

/** Releases the running cockpit on pagehide; replaced once the cockpit is mounted. */
let disposeActive: () => void = () => {};

async function start(root: HTMLElement): Promise<void> {
	renderNotice(root, "Connecting", "Opening the Endophasia presentation client…", "pending");
	let controller: CockpitController | undefined;
	let presentation: EndophasiaPresentationClientV0 | undefined;
	try {
		const response = await fetch("bootstrap.json", { cache: "no-store", credentials: "omit" });
		if (!response.ok) throw new Error(`Bootstrap request failed with HTTP ${response.status}`);
		const bootstrap = parseBootstrap(await response.json());
		presentation = await openEndophasiaPresentationClientV0({
			serverId: bootstrap.serverId,
			transportFactory: createBrowserWebSocketTransportFactory({ url: bootstrap.websocketUrl }),
			// Client, service-source and binding errors become ephemeral cockpit diagnostics.
			onError: (error) => controller?.report(error),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		renderNotice(root, "Cockpit could not start", message.slice(0, MAX_ERROR_LENGTH), "warn");
		return;
	}
	const client = presentation;
	let mounted: ReturnType<typeof mountCockpit> | undefined;
	const active = new CockpitController({
		presentation: client,
		render: (regions) => mounted?.render(regions),
		schedule: (callback) => requestAnimationFrame(() => callback()),
	});
	controller = active;
	mounted = mountCockpit(root, () => active);
	disposeActive = () => {
		active.dispose();
		void client.dispose();
	};
}

bindPageLifecycle((type, listener) => addEventListener(type, (event) => listener(event.persisted)), {
	dispose: () => disposeActive(),
	reload: () => location.reload(),
});
const root = document.getElementById("cockpit");
if (root !== null) void start(root);
