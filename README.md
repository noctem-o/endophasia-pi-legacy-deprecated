<a id="endophasia"></a>

<div align="center">

<p><sub>DEVELOP / EVOLVE &nbsp; · &nbsp; WORK / DREAM &nbsp; · &nbsp; OBSERVE / VERIFY</sub></p>

<h1>endophasia</h1>

<p><strong>Instrumented cognition for coding agents.</strong></p>

<p>
Observe agent runtimes, steer current work, compare experiments,<br>
and keep evidence separate from permission.
</p>

<p>
  <a href="#current-state"><img src="https://img.shields.io/badge/status-experimental-637d69?style=flat-square" alt="Status: experimental"></a>
  <a href="https://github.com/earendil-works/pi"><img src="https://img.shields.io/badge/reference%20runtime-Pi-536c85?style=flat-square" alt="Reference runtime: Pi"></a>
  <a href="#runtime-contracts"><img src="https://img.shields.io/badge/runtime%20contracts-exact-2f6f4e?style=flat-square" alt="Runtime contracts: exact"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-94765e?style=flat-square" alt="License: MIT"></a>
</p>

<p>
  <a href="#why-endophasia">Why</a> &nbsp; · &nbsp;
  <a href="#what-works-now">Today</a> &nbsp; · &nbsp;
  <a href="#develop-and-evolve">Develop / Evolve</a> &nbsp; · &nbsp;
  <a href="#work-and-dream">Work / Dream</a> &nbsp; · &nbsp;
  <a href="#profiles">Profiles</a> &nbsp; · &nbsp;
  <a href="#runtime-contracts">Runtimes</a> &nbsp; · &nbsp;
  <a href="#evolve-providers">Evolve</a> &nbsp; · &nbsp;
  <a href="#magpie-and-deadbolt">Evidence</a> &nbsp; · &nbsp;
  <a href="#roadmap">Roadmap</a>
</p>

</div>

---

Coding agents do more than send a prompt to a model. They select context, compact history, call tools, branch, retry, verify work, spend tokens, accept steering, and sometimes propose actions with real effects.

Endophasia gives those parts explicit contracts and a common place to inspect them.

It does not expose private chain of thought. It does not treat every runtime feature as equivalent. It does not turn a benchmark score into truth or a model proposal into permission.

> [!IMPORTANT]
> Endophasia is experimental. The current runnable path uses Pi. Prime has a merged transport layer and an active conformance study, but no Prime capability is admitted as exact. Codex, EVOLVE providers, Magpie integration, Deadbolt integration, and weight training are future work unless a section below says otherwise.

## Why Endophasia

The project keeps several distinctions explicit.

~~~text
observation  != inference
acceptance   != execution
evidence     != standing
proposal     != permission
history      != active context
configured   != in-flight
accounting   != context occupancy
simulation   != real execution
evaluation   != promotion
~~~

An observed event can be shown as an observation. A derived value should say how it was derived. A capability should stay unavailable if a runtime cannot meet the contract.

The related projects have separate jobs.

~~~text
Endophasia  observes, steers, compares
Pallium     chooses cognition policy
Magpie      records evidence and standing
Deadbolt    authorizes consequential action
~~~

None of those jobs grants another one authority.

## What works now

The merged Pi path has a browser cockpit, remote services, controls, continuity inspection, usage records, runtime accounting, terminal outcomes, and exact capability reporting.

<details>
<summary><strong>Merged v0 features</strong></summary>

