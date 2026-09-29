import { createFacetHost, createRemoteServiceBinding, type Facet } from "@earendil-works/chord";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { PI_STANDARD_RUNTIME_PROFILE_V0 } from "../runtime/session-worker.ts";
import {
	createEndophasiaRuntimeProfileFacetV0,
	ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0,
	type EndophasiaRuntimeCapabilityIdV0,
	EndophasiaRuntimeProfileV0,
	type RuntimeProfileClaimV0,
	type RuntimeProfileV0,
	runtimeProfileV0,
} from "../src/index.ts";
import { connectStrictJson } from "./strict-json-transport.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Host facets and bind the Runtime Profile over a strict-JSON wire, as a remote presentation does. */
async function bind(facets: readonly Facet[]) {
	const facetHost = await createFacetHost({ facets: [...facets] });
	const connection = connectStrictJson(facetHost.services);
	const errors: Error[] = [];
	const binding = createRemoteServiceBinding({
		services: [EndophasiaRuntimeProfileV0],
		transport: connection.transport,
		onError: (error) => errors.push(error),
	});
	cleanups.push(async () => {
		await binding.dispose(BACKGROUND_CONTEXT);
		connection.dispose();
		await facetHost.dispose();
		expect(errors).toEqual([]);
	});
	await binding.ready(BACKGROUND_CONTEXT);
	const state = binding.use(EndophasiaRuntimeProfileV0).state;
	// The subscription starts with the first use; wait for its snapshot.
	await expect.poll(() => state.value).toBeDefined();
	return { facetHost, state };
}

function profile(overrides: Partial<Record<keyof RuntimeProfileV0, unknown>> = {}): RuntimeProfileClaimV0 {
	return {
		schemaVersion: "runtime-profile.v0",
		scope: "session-worker-lifetime",
		runtimeFamily: "test-family",
		adapterProfileId: "endophasia.test.v0",
		capabilities: ["endophasia.mission-trace.v0", "endophasia.usage.v0"],
		...overrides,
	} as RuntimeProfileClaimV0;
}

describe("Runtime Profile v0 contract", () => {
	it("is a closed catalogue of the six current Endophasia semantics, not Chord service IDs", () => {
		expect(ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0).toEqual([
			"endophasia.session-overview.v0",
			"endophasia.mission-trace.v0",
			"endophasia.runtime-metrics.v0",
			"endophasia.operation-outcome.v0",
			"endophasia.usage.v0",
			"endophasia.continuity.v0",
		]);
		expect(EndophasiaRuntimeProfileV0.id).toBe("endophasia.runtime-profile.v0");
		// Runtime Facts is one service carrying two separate capabilities; Pi's plumbing services are not capabilities.
		for (const serviceId of [
			"endophasia.runtime-facts.v0",
			"endophasia.inspector.v0",
			"endophasia.runtime-profile.v0",
		]) {
			expect(ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0).not.toContain(serviceId);
		}
		expect(ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0.join(" ")).not.toMatch(/transcript|models/i);
	});

	it("states the standard Pi worker's profile explicitly: all six capabilities, frozen", () => {
		expect(PI_STANDARD_RUNTIME_PROFILE_V0).toEqual({
			schemaVersion: "runtime-profile.v0",
			scope: "session-worker-lifetime",
			runtimeFamily: "pi",
			adapterProfileId: "endophasia.pi-standard.v0",
			capabilities: [
				"endophasia.session-overview.v0",
				"endophasia.mission-trace.v0",
				"endophasia.runtime-metrics.v0",
				"endophasia.operation-outcome.v0",
				"endophasia.usage.v0",
				"endophasia.continuity.v0",
			],
		});
		expect(Object.isFrozen(PI_STANDARD_RUNTIME_PROFILE_V0)).toBe(true);
		expect(Object.isFrozen(PI_STANDARD_RUNTIME_PROFILE_V0.capabilities)).toBe(true);
		expect(runtimeProfileV0(PI_STANDARD_RUNTIME_PROFILE_V0)).toEqual(PI_STANDARD_RUNTIME_PROFILE_V0);
	});
});

