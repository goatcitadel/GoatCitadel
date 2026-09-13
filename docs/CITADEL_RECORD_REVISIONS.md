# Citadel profile revision contract

Citadel profile edits, archive, and restore require the revision returned by the
profile read. This protects the name, slug, description, kind, default workspace,
and lifecycle record. Charter, template, blueprint, membership, and access-rule
mutations have separate owners and are not covered by this profile revision.

`CitadelRecord.revision` is an opaque SHA-256 token bound to the persisted profile
and its timestamps. Derived `hasCharter` is excluded so directory and detail reads
agree. Reading or adding a Charter does not rewrite a profile or consume its
revision. No database migration is required.

The shared client sends `expectedRevision` for:

- `PATCH /api/v1/citadels/:citadelId`
- `POST /api/v1/citadels/:citadelId/archive`
- `POST /api/v1/citadels/:citadelId/restore`

Missing or malformed reviews return 400 before the owner runs. A stale review
returns 409 with code `WRITE_CONFLICT` and
`details.reason = CITADEL_RECORD_REVISION_CONFLICT`. A duplicate slug remains a
distinct `ALREADY_EXISTS` conflict. Creation retains the existing unique identity
contract; it cannot overwrite an existing id or slug.

`CitadelRepository` compares and writes in one SQLite immediate transaction or
PostgreSQL row-lock transaction. Accepted edits advance the timestamp even for a
same-value save or a backdated clock. Returning to earlier field values cannot
revive an old revision. Archive/restore already in their target state may return
the unchanged record, but only after validating the current review. The returned
acknowledgement is read inside the committing transaction, so a later peer write
cannot be substituted into that acknowledgement. These guarantees apply to
repository mutations, not arbitrary raw database writers.

Settings keeps a rejected draft, shows the current saved profile, and requires
explicit rebase before retrying. A failed or stale refresh cannot make the
rejected token retryable. Duplicate-slug validation does not latch a revision
conflict. Typing during a save survives its acknowledgement and receives the
accepted revision as its next baseline. An empty description explicitly clears
the field.

Both Settings and Library capture the reviewed id, name, and revision for archive
confirmation. A conflict requires a fresh confirmation. Restore uses the displayed
revision and never retries automatically. Library refreshes the profile without
overwriting an unsaved Charter draft. Lifecycle buttons require a loaded revision.

Focused verification covers owner validation, same-value and ABA changes,
backdated clocks, rollback, untouched Charter/chamber preservation, and a peer
writing immediately after commit. Independent database workers contend on the
same profile for edit/edit, edit/archive, edit/restore, archive/archive, and
restore/restore. Both connections are ready before the first write holds its
lock; the second writer attempts its operation before that lock is released.

Run the real Gateway/browser proof with `pnpm verify:citadels:revisions`. It uses
an isolated runtime and controlled provider, injects competing API writes, and
checks explicit review and retained drafts in Settings and Library at desktop and
390 px widths. It performs no volume provisioning or live provider calls.
Current results and remaining program work are recorded in
[the comparison implementation ledger](testing/COMPARISON_IMPLEMENTATION_STATUS.md).
