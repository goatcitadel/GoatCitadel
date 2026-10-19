# Citadel Vault: per-Chamber keys and key rotation — design

Status: draft for operator approval. No implementation code exists yet.
Tracks: goatcitadel/GoatCitadel#443 (part of #341). E2EE is out of scope.

## 1. Why

Today every Vault secret in a Citadel is sealed directly with one AES-256-GCM
key held in the OS keychain (`citadel:<citadelId>:vault_master_key`). That
gives encryption at rest and nothing else:

- No Chamber has its own key, so "every Chamber has a lock" (spec §13) is not
  true for secrets, and a Chamber's secrets cannot be cryptographically
  destroyed on their own.
- The key can never be rotated. A suspected exposure has no remedy short of
  deleting and re-entering every secret.
- A sealed blob is not bound to anything. Someone who can write the database
  can copy one secret's envelope over another's (another name, another
  Citadel sealed with the same key during dev verification) and a reveal will
  return the wrong value without any error.
- The key provider silently generates a fresh key when the keychain entry is
  missing (`gateway-route-composition-runtime.ts`, `vaultKey`). On a machine
  whose keychain lost the entry, existing secrets become unreadable and new
  ones are sealed under a different key, with no signal to the operator.

Cockpit (`CitadelVaultSettings.tsx`) and Classic (`CitadelVaultRoutePage.tsx`)
both tell the operator per-Chamber keys and rotation are not available.

## 2. Goals, non-goals, anti-goals

Goals

- Envelope encryption: a Citadel key-encryption key (KEK) in the OS keychain
  wraps one data-encryption key (DEK) per scope; the DEK seals the secrets.
- A scope is either a Chamber or the Citadel itself ("Citadel scope", for
  secrets not filed under a Chamber).
- Every sealed secret is cryptographically bound to its Citadel, scope, secret
  ID and key.
- Existing secrets move onto the new hierarchy with no data loss. Readable
  legacy rows migrate with no operator action; a row the legacy key cannot open
  is left untouched until the operator restores the key or deletes it (§5.3).
- Operators can rotate one scope's DEK, or the Citadel KEK, from Cockpit. Each
  rotation is approval-gated, audited, resumable after a crash, and never
  writes plaintext or key material to storage, logs, audit or responses.
- Missing or unavailable keychain fails closed, and a missing KEK is never
  silently replaced while sealed data exists.

Non-goals

- E2EE, member key grants, agent key grants, recovery keys, backup keys and the
  user-root-key tiers of spec §13.4. The hierarchy leaves room for them.
- Using Chamber keys for anything other than Vault secrets (memory, files,
  transcripts). Same hierarchy can carry them later.
- Per-member access control between Chambers. See §9: all scopes are opened by
  the same Gateway process with the same KEK, so a Chamber key is a
  cryptographic scope, rotation unit and shred unit, not an access boundary
  between people.
- Hostile-host protection. A compromised Gateway process or OS account can
  read the keychain.

Anti-goals (would be failure even if it "works")

- Any path where a rotation crash leaves a secret sealed under a key that no
  longer exists.
- Any plaintext, DEK, KEK, wrapped DEK or ciphertext in logs, audit rows,
  realtime events, idempotency records, error messages or API responses.
- UI copy that implies per-member isolation or hostile-code protection.

## 3. Key hierarchy

```text
OS keychain                        Storage (SQLite / Postgres)
-----------                        ---------------------------
Citadel KEK v<n>  ──wraps──▶  DEK (Citadel scope, version m)  ──seals──▶ secrets with chamber_id NULL
 (one per Citadel,            DEK (Chamber A, version m)      ──seals──▶ secrets in Chamber A
  32 random bytes)            DEK (Chamber B, version m)      ──seals──▶ secrets in Chamber B
```

- **KEK.** 256-bit random, one active version per Citadel, stored only in the OS
  keychain. Account names: the existing `citadel:<citadelId>:vault_master_key`
  is KEK version 1 (no keychain rewrite during migration); later versions use
  `citadel:<citadelId>:vault_kek:v<n>`. Storage records which version is
  active; it never stores the KEK.
- **DEK.** 256-bit random, one active version per scope, created lazily the
  first time a scope seals a secret. Stored only wrapped: AES-256-GCM under the
  KEK with associated data (§4). At most two versions of a scope's DEK exist at
  once, and only while a rotation is in progress.
- **Algorithm.** AES-256-GCM, 96-bit random IV, 128-bit tag, for both wrapping
  and sealing — the primitive the Vault already uses, available in Node without
  new dependencies. Random IVs are safe here: each DEK seals far fewer than
  2^32 values over its life, and each KEK wraps a handful of DEKs.

Why envelope encryption, rather than one keychain entry per Chamber:

