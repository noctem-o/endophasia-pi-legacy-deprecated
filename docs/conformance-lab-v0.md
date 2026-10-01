# Conformance Lab v0

The lab is a research-only place to run trustworthy studies that can conclude different things about different subjects. Shared experiment mechanics do not establish shared runtime semantics. A study that establishes nothing exact can still succeed by recording reproducible blockers.

`packages/endophasia/research/conformance/` provides only mechanical checks:

| Module | Responsibility |
| --- | --- |
| `json.ts` | Reject custom serializers, accessors, proxies, hidden/symbol properties, cycles and non-JSON values before reading them; deterministic JSON and SHA-256 validation. |
| `files.ts` | Plain filesystem identities and confined relative member names. |
| `repository.ts` | Clean tracked-source identity before/after capture; read historical source objects at an exact commit without executing them. |
| `order.ts` | Require unique complete scenario sets and impose the study's declared order. |
| `reference.ts` | Verify an externally pinned member/digest inventory; stage and publish a complete byte bundle through an atomic directory replacement. |

There is no runtime adapter, subject registry, provider/plugin framework, event mapper, evaluator or capability catalogue. These modules import Node builtins and each other only. A study defines its own scenarios, decoder, privacy schema, semantic predicates, contradictions, classification, mappings and citations. No production module imports the lab.

## Lifecycle

1. **Pin subject:** identify exact source, launcher, effective artifacts and dependencies on the studied boundary.
2. **Pin instrument:** commit its source and identify every execution input. Verify cleanliness and the same identity before and after the complete capture.
3. **Define scenarios:** declare identities, order, scope and decisive witnesses before measurement.
4. **Capture:** obtain observations in an isolated bounded environment.
5. **Sanitize:** the study removes payloads and applies its closed privacy schema before anything is written.
6. **Validate structure:** check closed shapes, required identities, complete sets and internal consistency.
7. **Evaluate:** apply subject-specific predicates and source-derived requirements.
8. **Classify:** retain qualifications, contradictions and unresolved cases separately from observations.
9. **Seal:** freeze original sanitized bytes, exact coordinates and an externally pinned complete digest inventory. A self-computed digest is not approval or proof of origin.
10. **Publish:** install the entire approved reference together, refusing partial replacements.
11. **Regenerate offline:** rebuild interpretations through the study's checker and compare the complete report bytes.
12. **Compare drift:** distinguish subject, instrument, environment, byte and semantic changes; none automatically admits capabilities.

Observation != interpretation. Classification != capability admission. Conformance evidence != runtime composition. Feature advertisement != semantic equivalence.

Plain JSON validation is not privacy validation. The byte publisher does not inspect meaning or judge publishability. Its caller must first sanitize, validate and pass the study's complete publication gate. There is deliberately no generic diagnostic writer claiming that arbitrary plain JSON is safe. Safe diagnostic persistence remains study-specific; the existing specimen distinguishes privacy/shape failures from ordinary semantic failures.

## Research vocabulary

These words describe a study under its stated contract and scope. They are **not Runtime Profile values** and install nothing.

| Word | Meaning |
| --- | --- |
| exact | The study established the complete relevant contract under its stated scope. |
| qualified | Useful exercised correspondence exists, but at least one requirement remains unestablished or conflicting. |
| incompatible | Observed behavior conflicts with the contract. |
| unavailable | Required information or an operation is not exposed on the studied boundary. |
| unverified | Evidence is insufficient to decide. |

Absence of evidence is not incompatibility. Unavailable, incompatible and unverified remain distinct. Subject-specific code decides which word its evidence supports. A malformed capture supplies no substantive contradiction. A valid disagreement may contradict only the conclusions that depend on it.

Runtime Profile v0 remains [composition root → profile → presentation](runtime-profile-v0.md). It is neither protocol introspection, discovery, feature negotiation nor conformance classification. Production capability admission requires a later deliberate implementation and review; a lab report cannot generate a profile.

## Mechanical limits

Canonical JSON sorts object keys and preserves arrays, emits tabs and one LF, and rejects `undefined` instead of silently dropping it. It is a local deterministic format, not RFC 8785. Existing specimens retain their own historical serialization.

