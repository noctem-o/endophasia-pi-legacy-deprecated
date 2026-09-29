# Prime RPC Runtime Ingress v0

The first production code that talks to Prime. It starts `prime-agent --mode rpc`, frames its JSONL protocol strictly, correlates command responses, delivers native events in order, records which Prime is running, and shuts the process down within a bounded time. It interprets no event, and it installs no Endophasia capability port.

```
   Endophasia observation services (Chord)      <- unchanged; no Prime port installed
   src/runtime-observation.ts ports             <- unchanged; no Prime vocabulary
   ---------------------------------------------------------------------------------
   (future) Prime semantic adapter              <- not in this change
   runtime/prime/rpc-connection.ts              process, correlation, events, lifecycle
   runtime/prime/jsonl.ts                       strict framing
   runtime/prime/runtime-identity.ts            version, installation, source provenance
   ---------------------------------------------------------------------------------
   prime-agent --mode rpc (child process, LF-delimited JSON over stdio)
```

## 1. The Prime process boundary

Prime runs as a separate child process. Endophasia owns the process and is the only writer to its stdin.

- **Location.** `packages/endophasia/runtime/prime/`. It is Node-only: it uses `node:child_process` and stdio. It is not exported from `@endophasia/core`.
- **Browser exclusion.** `scripts/check-browser-smoke.mjs` already forbids `packages/endophasia/runtime/` in the Presentation and Cockpit bundles, and now names `packages/endophasia/runtime/prime/` explicitly.
- **Import guards.** Offline tests (`test/prime-runtime-ingress.test.ts`) check that:
  - `runtime/prime` imports only `node:` builtins and its own modules, and never `research/`;
  - `src/`, `presentation/`, `cockpit/` and `runtime/session-worker.ts` import nothing Prime;
  - `src/runtime-observation.ts` contains no Prime vocabulary.
- **Environment.** The child receives exactly the environment the caller passes. Nothing is inherited from `process.env`, so an ambient `OPENAI_API_KEY` or similar credential cannot leak in. A test sets `OPENAI_API_KEY` in the parent and checks that the child sees only `PATH`.
- **stderr.** stderr is discarded. It may quote payloads, and an unread pipe could block Prime.
- **Process group.** On POSIX, Prime runs in a process group the connection owns (`runtime/prime/process-group.ts`). The group is led by a small keeper process (a `node -e` script):
  - it receives the command, arguments and environment over a control socket, so none of them appear on a command line, and it runs with an empty environment itself;
  - it starts Prime inside its group and reports Prime's exit;
  - it stays alive until the connection releases the group, which it does by SIGKILLing its own group, itself included, in one `kill(2)`.

  While the keeper lives, the group ID cannot be reused, so a signal to the group can never reach an unrelated process. If the owning process dies, the keeper sees its control socket close and ends the group the same way. On Windows there are no process groups: Prime is spawned directly.

The Pi Session worker is unchanged. It never starts Prime, and there is no runtime selection.

## 2. Why RPC

PR #21 ([Prime Runtime Conformance v0](prime-runtime-conformance-v0.md)) gathered all of its evidence over `prime-agent --mode rpc`:
- 12 probe fixtures;
- the framing findings;
- the terminal-status table;
- the refusal and suspended-queue behaviour.

A production substrate built on the same transport can be checked against that evidence. ACP is a different protocol with its own event vocabulary and lifecycle, and none of it has been probed. Switching to it would discard the evidence this layer rests on.

## 3. Which Prime has evidence

- **Version and commit.** Prime 0.9.6 at `2d24ad4e6b2d1ee8e6919af6f108e980a14d550e`.
- **Launch.** `prime-agent --mode rpc`, LF-delimited JSON over stdio.
- **Evidence.**
  - `docs/prime-runtime-conformance-v0.md`;
  - `packages/endophasia/research/prime-conformance/`;
  - `packages/endophasia/test/fixtures/prime/0.9.6/`.
- **Unchanged here.** The research code, its fixtures and its findings are unchanged. Production code copies the probe's framing rules and does not import them. Differential tests hold production to the research decoder instead.