1. **Rotation cost.** Rotating the KEK re-wraps a few dozen DEKs in one
   transaction instead of re-sealing every secret. DEK rotation touches only
   that scope's secrets.
2. **Keychain footprint and failure surface.** One keychain entry per Citadel
   (plus one transient during KEK rotation) instead of one per Chamber. Every
   keychain write is a crash window; envelope encryption keeps those windows
   rare and ordered (§6.3).
3. **Atomicity.** Wrapped DEKs live in the same database transaction as the
   secrets they seal, so "which key seals this row" and "does that key exist"
   commit together. Keychain writes cannot join a database transaction.
4. **Room to grow.** Member/agent key grants (spec §13.6) become "wrap this DEK
   for that principal" without changing how secrets are sealed.

Cost accepted: an attacker with the database and the KEK gets everything —
the same as today. Per-Chamber keys do not change that (§9).

## 4. Binding a secret to its Chamber

Every wrap and seal uses AEAD associated data (AAD) built as canonical JSON
(fixed key order, no whitespace) from values the reader already knows from the
row and the request URL — never from the envelope itself.

DEK wrap AAD:

```json
{"purpose":"goatcitadel.vault.dek-wrap","v":2,"citadelId":"…","scope":"chamber","chamberId":"…","keyId":"…","dekVersion":3,"kekVersion":2}
```

(`scope` is `"citadel"` with `chamberId: null` for the Citadel scope.)

Secret seal AAD:

```json
{"purpose":"goatcitadel.vault.secret","v":2,"citadelId":"…","chamberId":"…"|null,"secretId":"…","keyId":"…"}
```

Effects:

- Copying a sealed blob to another secret, Chamber or Citadel fails the GCM tag
  check on reveal, because the reader rebuilds AAD from the target row.
- Copying a wrapped DEK to another Chamber or Citadel fails to unwrap.
- Changing a row's `key_id` to point at a different DEK fails.
- The secret name is not in the AAD; the immutable secret ID already pins
  identity, and names may become renameable later.

Secret ID before sealing. Sealing happens in the Gateway before the storage
command, so the Gateway must know the secret ID first. It reads the reviewed
snapshot: if the name exists at `expectedRevision`, it reuses that ID
(replacement already preserves IDs); otherwise it generates a UUID. Storage
then verifies, inside the Citadel lock, that the revision still matches and
that the supplied ID equals the existing row's ID for that name (or that the
name is free). A mismatch is the normal 409 `CITADEL_VAULT_REVISION_CONFLICT`.
Because the revision digest covers names and IDs, a match proves the mapping
the Gateway sealed against is still current.

The envelope gains explicit fields so readers never guess its format:

```ts
interface SealedValueV2 { v: 2; keyId: string; iv: string; ciphertext: string; tag: string }
// Legacy SealedValue (no `v`) is read as "v1: sealed directly under KEK v1, no AAD".
```

Known gap (accepted, §9): AAD does not include a per-write counter, so someone
with database write access can roll a secret back to an older envelope of the
same secret under the same key. DEK rotation ends that window for envelopes
older than the rotation.

## 5. Storage and migration

### 5.1 Schema (additive)

`citadel_vault_secrets` gains:

| Column | Type | Meaning |
| --- | --- | --- |
| `chamber_id` | TEXT NULL | Scope. NULL = Citadel scope. Must reference a Chamber of the same Citadel. |
| `key_id` | TEXT NULL | DEK that sealed this row. NULL = legacy v1 envelope under KEK v1. |
| `envelope_version` | INTEGER NOT NULL DEFAULT 1 | 1 legacy, 2 bound envelope. |

New `citadel_vault_keys` (one row per DEK version):

| Column | Type | Meaning |
| --- | --- | --- |
| `key_id` | TEXT PK | Random ID, also in AAD. |
| `citadel_id` | TEXT NOT NULL | |
| `chamber_id` | TEXT NULL | NULL = Citadel scope. |
| `dek_version` | INTEGER NOT NULL | Monotonic per scope. |
| `status` | TEXT NOT NULL | `active` \| `retiring` (the source DEK of an in-progress rotation, still used to open rows that name it). |
| `kek_version` | INTEGER NOT NULL | KEK version that wraps it. |
| `wrapped_dek_json` | TEXT NOT NULL | `{v,iv,ciphertext,tag}` of the DEK under the KEK. |
| `created_at`, `updated_at` | TEXT NOT NULL | |

Unique: (`citadel_id`, `chamber_id`, `dek_version`); at most one `active` per
scope (partial unique index on SQLite and Postgres; `chamber_id` NULL handled by
a generated scope key `COALESCE(chamber_id, '')`). A retired DEK row is
deleted — that deletion is the crypto-shred.

