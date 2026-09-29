# Runtime Profile v0

A Runtime Profile is one small, read-only statement per Session worker. It answers two questions:
- **Runtime family.** Which runtime family is this worker composed around?
- **Capabilities.** Which Endophasia v0 semantic surfaces does this worker explicitly claim to provide, exactly?

Standard Cockpit shows the profile as live metadata. The profile is a view of one claim. It is not feature negotiation, and it is not a plugin API.

```
  runtime/session-worker.ts (composition root, knows the runtime is Pi)
     |  installs the six implementations
     |  and states PI_STANDARD_RUNTIME_PROFILE_V0 explicitly
     v
  Runtime Profile facet     validate, copy, publish once        src/runtime-profile-facet.ts (host, generic)
     |
  endophasia.runtime-profile.v0   state: RuntimeProfileV0       src/runtime-profile-service.ts (contract)
     |   Pi protocol, its own Session binding
  Presentation Client       runtimeProfile                       presentation/client.ts
     |
  Standard Cockpit          Runtime Profile panel                cockpit/
```

## What the profile says

```ts
interface RuntimeProfileV0 {
	schemaVersion: "runtime-profile.v0";
	scope: "session-worker-lifetime";
	runtimeFamily: string;
	adapterProfileId: string;
	capabilities: EndophasiaRuntimeCapabilityIdV0[];
}
```

- **Scope.** A profile describes one Session worker's composition, for that worker's lifetime. It is not durable Session history. A new worker publishes its own profile, even when the value is equal.
- **Whose claim it is.** The trusted Endophasia composition root makes the claim. The runtime does not report it about itself. A capability appears only because the composition root deliberately installed an implementation of that capability's exact existing v0 semantics.
- **Presence.** An advertised capability means the exact v0 semantics are deliberately offered.
- **Absence.** An unlisted capability means only that this worker does not advertise that exact capability. The reason may be that it is:
  - unimplemented;
  - unprobed;
  - only a qualified mapping;
  - intentionally omitted;
  - incompatible.

  Absence is never a statement that a runtime cannot support the capability.
- **`runtimeFamily` and `adapterProfileId`.** Both are informational and imply no capability. `adapterProfileId` names the Endophasia composition (for example `endophasia.pi-standard.v0`), not a runtime build.

The profile has no version, revision or build fields. Exact runtime and build provenance is a separate, subtler problem: [Prime Runtime Ingress v0](prime-runtime-ingress-v0.md) treats it as such, and a Runtime Profile does not flatten it into a label.

## The closed v0 catalogue

| Capability | Chord service today | Where its semantics sit |
| --- | --- | --- |
| `endophasia.session-overview.v0` | `endophasia.inspector.v0` | outside the observation boundary |
| `endophasia.mission-trace.v0` | `endophasia.mission-trace.v0` | [Runtime Observation Boundary v0](runtime-observation-boundary-v0.md) |
| `endophasia.runtime-metrics.v0` | `endophasia.runtime-facts.v0` | Runtime Observation Boundary v0 |
| `endophasia.operation-outcome.v0` | `endophasia.runtime-facts.v0` | Runtime Observation Boundary v0 |
| `endophasia.usage.v0` | `endophasia.usage.v0` | Runtime Observation Boundary v0 |
| `endophasia.continuity.v0` | `endophasia.continuity.v0` | outside the observation boundary |

Capability IDs are Endophasia semantics, not Chord service IDs:
- **Runtime Facts.** Runtime Metrics and Operation Outcome are separate capabilities, although one service exposes both.
- **Pi plumbing.** Pi's Transcript and Models services are presentation and runtime plumbing, not Endophasia semantic capabilities.
- **Nothing speculative.** The catalogue has no control, steering, memory, ACP or other future IDs.

## The standard Pi profile

`runtime/session-worker.ts` states `PI_STANDARD_RUNTIME_PROFILE_V0` explicitly, beside the facets it installs:
- `runtimeFamily: "pi"`;
- `adapterProfileId: "endophasia.pi-standard.v0"`;
- all six capabilities.