`readPrimeRuntimeIdentityV0` records which Prime is running:
- the version from `--version`: a SemVer 2.0.0 version (no leading zeros; `01.2.3`, `1.2.3-01` and `1.2.3+a+b` are rejected) standing alone as a word (optionally `v`-prefixed), so a versioned path such as `/opt/prime/1.2.3` is never read as a version. The output must name exactly one distinct version (a launcher that also prints its Node version is ambiguous and rejected). `--version` and the git reads are bounded: at the timeout the process group is killed and the read fails, even if the command ignores SIGTERM or a descendant holds its output open. Each command runs in an owned process group (see the process boundary above): once it exited, anything left in the group is killed while the keeper still holds the group ID, so no descendant outlives the read and no recycled group ID is signalled;
- whether Prime is a standalone binary (`PRIME_AGENT_BIN`) or a source checkout (`PRIME_AGENT_ROOT`, launched through `prime-agent.sh`);
- for a source checkout, the HEAD commit (a SHA-1 or SHA-256 object ID) and whether tracked files are modified. The result is `clean`, `dirty` or `unknown`; untracked files do not count. Provenance is accepted only when git's top level is the configured root itself: a root that merely sits inside another repository reports `unknown`, never the ancestor's commit. The git probes run without any `GIT_*` variable from the given environment (`GIT_DIR`, `GIT_WORK_TREE` and the like could select another repository despite `-C`), and the version and provenance are read as one stable snapshot: HEAD, the tracked-file status and the launcher file's stat are read before and after `--version`. If anything moved (an updater switched or edited the checkout), the whole read is repeated, up to three times. A checkout that keeps changing is an error, never an identity that did not describe one runtime.

A binary never carries a commit, because its source commit is not knowable from outside and is not claimed.

The identity is a record, not a certification. Deciding whether an identity belongs to a supported profile is left to a future semantic adapter.

## 4. Why current Prime main and ACP are not treated as equivalent

Conformance is a property of a specific build. Prime's agent loop, its event set and its RPC refusals can all change between commits. Examples:
- probe 0.2.0 met an undocumented `refine_failed` event;
- the suspended-input-queue behaviour depends on `agent-session.ts` details.

A newer Prime may or may not keep the 0.9.6 behaviour, and nothing here re-proves it. For that reason the ingress:
- reports the version and, for a checkout, the commit and tree state, so a later adapter can refuse an unprobed profile explicitly;
- never assumes that "Prime" means 0.9.6.

ACP is excluded for the reason in section 2.

## 5. What the ingress guarantees

**Framing** (`PrimeJsonlDecoderV0`):
- Bytes are split on LF only; readline is never used. U+2028 and U+2029 inside JSON strings stay part of the record.
- One trailing CR is stripped. A lone CR is not a separator.
- UTF-8 split across chunks, including inside a code point, is reassembled. An incomplete record is kept in one buffer that grows by doubling, so a record split over many chunks, even one byte per chunk, costs amortized linear copying and one allocation, not an object per chunk.
- A record longer than `maxRecordBytes` (default 64 MiB) is discarded up to its LF and reported as `oversized-record`; decoding continues with the next record.
- Each record is decoded with a fatal UTF-8 decoder. Malformed bytes, overlong encodings, lone surrogates and a truncated final code point are faults. They are never turned into U+FFFD.
- A record must be exactly one JSON object. A blank line, malformed JSON, an array, `null` or a scalar is a fault.
- A final record without an LF is still decoded at end of stream.
- Differential tests feed a hostile corpus to both the production decoder and the research `JsonlDecoderV0`, in 200 random chunkings. The classifications must be identical.

**Correlation** (`PrimeRpcConnectionV0.request`):
- The connection assigns unique IDs (`endophasia-N`). A command that carries its own `id` is rejected. The ID is reserved before any of the caller's getters or nested `toJSON` run, so a request issued from inside one gets its own ID; an ID whose command is never sent is handed back (or, when a re-entrant request already reserved a later one, remembered as unsent), so only IDs Prime received count as issued: a response for an unsent ID is `unknown-response-id`, not `stale-response-id`.
- A command is read and serialized before anything is registered. One that cannot be read or encoded (a cycle, a `BigInt`, a throwing getter or Proxy trap, including on `type`) is rejected, never thrown, with no pending entry or timer left behind. `type` is read once and the checked value is what is sent. A command with its own `toJSON` is refused unsent, since `JSON.stringify` would let it replace the envelope's `type` and `id`.
- Commands buffered for a slow reader are bounded by `maxInputBacklogBytes` (default 16 MiB): a request that would exceed it is rejected unsent.
- A response settles its request at most once:
  - a response for an ID this connection issued whose request already settled (answered, rejected or timed out) is a `stale-response-id` fault. IDs are sequential, so this needs no per-request history;
  - any other ID is `unknown-response-id`;
  - a response without an ID is `response-without-id`.
