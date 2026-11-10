# Auto approvals for Chat file work

The operator approved the managed project workspace described below on November 8, 2026.

## Windows project workspace decision

Auto owns file paths and revisions within a managed project workspace. The original checkout is a separate destination for an explicit publish action. The tested NTFS sharing lease allowed additional hard links, streams, and attribute changes while held. Windows also documents replacement failures that can leave the original under a different name. The managed workspace keeps save and restore within a transaction owned by the Gateway.

- Bind every file to its workspace, project, and canonical relative path. Use Windows-compatible path validation and collision rules consistently on every host. Treat file content as bytes and retain its hash. Windows attributes and alternate streams belong to the external checkout and require an explicit supported import or publish policy.
- Create checks that the logical path is absent and commits the first revision and its receipt together. Edit checks the expected current revision, retains that revision, and advances the head and receipt in one transaction. A stale write returns a conflict. Replaying the same durable effect returns its original receipt.
- Restore checks that the current head matches the saved edit's resulting revision and that the operator still has authority. It creates a new revision containing the exact prior bytes. A newer edit produces a conflict. The receipt and its retained bytes survive a restart. The save receipt can be restored once, and retries return the same result.
- Delete requires the existing explicit approval flow. Bind the approval to the file and its exact current revision. Record a tombstone and consume the approval with the same durable effect. Rename and move need explicit approval when they remove a source path.
- Chat identifies the managed workspace and shows save and restore results. Publishing needs its own operator action against the original checkout. Verify any destination write independently and present conflicts for review. The managed store gives no new access to host paths, processes, or external tools.

The managed implementation is available for local authenticated project Chat on SQLite and requires durable Chat execution. Existing installations must allow the desired managed tools in `config/tool-policy.json` under `tools.allow`. The four tools are `project.files.list`, `project.files.read`, `project.files.save`, and `project.files.delete`. Use Download for the manual publishing handoff.

On Windows, a policy-allowed `fs.write` to a verified existing regular file in the original project asks for explicit approval. Auto binds the approval to the target and its current bytes. Rejecting leaves the file untouched. Approval permits one overwrite through a native handle after the Gateway rechecks the target and current policy. This overwrite has no managed restore receipt. Unsupported targets and other direct write methods remain blocked.

The sections below record the original checkout approach and its acceptance cases. The managed implementation applies the corresponding guarantees to logical paths and stored bytes.

## Intent

Reduce interruptions during ordinary project work. The operator wants new files to save immediately, existing files to save automatically when the exact previous version can be restored in one click, and every deletion to require an explicit decision.

## Approaches considered

1. Create new files automatically and ask before any overwrite. This is simpler to enforce, but it still interrupts routine editing.
2. Create new files automatically and allow overwrites with verified recovery. The operator chose this behavior for managed documents and ordinary project files. It requires durable file history and conflict-safe restore.
3. Use a model reviewer to approve commands. This can consider more context, but it cannot guarantee that an arbitrary command's effects can be restored. Keep automatic eligibility in the Gateway's policy and execution checks.

## Proposed scope

Auto is an operator-selected mode for the current Chat session. The existing mode remains the default. Auto applies to local, project-scoped Chat work, including resumed turns under the same session and workspace. Recheck current policy and the active mode immediately before any automatic side effect. Changing workspace or turning Auto off removes automatic eligibility. Delegated and inbound remote callers remain outside this first version.

