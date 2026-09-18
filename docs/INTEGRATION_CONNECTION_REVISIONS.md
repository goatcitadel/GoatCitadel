# Integration connection revision contract

Saved integration connections expose an opaque `revision`. Public updates and
deletes require that revision and compare it inside the transaction that changes
the record. A stale request returns 409 with `code = WRITE_CONFLICT` and
`details.reason = INTEGRATION_CONNECTION_REVISION_CONFLICT`, before changing the
connection or synchronizing channel runtimes.

| Operation | Request | Successful response |
| --- | --- | --- |
| `GET /api/v1/integrations/connections` | Existing list query | Public records with revisions |
| `GET /api/v1/integrations/connections/:connectionId` | No body | One public record with revision |
| `POST /api/v1/integrations/connections` | Existing creation input | 201 and the committed public record |
| `PATCH /api/v1/integrations/connections/:connectionId` | `expectedRevision` plus existing update fields | The committed public record |
| `DELETE /api/v1/integrations/connections/:connectionId` | `expectedRevision` | `{ "deleted": true }` |

Operator authentication still applies. Missing or malformed public revisions
return 400; a deleted target returns 404. Older clients must read and carry the
new revision. The canonical Settings client and terminal client do so. Creation
allocates a new UUID and therefore has no existing-record review to compare.

## Storage and credentials

`IntegrationConnectionRepository` owns comparison, mutation, generation advance
and the returned acknowledgement in one transaction. SQLite uses an immediate
transaction. PostgreSQL takes an advisory lock for the connection and locks its
row. The acknowledgement describes this transaction even when another writer
commits before the caller receives the response.

Revisions bind the connection ID and persisted generation only. They do not hash
configuration, credential values, ciphertext, or secret references. Every write,
including trusted internal writes and same-value updates, advances the generation.
Update timestamps also advance monotonically. Deletion retains its generation
row. A failed generation write rolls back creation, update or deletion together.

Public projection continues to mask credentials. The update route restores
masked or omitted secret fields from its raw read and passes the caller's
original revision through to storage. A credential replacement between that
read and the service's later read therefore rejects the entire stale update.
Startup access-policy migration, Telegram and Discord configuration commands,
Telegram pairing, and Slack OAuth configuration merges also pass the revision
of the configuration they used.

Generic HTTP idempotency binds these mutation attempts to their method, actor,
route, attempt key and concrete query-free path. Its payload digest does not
include any body field. A completed duplicate remains blocked even when its body
changes. A new reviewed attempt uses a new key. The primary connection route
awaits its durable commit marker before realtime/runtime synchronization and
retains committed truth if synchronization or response delivery subsequently
fails. Connection list/detail/create/update/delete responses use `no-store` and
`no-cache`. Existing stored idempotency history is not rewritten.

SQLite v231 and PostgreSQL v176 add only `integration_connection_revisions`.
There is no configuration rewrite or backfill. Legacy records read at generation
zero until their first write. The immutable migration manifest and PostgreSQL
digest include the additive migration. Upgrade cooperating Gateway processes
together; direct SQL and older writers that bypass the owner do not participate
in this contract. Application rollback must retain the table and its generation
history. There is no destructive down migration.

## Settings behavior and proof

Settings keeps unsaved fields in the existing memory-only draft owner. Following
a conflict it loads the current public record, displays its metadata and masked
configuration, and requires **Use current connection review** before a separate
save or delete. Accepting a review never retries a write automatically. Deletion
requires a fresh confirmation after conflict. **Reload connection review** can
recover a failed read without discarding the draft or approving a write. Missing
targets retain the draft with saving disabled.

Successful writes merge their own returned record without a second list read.
Newer typing survives an acknowledgement. Earlier refreshes cannot replace that
acknowledgement. A workspace or selection change ignores late write/review
responses, including switching away and back. The terminal reads the chosen
connection before its update/delete confirmation and sends that same revision.

`pnpm verify:integrations:revisions` starts an isolated Gateway and browser with
synthetic configuration and loopback fixtures. It proves real stale edit/delete
rejection, failed-refresh recovery, explicit retries, new delete confirmation,
masked credentials and desktop/390 px layouts. SQLite and actual PostgreSQL
tests cover five independent-writer pairs, identical writes, A-B-A changes,
rollback, exact acknowledgements and populated-record migration preservation.
Gateway tests separately cover auth, the credential read race, idempotency and
post-commit failures. See the [evidence ledger](testing/COMPARISON_IMPLEMENTATION_STATUS.md#integration-connection-revisions).

This completes the local global-connection editor slice. The subsequent
[channel setup connection-review work](CHANNEL_SETUP_CONNECTION_REVIEWS.md)
also binds hydration, live validation and credential promotion to the reviewed
connection, with atomic draft/connection finalization. The subsequent
[MCP revision contract](MCP_SERVER_REVISIONS.md) covers public MCP edits and
deletion. Native worker work, credential recovery, the comparable campaign and
external C1-C6 acceptance remain open. No live
provider/channel, installed-service, keychain or drive operation is part of this
verification lane.