The worker installs six Endophasia facets: Runtime Profile, Inspector, Mission Trace, Runtime Facts, Usage and Continuity. A test pins a hand-reviewed mapping from each installed service to its capabilities. If the standard worker gains or loses a service, that test fails until the mapping and the profile are reviewed.

**Inside the boundary.** Mission Trace, Runtime Metrics, Operation Outcome and Usage are served through Runtime Observation Boundary v0 ports.

**Outside the boundary.** Session Overview reads Pi lanes directly. Continuity is Pi-backed on the main lane ([Continuity Remote v0](continuity-remote-v0.md)). Neither has a runtime-neutral port yet, because no second runtime has shown their exact semantics. "Outside the boundary" means only that; it does not mean Pi-only or non-portable.

## What it is not

- **Not discovery.** Nothing is read from the runtime or inferred from the Chord service catalogue, the runtime family or the adapter profile ID.
- **Not negotiation.** The flow is one-way: composition root → profile → presentation. The Presentation Client binds the same required services whatever the profile says, and a profile never controls which services are installed or bound.
- **Not conformance.** The profile runs no tests and certifies no compatibility.
- **Not native feature advertisement.** Prime's ACP `initialize` capabilities, RPC command availability, `_meta` extensions and version are separate evidence. None of them is translated into an Endophasia capability automatically.

## No Prime capability is admitted

This change installs no Prime profile and claims nothing about Prime. The Prime evidence classified in [Prime Runtime Conformance v0](prime-runtime-conformance-v0.md) remains qualified or unavailable. The profile only provides the truthful place where an admitted Prime capability could later be reported.

## The facet

`createEndophasiaRuntimeProfileFacetV0(profile)` is generic and knows no runtime. It:
- validates the claim when created:
  - the exact schema version and scope;
  - a non-empty runtime family and adapter profile ID;
  - known v0 capability IDs only, without duplicates, in canonical order;
  - no fields outside the schema;
- copies the claim field for field, so later changes to the caller's object are never published;
- publishes one replicated state and never changes it;
- reads, polls and subscribes to nothing.

## Presentation and cockpit

**Presentation Client.** The client binds `endophasia.runtime-profile.v0` as a required Session service, in its own binding, and exposes only `runtimeProfile`, a read-only replicated state.
- A worker without a profile attaches degraded.
- A plain Pi server gets no synthetic `pi` profile.

Because the binding is separate, a profile can hydrate while another service leaves the attachment degraded. Pi publishes `attaching` and then, in the same turn, clears every Session binding before rebinding. So a profile seen while Pi reports `attached` or `degraded` belongs to that attachment.

**Standard Cockpit.** The Runtime Profile panel shows:
- the runtime family and the adapter profile;
- the worker-lifetime scope;
- the advertised count;
- each known capability, grouped by boundary, as `advertised` or `not advertised`.

Identifiers outside the catalogue are listed verbatim, bounded and without meaning. Nothing is derived from the runtime family or the adapter profile ID.

**Visibility.** The panel shows the profile for an attached or degraded Session. It is hidden:
- while a selection is pending, because Pi still reports the previous Session attached until the attach completes;
- while attaching;
- while detached;
- when no profile hydrated.

**Health stays separate.**
- **Under degradation.** The panel says the attachment is degraded and that the profile is the worker's claim, not evidence that its services hydrated.
- **Attachment health.** It stays Pi's `attachment` state. The profile never makes a degraded attachment healthy.
- **Advertised is not hydrated.** Advertising a capability does not prove that the capability's service hydrated on this client.

## Browser boundary

`src/runtime-profile-service.ts` holds the catalogue, the schema and the service handle. The Presentation Client and the cockpit bundle it.

`scripts/check-browser-smoke.mjs` requires it in both Endophasia browser bundles. It rejects:
- `src/runtime-profile-facet.ts`;
- `runtime/session-worker.ts` and the rest of `runtime/`;
- `src/runtime-observation.ts`, which is not needed to render a profile.
