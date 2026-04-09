# Capability System v1

## Purpose

Capability System v1 gives GoatCitadel one native model for tools, skills, candidates, proposals, and Code Mode runs.

It extends the existing gateway, policy, approval, storage, realtime, and Mission Control layers. It does not introduce a second runtime or a hidden agent stack.

## Core Model

Two catalog views now exist:

- `inspectableCatalog`: everything the operator can review, including proposals and inactive candidates
- `callableCatalog`: only activated, policy-allowed capabilities

Only `callableCatalog` may feed planning, wrapper generation, or runtime selection.

Primary lifecycle/trust concepts:

- categories: `built_in`, `optional`, `project_local`, `self_generated`, `community_imported`, `proposal`
- skill lifecycle: `draft`, `candidate`, `approved`, `trusted`, `deprecated`, `revoked`
- proposal status: `proposal`, `validation`, `approval_pending`, `approved`, `activated`, `rejected`, `revoked`

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

Mission Control consumes the new APIs in:

- `apps/mission-control/src/api/capabilities.ts`
- `apps/mission-control/src/api/chat.ts`
- `apps/mission-control/src/pages/SkillsPage.tsx`
- `apps/mission-control/src/pages/chat/useChatOutboundExecution.ts`
- `apps/mission-control/src/components/InlineApprovalPrompt.tsx`

The chat approval UI now renders in a composer-adjacent footer instead of the old status lane.

## Code Mode v1

Code Mode v1 is intentionally narrow:

- feature-flagged by `codeModeV1Enabled`
- operator-approved before every run
- trusted-code only
- no hostile-code guarantees
- read-only deterministic wrappers only
- no in-program approval pause/resume

### Launch Contract

Production runs launch a child-process harness with:

- `spawn(process.execPath, [absoluteHarnessPath], ...)`
- `shell: false`
- fixed `cwd`
- minimal synthetic env only
- explicit stdio plus `ipc`

Guest source is never loaded as a normal CommonJS or ESM module inside the child process. The harness evaluates submitted source only through a restricted host API.

### RPC Contract

Parent and child communicate over framed JSON-RPC on the IPC channel.

Required properties:

- request id
- correlation id
- bounded message size
- timeout propagation
- cancellation
- structured errors

Wrapper calls cross the boundary through `capability.invoke`. The parent remains authoritative for policy and actual tool execution.

### Guest Restrictions

Guest code does not receive ambient Node or browser globals:

- no `process`
- no `require`
- no `import`
- no `fetch`
- no filesystem access
- no timers or scheduler primitives

TypeScript is transpiled as an isolated single-file string.

`async/await` is allowed over approved wrapper promises, but parallel wrapper invocation is rejected deterministically.

## Immutable Run Artifacts

Every Code Mode run stores:

- `capabilitySnapshotId`
- `wrapperManifestHash`
- `policySnapshotHash`
- `codeHash`
- durable refs to the actual wrapper manifest, policy snapshot, and submitted code artifacts

Stdout and stderr are captured as bounded streams. Truncation markers are persisted in both the run record and the event trail.

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
