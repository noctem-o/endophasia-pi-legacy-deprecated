import { Client } from "@earendil-works/pi-client";
import { openEndophasiaPresentationClientV0 } from "../packages/endophasia/presentation/client.ts";
import { createBrowserWebSocketTransportFactory } from "../packages/endophasia/presentation/websocket-transport.ts";

// Keep this entry browser-safe. scripts/check-browser-smoke.mjs bundles it to prove the Endophasia browser
// transport and Presentation Client reach an Endophasia server without Node modules or server-side code.
const transportFactory = createBrowserWebSocketTransportFactory({ url: "ws://127.0.0.1:1/pi/capability" });
void Client.connect({ serverId: "smoke", transportFactory });
void openEndophasiaPresentationClientV0({ serverId: "smoke", transportFactory });
