# Runtime Observation Boundary v0

Endophasia's observation services (Mission Trace, Runtime Facts, Usage) read a runtime through four narrow capability ports defined in Endophasia's own v0 semantics. Pi implements all four behind a Pi adapter. A future runtime implements only the ports whose semantics it can meet exactly.

```
        Endophasia observation services (Chord)
   mission-trace.v0   runtime-facts.v0   usage.v0
          |               |      |           |
     Mission Trace     Metrics  Outcome    Usage        src/runtime-observation.ts
          \               |      |           /
                  Pi adapter                             src/pi-runtime-observation.ts
                       |
     AgentHarness events, AgentLane watch/getResult, Session.scanUsage
```

## Why the boundary exists

Before this change, every host facet took Pi objects directly. The Mission Trace facet took `AgentHarness`, the Runtime Facts facet took `AgentLane`, and the Usage facet took Pi's `Events` plus `Session.scanUsage`. A second runtime could only be added by teaching the service layer that runtime's native vocabulary.

[Prime Runtime Conformance v0](prime-runtime-conformance-v0.md) (Prime 0.9.6 at `2d24ad4e`) showed that another runtime can supply some of these surfaces and not others. The boundary follows that evidence: one port per surface, and no assumption that any two ports come together.

## The four capabilities

All four ports are defined in `src/runtime-observation.ts`.

| Port | Delivers | Replaces in the facet |
| --- | --- | --- |
| `RuntimeMissionTraceSourceV0` | `observe(listener)`: finished `MissionTraceEventV0` events, numbered from 1 | `AgentHarness.events` |
| `RuntimeMetricsSourceV0` | `read(context)`: `RuntimeMetricsV0` | `AgentLane.watch` |
| `RuntimeOperationOutcomeSourceV0` | `read(operationId, context)`: `OperationOutcomeV0 \| null` | `AgentLane.getResult` |
| `RuntimeUsageSourceV0` | `tail`, `page` and `attach` over `UsageLedgerRowV0` | Pi `Events` + `Session.scanUsage` |

`RuntimeObservationSourcesV0` groups them for a composition root, and every member is optional. Each facet receives only the port it needs, never the aggregate.

The facets own only what is Endophasia's:
- the replicated window;
- bounded retention;
- remote argument checks;
- service publication;
- a payload-minimal copy of every value. Only the v0 schema fields cross the service boundary, whatever an adapter attaches.

The payload types moved into the Pi-free contract modules, with their wire shapes unchanged:
- `MissionTraceEventV0` to `mission-trace-service.ts`;
- `RuntimeMetricsV0` and `OperationOutcomeV0` to `runtime-facts-service.ts`;
- the `UsageLedger*` types to `usage-service.ts`.

## Orthogonal capabilities

No port implies another. A runtime may implement Mission Trace, Metrics and Usage without implementing Operation Outcome, and nothing encodes "metrics implies outcome" or "trace implies usage".

The existing `endophasia.runtime-facts.v0` service still exposes both `runtimeMetrics()` and `operationOutcome()`, so its facet is built from two separate ports and requires both. A runtime that lacks one does not get a synthesized empty or null capability. Deciding which services a partial runtime installs, and how Presentation degrades, is future work.

## Presence means exact semantics

Implementing a port is a claim that the existing v0 contract holds exactly. That covers:
- sequence meanings;
- cumulative (not context-window) accounting;
- `null` meaning only "unknown or not yet terminal";
- session-global usage sequences with normal gaps;
- a gap-free live handoff.

A mapping that is merely similar, or qualified, is not an implementation. Absence is preferable to a semantic lie.

## Why Prime is not installed into these ports

PR #21 classified Prime against the same contracts:

| Capability | Pi today | Prime #21 evidence (0.9.6 @ `2d24ad4e`) |
| --- | --- | --- |
| Mission Trace | exact implementation | qualified mapping (adapter-state) |
| Runtime Metrics | exact implementation | qualified mapping (adapter-state) |
| Operation Outcome | exact implementation | unavailable / incompatible |
| Usage | exact implementation | qualified mapping (adapter-state) |

"Pi today" means the v0 semantics are defined and projected from Pi and already tested. It does not mean every Pi fact is native: the run and turn identities in Mission Trace, for example, are Pi's own, but the usage feed's gap-safe handoff is Endophasia's algorithm over Pi's reads.

"Qualified" means a truthful mapping exists only with adapter-owned state and stated differences. So no Prime implementation is installed yet. A future Prime adapter may own internal state (run and turn counters, a durable usage sequence across a fork family, a rebuilt cumulative accounting). It implements a port only once that state makes the exact v0 semantics hold.

## What stays runtime-specific

- **Pi, in the Pi adapter and its projections:**
  - `pi-runtime-observation.ts`, `mission-trace.ts`, `runtime-metrics.ts`, `durable-outcomes.ts`, `usage-ledger.ts` and `usage-feed.ts`;
  - `AgentHarness` events, `AgentLane.watch` and `getResult`, and `Session.scanUsage`;
  - Pi's `UsageRow` and its `seq`;
  - the trusted pairing of Pi's usage events with the same Session's usage reads (Pi's usage event carries no Session identity).
- **Prime, below a future Prime adapter:**
  - RPC command and event names, and JSONL framing;
  - `get_session_stats`, session-file layouts and fork/session paths;
  - queue suspension rules, child-usage attribution and daemon details.

  None of these appears in the ports.

The Session worker (`runtime/session-worker.ts`) is the composition root: the one place that knows the worker's runtime is Pi. The Inspector is outside this boundary and still reads Pi lanes directly.

## Why Operation Outcome is separate from Runtime Metrics

They answer different questions from different mechanisms. Metrics are a fresh read of cumulative accounting. An outcome is an immutable terminal record found by a stable operation ID after completion, abort, detach or reopen. PR #21 found Prime can reconstruct the first but keeps no equivalent of the second, so bundling them would force a runtime to either lie or give up both.

## Not a generic Runtime API

These are read-only observation ports for four surfaces that already exist. There is:
- no prompt, steering, control, transcript, model, tool or continuity abstraction;
- no runtime selector;
- no new schema;
- no capability negotiation.

Those need their own evidence before they get a boundary.
