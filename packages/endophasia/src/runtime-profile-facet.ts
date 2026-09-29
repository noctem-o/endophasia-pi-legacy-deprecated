import { defineFacet, type Facet } from "@earendil-works/chord";
import {
	ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0,
	type EndophasiaRuntimeCapabilityIdV0,
	EndophasiaRuntimeProfileV0,
	type RuntimeProfileV0,
} from "./runtime-profile-service.ts";

/** A profile as a composition root may hold it, possibly frozen. The published state is a fresh copy. */
export type RuntimeProfileClaimV0 = Readonly<Omit<RuntimeProfileV0, "capabilities">> & {
	readonly capabilities: readonly EndophasiaRuntimeCapabilityIdV0[];
};

const PROFILE_FIELDS = new Set(["schemaVersion", "scope", "runtimeFamily", "adapterProfileId", "capabilities"]);

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`Runtime Profile ${field} must be a non-empty string`);
	}
	return value;
}

/**
 * Validate a supplied profile and copy it field for field. Anything outside the v0 schema is rejected rather than
 * dropped: the composition root makes this claim deliberately, so a malformed one is a bug, not input to repair.
 * Capabilities must be known v0 IDs, without duplicates, in canonical catalogue order.
 */
export function runtimeProfileV0(profile: RuntimeProfileClaimV0): RuntimeProfileV0 {
	if (profile === null || typeof profile !== "object" || Object.getPrototypeOf(profile) !== Object.prototype) {
		throw new TypeError("Runtime Profile must be a plain object");
	}
	for (const key of Object.keys(profile)) {
		if (!PROFILE_FIELDS.has(key)) throw new TypeError(`Unknown Runtime Profile field: ${key}`);
	}
	if (profile.schemaVersion !== "runtime-profile.v0") throw new TypeError("Runtime Profile schemaVersion is invalid");
	if (profile.scope !== "session-worker-lifetime") throw new TypeError("Runtime Profile scope is invalid");
	const runtimeFamily = nonEmptyString(profile.runtimeFamily, "runtimeFamily");
	const adapterProfileId = nonEmptyString(profile.adapterProfileId, "adapterProfileId");
	if (!Array.isArray(profile.capabilities)) throw new TypeError("Runtime Profile capabilities must be an array");
	const catalogue: readonly string[] = ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0;
	const capabilities: EndophasiaRuntimeCapabilityIdV0[] = [];
	let previous = -1;
	for (const capability of profile.capabilities as readonly unknown[]) {
		const position = typeof capability === "string" ? catalogue.indexOf(capability) : -1;
		if (position < 0) throw new TypeError(`Unknown Runtime Profile capability: ${String(capability)}`);
		if (position === previous) throw new TypeError(`Duplicate Runtime Profile capability: ${capability}`);
		if (position < previous) throw new TypeError(`Runtime Profile capabilities are not in canonical order`);
		previous = position;
		capabilities.push(capability as EndophasiaRuntimeCapabilityIdV0);
	}
	return {
		schemaVersion: "runtime-profile.v0",
		scope: "session-worker-lifetime",
		runtimeFamily,
		adapterProfileId,
		capabilities,
	};
}

/**
 * Provide EndophasiaRuntimeProfileV0: publish one validated, immutable profile for this worker's lifetime. The facet
 * knows no runtime: it reads, polls and subscribes to nothing, discovers nothing from installed services, and never
 * changes the state. The caller's object is copied, so later changes to it are not published.
 */
export function createEndophasiaRuntimeProfileFacetV0(profile: RuntimeProfileClaimV0): Facet {
	const published = runtimeProfileV0(profile);
	return defineFacet({
		id: "@endophasia/runtime-profile",
		setup(env) {
			// Replicated state takes ownership of its root, so each setup receives its own copy.
			const state = env.replicatedState<RuntimeProfileV0>({
				...published,
				capabilities: [...published.capabilities],
			});
			env.provide(EndophasiaRuntimeProfileV0, { state });
		},
	});
}