New `citadel_vault_key_state` (one row per Citadel):

| Column | Type | Meaning |
| --- | --- | --- |
| `citadel_id` | TEXT PK | |
| `kek_version` | INTEGER NOT NULL | Active KEK version (1 = legacy account name). |
| `kek_created_at`, `kek_rotated_at` | TEXT | |
| `legacy_reads_closed` | INTEGER NOT NULL DEFAULT 0 | 1 once no v1 row remains (§5.3). |

New `citadel_vault_rotations` (the rotation ledger, §6):

| Column | Type | Meaning |
| --- | --- | --- |
| `rotation_id` | TEXT PK | |
| `citadel_id` | TEXT NOT NULL | |
| `target` | TEXT NOT NULL | `dek` \| `kek` |
| `chamber_id` | TEXT NULL | Scope, for `dek`. |
| `from_key_id` / `to_key_id` | TEXT NULL | DEK rotation. |
| `from_kek_version` / `to_kek_version` | INTEGER NULL | KEK rotation. |
| `phase` | TEXT NOT NULL | see §6 |
| `approval_id` | TEXT NULL | |
| `requested_by`, `reason` | TEXT | Operator, short reason text (validated, no secrets). |
| `resealed_count`, `total_count` | INTEGER | Progress only. |
| `last_error_code` | TEXT NULL | Code only, never a message from crypto. |
| `created_at`, `updated_at`, `completed_at` | TEXT | |

At most one non-terminal rotation per Citadel (partial unique index), so
rotations never interleave.

### 5.2 Migrations on both lineages

- SQLite: one new numbered migration (next after v268, so v269 at time of writing) adds the three columns and three tables.
  Pure DDL; existing rows keep `envelope_version = 1`, `key_id NULL`,
  `chamber_id NULL`.
- Postgres: the matching additive migration (next after v216), plus a forward-only convergence
  migration so an upgraded install (where `canonical_runtime_schema` v2 was
  applied before these tables existed in the SQLite blueprint) ends with exactly
  the shape a fresh install renders from v2 — same pattern as
  `schema-convergence-v196.ts` / `-v200.ts` and v214 `mail_drafts_schema_convergence`. Both lineages get a real-Postgres
  test (fresh, and upgrade from the migration before these). Update the
  migration manifest (`pnpm update:storage:migration-manifest`), the parity
  test literals in `scripts/verify-storage-migration-parity.test.mjs`, and the
  column/table/index tripwire in `postgres-migrator.test.ts` plus the in-SQL
  `expected_column_count` guard in `postgres/migrations.ts`. SQLite tests use
  `TempSqliteFiles`.
- No down migration; the additive tables stay on application rollback. An older
  Gateway reading a v2 row would fail to open it (no AAD) and fail closed — it
  does not corrupt it. Upgrade cooperating Gateways together, as today.

### 5.3 Data migration: legacy secrets onto DEKs

The re-seal needs the KEK, so it cannot be a SQL migration. It is a Gateway
step, `upgradeLegacyVault(citadelId)`, which is idempotent and runs:

- before any Vault write or rotation for that Citadel, and
- once per Citadel in a startup reconciler when the keychain is available
  (never blocks boot; failures are recorded and retried next boot or next write).

Crypto never runs inside storage (the repository stays plaintext-free, §5.4).
For each batch of legacy rows the Gateway reads the sealed rows, then:

1. **Authenticate KEK v1 first.** Open the v1 envelopes with KEK v1 in memory.
   If legacy rows exist and none of them opens, stop: create no DEK, record the
   rows as unreadable and report `legacyUnreadableCount`. A keychain entry that
   was silently regenerated by the old code is present but wrong, and a DEK
   wrapped under it would become unwrappable once the original key is restored.
2. Only after at least one legacy row opened (or when there are no legacy rows),
   ensure the Citadel-scope DEK exists (create and wrap under KEK v1 if not).
3. Seal a v2 envelope under the Citadel-scope DEK with full AAD.
4. Open the new envelope and compare to the plaintext in memory; abort the row
   on mismatch.
5. Sends the batch of new envelopes to storage, which applies each under the
   Citadel lock as `UPDATE … SET sealed_value_json, key_id, envelope_version = 2
   WHERE secret_id = ? AND envelope_version = 1 AND sealed_value_json = <the
   value read>` — row-level compare-and-set, so a concurrent operator write wins
   and nothing is overwritten.

All legacy secrets land in the Citadel scope: today no secret belongs to a
Chamber, and guessing one would be wrong. Operators can then move a secret into
a Chamber (§8). The upgrade does not change names, IDs, `created_at` or
`updated_at`, and does not advance the review generation (metadata is
unchanged). A legacy row that cannot be opened (wrong or missing KEK) is left
untouched and reported as `legacyUnreadableCount`; it is never deleted.

