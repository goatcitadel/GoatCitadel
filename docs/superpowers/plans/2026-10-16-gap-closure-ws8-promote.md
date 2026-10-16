# WS8 PR B — Aider Patch Promote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can promote a `patch_produced` Aider run into the Chat workbench. Promotion happens only under its own explicit approval, re-checks the patch artifact's sha256, and requires the workbench HEAD and tree state to equal the pin captured at plan time. The patch goes through the workbench path (`git apply --check`, then apply) and is recorded once in the run ledger. Docker posture does not change; only doc text this PR makes stale is corrected.

**Architecture:** Aider runs created against a ready, clean Chat workbench get a workspace pin (HEAD, state hash, worktree identity), frozen into the approved input binding. Pinned runs are seeded from the pinned commit through an isolated, alternates-backed baseline git dir outside the docker bind mount; the patch is the diff against that commit. A separate `code_mode.aider_promote` approval re-verifies the patch hash and the pin, then applies through a guarded workbench check-then-apply, and records the promotion in the run's `result_json`.

**Tech Stack:** TypeScript, Fastify gateway, vitest, git CLI.

**Spec:** `docs/superpowers/plans/2026-10-15-gap-closure-program.md` § WS8 Tasks 8.2/8.3; issue goatcitadel/GoatCitadel#368; tracker #341. PR A (8.1) is goatcitadel/GoatCitadel#389; its plan (`2026-10-16-gap-closure-ws8-replay.md`, Tasks 1–6) is on that branch, so tasks here are numbered from 7.

## Global Constraints