Repository identity pins an exact Git commit, compares every tracked plain file against that commit (including configuration and edits hidden by index flags), and supplies an explicit JS/TS source fingerprint. Every Git subprocess disables replacement objects, so local replacement refs cannot substitute content beneath a recorded object ID. Filesystem executable bits must match the committed mode independently of `core.fileMode`. Only explicitly tracked `text eol=crlf` policy permits checkout newline normalization; local/global/system attributes cannot excuse differences, and no custom filter is used to excuse them. Repositories with tracked links/submodules are refused by this helper and need a separate identity policy. Ignored/generated code, installed dependencies, injected loaders, environment and subject artifacts require explicit study-specific guards and coordinates. The helper alone does not attest the effective execution graph. Historical verification hashes **the recorded commit**, never today's source; full Git history is required (CI checks out full history).

References require an externally trusted complete inventory of relative paths and SHA-256 values, with no duplicate or overlapping members. Verification rejects absent, additional, changed or linked members/roots and bounds total file bytes to 16 MiB. Publication validates the entire input before staging. The publisher owns the parent directory and assumes no hostile concurrent filesystem writer; immutable offline references are verified without concurrent mutation.

Publication uses the audited single-exchange mechanism retained independently for future studies: sync staged files/directories, then Linux atomic rename exchange through `/usr/bin/mv --exchange --no-copy --no-target-directory`, then sync the parent. Replacing an existing reference requires GNU coreutils >= 9.5 (the first release with `mv --exchange`) or another explicitly audited implementation of atomic directory exchange. Unsupported tools/filesystems refuse replacement; there is no remove/copy fallback. GNU coreutils 9.12 is the tested environment; CI runs on `ubuntu-26.04` (GNU `mv` 9.7) and verifies the primitive before building. A process death before/after exchange leaves the complete old/new visible reference. A failure after exchange can leave the new complete reference installed; re-verify its digest instead of interpreting an exception as rollback. Crash remnants at staging paths are not published references. Multi-file pathname reads must avoid concurrent publication or hold a directory snapshot; exchange is not a transaction across separate opens.

## First full adversarial specimen

[Prime Agent 0.9.7](prime-runtime-conformance-0.9.7.md) is sealed at `08ff1b2e2794ea9e8f4a08d12bc95408a66e1074`, measured by `prime-conformance-v0@0.14.7` at Endophasia capture commit `45adf6b103bf484f40aa69b4774c089ccd170bda` with source hash `56e25aee3557d266f8b40e3efc883e3ffbf6f2dcdbcee42407dc3989186600f0`.

Its 12 RPC + 15 ACP fixtures and report are unchanged. Report SHA-256 is `d61a8b298954880068b954872d9ea6c110a49fc60d815856d6da344fb2299a53`. The read-side golden inventory at `test/fixtures/conformance/prime-097-reference.json` pins all 28 files; its digest is `7e9f090a28e0fa0af3e0106645720b0d4c36eaf12f334ea18af7333fe0ad69ac`.

The lab verifies bytes, complete scenario IDs and historical source identity, then lets the unchanged original checker regenerate its own report. It cannot reinterpret the capability matrix. The historical implementation remains in `research/prime-conformance/`; the generic equivalents do not replace it or become part of its measuring instrument. The old live commands are archival tooling, not instructions to recapture this sealed specimen from today's checkout.

No capability was admitted: Overview and Continuity are incompatible; Trace is qualified fragments, Metrics qualified reconstruction, Outcome unavailable/incompatible, Usage qualified durable projection. `candidateForPR27=[]` is the completed result of #26, not work left for this PR to force through.

Prime runtime admission is dormant. Reopen it only for a material upstream semantic change that closes a recorded blocker, such as durable operation/outcome identity, complete lifecycle evidence, committed Usage allocation/paging, or matching continuity/context semantics. A version bump alone is insufficient. Prime's recursive/subagent execution, persistent REPL state, continual harness refinement, goals, budgets, quality gates and trajectory/accounting material remain interesting experimental subjects for EVOLVE, without becoming Endophasia capabilities. Its existing process/RPC substrate remains intact.

## Next work

#27 consolidates this laboratory and the post-Prime result. Repository migration follows separately. Then #28 Evolution Trace + Experiment Bundle v0, #29 Environment/Evaluation Profiles + Resource Envelope, #30 Harbor EVOLVE provider, and #31 a pinned Codex app-server conformance study. Those contracts and integrations are not implemented here. A genuinely different second subject should inform any later abstraction; sharing transport shape is insufficient.
