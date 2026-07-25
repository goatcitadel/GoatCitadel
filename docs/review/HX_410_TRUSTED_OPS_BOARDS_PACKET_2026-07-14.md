# HX-410 Saved Trusted Ops Boards Packet

Date: 2026-07-14
Status: frozen implementation contract; SQLite 167 / PostgreSQL 109 reserved

## Current implementation truth

GoatCitadel already has trusted, workspace-scoped operator surfaces for the agentic-run Kanban, approvals, runtime truth, task status, and usage/cost. It does not currently have a canonical saved-board record, board CRUD/CAS API, built-in widget registry, or saved-board renderer. The existing Kanban is a live view, not a saved board. `HX-410` therefore remains partial until the storage, API, and Ops surface below ship.

## Product boundary

The first release saves layouts composed only from Gateway-defined built-in widgets. It does not accept JavaScript, HTML, Markdown, URLs, component names, query text, arbitrary props, executable templates, plugin bundles, or agent-authored widget definitions.

The frozen built-in widget kinds are:

- `agentic_run_kanban`
- `approval_queue_summary`
- `runtime_truth_summary`
- `task_status_summary`
- `usage_cost_summary`

Each widget is a reference to a compiled Mission Control renderer that obtains current workspace-scoped data from its existing Gateway owner. A board record never caches or becomes the authority for runtime, approval, task, usage, or cost truth.

## Canonical contract

`OpsSavedBoardRecord` is workspace-scoped and contains:

- schema version `goatcitadel.ops-board.v1`
- `boardId`, `workspaceId`, plain-text `name`, optional plain-text `description`
- `status: active | archived`
- 1-12 exact-key widget placements
- monotonic positive `revision`
- create/update/archive actor IDs and timestamps
- create `idempotencyKey` and canonical `requestSha256`

A widget placement contains exactly `widgetId`, `kind`, `x`, `y`, `width`, and `height`. The grid is 12 columns. `x` is 0-11, `y` is 0-255, width is 1-12, height is 1-12, and `x + width` cannot exceed 12. Widget IDs are unique inside a board. Unknown keys or widget kinds fail closed.

Names are 1-120 Unicode characters after NFKC trim; descriptions are at most 500 characters. Control characters are rejected. Text is rendered by React text nodes only.

## Storage and mutation rules

SQLite 167 and PostgreSQL 109 own one additive `ops_saved_boards` table with a composite `(workspace_id, board_id)` primary key, a unique `(workspace_id, idempotency_key)`, bounded JSON-array layout storage, request hash, status, revision, actor, and timestamp columns.

Required behavior:

1. Create is idempotent inside the exact workspace. Same key and same canonical request bytes return the winning record. Same key with different bytes conflicts.
2. A workspace may retain at most 64 board records, including archived records. The database owns the concurrency-safe cap; PostgreSQL takes a workspace advisory transaction lock before counting.
3. Update requires exact workspace, board ID, positive expected revision, and active status. One writer wins; stale, foreign-workspace, archived, or missing rows do not mutate.
4. Archive and restore are explicit CAS transitions. There is no public hard-delete route in v1.
5. Workspace/board identity, create identity, request hash, and creation metadata are immutable. Every accepted mutation increments revision by exactly one.
6. Repository reads validate the complete record through the shared contract guard. Corrupt or unknown widget bytes never reach Mission Control.
7. Board persistence does not grant access to any widget's underlying data. Every widget request still passes its existing Gateway auth, workspace, policy, and no-store boundary.

## Gateway API

The operator-only, no-store API is:

- `GET /api/v1/ops/boards?workspaceId=<id>&includeArchived=<bool>`
- `GET /api/v1/ops/boards/:boardId?workspaceId=<id>`
- `POST /api/v1/ops/boards`
- `PATCH /api/v1/ops/boards/:boardId`
- `POST /api/v1/ops/boards/:boardId/archive`
- `POST /api/v1/ops/boards/:boardId/restore`

Create accepts workspace, name, description, placements, and an idempotency key. Patch accepts only name, description, placements, and `expectedRevision`. Archive/restore require `workspaceId` and `expectedRevision`. The server derives actor identity from authenticated request context; request bodies cannot override it.

List is bounded by the database cap and returns only the requested workspace. `includeArchived` defaults false. Every response includes `Cache-Control: no-store`.

## Mission Control surface

Add one `/ops/boards` route. The default experience is a saved-board selector plus a responsive grid. Create/edit mode offers only the five built-in registry entries, plain-text board metadata, add/remove controls, and bounded move/resize controls. It does not expose raw JSON.

Each widget renderer:

- receives only the active workspace and its trusted placement kind;
- calls an existing typed client owner;
- labels canonical versus projected data using the existing Ops conventions;
- handles loading, error, empty, and stale-workspace responses independently;
- invalidates late responses when workspace or board generation changes;
- uses links to existing detailed Ops routes for mutation or deep inspection.

The board surface itself is layout management, not a second control plane. Risky actions stay on their existing approval-gated owner surfaces.

## Failure and adversarial matrix

Proof must include:

- duplicate create replay and same-key/different-byte conflict;
- two-connection create-cap enforcement and one-winner update CAS;
- exact workspace isolation for get/list/update/archive/restore;
- corrupt JSON, unknown widget kind, duplicate widget ID, extra key, invalid grid bounds, oversized text, control characters, and non-array layout rejection;
- archived-board mutation rejection and exact restore revision;
- SQLite/PostgreSQL DDL parity plus live PostgreSQL CAS/cap proof when configured;
- strict operator-only/no-store route coverage and spoofed actor rejection;
- no `dangerouslySetInnerHTML`, dynamic import, URL/script/Markdown renderer, or generic component lookup in the production board registry;
- late response suppression across workspace and selected-board switches;
- desktop, laptop, and 390x844 mobile visual proof in light and dark themes;
- existing Kanban, approvals, runtime truth, task, and usage/cost route regressions.

## Release gate

`HX-410` can move to complete only after contracts, paired migrations, repository, operator API, typed client, saved-board UI, browser/visual proof, and an independent security/concurrency review pass. The integrated `pnpm verify:ops:saved-boards` lane binds those focused owners to canonical release-surface, browser, and visual proof in one artifact. A storage-only foundation remains `in_progress`; an interface that accepts arbitrary widget bytes is a hard hold.
