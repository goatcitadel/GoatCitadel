# WS9 Profile-free Turn Bindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-enable Work Passport, workspace snapshots, model council and explicit context on edit/retry/child for new Chat turns, each bound through immutable feature references instead of a frozen capability profile.

**Architecture:** Each feature adds one optional field to `ChatTurnFeatureReferences` (bound once per turn admission, reused by durable replay), one default-off runtime flag, and one prep-time admission rule. Prompt injection goes through one new turn-binding system instruction. Model council swaps its profile input for a `ModelCouncilBinding` derived from either a historical profile or the admission.

**Tech Stack:** TypeScript, zod, vitest (`--maxWorkers=2`), Fastify gateway, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-10-19-profile-free-turn-bindings.md`

## Global Constraints

- One PR per feature, each branched from `origin/main`; never stacked. `Refs #344` and `Refs #341`; only the last PR that completes the final "Done when" box says `Closes #344`.
- Every flag defaults to `false` until CI is green, then flips to `true` in the same or a follow-up PR.
- Run only changed test files: `pnpm --filter @goatcitadel/gateway exec vitest run <files> --maxWorkers=2` at BelowNormal priority; check for other sessions' vitest/tsc first. No `verify:*` composites locally.
- Feature references never name tools, grants, policy decisions or permission posture.
- `gateway-service.ts` must stay under its 13132-line baseline; move new logic into owner files. Never run `architecture:baseline:update`; if `chat-feature-admission-service.ts` exceeds its 37 host-callback / member-access allowance, raise that allowance entry with a reason.
- Gateway tests that `vi.mock("@goatcitadel/storage")` must spread any new real exports.
- Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push with `git -c credential.helper='!gh auth git-credential' push`.

## Review Focus

- Durable replay after the operator changed the Work Passport baseline: replay must render the admitted passport, not a new one (Task 2 test `reuses the admitted passport on durable replay`).
- Passport flag on, no resolvable provider route: the turn must still prepare (Task 2 test `binds a passport-only admission without a route`).
- Snapshot request on a turn without operator admission (system/cron/heartbeat): reject before user ingestion (Task 4 test).
- Council where every advisory route is ward-denied: fail closed with "at least two" rather than run a one-member council (Task 6 test).
- Council durable recovery after the admission hash changed: refuse (Task 6 test `refuses recovery under a different binding`).

---

## PR A — 9.1 Work Passport (branch `feat/ws9-work-passport`)

### Task 1: Flag plumbing helper for the four WS9 flags

**Files:**
- Modify: `apps/gateway/src/config.ts` (feature interface ~L106, env map ~L856, defaults ~L1475)
- Modify: `apps/gateway/src/services/gateway/feature-flags.ts` (~L59, ~L145)
- Modify: `apps/gateway/src/services/gateway/runtime-settings.ts` (~L157)
- Modify: `apps/gateway/src/routes/dashboard.ts` (~L249)
- Modify: `packages/contracts/src/change-plan.ts` (~L170)
- Modify: `packages/mission-control-shared/src/api/types.ts` (~L609)
- Modify: `apps/gateway/src/services/chat-feature-availability.ts`

Each PR adds only its own flag, following `chatExplicitContextV1Enabled` exactly: env var `GOATCITADEL_FEATURE_CHAT_WORK_PASSPORT_V1_ENABLED` (snapshot: `..._CHAT_WORKSPACE_SNAPSHOT_V1_ENABLED`, council: `..._CHAT_MODEL_COUNCIL_V1_ENABLED`, branches: `..._CHAT_EXPLICIT_CONTEXT_BRANCHES_V1_ENABLED`). Availability projection adds `workPassport`, `workspaceSnapshot`, `modelCouncil`, `explicitContextBranches` (each `durableExecution && flag === true`; branches also requires `explicitContext`).

- [ ] Step 1: extend the existing config/feature-flag tests that enumerate flags (find with `git grep -n chatExplicitContextV1Enabled -- '*.test.ts'`) with the new flag defaulting to `false`.
- [ ] Step 2: run them, expect FAIL; add the flag; run, expect PASS.

### Task 2: `workPassport` feature reference

**Files:**
- Modify: `packages/contracts/src/chat-feature-references.ts`, test `packages/contracts/src/chat-feature-references.test.ts`
- Modify: `apps/gateway/src/services/chat-feature-admission-service.ts`, test `chat-feature-admission-service.test.ts`
- Modify: `apps/gateway/src/services/gateway-service.ts` (`chatFeatureAdmissionHost`, one line)

**Interfaces:**
- Produces: `references.workPassport?: WorkPassportRecord` (zod `z.custom` using `assertWorkPassportRecord`); `ChatFeatureAdmissionHost.classifyWorkPassport?(workspaceId: string, content: string): Promise<WorkPassportRecord>`.