- A response must have:
  - a non-empty `command` string;
  - a boolean `success`;
  - a string `error` exactly when `success` is false. A success carrying an `error` is malformed, so refusal text never arrives through a successful response.

  Anything else is a `malformed-response` fault and never settles a request.
- A response whose `command` differs from the request's rejects that request. The caller would otherwise receive another command's data shape.
- A refusal (`success: false`) resolves as a refusal, not an error.

**Events** (`subscribe`):
- Every non-response record with a string `type` is delivered to every listener in arrival order.
- Nothing is retained, so history is not unbounded.
- A throwing listener is reported as `listener-failure` with only a standard error name (`TypeError`, `RangeError` and so on), `other-error` or `non-error`. Classifying the thrown value is itself guarded, so a Proxy whose traps throw cannot escape listener isolation. An `Error`'s `name` is mutable, so a custom name is never forwarded. Other listeners, later records and pending requests are unaffected. A throwing `onDiagnostic` sink is also contained.

**Commands** (`observeCommands`):
- The connection is the sole stdin writer. Each command is announced synchronously as it is written, before any response or later event can arrive.
- `answerExtensionUi(requestId, answer)` answers a dialog Prime opened with `extension_ui_request`. Prime blocks until an `extension_ui_response` with the same ID arrives and sends no reply to it (`prime:packages/coding-agent/src/modes/rpc/rpc-mode.ts:461-473`), so it is a write, not a request, and it keeps Prime's ID. It resolves once the record is written to Prime's stdin pipe and rejects if that write fails (e.g. EPIPE), so an undelivered answer is never reported as sent. The record is built only from the three answer shapes Prime accepts (`value`, `confirmed`, `cancelled: true`). The ingress still does not interpret the dialog.
- This lets a future adapter know, in order, which aborts it sent itself.

**Lifecycle**:
- `exited` settles when the process exits or cannot start. Pending requests reject at that moment with `PrimeRpcExitErrorV0`, and later requests reject immediately.
- `terminated` settles only when the process has exited and stdout has closed. Records written just before exit are still decoded, including a final record without an LF.
- If Prime's stdin fails while it still runs (EPIPE), waiting requests reject at once and later requests are refused, with a `stdin-failure` diagnostic, instead of each waiting for its timeout.
- If a descendant holds stdout open after exit, the drain is bounded by `drainGraceMs`. The process group is then killed, stdout is destroyed, and `terminated` reports `stdoutDrained: false`.
- `close()` ends stdin and waits for `terminated`, even when the process already exited. If Prime does not exit within `closeTimeoutMs`, it sends SIGTERM to the process group, then SIGKILL to Prime two seconds later, reporting each as `forced-termination`. The connection owns the whole group. Once Prime exited and stdout drained (whether or not `close()` was called), any member still running, such as a descendant that does not hold stdout, gets SIGTERM (unless the group already did) and SIGKILL when the grace expires; `close()` resolves after that. Finally the group is released, which SIGKILLs anything left along with the keeper. Every group signal is sent while the keeper is alive, so the group ID is always still this group's. Where `/proc` exists (members are observed there; elsewhere the group is released at once), only live members count, since a killed descendant may stay a zombie when a container's PID 1 does not reap it.
- Every `close()` call returns the same promise.
- Tests confirm that no descendant outlives the connection.

**Privacy**:
- Diagnostics carry categories, byte lengths and standard error names only.
- Connection error messages name commands, IDs and exit codes, never record content.
- The fake Prime puts privacy sentinels into prompts, assistant output and tool arguments. Tests check that none reach diagnostics or connection errors.
- The ingress persists nothing.
- The one exception is Prime's own refusal text, which is handed back as `response.error`. Its type documents that it may quote user content and must not be persisted raw.

