# Prime 0.9.7 RPC and ACP conformance research

No existing Endophasia v0 capability is exact on either observed boundary. There is no capability admission candidate for PR #27. RPC still permits qualified Mission Trace, Metrics and Usage projections; ACP adds useful producer correlation and terminal quiescence envelopes, but does not supply the missing Endophasia semantics. Durable session files remain a separate observation surface.

This document supplements [the historical 0.9.6 audit](prime-runtime-conformance-v0.md). Its 12 fixtures and original probe identity remain unchanged. The production observation contracts, Prime RPC ingress, Runtime Profile, Session worker, Presentation Client and Cockpit are unchanged.

## Coordinates and executable provenance

- Endophasia main/base: `08068242aa5e115ea947e996b88b11107eea9a0d`, the merge of PR #25. The isolated research branch is `research/prime-0.9.7-conformance`.
- Historical Prime source: `2d24ad4e6b2d1ee8e6919af6f108e980a14d550e`, version `0.9.6`, probe `0.13.0`.
- Audited Prime source/tag: [`08ff1b2e2794ea9e8f4a08d12bc95408a66e1074`](https://github.com/PrimeIntellect-ai/prime-agent/tree/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074), `v0.9.7`, [release dated 2026-09-28](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.9.7).
- Research probe: `prime-conformance-v0`, `0.14.6`; environment `linux-x64`, Node `v26.10.0`.
- Clean Endophasia instrument at capture: `cb83aa65586327b4cc0daff6d64915be0f5dfb48`; source SHA-256: `f4620578024ccd0565a45874eb251ea32894e9d073e28fe26e94dd0a34113820`.
- Actual launcher: the pinned checkout's `prime-agent.sh`, with no leading arguments; its default source CLI loads compiled workspace dependencies. Both `--mode rpc` and `--mode acp` use that same launcher/build.
- Fresh build output SHA-256 (`packages/*/dist`, sorted paths and bytes): `a25d17fdb3691f581521f7e9f1a7fb35d0ae1c7bd45d9a7b213156aee9bc85b6`.
- Launcher SHA-256: `0ceef94210da44aa2cb232fb18fd215c5a25caf7b652531856c5a90af01df09d`.
- Upstream lock SHA-256: `4c305464abcef869ad1f812835209fe9c7aed39dca42b724296c4f4ed1c9cd51`; resolved ACP SDK `@agentclientprotocol/sdk@1.3.0`.

Each scenario records its boundary, upstream commit, artifact/launcher/lock identities, probe version, environment, `endophasiaCommit`, `endophasiaBuild=clean-checkout` and `researchHash`. The instrument must be committed and clean (tracked changes and nonignored untracked files are refused) before and after the complete experiment. Both complete identities must match before any diagnostic or reference write. `researchHash` covers sorted repository-relative names and bytes of **all tracked executable source** (`ts`, `mts`, `cts`, `js`, `mjs`, `cjs`, `tsx`, `jsx`), including the transitive process-group keeper. There is no hand-maintained dependency list. An offline test compares it with the published source.

The live instrument runs direct tracked TypeScript plus Node builtins. A transitive static-module guard, after erasing type-only edges, refuses untracked/generated/linked modules, external imports and computed import loaders; injected Node flags or `NODE_OPTIONS` are refused. Endophasia's ignored `dist` and installed package code are not instrument inputs. The probe-tool source emitted into each temporary Prime environment is a tracked string in `environment.ts`, covered by the instrument hash; its `typebox` dependency is part of the pinned Prime subject. Prime's ignored compiled workspace output remains separately hashed and freshly rebuilt. These coordinates establish a bounded measuring instrument, not a cryptographic build attestation or production composition.

Prime was cloned at the exact tag and verified against the commit through GitHub. Dependencies were installed from its lock with lifecycle scripts disabled. The source was built with the installed compiler, then assets and the bundle were generated:

```sh
npm ci --ignore-scripts
./node_modules/.bin/tsgo -p packages/tui/tsconfig.build.json
./node_modules/.bin/tsgo -p packages/ai/tsconfig.build.json
./node_modules/.bin/tsgo -p packages/agent/tsconfig.build.json
./node_modules/.bin/tsgo -p packages/coding-agent/tsconfig.build.json
npm run copy-assets --workspace=@earendil-works/pi-coding-agent
npm run bundle --workspace=@earendil-works/pi-coding-agent
```

The upstream tracked checkout remained clean. Source, launcher, ignored output, lock and research identity are described before and after the complete live run. A changed identity invalidates publication.

## Source delta from the audited 0.9.6 commit

The complete upstream diff is 54 files, 301 insertions and 1,030 deletions. ACP was already present at the old audited commit; it is a newly measured boundary in this research, not a newly introduced 0.9.7 feature.

| Audited surface | Change at 0.9.7 | Consequence for this audit |
| --- | --- | --- |
| Agent loop; session stats/accounting; ACP event mapper, mode and stop-reason mapper | No diff between the two exact commits | Re-read the 0.9.7 definitions and exercised them; old conclusions were not inferred from version alone |
| ACP autonomous metadata interface | Unused `limitReason` declaration removed | Do not fabricate or retain a wire `limitReason`; infer no gate success from a prompt result |
| Session manager | Unused recent-session helpers removed | Later file/rewrite/fork citations shift by 24 lines; identities/context assembly remain as inspected |
| Daemon command recognition | Worker command table centralized in the protocol module | Re-run actual daemon-backed entrypoints; no evidence that this introduces Endophasia operation identity |
| RLM runtime construction/activity | Shared runtime specification and activity handling changed | Seeded child attribution replay checks durable accounting only; live RLM spawn, worker recovery, restart and concurrent attribution remain unverified |
| Harness management and SDK cleanup | CRUD reversion and internal API cleanup | No inference of new durable outcomes, global Usage allocator or exact Continuity |

Relevant exact source references below all use `08ff1b2e2794ea9e8f4a08d12bc95408a66e1074`.

## Experiment and retained evidence

Every scenario gets fresh HOME, TMPDIR, XDG directories, agent configuration, session directory, working directory and daemon socket space. Provider secrets are absent from the child environment. The deterministic OpenAI-compatible fake listens only on `127.0.0.1`; the only model/provider is `probe-local/probe-model`, with scripted usage and exact arithmetic-friendly prices. There are no real model calls or API credits. Prime's offline flags disable catalog/version/tool network activity. Automatic compaction and harness refinement are disabled. ACP provider failure additionally disables retry to isolate one rejected attempt.

Only the harmless `probe_tool` extension is loaded. Its scripted successful, failing and cancellable actions use no Python kernel. The bounded quality gate executes the constant shell command `false` inside the disposable environment. Per-scenario process groups, time-bounded requests, stream draining, isolated daemon shutdown and cleanup constrain subprocess lifetime. Durable files are confined to the disposable session directory and decoded through the existing hardened file reader.

RPC keeps the existing decoder, invariants, fake provider, file reader, mission mapping and accounting projections. ACP has an independent JSON-RPC client and decoder. It imports the generic process-group keeper for cleanup; it does not route requests or classify events through production RPC ingress.

| RPC scenario | ACP counterpart | Decisive question |
| --- | --- | --- |
| simple | simple | Completion and prompt response boundaries |
| tool-run / tool-error | tool-run / tool-error | Native tool identity, recovery after an error |
| provider-failure | provider-failure | Model failure versus successful prompt response |
| abort-stream / abort-tool | cancel-stream / cancel-tool | Local cancellation witness and terminal ambiguity |
| length-stop | length-stop | Model output exhaustion versus success |
| reasoning-usage | reasoning-usage | Reasoning chunks versus reported accounting dimensions |
| multi-turn-reopen | multi-prompt / close-recreate | Reopen durability versus ACP slot replacement |
| compaction | compaction | Context truncation, summary accounting and metadata |
| fork | No ACP fork/load capability | Copied entry identities and session-file lineage |
| child-usage-replay | No live child spawn | Attribution replay, not child execution certification |
| No additional RPC limit experiment | token-limit / turn-limit / gate-failure | Autonomous counters, transport stops and gate failure |
| Existing RPC command checks | unsupported-requests | Occupied session slot, unsupported load and wrong session |

The new reference contains 12 RPC and 15 ACP scenario fixtures plus the generated comparison report in `test/fixtures/prime/0.9.7/`. Prompts, answers, reasoning, tool inputs/outputs, errors, summaries, raw ACP updates and raw transcripts are never committed. Evidence retains safe identities, numbers, closed discriminators, booleans and field-name sets. Unknown metadata values are dropped. Summary and gate-failure text become presence flags. Sentinel scanning covers evidence, report and derived projections before persistence. Defensive schema checks reject unapproved payload slots even when no sentinel is present.

The joint publication gate extends the existing RPC gate and is the only 0.9.7 writer. It rejects missing/duplicate scenarios, invalid structure, correlation contradictions, process/protocol failures, privacy violations, dirty/unverified/wrong revisions, cross-boundary build mismatches and probe/environment/research mismatches. Partial 0.9.7 refreshes are refused. Full refreshes sync and atomically exchange the complete directory on Linux, refusing unsupported exchanges without a copy fallback. The old reference remains at the staging path until cleanup; interruption never removes the visible target. The legacy RPC writer refuses 0.9.7. Structurally valid changed stop reasons or accounting values remain drift evidence; they are not coerced back to the old result.

Probe 0.14.1 remediates the seven Codex findings with explicit attacks in `prime-097-remediation.test.ts` and the committed-fixture/transport suites:

| Finding | Hardened boundary and regression witness |
| --- | --- |
| P1 diagnostic privacy | Dedicated RPC/ACP closed-shape plus sentinel checks run before any directory/write. Non-sentinel private fields and sentinel attacks leave no artifacts; a closed-schema failed provider-witness invariant still produces sanitized diagnostics, but cannot publish. ACP shape validation is separate from scenario semantics. |
| P1 measuring instrument | Clean Endophasia identity is required before/after all 27 scenarios; repository-wide source hashing includes transitive code. A process-group edit keeps HEAD but changes the hash and fails the clean gate. A clean tracked checkout importing ignored generated code fails the module guard. Old 0.14.0 provenance is unpublishable. |
| P2 cancellation witness | Exactly one successful local writer callback records `session/cancel`, session UUID and trigger index; this is no remote acknowledgement. Missing, duplicate, failed and cross-trigger/session sends fail. Noncancel scenarios require zero sends. |
| P2 prompt identity | Every retained prompt-associated update must name a positive in-range turn in its ACP slot. Message, tool start and tool completion mutations to zero/unknown positive turns fail. Session-level metadata is not promoted to correlated prompt evidence. |
| P2 summary accounting | Assistant and summary Usage share one exact comparator over five token fields, five cost fields and empty `extraKeys`; summary accounting scales by `summaryRequests`. Every field mutation/omission and wrong request multiplier fails equality. Structurally valid number drift remains inspectable. |
| P2 capability dependencies | Durable Usage disagreement contradicts Metrics and Usage only. A Usage-only mutation leaves the other four capabilities' bases and compatibility unchanged. |
| P2 offline canonicalization | Joint report construction orders RPC by its declared invariant scenario list and ACP by `ACP_SCENARIOS`. Reversed inputs and fixture creation order produce the same report; the actual offline command reproduces committed `report.json` byte-for-byte with normal LF formatting. Historical baseline ordering remains unchanged. |

The entire 0.14.0 reference was replaced by a fresh 0.14.1 live run after offline hostile checks passed. No old fixture was retagged. Test-only synthetic controls let those mutation checks run before refresh; they are never written as audited reference evidence.

Probe 0.14.2 addresses the eight additional findings from the review of `326b38ece8`, with explicit mutations in `prime-097-review2.test.ts`:

| Finding | Hardened boundary and regression witness |
| --- | --- |
| P1 audited artifact identity | The 0.9.7 profile pins exact artifact, launcher and lock hashes. Uniform forged hashes across all 27 scenarios withdraw audited classifications and refuse publication. Historical 0.9.6 coordinates are unchanged. |
| P1 approved scalar/list slots | Every retained string has a finite approved vocabulary or an identity grammar; descriptions must equal the declared scenario description. All string and list-string slots, including initially empty diagnostic/Usage/meta lists and arbitrary flag keys, reject non-sentinel private text before any write. Raw RPC failures/protocol diagnostics are reduced to closed categories; unknown new names require schema review. Numeric drift and safe scenario failures remain inspectable. |
| P2 session/prompt command witnesses | Successful session creation records the returned UUID. Every prompt command records its requested slot and local ordinal; close records the requested slot. The complete ordered serial request transcript must match initialization, creation/recreation, recorded prompt results and close. Missing, duplicate, swapped-slot, wrong-ordinal and wrong-response mutations fail. |
| P2 unsupported request coverage | The ordered rejected requests must be occupied `session/new/-32603`, current-slot `session/load/-32601`, and unknown-slot `session/prompt/-32603`. Method, code, slot, missing and duplicate mutations fail. |
| P2 initialize consistency | All scenarios must agree on the complete sanitized initializer, independent of inventory/map ordering. A later changed advertisement invalidates the joint set; the report retains every scenario's initializer and omits a global initializer on disagreement. Consistent changed booleans remain inspectable and do not admit capabilities. |
| P2 bilateral metadata | Every retained mandatory/optional metadata field must be present in `metaKeys`, and every recorded known metadata key must have its corresponding value. Missing keys, missing values and invented optional keys fail for outcome, terminal promise, autonomy, quiescence and compaction. |
| P3 requirement version | The current audited requirement derives its probe text from `PROBE_VERSION`; a withdrawn audit names the actual current version. Historical requirement semantics remain unchanged. |
| P2 indivisible report publication | A complete valid historical baseline is mandatory and assessed before creating a directory. Missing, empty, partial and private-content baselines refuse publication on both fresh and existing references; the existing report and fixture set remain in place. |

The complete 0.14.1 set was replaced by a fresh 0.14.2 measurement after the offline attacks passed. No old fixture was retagged. The audited subject hashes are exact accepted build coordinates, not an assertion that hashes alone prove how a build was produced.

Probe 0.14.3 addresses the five findings from review `5361742756` of `b86f0f557d`, with explicit hostile regressions in `prime-097-review3.test.ts`:

| Finding | Hardened boundary and regression witness |
| --- | --- |
| P1 audited instrument hash | The audited profile pins the exact repository-wide `researchHash` in tracked `audited-instrument-097.json`. Uniform replacement by another 64-hex hash withdraws both boundary classifications and refuses publication. The registry is nonexecutable audit data, outside the executable-source hash to avoid a self-reference; the clean capture commit binds its bytes. Registry shape/version/hash and real path are checked. |
| P2 complete provenance | The pre-persistence RPC/ACP shape gates require every mandatory provenance field as an own nonempty string and exact source/generator/boundary. Uniform deletion, empty strings and nonstrings for all nine required fields refuse diagnostics and publication before filesystem mutation. A successful whole-set publication reloads both fixture readers and reproduces its report. Optional build coordinates remain separate from safe diagnostic shape. |
| P2 update inventory | Every retained ACP update requires `sessionUpdate` and `_meta`; text/thought chunks require `content`. Tool identity, kind, status and message identity agree with their wire keys in both directions. Empty inventories, individual omissions, duplicate keys and retained-value deletion fail. Payload-only fields remain names without payload values. Safe semantic inventory failures can still produce diagnostics. |
| P2 initializer inventory | Each initializer requires name/version and the Prime namespace, unique inventories, a visited field for every boolean, and visited nonboolean ancestor groups for every nested field. Uniform deletion/contradiction across all scenarios fails independently of cross-scenario agreement. Legitimate empty groups and consistent changed booleans remain observations. |
| P2 bounded ACP drain | After process exit/release, stdout has a two-second drain grace. Expiry records a protocol failure, stops decoding and destroys the reader; close settles idempotently. A real detached descendant holding inherited stdout survives group release and exercises the deadline, with test-owned PID cleanup. Existing fragmented/final-record tests still drain cleanly. The resulting normalized protocol failure invalidates the joint gate. |

All 12 RPC and 15 ACP fixtures were remeasured under committed clean 0.14.3 after the offline attacks passed. The full set/report was replaced with exception rollback; crash atomicity was hardened in 0.14.5. No 0.14.2 fixture was retagged. The previous 0.14.1 and 0.14.2 remediations above remain covered.

Probe 0.14.4 addresses the two findings from review `5362070523` of `7fcfcb5110`, with 64 hostile/control cases in `prime-097-review4.test.ts`:

| Finding | Hardened boundary and regression witness |
| --- | --- |
| P1 diagnostic baseline privacy | The dedicated pre-persistence gate checks historical baseline RPC privacy shape and includes baseline in sentinel scanning before report construction or any filesystem mutation. Non-sentinel private text in every captured baseline string/list-string slot, provider stop reasons, unapproved fields and initially empty diagnostic lists is refused. Sentinel-bearing baseline is refused too. Existing diagnostic bytes remain unchanged. Structurally safe baseline/current semantic failures still produce sanitized diagnostics; no semantic publication gate is substituted for privacy validation. Historical fixtures are unchanged. |
| P2 duplicate metadata inventory | Every ACP update's `metaKeys` must be unique, matching the decoder's `Object.keys` inventory. Duplicating each observed metadata field, including uniform mutations across scenarios, invalidates the joint assessment and refuses publication. Unique inventories in reversed order remain valid. No report-side deduplication is treated as validation. |

All 27 scenarios were remeasured under clean committed 0.14.4 after the offline mutation/gate suites passed. The complete 0.9.7 fixtures/report were replaced with exception rollback; crash atomicity was hardened in 0.14.5. No 0.14.3 fixture was retagged. Every earlier remediation remains covered.

Probe 0.14.5 addresses all five findings from review `5376872017` of `7b31a90c2`, with 74 hostile/control cases in `prime-097-review5.test.ts`:

| Finding | Hardened boundary and regression witness |
| --- | --- |
| P1 custom serializers | Before reading evidence values, inspect every container's prototype and own descriptors. Reject custom/inherited/hidden serializers, accessors, proxies, symbols, hidden properties, sparse/custom arrays and nonplain objects. All three input sets (including baseline) are checked before report construction or any write. Fifty serializer/getter/proxy/symbol attacks execute no caller code and create no output; the reported `failures.toJSON` attack also preserves existing diagnostic/reference bytes. Safe semantic failures remain diagnostic material. |
| P1 exact capture commit | The audited profile requires exact `endophasiaCommit` equality as well as clean state and exact research/subject hashes. Uniform zero, unrelated and base commits withdraw all boundary bases and refuse publication despite matching hashes. Capture is sealed after measurement in a nonexecutable data-only descendant; no scenario/provenance value is retagged and no executable source changes after capture. |
| P2 durable entry inventories | The shared durable validator requires unique outer wire keys for type/id, nonheader parentId, message envelopes, compaction retention, summary usage and retained child accounting/target fields. Summary usage key/value agreement is bilateral. Clearing every ACP inventory, duplicate keys, individual omissions and deleted summary usage invalidate evidence. Nested assistant role/usage belong to the outer message envelope. Unique reversed inventories remain valid; payload values remain absent. |
| P2 crash-atomic reference | Sync complete staged files/directories, replace an existing reference through one Linux atomic directory exchange (`/usr/bin/mv --exchange --no-copy --no-target-directory`), then sync the parent. Unsupported exchanges fail closed; no remove-then-install or copy fallback. Real SIGKILL witnesses before/after exchange leave a complete visible target; a concurrent reader sees no absent/partial report. The crash witness freezes a regressed two-rename writer immediately after removing the old target, so that mutation fails deterministically. GNU coreutils 9.12 was exercised. Readers opening multiple pathnames must avoid concurrent publication or hold a directory snapshot; atomic replacement is not a transaction across independent opens. |
| P1 linked subject build roots | Check the checkout real path and `lstat` packages, package ancestors, dist roots and nested directories before traversal. Identical bytes behind linked checkout/packages/package/dist/nested/file paths or a dangling dist link are unverifiable. The unchanged plain build still yields its pinned artifact hash. |

Each of the five source guards was temporarily removed or replaced with the vulnerable behavior. Its targeted regression failed, including the original hash traversal and two-rename crash gap; the exact working source was restored before freeze. All 612 pre-live tests passed before the complete 27-scenario capture. The strict capture pin intentionally withheld publication during the first diagnostic capture; sealing the observed commit in audit data made the untouched full capture pass the joint gate. No 0.14.4 fixture was retagged.

Probe 0.14.6 addresses all four P2 findings from review `5377775683` of `cbb56e88c5`, with 106 hostile/control cases in `prime-097-review6.test.ts`:

| Finding | Hardened boundary and regression witness |
| --- | --- |
| Unretained outer accounting | A shared type-specific accounting-key check runs before the live decoder reduces any entry, including session headers, and again on persisted key inventories. Only compaction/branch-summary outer usage and child-attribution child/aggregate usage are retained; assistant usage is nested in the message envelope. Other outer usage/cost/child keys fail instead of disappearing. Sanitized accounting values must also have a decoded source. RPC/ACP session/message inventory attacks and all known entry types plus an unknown type carrying non-sentinel private accounting values exercise both boundaries. |
| Complete ACP accounting | Usage equality examines every retained usage, childUsage and aggregateUsage source, in addition to exact assistant and compaction values/counts. Extra valid branch-summary or child-attribution rows make providerUsageDecodedExactly false. They remain observed accounting drift, with Metrics/Usage durable bases contradicted and all four unrelated bases unchanged. A fabricated user-usage slot is invalid decoder evidence. |
| Durable prompt roles | Each declared marker requires its ordered user/assistant roles, plus tool results and follow-up assistants where the scenario exercises them. /compact is a command without a user message; close-recreate must retain both exchanges in the one observed durable file. Deleting each of the 39 message rows and repairing its descendants' parent links still invalidates the scenario; reordered roles fail tool, multi-prompt, close-recreate and compaction witnesses. Numeric or transport-stop drift is not coerced to the prior result. |
| Required RPC description | The pre-persistence shape gate requires an own string description; the existing closed-domain check also requires the declared scenario description. Deleted, undefined, null and numeric descriptions invalidate evidence, create no diagnostic/reference directory, and cannot publish a fixture the reader cannot reload. Existing whole-set publication/reload and exact offline regeneration remain covered. |

The original four attacks were reproduced under the reviewed checker: 88 of the initial 90 regression cases failed. The final expanded suite has 106 passing cases. Temporarily removing each of the five guards (shared accounting, live decoder, ACP usage coverage, role sequence and description) caused its targeted regression to fail; exact source was restored before measurement. All 718 pre-live offline checks passed before the new complete capture. The capture seal and publication consume unchanged measured evidence; no 0.14.5 fixture is retagged.

## ACP protocol, initialization and identity

The pinned SDK defines JSON-RPC 2.0 messages over newline-delimited JSON. Initialize reports protocol version `1`, agent `prime-agent`, version `0.9.7`; `agentInfo` has `name`, `title`, `version`. Observed capability booleans are `loadSession=false`, image/embedded-context prompts enabled and HTTP MCP enabled; `sessionCapabilities.close` is present. The initialize `_meta` has namespace `ai.primeintellect.prime-agent` with **no capability-group keys**. Advertised ACP features do not set any Endophasia conformance result. This probe tests text prompts, not multimodal or MCP implementation.

See [initialize and session/new, lines 736–906](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/modes/acp/acp-mode.ts#L736), [upstream dependency lock](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/package-lock.json) and [SDK dependency declaration](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/package.json).

The actual default CLI path connects to a daemon-owned runtime before entering either RPC or ACP ([main.ts, lines 1585–1624](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/main.ts#L1585)). This experiment measures those entrypoints, not a constructed in-process session.

ACP session IDs identify the single client slot. In `close-recreate`, two different ACP UUIDs, prompt counter resets and producer sequence resets accompany **one durable file containing both exchanges**. `session/new` allocates a UUID and attaches to the existing connection; it does not create a new durable runtime Session. Thus neither ACP UUID nor `promptTurnId` is an Endophasia operation ID. Source comments call `eventSequence` connection-wide, but the producer is constructed per new slot and the live witness shows it restarting within the same process. Its scope is the producer/slot, not a durable session-global Usage cursor. The relevant producer code is [acp-mode.ts, lines 186–337](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/modes/acp/acp-mode.ts#L186); metadata declarations are [acp-meta.ts, lines 86–123](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/modes/acp/acp-meta.ts#L86).

`session/load` returns JSON-RPC `-32601`. A second slot creation while the first slot is occupied and a prompt for an unknown slot return `-32603`. These are observed request errors, not Endophasia declined operation records. No history/tail/page API is exposed by these ACP operations.

## Delta table

| Surface | 0.9.6 RPC | 0.9.7 RPC | 0.9.7 ACP | Reason for change |
| --- | --- | --- | --- | --- |
| Mission Trace | Qualified local mapping | Same qualified mapping | Qualified fragment; full trace unavailable | ACP carries prompt/producer correlation, but drops model/turn completion and resume/suspend |
| Provider failure | Assistant stop `error` | Same | Prompt request error `-32603`; outcome `error` envelopes | ACP scans newly added assistant failures |
| Stream cancellation | Native assistant `aborted` | Same | Prompt `cancelled`; early path has no terminal envelope | Transport cancellation and Endophasia mission termination are different observations |
| Tool cancellation | Final assistant `toolUse`; local abort witness needed | Same | Tool update `failed`, prompt `cancelled`; no terminal envelope | ACP names the transport cancel, not a durable outcome |
| Model output length | `length`; no truthful completed/failed mapping | Same | `end_turn` | ACP mapper consults autonomous limits, not the model's stop reason |
| Autonomous exhaustion | Not a separate old fixture | Not conflated with model length | Token cap → `max_tokens`; turn cap → `max_turn_requests` | Separately induced deterministic limits |
| Failing quality gate | Not audited by old fixtures | No new RPC claim | `hasGateFailure=true`, yet result/quiescence outcome `result` | Stop/quiescence does not certify task success |
| Runtime Metrics | Qualified durable reconstruction; stats incompatible | Same | Native totals unavailable; durable material separate | No cumulative metric service is introduced |
| Operation Outcome | Unavailable/incompatible | Same | Unavailable/incompatible | No immutable durable operation registry |
| Usage | Qualified file projection | Same | Wire unavailable; file projection separately qualified | ACP producer sequence is not a ledger allocator |
| Session Overview | Previously outside the four-port conformance scope | Incompatible with exact per-lane snapshot | Incompatible | Added research comparison, no new port |
| Continuity | Previously outside that scope | Incompatible with exact Pi context semantics | Incompatible | Similar durable tree is not Pi's source-entry window |

## Capability and field matrix

`qualified` describes an exercised partial mapping; it is not an exact implementation candidate. `unavailable/incompatible` describes missing or conflicting facts. `unverified` marks algorithms or scenarios this work did not prove. Endophasia source definitions remain the authority.

| Existing capability | RPC boundary | ACP boundary | Durable material / adapter state | Final result |
| --- | --- | --- | --- | --- |
| Session Overview v0 | Root session state/configuration and streaming flags; no exact lane operation snapshot | One attached slot, configuration options, prompt/producer metadata; no lane inventory | Tree tips/settings exist separately; atomic operation/model capture algorithm unverified | Incompatible |
| Mission Trace v0 | Native tool IDs and turn/model events; adapter run/turn/lane/sequence labels; ambiguous stops | Chunk/tool fragments and causal response/quiescence envelopes; incomplete lifecycle | A local worker-lifetime allocator is possible, but complete truthful lifecycle must be proved | Qualified fragments; no exact trace |
| Runtime Metrics v0 | `get_session_stats` sums current context messages | No native cumulative metrics | File rebuild exercised on bounded examples; retries/adjustments/fork-wide accounting incomplete | Qualified reconstruction; native stats incompatible |
| Operation Outcome v0 | No immutable durable operation lookup | No such lookup; prompt result is transport response | A new durable adapter registry would require an algorithm and hostile tests | Unavailable/incompatible |
| Usage v0 | No native exclusive-page/live ledger API | No such API or session-global sequence | Ordinal-based projection lacks allocation durability, signed adjustments and handoff proof | Qualified file material; exact unverified |
| Continuity v0 | Context/tree data have different assembly semantics | No source-entry continuity capture | Durable ancestry exists; exact Pi retained-tail context/settings/sequence projection unproved | Incompatible with current contract |

### Session Overview v0

The [current contract](../packages/endophasia/src/session-overview.ts) requires `schemaVersion`, `consistency=per-lane`, sorted lane `name`/`tipId`, nullable atomic operation with `operationId`, run/compaction/navigation `kind`, `status`, `startedAt` and optional captured model, plus lane/active/aborting counts. Captured model is the open request's model, not merely the configured model. Absence of an optional captured model is not by itself a blocker.

Prime root/child sessions are not Pi lanes. RPC `get_state` and ACP configuration options cannot be joined with separate flags into an atomic open-operation snapshot. ACP subagent telemetry does not provide a complete lane operation topology. Durable ancestry can identify a tip, but does not establish this live atomicity. No source field is admitted by renaming `sessionId` or `promptTurnId`.

### Mission Trace v0

RPC re-exercises native tool identity, recovered tool error, provider failure, stream/tool abort, output length and post-abort/compaction admission. The old mapper retains its original qualification: tool abort ends in assistant `toolUse`, so only the adapter's local abort request permits `mission.aborted`; `length` produces no guessed terminal. Plain RPC prompts after abort/compaction are refused, while explicit follow-up semantics resume queue admission.

The loop emits the same `agent_end` kind after errors, abort, stop-before/after-turn, terminating tool batches and ordinary completion. A terminating batch requires all finalized tool results to have `terminate=true`; the wire end marker does not encode that cause. These hook/termination paths were re-read, not newly certified by a live custom terminating tool scenario. See [agent-loop.ts, lines 310–449](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/agent/src/agent-loop.ts#L310), [termination predicate, lines 751–756](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/agent/src/agent-loop.ts#L751), [abort queue handling, lines 8199–8206](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/agent-session.ts#L8199), and [daemon prompt admission, lines 4465–4553](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/modes/daemon/daemon-mode.ts#L4465).

ACP maps assistant text/reasoning deltas, native tool starts and terminal statuses. It deliberately drops `message_end` and turn events, so chunk completion does not prove `model.completed`; a chunk does not carry final usage or final assistant stop reason. Its assistant message IDs are synthetic mapper counters. [acp-events.ts, lines 147–323](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/modes/acp/acp-events.ts#L147) defines those projections.

`responseBoundary` and `terminalQuiescence` have producer correlation and result/error outcomes, useful facts within their scope. Early cancellation can return `cancelled` before those envelopes. Provider failure yields an error response, while a model `length` stop yields `end_turn`. The explicit autonomous token and turn caps yield their corresponding ACP transport stops. A failing gate can end in `max_turn_requests` with `outcome=result`, zero outstanding children and three unused continuation slots. Quiescence does not mean the goal succeeded; remaining slots are capacity, not outstanding work. See [prompt handler, lines 961–1120](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/modes/acp/acp-mode.ts#L961), [stop mapper, lines 1–29](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/modes/acp/acp-stop-reason.ts#L1), and [autonomous limit selection, lines 417–435](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/autonomous.ts#L417).

The missing exact invariant is a complete truthful worker-lifetime trace: started/resumed/suspended, turn start/finish, model completion, tool start/finish and mission completed/aborted/failed with correlated identities and sequence. Local lifetime counters are not inherently disallowed by that contract; this research does not reject them merely for resetting on restart. It rejects the missing lifecycle and ambiguous termination facts. Neither ACP transport stops nor `agent_end` fill those gaps.

### Runtime Metrics v0

The [metrics contract](../packages/endophasia/src/runtime-facts-service.ts) requires session-wide persisted message count, cumulative input/output/cacheRead/cacheWrite/reported-total usage, component and total cost, optional reported reasoning/cacheWrite1h, failed/retried/aborted attempts and signed caller adjustments. It is not context occupancy or a provider invoice.

The new RPC fixtures establish the same accounting facts: current stats decrease after compaction and fork, omit summary spend and recompute totals. Reopen preserves the bounded fixture's stable accounting and entry identities. Seeded child attribution folds parent/child component usage into stats but retains parent-reported total: stats total `1470` versus persisted aggregate `totalTokens=1050`. Optional reasoning and cacheWrite1h remain absent, never fabricated as zero. A reasoning chunk is not a numeric reasoning token account.

See [getSessionStats, lines 14776–14824](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/agent-session.ts#L14776), [child usage addition, lines 1507–1516](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/agent-session.ts#L1507), [retry message removal, lines 13434–13444](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/agent-session.ts#L13434), and [summary usage persistence, lines 829–866](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/compaction/compaction.ts#L829).

ACP has no cumulative metric read; autonomous `tokensUsed` is a limit counter, not this service. Separately read ACP-created files preserve the fake's scripted assistant and compaction usage. File material supports bounded reconstruction, but failed/retried billing, every branch/fork/session scope, concurrent child folding, rewrite reconciliation and signed adjustments remain unproved. Counting all old-file messages blindly after fork can double-count copied entries. Thus the full capability is not exact.

### Operation Outcome v0

Every [existing outcome field](../packages/endophasia/src/runtime-facts-service.ts) matters: operation identity, run/compaction/navigation kind, completed/declined/aborted/failed status, from/current tips, start/end timestamps and optional machine error code. The source is an immutable terminal lookup, with `null` only where no durable result is returned at the read; it must survive reopen.

Neither boundary exposes that registry. An ACP request ID or prompt counter is transport-local, and ACP `result/error` omits declined/aborted operation kinds and durable tips/times. Durable messages, compactions and session-state records do not become immutable operation results. A stateful adapter could create its own durable registry only with a new proved identity/persistence algorithm; none is implemented or certified here.

### Usage v0

The [Usage contract](../packages/endophasia/src/usage-service.ts) requires stable row/entry identity and ancestry, role/model/API/stop facts where applicable, usage and adjustment semantics, a committed session-global sequence shared with entries/values, exclusive `after`/`before` cursors, bounded limit, exact `hasEarlier`, tail and race-free snapshot-to-live subscription. Sequence gaps are normal; row ordinal is not the allocator.

The RPC projection still numbers the observed file order. Pure reopen preserves tested entry IDs; fork copies seven entry IDs byte-for-byte to a new header linked to its parent file. That establishes lineage, not globally stable row allocation. Child attribution changes earlier assistant accounting while also appending attribution material. Whole-file rewrites invalidate naive append-only assumptions; signed adjustments, concurrent attribution, process restarts and exclusive live handoff are not established. [Session rewrite, lines 1893–1911](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/session-manager.ts#L1893), [child attribution, lines 2152–2195](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/session-manager.ts#L2152), and [fork construction, lines 2544–2615](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/session-manager.ts#L2544) bound these claims.

ACP has no Usage pages/tail/feed. Its producer sequence counts notifications, resets on slot replacement, and is unrelated to the durable entry/value sequence. Numeric autonomous counters, subagent telemetry and summary-presence flags are not Usage rows. Durable-file reconstruction remains separately qualified. An exact adapter would need a proved durable allocator plus rewrite/fork deduplication and atomic snapshot/live handoff; this PR supplies no such proof.

### Continuity v0

The [current Continuity schema](../packages/endophasia/src/continuity-service.ts) requires lane, durable captured tip, configuration model/thinking/active tools, full committed ancestry and Pi's compaction-bounded **source entries**, compaction retained-tail information, exact counts, stable entry ID/parent/sequence/timestamp and variant-specific flags. It is not a provider transcript.

Prime has a durable parent tree and model/thinking change entries, but builds a summary-first message context, synthesizes compaction/branch-summary messages, handles harness digest custom messages specially, and uses `firstKeptEntryId` rather than Pi's retained-tail source-entry contract. Prime entry timestamps and IDs are useful material; they do not establish the missing Pi context membership/sequence semantics. ACP compaction metadata is only optional `tokensBefore`/summary presence, with no complete source-entry window or tool configuration capture. Neither a source-schema declaration nor a generic tree resemblance certifies the current snapshot contract. See [session-manager.ts, lines 446–575](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/session-manager.ts#L446) and [session entry format, lines 54–167](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/core/session-manager.ts#L54).

## Metadata scope and unresolved cases

Prime declares subagents, goals, heartbeats, harness refinement, Python attachment and agent-message metadata in [acp-meta.ts](https://github.com/PrimeIntellect-ai/prime-agent/blob/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074/packages/coding-agent/src/modes/acp/acp-meta.ts#L1). The event mapper emits partial updates for these, sometimes only a presence/change notification. Their field names are not evidence of operation outcomes, Session lanes or a committed Usage allocator. This audit exercises autonomous gate/limit and compaction metadata; zero-child quiescence is observed, while child spawn/late-result races, goals, scheduled heartbeats and refinement runs are unverified. Refinement is deliberately disabled to prevent harness mutation during measurement. No capability is promoted based on unexercised metadata groups.

Source-only terminating-tool/hook equivalences, daemon worker recovery, live child accounting races, negative adjustments, concurrent ledger allocation, non-text ACP content and MCP servers are unresolved. This report does not assert those paths are conformant. Adding them would require semantic witnesses relevant to an existing Endophasia capability, not a feature inventory.

## Reproduction and offline checks

Normal tests use only committed sanitized evidence and local protocol adversaries. They never download or launch Prime. The independent ACP tests cover framing, final records without LF, fragmented delivery, request correlation, duplicate/unknown IDs, request errors, malformed records/updates and abnormal process exit. Fixture tests cover source/probe drift, boundary confusion, schema/privacy, terminal causality, scripts, every historical RPC invariant, all six classifications and full-set publication. Import-graph guards cover production contracts, ingress, Presentation Client, Cockpit and Runtime Profile; existing browser smoke inspects actual bundle inputs. No Prime or ACP SDK dependency is added to Endophasia.

```sh
# Entire Endophasia package, offline
npm test --workspace=@endophasia/core
npm run build --workspace=@endophasia/core
npm run check:prime-conformance:097:offline

# Opt-in live probe; only this command executes the exact prepared Prime checkout
PRIME_AGENT_ROOT=/absolute/path/to/clean-built-prime-agent npm run check:prime-conformance:097
# --write-fixtures remains strictly gated by the sealed exact capture commit.
# A new clean commit first captures diagnostics without publication; see sealing below.
```

A commit cannot contain its own SHA. For a new capture, freeze the executable probe (and current version/hash expectation), commit it, and run all scenarios from that clean commit. The CLI validates pre/post identities and writes only privacy-approved diagnostics; its final exit is nonzero while that new capture commit is unsealed. Review the complete evidence, then seal its exact `endophasiaCommit` in `audited-instrument-097.json` in a **data-only** commit. Keep the capture evidence untouched. The sealed checker must pass the full joint assessment before publishing it through `publishPrime097` with the complete historical baseline:

```js
import { readFileSync } from "node:fs";
import { publishPrime097 } from "./packages/endophasia/research/prime-conformance/comparison.ts";
import { readPrimeFixturesV0 } from "./packages/endophasia/research/prime-conformance/report.ts";
const root = "./packages/endophasia/test/fixtures/prime";
const { rpc, acp } = JSON.parse(readFileSync("./.artifacts/prime-conformance-097/evidence.json", "utf8"));
publishPrime097(root, rpc, acp, readPrimeFixturesV0(`${root}/0.9.6`));
```

The seal records the observed clean measuring commit rather than declaring a later checkout equivalent by assertion. Audit data, fixtures and docs are excluded from the executable hash; the captured source hash must remain identical to the sealed checker. Publication requires Linux, a filesystem with atomic directory exchange and GNU `mv` supporting the above flags; lack of that facility refuses replacement.

`--scenario`, `--retain` and arbitrary extra flags are not accepted by the joint refresh. The historical RPC command retains its old partial-run inspection behavior but cannot publish 0.9.7 evidence on its own. The comparison report is derived from separate boundary evidence, never a fictional combined production interface.

## Candidate for PR #27

**None is exact.** The narrowest Mission Trace blocker is truthful termination/lifecycle evidence: output length and stop-hook/tool termination cannot be inferred as success, and ACP loses turn/model completion and resume/suspend. For durable services, the first missing invariant is a stable committed operation/ledger identity with explicit replay and rewrite rules. These are candidates for a separately scoped upstream protocol proposal or adapter algorithm proof, not capability admission in this PR. Existing v0 contracts remain intact.

## Validation result

The fresh 0.14.6 live run on 2026-10-01 exercised all 12 RPC and 15 ACP scenarios against exact freshly rebuilt Prime `08ff1b2e2794ea9e8f4a08d12bc95408a66e1074`. Both pre/post checks verified clean Endophasia instrument `cb83aa65586327b4cc0daff6d64915be0f5dfb48` and identical source hash `f4620578024ccd0565a45874eb251ea32894e9d073e28fe26e94dd0a34113820`. After the exact capture commit was sealed in audit data, the untouched captured evidence passed the joint gate with `invalid=[]`, `unpublishable=[]`; the complete fixture set and report were atomically replaced. Offline command output is byte-identical to committed `report.json` (SHA-256 `a333e20e92d6f9d784aaf0163504d92d4716d3f1bd6ab939fa185566ca6be2ee`). Recomputed RPC/ACP/durable support, semantic fit and basis for every capability match the previous matrix; `candidateForPR27=[]` remains evidence-derived. The subsequent fixture/documentation commit does not change executable source.

- Full `@endophasia/core`: 40 files passed, 1291 tests passed, 2 existing tests skipped.
- Focused Prime offline suites, hostile mutations and research boundary guards: 811 tests passed across 11 files. Before the live refresh, the ten suites that do not require the replacement fixture identity passed 718 tests.
- Core build, offline report regeneration, browser smoke, Cockpit check, pinned/runtime dependency checks, TypeScript import checks, entry-graph budgets, shrinkwrap/install-lock checks, Biome and whitespace checks passed.
- Root `npm run check` reaches TypeScript and fails on ten existing `moonshotai/Kimi-K2.6` model-catalog type errors. Current main `536e4caa2c2a85357fd7ab711bc0e8777b4a3153` (only README changes since the branch base) was checked in a separate detached worktree with the same dependency/model-data environment. Its diagnostics and the candidate diagnostics are byte-for-byte equal. There are no new root TypeScript errors; no unrelated catalog cleanup was made. Browser/Cockpit checks were run separately because the root command stops at that known failure.

These are maker-run validations of the research candidate, not independent approval or production admission.