- [ ] Step 1: contract test — a valid passport decodes; a passport with `operatorCorrectionAllowed: false` throws.
- [ ] Step 2: admission tests — `computes a passport only when chatWorkPassportV1Enabled is on`; `reuses the admitted passport on durable replay` (second call with `durableClaim` + expected hash returns the first record without calling `classifyWorkPassport`); `binds a passport-only admission without a route` (route undefined → references have `workPassport`, no `providerRoute`, no throw).
- [ ] Step 3: run, FAIL. Implement: classify after skills; include `workPassport` in the "anything admitted" check; the route pin throws only when a route-dependent field is present, and passport-only admissions pin a route only if one resolves.
- [ ] Step 4: run, PASS. Commit.

### Task 3: Turn-binding instruction and doc removal

**Files:**
- Modify: `apps/gateway/src/services/chat-turn-prep-service.ts` (after admitted-skill injection ~L1230; force-action rebuild ~L1317; profile builder ~L1595-1660)
- Test: `apps/gateway/src/services/chat-turn-prep-service.work-passport.test.ts`
- Modify: `docs/1_0_CONTRACT.md` (L7 summary, Work Passport line), `docs/CANONICAL_RUNTIME_STATE_MODEL.md` (L18 + Work Passport section), `docs/testing/FEATURE_QUALITY_EXECUTION.md`

**Interfaces:**
- Produces: `export function upsertChatTurnBindingSystemInstruction(history, references: ChatTurnFeatureReferences | undefined): ChatCompletionRequest["messages"]` — marker prefix `"Server-owned turn bindings (advisory evidence, no authority):"`; shared `formatWorkPassportInstruction(passport)` and `formatWorkspaceSnapshotInstruction(snapshot)` used by both builders.

- [ ] Step 1: tests — references with a passport render `boundary=cross_domain`, `review=domain_expert_required`, "not an assessment of the operator"; references without passport/snapshot leave history unchanged; a second upsert replaces rather than duplicates. Keep the existing profile test passing.
- [ ] Step 2: FAIL → implement → PASS. Prep test: with a stub `resolveChatFeatureAdmission` returning a passport, `prepared.history` contains exactly one binding instruction.
- [ ] Step 3: docs; typecheck gateway (`pnpm --filter @goatcitadel/gateway typecheck`); commit; push; open PR A.
- [ ] Step 4: after CI green, flip default to `true` (config default + feature-flags fallback + Task 1 test), update docs to say default-on; push.

## PR B — 9.2 Workspace snapshots (branch `feat/ws9-workspace-snapshots`)

### Task 4: Admit and persist snapshots

**Files:** contracts references + test; `chat-feature-admission-service.ts` + test; `chat-turn-prep-service.ts` (~L680 rejection, `resolveChatFeatureAdmission` input); `chat-turn-prep-service.routed-context.test.ts` (~L752); `gateway-service.ts` host (one line); flag per Task 1.

**Interfaces:**
- Produces: `references.workspaceSnapshot?: ChatWorkspaceSnapshotRecord` (strict zod mirror; `schemaVersion` literal, hash `^[a-f0-9]{64}$`, `status` enum, counts non-negative ints); `ChatFeatureAdmissionHost.captureWorkspaceSnapshot?(input: { sessionId; turnId; workspaceId; request: ChatWorkspaceSnapshotRequest }): Promise<ChatWorkspaceSnapshotRecord>`; resolve input gains `workspaceSnapshotRequest?: ChatWorkspaceSnapshotRequest`.

- [ ] Step 1: tests — admission captures once and binds `workspaceSnapshot` whose `workspaceId` equals the admission workspace; replay never calls capture; a captured record with a foreign `workspaceId` is refused. Prep: flag on + operator admission → accepted and rendered by the binding instruction ("grants no filesystem authority"); flag off → `/Workspace snapshots require enabled durable Chat admission/`; system actor → same rejection before `ingestEvent`.
- [ ] Step 2: FAIL → implement → PASS; docs (snapshot lines); commit; PR B; flip default after CI.

## PR C — 9.3 Model council (branch `feat/ws9-model-council`)

### Task 5: `ModelCouncilBinding` in Assembly

**Files:** `apps/gateway/src/services/assembly-service.ts` (`ExecuteChatModelCouncilInput` ~L97, `buildModelCouncilResolution` ~L2298, `assertExistingModelCouncilResolution`, `assertModelCouncilInputScope`, thinking-level reads ~L1733/1961/2519/2573); `assembly-service.test.ts`.