**Closing the v1 read path (downgrade defence).** `citadel_vault_key_state`
gains `legacy_reads_closed` (0/1). When an upgrade pass ends with zero v1 rows
for the Citadel, the same transaction sets it to 1. From then on any row with
`envelope_version = 1` or `key_id NULL` in that Citadel is refused on reveal
(`open_failed`) instead of being opened without AAD, so pasting an old v1
envelope back into the table cannot return a wrong value. Storage also rejects
every write of an `envelope_version = 1` row once the Gateway seals bound
envelopes (PR 3); until then the legacy store path stays open so the existing
Gateway keeps working. Until a
Citadel's flag is set, the v1 path stays open only for rows that are still v1;
this residual window is listed in §10.

**Unreadable legacy rows.** A Citadel with `legacyUnreadableCount > 0` cannot
close its v1 path and cannot rotate its KEK (§6.3). The operator resolves it by
restoring the right keychain entry or deleting those secrets explicitly; the
system never does either on its own.

### 5.4 Storage invariants

- **No crypto in storage.** `CitadelVaultRepository` keeps its rule that
  plaintext never enters it. The Gateway does every open, seal, wrap and unwrap
  outside the lock and sends ciphertext-only commands; storage applies them
  atomically with compare-and-set guards. Storage gains a trusted read that
  returns sealed rows and wrapped DEKs to the Gateway's key service only (never
  to routes).
- **Active-key check.** Every store or move command names the `key_id` it
  sealed under. Inside the lock, storage refuses it with 409
  `VAULT_KEY_CHANGED` unless that key is the target scope's current `active`
  DEK. So a store sealed just before a rotation started can never land under a
  `retiring` key that is about to be shredded; the Gateway re-seals and retries
  once, then surfaces the 409. Rotation batches are the only writes that name
  the `to_key_id` while replacing a `from_key_id`.
- **KEK-version check.** Creating a data key (lazily, or as a rotation target)
  carries the KEK version that wrapped it. Inside the lock, storage accepts it
  only when `citadel_vault_key_state.kek_version` still matches; otherwise 409
  `VAULT_KEY_CHANGED` and the Gateway re-wraps under the current KEK and
  retries. Together with the re-wrap's key-set check (§6.3) this means a data
  key is never left wrapped only under a KEK that is about to be destroyed.
- **Shred check.** Deleting a DEK row happens in the same transaction that
  proves no secret row references it.
- **Deployment.** On Postgres the Citadel lock is already the transaction
  advisory lock plus profile row lock, so batches serialize across processes.
  But the KEK lives in one host's OS keychain, so the Vault supports exactly one
  Gateway host per database for custody (true today as well — a second host
  would generate its own key). This is documented, not newly enforced; a second
  host sees `VAULT_KEY_MISSING`, which now fails closed instead of forking keys.
- **Chamber lifecycle.** Chambers cannot be deleted today (structure changes
  only add or update them). Any future Chamber deletion must refuse while the
  scope holds secrets, then delete the scope's DEK rows as the shred. An
  archived Citadel refuses stores, moves and rotations, as it refuses writes
  today.

## 6. Rotation

### 6.1 Common rules

- Requested by an authenticated operator with the reviewed Vault
  `expectedRevision` (the same CAS as stores). A stale revision is 409 before
  anything is created.
- Creating the request inserts a ledger row in phase `awaiting_approval` and an
  approval request atomically: the ledger row is inserted, with the approval ID,
  from the approvals service's `onCreated` commit hook, so both commit or
  neither does. If that hook cannot share the approval's transaction, the
  ledger is inserted first and cancelled by a compensating step when approval
  creation fails; either way a failure-path test proves no orphan
  `awaiting_approval` row blocks later requests. Nothing cryptographic happens
  until approval. Denial or expiry moves it to `cancelled`. (Approval mechanism: §7.)
- A rotation needs a key to rotate: a DEK rotation is refused for a scope with
  no active data key, and a KEK rotation for a Citadel with no key state, both
  with 409 `VAULT_NO_KEY_TO_ROTATE` at request time. Cockpit disables the
  action for such rows. The first key of a scope is created lazily by its first
  store, never by a rotation.
- **No terminal failure after keys change.** `failed` and `cancelled` are
  reachable only from `awaiting_approval` and `approved` (before any key
  material changed). Once a rotation is `resealing`, `kek_staged` or
  `rewrapped`, an error is recorded in `last_error_code` and the rotation
  stays open, so it keeps blocking new rotations until resume finishes it. A
  scope can therefore never hold rows under two retiring keys.
- Rotation work runs in the Gateway, holds the Citadel lock per batch (never
  across the whole rotation), and keeps the Vault usable: reads and reveals
  continue; new stores seal under the newest key.
