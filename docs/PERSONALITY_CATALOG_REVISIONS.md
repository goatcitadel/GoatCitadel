# Personality catalog revisions

The Gateway owns the personality catalog and global Work default. Its catalog
response includes an opaque `revision`. Every catalog mutation requires the
revision from the snapshot being reviewed, including first-time custom creation.

## API contract

| Operation | Request | Required review |
| --- | --- | --- |
| Read catalog | `GET /api/v1/personalities` | Returns `revision`, `items` and `defaultPersonalityId` |
| Create custom | `POST /api/v1/personalities` | `expectedRevision` alongside the personality fields |
| Edit or rename | `PATCH /api/v1/personalities/:id` | `expectedRevision` alongside the changed fields |
| Reset built-in or remove custom | `DELETE /api/v1/personalities/:id` | JSON body containing `expectedRevision` |
| Change or clear Work default | `PATCH /api/v1/personalities/default` | `personalityId` and `expectedRevision` |

A missing or malformed revision returns 400. A stale revision returns 409 with
`code: WRITE_CONFLICT` and
`details.reason: PERSONALITY_CATALOG_REVISION_CONFLICT`. Rejected requests do not
alter any catalog entry or the Work default. Clients must review the current
catalog before making another mutation; fetching a fresh token and silently
retrying the old request is not a conflict-resolution strategy.

## Storage authority

`PersonalityCatalogService` reads and projects one snapshot of
`personality.catalog.v1`. The revision binds that exact stored record and the
merged shipped/custom catalog. Mutations use the data-only
`SystemSettingsRepository.compareAndSet` operation, with a SQLite immediate
transaction or PostgreSQL row lock. Initial insertion also rejects competing
first writers. No schema migration or eager initialization is required.

Every accepted write advances the row timestamp, even for an unchanged value or
a future-dated legacy row. Repeating default/reset operations cannot restore a
consumed revision. The response projects the row actually committed, so a later
peer write cannot replace the first writer's acknowledgement. Revision
invalidation is deliberately catalog-wide: editing one personality invalidates
pending mutations for other personalities and the default.

Existing behavior is preserved: custom renames update their selected global
default in the same write; removal clears a selected default; resetting a
built-in removes its override and also clears it as the global default. The
immutable no-overlay Default preset cannot be edited or removed. Personality
overlays remain subordinate to approval, tool, memory and safety policy.

## Operator behavior

Settings retains a rejected editor draft and displays the current saved
instructions or catalog. **Apply draft to current personality** is explicit and
stays unavailable while refresh still returns the rejected revision. Save
acknowledgements preserve text typed while a request was pending, including
custom creation and renaming to a new ID. If a peer removes the selected
personality, the retained draft remains readable and is not recreated silently.

Default, reset and remove dialogs capture the revision and saved label when
opened. A conflict closes the stale dialog, retains the draft and reloads the
catalog. The operator must open a fresh confirmation. Setting a default uses the
saved instructions identified in that confirmation, not an unsaved editor draft.
The Chat `/personality` command passes its single catalog read through to the
owner and does not refresh/retry a conflict.

## Verification boundary

Focused Gateway tests cover exact revision transport, validation, structured
conflicts and commit truth after response failures. SQLite and actual temporary
PostgreSQL tests exercise independent simultaneous writers, absent-row creation,
edit/reset/delete/default races, legacy preservation, repeated values and
acknowledgement identity. Settings tests cover retained conflicts, explicit
rebase, removed records and typing during creation/rename.

`pnpm verify:personalities:revisions` runs the real Gateway and canonical Settings
UI in a temporary runtime. It races real API writes against browser creation,
edit, default, reset and removal, then requires fresh explicit review. Desktop
and 390 px captures accompany canonical-state and revision assertions. Execution
receipts are recorded in the [comparison implementation ledger](testing/COMPARISON_IMPLEMENTATION_STATUS.md).

These checks do not prove installed-desktop, second-machine, live-provider or
external-channel acceptance, or protection against arbitrary raw database
writers. Citadel, integration and MCP mutation contracts remain separate work.