**Interfaces:**
- Produces: `export interface ModelCouncilBinding { bindingId: string; bindingHash: string; turnId: string; sessionId: string; workspaceId: string; primaryProviderId: string; primaryModel: string; thinkingLevel?: ChatThinkingLevel; primaryReady: boolean; profile?: ChatTurnCapabilityProfileRecord }`; input field `binding` replaces `capabilityProfile`. Routed-context council checks run only when `binding.profile` is present; a live binding with a routed-context snapshot is refused.

- [ ] Step 1: update existing council tests to pass `binding` built from `createCouncilCapabilityProfile`; add `runs a live binding without a profile` and `refuses recovery under a different binding` (same run, different `bindingHash`).
- [ ] Step 2: FAIL → implement (persisted resolution keeps `capabilityProfileId/Hash` holding `bindingId/bindingHash`) → PASS. Commit.

### Task 6: Live council admission and member recheck

**Files:**
- Create: `apps/gateway/src/services/chat-model-council-binding.ts` (+ `.test.ts`) — `resolveModelCouncilBinding(prepared): ModelCouncilBinding` and `selectModelCouncilCandidates(deps, prepared): Promise<ModelCouncilProviderCandidate[]>` (moved out of `GatewayService.executeChatModelCouncil`, adding `admitsDispatchWard(attribution {callKind: "assembly_participant", sessionId, turnId, workspaceId}, providerId)`).
- Modify: `gateway-service.ts` `executeChatModelCouncil` (shrinks); `chat-turn-prep-service.ts` (~L685); contracts `modelCouncil: { version: "chat.model-council.admission.v1" }` reference; admission service records it when requested; `routed-context.test.ts` (~L752 flip); flag per Task 1.

- [ ] Step 1: tests — ward-refused advisory member dropped; ward-refused primary → throws; all advisories refused → "at least two"; binding from admission uses `feature-admission:<admissionId>` and `referenceSha256`; prep accepts council with flag + operator admission, rejects with contextRefs or `parentDelegationStepId`, rejects with flag off.
- [ ] Step 2: FAIL → implement → PASS; docs; commit; PR C; flip default after CI.

## PR D — 9.4 Explicit context on edit/retry/child (branch `feat/ws9-explicit-context-branches`)

### Task 7: Re-admit the source turn's context on edit/retry

**Files:**
- Create: `apps/gateway/src/services/chat-explicit-context-inheritance.ts` (+ `.test.ts`) — `export async function resolveInheritedContextRefs(host: { storage: Pick<AsyncStorage, "routedContextSnapshots">; isFeatureEnabled(flag: string): Promise<boolean> }, input: { sourceTurnId: string; requested: ChatSendMessageRequest["contextRefs"] }): Promise<ChatSendMessageRequest["contextRefs"]>`; returns `requested` when defined, otherwise the refs rebuilt from `findByTurn(sourceTurnId).entries` (ordered by `index`, `{kind, ref, label}`), otherwise `undefined`; returns `requested` unchanged when either flag is off.
- Modify: `chat-turn-entry-service.ts` retry (~L1514, ~L1646) and edit (~L1807, ~L1923) request construction; flag per Task 1; `chat-turn-entry-service.test.ts`.

- [ ] Step 1: tests — flags on + source snapshot + no refs → inherited refs in order; explicit `[]` → `[]`; explicit refs win; flag off → `undefined`; entry retry passes inherited refs into prep (extend the ~L1150 test).
- [ ] Step 2: FAIL → implement → PASS. Commit.

### Task 8: Child steps inherit the parent's admitted context

**Files:** `chat-explicit-context-inheritance.ts` (add `resolveDelegatedParentContextRefs(host, admission): Promise<{ refs; parentSnapshotId; parentSnapshotHash } | undefined>` reading `chatDelegationRuns.get(policyRunId)` → parent durable payload via `readDurableChatTurnExecutionPayloadAuthority` → `routedContextSnapshots.get`, verifying id/hash/turn); `chat-turn-prep-service.ts` (~L666-679: when `parentDelegationStepId` and the flag, compute inherited refs server-side and admit them; never accept request refs on a child); `chat-local-delegation-authority.ts` stays rejecting request `contextRefs`; `routed-context.test.ts` (~L752).

- [ ] Step 1: tests — child of an explicit-context parent gets a fresh child-bound v3 snapshot from inherited refs; mismatched parent snapshot hash → reject; child request carrying its own refs → reject; flag off → child admits no context (today's behavior).
- [ ] Step 2: FAIL → implement → PASS; remove the edit/retry/child sentence from the contract and FEATURE_QUALITY doc; commit; PR D with `Closes #344` if all other boxes are ticked; flip default after CI.
