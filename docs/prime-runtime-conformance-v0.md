# Prime Runtime Conformance v0

Research spike. It asks one question: can Prime Agent produce Endophasia's v0 observation contracts without semantic lies? The contracts are `MissionTraceEventV0`, `RuntimeMetricsV0`, `OperationOutcomeV0`, and `UsageLedgerRowV0` with the Usage observation semantics.

The code under `packages/endophasia/research/prime-conformance/` is experimental. It is not exported from `@endophasia/core`, not imported by the Presentation Client or browser code, not used by the Session worker, and is not a production adapter.

## Scope and versions

| Item | Value |
| --- | --- |
| Endophasia base | `main` at `f82e0020740d6b78621244703ee0ddb659c0877a` |
| Prime Agent | `PrimeIntellect-ai/prime-agent` `main` at `2d24ad4e6b2d1ee8e6919af6f108e980a14d550e`, version 0.9.6 |
| Boundary | `prime-agent --mode rpc`, JSONL over stdio |
| Probe | `prime-conformance-v0`, probe version 0.1.0 |
| Platform of the committed evidence | linux-x64, Node v22.22.2 |

Citations use two forms:

- `prime:<path>:<lines>` is Prime source or docs at the pinned commit.
- `probe:<scenario>` is a live scenario whose sanitized evidence is committed under `packages/endophasia/test/fixtures/prime/0.9.6/<scenario>.json`.

## Method

**Isolation.** Prime runs as a separate process. The monorepo has no Prime npm dependency, alias, override, vendored file or copied Prime type. The client parses a few structural JSON shapes and validates each field defensively (`protocol.ts`).