- Key material lives only in Buffers inside one call frame and is zeroed
  (`fill(0)`) when the call ends. JavaScript cannot guarantee no copies; this is
  best effort and stated as such.
- Errors from crypto are mapped to stable codes (`unwrap_failed`,
  `open_failed`, `keychain_unavailable`, `keychain_write_unverified`). Messages
  never include key IDs beyond the ledger's own, buffers, ciphertext or
  plaintext.
- Every phase transition writes an audit event (§7).
- Only one non-terminal rotation per Citadel. A KEK rotation and a DEK rotation
  cannot overlap.

### 6.2 Rotating a scope DEK

Phases: `awaiting_approval → approved → resealing → completed` (`cancelled` or `failed` only before `resealing`, §6.1).

1. When the runner picks up an `approved` ledger (one transaction): create DEK version m+1 wrapped under the
   active KEK with status `active`; set the old DEK to `retiring`; record
   `from_key_id`/`to_key_id`, `total_count`; phase `resealing`. From this commit,
   new stores in that scope seal under the new DEK.
2. Batches of N rows (default 50): the Gateway reads rows with
   `key_id = from_key_id`, opens with the old DEK, seals with the new DEK (AAD
   carries the new key ID) and verifies by opening — outside the lock. Storage
   then applies the batch in one transaction under the Citadel lock as
   `UPDATE … WHERE secret_id = ? AND key_id = from_key_id AND
   sealed_value_json = <value read>`; bump `resealed_count`. A row changed by a
   concurrent operator write is skipped by the CAS — that write already used the
   new DEK.
3. When no row references the old DEK (checked in the same transaction): delete
   the old DEK row (crypto-shred), phase `completed`, set `completed_at`,
   advance the review generation once.

Crash safety: every secret row always names the DEK that sealed it, and both
DEKs exist until no row references the old one. A crash at any point leaves
every secret readable. Resume = run step 2 again; it is idempotent because it
selects by `key_id`. The startup reconciler resumes any `resealing` rotation
when the keychain is available, and operators can resume explicitly.

"Roll back" is never needed for safety, but `cancel` is allowed in
`resealing`: it flips the new DEK to `retiring` and the old back to `active` and
re-seals the already-moved rows back with the same batch procedure — i.e., a
rotation in the other direction under the same ledger row. My call: offer
cancel only before approval in the first PR, and add cancel-while-resealing only
if wanted; resume is the primary recovery.

### 6.3 Rotating the Citadel KEK

Precondition, checked at request and again before staging: the Citadel has
no v1 rows (`legacySecretCount = 0`, so `legacy_reads_closed = 1`). Otherwise
the request is refused with 409 `VAULT_LEGACY_SECRETS_PRESENT`, because
destroying KEK v1 would shred those rows. DEKs do not change, so no secret is
re-sealed. Phases:
`awaiting_approval → approved → kek_staged → rewrapped → completed`.

1. **Stage (keychain first).** Generate KEK v(n+1); write
   `citadel:<id>:vault_kek:v<n+1>`; read it back and compare in memory
   (`keychain_write_unverified` on mismatch). Then phase `kek_staged`.
2. **Re-wrap (one transaction).** The Gateway reads every DEK row of the
   Citadel, unwraps each with KEK vn and re-wraps it with KEK v(n+1) (new AAD
   carries the new `kekVersion`), verifying each by unwrapping — outside the
   lock, like all crypto. Storage then, under the Citadel lock, re-enumerates the
   DEK rows and commits only if that set equals the set the Gateway re-wrapped
   (otherwise `VAULT_KEY_CHANGED` and resume re-reads, so a data key created
   meanwhile is included); it updates all rows and
   `citadel_vault_key_state.kek_version = n+1`, phase `rewrapped`. A Citadel has
   one DEK per scope plus at most one retiring one, so this is small.
3. **Destroy old KEK.** Delete the vn keychain entry (the legacy account name
   for v1), phase `completed`, advance the review generation once.

Crash windows, and why each is safe:

| Crash after | State | Resume does |
| --- | --- | --- |
| keychain write, before `kek_staged` | Orphan v(n+1) entry; storage still on vn | Ledger is still `approved`: overwrite the v(n+1) entry with a fresh KEK, read back, continue. The orphan was never referenced. |
| `kek_staged` | Both KEKs in keychain; storage on vn | Redo step 2 (idempotent: rows still name vn). |
| `rewrapped` | Both KEKs in keychain; storage on v(n+1) | Redo step 3. |

The database never references a KEK version that is not already in the
keychain, and the old KEK is deleted only after the database stops referencing
it. Running the dev-verification key (`devVerificationVaultKey`) makes KEK
rotation unavailable (`kek_rotation_unavailable`); DEK rotation still works.

