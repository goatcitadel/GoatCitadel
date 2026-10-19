# Citadel Vault per-Chamber keys and rotation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seal every Citadel Vault secret under a per-scope (Citadel scope or Chamber) data key wrapped by the keychain-held Citadel KEK, migrate legacy secrets, and add approval-gated, resumable DEK and KEK rotation with Cockpit controls.

**Architecture:** Crypto lives in a new Gateway key service; storage stays plaintext-free and applies ciphertext-only commands with compare-and-set guards under the existing Citadel lock. Rotation is a ledger row advanced by an approval effect and executed by a runner shared by boot recovery and explicit resume.

**Tech Stack:** TypeScript, Node `crypto` AES-256-GCM, SQLite + Postgres via `DatabaseClient`, Fastify, React (mission-control-next), vitest, `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-19-vault-chamber-keys-design.md` (section numbers below are the spec's).

## Global Constraints

- Load rules (mandatory): before a heavy command check `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` for another session's vitest/tsx/tsc; one heavy command at a time; BelowNormal priority; only changed test files; vitest `--maxWorkers=2`; storage `tsx --test --test-concurrency=3` at most; never `verify:*` or full suites; never wrap tests in a timeout; single-package typecheck only.
- Never `git stash`; use `git grep`; never `architecture:baseline:update` (consolidate `host.X` or add an owner file with an allowance).
- New Postgres schema: additive migration after v216 plus a convergence migration; real-Postgres tests on fresh and upgraded lineages; `pnpm update:storage:migration-manifest`; bump literals in `scripts/verify-storage-migration-parity.test.mjs`, the tripwire in `packages/storage/src/postgres-migrator.test.ts`, and the in-SQL `expected_column_count` guard.
- SQLite tests through `TempSqliteFiles`. Gateway tests that `vi.mock("@goatcitadel/storage")` must spread new real exports.
- No plaintext, key bytes, wrapped DEKs or ciphertext in logs, audit, realtime, idempotency records, errors or responses. Synthetic token fixtures only.
- AAD JSON exactly as spec §4 (`purpose` `goatcitadel.vault.dek-wrap` / `goatcitadel.vault.secret`, `v: 2`, fixed key order).
- Keychain accounts: KEK v1 = `citadel:<citadelId>:vault_master_key`; v≥2 = `citadel:<citadelId>:vault_kek:v<n>`.
- Error codes verbatim: `VAULT_KEYCHAIN_UNAVAILABLE` (503), `VAULT_KEY_MISSING`, `VAULT_ROTATION_IN_PROGRESS`, `VAULT_KEY_CHANGED`, `VAULT_LEGACY_SECRETS_PRESENT`, `CITADEL_ARCHIVED` (409); ledger codes `unwrap_failed`, `open_failed`, `keychain_unavailable`, `keychain_write_unverified`, `kek_rotation_unavailable`.
- Approval kind `citadel.vault.key_rotation`, risk `danger`. Revision schema `citadel.vault.v2`.
- No personal paths in tracked files. PRs against main, each `Refs #443` and `Refs #341`; only the last says `Closes #443`. Security-reviewer pass before opening PR 3 and PR 4. Read `DESIGN.md` and `PRODUCT.md` before PR 5.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push with `git -c credential.helper='!gh auth git-credential' push`.

## Review Focus

1. A secret replaced by the operator while a rotation batch holds its old envelope — expect the operator's value to win and the batch to skip the row (Task 9 test `batch skips a row changed after it was read`).
2. Keychain entry deleted between two Vault operations on a Citadel with secrets — expect `VAULT_KEY_MISSING` and no new keychain entry written (Task 5 test `never regenerates a KEK while sealed data exists`).
3. Gateway killed after the new KEK is written to the keychain but before re-wrap commits — expect every secret still revealable and resume to finish (Task 10 test `resumes from each KEK crash window`).
4. A rotation reason that contains a credential-looking string — expect 400 and nothing stored (Task 11 test `rejects a reason that looks like a credential`).
5. A Citadel whose only legacy row cannot be opened — expect upgrade to leave it untouched, KEK rotation refused with `VAULT_LEGACY_SECRETS_PRESENT`, and reveal of other secrets unaffected (Task 6 test `leaves an unreadable legacy row in place`).

## File map

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/citadel-vault.ts` | Contract types (§8), `SealedValueV2`, AAD builders, error code constants |
| `packages/contracts/src/citadel-vault-node.ts` | `sealValue`/`openValue` with optional AAD; `wrapKey`/`unwrapKey` |
| `packages/storage/src/citadel-vault-key-schema.ts` (new) | DDL for key tables + secret columns, both engines, convergence SQL |
| `packages/storage/src/citadel-vault-key-repo.ts` (new) | Key rows, key state, rotation ledger, CAS batch apply |
| `packages/storage/src/citadel-vault-repo.ts` | Scope-aware store/move, active-key check, v2 snapshot digest |
| `apps/gateway/src/services/citadel-vault-key-service.ts` (new) | KEK resolution, DEK create/unwrap, seal/open with AAD, legacy upgrade |
| `apps/gateway/src/services/citadel-vault-rotation-service.ts` (new) | Ledger runner, approval request/effect, resume, audit |
| `apps/gateway/src/services/citadels-route-service.ts` | Delegates Vault crypto to the key service |
| `apps/gateway/src/routes/citadels.ts` | Move, rotation routes |
| `packages/mission-control-shared/src/api/citadels.ts` | Client calls |
| `apps/mission-control-next/src/cockpit/areas/settings/CitadelVaultKeys.tsx` (new) | Cockpit Keys section |

---

## PR 1 — Design (docs only)

### Task 1: Ship spec and plan

- [ ] **Step 1:** Open PR with the spec and this plan (`docs: design per-Chamber Vault keys and rotation`), body `Refs #443`, `Refs #341`.
- [ ] **Step 2:** After merge, tick the "Design note" box in #443.

## PR 2 — Contracts and storage (no Gateway behavior change)

### Task 2: Crypto primitives with AAD

**Files:** Modify `packages/contracts/src/citadel-vault-node.ts`, `packages/contracts/src/citadel-vault.ts`; Test `packages/contracts/src/citadel-vault.test.ts`

**Interfaces — Produces:**
- `sealValue(plaintext: string, key: Buffer, aad?: Buffer): SealedValue` / `openValue(sealed: SealedValue, key: Buffer, aad?: Buffer): string` (no `aad` = legacy behavior, unchanged)
- `wrapKey(dek: Buffer, kek: Buffer, aad: Buffer): SealedValue` / `unwrapKey(wrapped: SealedValue, kek: Buffer, aad: Buffer): Buffer` (asserts 32 bytes)
- `interface SealedValueV2 extends SealedValue { v: 2; keyId: string }`
- `vaultSecretAad(i: { citadelId: string; chamberId: string | null; secretId: string; keyId: string }): Buffer`
- `vaultDekWrapAad(i: { citadelId: string; chamberId: string | null; keyId: string; dekVersion: number; kekVersion: number }): Buffer`
- `VAULT_ERROR_CODES` const with the six codes from Global Constraints.

- [ ] **Step 1: Write failing tests** — `seal/open round-trips with AAD`; `open fails when AAD differs in any of citadelId, chamberId, secretId, keyId` (expect throw for each field changed); `vaultSecretAad emits exact canonical JSON` (expect `{"purpose":"goatcitadel.vault.secret","v":2,"citadelId":"c1","chamberId":null,"secretId":"s1","keyId":"k1"}`); `vaultDekWrapAad emits scope "citadel" for null chamber and "chamber" otherwise`; `unwrapKey rejects a non-32-byte payload`; `legacy open without AAD still opens a v1 fixture`.
- [ ] **Step 2:** Run `pnpm --filter @goatcitadel/contracts exec vitest run src/citadel-vault.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3:** Implement. AAD via `cipher.setAAD(aad)` before update. Canonical JSON built by explicit object literal in spec order.
- [ ] **Step 4:** Re-run → PASS. Rebuild contracts (`pnpm --filter @goatcitadel/contracts build`) since storage tests read dist.
- [ ] **Step 5:** Commit `feat(contracts): bind Vault envelopes with AEAD associated data`.

### Task 3: Contract types for scopes, keys and rotation

**Files:** Modify `packages/contracts/src/citadel-vault.ts`; Test same test file.

**Interfaces — Produces:** exactly the §8 types: `CitadelVaultScope`, extended `CitadelVaultSecretMetadata` (`chamberId: string | null`, `keyVersion: number | null`), `CitadelVaultScopeKeyMetadata`, `CitadelVaultKeyMetadata`, `CitadelVaultRotationView` (phase union includes `approved`), `CitadelVaultSnapshot.keys`. `CitadelVaultMutation.change` gains `{ type: "store"; secretId: string; secretName: string; chamberId: string | null; keyId: string; sealedValue: SealedValueV2 }` and `{ type: "move"; secretId: string; chamberId: string | null; keyId: string; sealedValue: SealedValueV2 }`; `delete` unchanged. `toVaultSecretMetadata` maps the new fields.

- [ ] **Step 1:** Failing test `toVaultSecretMetadata never copies sealedValue and maps chamberId/keyVersion`.
- [ ] **Step 2–4:** Run → FAIL; implement; run → PASS; typecheck contracts (`pnpm --filter @goatcitadel/contracts typecheck`) and note breakages in storage/gateway for Tasks 4–8.
- [ ] **Step 5:** Commit `feat(contracts): add Vault scope, key and rotation contracts`.

### Task 4: Schema and migrations (both engines, both lineages)

**Files:** Create `packages/storage/src/citadel-vault-key-schema.ts`; Modify `packages/storage/src/sqlite.ts` (append v269 `citadel_vault_chamber_keys`), `packages/storage/src/postgres/migrations.ts` (append v217 `citadel_vault_chamber_keys` and v218 `citadel_vault_chamber_keys_convergence`), `packages/storage/src/postgres-migrator.test.ts`, `scripts/verify-storage-migration-parity.test.mjs`, migration manifest; Test create `packages/storage/src/citadel-vault-key-schema.test.ts`, extend `packages/storage/src/citadel-vault-revisions.postgres.test.ts`.

**Interfaces — Produces:** tables/columns exactly as spec §5.1 including `citadel_vault_key_state.legacy_reads_closed INTEGER NOT NULL DEFAULT 0`; partial unique index one `active` per (`citadel_id`, `COALESCE(chamber_id,'')`); partial unique index one non-terminal rotation per Citadel (phase not in `completed`,`cancelled`,`failed`).

- [ ] **Step 1: Failing SQLite tests** (TempSqliteFiles): `migration preserves existing sealed rows with envelope_version 1 and null key_id/chamber_id`; `rejects a second active key for the same scope`; `rejects a second open rotation for a Citadel`; `allows a Citadel-scope and a Chamber-scope active key side by side`.
- [ ] **Step 2:** Run `pnpm --filter @goatcitadel/storage exec tsx --test --test-concurrency=3 src/citadel-vault-key-schema.test.ts` → FAIL.
- [ ] **Step 3:** Implement DDL in the schema module; SQLite migration calls it. Postgres v217 additive SQL; v218 frozen convergence SQL that makes an upgraded lineage match the v2 render (types, index names/sort, dropped CHECKs) — model on v214 `mail_drafts_schema_convergence`.
- [ ] **Step 4:** Run the SQLite test → PASS. Add real-Postgres tests (skipped without `GOATCITADEL_TEST_POSTGRES_URL`): `fresh lineage matches canonical shape` and `upgrade lineage (migrate to v216, then full) matches canonical shape and preserves sealed rows`. Run them only if a disposable local PG is available; otherwise CI proves them.
- [ ] **Step 5:** `pnpm update:storage:migration-manifest`; bump parity literals and tripwire counts (tables +3, columns as counted, indexes as counted); run `node --test scripts/verify-storage-migration-parity.test.mjs` and `pnpm --filter @goatcitadel/storage exec tsx --test src/postgres-migrator.test.ts` → PASS.
- [ ] **Step 6:** Commit `feat(storage): add Vault key, key-state and rotation tables`.

### Task 5: Key repository (key rows, key state, ledger)

**Files:** Create `packages/storage/src/citadel-vault-key-repo.ts`; wire in `packages/storage/src/citadel-repo.ts` (same lock context as `CitadelVaultRepository`); export from storage index; Test create `packages/storage/src/citadel-vault-key-repo.test.ts`.

**Interfaces — Produces** (`CitadelVaultKeyRepository`, all synchronous inside `withLock`):
- `getKeyState(citadelId): VaultKeyStateRow | undefined`; `ensureKeyState(citadelId, kekVersion: number): VaultKeyStateRow`
- `listKeys(citadelId): VaultKeyRow[]`; `getActiveKey(citadelId, chamberId: string | null): VaultKeyRow | undefined`
- `insertActiveKey(input: { citadelId; chamberId: string | null; keyId; dekVersion; kekVersion; wrappedDek: SealedValue }): VaultKeyRow` — fails `VAULT_KEY_CHANGED` if an active key already exists (lazy-creation race)
- `hasSealedData(citadelId): boolean` (any key row or secret row)
- `readSealedRows(citadelId, filter: { keyId?: string; legacyOnly?: boolean; limit: number }): VaultSealedRow[]` — trusted read (sealed JSON + ids)
- `applyResealBatch(citadelId, items: Array<{ secretId; expectSealedJson; expectKeyId: string | null; next: SealedValueV2 }>): { applied: number; skipped: number }` — row CAS per spec §5.3/§6.2
- `closeLegacyReads(citadelId): boolean` — sets flag only if zero v1 rows (same transaction)
- Ledger: `createRotation(input): VaultRotationRow` (fails `VAULT_ROTATION_IN_PROGRESS`), `getRotation(citadelId, rotationId)`, `getOpenRotation(citadelId)`, `listOpenRotations(): VaultRotationRow[]`, `advanceRotation(rotationId, fromPhase, patch): VaultRotationRow` (phase CAS), `startDekRotation(...)`, `finishDekRotation(rotationId): boolean` (deletes old key only if unreferenced), `rewrapAll(citadelId, rotationId, rewrapped: Array<{ keyId; wrappedDek; kekVersion }>, toKekVersion)`.

- [ ] **Step 1: Failing tests:** `applyResealBatch skips a row changed after it was read`; `finishDekRotation refuses while any row names the old key`; `closeLegacyReads is a no-op while a v1 row remains`; `advanceRotation rejects a stale fromPhase`; `rewrapAll updates every key and kek_version atomically (forced failure rolls back all)`; `createRotation rejects a second open rotation`.
- [ ] **Step 2–4:** Run (`… tsx --test src/citadel-vault-key-repo.test.ts`) → FAIL; implement; → PASS.
- [ ] **Step 5:** Commit `feat(storage): add Vault key repository with CAS batches`.

### Task 6: Scope-aware Vault repository

**Files:** Modify `packages/storage/src/citadel-vault-repo.ts`; Test extend `packages/storage/src/citadel-vault-revisions.test.ts` and `citadel-vault-revisions.test-support.ts` (run on both engines).

**Interfaces — Consumes:** Task 3 mutation shape; Task 5 `getActiveKey`. **Produces:** `mutate` handles `store` (verifies supplied `secretId` equals the existing row for that name or the name is free; `chamberId` must belong to the Citadel → 404; `keyId` must be scope's active key → `VAULT_KEY_CHANGED`; rejects any envelope without `v: 2`), `move`, `delete`; snapshot includes `keys` metadata and v2 digest per spec §8 (covers item `chamberId`, KEK version, open rotation id+phase only).

- [ ] **Step 1: Failing tests:** `store with a mismatched secretId is a revision conflict`; `store under a retiring key is refused with VAULT_KEY_CHANGED`; `store with a foreign chamberId is 404`; `v1 envelope writes are rejected`; `digest ignores keyVersion, counts and legacy upgrade but changes on rotation phase`; existing six race scenarios still pass with v2 commands.
- [ ] **Step 2–4:** Run → FAIL; implement; → PASS (SQLite locally; PG in CI).
- [ ] **Step 5:** Commit `feat(storage): scope Vault secrets to Chambers with active-key checks`. Open PR 2.

## PR 3 — Gateway key hierarchy (security-reviewer pass first)

### Task 7: Key service

**Files:** Create `apps/gateway/src/services/citadel-vault-key-service.ts`; Test `apps/gateway/src/services/citadel-vault-key-service.test.ts`.

**Interfaces — Consumes:** Task 2 primitives, Task 5 repo, `SecretStoreService` (`isAvailable`, `getSecret`, `setSecret`, `deleteSecret`, `isWriteCustodySafe`). **Produces** `CitadelVaultKeyService`:
- `resolveKek(citadelId): { ok: true; kek: Buffer; version: number } | { ok: false; code: "VAULT_KEYCHAIN_UNAVAILABLE" | "VAULT_KEY_MISSING" }` — generates only when `!hasSealedData`; new KEK after deletions takes version n+1 and audits `citadel.vault.kek_created`
- `withScopeKey<T>(citadelId, chamberId: string | null, fn: (dek: Buffer, keyId: string) => T)` — lazily creates the scope DEK, zeroes buffers in `finally`
- `sealForStore(citadelId, chamberId, secretId, plaintext): SealedValueV2 & { keyId }`
- `open(record): string` — v2 with AAD; v1 only when `legacy_reads_closed = 0`, else throws `open_failed`
- Dev-verification mode: constructor flag `custody: "os_keychain" | "dev_verification"`.

- [ ] **Step 1: Failing tests** (fake in-memory secret store, synthetic fixtures): `never regenerates a KEK while sealed data exists`; `fails closed when keychain unavailable`; `refuses v1 read after legacy reads close`; `swapped blob from another Chamber fails to open`; `zeroes DEK buffers after use` (spy on `fill`); `no log or thrown message contains plaintext or base64 key material` (capture logger, assert fixture strings absent).
- [ ] **Step 2–4:** Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/citadel-vault-key-service.test.ts --maxWorkers=2` → FAIL; implement; → PASS.
- [ ] **Step 5:** Commit `feat(gateway): add Citadel Vault key service`.

### Task 8: Legacy upgrade, store/reveal/move through the key service

**Files:** Modify `apps/gateway/src/services/citadels-route-service.ts` (replace `VaultKeyProvider` use), `gateway-route-composition-runtime.ts` (build key service instead of `vaultKey`), `gateway-route-services.ts`, `apps/gateway/src/routes/citadels.ts` (`chamberId?` on store; new `POST …/vault-secrets/:secretId/move`); Test extend `apps/gateway/src/routes/citadels.vault-revisions.test.ts`, add `apps/gateway/src/services/citadel-vault-legacy-upgrade.test.ts`.

**Interfaces — Produces:** `upgradeLegacyVault(citadelId): { upgraded: number; unreadable: number }`; `CitadelsRouteService.moveVaultSecret(citadelId, secretId, chamberId, expectedRevision)`; store retries once on `VAULT_KEY_CHANGED`.

- [ ] **Step 1: Failing tests:** `upgrade moves every legacy row to the Citadel scope and reveals the same values`; `leaves an unreadable legacy row in place`; `upgrade does not change the review revision`; `move re-seals into the Chamber and reveal still works`; `store retries once on VAULT_KEY_CHANGED then returns 409`; route tests: `503 VAULT_KEYCHAIN_UNAVAILABLE`, `409 VAULT_KEY_MISSING`, no-store headers on move, URL scope beats body.
- [ ] **Step 2–4:** Run each file → FAIL; implement; → PASS. Typecheck gateway once (`pnpm --filter @goatcitadel/gateway typecheck`), after confirming no other node typecheck is running.
- [ ] **Step 5:** Run `/security-review`-style pass with the security-reviewer agent over the PR 2–3 diff; fix findings. Commit `feat(gateway): seal Vault secrets under per-Chamber keys`. Open PR 3.

## PR 4 — Rotation (security-reviewer pass first)

### Task 9: DEK rotation runner

**Files:** Create `apps/gateway/src/services/citadel-vault-rotation-service.ts`; Test `apps/gateway/src/services/citadel-vault-rotation-service.test.ts`.

**Interfaces — Produces** `CitadelVaultRotationService`: `requestRotation({ citadelId; target: "dek" | "kek"; chamberId: string | null; reason: string; expectedRevision; actor }): { rotation: CitadelVaultRotationView; approvalId: string }`; `run(rotationId): Promise<CitadelVaultRotationView>` (idempotent, batch size 50); `resumeInterrupted(): Promise<void>`; `cancel(rotationId)` (only `awaiting_approval`).

- [ ] **Step 1: Failing tests:** `DEK rotation re-seals every row and shreds the old key`; `crash after N batches resumes and completes` (throw from the batch apply after batch 1, then `run` again); `batch skips a row changed after it was read`; `new stores during resealing use the new key`; `phase changes advance the revision, batches do not`; `every audit payload is free of plaintext and key material`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(gateway): add resumable Vault DEK rotation`.

### Task 10: KEK rotation

**Files:** same service + test.

- [ ] **Step 1: Failing tests:** `resumes from each KEK crash window` (three cases from spec §6.3 table, each leaves every secret revealable and ends `completed` with only v(n+1) in the keychain); `refuses with VAULT_LEGACY_SECRETS_PRESENT while v1 rows remain`; `refuses when isWriteCustodySafe is false`; `keychain_write_unverified when read-back differs`; `kek_rotation_unavailable under dev verification`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(gateway): add crash-safe Vault KEK rotation`.

### Task 11: Approval effect, routes, boot resume

**Files:** Modify `packages/contracts/src/approvals.ts` (+ `approvals.test.ts` union test), `apps/gateway/src/services/approval-resolution-effects-service.ts` (upsert builder + dispatcher case), `apps/gateway/src/services/gateway-service.ts` (startup `resumeInterruptedVaultRotations()` next to `resumeInterruptedMediaJobs()`), `apps/gateway/src/routes/citadels.ts` (rotation routes per §8); Test `apps/gateway/src/routes/citadels.vault-rotation.test.ts`.

**Interfaces — Produces:** `CITADEL_VAULT_KEY_ROTATION_APPROVAL_KIND = "citadel.vault.key_rotation"`, `CITADEL_VAULT_KEY_ROTATION_EFFECT_KIND`; `executeApprovedRotation(approvalId)` moves `awaiting_approval → approved` (verifies `payloadHash`) and signals the runner; denial/expiry → `cancelled`.

- [ ] **Step 1: Failing tests:** `POST vault-rotations returns 202 with approvalId and does nothing cryptographic`; `approved effect advances to approved and the runner completes`; `replayed effect is a no-op`; `denied approval cancels`; `rejects a reason that looks like a credential`; `409 VAULT_ROTATION_IN_PROGRESS`; `archived Citadel refuses rotation`; `boot resume skips when keychain unavailable`; `boot step also runs upgradeLegacyVault per Citadel and never blocks startup on failure`.
- [ ] **Step 2–4:** FAIL → implement → PASS (also run `approvals.test.ts` in contracts).
- [ ] **Step 5:** Security-reviewer pass over the rotation diff; fix. Commit `feat(gateway): approval-gate and resume Vault key rotation`. Open PR 4.

## PR 5 — UI and docs (`Closes #443`)

### Task 12: Shared client + Cockpit keys section

**Files:** Modify `packages/mission-control-shared/src/api/citadels.ts`; Create `apps/mission-control-next/src/cockpit/areas/settings/CitadelVaultKeys.tsx` (+ test); Modify `CitadelVaultSettings.tsx`, `CitadelVaultSecretControls.tsx` (Chamber picker, Move to Chamber), their tests.

- [ ] **Step 0:** Read `DESIGN.md`, `PRODUCT.md`.
- [ ] **Step 1: Failing tests:** `shows custody, KEK version and one row per scope`; `Rotate key requires a reason and shows Waiting for approval`; `shows progress then completion`; `VAULT_KEY_MISSING and VAULT_KEYCHAIN_UNAVAILABLE have distinct copy`; `"not available" copy is gone`; `store defaults to Citadel scope`; `no copy implies per-member isolation` (assert absence of "member", "only you").
- [ ] **Step 2–4:** `pnpm --filter @goatcitadel/mission-control-next exec vitest run <files> --maxWorkers=2` FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(cockpit): expose per-Chamber Vault keys and rotation`.

### Task 13: Classic copy, release scope, docs, proof

**Files:** `CitadelVaultRoutePage.tsx` (+ test), `apps/mission-control-next/src/app/route-release-scope.ts`, `docs/CITADEL_VAULT_REVISIONS.md`, `docs/1_0_CONTRACT.md`, `scripts/verification/lib/scenarios/cockpit-citadel-vault-proof.mjs` if its assertions cover removed copy.

- [ ] **Step 1:** Update tests for new copy → FAIL → update copy → PASS.
- [ ] **Step 2:** Docs: key hierarchy, AAD binding, migration, rotation phases and recovery, error codes, threat model summary, single-host custody; 1.0 contract line for Vault.
- [ ] **Step 3:** `pnpm docs:check`; `git diff --check`. Visual baselines for the Vault screens are regenerated by CI's lane, not locally (all-or-nothing gate).
- [ ] **Step 4:** Commit `docs: document per-Chamber Vault keys and rotation`. Open PR 5 with `Closes #443`, `Refs #341`; tick remaining #443 boxes.
