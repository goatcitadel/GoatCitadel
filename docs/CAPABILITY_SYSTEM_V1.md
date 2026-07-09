# Capability System v1

## Purpose

Capability System v1 gives GoatCitadel one native model for tools, skills, candidates, proposals, and Code Mode runs.

It extends the existing gateway, policy, approval, storage, realtime, and Mission Control layers. It does not introduce a second runtime or a hidden agent stack.

## Core Model

Two catalog views now exist:

- `inspectableCatalog`: everything the operator can review, including proposals and inactive candidates
- `callableCatalog`: only activated, policy-allowed capabilities

Only `callableCatalog` may feed planning, wrapper generation, or runtime selection.

Portable capability-pack materialization receipts do not add entries to `callableCatalog`. They record operator review evidence for staged assets only; each asset still becomes callable solely through its existing governed Skills, Add-ons, MCP, Plugins, Tools, or policy lifecycle.

Portable skill bundle manifests use the same truth-preserving posture. A `goatcitadel.skill-bundle.json` file can declare `goatcitadel.skill-bundle.v1` assets with per-file `sha256` hashes and `scriptDisposition: review_only_non_callable`; the skill import path validates those assets and records the result on the candidate/source receipt. This makes hosted and local skill bundles easier to review and re-export, but it does not add scripts to `callableCatalog`, activate skills, or grant tools.

Primary lifecycle/trust concepts:

- categories: `built_in`, `optional`, `project_local`, `self_generated`, `community_imported`
- skill lifecycle: `draft`, `candidate`, `approved`, `trusted`, `deprecated`, `revoked`
- proposal status: `proposed`, `validating`, `pending_approval`, `approved`, `rejected`, `activated`, `failed`

## Repo Mapping

### Contracts

Shared capability contracts live in:

- `packages/contracts/src/capabilities.ts`
- `packages/contracts/src/skills.ts`
- `packages/contracts/src/tool-catalog.ts`
- `packages/contracts/src/chat.ts`
- `packages/contracts/src/approvals.ts`
- `packages/contracts/src/config-schemas.ts`

These define catalog entries, snapshots, lifecycle records, candidate bundles, proposals, Code Mode runs, and slim chat trace references.

### Storage

Capability persistence lives in:

- `packages/storage/src/capability-catalog-snapshot-repo.ts`
- `packages/storage/src/skill-lifecycle-repo.ts`
- `packages/storage/src/candidate-skill-version-repo.ts`
- `packages/storage/src/capability-proposal-repo.ts`
- `packages/storage/src/code-mode-run-repo.ts`

SQLite migration `54` creates the new tables and extends inline chat approvals with richer approval metadata.

### Gateway

The gateway capability runtime is centered in:

- `apps/gateway/src/services/capability-system-service.ts`
- `apps/gateway/src/services/code-mode-child-source.ts`
- `apps/gateway/src/routes/capabilities.ts`
- `apps/gateway/src/services/approval-lifecycle-service.ts`

`GatewayService` delegates skill listing, catalog reads, proposal creation, Code Mode run creation, and Code Mode approval execution to `CapabilitySystemService`.

### Mission Control

Mission Control consumes the new APIs through the canonical Next shell and shared packages:

- `packages/mission-control-shared/src/api/capabilities.ts` (capabilities API client)
- `packages/mission-control-shared/src/api/client.ts` (shell API client)
- `apps/mission-control-next/src/features/native-routes/library/` (Skills / Capabilities surfaces)
- `packages/threaded-surface-core/src/chat/` (single Chat outbound execution, including agentic and code-capability requests)
- `packages/mission-control-shared/src/components/InlineApprovalPrompt.tsx` (inline approval UI)

The chat approval UI now renders in a composer-adjacent footer instead of the old status lane.

## Code Mode v1

Code Mode v1 is intentionally narrow:

- feature-flagged by `codeModeV1Enabled`
- operator-approved before every run
- trusted-code only
- no hostile-code guarantees beyond explicitly proof-scoped platform wording
- read-only deterministic wrappers only
- no in-program approval pause/resume

Operator truth:

- Linux uses a firejail-based best-effort host adapter when available
- macOS uses `sandbox-exec` while the adapter remains available on the host
- Windows uses a constrained AppContainer launcher with stdio JSON-RPC transport when prerequisites are available
- if required host isolation is unavailable, Code Mode fails closed
- if isolation is advisory only, the run may proceed but must surface unsandboxed/advisory metadata to the operator
- Windows-only hostile-code wording is allowed only when `hostileSandboxClaim.platformClaims.win32.publicClaimAllowed` is true from Windows AppContainer adversarial canary proof on the exact release SHA
- aggregate hostile-code promotion remains blocked until `verify:code-mode:hostile-sandbox` has green native Linux Firejail, macOS Seatbelt, and Windows AppContainer adversarial canary proof

### Launch Contract

Production runs launch a child-process harness with:

- a direct `spawn(...)` of either the Node harness or the host-isolation adapter executable
- `shell: false`
- fixed `cwd`
- minimal synthetic env only
- either Node IPC or stdio JSON-RPC transport, depending on the selected native adapter

