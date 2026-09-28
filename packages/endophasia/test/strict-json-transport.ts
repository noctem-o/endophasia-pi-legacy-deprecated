import {
	type Context,
	createRemoteServiceEndpoint,
	createServiceStateDecoder,
	createServiceStateEncoder,
	createServiceSubscribeCall,
	createServiceUnsubscribeCall,
	isJsonValue,
	type JsonValue,
	parseServiceCall,
	parseServiceSubscriptionSnapshot,
	parseWireServiceProviderUpdate,
	parseWireServiceSubscriptionSnapshot,
	type RemoteServiceProvider,
	type RemoteServiceTransport,
	type ServiceProviderUpdate,
	type ServiceUpdatePublisher,
} from "@earendil-works/chord";
import { createContextKey, withContextValue } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";

export const HOST_REQUEST = createContextKey<number>("endophasia.test.hostRequest");

/** Copy one value across a strict-JSON wire, rejecting anything JSON.stringify would silently drop or coerce. */
export function throughWire(value: unknown): JsonValue {
	if (!isJsonValue(value)) throw new TypeError("Value crossing the service boundary is not strict JSON");
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * Test transport with the same split as pi-client and pi-server: every call and result crosses strict JSON, Chord's
 * `$chord.service` control calls drive subscriptions through a real endpoint, and each subscription owns one state
 * encoder/decoder pair. The consumer's Context does not cross the wire; each host call gets its own Context.
 */
export function connectStrictJson(provider: RemoteServiceProvider): {
	transport: RemoteServiceTransport;
	hostContexts: Context[];
	/** Every encoded subscription snapshot and update, exactly as it crossed the wire. */
	wire: { snapshots: JsonValue[]; updates: JsonValue[] };
	dispose(): void;
} {
	const endpoint = createRemoteServiceEndpoint(provider);
	const hostContexts: Context[] = [];
	const wire: { snapshots: JsonValue[]; updates: JsonValue[] } = { snapshots: [], updates: [] };
	const deliveries = new Map<string, (update: ServiceProviderUpdate) => void>();
	const publish: ServiceUpdatePublisher = (subscriptionId, update) => deliveries.get(subscriptionId)?.(update);
	let subscriptions = 0;
	// `encode` runs on the host before the wire, as pi-server encodes subscription snapshots.
	const request = async (
		call: unknown,
		encode: (result: JsonValue) => unknown = (result) => result,
	): Promise<JsonValue | undefined> => {
		const hostContext = withContextValue(HOST_REQUEST, hostContexts.length, BACKGROUND_CONTEXT);
		hostContexts.push(hostContext);
		const result = await endpoint.invoke(parseServiceCall(throughWire(call)), publish, hostContext);
		return result === undefined ? undefined : throughWire(encode(result));
	};
	return {
		hostContexts,
		wire,
		transport: {
			invoke: (call) => request(call),
			async subscribe(serviceId, mode, listener) {
				const subscriptionId = `subscription-${++subscriptions}`;
				const encoder = createServiceStateEncoder();
				const decoder = createServiceStateDecoder();
				const queued: ServiceProviderUpdate[] = [];
				let active = false;
				const deliver = (update: ServiceProviderUpdate): void => {
					const encoded = throughWire(encoder.encodeUpdate(update));
					wire.updates.push(encoded);
					listener(decoder.decodeUpdate(parseWireServiceProviderUpdate(encoded)), BACKGROUND_CONTEXT);
				};
				deliveries.set(subscriptionId, (update) => (active ? deliver(update) : queued.push(update)));
				const wireSnapshot = await request(createServiceSubscribeCall(subscriptionId, serviceId, mode), (result) =>
					encoder.encodeSnapshot(parseServiceSubscriptionSnapshot(result)),
				);
				if (wireSnapshot !== undefined) wire.snapshots.push(wireSnapshot);
				return {
					snapshot: decoder.decodeSnapshot(parseWireServiceSubscriptionSnapshot(wireSnapshot)),
					activate() {
						active = true;
						for (const update of queued.splice(0)) deliver(update);
					},
					async close() {
						deliveries.delete(subscriptionId);
						await request(createServiceUnsubscribeCall(subscriptionId));
					},
				};
			},
		},
		dispose: () => endpoint.dispose(),
	};
}
