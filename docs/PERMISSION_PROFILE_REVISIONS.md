# Permission profile and selection revisions

Permission profile saves, archives, activations and default-selection changes
use canonical review revisions. If the reviewed record or selection changed,
the Gateway rejects the request with `409` and preserves the winning state.
Creating a profile with defaults and saving a changed default list apply the
profile and its selections together in one transaction.

## Operator workflow

In **Settings > Permissions**, select a custom profile and choose **Edit profile**.
The editor retains the loaded revision with its draft. **Save profile** submits
that revision, even if a newer snapshot arrives while the draft is being edited.

On a conflict:

1. The winning profile remains unchanged and the draft stays in the editor.
2. Expand **Current profile rules** to review the current saved values.
3. Choose **Apply draft to current profile** to keep the draft against that
   reviewed version, then choose **Save profile** again.

**Reload latest profile** fetches current state without discarding the draft.
Save remains blocked after a rejected revision until a different canonical
revision is available and the operator explicitly rebases the draft. Another
intervening change can still produce a new conflict.

**Archive profile** captures the profile ID, label and revision when its
confirmation opens. A conflict closes that confirmation, retains the draft and
reloads current state. Review the changed profile and open a new confirmation
before archiving it. Confirming a stale dialog never silently uses a newer token.

**Use for Chat** and the other **Use** actions first load a selection review.
It shows the requested context, profile approval and filesystem-read settings,
tool rules, and current explicit selections in that scope. Choose **Apply
reviewed selection** to activate it. **Cancel selection** discards the review.
A competing permission change clears the rejected review; choose the **Use**
action again to review current state before applying it.

When creating a profile with automatic defaults or changing an existing default
list, choose **Review default selection** before **Create profile** or **Save
profile**. The editor retains the proposed draft and the review identifies the
currently saved profile and selections. Changing the draft, selected profile or
workspace invalidates that review; late responses cannot restore it. A selection
conflict preserves the draft and requires a fresh review. Ordinary edits and
reordering an unchanged default set do not reassert automatic selections.

## API contract

Profile list, create and update responses return `PermissionProfileSnapshotRecord`
with an opaque 64-character lowercase hexadecimal `revision`. Runtime-only
`PermissionProfileRecord` values do not require a mutation token.

| Request | Required review precondition |
| --- | --- |
| `POST /api/v1/tools/permission-profiles/selection-review` | Read-only review request: `operation: "activate"` with profile/context, or `operation: "defaults"` with existing profile ID or new profile scope and requested default contexts |
| `POST /api/v1/tools/permission-profiles/activate` | `expectedProfileRevision` from the returned profile and `expectedSelectionRevision` from the selection review |
| `POST /api/v1/tools/permission-profiles` | `expectedSelectionRevision` when creating with a nonempty default list |
| `PATCH /api/v1/tools/permission-profiles/:profileId` | `expectedRevision` from the reviewed profile; also `expectedSelectionRevision` when changing the default set |
| `POST /api/v1/tools/permission-profiles/:profileId/archive` | Body `expectedRevision` captured for the archive confirmation |

Missing or malformed required preconditions return `400` before any write.
The Gateway supplies the authenticated actor; a token does not grant authority
over another operator's profile. Built-in profiles remain immutable. Existing
scope checks, deployment approval restrictions and deny-wins policy still apply.

Stale, mismatched or terminal profile revisions are rejected by the repository:

```json
{
  "code": "WRITE_CONFLICT",
  "details": { "reason": "PERMISSION_PROFILE_REVISION_CONFLICT" }
}
```

Selection conflicts use the same `WRITE_CONFLICT` code with
`details.reason: "PERMISSION_SELECTION_REVISION_CONFLICT"`. The review token
binds the authenticated actor, normalized operation and target scope, requested
contexts, selected profile revision and permission-domain generation. Review
alone does not activate a profile or change its defaults.

Clients should handle `409` as a review conflict and retain their draft. Do not
fetch a new revision and automatically retry the old mutation. A successful
update returns the canonical snapshot captured inside its transaction.

## Storage owner and limits

`PermissionProfileRepository` compares a SHA-256 digest of the canonical profile,
including its identity, scope, rules, status and timestamps. The comparison and
mutation run inside an immediate SQLite transaction or a PostgreSQL transaction.
All profile and selection writers acquire the singleton selection guard before
profile row locks, including writers targeting an empty context or a different
profile. The conditional profile update also checks the prior `updated_at`.
The timestamp advances by at least one millisecond for each accepted save or
archive, including same-value writes and edits that restore earlier values.
This prevents a previously consumed revision from becoming valid again.

The repository advances the persisted generation whenever it creates, edits or
archives a profile, or changes an activation. Reverting a selection to an empty
context cannot revive an earlier review. This intentionally invalidates pending
selection reviews across the permission domain, even when the intervening change
was in another scope. That conservative tradeoff avoids missing cross-profile
changes; it can require an extra review during concurrent settings activity.

The review lists up to 1,000 explicit activation records in the exact target
scope and fails closed if that bound is exceeded. Inherited policy and existing
runtime resolution still apply. This does not change the separate runtime
activation-enumeration limit or local-operator-override lifecycle.

SQLite migration 228 and PostgreSQL migration 173, `permission_profile_selection`,
add the singleton guard/generation table. They preserve existing profiles and
activation history; reapplication preserves the initialized generation. The
record revision itself still requires no additional profile column. The guard
coordinates repository writers, not arbitrary direct database mutations. Existing
mutation commit markers and safe post-commit publication remain in place.

## Verification

- SQLite and actual temporary PostgreSQL checks cover independent connections
  racing update/update and update/archive, stale and wrong-profile tokens,
  same-value and restored-value edits, immutable built-ins, archived profiles,
  and rollback of an enclosing transaction.
- Independent SQLite and actual PostgreSQL writers also race activation against
  activation, default creation and default updates in initially empty contexts.
  One wins and the other conflicts, with no partial profile or activation. Tests
  cover actor/context mismatch, missing tokens, selection reversion, rollback,
  additive schema preservation and generation-preserving reapplication.
- Gateway tests cover required preconditions, actor ownership, unchanged token
  forwarding, structured conflicts and committed mutation truth. Separate
  service tests check delegation to the atomic repository owner; storage tests
  verify that ordinary edits do not reassert profile defaults.
- Shared API tests check exact profile addressing and revision transport.
  Settings tests retain a rejected draft even when reload returns the old token.
- `pnpm verify:permissions:revisions` runs a temporary Gateway/database and the
  production Settings UI. Actual API writes race the browser's reviewed save and
  archive confirmation, activation, default edit and default creation. The two
  scenarios check all five rejected writes, draft retention, explicit reviewed
  retries and narrow-screen review/application at 390 px. Screenshots, canonical
  snapshots and expected conflict responses are retained.

These checks use task-owned temporary state. They do not attach, partition,
format or mount a drive, install a service, use live model credentials, or send
external messages. See the
[comparison implementation ledger](testing/COMPARISON_IMPLEMENTATION_STATUS.md)
for retained run evidence and the remaining plan.
