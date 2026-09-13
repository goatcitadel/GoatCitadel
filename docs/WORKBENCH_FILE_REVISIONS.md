# Workbench file and path revisions

The Gateway owns editor save preconditions. A browser preflight read improves
conflict visibility, but a successful preflight does not authorize an unconditional
write. The original reviewed revision accompanies the eventual save.

## API contract

`GET /api/v1/chat/sessions/:sessionId/workbench/file?path=index.ts` returns an
opaque `revision` with the file contents. The revision binds the session, project,
canonical project and file paths, physical file identity, filesystem change
metadata and exact file bytes. It is a precondition, not an access grant.

`PUT /api/v1/chat/sessions/:sessionId/workbench/file` requires:

```json
{
  "path": "index.ts",
  "content": "export const value = 2;\n",
  "expectedRevision": "<revision returned with the reviewed file>"
}
```

For creation, explicitly send `expectedRevision: null`; the path must still be
absent. Missing or malformed revisions fail validation. Null cannot replace an
existing file. Older clients must adopt this contract; there is no unconditional
save fallback.

A stale save returns HTTP `409`, code `WRITE_CONFLICT`, and
`details.reason: WORKBENCH_FILE_REVISION_CONFLICT`. No file write occurs for a
rejected precondition. `WORKBENCH_WRITE_LOCK_BUSY` also returns `409` when another
Workbench operation holds the project lock beyond the bounded acquisition wait.

## Editor behavior

Open **Activity**, then **Open build editor** in Chat to reach the editor.

The editor keeps its original revision while the operator types. Observed or
server-reported conflicts retain the draft and show the latest file for review.
The operator chooses **Review latest file**, then **Use this version and keep my
draft**, before saving against the new revision. The review does not itself save.
Edits made after a save is submitted remain dirty when its acknowledgement arrives.

The Gateway captures the saved file snapshot before follow-up validation and
publication. A later writer cannot change the contents acknowledged for that
save. A later read can legitimately return a newer revision. If I/O has started
and confirmation or follow-up fails, the route preserves non-retryable mutation
truth; the editor retains its draft and the operator must reload before retrying.

## Filesystem coordination and boundaries

Workbench saves acquire `.goatcitadel-workbench.lock` in the canonical project
root using exclusive creation. Independent Gateway processes sharing that
physical project coordinate through the same file. Workbench file operations,
patch application, revert operations and validation commands use that lock too.
The lock is hidden from Workbench trees and change lists and reserved against
editor, file-action, patch and revert access.

Existing files are opened without truncation and checked through their file
descriptor before writing. Bounded reads compare file identity and change
metadata before and after reading. Saves preserve the existing file identity
and permissions, and reject symbolic-link and multiply linked file writes.
Project scope, write jails and realpath checks remain authoritative. The editor's
existing 256 KiB limit applies.

The lock coordinates Workbench operations. It is not an operating-system
transaction or a hostile-process boundary. Uncooperative external editors,
shell commands, or file tools that do not use this owner can still race I/O.
In-place writes are not crash-atomic: a process or machine failure can leave a
partial file. Git and the operator's backups remain necessary for recovery.

## File action reviews

Create, rename, move, duplicate and delete use a separate explicit review.
In **Files**, expand **File actions**, choose the action and project-relative
paths, then choose **Review file action**. The review shows the source,
destination, affected paths and total bytes. **Apply reviewed action** submits
that exact review. Changing an input or switching the session, project or
worktree clears the review. Pending replies cannot replace later form edits.

`POST /api/v1/chat/sessions/:sessionId/workbench/file-operation/preview`
accepts `operation`, `path`, optional `targetPath`, and initial `content`
for `create_file` only. It returns a canonical `input`, opaque `revision`,
`sourceKind`, complete `affectedPaths` and `totalBytes`. Preview does not
perform the file action. It still checks the owner's policy and project scope.

`POST /api/v1/chat/sessions/:sessionId/workbench/file-operation` requires
those same action fields plus `expectedRevision` from the explicit review.
Missing, null or malformed revisions return 400; there is no unconditional
compatibility fallback. The review binds session, project, physical root,
normalized action and initial content, source identity and exact recursive
contents, and the physical identity of source/destination parents. Creation and
move destinations must be absent. Parent timestamps are excluded because the
project write lock and unrelated sibling changes update them.

Review and apply each hold the same project lock used for content saves. Apply
rechecks the canonical project binding, computes the current review and compares
it before starting the operation. A changed source, folder membership,
destination or project returns 409 / `WRITE_CONFLICT` with reason
`WORKBENCH_PATH_REVISION_CONFLICT`. The form retains the entered paths and
requires a fresh explicit review. No action is automatically retried. As with
content saves, post-mutation response or publication failures retain committed
truth and require inspection before another attempt.

Recursive reviews include at most 500 paths, 32 MiB of file bytes and 32 folder
levels. Exceeding a limit fails the review; it never presents a truncated scope
as complete. Symbolic links, junctions, special files, protected descendants,
Windows device names and alternate data streams cannot enter this workflow.
Git metadata, node_modules and lock aliases remain protected. Duplication keeps
the editor's existing file-only, text-only 256 KiB boundary.

These are cooperating Workbench preconditions, not crash-atomic directory
transactions or exclusion of uncooperative external filesystem writers. Other
GATE-02 owners and full comparison acceptance remain open.

## Retained lock recovery

The lock records the creating PID and start time. Cleanup removes only the
lock identity created by the current operation. It never deletes a replacement
lock or takes over a lock based on age or an apparently dead PID.

After an unexpected Gateway stop, first verify the exact project root and stop
or wait for every Workbench process sharing it, including other machines. Inspect
the retained lock and current files. Remove only that project's verified regular
lock file once no writer remains, then reload the file and review its contents.
Do not infer ownership from a drive letter, timestamp or PID alone. Ordinary
verification does not perform this manual recovery or touch drive partitions,
formats, mounts, installed services or user databases.

## Verification

Focused tests cover independent-process competition, wrong scope, missing
preconditions, explicit creation, file replacement, intervening changes,
hardlinks, lock cleanup, post-write failures and retained editor drafts.
`pnpm verify:code:workbench-loop` includes the owner checks and a browser scenario
that inserts an actual Gateway write after the browser's preflight, then checks
the conflict, retained draft and explicitly reviewed save. It then changes the
actual source after a rename review, checks that the stale action leaves the
source and destination unchanged, and requires a fresh review before renaming.
Desktop and narrow screenshots accompany the result. Its provider and Git
repository fixtures are local and temporary.

Exact results and remaining acceptance are recorded in the
[comparison implementation evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md).