describe("Runtime Profile validation", () => {
	it("accepts a canonical profile, including one that advertises nothing, and copies it", () => {
		const claim = profile();
		const copy = runtimeProfileV0(claim);
		expect(copy).toEqual(claim);
		expect(copy).not.toBe(claim);
		expect(copy.capabilities).not.toBe(claim.capabilities);
		expect(runtimeProfileV0(profile({ capabilities: [] })).capabilities).toEqual([]);
		expect(
			runtimeProfileV0(profile({ capabilities: [...ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0] })).capabilities,
		).toEqual(ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0);
	});

	it("rejects unknown, duplicate and non-canonically ordered capabilities", () => {
		expect(() => runtimeProfileV0(profile({ capabilities: ["endophasia.memory.v0"] }))).toThrow(
			"Unknown Runtime Profile capability: endophasia.memory.v0",
		);
		// Chord service IDs and Pi plumbing are not capability IDs.
		for (const id of ["endophasia.runtime-facts.v0", "endophasia.inspector.v0", "pi.transcript", "", 7, null]) {
			expect(() => runtimeProfileV0(profile({ capabilities: [id] }))).toThrow(TypeError);
		}
		expect(() => runtimeProfileV0(profile({ capabilities: ["endophasia.usage.v0", "endophasia.usage.v0"] }))).toThrow(
			"Duplicate Runtime Profile capability: endophasia.usage.v0",
		);
		expect(() =>
			runtimeProfileV0(profile({ capabilities: ["endophasia.usage.v0", "endophasia.mission-trace.v0"] })),
		).toThrow("not in canonical order");
		expect(() => runtimeProfileV0(profile({ capabilities: "endophasia.usage.v0" }))).toThrow(TypeError);
	});

	it("rejects an empty runtime family or adapter profile ID, and any other schema or scope", () => {
		for (const runtimeFamily of ["", "   ", undefined, 1]) {
			expect(() => runtimeProfileV0(profile({ runtimeFamily }))).toThrow("runtimeFamily");
		}
		for (const adapterProfileId of ["", "\t", undefined, {}]) {
			expect(() => runtimeProfileV0(profile({ adapterProfileId }))).toThrow("adapterProfileId");
		}
		expect(() => runtimeProfileV0(profile({ schemaVersion: "runtime-profile.v1" }))).toThrow("schemaVersion");
		expect(() => runtimeProfileV0(profile({ scope: "session" }))).toThrow("scope");
	});

	it("rejects fields outside the schema instead of carrying them", () => {
		for (const extra of ["version", "revision", "buildHash", "nativeCapabilities", "services"]) {
			expect(() => runtimeProfileV0({ ...profile(), [extra]: "x" } as RuntimeProfileClaimV0)).toThrow(
				`Unknown Runtime Profile field: ${extra}`,
			);
		}
		expect(() => runtimeProfileV0(null as unknown as RuntimeProfileClaimV0)).toThrow(TypeError);
		expect(() => runtimeProfileV0(Object.assign(Object.create({ inherited: true }), profile()))).toThrow(
			"plain object",
		);
	});
});

describe("Runtime Profile facet", () => {
	it("publishes exactly the schema fields over a strict-JSON wire", async () => {
		const { state } = await bind([createEndophasiaRuntimeProfileFacetV0(profile())]);
		expect(state.value).toEqual(profile());
		expect(Object.keys(state.value ?? {}).sort()).toEqual([
			"adapterProfileId",
			"capabilities",
			"runtimeFamily",
			"schemaVersion",
			"scope",
		]);
	});

	it("validates on creation, so a malformed claim is never installed", () => {
		expect(() => createEndophasiaRuntimeProfileFacetV0(profile({ capabilities: ["endophasia.acp.v0"] }))).toThrow(
			TypeError,
		);
		expect(() => createEndophasiaRuntimeProfileFacetV0({ ...profile(), extra: 1 } as RuntimeProfileClaimV0)).toThrow(
			TypeError,
		);
	});

	it("copies the claim: later changes to the caller's object are never published", async () => {
		const claim = {
			schemaVersion: "runtime-profile.v0" as const,
			scope: "session-worker-lifetime" as const,
			runtimeFamily: "test-family",
			adapterProfileId: "endophasia.test.v0",
			capabilities: ["endophasia.mission-trace.v0"] as EndophasiaRuntimeCapabilityIdV0[],
		};
		const facet = createEndophasiaRuntimeProfileFacetV0(claim);
		claim.runtimeFamily = "tampered";
		claim.capabilities.push("endophasia.continuity.v0");
		const { state } = await bind([facet]);
		expect(state.value).toEqual({ ...profile(), capabilities: ["endophasia.mission-trace.v0"] });
	});

	it("reads the claim once, when created, and nothing afterwards", async () => {
		let reads = 0;
		const claim = profile();
		const counted = {} as Record<string, unknown>;
		for (const [key, value] of Object.entries(claim)) {
			Object.defineProperty(counted, key, {
				enumerable: true,
				get() {
					reads++;
					return value;
				},
			});
		}
		const facet = createEndophasiaRuntimeProfileFacetV0(counted as unknown as RuntimeProfileClaimV0);
		const afterCreate = reads;
		const { state } = await bind([facet]);
		expect(state.value).toEqual(claim);
		expect(reads).toBe(afterCreate);
	});

	it("never changes the published state, and each host gets its own copy", async () => {
		const facet = createEndophasiaRuntimeProfileFacetV0(profile());
		const first = await bind([facet]);
		const second = await bind([facet]);
		const updates: unknown[] = [];
		// A new subscriber is hydrated with the current value; only a later update would be a change.
		for (const { state } of [first, second]) {
			state.subscribe(async (value, _context, delivery) => {
				if (delivery.kind !== "hydrate") updates.push(value);
			});
		}
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(updates).toEqual([]);
		expect(first.state.value).toEqual(second.state.value);
		expect(first.state.value).not.toBe(second.state.value);
	});
});