| Feature | What it reports or controls |
| :--- | :--- |
| Mission Trace | Structural lifecycle events from the runtime. |
| Continuity Inspector | Durable ancestry and Pi's compaction-bounded context source window. |
| Steering Controls | STEER, QUEUE, and STOP requests with bounded receipts. |
| Session Overview | Per-session state with explicit non-atomic semantics. |
| Operation Outcome | Immutable terminal operation records on the Pi path. |
| Runtime Metrics | Cumulative session accounting captured separately from context occupancy and billing. |
| Usage Ledger and Feed | Durable usage paging and a bounded live tail. |
| Runtime Control Deck | Runtime settings with configured state kept separate from work already in flight. |
| Endophasia Runtime | Chord server and Session worker with multiprocess tests. |
| Presentation Client | Typed client for the Endophasia services. |
| Standard Cockpit | Browser view for sessions, transcript, trace, usage, controls, continuity, and degraded states. |
| Runtime Observation Boundary | Pi-free contracts for trace, metrics, outcome, and usage. |
| Runtime Profile v0 | Worker-lifetime statement of the six Endophasia v0 capabilities installed by the composition root. |
| Prime RPC ingress | Prime-specific process and protocol handling. It installs no Prime semantic capability. |

</details>

The browser is a projection of service state. It does not infer facts from display strings or raw runtime messages.

~~~mermaid
flowchart TB
    A["Runtime"] --> B["Runtime adapter"]
    B --> C["Endophasia services"]
    C --> D["Presentation Client"]
    D --> E["Standard Cockpit"]
~~~

### Mission Trace

Mission Trace records structural lifecycle events without exposing hidden reasoning.

~~~text
mission.started
turn.started
model.started
model.completed
tool.started
tool.completed
mission.completed
mission.failed
mission.aborted
~~~

The Pi implementation is sequence numbered and streaming. The remote worker keeps a bounded window of the latest 1024 events. If the first visible sequence is greater than 1, earlier events fell outside that window. Endophasia does not claim that a durable copy exists elsewhere.

### Continuity

A transcript and the context used for the next model call are different things.

~~~mermaid
flowchart TB
    H["Durable history"] --> C["Compaction and branch state"]
    C --> W["Active context source window"]
    W --> N["Next model request"]
~~~

The current inspector shows durable ancestry and Pi's context source window. It does not claim to reconstruct the exact provider-visible prompt.

### Usage and outcomes

Mission Trace, Runtime Metrics, Usage, and Operation Outcome answer different questions.

A Usage record does not establish a session lane, operation, model, timestamp, or cause unless the Usage contract contains that field. Runtime Metrics is not rebuilt by summing Usage rows. A STOP receipt records acceptance of the request, not the later terminal result.

### Steering

The Pi path currently has three control operations.

~~~text
STEER  changes the active trajectory through Pi's steering queue
QUEUE  delivers work at Pi's follow-up boundary
STOP   requests abort of the observed run
~~~

A receipt records runtime acceptance. It does not claim that the runtime consumed the request or completed the requested effect.

## Develop and Evolve

DEVELOP and EVOLVE describe what the user is doing. They do not select a fixed runtime.

### Develop

DEVELOP covers the current piece of work.

Its main records are the session, turn, context, tools, changes, verification, usage, outcomes, and human steering. Pi is the reference runtime today. Codex is a future runtime candidate. Prime may also run interactive work if its adapter can state the required semantics exactly.

~~~mermaid
flowchart TB
    U["User"] --> C["Cockpit"]
    C --> E["Endophasia"]
    E --> A["Exact runtime adapter"]
    A --> R["Pi now"]
    A -. "future" .-> X["Codex"]
    A -. "research" .-> P["Prime"]
~~~

DEVELOP asks what the agent is doing now, what the runtime actually reported, and whether the user wants to intervene.

### Evolve

EVOLVE covers repeated experiments over candidate agents, policies, skills, prompts, tools, runtime settings, or models.

Its records include scenario identity, candidate identity, environment revision, evaluator revision, repeated episodes, cost, held-out checks, comparison, selection, and promotion history.

~~~mermaid
flowchart TB
    P["Experiment profile"] --> C["Isolated candidate"]
    C --> E["Environment"]
    E --> V["Evaluator"]
    V --> R["Recorded result"]
    R --> K["Compare candidates"]
    K --> A["Admit or reject"]
    A --> N["Next experiment"]
    A -. "separate permission" .-> D["Promotion or deployment"]