A "full" rotation (KEK and every DEK) is two requests in sequence; not one
combined operation (my call — keeps each ledger simple).

## 7. Approval and audit

Rotation requests go through the Gateway's existing approval owner as a new
approval kind, so they appear in the normal Approvals surface and Chat approval
cards, obey deny-wins policy, and expire like other approvals. The approved
action is executed by the Gateway from the ledger row, not from client-held
state: approval only advances the ledger, and the rotation runner reads the row.

### 7.1 How it plugs into the existing owners

- **Approval request.** The rotation route calls the approvals service's
  `createApproval` (as `communications-dashboard-service.ts` does for mail
  send) with kind `citadel.vault.key_rotation`, `riskLevel: "danger"`, and a
  payload of `{ citadelId, rotationId, target, chamberId, fromVersion,
  toVersion, payloadHash }` — IDs and versions only. `payloadHash` covers that
  payload plus the ledger row's `created_at`, so an approval cannot be replayed
  onto a different rotation.
- **Approved effect.** Add `CITADEL_VAULT_KEY_ROTATION_EFFECT_KIND` to the
  `ApprovalEffectKind` union (`packages/contracts/src/approvals.ts`), an effect
  upsert builder called from `approval-resolution-effects-service.ts` when the
  approval resolves, and a dispatcher `case` that calls
  `CitadelVaultRotationService.executeApprovedRotation(approvalId)`. That method
  re-reads the approval (must be `approved`), re-verifies `payloadHash` against
  the ledger row, and only moves the ledger from `awaiting_approval` to
  `approved`, then signals the rotation runner. It never does the re-seal
  inside the effect, so effect timeouts and retries cannot interrupt a long
  rotation. The runner (the same code the boot step and explicit resume use)
  does the work from the ledger, so a replayed effect finds the ledger past
  `awaiting_approval` and reports already-done. Denial or expiry builds an
  effect that marks the ledger `cancelled`. Update the union-membership test.
- **Resume on boot.** A `resumeInterruptedVaultRotations()` step joins the
  existing startup recovery sequence in `gateway-service.ts` (next to
  `resumeInterruptedMediaJobs()`), runs only when the keychain is available,
  never blocks boot, and also runs the legacy upgrade (§5.3).
- **Keychain writes.** KEK staging uses `SecretStoreService.setSecret` then
  `getSecret` read-back, and refuses to start KEK rotation when
  `isWriteCustodySafe()` is false. Where Windows write receipts are available
  (`setSecretForCustody` / `hasCredentialWriteReceipt`), use them as extra
  proof; they are not required on other platforms.
- **Audit.** Events go through `storage.audit.append(stream, payload)` (payloads
  already pass `sanitizeForAudit`; attribution comes from the request). Approval
  lifecycle events use the existing `approvals` stream. The Vault events below
  use the same stream with an `event` field, unless adding a dedicated
  `vault_keys` value to `AuditStream` is free of schema impact — builder's call
  after checking the audit table constraints.

Audit events, fields limited to
IDs, versions, counts, phases, actor, approval ID and error codes:

`citadel.vault.legacy_upgrade` · `citadel.vault.kek_created` · `citadel.vault.dek_created` ·
`citadel.vault.rotation_requested` · `citadel.vault.rotation_approved` /
`_denied` / `_cancelled` · `citadel.vault.rotation_resumed` ·
`citadel.vault.rotation_completed` · `citadel.vault.rotation_failed` ·
`citadel.vault.dek_destroyed` · `citadel.vault.kek_destroyed` ·
`citadel.vault.secret_moved`.