| Action | Auto behavior |
| --- | --- |
| Read or search files | Run known read-only operations within authorized roots and honor protected paths and disclosure rules. |
| Create a document or ordinary project file | Create exclusively in an authorized workspace or project path. If the destination exists, surface a conflict or use an explicitly requested new name. An automatic create never becomes an overwrite. |
| Edit an existing document or project file | Save automatically only when the Gateway can retain, verify, and restore the exact previous version under the same authority. Use the managed document revision path where applicable and retain exact original bytes for ordinary files. |
| Delete a file or directory | Ask before every allowed deletion, including trashing and moves that remove the source entry. Existing policy can still block the action outright. Auto does not honor broad approval relief for deletes. |
| Overwrite without verified recovery | Ask before performing the allowed write, with a reason recovery is unavailable. A stale edit is a conflict and needs a fresh proposal. |
| Execute commands | Automatically admit only a small set of verified read-only operations. Prefer structured tools. Block execution if the Gateway cannot rule out deletion or enforce a pause before each deletion. |
| Send, publish, or change permissions | Keep existing explicit governance for external effects and permission changes. |

Existing deny-wins rules, Wards, tool availability, write roots, and protected paths still apply. Where current policy denies `fs.write`, turning on Auto cannot enable it. Reuse existing project-scoped write authority if it covers the operation. If it is missing, surface a one-time, project-scoped authorization through the existing governance flow wherever policy permits. Subsequent qualifying saves proceed automatically.

The operator chose to block commands that could delete files until the runtime can ask before each deletion. The current command runner cannot intercept arbitrary process side effects, so Auto blocks opaque scripts, package tasks, and Code Mode or external agent runs whose filesystem effects it cannot enforce. A command-level approval, pre-existing grant, or resumed approval cannot clear this block while Auto is active. Apply the check before execution on every callable path, including wrappers and background launches. Future support must pause before each deletion and bind the operator's decision to the specific target.

## Save and restore contract

- Resolve the target under existing Gateway path authority. Bind the edit and its receipt to the workspace, target, and expected revision. Use the workbench revision and locking primitives where their guarantees fit. Their existing lock coordinates GoatCitadel writers. Prove safety separately for an external editor, path swaps, aliases, and platform-specific filesystem behavior.
- Before replacing a file, durably store and verify the exact prior bytes and the supported metadata necessary for an equivalent restore. Store recovery data privately under Gateway authority and keep it out of model context and logs. Unsupported file kinds, metadata, volumes, or sizes and unavailable recovery storage make the write ineligible for Auto. Preserve the current byte representation, including line endings and encoding.
- Publish a success receipt with the before and after revisions only once the write and restore record are recoverable. Define crash reconciliation between history persistence and file replacement. A retry must preserve the original snapshot and must never replay a write against a newer revision. If the platform cannot safely perform the conditional write, keep that operation behind approval.
- The successful Chat result offers **Restore previous version**. A click restores the exact previous version when the current file still matches the recorded post-edit revision and current policy authorizes the restore. A later edit or missing target produces a conflict and preserves recovery data. Restore itself records a revision so it can be undone. Keep the snapshot for the life of its restore receipt, subject to explicit operator-directed history removal. If the recovery store cannot admit another snapshot within its storage limit, ask before writing.
- Keep the normal durable approval and resume flow for actions that ask. Audit automatic decisions with the relevant policy reason and linked revision or command receipt. The Chat UI reads Gateway outcomes and cannot grant authority or write project files directly.

## Acceptance cases

- Auto can create a new ordinary project file and a managed document without an approval. A concurrent create cannot replace the winner's file.
- An automatic edit to an ordinary file with mixed line endings can restore byte-for-byte in one click after a Gateway restart. A managed document can restore its exact prior revision.
- A competing editor, link swap, unavailable revision store, or expired authority cannot cause an unreviewed overwrite or loss of a newer revision. Recovery after an interrupted save reports the actual outcome.
- Any otherwise allowed Gateway-mediated delete asks, including when a broad allow grant is present. A protected target remains blocked. Unrecoverable overwrites ask.
- A verified read-only command runs. An opaque test, script, or delegated executable that could delete a file is blocked before launch, including after a prior command-level approval. The same check applies to foreground, background, and resumed execution.
- The default approval behavior, operator review in Chat, and durable resume still work. Verify the cockpit result and restore interaction, plus Windows and other supported filesystem behavior, before making a product claim.