- **Executable.** The probe uses `PRIME_AGENT_BIN`, or `PRIME_AGENT_ROOT/prime-agent.sh` for a built source checkout. It never downloads Prime.
- **Environment.** Each scenario gets its own temporary directory: `HOME`, `TMPDIR` (which also holds Prime's daemon socket), XDG directories, the Prime agent directory, the session directory, the working directory and `models.json`. The child process receives only a minimal allowlisted environment, so no provider keys are inherited. `~/.prime` is never read or written. After each scenario the probe runs `prime-agent shutdown --force` and deletes the directory, unless `--retain` is passed.
- **Model.** A loopback fake of OpenAI Chat Completions on `127.0.0.1` is registered through Prime's documented `models.json` custom-provider seam. Nothing leaves loopback and no API credits are spent. Prices are chosen so every cost is exact: input ×1, output ×2, cache read ×0.5 and cache write ×0.25 per token.
- **Tool.** A probe extension tool, `probe_tool`, has three modes: ok, fail and hang. Prime's default `ipython` tool is disabled with `--tools probe_tool`.

**Framing.** `JsonlDecoderV0` does not use `readline`. Its rules:

- UTF-8 is decoded incrementally.
- Records split on LF only, with one trailing CR stripped.
- Partial bytes and text stay buffered between chunks.
- Each record must be exactly one JSON object.
- U+2028 and U+2029 are ordinary characters. `readline` would split valid JSON on them.

**Sanitization.** Events are reduced to identities, kinds, flags and numbers as they arrive. Raw transcripts are never kept.

- `message_update` deltas are dropped.
- Assistant messages keep the stop reason, usage and tool-call id and name only.
- Command errors become labels such as `queued-input-suspended`.
- Session-file entries keep type, id, parent, role, stop reason, usage and field names.

The fake provider plants these sentinels in every payload class: `PROMPT_SENTINEL`, `ASSISTANT_SENTINEL`, `REASONING_SENTINEL`, `TOOL_ARGS_SENTINEL`, `TOOL_RESULT_SENTINEL`, `ERROR_DETAIL_SENTINEL` and `SUMMARY_SENTINEL`. The report fails if any of them appears in the evidence, the candidate Mission Trace, the usage projection, the metrics projection or the report itself.

**Scenarios** (`probe.ts`):

| Scenario | What it does |
| --- | --- |
| `simple` | One prompt with known usage. |
| `tool-run` | A tool call, then an answer. |
| `tool-error` | The tool throws and the model recovers. |
| `provider-failure` | HTTP 400, with auto-retry off. |
| `abort-stream` | RPC abort while the assistant streams, then a new prompt. |
| `abort-tool` | RPC abort while the tool runs. |
| `length-stop` | The assistant stops at the output-length limit. |
| `reasoning-usage` | The provider reports `reasoning_tokens`. |
| `multi-turn-reopen` | Three prompts, then a new process reopens the file with `switch_session`. |
| `compaction` | Two prompts, a manual `compact`, then a new prompt. |
| `fork` | Two prompts, `fork` from the last user message, then a prompt on the fork. |
| `child-usage-replay` | A crafted session with one `child_usage_attributed` entry, reopened by real Prime. |

**Running it.**

- Live: `PRIME_AGENT_BIN=/path/to/prime-agent npm run check:prime-conformance` or `PRIME_AGENT_ROOT=/path/to/prime-agent npm run check:prime-conformance`. It writes `.artifacts/prime-conformance/report.json`, which is ignored by git.
- Refresh fixtures: add `--write-fixtures`.
- Drift: when the installed Prime's version or commit differs from the committed fixtures, the run prints `STALE` and sets `drift.stale`.
- Missing binary: the command exits 1 with a clear message.
- CI: the live probe is not part of CI. The offline tests in `packages/endophasia/test/prime-conformance.test.ts` need no Prime.

## Summary matrix

Two axes. **Support** says where the facts come from: `native`, `adapter-state` (the adapter must own state Prime does not provide) or `unavailable`. **Semantic fit** says whether the best truthful mapping means what the contract says: `exact`, `qualified` or `incompatible`.

| Contract | Support | Semantic fit | In one line |
| --- | --- | --- | --- |
| `MissionTraceEventV0` | adapter-state | qualified | Tool identities are native. Lane, run, turn and some terminal status are adapter-owned and last one observation. |
| `RuntimeMetricsV0` | adapter-state | qualified | `get_session_stats` is path-scoped and would lie. A rebuild from durable session files is truthful, with gaps. |
| `OperationOutcomeV0` | unavailable | incompatible | Prime has no operation identity and no result lookup. |
| `UsageLedgerRowV0` | adapter-state | qualified | Durable usage lives on session entries. There is no native sequence or cursor, and forks copy rows. |

No contract is `native` + `exact`. The report (`findings[]`) carries the evidence, adapter-owned state, qualifications and unavailable facts behind each row. The sections below explain them.

## Mission Trace

**Native evidence.**

- Prime's RPC events are `agent_start`/`agent_end`, `turn_start`/`turn_end`, `message_*` and `tool_execution_*`. None of them carries a run, turn, operation or lane identity (`prime:packages/coding-agent/docs/rpc.md:793-808`).
- `tool_execution_start`/`end` carry Prime's own `toolCallId`, `toolName` and `isError`, and they match the assistant's tool calls (`probe:tool-run`, where the ID is `call_probe_1`). `toolCallId`, `toolName` and `isError` are therefore native.
- Observed order within one run:
  1. `agent_start`, then `turn_start`.
  2. A `custom_message` that Prime injects, then the user message.
  3. The assistant `message_end`.
  4. `tool_execution_start` and `tool_execution_end`.
  5. The `toolResult` message, then `turn_end`.
  6. The next `turn_start`, and so on until `agent_end`.

**Adapter-owned state.**

- **`lane`.** Prime has no lane. An RPC process drives one root session, whose RLM children are separate sessions (see below). The candidate mapping writes the label `prime:root`. It deliberately does not reuse Pi's `"main"`: a Pi lane is a durable branch pointer inside one Session, and nothing in Prime has that meaning.
- **`runId`.** An adapter counter (`adapter:run-N`), opened at `agent_start` and closed at `agent_end`.
- **`turnId`.** `adapter:run-N/turn-K`, opened at each `turn_start`.
- **Lifetime of run and turn IDs.** Both are valid for one observation only. They do not survive a process restart, reconnect or reopen, because Prime's events carry nothing to rebuild them from. `probe:multi-turn-reopen` reopens the session but produces no run events for past runs.
- **Mission sequence.** An adapter counter that restarts per observation.
- **Abort requests.** The adapter must remember the aborts it sent itself (next point).
- **Identity checks.** Across all 12 fixtures, adapter IDs are unique, correlated (every turn nests in its run) and numbered without gaps (`checkAdapterIdentitiesV0`).

**Terminal status.** It is not taken from `agent_end`. Prime emits `agent_end` on normal completion, on error and abort stops, and after an abort that interrupts a tool batch (`prime:packages/agent/src/agent-loop.ts:345-436`). The mapping reads the final assistant stop reason instead:

| Scenario | Final stop reason | Candidate | Basis |
| --- | --- | --- | --- |
| `simple`, `tool-run` | `stop` | `mission.completed` | native stop reason |
| `tool-error` | `stop` (tool `isError: true`, then recovery) | `mission.completed` | native stop reason |
| `provider-failure` | `error` | `mission.failed` | native stop reason |
| `abort-stream` | `aborted` | `mission.aborted` | native stop reason |
| `abort-tool` | `toolUse` | `mission.aborted` | **adapter's own abort request** |
| `length-stop` | `length` | none | ambiguous |

Two runs cannot be classified from Prime's facts alone:

- **Abort during a tool (`abort-tool`).** Prime ends the run with stop reason `toolUse` and no final turn. The same events without the adapter's abort record classify as ambiguous; the offline test pins this.
- **Length stop.** The model did not finish, but nothing failed. The mapping emits no terminal kind rather than collapse this into `completed` or `failed`.

**Semantic gaps.**

- `mission.resumed` and `mission.suspended` are never emitted. Prime has no suspended-run concept in RPC.
- `model.completed` is emitted for every assistant `message_end`, including errored and aborted ones.
- After an abort, Prime suspends its input queue.
  - Source: `prime:packages/coding-agent/src/core/agent-session.ts:8199-8206`. Manual `compact` aborts first (`prime:…/agent-session.ts:8718-8725`).
  - A plain RPC `prompt` is then refused with "queued session input is suspended". Only a prompt with `streamingBehavior` resumes the queue (`prime:packages/coding-agent/src/modes/daemon/daemon-mode.ts:4628`).
  - Observed: `probe:abort-stream` (plain prompt refused, `followUp` admitted) and `probe:compaction` (the same).
  - Pi has no such state, so an adapter must know that "idle after an abort" is not "ready for input".
- Prime emits event types beyond its documented table. `refine_failed` appeared in `probe:compaction`. The mapping ignores unknown types; it does not guess.

## Runtime Metrics

**Native evidence.** `get_session_stats` sums assistant usage over `state.messages`, which is the current context path. It recomputes `tokens.total` as input + output + cacheRead + cacheWrite, and it reports a single `cost` total (`prime:packages/coding-agent/src/core/agent-session.ts:14776-14815`).

Field by field against `RuntimeMetricsV0`:

| `RuntimeMetricsV0` | `get_session_stats` | Fit |
| --- | --- | --- |
| scope: cumulative session accounting | current context path | **incompatible**: decreases after compaction and fork |
| `messageCount`: persisted `message` entries | `totalMessages`: messages on the current path | incompatible |
| `usage.input/output/cacheRead/cacheWrite` | `tokens.*` on the path | path-scoped |
| `usage.totalTokens`: sum of reported `totalTokens` | `tokens.total`: recomputed sum of components | different definition (equal only by construction in these runs) |
| `usage.cost.{input,output,cacheRead,cacheWrite}` | absent (total only) | unavailable natively |
| `usage.cost.total` | `cost` on the path | path-scoped |
| `usage.reasoning` | absent | unavailable |
| `usage.cacheWrite1h` | absent | unavailable |
| (not mapped) | `contextUsage` | a context-window estimate; deliberately not mapped |

Concrete trace:

- **Compaction (`probe:compaction`).** Before compaction, total 1218 and cost 1073.5. After, total 711 and cost 559.5, with `contextUsage` null. The two summarization calls cost 4480; that usage is persisted on the `compaction` entry (4000 input / 240 output) but never counted by stats.
- **Fork (`probe:fork`).** Before the fork, total 1218. After, total 507: stats follow the new path.
- **Reopen (`probe:multi-turn-reopen`).** Stats are identical after reopen: total 2131, cost 1799.5.
- **Failed and retried attempts.** They stay on the path at zero usage when not retried (`probe:provider-failure`, `probe:abort-stream`: the fake reported no usage for them). An auto-retried failure is removed from the path (`prime:…/agent-session.ts:13442-13444`), so its usage leaves stats. This comes from source only and was not exercised live.
- **Reasoning (`probe:reasoning-usage`).** The provider reported 70 reasoning tokens. Prime reports output 90 with no reasoning field: its openai-completions parser has none (`prime:packages/ai/src/providers/openai-completions.ts:1110`).
- **Child usage (`probe:child-usage-replay`).** Stats show input 1400 and cost 1540. The file's assistant row still says input 1000 and `totalTokens` 1050: child usage was folded in on reload. Folding keeps the parent's `totalTokens` at the parent's own context size (`prime:…/agent-session.ts:1507-1516`). Stats total 1470 is a recomputed number that no row reports.

**Adapter-owned state.** A truthful `RuntimeMetricsV0` needs:

- A cumulative sum the adapter rebuilds from durable session files: assistant usage as written in the file, `compaction`/`branch_summary` usage, and `child_usage_attributed` rows (`projection.ts`). `messageCount` is the count of persisted `message` entries.
- The file set of one logical session, because forks write new files.
- De-duplication by entry ID across that set, because a fork copies the path's entries into its new file with the same IDs (`probe:fork`: 7 shared).

On a single path with no summaries, the rebuild equals `get_session_stats` (`probe:multi-turn-reopen`). Across compaction it keeps the pre-compaction usage and adds the summary usage (`probe:compaction`).

**Semantic gaps.**

- The rebuild reads Prime's session-file format directly, outside the RPC boundary. The format is documented but it is still a second coupling.
- Caller adjustments do not exist in Prime.
- `reasoning` and `cacheWrite1h` are unavailable and must stay absent, not zero.
- Totals do decrease natively. The rebuild does not decrease under compaction or fork, but it would if Prime rewrote history (see Usage).

## Operation Outcome

**Native evidence.** None.

- The RPC command table has no operation identity, no result record and no lookup (`prime:packages/coding-agent/docs/rpc.md:225-256`).
- The `prompt` response acknowledges admission only. The outcome arrives later as events with no identity (`rpc.md:793-808`).
- Errors are free text on the assistant message. There is no machine-readable code.

**Adversarial lookup.** The probe asked: by what stable ID can a terminal result be found after completion, abort, detach and reopen? The answer is none.

- **Completion and abort.** The outcome is observable only as a live `agent_end` plus the final stop reason, and for `abort-tool` only together with the adapter's own abort record.
- **Detach.** A client that was not attached when `agent_end` fired has no way to learn the outcome.
- **Reopen.** Entry IDs are stable (`probe:multi-turn-reopen`) and the final assistant stop reason survives in the file. However, nothing links those entries to an operation, and the `toolUse`-after-abort case cannot be recovered at all.

**Minimal adapter state that would be needed.** Not built here:

- An adapter-assigned operation ID per `prompt`, correlated to the `agent_start`/`agent_end` pair it caused.
- A durable adapter record `{operationId, status, basis, fromTipId, tipId, startedAt, endedAt}`, written at `agent_end`, with the tip IDs taken from the session leaf before and after the run.
- The record is only as good as the adapter's attachment: an outcome that happens while detached is lost.

Classification: `unavailable` / `incompatible`. An adapter record would be an adapter's claim, not Prime's durable fact.

## Usage

**Native evidence.**

- Usage is durable on session-file entries:
  - assistant `message` entries;
  - `compaction` and `branch_summary` entries, which carry the summarization usage (`prime:packages/coding-agent/src/core/compaction/compaction.ts:108-116`);
  - `child_usage_attributed` entries, which carry `targetId`, `childUsage` and `aggregateUsage` (`prime:packages/coding-agent/docs/session-format.md:265-280`).
- Entry IDs are 8-hex and stable across reopen (`probe:multi-turn-reopen`).

**Adapter-owned state.**

- **Row `id`.** The entry ID. It names one durable row across a session's files only after de-duplication, since a fork copies entries with their IDs (`probe:fork`).
- **Row `sequence`.** The entry's 1-based line ordinal in the file, assigned by the adapter. It is not a Prime cursor. Prime rewrites the whole file atomically on format migration and session moves (`prime:packages/coding-agent/src/core/session-manager.ts:1812-1818,1917-1930`), so the ordinal is a stable cursor only while rewrites preserve order. The adapter must detect rewrites to re-validate it.
- **Paging.** The adapter reads the file itself. Prime has no usage scan.
- **Live observation.** The adapter watches `message_end` and `compaction_end` and re-reads the file for the durable row. Events carry no sequence.

**Semantic gaps.**

- **Rows are session entries, not Pi usage rows.** `adjustment` is always false, because Prime has no caller adjustments.
- **Child usage is mutated after persistence, in memory.** A later `child_usage_attributed` entry changes what Prime reports for an earlier assistant entry on reload (`probe:child-usage-replay`: file input 1000, replayed 1400). An adapter must read the file's original row and count the child row separately, never read the replayed message. Otherwise it would double count.
- **A child row names the wrong party.** Its `entryId` (Prime's `targetId`) is the parent assistant entry, not the child session that spent the tokens.
- **Absent counts.** No `reasoning` and no `cacheWrite1h`.
- **No fake cursor.** The report does not present the adapter's ordinal as a native cursor. `UsageLedgerRowV0` is unchanged.

## Session tree / future Continuity

Exploratory evidence only. This is not Continuity v1.

- **Tree structure.** A session is a JSONL tree of entries with `id`/`parentId` and a leaf. Every probe session starts with `model_change`, `thinking_level_change`, `service_tier_change`, `session_state` and `custom_message` before the first user message.
- **Fork.** A fork writes a **new file** with `parentSession`. It copies the path's entries into that file with their original IDs; the original file keeps its 10 entries (`probe:fork`). A Continuity model built on Prime would therefore treat entry IDs as file-scoped, or de-duplicate across a fork family.
- **Compaction.** Compaction appends a `compaction` entry with `firstKeptEntryId`. Older entries stay in the file (`probe:compaction`). Continuity can read the full history, but the model context is the compacted path.
- **Reopen.** `switch_session` restores 7 messages, identical stats and identical entry IDs (`probe:multi-turn-reopen`).
- **Rewrites.** Prime rewrites files wholesale on migration. Any byte-offset or line cursor needs rewrite detection.

## RLM implications

Observed from Prime docs and source. RLM child spawning was not exercised live, because it needs Prime's Python kernel, which is provisioned with `uv`.

- **Children are separate sessions.** `rlm.spawn` creates a normal child `AgentSession` with its own context and session directory (`prime:packages/coding-agent/docs/rlm.md:64-118`). Its handle carries `rlm_child_id`, `name`, `session_dir` and `model`.
- **Child events are not in the root stream.** A client must `observe` a child's `activeSessionId` and receives wrapped `observed_session_event` records, then `observed_session_closed` (`prime:packages/coding-agent/docs/rpc.md:241-256`). The probe did not exercise `observe`.
- **Identities.** A child is a session, not a lane or a run. Mapping children onto Mission Trace lanes would invent a structure Prime does not have. A future contract would need an explicit "child session" relation.
- **Child usage in root accounting.** Child usage is folded into the parent assistant's usage and persisted as `child_usage_attributed` (`probe:child-usage-replay`, `prime:…/agent-session.ts:1507-1516`). The entry names the parent assistant, not the child, so per-child attribution needs the child's own session file.

## Proposed minimum runtime boundary

Derived from the findings above. It is not implemented here. The shape is a small common core, explicit capabilities, and runtime-specific extensions. It is not a lowest-common-denominator flattening that hides the differences.

**Common core** (both runtimes provide it truthfully):

- Tool-call observation: `toolCallId`, `toolName`, `isError`, start and end.
- Assistant-message completion with a stop reason.
- Durable per-message usage with input, output, cacheRead, cacheWrite and cost components.

**Explicit capabilities** (declared per runtime; a consumer must check them before relying on the fact):

| Capability | Pi | Prime 0.9.6 |
| --- | --- | --- |
| `native-run-identity` (run and turn IDs, lanes) | yes | no: adapter-owned, per observation |
| `native-run-terminal-status` | yes | partial: stop reason, plus adapter abort record |
| `durable-operation-outcome` (lookup by ID) | yes | no |
| `durable-usage-sequence` (native cursor) | yes | no: adapter ordinal over files |
| `cumulative-session-accounting` | yes | no natively: adapter rebuild from files |
| `usage-reasoning`, `usage-cache-write-1h` | when reported | no |
| `caller-usage-adjustments` | yes | no |
| `run-suspension` (resumed/suspended) | yes | no |
| `post-abort-input-suspension` | no | yes: needs `streamingBehavior` to resume |
| `child-sessions` (RLM) | no | yes: separate sessions, observed via `observe` |

**Runtime-specific extensions.** These should not be squeezed into v0 fields:

- Prime: `child_usage_attributed` rows, fork-family files, the `refine_failed` event and other undocumented events, and the queue-suspension state.
- Pi: lanes, operation results and usage adjustments.

## What this spike deliberately does not prove

- It does not integrate Prime. There is no production adapter, runtime selector, Session-worker change, Presentation Client change or Standard Cockpit change, and no generic Runtime interface.
- It does not change any v0 schema. The candidate projections use the existing types unchanged.
- It does not prove behavior under real providers. All evidence comes from a loopback fake: real usage reports, streaming partial usage on abort, and provider retries may differ.
- RLM child spawning, `observe`, auto-retry, and `branch_summary` from tree navigation were not exercised live. The findings for them come from source and docs.
- It does not cover Prime versions other than 0.9.6 at `2d24ad4e`. Evidence goes stale when either differs, and the probe reports `STALE`.
- It does not verify that the durable adapter records proposed for Operation Outcome and Usage are sufficient under concurrent clients or daemon restarts.
- It does not implement Continuity, Work/Dream, Continual Harness, Reef, Magpie, Deadbolt or recursive subagent visualization.
