# Channel setup connection reviews

Channel repair and credential rotation retain the exact connection revision used
to hydrate the draft. Validation, live checks, cached-test reuse and finalization
require that review to remain current. A changed connection returns `409
WRITE_CONFLICT`; a deleted connection cannot be recreated by an old repair draft.

## Owner and API

`ChannelSetupDraft.connectionRevision` is server-owned. Creating an edit/repair
draft records the connection generation returned with its configuration. Generic
draft PATCH requests cannot supply or advance this binding.

- `GET /api/v1/channels/drafts/:draftId` returns the masked current draft.
- `POST /api/v1/channels/drafts/:draftId/connection-review` requires the current
  numeric `expectedRevision` and opaque `expectedConnectionRevision`.
- Accepting a review preserves setup fields and explicitly submitted credential
  replacements. Inherited credentials use the newly reviewed connection. Existing
  legacy draft credentials without an operator-source marker are not treated as
  an intentional replacement during this review.
- Reviewing changes the draft revision and invalidates its cached test. It does
  not run a test or finalize the connection.

The public routes remain operator authenticated and use the shared idempotency
boundary. Draft bodies, credential values and unvalidated extra input do not
contribute to persisted generic request fingerprints. Draft responses are
`no-store`; public projections omit credential locators and raw values.

## Atomic finalization and credential custody

The storage owner commits the tested draft revision, the connection revision and
draft deletion in one transaction. SQLite uses an immediate transaction.
PostgreSQL locks the draft row with the draft advisory lock before entering the
integration connection owner's lock. A competing edit, finalization or deletion
cannot consume the same reviewed draft. Failure to remove the draft rolls back
the connection write and its generation increment.

Credential promotion creates a unique versioned connection locator. It does not
overwrite a currently referenced credential slot. A rejected transaction removes
only the references provisioned by that attempt and retains the draft's temporary
credentials. Once the transaction commits, follow-up or acknowledgement failures
retain committed credential references and mark the mutation committed. A
duplicate HTTP attempt is blocked. Runtime synchronization follows commit.

Finalization returns the record captured by its own transaction, even if another
writer changes the connection before the response. The exact passing test can be
reused while its connection binding and configuration remain unchanged.

Legacy three-part connection credential locators remain readable. New promotions
add an opaque nonce. This change does not bulk-convert existing credentials or
prove any OS-keychain operation on an installed runtime.

## Migration

SQLite 232 and PostgreSQL 177 append `channel_setup_connection_review`, adding a
nullable `connection_revision` column. Existing draft contents and connection
records are preserved; old repair drafts remain unreviewed until the operator
accepts a current connection review.

PostgreSQL 177 is safe when fresh bootstrap already includes the column. Its
runtime digest is
`89d5b7420be41499de45f148fbbcc6b291b5164ab77216a8e81c8b8d7a72c3a8`.
Only this unpublished new migration was corrected after the first fresh-bootstrap
test exposed the duplicate-column case. All earlier migration definitions and
manifest entries remain unchanged. The append-only and parity checks pass.

Older application code must not be used to write reviewed channel drafts. Use the
documented offline backup/recovery procedure for a rollback; do not drop the
column or rewrite migration history in a user database.

## Mission Control

Channels keeps the editor mounted during conflict refresh, including advanced
input. Failed reads offer a read-only reload. The operator reviews masked current
connection metadata and explicitly selects **Use current connection review**.
The response advances the draft's review while retaining unsaved edits. A new
save/test is a separate action. Deleted connections remain blocked, and late
responses after a workspace switch cannot change the newly selected editor.

## Local proof and limits

- SQLite and actual PostgreSQL cover five independent-writer pairs, transaction
  rollback, exact acknowledgements, deleted targets and populated draft migration
  preservation. The PostgreSQL lane also passes 24 migration-integrity tests.
- Real storage, Gateway services, auth and idempotency tests cover stale reviews,
  changes during live checks and promotion, deliberate credential replacements,
  cache invalidation/reuse and failures after commit. Credential custody uses an
  in-memory synthetic store; external checks are injected local test doubles.
- `pnpm verify:channels:revisions` passes against a disposable real Gateway and
  Mission Control. Its desktop and 390 px captures were visually inspected:
  `artifacts/verification/2026-09-13T22-48-21-115Z-channel-connection-review-db68ddd5`.
  It proves a real stale-connection rejection, failed-read recovery, an unsaved edit
  retained through explicit review and a save carrying the accepted draft revision.
  No live channel test runs in that browser lane.

This closes the local channel setup connection-review gap. MCP editor
preconditions, native worker source/installation work, comparable campaigns and
the remaining C1-C6 external acceptance are separate open work. Publication and
drive operations remain paused.