Guest source is never loaded as a normal CommonJS or ESM module inside the child process. The harness evaluates submitted source only through a restricted host API.

Configured Docker execution uses the same approval and artifact path with `GOATCITADEL_CODE_MODE_DOCKER_BACKEND_ENABLED=true` plus `GOATCITADEL_CODE_MODE_DOCKER_IMAGE`. Digest pinning is required by default: the configured image must be pinned by digest (`name@sha256:...`) unless an operator explicitly sets `GOATCITADEL_CODE_MODE_DOCKER_REQUIRE_DIGEST=false` for a local exception. `--pull never` blocks remote tag mutation but does not stop a locally re-tagged image from being substituted under the same tag, so tag-only Docker images are not the default posture. The Aider adapter is a separate audit-only execution backend: it requires Docker to be callable plus `GOATCITADEL_CODE_MODE_AIDER_ADAPTER_ENABLED=true` and `GOATCITADEL_CODE_MODE_AIDER_IMAGE`, with optional `GOATCITADEL_CODE_MODE_AIDER_COMMAND` and `GOATCITADEL_CODE_MODE_AIDER_MODEL`. Aider runs only in Code Mode run-temp/artifact space and may record request, plan, stdout/stderr, result envelope, and optional patch evidence; it does not apply patches, promote candidates, replay side effects, or mutate the operator workspace.

### RPC Contract

Parent and child communicate over framed JSON-RPC on the IPC channel.

Required properties:

- JSON-RPC request id
- bounded message size
- timeout propagation
- cancellation
- structured errors with durable `errorCode` and `errorDetails` evidence when the child or wrapper boundary rejects a call

Wrapper calls cross the boundary through `capability.invoke`. The parent remains authoritative for policy and actual tool execution.

### Guest Restrictions

Guest code does not receive ambient Node or browser globals:

- no `process`
- no `require`
- no `import`
- no `fetch`
- no ambient filesystem access; approved deterministic wrappers remain the only filesystem path
- no timers or scheduler primitives

TypeScript is transpiled as an isolated single-file string.

`async/await` is allowed over approved wrapper promises, but parallel wrapper invocation is rejected deterministically.

## Hash-Verified Run Artifacts

Every Code Mode run stores stable run identity, status, source/artifact hashes, and the artifact refs needed to revalidate execution. When available for the run, it also stores:

- `capabilitySnapshotId`
- `originSurface`
- `workspaceId`
- `operatorId`
- `permissionProfileId`
- `permissionProfileLabel`
- `localOperatorOverrideId`
- `codeModeInputHash`
- `wrapperManifestHash`
- `policySnapshotHash`
- `codeHash`
- durable refs to the actual wrapper manifest, policy snapshot containing the frozen input, and submitted code artifacts

Stdout and stderr are captured as bounded streams. Truncation state is persisted on the run record and artifact previews.

If approval creation or post-approval pending-action registration fails after source, wrapper manifest, and policy snapshot artifacts are written, the run ledger stores a failed Code Mode run with the artifact refs, failure phase, and error code. This keeps artifact evidence inspectable instead of leaving managed files with no operator-visible run record.

## Skills, Candidates, and Proposals

Runtime skills remain `SKILL.md`-driven.

Generated candidates are staged under a runtime-managed data root, defaulting to:

- `data/capability-candidates/`

Code-run artifacts default to:

- `data/code-mode-artifacts/`

Each candidate bundle contains:

- `skill.json`
- `SKILL.md`
- optional program source
- optional schemas
- `proof.json`

`proof.json` records the originating run, sample input and output, wrapper manifest version, a generated smoke case, and the last successful execution timestamp.

Proposals and unactivated candidates are inspectable in Mission Control but are never callable until activation.

Tool creation in v1 is proposal-and-scaffold only. Executable new tools still require human review and activation.

## Skill Backfill

First-run backfill maps existing skills into lifecycle metadata:

- bundled -> `built_in` + `trusted`
- managed -> `optional` + `trusted`
- workspace -> `project_local` + `approved`
- extra with provenance -> `community_imported` + `approved`

Existing runtime state is preserved. Backfill is idempotent and does not widen the callable surface for disabled skills.

## Approval UX

Blocking approvals are now thread-scoped and server-truth-backed.

The footer shows:

- oldest unresolved blocking approval
- remaining queue count
- risk and affected resources
- Code Mode hashes and snapshot ids
- short code preview or inspect path
- requested output intent
- candidate-save intent

While a blocking approval is active, draft text remains editable but send is disabled.

## Operator Notes

- Enable Code Mode v1 with `GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED=true`.
- Candidate root override: `GOATCITADEL_CAPABILITY_CANDIDATE_ROOT`
- Artifact root override: `GOATCITADEL_CODE_MODE_ARTIFACT_ROOT`
- Temp root override: `GOATCITADEL_CODE_MODE_TEMP_ROOT`

Default managed paths are ignored in git.

## Verification

Minimum proof for this feature set:

- package typechecks
- gateway and Mission Control targeted tests
- migration proof for backfill idempotence
- approval footer regression coverage
- child-process harness tests around env, IPC, output bounds, and non-module execution
