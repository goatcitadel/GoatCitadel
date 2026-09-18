# Citadel access-rule revision contract

Council seats, Wards, outgoing Passages, members, and Citadel integration grants
use one reviewed access snapshot. `CitadelRepository.mutateAccess` compares its
revision, applies one command, and returns its own complete acknowledgement inside
the same transaction. A stale command writes nothing.

`GET /api/v1/citadels/:citadelId/access` returns a `CitadelAccessSnapshot` with the
Citadel identity, opaque `revision`, structure snapshot, and five nonsecret lists.
The structure includes the current profile/lifecycle, Charter, and Chambers.
Empty and legacy Citadels are reviewable. Vault metadata and values are excluded;
this token does not govern Vault credential changes.

All of these operator writes require `expectedRevision` in their JSON body:

| Resource suffix under `/api/v1/citadels/:citadelId` | Create/update | Remove |
| --- | --- | --- |
| Council | `POST /council` | `DELETE /council/:agentId` |
| Wards | `POST /wards` | `DELETE /wards/:wardId` |
| Outgoing Passages | `POST /passages` | `DELETE /passages/:passageId` |
| Members | `POST /members` | `DELETE /members/:subjectId` |
| Integration grants | `POST /integrations` | `DELETE /integrations/:grantId` |

POST returns 201 and DELETE returns 200, both with the complete snapshot.
Older callers without revisions receive 400. The URL binds Citadel scope; body
scope fields cannot override it. Missing or foreign removal targets return 404
without consuming a revision. A Passage source Chamber must belong to the source
Citadel. Existing operator auth and policy enforcement remain authoritative.

A consumed review returns 409, `code = WRITE_CONFLICT`, and
`details.reason = CITADEL_ACCESS_REVISION_CONFLICT`. An archived profile rejects
access changes with `CITADEL_ARCHIVED`; restore and review again first. Profile,
Charter, or Chamber changes invalidate an access review. Access writes do not
consume the separate profile or structure revision.

SQLite uses an immediate transaction. PostgreSQL uses the existing Citadel-scoped
transaction advisory lock and profile row lock, including an advisory lock for
empty scopes. The compare, write, persisted generation advance, and returned
snapshot are serialized. Every trusted repository access writer participates;
same-value writes consume a review. Failed removals do not. Removing a rule after
adding it cannot revive an older empty review. A failure after the rule write
rolls back both the rule and generation. Route handlers await durable idempotency
acknowledgement before returning a successful response.

The canonical Wards and Council screens retain drafts/selections on 409, fetch
the current access context, and require **Use current access review** before an
explicit retry. That button does not write. Deletions require a new confirmation.
Forms stay visible while conflict state reloads. Scope changes discard late
acknowledgements; edits typed during a save survive its own acknowledgement.

## Migration and deployment

SQLite v229 and PostgreSQL v174 add `citadel_access_revisions`, containing only
the Citadel ID and generation. There is no existing-data rewrite or backfill.
Reads of legacy scopes use generation zero without inserting a row. The first
write inserts generation one. Historical migration definitions remain unchanged;
the new PostgreSQL migration has an integrity digest and both ledgers are locked
in the append-only manifest.

Upgrade all cooperating Gateway writers together. This contract does not govern
arbitrary SQL or an older binary bypassing the current owner. An application
rollback should retain the additive table and its generation history. There is
no destructive down migration. Isolated SQLite and PostgreSQL fixtures verify
that applying the migration preserves populated Citadel tables and Vault data.

## Local acceptance

Focused tests exercise all ten commands, scope binding, absent/invalid and stale
reviews, same-value and add/remove cycles, lifecycle/Charter changes, transaction
rollback, and acknowledgements followed by a peer commit. Both database engines
run eight races using independent connections. Actual Gateway tests cover auth,
conflicts, exact owner snapshots, response failure, and awaited idempotency.

`pnpm verify:citadels:revisions` includes real Ward-add, Ward-delete, and Council
conflict/retry journeys with desktop and 390 px captures alongside profile and
structure scenarios. These use a disposable local Gateway and deterministic
provider configuration. They do not establish installed-worker, two-machine,
live-channel, or provider acceptance. [Vault credential revisions](CITADEL_VAULT_REVISIONS.md)
have a separate metadata-only owner; global integration/MCP owners remain open.
