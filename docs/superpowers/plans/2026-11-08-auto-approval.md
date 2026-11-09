# Auto Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let Chat create managed project files and documents automatically and save edits with exact one-click recovery, while requiring review for deletions and blocking commands that could delete files.

**Architecture:** The Gateway owns Chat's Auto selection and checks it at each side-effect boundary. The managed project store commits file bytes, revisions, and restore receipts together. Cockpit displays the effective mode and the results reported by the Gateway.

**Tech Stack:** TypeScript, Fastify, React, SQLite, Postgres, and Vitest.

**Spec:** [Auto approvals for Chat file work](../specs/2026-11-08-auto-approval-design.md)

## Managed workspace implementation

The operator approved a managed project workspace for automatic saves on Windows. Tasks 1 and 2 supply the reviewed authority and execution checks. The native NTFS experiment remains evidence of the original approach. The steps below replace Tasks 3 through 5 for the managed workspace.

1. **Storage and recovery.** Add a workspace and project scoped repository for canonical paths, immutable byte revisions, current heads, and idempotent effects. Require an absent live head for create and an exact current revision for edit, restore, and delete. Save the bytes and advance the head within one transaction. Test mixed line endings, restart, competing writes, retries, scope mismatch, retention limits, tombstones, and both database adapters. Review the storage boundary before wiring it into Chat.
2. **Gateway and approvals.** Expose typed managed file tools through the reviewed Auto policy. Resolve workspace and project from the durable turn. Check deny rules, capability grants, protected paths, and current mode before executing any effect. Keep original-checkout operations out of the managed save path. Bind each deletion approval to the exact managed file revision and consume it through durable execution. Test normal Chat calls, resumed approvals, changed revisions, mode changes, scope mismatches, and blocked processes. Review this boundary before exposing the controls.
3. **Chat and publishing.** Show which workspace receives saves, render a restore action bound to the save receipt, and surface conflicts after newer edits. Provide an explicit export or publish flow with destination review. Any Gateway write to the original checkout requires separate authority and destination verification. Prove the operator flow on Windows and run the auth, governance, durable recovery, and surface checks before opening the release gate.

## Global constraints

- Auto is opt-in per local project Chat session. Existing sessions default to their current policy. Delegated and remote callers retain their existing authority boundaries.
- Existing deny rules, Wards, protected paths, auth, and workspace bounds take precedence. Missing write authority uses the existing project-scoped authorization flow where available.
- An allowed direct deletion always asks, including trash and moves that remove the source entry. Approval for a process cannot authorize incidental deletions.
- Use existing storage and migration conventions. Keep recovery payloads private. Keep each task reviewable and follow repository staging and commit rules.
- Keep Auto unavailable to operators until the complete safety and restore lanes pass on the supported platforms and filesystem types. An unsupported target falls back to the existing explicit approval path only when policy permits.

## Review focus

1. Mode or workspace changes during a parked turn must stop stale execution (Task 1).
2. Previously approved wrapper, background, and Code Mode paths must observe the same pre-execution block (Task 2).
3. External editor, directory substitution, and alias races must preserve the other writer's file (Task 3).
4. Restart after a partial write and before a success receipt must reconcile without duplicating writes (Task 4).
5. Double-clicked restore or a stale receipt from another workspace must never mutate a different revision or target (Task 5).

## Task 1 — Bind Auto to Chat and to current authority

**Owners:** `packages/contracts/src/durable-chat-turn-payload.ts`, `packages/storage/src/chat-session-prefs-repo.ts`, `apps/gateway/src/services/chat-session-service.ts`, `apps/gateway/src/services/gateway/durable-chat-turn-payload.ts`, `apps/gateway/src/routes/chat.sessions.ts`.

**Interface:** Add server-owned `ChatAutoBinding { sessionId: string; workspaceId: string; projectId: string; modeRevision: string }` to new durable turns admitted under Auto. Store the operator preference as `"standard" | "auto"` with a revision and the project/workspace binding. Use a versioned payload addition compatible with historical records.

