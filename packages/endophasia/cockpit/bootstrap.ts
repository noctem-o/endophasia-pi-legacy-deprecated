// The cockpit's only application configuration: which Pi server to expect and where its WebSocket capability is.
// It carries no model, provider or Session state; all of that crosses the Pi WebSocket.

export interface CockpitBootstrap {
	readonly serverId: string;
	readonly websocketUrl: string;
}

/** Accept exactly the two bootstrap fields, with a loopback ws: capability URL. */
export function parseBootstrap(value: unknown): CockpitBootstrap {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Bootstrap is not an object");
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== 2 || keys[0] !== "serverId" || keys[1] !== "websocketUrl") {
		throw new Error("Bootstrap must contain exactly serverId and websocketUrl");
	}
	const { serverId, websocketUrl } = record;
	if (typeof serverId !== "string" || serverId.length === 0) throw new Error("Bootstrap serverId is invalid");
	if (typeof websocketUrl !== "string") throw new Error("Bootstrap websocketUrl is invalid");
	const url = new URL(websocketUrl);
	if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") {
		throw new Error("Bootstrap websocketUrl must be a loopback ws: URL");
	}
	return { serverId, websocketUrl };
}
