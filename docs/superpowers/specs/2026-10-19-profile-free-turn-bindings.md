# Profile-free turn bindings for the gated Chat features (WS9) — design

- **Date:** 2026-10-19
- **Status:** Approved direction (gap-closure program WS9, issue #344 under tracker #341)
- **Surface:** `apps/gateway` (prep, feature admission, model council, delegation authority), `packages/contracts` (feature references), runtime feature flags, `docs/1_0_CONTRACT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, `docs/testing/FEATURE_QUALITY_EXECUTION.md`

> Line anchors come from `main` at `1529fbf0e` and are approximate.

## 1. Problem

Commit `078c420a9` (2026-09-25) stopped freezing a per-turn capability profile for new Chat turns. The profile was an all-purpose authority snapshot: tools, skills, grants, policy decisions and provider readiness were captured once and then trusted for the rest of the turn. It drifted from live authority, so it was removed. Four features were bound to that profile and were switched off with it:

| Feature | Where it was bound | Where it is rejected today |
|---|---|---|
| Work Passport | `selection.workPassport` in the profile, rendered by `upsertChatCapabilityProfileSystemInstruction` | Not computed for new turns (no rejection; the field is simply absent) |
| Workspace snapshots | `selection.workspaceSnapshot` in the profile | `chat-turn-prep-service.ts` ~L680 `ConflictError` |
| Model council | `ExecuteChatModelCouncilInput.capabilityProfile` (identity, primary route, readiness, thinking level) | `chat-turn-prep-service.ts` ~L685 `ConflictError`; `GatewayService.executeChatModelCouncil` requires a profile |
| Explicit context on edit/retry/child | Fresh explicit context is restored for ordinary operator sends only | `chat-turn-prep-service.ts` ~L666-679 and `chat-local-delegation-authority.ts` ~L70 |

Re-enabling them must not bring back a per-turn authority snapshot.

## 2. Principle: evidence, never authority

Since the restoration work of 2026-10-11, new turns record what they admitted in `ChatTurnFeatureReferences` (`packages/contracts/src/chat-feature-references.ts`). That record is:

- bound once per turn admission (`sessionMutationAdmissions.bindFeatureReferences`, keyed by the admission identity, which carries the `turnId`), and immutable afterwards;
- reused verbatim by durable replay (`resolveChatFeatureAdmission` returns the existing record when a `durableClaim` or expected hash is present);
- documented as "immutable feature evidence. These records never grant callable authority."

All four features bind through this record. None of them adds a field that names tools, grants, policy decisions or permission posture. Tool exposure and invocation keep using the live callable catalog with Gateway policy checks, exactly as for any other new turn.

Every feature ships behind its own default-off runtime flag, wired like the other restoration flags (config, env var, runtime settings, dashboard patch schema, change-plan flag list, Mission Control shared types):

| Feature | Flag |
|---|---|
| 9.1 Work Passport | `chatWorkPassportV1Enabled` |
| 9.2 Workspace snapshots | `chatWorkspaceSnapshotV1Enabled` |
| 9.3 Model council | `chatModelCouncilV1Enabled` |
| 9.4 Explicit context on edit/retry/child | `chatExplicitContextBranchesV1Enabled` (also requires `chatExplicitContextV1Enabled`) |

A flag is flipped to default-on only after CI shows that feature's tests green.

## 3. Bindings

### 9.1 Work Passport

- **Compute:** in `resolveChatFeatureAdmission`, when `chatWorkPassportV1Enabled` is on and the admission is new (not durable replay), call a new host port `classifyWorkPassport(workspaceId, content)` that the Gateway backs with `WorkPassportService.classify`. Classification is local and deterministic; it reads only the operator-authored baseline.
- **Persist:** add `workPassport` to `chatTurnFeatureReferencesSchema`, validated by the existing `assertWorkPassportRecord`. It is bound with the rest of the turn's references and reused on replay, so a durable resume renders the same passport even if the baseline changed meanwhile.
- **Route pin:** a passport does not depend on the provider route. A passport-only admission pins the route when one is resolved and otherwise binds without one, so turning the flag on cannot make a route-less turn fail.
- **Inject:** after feature admission, prep upserts one system instruction built from the admitted references (`upsertChatTurnBindingSystemInstruction`). The passport lines are the ones the profile builder used (boundary, consequence, review, action, evidence requirements, the "advisory, not an assessment of the operator" sentence). The profile builder and the new builder share one formatter. The force-action rebuild of history re-applies the same instruction.
- **Not:** the passport grants nothing, changes no tool exposure, and is not part of the compaction dimension (that hash still uses only route and selected skills).

### 9.2 Workspace snapshots

- **Admit:** a request carrying `workspaceSnapshot` is accepted for a new turn only when `chatWorkspaceSnapshotV1Enabled` is on and the turn has an operator turn admission. Otherwise the existing "temporarily unavailable" rejection becomes a precise one ("Workspace snapshots require enabled durable Chat admission").
- **Capture:** `resolveChatFeatureAdmission` receives the request and calls a new host port `captureWorkspaceSnapshot({ sessionId, turnId, workspaceId, request })`, backed by the existing `ChatWorkspaceSnapshotService.capture` (path-bridge verified, content-free Git receipt, `unavailable` with a reason code when anything is missing).
- **Persist:** add `workspaceSnapshot` to the references schema with a strict zod mirror of `ChatWorkspaceSnapshotRecord`, plus a check that the record's `workspaceId` equals the admission workspace. The references are bound under the admission identity, which carries the `turnId`, and the capture service binds each `requestId` to exactly one `turnId`. That makes it a turn-scoped immutable record keyed by `turnId`. Replay reads it back and never recaptures.
- **Inject:** the same turn-binding instruction renders it with the existing snapshot formatter ("point-in-time ... grants no filesystem authority; refresh only on a new turn").
- **Not:** the record grants no tool, path or filesystem authority. Edit and retry schemas still omit `workspaceSnapshot`; a refresh is a new request on a new turn.

### 9.3 Model council

- **Admit:** `modelCouncil.enabled` is accepted for a new turn only when `chatModelCouncilV1Enabled` is on, the turn has an operator turn admission, and the turn carries no explicit context and is not a delegated child (the admission-bound v3 context snapshot and delegated budgets are not council inputs in this version). The `ConflictError` at ~L685 is removed for that case.
- **Persist:** add `modelCouncil: { version: "chat.model-council.admission.v1" }` to the references so the request itself is immutable evidence and a durable replay keeps running the council. A request without the flag on replay of an admitted council turn is honored from the record; a new request is never inferred.
- **Bind:** `ExecuteChatModelCouncilInput.capabilityProfile` becomes `binding: ModelCouncilBinding` — `{ bindingId, bindingHash, turnId, sessionId, workspaceId, primaryProviderId, primaryModel, thinkingLevel }`. For historical profile turns the Gateway derives it from the profile (`profileId`, `profileHash`, profile readiness). For new turns it derives it from the admission: `bindingId = feature-admission:<admissionId>`, `bindingHash = referenceSha256`, primary route from `references.providerRoute.primary`, thinking level from the prepared prefs. The persisted council resolution keeps its existing `capabilityProfileId` / `capabilityProfileHash` columns and stores the binding id and hash in them, so stored runs stay readable and recovery still refuses a changed binding.
- **Live catalog with per-member policy recheck:** council members stay advisory and tool-free (`toolsAllowed: false`), so they never see a tool catalog. Each candidate route is rechecked at selection time against current authority: provider configured or local, trusted context-window metadata, a current route-config fingerprint, the xAI/Grok exclusion, and `llmService.admitsDispatchWard` for `model.chat.<providerId>` with `assembly_participant` attribution (deny-wins, `route_local`). A member that fails is dropped before resolution; the dispatch-time ward guard still rechecks every call. The primary must pass or the council fails closed.
- **Not:** no frozen catalog or tool list. Routed-context council inputs remain historical-profile only.

### 9.4 Explicit context on edit, retry and child steps

Trace on `main` (2026-10-19): a retry or edit that *re-sends* `contextRefs` already gets a fresh operator turn admission and passes the fresh-explicit-context gate (`chat-turn-entry-service.ts` retry ~L1514/1646, edit ~L1807; existing tests `chat-turn-entry-service.test.ts` ~L1150, ~L1404). Nothing re-admits the source turn's context when the client omits the refs, so a plain "retry" silently drops it; the contract line saying edit/retry is unavailable was never enforced. Child turns are rejected (`chat-turn-prep-service.ts` ~L672, `chat-local-delegation-authority.ts` ~L72).

- **Edit/retry (re-admit):** with `chatExplicitContextBranchesV1Enabled` on, when a retry or edit request carries no `contextRefs` and the source turn has an admitted routed-context snapshot (`storage.routedContextSnapshots.findByTurn(sourceTurnId)`), the entry service rebuilds the ordered `{ kind, ref, label }` list from the snapshot's entries and sends it through the normal fresh admission on the new turn. The new turn gets its own v3 snapshot bound to its own admission identity, with current access and provenance checks; the source snapshot is never reused or mutated (`beginDurableChatRun` still refuses a snapshot whose `turnId` differs). Refs sent explicitly win over inherited ones; an explicit empty array opts out.
- **Child delegation (inherit, re-validate):** with the flag on, a delegated child turn whose parent durable turn admitted explicit context inherits the parent's refs. The child resolves the parent turn through its delegation run (`chatDelegationRuns` → `parentRunId` → the parent's durable payload `turnId`, `routedContextSnapshotId`, `routedContextSnapshotHash`), checks that the parent snapshot id/hash match, rebuilds the refs from that snapshot, and runs a fresh admission bound to the child's own admission. Re-validation happens in that admission: current session scope (shared sessions stay session-only), source access, provenance, and the child's own provider budget. A child request can never carry its own `contextRefs`; the local delegation authority keeps rejecting them, and the inherited refs are server-derived. The prep gate that requires an operator actor for fresh refs admits the child only on this server-derived path.
- **Unchanged rules:** durable admission required, subagent policy `off` for the admitted turn, direct route, no integration delivery, no automatic fan-out from an explicit-context parent.

## 4. Testing

- Contract tests for each new references field (strict decode, identity mismatch rejection, 64 KiB limit).
- `chat-feature-admission-service.test.ts`: passport and snapshot computed only with their flags on, reused on replay, passport-only admission without a route.
- `chat-turn-prep-service.routed-context.test.ts` ~L752: the snapshot and council rejections become acceptance tests with the flags on, plus "still rejected with the flag off" cases.
- `chat-turn-prep-service.work-passport.test.ts`: the turn-binding instruction renders a passport from feature references.
- `chat-turn-capability-profile-service.test.ts`: historical profile passport/snapshot behavior is unchanged.
- `assembly-service.test.ts` / a new council-binding test: live binding resolution, ward-refused member dropped, refused primary fails closed, recovery refuses a changed binding.

## 5. Docs

As each feature lands, remove its "temporarily unavailable" sentence from `docs/1_0_CONTRACT.md` and `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, and add its flag and restrictions to `docs/testing/FEATURE_QUALITY_EXECUTION.md`.