- [ ] Add Gateway tests in `apps/gateway/src/services/gateway/chat-auto-binding.test.ts`. Assert that absent fields preserve standard behavior, model arguments cannot supply the binding, delegated or remote admission cannot opt in, and a changed mode revision or project invalidates a parked Auto turn. Include the inverse transition so an older standard turn cannot run unsafe effects after Auto is enabled.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/gateway/chat-auto-binding.test.ts`. Confirm the new cases fail before implementation.
- [ ] Add operator-authenticated mode read/update to Chat sessions with an expected mode revision. Admit a binding from persisted server authority only. When an in-flight turn's mode or scope changes, stop its side effects and require a fresh turn under the new setting. Recheck within the final effect boundary.
- [ ] Rerun the targeted suite and the existing `src/services/gateway/durable-chat-turn-payload.test.ts`. Require both to pass.

## Task 2 — Enforce the deletion and execution boundary

**Owners:** Add `apps/gateway/src/services/chat-auto-action-policy.ts`. Integrate with `tool-invocation-coordinator-service.ts`, `approval-resolution-effects-service.ts`, `code-mode-request-tool.ts`, and `packages/policy-engine/src/engine.ts` and `tool-executor.ts`. Trace capability wrappers and alternate approved dispatch before adding any executable to Auto.

**Interface:** `classifyChatAutoAction(action: ResolvedAutoAction): "read_only" | "create" | "edit" | "delete" | "review" | "blocked"`. Resolve effect, target, and executable identity from trusted Gateway/tool data. An unknown or opaque process is `"blocked"`.

- [ ] Add `apps/gateway/src/services/chat-auto-action-policy.test.ts` and approval-effect integration coverage. Assert structured project reads and a verified read-only operation run, protected paths deny, allowed delete/trash/move asks despite grants, and an exact one-use approval permits only the bound direct deletion after rechecking target and policy. Assert `shell.exec_background`, shell interpreters, package scripts, Code Mode, wrapped calls, and already-approved opaque process replays reach no spawn or external dispatch.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/chat-auto-action-policy.test.ts` and confirm failure before wiring the guard.
- [ ] Enforce the block before approval creation for prohibited processes and again before actual dispatch, including approval replay. Keep command eligibility closed by default. Start with structured read/search and, where proven, a pinned executable with exact argument and cwd constraints. Never infer safety from a command prefix, a tool label, or a script's stated purpose. Audit blocked and automatic decisions through the existing audit owner.
- [ ] Rerun focused tests and `pnpm verify:agentic:governance`. Require explicit assertions that blocked cases performed no side effects.

## Task 3 — Prove safe creation and conditional replacement on real files

**Owners:** `apps/gateway/src/services/workbench-file-revisions.ts`, `workbench-path-revisions.ts`, `tool-path-session-scope.ts`, `tool-path-resolution.ts`. Add `chat-auto-file-io.ts` as the byte-preserving boundary. Use existing workbench path checks and locking only for the guarantees each provides.

**Interface:** `createExclusive(target: AutoFileTarget, content: Uint8Array): Promise<FileRevision>` and `withConditionalWrite(target: AutoFileTarget, expected: FileRevision, action: (file: LockedAutoFile) => Promise<FileRevision>): Promise<FileRevision>`. `LockedAutoFile` reads exact bytes and supported metadata and writes while the platform boundary still protects the resolved target.

