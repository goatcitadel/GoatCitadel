# MCP server revision contract

Caller-owned MCP servers expose an opaque `revision`. Public edits, policy
updates and deletion require the revision the operator reviewed. The registry
compares it inside the transaction that writes the configuration. A stale
request returns 409 with `code = WRITE_CONFLICT` and
`details.reason = MCP_SERVER_REVIEW_REQUIRED`, before changing configuration,
approvals, credentials or tool inventory.

| Operation | Request | Successful response |
| --- | --- | --- |
| `GET /api/v1/mcp/servers` | No body | Public inventory with caller-owned revisions |
| `GET /api/v1/mcp/servers/:serverId` | No body | One public record with revision |
| `POST /api/v1/mcp/servers` | Existing creation input | 201 and the committed public record |
| `PATCH /api/v1/mcp/servers/:serverId` | `expectedRevision` plus existing update fields | The committed public record |
| `PATCH /api/v1/mcp/servers/:serverId/policy` | `expectedRevision` plus policy fields | The committed public record |
| `DELETE /api/v1/mcp/servers/:serverId` | `expectedRevision` | `{ "deleted": true }` |

Operator authentication remains required. Missing or malformed revisions return
400; missing targets return 404. Older clients must read and carry the new
revision. The two synthesized internal servers remain Gateway-owned and cannot
be edited or deleted from Settings. Existing capability-pack writers carry their
read revision in addition to the pack owner's review and compensation bindings.

## Registry and runtime behavior

`McpServerStore` owns the configuration comparison, mutation and acknowledgement
inside its existing asynchronous storage transaction and compare-and-set owner.
The acknowledgement contains this transaction's saved record, even when another
writer commits before the response arrives. Deletion removes the server's tool
cache, first-use approvals and receiver approval state in that transaction, and
retains credential retirement through its dedicated owner.

Edit revisions are random generation tokens. A legacy record gets a deterministic
ID-only token on read, without writing or hashing configuration or credentials.
The first owner write enrolls a persisted token. Explicit same-value edits also
consume their review. These are additive fields in the existing `mcp_servers_v1`
JSON record; no SQL migration or startup rewrite is required. Cooperating Gateway
processes must be upgraded together. Older or direct writers that bypass this
owner do not participate in the contract.

Edit revisions are separate from requester `configurationRevision`, static
`configurationBindingId` and runtime `connectionRevision`. Configuration or
credential authority changes invalidate the edit review. Ordinary connection
status changes preserve it. Edits start disconnected, remove stale discovered
tools and fence pending connection attempts. Connection completion compares the
attempt, configuration and authority before publishing status and tools together.
Late success or failure cannot overwrite a newer edit, disconnect or connection.
Session cleanup captures only the sessions owned before the mutation, so delayed
cleanup cannot close a replacement session.

The public route validates the original review before restoring masked fields
from its private read and carries that review through subsequent service reads.
A credential change during those reads rejects the whole stale update. Public
records keep the existing secret-redaction rules. Inventory and detail reads
are uncached. Generic HTTP idempotency uses the method, actor, attempt key, route
and query-free concrete path, with no body fields in the payload digest. This
covers arguments, policy, OAuth inputs and unvalidated extras. Existing stored
idempotency history is not rewritten. Configuration routes await their durable
commit marker before follow-up work; a follow-up failure cannot make a committed
attempt retryable.

## Settings behavior and proof

Settings retains unsaved edits after conflict, failed recovery or a deleted
target. It loads the current public server for read-only review and requires
**Use current server review** before a separate save or delete. Accepting a
review never retries a write. **Reload server review** recovers a failed read.
Deletion needs a fresh confirmation after conflict. A missing target leaves its
draft visible with saving disabled.

Successful saves merge their own acknowledgements without reloading the list;
newer typing survives. Late responses from an earlier workspace or selected
server cannot replace the current review, draft or busy state, including
switching away and back.

`pnpm verify:mcp:revisions` starts an isolated Gateway and browser with a disabled
synthetic MCP server. It proves stale edit/delete rejection, failed-read recovery,
draft retention, explicit review, separate save, renewed deletion confirmation
and masked credentials at desktop and 390 px widths. The lane blocks all live
MCP connection actions and asserts none were attempted. SQLite and actual
PostgreSQL tests cover competing independent writers, same-value edits,
delete/recreate conflicts, rollback, own acknowledgements and late discovery.
Gateway tests cover authentication, credential read races, durable idempotency
and failure after commit. See the
[evidence ledger](testing/COMPARISON_IMPLEMENTATION_STATUS.md#mcp-server-revisions).

This completes the local MCP Settings revision slice. Custody recovery, remaining
native worker/comparison source work and external C1-C6 acceptance are separate.
No live provider, MCP transport, OS-keychain, installed-service or drive operation
is part of this browser lane.