- Own worktree; branch `claude/gap-ws8-promote` off `origin/main`. Never edit `C:\personal-ai`. Never `git stash`.
- vitest with `--maxWorkers=2`, low priority, one heavy job at a time; re-run a failed file alone before treating it as real.
- Gateway focused test: `pnpm --filter @goatcitadel/gateway exec vitest run <file> --maxWorkers=2`.
- `prettier --write` only on changed files. Search with `git grep`.
- Never `architecture:baseline:update`. New service files get `C0` entries in `scripts/verification/baselines/architecture-new-service-allowances.json`. Owner counters stay at baseline: `capability-system-service.ts` 259, `approval-resolution-effects-service.ts` 259, `chat-workbench-service.ts` 71, `code-mode-verification-service.ts` 13, `gateway-route-composition-chat.ts` 141.
- `gateway-service.ts`: only the single +2-line edit in Task 11; `git diff --numstat` must show `2 0`; `gatewayLineCount` ≤ 13132.
- No migrations (promotion lives in `result_json`).
- No hostile-code sandbox claim. Docker `preview_only` / "Planned" stay (no proof lane on this machine; Refs #368).
- No personal paths in tracked files. Commits `<type>: <description>` ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions the code forces

- **F1:** `CapabilitySystemService` reaches the workbench only through callbacks composed in the `gateway-service.ts` constructor literal (~L1558). Add one property there: `applyChatSessionWorkbenchPatch: (sessionId, input) => this.routeServices.chatSessions.applyChatSessionWorkbenchPatch(sessionId, input)` (+2 lines; file is prettier-clean).
- **F2:** `repoScopePath` is not reachable on the capability side; the pin binds `worktreeIdentityHash` (sessionId + projectId + realpath, same formula as `captureWorktree`). Seeding uses `aider.repositoryRootRelPath` as a pathspec relative to the worktree root; scope is still enforced at promote by `assertPatchPathsInWorkbenchScope`.
- **F3:** Pin only a `ready` worktree with no changes; dirty/not-ready/sessionless runs get no pin and can never be promoted.
- **F4:** `result-envelope.json` on disk stays `audit_only`. Only the ledger copy changes to `policy: "promoted"` next to `run.result.aiderAdapter.promotion`; every read validates with the promotion record.
- **F5:** For seeded runs the computed diff wins; `aider.patch`, `aider.git.patch`, `.aider*` and the request file are excluded. Unpinned runs keep explicit-patch-first unchanged.
- **F6:** Baseline = `git init --bare <runTemp>/aider-baseline.git` + `objects/info/alternates` pointing at the operator repo's common-dir objects. No clone; nothing written to the operator repo or index.
- **F7:** The extracted capture takes `rootDir` to resolve stored workbench paths; the verification call site stays byte-identical.
- **F8:** Promotion stored via `codeModeRuns.upsert` inside `storage.runImmediateTransaction` (re-read then write).
- **F9:** The promote approval's linkage omits `sessionId`/`turnId` and its payload carries no code hashes, keeping it out of chat-continuation and `isCodeModeApproval` paths.
- **Metrics:** passing `this.options` whole (or spread) costs 0; `this.options.x` costs +1. Name new parameters `deps`, never `host`.

## Review Focus

1. Seeding writes nothing to the operator repo (Task 10 `seeding never touches the operator worktree`).
2. Pin TOCTOU: HEAD/state rechecked inside the workbench write lock before `git apply --check` (Task 11).
3. Crash after apply: an `applying` intent makes a retry return `promotion_outcome_unknown`, never re-apply (Task 12).
4. Patch hash read through the contained regular-file read; sha256 must equal both the envelope and the pending-action hash (Task 12).
5. Promoted posture validated on every read (Tasks 7, 12).

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/capabilities.ts` | `CodeModeAiderReplayPolicy`, `CodeModeAiderWorkspacePin`, `CodeModeAiderPromotionRecord`, `CodeModeAiderPromotionRequestResponse`; envelope `replay.policy` union |
| `packages/contracts/src/approvals.ts` | `PendingApprovalAction.actionType` adds `"code_mode.aider_promote"` |
| `apps/gateway/src/services/code-mode-aider-result-contract.ts` | pin/promotion parsers; `promoted` posture only with a matching record |
| `apps/gateway/src/services/code-mode-worktree-capture.ts` (new) | extracted git plumbing + worktree state/identity capture |
| `apps/gateway/src/services/code-mode-verification-service.ts` | imports the extracted capture (behavior unchanged) |
| `apps/gateway/src/services/code-mode-aider-workspace-pin.ts` (new) | capture pin at plan time; resolve the seed at execution time |
| `apps/gateway/src/services/code-mode-aider-workspace-seed.ts` (new) | isolated baseline git dir, materialize pinned tree, collect seeded diff |
| `apps/gateway/src/services/code-mode-aider-execution.ts` | `workspaceSeed?` input; seeded branch; unpinned path untouched |
| `apps/gateway/src/services/chat-workbench-service.ts` | guarded mode of `applyChatSessionWorkbenchPatch` |
| `apps/gateway/src/services/code-mode-aider-promotion.ts` (new) | request approval; execute approved promotion; ledger intent/finalize |
| `apps/gateway/src/services/capability-system-service.ts` | freeze pin; pass seed; dispatch promote; public request method; new option |
| `apps/gateway/src/services/approval-resolution-effects-service.ts` | route `code_mode.aider_promote` to `executeCodeModePendingApproval` |
| `apps/gateway/src/services/capabilities-route-service.ts`, `apps/gateway/src/routes/capabilities.ts` | `POST /api/v1/code-mode/runs/:runId/promote` |
| `apps/gateway/src/services/gateway-service.ts` | +2 lines (F1) |
| `code-mode-execution-backends.ts` + docs | 8.3 truth: governance strings and docs |

---

### Task 7: Contracts and result-contract relaxation

**Files:**
- Modify: `packages/contracts/src/capabilities.ts`, `packages/contracts/src/approvals.ts`, `apps/gateway/src/services/code-mode-aider-result-contract.ts`
- Test: `apps/gateway/src/services/code-mode-aider-result-contract.test.ts`

**Interfaces:**
- Contracts:
  - `export type CodeModeAiderReplayPolicy = "audit_only" | "promoted";` and `CodeModeAiderAdapterResultEnvelope.replay.policy: CodeModeAiderReplayPolicy` (`replaySafe: false` unchanged).
  - `export interface CodeModeAiderWorkspacePin { version: 1; sessionId: string; worktreeIdentityHash: string; worktreeHead: string; worktreeStateHash: string; capturedAt: string }`
  - `export interface CodeModeAiderPromotionRecord { version: 1; status: "applying" | "promoted"; approvalId: string; patchArtifactId: string; patchSha256: string; pin: CodeModeAiderWorkspacePin; startedAt: string; promotedAt?: string; resolvedBy?: string; changedFiles?: string[]; workbenchValidationStatus?: ChatSessionWorkbenchValidationStatus }`
  - `export interface CodeModeAiderPromotionRequestResponse { runId: string; status: "approval_pending" | "already_promoted"; approvalId?: string; expiresAt?: string; promotion?: CodeModeAiderPromotionRecord }`
  - The `run.result.aiderAdapter` shape gains `promotion?: CodeModeAiderPromotionRecord`.
  - `PendingApprovalAction.actionType` adds `"code_mode.aider_promote"`.
- Result contract:
  - `parseCodeModeAiderAdapterResultEnvelope(value: unknown, options?: { promotion?: unknown }): CodeModeAiderAdapterResultEnvelope` — `audit_only` accepted when `promotion` is absent or `applying`; `promoted` requires a parsed promotion with status `promoted`, outcome `patch_produced`, `promotion.patchSha256 === patchArtifact.artifact.sha256` and `promotion.patchArtifactId === patchArtifact.artifact.artifactId`; `audit_only` with a `promoted` record rejected; `replaySafe !== false` always rejected.
  - `parseCodeModeAiderWorkspacePin(value: unknown): CodeModeAiderWorkspacePin` — commit `/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/`, 64-hex hashes, non-empty `sessionId`.
  - `parseCodeModeAiderPromotionRecord(value: unknown): CodeModeAiderPromotionRecord`
  - `withPromotedCodeModeAiderReplayPosture(envelope, promotion): CodeModeAiderAdapterResultEnvelope` → copy with `replay: { replaySafe: false, policy: "promoted", reason: "Patch promoted into the Chat workbench under approval <id>; it is never re-applied." }`.

- [ ] **Step 1: Write failing tests:** `accepts promoted posture only with a matching promoted record`; `rejects promoted posture without a promotion record`; `rejects promoted posture when the record names a different patch hash`; `rejects audit_only posture paired with a promoted record`; `accepts audit_only posture with an applying intent`; `parseCodeModeAiderWorkspacePin rejects non-hex heads and missing sessions`. Existing audit_only tests unchanged.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/gateway exec vitest run src/services/code-mode-aider-result-contract.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: Implement.** `code-mode-aider-artifacts.ts` keeps calling without options. Rebuild `@goatcitadel/contracts` dist after changing contracts.
- [ ] **Step 4: Run** same + `code-mode-aider-artifacts.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(contracts): Aider workspace pin and promotion record with a promoted posture`.

### Task 8: Extract worktree capture; workspace pin

**Files:**
- Create: `apps/gateway/src/services/code-mode-worktree-capture.ts`, `apps/gateway/src/services/code-mode-aider-workspace-pin.ts`
- Modify: `apps/gateway/src/services/code-mode-verification-service.ts` (move `captureWorktree`, `hashUntrackedEntry`, `runGit`, `buildSanitizedGitEnvironment`, `readContainedRegularFile`, `assertPathInside` into the new file; import back)
- Test: `apps/gateway/src/services/code-mode-aider-workspace-pin.test.ts`; `code-mode-verification-service.test.ts` passes unchanged.

**Interfaces:**
- `code-mode-worktree-capture.ts`:
  - `runCodeModeGit(args: string[], options: { cwd?: string; gitDir?: string; workTree?: string; timeoutMs: number; maxBuffer?: number }): string` — same `-c` hardening and sanitized env; the `cwd` form produces argv identical to today's `runGit`.
  - `captureCodeModeGitWorktreeState(worktreePath: string, timeoutMs: number): { headHash: string; stateHash: string; changedFiles: string[]; changedFilesTruncated: boolean }` — same stateHash formula.
  - `captureCodeModeWorkbenchWorktree(storage: Pick<AsyncStorage, "chatSessionWorkbench">, binding: { sessionId?: string; runId: string }, timeoutMs: number, options?: { rootDir?: string }): Promise<CodeModeWorktreeCapture>` — today's `WorktreeCapture` + `worktreePath?` (realpath); stored path resolved via `path.resolve(options.rootDir ?? process.cwd(), stored)`; `"[outside-root]"` refused.
  - `readContainedRegularFile(candidate, root, maxBytes): Buffer`; `assertPathInside(candidate, root): void`; `CODE_MODE_GIT_CAPTURE_TIMEOUT_MS = 15_000`.
- `code-mode-aider-workspace-pin.ts`:
  - `CodeModeAiderWorkspacePinDeps { storage: Pick<AsyncStorage, "chatSessionWorkbench">; rootDir: string }`
  - `captureCodeModeAiderWorkspacePin(deps, binding: { sessionId: string; runId: string }, options?: { now?: () => Date; gitCaptureTimeoutMs?: number }): Promise<CodeModeAiderWorkspacePin | undefined>` — `undefined` unless capture valid AND `changedFiles.length === 0`; storage errors propagate.
  - `CodeModeAiderWorkspaceSeed { worktreePath: string; baseCommit: string; pin: CodeModeAiderWorkspacePin }`
  - `resolveCodeModeAiderWorkspaceSeed(deps, pin, run: { sessionId?: string; runId: string }): Promise<CodeModeAiderWorkspaceSeed>` — throws on session mismatch, worktree not ready, or `identityHash !== pin.worktreeIdentityHash`. HEAD may have moved (seed uses the pinned commit).

- [ ] **Step 1: Write failing tests** (real mkdtemp git repo, fake `chatSessionWorkbench.get`): `pins a ready clean workbench at its HEAD`; `does not pin a dirty, not-ready or missing workbench`; `pin state hash equals the verification capture for the same tree`; `resolveCodeModeAiderWorkspaceSeed refuses a different worktree identity`; `resolveCodeModeAiderWorkspaceSeed refuses a session mismatch`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the move, then the pin module. Verification counter ≤ 13.
- [ ] **Step 4: Run** pin test + `code-mode-verification-service.test.ts` → PASS.
- [ ] **Step 5: Allowances** — `C0` entries for both new files with measured counts (`countDependencyMemberAccesses` / `countHostMemberAccesses` from `scripts/verification/lib/architecture-metrics.mjs`).
- [ ] **Step 6: Commit** `refactor(gateway): extract Code Mode worktree capture and add the Aider workspace pin`.

### Task 9: Freeze the pin into the approved Aider binding

**Files:**
- Modify: `apps/gateway/src/services/capability-system-service.ts`
- Test: `apps/gateway/src/services/capability-system-service.test.ts` (Map-backed `chatSessionWorkbench.get` for the new cases only; existing Aider tests byte-identical)

**Interfaces:**
- `hashCodeModeInputBinding(input, aiderRequest?, aiderExecution?, aiderWorkspacePin?)` — JSON `{ input, aiderRequest, aiderExecution, ...(aiderWorkspacePin ? { aiderWorkspacePin } : {}) }` when `aiderRequest` is set; unpinned hash unchanged.
- `readFrozenCodeModeInputBinding` also returns `aiderWorkspacePin?` (parsed with `parseCodeModeAiderWorkspacePin` when `policySnapshot` has own property `codeModeAiderWorkspacePin`), included in the recomputed hash.
- `createCodeModeRun`: after the turn checks, `aiderWorkspacePin = normalizedAiderRequest && sessionId ? await captureCodeModeAiderWorkspacePin(this.options, { sessionId, runId }) : undefined`, then compute `runInputHash`; policy snapshot gains `codeModeAiderWorkspacePin`; `buildCodeModeApprovalPayload` gains `aiderWorkspacePin?` shown as `{ worktreeHead, sessionId }`.

- [ ] **Step 1: Write failing tests:** `freezes the workspace pin into the approved input binding` (pin head in policy snapshot, hash formula, approval payload); `does not pin Aider runs without a ready clean workbench`; `refuses execution when the frozen workspace pin was edited` (`input snapshot hash mismatch`). Existing binding test unchanged.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/gateway exec vitest run src/services/capability-system-service.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: Implement.** Counter must read 259.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(gateway): pin the workbench HEAD into approved Aider runs`.

### Task 10: Seed pinned Aider runs from the pinned commit

**Files:**
- Create: `apps/gateway/src/services/code-mode-aider-workspace-seed.ts`
- Modify: `apps/gateway/src/services/code-mode-aider-execution.ts`, `apps/gateway/src/services/capability-system-service.ts` (`executeAiderAdapterRun` and its call site)
- Test: `apps/gateway/src/services/code-mode-aider-execution.test.ts` (real mkdtemp git repo + existing fake child/`spawnCommand`), `apps/gateway/src/services/code-mode-aider-workspace-seed.test.ts`

**Interfaces:**
- `CODE_MODE_AIDER_BASELINE_GIT_DIR = "aider-baseline.git"`, `CODE_MODE_AIDER_SEED_MAX_FILES = 20_000`, `CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES = 8 * 1024 * 1024`.
- `SeededCodeModeAiderWorkspace { baselineGitDir; workTreeRoot; baseCommit; pathspec; excludePathspecs: string[] }`
- `seedCodeModeAiderWorkspace(input: { seed: CodeModeAiderWorkspaceSeed; runTempRoot: string; workTreeRoot: string; pathspec: string; reservedRelPaths: string[]; timeoutMs?: number }): Promise<SeededCodeModeAiderWorkspace>` — (1) assert baseline not inside `workTreeRoot`; (2) `git init --bare --quiet` + write `objects/info/alternates`; (3) `cat-file -e <sha>^{commit}`; (4) `ls-tree -r --name-only -z <sha> -- <pathspec>`: refuse > max files or a tracked reserved path; (5) `--git-dir <baseline> --work-tree <workTreeRoot> checkout <sha> -- <pathspec>`.
- `collectSeededCodeModeAiderPatch(seeded, options?): Promise<{ kind: "git_patch"; content: string; fileCount: number; baseRef: string } | undefined>` — `add -A -- <pathspec> <excludes>` then `diff --cached --binary --full-index <sha> -- <pathspec> <excludes>` (pathspec restriction mandatory). Excludes: `:(exclude)<reserved>`, `:(exclude)aider.patch`, `:(exclude)aider.git.patch`, `:(exclude,glob)**/.aider*`. Empty → `undefined`; over max bytes → throw.
- `CodeModeAiderExecutionInput.workspaceSeed?: CodeModeAiderWorkspaceSeed`. When set: seed before writing `aider/request.md` (reserved path `posix.join(rootRelPath, CODE_MODE_AIDER_MESSAGE_FILE)`, work-tree root `runRoot`, pathspec `repositoryRootRelPath`); no `input.*`; after the run the patch comes from `collectSeededCodeModeAiderPatch` with `baseRef` on `patchArtifact`; collection throw → outcome `failed`, code `AIDER_PATCH_CAPTURE_FAILED`, no patch; seeding errors thrown before `beforeDispatch`. Unset → unchanged.
- `executeAiderAdapterRun` gains `aiderWorkspacePin?` and `sessionId?`, resolves the seed via `resolveCodeModeAiderWorkspaceSeed(this.options, pin, { sessionId, runId })`.

- [ ] **Step 1: Write failing tests:** `seeds a pinned run from the pinned commit and diffs against it` (patch has `diff --git a/src/a.ts b/src/a.ts`, `baseRef` = sha, no `input.ts`, `git apply --check` succeeds against the pinned repo); `seeding never touches the operator worktree` (status, HEAD and `count-objects -v` identical; docker `--mount src=` excludes `aider-baseline.git`); `ignores aider.patch, the request file and .aider files in seeded runs`; `refuses to seed when the pinned commit is unavailable` (`spawnCommand` never called); `refuses to seed over a tracked aider/request.md`; `unpinned runs keep the synthetic input workspace` (no `aider-baseline.git`).
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/gateway exec vitest run src/services/code-mode-aider-execution.test.ts src/services/code-mode-aider-workspace-seed.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: Implement.** `C0` allowance for the seed file.
- [ ] **Step 4: Run** those + `code-mode-execution-backend-runner.test.ts` + `capability-system-service.test.ts` → PASS; capability counter 259.
- [ ] **Step 5: Commit** `feat(gateway): seed pinned Aider runs from the pinned commit in an isolated baseline`.

### Task 11: Guarded check-then-apply workbench path

**Files:**
- Modify: `apps/gateway/src/services/chat-workbench-service.ts`, `apps/gateway/src/services/capability-system-service.ts` (options type only), `apps/gateway/src/services/gateway-service.ts` (+2 lines, F1)
- Test: `apps/gateway/src/services/chat-workbench-service.test.ts` (existing git workbench fixture)

**Interfaces:**
- `ChatSessionWorkbenchPatchApplyInput extends ChatSessionWorkbenchPatchApplyRequest { expectedWorktreeHead?: string; expectedWorktreeStateHash?: string }` — guarded mode = `expectedWorktreeHead` set; the HTTP body schema strips these keys.
- `ChatWorkbenchPatchRefusalReason = "out_of_scope" | "head_moved" | "state_drift" | "check_failed"`; `class ChatWorkbenchPatchRefusedError extends ConflictError { readonly reason }` (`code: "STATE_CONFLICT"`, `details: { reason }`).
- `applyChatSessionWorkbenchPatch(deps, sessionId, input: ChatSessionWorkbenchPatchApplyInput)` — guarded mode: scope errors → `out_of_scope`; inside `withWorkbenchWriteLock`, `captureCodeModeGitWorktreeState` must match both expected values (else `head_moved` / `state_drift`); then `applyPatchWithScope(..., true)` (non-zero → `check_failed`, before any apply); then the real apply and the existing validation/state flow. Non-guarded calls unchanged; restructure, don't duplicate; counter 71.
- `CapabilitySystemServiceOptions.applyChatSessionWorkbenchPatch?: (sessionId, input) => Promise<ChatSessionWorkbenchPatchApplyResponse>`.
- `gateway-service.ts`: `applyChatSessionWorkbenchPatch: (sessionId, input) => this.routeServices.chatSessions.applyChatSessionWorkbenchPatch(sessionId, input),` next to `getChatSessionWorkbench`.

- [ ] **Step 1: Write failing tests:** `guarded apply refuses when HEAD moved without touching files`; `guarded apply refuses on dirty-state drift`; `guarded apply runs git apply --check first and refuses a failing check without mutating the worktree`; `guarded apply refuses an out-of-scope patch with a typed refusal`; `guarded apply applies a scoped patch when the pin still holds`. Existing patch tests green.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/gateway exec vitest run src/services/chat-workbench-service.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: Implement.** gateway-service edit by hand; `git diff --numstat` shows `2 0`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(gateway): guarded check-then-apply workbench patch path`.

### Task 12: Approval-gated Aider promote

**Files:**
- Create: `apps/gateway/src/services/code-mode-aider-promotion.ts`
- Modify: `capability-system-service.ts`, `approval-resolution-effects-service.ts` (the pending-action `code_mode.run` dispatch check, ~L2959, only), `capabilities-route-service.ts`, `routes/capabilities.ts`
- Test: `code-mode-aider-promotion.test.ts`, `approval-resolution-effects-service.test.ts`, `capability-system-service.test.ts`, `routes/capabilities.test.ts`

**Interfaces:**
- `CODE_MODE_AIDER_PROMOTE_APPROVAL_KIND = CODE_MODE_AIDER_PROMOTE_ACTION_TYPE = "code_mode.aider_promote"`; `isCodeModePendingActionType(actionType): boolean` (true for `code_mode.run` and the promote action).
- `CodeModeAiderPromotionDeps { storage: AsyncStorage; rootDir; artifactRoot; createApproval; publishRealtime; applyChatSessionWorkbenchPatch?; gitCaptureTimeoutMs?; now? }`
- `CodeModeAiderPromotionRefusalReason` = `run_not_completed | no_patch | not_pinned | pin_binding_mismatch | session_mismatch | patch_hash_mismatch | worktree_not_ready | worktree_identity_changed | worktree_head_moved | worktree_state_drift | patch_out_of_scope | patch_check_failed | promotion_in_progress | promotion_outcome_unknown | workbench_apply_unavailable`
- `requestCodeModeAiderPromotion(deps, run, operatorId?): Promise<CodeModeAiderPromotionRequestResponse>` — requires a completed run, a `patch_produced` envelope and a pin read from the verified policy snapshot (bytes sha256 = `run.policySnapshotArtifact.sha256`, JSON hash = `run.policySnapshotHash`, `snapshot.codeModeInputHash === run.codeModeInputHash`), else `ConflictError` with `details.reason`. Already promoted → `already_promoted`, no approval. Otherwise `createApproval({ kind, riskLevel: "caution", payload: { runId, workspaceId, patchSha256, patchArtifactId, fileCount, pinnedHead }, linkage: { workspaceId, runId, toolName: kind, actionType: kind }, expiresAt: +15m })`, `pendingApprovalActions.upsertPending({ actionType, request: { runId, patchSha256, patchArtifactId } })`, `approvalEvents.append("pending_action_registered")`.
- `executeApprovedCodeModeAiderPromotion(deps, approvalId, pending): Promise<ToolInvokeResult>` — order: (1) re-read run; (2) existing `promoted` → mark executed `{ alreadyPromoted: true }`, no apply; `applying` under another approval → `promotion_in_progress`; under this approval → `promotion_outcome_unknown`; (3) outcome/pin/session checks and pending-request sha = envelope sha; (4) read the patch via `readContainedRegularFile` under `artifactRoot`, sha must equal envelope sha; (5) recapture with `rootDir`: identity, then head, then state; (6) transaction: write `applying` intent; (7) `deps.applyChatSessionWorkbenchPatch(sessionId, { patch, expectedWorktreeHead, expectedWorktreeStateHash })` — refusal error → clear intent, refuse with mapped reason; any other error → keep intent, `promotion_outcome_unknown`; (8) transaction: finalize `promoted` + `withPromotedCodeModeAiderReplayPosture`; (9) `markResolved`, `approvalEvents.append("approved_action_executed", { outcome })`, `publishRealtime("code_mode_aider_patch_promoted" | "code_mode_aider_promotion_refused", "capabilities", ...)`; (10) return `{ outcome: "executed" | "blocked", policyReason, auditEventId, result }`.
- `CapabilitySystemService.requestCodeModeAiderPromotion(runId, scope: Pick<CodeModeRunListOptions, "sessionId" | "turnId" | "workspaceId">, operatorId?)` → `getCodeModeRunInScope` then the module with `{ ...this.options, artifactRoot: this.artifactRoot }`. `executeApprovedCodeModeRun` dispatches the promote action right after its `pending` read. `selectAiderEnvelopeArtifact` passes `{ promotion: adapter.promotion }`. Counter 259.
- `approval-resolution-effects-service.ts`: the pending-action `code_mode.run` dispatch check becomes `isCodeModePendingActionType(...)`; other `code_mode.run` checks unchanged; counter 259.
- Route `POST /api/v1/code-mode/runs/:runId/promote` (`runParamsSchema` + `runDetailQuerySchema`, `workspaceId ?? DEFAULT_WORKSPACE_ID`, `request.authActorId`; 409 on `ConflictError`, 400 otherwise); `CapabilitiesRoutePort` adds `"requestCodeModeAiderPromotion"`.

- [ ] **Step 1: Write failing tests** in `code-mode-aider-promotion.test.ts` (real mkdtemp git repo; real `Storage({ dbPath: ":memory:" })` + `createSqliteAsyncStorage`; artifacts persisted under `rootDir`; policy-snapshot artifact holding the pin; faithful fake `applyChatSessionWorkbenchPatch` doing the guard check + `git apply --check` + apply and throwing `ChatWorkbenchPatchRefusedError`): `refuses promote when the patch artifact hash no longer matches` (`patch_hash_mismatch`, worktree unchanged, no promotion); `refuses promote when the workbench HEAD moved since plan time` (`worktree_head_moved`, apply not called); `applies the patch through the workbench and records the promotion in the ledger` (file changed; promotion `{ status: "promoted", approvalId, patchSha256 }`; envelope `policy: "promoted"` parses with `{ promotion }`; pending action `executed`; event `approved_action_executed`); `refuses promote for an unpinned run` (`not_pinned`, no approval); `refuses promote when the workbench has uncommitted drift since plan time` (`worktree_state_drift`); `refuses promote without mutating when git apply --check fails` (intent cleared); `a second approval of the same promotion applies the patch once`; `request returns already_promoted without a new approval`; `a promotion interrupted after apply never re-applies` (`promotion_outcome_unknown`).
- [ ] **Step 2:** effects: `dispatches code_mode.aider_promote pending actions through executeCodeModePendingApproval`; capability: `reads promoted Aider runs through the envelope validator`, `a rejected promote approval never applies the patch`; route: `POST /api/v1/code-mode/runs/:runId/promote requests promotion in scope`.
- [ ] **Step 3: Run** each file alone → FAIL.
- [ ] **Step 4: Implement.** `C0` allowance for `code-mode-aider-promotion.ts`.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(gateway): approval-gated Aider patch promote through the hash-checked workbench path`.

### Task 13: 8.3 docs truth (no Docker posture change)

**Files:** `apps/gateway/src/services/code-mode-execution-backends.ts` (Aider governance strings only, ~L239–240; `preview_only`/"Planned" stay), `code-mode-execution-backends.test.ts`, `docs/1_0_CONTRACT.md` (~L75, ~L106), `README.md` (~L218), `docs/1_0_RELEASE_EVIDENCE.md` (~L117), `docs/CAPABILITY_SYSTEM_V1.md` (~L111), `docs/QA_MANUAL_TEST_PLAN.md` (~L994), `docs/qa_manual_test_plan_sheets/Test Cases.csv` (~L360)

- [ ] **Step 1:** Governance strings → `"Runs only in run-temp/artifact space; the operator workspace changes only through an approved, hash-checked promote."` and `"Replay posture stays non-replayable; a promoted patch is never re-applied."`; update pinned test assertions.
- [ ] **Step 2:** In every listed doc: Aider runs stay audit-only; runs created against a ready, clean Chat workbench are pinned to its HEAD and seeded from it; a `patch_produced` pinned run can be promoted via `POST /api/v1/code-mode/runs/:runId/promote` under a separate approval that re-checks the patch sha256 and the pinned HEAD/state and applies through the workbench (`git apply --check`, then apply) exactly once; unpinned runs cannot be promoted; replay and candidate promotion remain unshipped; Docker stays configured-only; no hostile-code claim. Keep README governance-checked phrases.
- [ ] **Step 3:** `git grep -n -i "operator-workspace mutation\|workspace patches are not applied\|does not apply patches" -- docs README.md apps` → no stale hits.
- [ ] **Step 4: Run** backends test + `pnpm docs:check` → PASS.
- [ ] **Step 5: Commit** `docs: Aider promote truth; Docker posture unchanged`.

### Task 14: PR B proof lane

- [ ] `pnpm typecheck`; `pnpm verify:architecture:metrics`; `node scripts/verify-repo-hygiene.mjs`; `pnpm docs:check`; `git diff --check origin/main...HEAD`; every focused test file from Tasks 7–13, each alone.
- [ ] Open PR B with `Refs #368` (Docker box unmet) and `Refs #341`; list F1–F9 for the reviewer.