- [ ] Add `apps/gateway/src/services/chat-auto-file-io.test.ts` with separate-process races. Assert simultaneous creation yields one winner without truncation. Assert a noncooperating writer, ancestor swap, symlink/junction, or hard-link alias cannot cause a write to the wrong file or a lost revision. Assert unsupported volumes or metadata return an explicit ineligible result.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/chat-auto-file-io.test.ts src/services/workbench-file-revisions.test.ts`. Confirm the new cases fail before implementation.
- [ ] Implement exclusive creation and prove a conditional-write primitive on Windows first. Verify native handle semantics for excluding conflicting writes and path replacement, including parent path changes. A JavaScript lock, advisory lock alone, or hash check followed by an unconditional rename cannot satisfy this contract. If the existing runtime cannot provide the required primitive, keep the target ineligible and treat that platform's support as a release blocker. Cover each additional supported platform and filesystem explicitly.
- [ ] Rerun the focused suites on the claimed platform matrix. Require the tests to exercise the actual filesystem primitive. Platform skips provide no release proof.

## Task 4 — Journal ordinary edits and integrate managed revisions

**Owners:** Add `packages/storage/src/auto-file-recovery-repo.ts` and `apps/gateway/src/services/chat-auto-file-service.ts`. Register schema and repository in `packages/storage/src/async-storage.ts`, `sqlite/migration-registry.ts`, and `postgres/migrations.ts` using the live migration sequence. Integrate `document-editing-service.ts` and the existing filesystem executor through a Gateway-owned effect port. Reuse the document proposal's target-revision check.

**Interface:** `saveAutoFile(input: AutoSaveInput): Promise<AutoSaveResult>`. Results are `created`, `saved` with a workspace-bound recovery receipt, `conflict`, or `needs_approval`. Use the canonical durable effect ID as the idempotency key and bind it to the target and expected revision.

- [ ] Add `apps/gateway/src/services/chat-auto-file-service.test.ts` and SQLite/Postgres coverage in `packages/storage/src/auto-file-recovery-repo.test.ts`. Assert that recovery storage failure produces zero writes, and crashes before mutation, during mutation, and after mutation but before settlement do not replay blindly. Include binary bytes, mixed line endings, exhausted quota, and concurrent idempotent retries. Add managed-document cases to `document-editing-service.test.ts` for exact revision restore eligibility and stale proposals.
- [ ] Run `pnpm --filter @goatcitadel/storage exec tsx --test src/auto-file-recovery-repo.test.ts` and `pnpm --filter @goatcitadel/gateway exec vitest run src/services/chat-auto-file-service.test.ts src/services/document-editing-service.test.ts`. Confirm the new cases fail.
- [ ] Reserve quota and persist a prepared journal record with verified original bytes, supported metadata, and before and intended-after identities before mutation. Under Task 3's fence, recheck live policy, write, flush, and verify the resulting revision before marking the receipt restorable. On restart reconcile by comparing observed state to before and intended-after identities. A partial or otherwise unknown state preserves recovery and asks for operator intervention. Match managed proposal IDs to immutable revisions and use their storage transaction to link the outcome. Route eligible creates and edits through this service so no generic overwrite path bypasses the journal.
- [ ] Rerun both suites, exercise both storage adapters with the repo's integration harness, and run `pnpm verify:durable:recovery`.

## Task 5 — Restore and expose the operator workflow

**Owners:** Extend `chat-auto-file-service.ts`, `apps/gateway/src/routes/chat.sessions.ts`, `packages/mission-control-shared/src/api/chat-workbench-operations.ts`, and Cockpit's `ChatComposerControls.tsx` and `ChatTranscriptContent.tsx`. Add `ChatAutoFileReceipt.tsx` for the typed receipt and restore action.

**Interface:** `restoreAutoFile(input: { receiptId: string; workspaceId: string; actorId: string }): Promise<RestoreResult>` inside the Gateway. Derive `actorId` from auth. The client submits the receipt ID using the current session and workspace. Results are `restored`, `conflict`, or `unavailable`.

- [ ] Add `apps/gateway/src/routes/chat-auto-restore.test.ts` and `apps/mission-control-next/src/cockpit/areas/chat/ChatAutoFileReceipt.test.tsx`. Assert exact byte restore after restart, replay without a second mutation, cross-workspace rejection, and conflict without overwriting a later edit. Assert the operator sees the effective mode, an accessible **Restore previous version** control for a settled receipt, and truthful saved, blocked, waiting, and conflict outcomes.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/routes/chat-auto-restore.test.ts` and `pnpm --filter @goatcitadel/mission-control-next test src/cockpit/areas/chat/ChatAutoFileReceipt.test.tsx`. Confirm the new cases fail.
- [ ] Restore through the same conditional mutation and journal boundary against the receipt's after revision. Record the restore as a new revision. Keep the prior bytes for the life of the receipt unless the operator explicitly removes history. Show no restore success until the Gateway returns it. Reuse the existing inline approval and Inbox for actions that ask.
- [ ] Rerun targeted suites, then verify the live Cockpit flow on desktop and a narrow viewport. Run the applicable package typechecks, `pnpm verify:surface:regression`, `pnpm verify:runtime:truth`, `pnpm docs:check`, and `git diff --check`. Keep public claims scoped to the verified platform and storage matrix.