## 6. What the ingress deliberately does not interpret

- **Events.** Event types and fields stay raw (`{ type, record }`). There is no run, turn, lane or operation identity, no terminal status, and no model or tool mapping.
- **Commands.** Response `data` is passed through unvalidated. Decoding `get_state`, `get_session_stats` and the rest belongs to a semantic adapter.
- **Refusals.** Refusal text is not classified. For example, "queued session input is suspended" means something only to an adapter that knows Prime's post-abort queue.
- **Provider, model and session arguments.** The caller passes them as `args`, and the ingress does not choose them.
- **Other surfaces.** It has no knowledge of Usage, Runtime Metrics, Operation Outcome, Continuity or RLM.

## 7. Mission Trace admission result: not admitted

`RuntimeMissionTraceSourceV0` promises exact v0 semantics. Every run the source reports ends in exactly one of `mission.completed`, `mission.failed` or `mission.aborted`, and that status is a fact, not a guess. At Prime 0.9.6 two terminal paths cannot meet this.

### Output-length stop

`prime:packages/agent/src/agent-loop.ts` at `2d24ad4e`:

```ts
343		if (message.stopReason === "error" || message.stopReason === "aborted") {
344			await emit({ type: "turn_end", message, toolResults: [] });
345			await emit({ type: "agent_end", messages: newMessages });
346			return;
347		}
349		const toolCalls = message.content.filter((c) => c.type === "toolCall");
```

- Only `error` and `aborted` take the early exit. An assistant message with `stopReason: "length"` and no tool calls sets `hasMoreToolCalls = false` and follows the normal `turn_end`. The inner loop ends, follow-ups are polled, and `agent_end` is emitted.
- On the wire, this looks exactly like a completed run except for the final stop reason. `probe:length-stop` records it.
- The model did not finish, and nothing failed. `completed` would be false, `failed` would be invented, and `aborted` did not happen.
- Pi handles the same case differently:
  - Pi's harness routes a length stop through overflow recovery (`isRecoverableLength` in `packages/agent/src/harness/runtime/drive/response.ts`).
  - The run then always ends with a `run_end` status: `completed` after a successful recovery, or `failed`.
  - A faux-provider check during this work saw `failed` with code `summarization_failed`.
  - Prime has no such policy, so the three-way v0 status has no truthful value for this run.

### `toolUse` final stop without the adapter's own abort

```ts
353			if (toolCalls.length > 0) {
354				const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
355				toolResults.push(...executedToolBatch.messages);
356				hasMoreToolCalls = !executedToolBatch.terminate;
...
364			await emit({ type: "turn_end", message, toolResults });
365			if (signal?.aborted) {
366				await emit({ type: "agent_end", messages: newMessages });
367				return;
368			}
...
376			const shouldStopResult = await settlePostTurn(
377				maybePromiseWithAbort(
378					config.shouldStopAfterTurn?.({
...
392			if (shouldStopResult.value || shouldStopBeforeTurn()) {
393				await emit({ type: "agent_end", messages: newMessages });
394				return;
395			}
```

A run whose final assistant stop reason is `toolUse` ends with the same `turn_end` then `agent_end` sequence on at least four paths:

1. **An abort the adapter sent.** This is observable through `observeCommands`, and `probe:abort-tool` maps it to `mission.aborted`.
2. **A terminating tool** (`executedToolBatch.terminate`). The run stops by design, so it should be `completed`.
3. **`shouldStopAfterTurn` or `shouldStopBeforeTurn`.** Prime's own policy stops the run between turns. Whether that is `completed` or `aborted` depends on the policy.
4. **An abort from another party**, such as another RPC client of the same daemon session, or an internal cancellation. `signal.aborted` is true, but nothing on the wire says who aborted.

No event field separates paths 2 to 4 from each other, or from path 1 when the adapter did not send the abort. The research classifier (`classifyTerminal`, `research/prime-conformance/mission-trace.ts`) marks them `ambiguous`, and an offline test pins that.

### Completeness

