# Citadel Vault revision contract

Vault stores and deletes compare a reviewed metadata revision inside the same
transaction that changes the sealed record. A stale request returns 409 with
`code = WRITE_CONFLICT` and `details.reason = CITADEL_VAULT_REVISION_CONFLICT`.
It does not replace or delete a credential. An archived Citadel rejects writes
with `CITADEL_ARCHIVED`; restore it and review again first.

`GET /api/v1/citadels/:citadelId/vault-secrets` returns a
`CitadelVaultSnapshot`: Citadel ID, opaque revision, optional profile/lifecycle,
and secret names, IDs, creation times and update times. The snapshot query reads
only metadata. Its digest binds that metadata, the profile revision and a
persisted generation; it never incorporates plaintext or ciphertext. Vault
metadata is separate from the nonsecret access-rule snapshot.

| Operation | Request body | Successful response |
| --- | --- | --- |
| `POST /api/v1/citadels/:citadelId/vault-secrets` | `name`, `value`, `expectedRevision` | 201 and the committed metadata snapshot |
| `DELETE /api/v1/citadels/:citadelId/vault-secrets/:secretId` | `expectedRevision` | 200 and the committed metadata snapshot |
| `GET /api/v1/citadels/:citadelId/vault-secrets/:secretId/reveal` | None | Explicitly opened value, as before |

Existing operator authentication remains required. The URL controls scope;
body scope fields cannot redirect a write. Missing or invalid revisions receive
400 before sealing. Missing and foreign deletion targets return 404 without
consuming a revision. Older clients must refresh and send the new revision.

The dedicated credential service resolves the Citadel key and seals the value
before passing it to storage. It fails closed when no key is available. Generic
HTTP idempotency now binds Vault requests to the concrete, query-free path and
attempt key without hashing any body field. A completed duplicate is blocked,
including a duplicate carrying different bytes; an explicit new attempt uses a
new key and the current Vault revision. Route handlers await the durable commit
marker before acknowledging success. Vault responses, including reveals, use
`Cache-Control: no-store` and `Pragma: no-cache`. This change does not rewrite
historical idempotency records or rotate existing credentials.

## Storage and migration

`CitadelVaultRepository` owns the sealed SQL and metadata projection, using the
same Citadel lifecycle lock as the profile and structure owners. SQLite uses an
immediate transaction. PostgreSQL uses the Citadel-scoped transaction advisory
lock and profile row lock, including for initially empty scopes. Comparison,
write, generation advance and the returned acknowledgement are one transaction.
Trusted store/delete primitives participate in the same lock and counter.

A replacement preserves the secret ID and creation time, advances its update
time monotonically, and consumes the review even if its envelope is identical.
An add/delete cycle cannot revive an empty review. A counter-write failure rolls
back both credential and counter. The returned snapshot describes this commit,
even if a peer writes before the caller receives it.

SQLite v230 and PostgreSQL v175 add only `citadel_vault_revisions`, containing
Citadel ID and positive generation. There is no existing-data rewrite or
backfill; reads of legacy scopes use generation zero without inserting rows.
The first write inserts generation one. Historical migrations are unchanged,
and the append-only manifest protects both additions and the PostgreSQL digest.

Upgrade cooperating Gateway writers together. Arbitrary SQL and older writers
that bypass this owner are outside its concurrency contract. For application
rollback, retain the additive table and generation history; there is no
destructive down migration. Isolated fixtures prove preservation of populated
Citadel records and sealed Vault values when the migration is applied.

## Operator flow and local proof

The canonical Vault screen retains the unsaved name/value in its existing
memory-only draft owner after 409. It displays current names and timestamps and
requires **Use current Vault review** before retry. That action does not write
or reveal a value. A duplicate name requires **Replace secret?** confirmation;
deletion requires a new confirmation after a conflict. The password field stays
masked. A successful acknowledgement clears only the submitted input, preserving
anything typed later. No browser storage is introduced.
If current metadata cannot be fetched, **Reload Vault review** retries the read
without discarding the draft or approving a write. It is disabled during a read.

Switching Citadels ignores old acknowledgements and late reveal successes or
failures. Closing or hiding the inspector clears revealed values, as does the
existing 30-second timer. Failures remain separate from displayed plaintext.

Both database engines pass six independent-writer races covering stores,
deletions, trusted writes, profile changes and archive, plus rollback, add/delete
cycles, metadata isolation and exact acknowledgements. Actual Gateway tests cover
auth, URL scope, rejection, durable commit markers and response failure. UI tests
cover conflict review, replacement/deletion confirmation, draft retention,
double submits, failed refresh and scope changes.

`pnpm verify:citadels:revisions` includes the real Vault journey alongside profile,
structure and access-rule scenarios. It rejects two competing writes, accepts
both explicit retries, verifies the synthetic replacement can be opened, and
recovers a failed metadata refresh without losing the draft. It captures desktop
and 390 px layouts and uses the existing dev-verification key
with diagnostics enabled in a disposable Gateway; the OS keychain is not used.
This proof does not establish installed custody, physical-device, two-machine,
live-channel or live-provider acceptance.
