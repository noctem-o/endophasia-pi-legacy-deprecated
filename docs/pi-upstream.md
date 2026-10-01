# Pi upstream and standalone repository readiness

Pi remains Endophasia's reference runtime and an important upstream. Endophasia retains shared Git ancestry and applicable upstream licenses and attribution. GitHub fork-network membership is not required to fetch, inspect or deliberately integrate Pi changes.

A standalone clone can keep these explicit remotes:

```sh
git clone https://github.com/noctem-o/endophasia.git
cd endophasia
git remote add pi-upstream https://github.com/earendil-works/pi.git
git fetch pi-upstream
```

These are manual instructions, not a synchronization script. Inspect an exact upstream revision and its diff before selecting a reviewed integration branch. Merge or cherry-pick deliberately, preserve ancestry/attribution, review conflicts, then run Endophasia's checks. Upstream commits must not silently overwrite Endophasia semantic contracts. Endophasia runtime, service, presentation and research changes remain separate from upstream synchronization. Do not infer semantic equivalence from upstream API similarity or a successful merge.

## Readiness inspection at #27

The source tree was inspected from `main` `971bc28b0b84a1b8ef03f6c74aa5b66670a66485`, after merged #26. No script, test or workflow requires GitHub to report Endophasia's repository as a Pi fork, query its parent/source fork metadata, or synchronize through a fork-network operation. Detaching the existing `noctem-o/endophasia` repository from the network tomorrow would not break an identified source-tree dependency.

| Surface checked | Finding and treatment |
| --- | --- |
| Owner/repository paths and source links | Endophasia PR #23/#26 links remain historical references at their real addresses. Exact Prime source links identify the studied subject. Pi links identify upstream components; they do not depend on fork metadata. No speculative organization URLs were introduced. |
| CI and scripts | Main/PR workflows use checkout and repository-local code; repository-sensitive jobs use `github.repository`, `GH_REPO` or `GITHUB_REPOSITORY`. Historical source verification requires full Git history, now requested by CI checkout. No parent-fork API dependency was found. |
| Package metadata | Inherited `@earendil-works/pi-*` names, dependency identities and repository metadata remain upstream component attribution. Changing their publication identity is separate release work; detachment does not require package/lock changes. |
| Clone/update instructions | The command above clones Endophasia directly. Component-specific coding-agent instructions intentionally still describe cloning Pi. Explicit `pi-upstream` replaces any need for GitHub's fork update UI. |
| Badges | README status/license anchors are local; the reference-runtime badge intentionally links Pi. No fork-status badge is used. |
| Upstream merge guidance | Deliberate Git revision review and integration are independent of fork-network membership. Automatic overwriting of Endophasia contracts is not authorized. |
| Test fixtures and research provenance | Fixtures pin source commits, artifact/source hashes and bytes, not GitHub fork metadata. Preserve capture commits in history; archive/shallow clones without those objects cannot verify the measuring source and must obtain full history. Prime's sealed source, audit registry, fixtures/report and classifications are unchanged. |
| Inherited maintainer tooling | `scripts/release-notes.mjs` defaults to `earendil-works/pi` and supports explicit `--repo`; do not use that default for Endophasia release mutations. Inherited issue templates/CONTRIBUTING guidance refer to Pi's contribution policy. These identify upstream workflow, not fork membership, and are retained without broad release/governance redesign. |

Detachment is distinct from renaming/moving a repository, publishing renamed packages, or configuring a new repository's secrets, permissions, catalogs, webhooks, branch rules and release credentials. Those external settings cannot be certified by a source-tree review. The existing catalog/CI/build environment and Linux atomic-exchange requirements remain; a new standalone repository would need its own deliberate configuration. This PR does not modify external settings or perform migration.

Preserve LICENSE, component notices, upstream author history and applicable attribution during any later migration or integration. Pi remains a reference runtime, not the authority to redefine Endophasia's semantic contracts.