- A port that emits no terminal event for these runs breaks the v0 promise that every started mission finishes.
- A port that picks a status would report a guess as a fact.
- A flag such as "maybe exact", or a separate qualified port, is excluded by the boundary's doctrine: presence of a port means exact semantics.

### PR #21 qualifications still open

These would also need closing before admission. They are documented in the conformance report.

- **Lane.** The lane is the adapter label `prime:root`, not a Prime concept.
- **IDs.** Run and turn IDs and the mission sequence are adapter counters. They are valid for one observation only and cannot be rebuilt after a restart or reconnect.
- **Resume and suspend.** `mission.resumed` and `mission.suspended` are never produced, because Prime's RPC has no suspended-run concept. Its post-abort input suspension is a different thing.
- **Model events.** `model.completed` fires for every assistant `message_end`, including errored and aborted ones.
- **Unknown events.** Unknown event types are kept by name and left unmapped.

## 8. Why nothing Prime is exposed upstream

The runtime-observation boundary (`docs/runtime-observation-boundary-v0.md`) states that implementing a port is a claim that the v0 contract holds exactly. Presentation and Cockpit rely on that claim. They render `mission.completed` as a finished mission, and a missing terminal as a mission still running.

A Prime Mission Trace source that is right only on the probed happy paths would make both renderings false for the runs in section 7. So this change:
- installs no port;
- adds no `RuntimeQualifiedMissionTraceSource` and no "maybe exact" flag;
- leaves `src/runtime-observation.ts`, the Chord contracts, Presentation, Cockpit and the Pi Session worker unchanged.

A later Prime semantic adapter builds on `PrimeRpcConnectionV0` and `readPrimeRuntimeIdentityV0` without changing the common layer. It implements a port only for a Prime profile whose semantics are shown to be exact, which could mean a Prime change that makes length and `toolUse` terminals explicit.

## Tests

`packages/endophasia/test/prime-runtime-ingress.test.ts` is fully offline. `test/fixtures/prime-ingress/fake-prime-rpc.mjs` plays Prime, with one mode per behaviour. The suite covers:
- **Framing:**
  - single and multiple records per chunk;
  - UTF-8 split at every byte;
  - U+2028 and U+2029;
  - CRLF and a lone CR;
  - a partial final record;
  - blank lines, malformed JSON, malformed UTF-8 and non-objects;
  - a large record over many chunks, and oversized records.
- **Differential framing:** the production decoder against the research decoder.
- **Correlation:**
  - duplicate, stale (after a timeout), unknown and missing response IDs;
  - commands that cannot be read or serialized, and `type` pinning;
  - an `error` on a successful response;
  - a bounded input backlog when Prime stops reading;
  - a wrong echoed command and malformed responses;
  - out-of-order responses, refusals and timeouts.
- **Events:**
  - events without response IDs;
  - response and event interleaving;
  - listener and diagnostic-sink failure isolation, including listener-set error names;
  - command observation order and unsubscribe.
- **Lifecycle:**
  - exit with a pending request;
  - records written before exit, including a final record without an LF;
  - a descendant holding stdout, with a check that the process group is gone;
  - Prime closing its stdin while still running;
  - idempotent close, SIGTERM and SIGKILL escalation (including a descendant that ignores SIGTERM after Prime exits), and spawn failure.
- **Hermeticity and privacy:**
  - environment hermeticity;
  - privacy sentinels absent from diagnostics and errors.
- **Identity:**
  - resolution precedence;
  - version parsing from stdout or stderr, and rejection of versioned paths and of output naming more than one version;
  - a bounded `--version` that ignores SIGTERM or leaves a descendant holding its output;
  - binary without a source commit;
  - a checkout's commit and clean, dirty or unknown tree, and never an enclosing repository's commit.
- **Import-graph guards.**

**Opt-in live smoke.** Set `ENDOPHASIA_PRIME_LIVE_SMOKE=1` together with `PRIME_AGENT_BIN` or `PRIME_AGENT_ROOT`. The smoke then:
1. reads the identity;
2. starts Prime in a disposable HOME, TMPDIR and agent directory, with an unreachable local model entry;
3. sends only `get_state`, so no prompt and no provider request is made;
4. runs `shutdown --force`.

It is skipped by default.