~~~

EVOLVE should follow a visible sequence.

~~~text
observe
propose
isolate
evaluate
compare
admit
promote
~~~

Promotion is deliberately last. A candidate can win an evaluation and still lack permission to replace anything.

DEVELOP and EVOLVE can use the same runtime. Pi or Codex can be subjects of EVOLVE experiments. Prime can be used in DEVELOP. The mode describes the job, not the software.

## Work and Dream

WORK and DREAM are planned cognition policies. They are separate from DEVELOP and EVOLVE.

WORK keeps one main trajectory, bounds exploration, runs deterministic checks early, and spends extra compute only when the policy calls for it.

DREAM allows broader search, more retained hypotheses, counterfactual tests, stronger falsification, independent challenge, and white-box experiments when the model exposes the required state.

~~~text
more cognition != more authority
more branches  != more truth
more agreement != more permission
~~~

The planned controls are:

| Control | Intended meaning |
| :--- | :--- |
| Reasoning | Provider-native or local reasoning budget. |
| Epistemic rigour | Named verification and evidence policy. |
| Explore | Breadth of materially different alternatives. |
| Verify | Deterministic checks, falsification, and independent review. |
| Compute appetite | Token, call, test, and branch budget under uncertainty. |
| Tool initiative | When the runtime inspects, retrieves, benchmarks, or proposes actions. |
| Latent deliberation | White-box control only when the model exposes an exact mechanism. |
| J-space | Experimental local-model observation, never fabricated for API-only models. |

A runtime adapter may implement one policy through several runtime settings. It may also report that a control is unavailable.

## Profiles

