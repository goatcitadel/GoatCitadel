# Memory item enumeration

Updated: 2026-09-13

Library > Memory > Items can load the complete matching item list. Search is
performed by the Gateway. **Load more memory** appends a bounded page and shows
how many items have loaded against the complete search total. Namespace pills
and lifecycle counts describe the loaded items; they do not claim a complete
breakdown while more pages remain.

If memory changes between pages, the UI retains the loaded records with a
warning and offers **Reload memory**. It does not combine generations, silently
drop records or automatically retry a stale continuation. Search, workspace
changes and reload invalidate pending reads. The UI does not expose raw API
JSON in the pagination warning.

## API contract

`GET /api/v1/memory/items` remains operator authenticated and feature gated by
`memoryLifecycleAdminV1Enabled`. It returns `items`, `total`, `snapshotAt` and an
optional `nextCursor`. The old `items` property remains available to existing
clients. Every page is limited to 1-500 items, with a default of 200.

The filters are `workspaceId`, exact `namespace`, `query`, and `status`
(`active`, `forgotten`, or `all`). HTTP requests default to `active`, excluding
forgotten and expired records. Canonical workspace ownership takes precedence
over legacy metadata; workspace reads retain the existing global-memory
visibility rules. Query matching retains the existing case-insensitive SQL
LIKE behavior across title, content and namespace.

Pass `nextCursor` back as `cursor`, preserving the filters. Page size may change.
Cursor content is signed with a key held by the Gateway memory owner and is
bound to the normalized filters. It contains a filter hash and row position,
not item content or raw search text. A new Gateway owner invalidates earlier
cursors. Completion is indicated by the absence of `nextCursor`.

Responses to invalid continuation requests are:

| Condition | HTTP status | Code / details |
|---|---|---|
| Malformed, altered or earlier-owner cursor | 400 | `FIELD_INVALID`, `field: cursor` |
| Changed workspace or filters | 409 | `STATE_CONFLICT`, `reason: MEMORY_CURSOR_SCOPE_MISMATCH` |
| Committed memory mutation or expired continuation | 409 | `STATE_CONFLICT`, `reason: MEMORY_CURSOR_STALE` |
| Missing enumeration repository | 503 | Owner unavailable; no partial page |

## Ownership and consistency

`MemoryLifecycleService` remains the public owner. Its pagination collaborator
signs and validates cursors; `MemoryItemEnumerationRepository` owns the reads
and transactions. Mission Control uses the shared API client. Bounded internal
readers retain their existing array-returning lifecycle method.

SQLite migration 227 and PostgreSQL migration 172 add a generation counter,
mutation triggers and an index ordered by `updated_at` and `item_id`. Pages use
that same deterministic order with keyset continuation. The counter is updated
in the writing transaction, including edits that retain their timestamp;
rollback also rolls back the generation change. Count and page reads share a
transaction and writer exclusion appropriate to each database.

Any committed mutation to `memory_items`, including another workspace's write,
invalidates a continuation. This conservative global counter can require extra
reloads in a busy installation. Cursors also expire after 15 minutes; active-only
reads expire earlier when their next matching item expires. `snapshotAt` is the
database clock used for enumeration and active-item expiry, not an immutable
historical copy of the library.

## Local acceptance

The SQLite and actual PostgreSQL fixtures enumerate 1,211 matching records over
three pages, including tied timestamps, canonical and legacy workspace ownership,
global records, malformed legacy metadata and filtered exclusions. They check
insert, edit, forget, delete, foreign-workspace mutation, expiry, rollback and
schema replay.

The authenticated Gateway integration tests exercise the lifecycle owner,
async storage, route validation, feature gate, filters, totals and cursor
rejection. UI tests cover duplicate clicks, superseded responses, conflicting
pages and reload. The named browser lane uses a fresh local database, a loopback
provider stub and deterministic local embeddings. It enumerates all 503 fixture
items, commits a real mutation before continuation reaches the Gateway, observes
the 409 and warning, and reloads to all 504 items. It also verifies TTL expiry
through the existing approval and lifecycle path.

Final browser receipt:
`artifacts/verification/2026-09-13T12-09-40-173Z-memory-truth-714d04de/manifest.json`.
The complete-list and stale-list screenshots were visually inspected. The stale
scenario intentionally records its asserted HTTP 409 in browser diagnostics.
Earlier failed verifier runs remain retained; they are not completion receipts.

This closes local Memory enumeration acceptance from UI handoff GATE-01. It
does not complete the broader comparison plan, installed desktop acceptance,
live provider/channel journeys or Mini PC acceptance. No real drive was attached,
partitioned, formatted, mounted or given new permissions for this work.
