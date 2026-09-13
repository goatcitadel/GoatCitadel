# Memory maintenance save revisions

Memory maintenance policy saves compare the operator's reviewed revision with
canonical storage inside the write transaction. A concurrent change returns a
conflict without replacing the current policy. The Library policy editor keeps
the draft and offers the current policy for review before another save.

## Policy API

`GET /api/v1/memory/maintenance/policy?workspaceId=<id>` and the maintenance
status response include `policy.revision`: an opaque string representing the
normalized stored policy, including its workspace and update timestamp. Keep
the revision with the draft when editing begins. It is a concurrency
precondition, not authorization; the existing operator access boundary applies.

`PATCH /api/v1/memory/maintenance/policy` requires `expectedRevision` alongside
the optional policy fields. Send `workspaceId` in the body or query. When both
are present, they must match. The shared client sends both consistently.

```json
{
  "workspaceId": "workspace-a",
  "expectedRevision": "<revision returned with the reviewed policy>",
  "model": "operator-selected-model"
}
```

An absent or malformed revision returns `400`. A stale or different-workspace
revision returns `409` with `details.reason = MEMORY_POLICY_REVISION_CONFLICT`.
The successful response is the complete policy with a new revision. Every save
advances the revision, including identical values and a clock that has moved
backward. Returning to old settings does not revive an old revision.

Clients must retain unsaved input on conflict, fetch and display the current
policy, and let the operator review which changes to keep. Do not automatically
retry a draft with a freshly fetched revision. The canonical editor's **Review
current policy** and **Use this version and keep my draft** actions make that
choice explicit. Edits typed while an earlier save is pending stay dirty.

## Recommendation decisions

Each maintenance recommendation includes its own `revision`, binding its
workspace, exact proposal, and decision state.

| Endpoint suffix | Required body | Successful response |
| --- | --- | --- |
| `/recommendations/:recommendationId/accept` | `expectedRevision` for the recommendation and `expectedPolicyRevision` for the policy | `{ recommendation, policy }` |
| `/recommendations/:recommendationId/reject` | `expectedRevision` for the recommendation | The rejected recommendation |

Both endpoints are under `/api/v1/memory/maintenance`. Acceptance locks and
compares the proposal and policy before applying either write. The policy
update and the applied decision commit together; a failed decision write rolls
back the policy. Rejection never changes the policy. An already resolved or
changed recommendation returns `409` with
`details.reason = MEMORY_RECOMMENDATION_REVISION_CONFLICT`; a fresh revision
does not authorize rewriting an applied or rejected decision.

## Storage and compatibility

SQLite uses an immediate transaction; PostgreSQL locks the canonical row with
`FOR UPDATE`. First-read initialization uses insert-if-absent, so it cannot
replace a policy created by another request. No schema migration is needed:
revisions are derived from persisted state, and policy writes advance
`updated_at` monotonically.

Older clients that omit preconditions must be updated. There is no unguarded
compatibility fallback. This does not add revision guards to other settings or
Workbench file saves; those remain separate GATE-02 work.

## Verification

Focused SQLite and actual PostgreSQL tests cover independent simultaneous
writers, scope binding, initialization preservation, repeated/same-clock saves,
proposal changes, terminal decisions, and injected failure between the policy
and recommendation writes. Gateway integration covers auth, HTTP conflicts,
canonical workspace routing, and mutation commit acknowledgement. Shared-client
and hook tests cover wire fields and drafts retained after conflicts or late
save responses.

`pnpm verify:memory:truth` includes `memory-truth.policy-revision`. This uses an
isolated Gateway and its real storage worker, commits another policy after the
browser preflight, verifies the HTTP conflict and retained draft, and saves only
after explicit review. It also checks that the default workspace is unchanged.
The lane's providers and embeddings are local fixtures. No drive formatting,
mounting, installed-service changes, or external-provider acceptance is involved.
