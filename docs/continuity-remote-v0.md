# Continuity Remote v0

Continuity Remote v0 exposes Endophasia's existing `ContinuitySnapshotV0` as a read-only remote service for the attached Session's main Pi lane. The Presentation Client exposes it as `continuitySnapshot(context)`, and Standard Cockpit captures it only when asked.

```
  Standard Cockpit        Continuity panel, explicit Capture      cockpit/
          |
  Presentation Client     continuitySnapshot(context)             presentation/client.ts
          |   Pi protocol (Unix socket or WebSocket)
  endophasia.continuity.v0   snapshot(context)                    src/continuity-service.ts (contract)
          |
  Continuity facet        fresh capture per call, size check      src/continuity-facet.ts (host)
          |
  captureContinuityV0     main lane watch + findEntries           src/continuity.ts (Pi-backed)
```

## What a snapshot means

The meaning is unchanged from `captureContinuityV0`:
- **One tip.** A snapshot is anchored to one captured tip of the main lane.
- **`activePath`.** The tip's committed durable ancestry, including history from before any compaction.
- **`contextWindow`.** Pi's compaction-bounded source-entry window. It is not the final prompt a provider sees.
- **`compaction`.** The window's boundary compaction, described by structure only.
- **`configuration`.** The lane's model, thinking level and active tool names, reported explicitly.
- **No payloads.** Message content, reasoning, tool arguments and results, compaction and branch summaries, and custom-entry data never cross the projection. `hasSummary` and `hasData` report only that a payload exists.
- **Read-only.** A capture reads the lane and releases its temporary watcher.

## A fresh capture, not live state

Each `snapshot()` call runs `captureContinuityV0` against the main lane. The facet:
- seeds nothing;
- caches nothing;
- subscribes to nothing.

A failed capture fails the call. It is never replaced by an empty snapshot.

The snapshot carries no capture time. The cockpit records `capturedAt` as the moment the cockpit received the capture.

## Pi-backed by design

The facet takes only the main lane's `watch` and `findEntries` reads. Nothing else of the lane or the harness is handed over.

`runtime/session-worker.ts` installs it on the same main lane the Pi observation adapter already uses. Continuity is not a port of the [Runtime Observation Boundary](runtime-observation-boundary-v0.md): there is no `RuntimeContinuitySourceV0` and no Prime mapping.

A runtime-neutral Continuity capability would first need another runtime to show these exact semantics. The service being Pi-backed says nothing about whether Prime could provide Continuity.

## Presentation Client and cockpit

**Presentation Client.** The client binds `endophasia.continuity.v0` as a required Session service, like the Inspector, Mission Trace, Runtime Facts and Usage:
- a worker without it attaches degraded;
- a detached or degraded client's read fails;
- the client exposes only the read method, never the service object, lane or harness.

**Standard Cockpit.** Continuity is handled like Session Accounting:
- it changes only on an explicit **Capture** press;
- a second press while a capture is in flight starts nothing;
- nothing subscribes, polls or refreshes it, and transcript, Mission Trace and Usage updates never request it.

**Stale Sessions.** Each capture records its Session and a generation number:
- selecting another Session clears the capture and discards any capture in flight, because Pi still reports the old Session attached until the attach completes;
- any attachment change clears it too, including attaching, degraded, detached, and re-attaching the same Session.

A late result is dropped rather than shown under another Session. A failure stays in the Continuity panel and does not affect the attachment.

**Cockpit panel.** The panel shows only the snapshot's own fields:
- lane, tip, configured model, thinking level and active tools;
- the three counts, as given and never recomputed;
- the compaction boundary.

Two collapsed lists show the context-window and active-path entries. They show at most the latest 100 rows each, labelled as a display window over a complete capture. Each row shows only:
- sequence, ID and type;
- role and stop reason;
- the terminate flag;
- compaction and branch-summary structure;
- custom type, and whether data exists.

The panel does not join entries to Mission Trace runs, Usage rows or Operation Outcomes, and it does not present `contextWindow` as token occupancy or as the provider-visible prompt.

## Remote size limit

**Problem.** `activePath` is a tip's whole durable ancestry, so its size has no bound. Every Pi client transport carries a service result in one CBOR frame, 16 MiB by default. That covers both the Unix socket and the cockpit's WebSocket. When a response cannot be encoded within the frame, Pi's server closes the client's whole connection. The Session worker's hop to the server is a JSON line of up to 128 MiB, so the client frame is the binding limit.

**Measured.** A main-lane message entry with Pi's UUIDv7 IDs projects to about 212 JSON bytes. An uncompacted lane lists every entry in both `activePath` and `contextWindow`, about 424 bytes per entry. CBOR frames came out at about 83% of the JSON size, so without a limit the 16 MiB frame would close the connection at roughly 45,000 uncompacted entries.

**Solution.** The facet serializes each snapshot and refuses it when its JSON is over `CONTINUITY_REMOTE_BYTE_LIMIT` (8 MiB). The snapshot is never truncated or paginated, and its semantics are unchanged.

- **Tested boundary.** A synthetic snapshot of 8,388,170 JSON bytes, the largest under the limit, crosses the real Unix transport whole as an 8,162,666-byte frame. One more entry is refused.
- **Practical limit.** The limit falls at roughly 20,000 main-lane entries without compaction. After compaction, only the shorter `contextWindow` is listed twice, so a heavily compacted lane reaches about 39,000 entries.
- **Error text.** The worker endpoint reports the exact reason: the byte size, the entry count and the limit. Pi's server does not forward a service's own error text to clients, so a remote reader, and therefore the cockpit, sees Pi's generic `Internal server error`. The connection, the attachment and the other services stay usable.

This is a v0 limitation. A Session past the limit cannot be captured remotely until a later version defines paging or streaming with its own completeness semantics.

## Browser boundary

**Bundled contract.** `src/continuity-service.ts` holds the schema, the service handle and the byte-limit constant. It imports only Chord and Pi types, so the Presentation Client and the cockpit can bundle it.

**Host-only modules.** `src/continuity.ts` (the capture) and `src/continuity-facet.ts` (the facet) run on the host only. `scripts/check-browser-smoke.mjs` requires the contract in both Endophasia browser bundles. It fails if either host module is among the bundle's resolved inputs, so the check does not depend on tree-shaking.