Tests assert that no audit row, log line, realtime event or response for these
operations contains the plaintext, any key bytes, a wrapped DEK or a ciphertext
(using the repo's synthetic token fixtures as plaintext).

## 8. API and contract surface

Contract changes (`packages/contracts/src/citadel-vault.ts`):

```ts
export type CitadelVaultScope = { type: "citadel" } | { type: "chamber"; chamberId: string };

export interface CitadelVaultSecretMetadata {
  secretId: string; secretName: string; createdAt: string; updatedAt: string;
  chamberId: string | null;          // new
  keyVersion: number | null;         // new; null = legacy envelope awaiting upgrade
}

export interface CitadelVaultScopeKeyMetadata {
  chamberId: string | null; chamberName?: string;
  activeKeyVersion: number | null;   // null = no DEK yet (no secrets sealed)
  keyCreatedAt?: string;
  secretCount: number;
}

export interface CitadelVaultKeyMetadata {
  custody: "os_keychain" | "dev_verification";
  keychainAvailable: boolean;
  kekState: "ready" | "missing" | "unavailable";  // missing = sealed data exists but no keychain entry
  kekVersion: number | null; kekRotatedAt?: string;
  scopes: CitadelVaultScopeKeyMetadata[];
  legacySecretCount: number; legacyUnreadableCount: number;
  rotation?: CitadelVaultRotationView;  // the one non-terminal rotation, if any
}

export interface CitadelVaultRotationView {
  rotationId: string; target: "dek" | "kek"; chamberId: string | null;
  phase: "awaiting_approval" | "approved" | "resealing" | "kek_staged" | "rewrapped" | "completed" | "cancelled" | "failed";
  approvalId?: string; resealedCount: number; totalCount: number;
  lastErrorCode?: string; createdAt: string; updatedAt: string; completedAt?: string;
}

export interface CitadelVaultSnapshot { citadelId; revision; record?; items; keys: CitadelVaultKeyMetadata } // keys new
```

The revision digest moves to `schemaVersion: "citadel.vault.v2"`. Besides
today's inputs it covers each item's `chamberId`, the KEK version and the
non-terminal rotation's `rotationId` and `phase` — nothing else. Per-item
`keyVersion`, counts, lazy DEK creation and the background legacy upgrade are
excluded, so those never 409 an operator. Starting a rotation, each phase
change and completion (which also advances the generation) change the review;
individual batches do not. Old clients get one 409 and refresh, as the revision doc already says.

Routes (all under existing operator auth, URL scope authoritative, no-store
headers, generic idempotency as today):

| Operation | Body | Result |
| --- | --- | --- |
| `GET /api/v1/citadels/:citadelId/vault-secrets` | — | Snapshot with `keys` (unchanged path) |
| `POST /api/v1/citadels/:citadelId/vault-secrets` | `name`, `value`, `expectedRevision`, `chamberId?` (null/absent = Citadel scope; replacement keeps the existing scope unless given) | 201 snapshot |
| `POST /api/v1/citadels/:citadelId/vault-secrets/:secretId/move` | `chamberId \| null`, `expectedRevision` | 200 snapshot; re-sealed under the target scope's DEK; no plaintext in request or response |
| `POST /api/v1/citadels/:citadelId/vault-rotations` | `target: "dek" \| "kek"`, `chamberId?` (for `dek`, null = Citadel scope), `reason`, `expectedRevision` | 202 `{ rotation, approvalId }` |
| `GET /api/v1/citadels/:citadelId/vault-rotations/:rotationId` | — | `CitadelVaultRotationView` |
| `POST /api/v1/citadels/:citadelId/vault-rotations/:rotationId/resume` | — | 202 view; only for `approved`/`resealing`/`kek_staged`/`rewrapped` |
| `POST /api/v1/citadels/:citadelId/vault-rotations/:rotationId/cancel` | — | 200 view; only in `awaiting_approval` (first cut) |

Rotation request validation: `reason` is required, ≤200 chars, runs through the
existing secret-redaction check and is rejected if it looks like a credential.

Failure mapping: keychain unavailable → 503 `VAULT_KEYCHAIN_UNAVAILABLE`; KEK
missing with sealed data → 409 `VAULT_KEY_MISSING`; rotation already running →
409 `VAULT_ROTATION_IN_PROGRESS`; stale sealing key → 409 `VAULT_KEY_CHANGED`; KEK rotation with v1 rows left → 409 `VAULT_LEGACY_SECRETS_PRESENT`; nothing to rotate → 409 `VAULT_NO_KEY_TO_ROTATE`; unknown Chamber → 404; archived Citadel → 409
`CITADEL_ARCHIVED` (rotation of an archived Citadel is refused; restore first).

## 9. Keychain unavailable or key missing

- **Keychain unavailable** (`secretStore` absent or `isAvailable()` false):
  stores, reveals, moves, legacy upgrade and rotations return
  `VAULT_KEYCHAIN_UNAVAILABLE`. The metadata snapshot still loads (names,
  scopes, key versions, rotation phase) with `keychainAvailable: false`. A
  rotation mid-flight simply pauses; the reconciler resumes it later. No
  plaintext fallback, no in-memory substitute key.
- **KEK missing** (keychain works, but the entry for the active version — the
  legacy account for v1, `vault_kek:v<n>` otherwise, per
  `citadel_vault_key_state.kek_version` — is absent, and this Citadel has any
  DEK row or any secret row): fail closed with `VAULT_KEY_MISSING`; never generate.
  This replaces today's silent regeneration. Cockpit says the Vault key isn't in
  this machine's keychain and that sealed values can't be opened until it is
  restored. A new KEK is generated only when the Citadel has no DEK rows and no secret
  rows. If a key-state row already exists (all secrets were deleted), the new
  KEK takes version n+1, the key-state row is updated, and an audit event
  `citadel.vault.kek_created` records it. Key-state rows are never deleted.
- **Unwrap/open failure** (wrong key, tampering, swapped blob): reveal returns
  the existing `unavailable` result with code `open_failed`; nothing is retried
  with other keys, nothing is rewritten.

## 10. Threat model

Protects against:

- Theft or leakage of the database file, its backups or exports without the OS
  keychain (as today; now also covers wrapped DEKs).
- Someone with database write access swapping sealed values between secrets,
  Chambers or Citadels, or repointing a row at another DEK: reveal fails instead
  of returning the wrong secret.
- Long-lived key exposure: DEK rotation re-seals a scope so a previously leaked
  DEK cannot open its current envelopes; KEK rotation retires a leaked KEK
  without touching secrets.
- Lost keychain entry silently forking the Vault: now detected and fail-closed.
- Partial operations: crashes during upgrade or rotation never leave a secret
  without a key.
- Disclosure through operational channels: logs, audit, realtime, idempotency
  records and responses carry no secret or key material (tested).

Does not protect against:

- An attacker who runs code as the Gateway's OS user, or reads its memory: they
  can read the keychain and open everything.
- Ciphertext exfiltrated before a rotation together with the then-current key:
  rotation does not reach copies already taken.
- Rollback of a secret to an older envelope of itself under the same DEK by
  someone with database write access (no per-write counter in AAD).
- Before a Citadel's legacy upgrade completes, a v1 envelope pasted over a row
  that is itself still v1 (no AAD on v1). The window closes when
  `legacy_reads_closed` is set (§5.3).
- Isolation between people: every scope is opened by the same Gateway with the
  same KEK. A Chamber key is a scope for sealing, rotation and shredding — not a
  member permission. Member/agent key grants are future work.
- Metadata: secret names, Chamber assignment, counts and timestamps stay
  plaintext in storage.
- Malicious operators with valid auth and approval.

## 11. UI (Cockpit, then Classic copy)

Read `DESIGN.md` and `PRODUCT.md` before building. Cockpit Vault settings gain a
"Keys" section: custody (OS keychain / dev verification), keychain status, KEK
version and last rotation, one row per scope (Citadel scope + each Chamber with
its active key version and secret count), and a **Rotate key** action per row
plus **Rotate Citadel key** (disabled, with a short reason, for a scope with no
data key yet or a Citadel with no key state). Rotation opens a confirm dialog with a required
reason, then shows "Waiting for approval" with a link to the approval, then
progress, then completion. The store form gains a Chamber picker defaulting to
Citadel scope; each secret row shows its Chamber and offers **Move to Chamber**.
`VAULT_KEY_MISSING` and `VAULT_KEYCHAIN_UNAVAILABLE` get their own plain
explanations. The "not available" sentence is removed from Cockpit and Classic,
and `route-release-scope.ts` is updated. Copy must not say or imply per-member
isolation.

## 12. Delivery (small PRs against main, each `Refs #443`, `Refs #341`)

1. **Design** — this document (ticks the first box of #443 once approved).
2. **Storage** — schema, SQLite + Postgres migrations, convergence migration,
   repository support for scopes, key rows, ledger and row-level CAS; contracts.
   No Gateway behavior change.
3. **Gateway hierarchy** — key service (KEK/DEK, AAD, fail-closed KEK-missing),
   v2 sealing, legacy upgrade + reconciler, Chamber-scoped store and move.
   Security-reviewer pass before opening.
4. **Rotation** — ledger runner, approval kind, audit, resume, routes.
   Security-reviewer pass before opening.
5. **UI and docs** — Cockpit keys section, Chamber picker, move, rotation flow;
   Classic copy; `docs/CITADEL_VAULT_REVISIONS.md`, `docs/1_0_CONTRACT.md`;
   `Closes #443`.

## 13. Calls made by the designer (check these)

- Legacy secrets go to a Citadel-scope DEK, not a guessed Chamber.
- KEK v1 reuses the existing keychain account; no keychain write at migration.
- Rotation batches use row-level CAS and do not consume the operator's review;
  only start and completion change the revision.
- Legacy upgrade runs automatically (audited, no approval): it changes envelope
  format, not key custody.
- Cancel is offered only before approval in the first cut; resume is the
  recovery path.
- No DEK cache: each operation unwraps and zeroes.
- KEK rotation is refused under the dev-verification key.
- Secret name is not in the AAD (secret ID is).
- KEK rotation is refused while any v1 row remains; unreadable legacy rows
  block it until the operator restores the key or deletes them.
- The v1 read path closes per Citadel once its upgrade finishes.
- One Gateway host per database for Vault custody (documented, matches today).
- On a stale active key, the Gateway re-seals and retries a store once before
  returning 409 `VAULT_KEY_CHANGED`.