The current \`RuntimeProfileV0\` is narrow on purpose. It states which exact Endophasia v0 capabilities a Session worker installs. It is not runtime feature negotiation.

EVOLVE needs more coordinates, but they should remain separate contracts.

| Profile | Intended contents |
| :--- | :--- |
| Runtime | Pi, Codex, Prime, or another runtime plus exact admitted capabilities. |
| Model | Hosted or local model identity and the observation level the model permits. |
| Cognition | WORK, DREAM, or another named policy. |
| Environment | Task pack, revision, sandbox, reset rules, and whether execution is real or simulated. |
| Evaluation | Metrics, deterministic checks, graders, judge models, held-out requirements, and selection policy. |
| Adaptation | Candidate generation and selection method such as Reef or RRSI. |
| Training | Optional weight update system such as verl, ROLL, or Molt. |
| Governance | Optional Magpie evidence policy and Deadbolt authority policy. |

Only Runtime Profile v0 is implemented today. The rest describe the intended split for future work.

## Runtime contracts

Pi is the current reference runtime. It is not the definition of Endophasia.

Four observation contracts already sit above the Pi adapter.

~~~text
RuntimeMissionTraceSourceV0
RuntimeMetricsSourceV0
RuntimeOperationOutcomeSourceV0
RuntimeUsageSourceV0
~~~

A runtime may implement one contract without implementing the others. Similar data with different semantics does not count as the same capability.

### Pi

Pi exposes sessions, steering, follow-up work, aborts, lifecycle events, model and thinking settings, compaction, persistence, forks, and resume. Chord supplies typed remote services and replicated state.

Endophasia uses those APIs where they match the Endophasia contract.

The repository currently inherits Pi code and Git history. Pi can remain upstream-aware even if Endophasia later moves outside GitHub's fork network. Shared Git ancestry and an explicit Pi remote are enough for reviewed upstream merges.

### Prime

The merged Prime 0.9.6 study found qualified similarities but no capability that was both native and exact.

PR [#23](https://github.com/noctem-o/endophasia/pull/23) merged the Prime RPC ingress. The ingress owns Prime process and protocol details. It does not install an Endophasia capability.

PR [#26](https://github.com/noctem-o/endophasia/pull/26) audits Prime 0.9.7 at \`08ff1b2e2794ea9e8f4a08d12bc95408a66e1074\` across RPC, ACP, and durable files. The current matrix admits no exact capability and proposes no production capability change.

Prime remains interesting for EVOLVE because it has persistent REPL state, recursive agents, refinement, goals, autonomous budgets, quality gates, and detailed trajectory accounting. Those features do not change the admission rule.

### Codex

Codex is a future runtime candidate.

Its app-server protocol exposes threads, turns, items, steering, interruption, forks, compaction, usage, review, approvals, and runtime settings. Endophasia still needs a pinned conformance study before any of those become Endophasia capabilities.

The planned order is runtime-specific transport first, conformance evidence second, capability admission last.

## Evolve providers

EVOLVE should not require one benchmark runner, adaptation framework, sandbox, or trainer.

The provider contracts should let users install only the parts they need.

~~~mermaid
flowchart TB
    E["Endophasia EVOLVE"] --> R["Runtime"]
    E --> N["Environment"]
    E --> V["Evaluation"]
    E --> A["Adaptation"]
    E --> T["Training, optional"]
    N --> S["Sandbox"]
    V --> O["Experiment record"]
    A --> O
    T --> O
~~~

These projects are useful reference points for future adapters. None is bundled with Endophasia today.

| Job | Candidate provider |
| :--- | :--- |
| Run packaged agent benchmarks | [Harbor](https://github.com/harbor-framework/harbor) |
| Large optional agent environment pack | [MiMo-V2.6-RL-oss](https://huggingface.co/datasets/XiaomiMiMo/MiMo-V2.6-RL-oss) |
| Connect existing agents to rollout and training infrastructure | [Uni-Agent](https://github.com/verl-project/uni-agent) and [mimoagent](https://github.com/XiaomiMiMo/mimoagent) |
| Run isolated environments | Local Docker, [CubeSandbox](https://github.com/TencentCloud/CubeSandbox), or another sandbox provider |
| Simulate agent environments | [Qwen-AgentWorld](https://github.com/QwenLM/Qwen-AgentWorld) |
| Generate and select harness candidates | [Reef](https://github.com/Human-Agent-Society/reef), [RRSI](https://github.com/google-research/rrsi), or another adaptation provider |
| Train model weights | [verl](https://github.com/verl-project/verl), [ROLL](https://github.com/alibaba/ROLL), [Molt](https://github.com/NVIDIA-NeMo/labs-molt), or another training provider |

Large datasets, container images, local models, and training stacks should be optional downloads. Selecting a MiMo experiment should fetch a pinned pack or the required subset. Installing Endophasia should not fetch it.

A stored experiment should identify the exact inputs needed to understand the result.

~~~text
candidate revision
runtime and model identity
cognition policy
environment pack and revision
sandbox image or template identity
evaluator and grader identity
seeds and run count
usage and wall time
result bundle digest
~~~

A simulated environment must say that it was simulated. A world-model result must not appear as a real execution result.

## Magpie and Deadbolt

EVOLVE creates many observations that can be mistaken for conclusions. Magpie can keep that distinction explicit.

Endophasia should keep the large operational records in the experiment system. Magpie should receive the claims and evidence that matter, plus immutable identities for the experiment bundles that support them.

For example, these are different statements:

~~~text
candidate c17 passed 43 of 50 tasks
candidate c17's result bundle has digest X
candidate c17 is supported as better under policy P
candidate c17 may replace the current version
~~~

The first statement is an evaluation result. The second can be checked mechanically. The third is an epistemic conclusion under a named policy. The fourth is an authority decision.

The intended split is:

~~~mermaid
flowchart TB
    R["Experiment run"] --> B["Immutable experiment bundle"]
    B --> E["Endophasia record"]
    E --> M["Magpie: claims, evidence, standing"]
    E --> D["Deadbolt: permission"]
    M --> C["Cockpit explanation"]
    D --> X["Authorized effect"]
~~~

Magpie should not become an RL replay buffer. SPEAR-style self-imitation, Reef history, or trainer replay data belongs with the adaptation or training system.

Deadbolt should not decide what evidence means. It decides whether a consequential action is allowed.

This split also leaves room for disagreement. An in-distribution benchmark can support a candidate while a held-out benchmark supplies counterevidence. Endophasia should show both. Magpie can later apply explicit contradiction, currentness, origin, and standing rules without reducing the record to one score.

## Plans are not effects

A model proposal remains inspectable before any consequential action.

~~~mermaid
flowchart TB
    I["Model intent"] --> P["Structured proposal"]
    P --> R["Review and policy"]
    R --> A["Authority check"]
    A --> E["Real effect"]
    E --> C["Receipt"]
~~~

A valid proposal does not widen the model's permission.

## Local and white-box work

Local models may expose internal state that hosted APIs do not.

Future experiments may include activation probes, local verification models, white-box interventions, context instrumentation, and J-space views. Every such feature needs a concrete model or runtime contract.

If the required state is not available, Endophasia should report \`UNAVAILABLE\`.

## Roadmap

### Near term

1. Complete the Prime 0.9.7 conformance study without changing the contracts to fit Prime.
2. Keep Runtime Profile v0 as a read-only statement of installed Endophasia capabilities.
3. Continue runtime-neutral continuity and control work only where a runtime exposes enough evidence.
4. Improve the cockpit with clearer provenance and controls.
5. Specify DEVELOP and EVOLVE records before building an adaptation loop.
6. Define Environment Profile and Evaluation Profile contracts.

### Next

1. Audit Codex app-server against the existing Endophasia contracts.
2. Add versioned WORK and DREAM cognition policies.
3. Add the planned reasoning, rigour, explore, verify, compute, and tool controls.
4. Define experiment, candidate, episode, comparison, and selection records.
5. Add a first benchmark provider, with Harbor as a strong candidate.
6. Add a local sandbox provider, then keep CubeSandbox or another remote provider behind the same contract.
7. Define an optional Magpie experiment-evidence seam without writing Endophasia-specific semantics into Magpie's log format.

### Later

1. Add optional adaptation providers such as Reef or RRSI.
2. Add optional MiMo environment packs and other benchmark packs.
3. Test simulated environments such as Qwen-AgentWorld, with explicit simulated provenance and real-environment confirmation.
4. Add optional training providers after the experiment and evaluation contracts are stable.
5. Add Deadbolt promotion and deployment checks.
6. Continue local white-box experiments where the model exposes the required state.

The constraint is simple:

> Do not report more certainty, compatibility, evidence, or authority than the recorded inputs support.

## Current state

Merged \`main\` includes the Pi-backed runtime and browser cockpit, Mission Trace, Session Overview, Runtime Metrics, Operation Outcome, Usage, Continuity Remote v0, controls, the runtime-neutral observation contracts, Runtime Profile v0, and the Prime RPC ingress.

Prime 0.9.7 conformance is active in [PR #26](https://github.com/noctem-o/endophasia/pull/26). Its current matrix admits no exact Prime capability.

DEVELOP and EVOLVE, Codex support, environment providers, adaptation providers, training providers, Magpie integration, Deadbolt integration, WORK and DREAM policy compilation, semantic sensors, and J-space controls are design work unless stated otherwise.

Endophasia is ready for architecture experiments. It is not a stable multi-runtime product.

## Development

Most Endophasia code is under:

~~~text
packages/endophasia/
  src/            contracts, services, Pi adapter
  runtime/        worker and runtime composition
  presentation/   typed presentation client
  cockpit/        browser cockpit
  research/       conformance experiments
  test/           unit, integration, hostile, browser tests
~~~

Architecture notes live in \`docs/\`. Current examples include:

~~~text
runtime-observation-boundary-v0.md
prime-runtime-conformance-v0.md
~~~

The Prime conformance code is research-only and is not a production dependency.

## License

MIT.

Endophasia inherits and builds around upstream Pi components under their applicable licenses. See the package metadata and repository history for component-specific details.
