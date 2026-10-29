# Inbox Install-Wide Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cockpit Inbox lists and decides approvals that belong to no workspace ("install-wide": `linkage` absent), starting with `skill.lifecycle` skill approvals, in every workspace's Inbox.

**Architecture:** The approvals repository's workspace-scoped page gains an opt-in that also keeps install-wide rows (same bounded statements, so SQLite and PostgreSQL behave alike). The Gateway Inbox projection opts in and marks those items `source.installWide: true`. The cockpit reads a marked item's approval without a workspace (PR 3b's `workspaceId: null` path) and keeps the scoped read, and its workspace-mismatch guards, for linked approvals.

**Tech Stack:** TypeScript, `@goatcitadel/storage` (node:test via tsx), Fastify Gateway (vitest), React 19 + TanStack Query cockpit (vitest + happy-dom), real PostgreSQL 16 lane.

**Spec:** The task brief from the Capabilities hub Phase 3 session (ruling R37 follow-up), summarised here: install-wide approvals appear in every workspace's Inbox because they belong to the operator, not a workspace; bounded read with PostgreSQL parity; linked approvals stay scoped exactly as today; the Inbox detail reads a detached approval unscoped via PR 3b's `workspaceId: null` path; tests for the Gateway projection (SQLite and PostgreSQL) and the cockpit (a skill approval shows, opens and is approved in one click); update `docs/CANONICAL_RUNTIME_STATE_MODEL.md` and the Skills tab copy. Done when a skill switch change from Library, Chat's `/skill` or the Skills tab appears in the cockpit Inbox and can be approved or denied there.

## Global Constraints

- **Install-wide** means `approval.linkage === undefined` after the repository's own mapping (`mapRow`, which also reads legacy linkage embedded in the payload or preview). An approval whose linkage exists but has no `workspaceId` is NOT install-wide and stays out of every workspace's Inbox, as today.
- One definition: `isInstallWideApproval(approval: Pick<ApprovalRequest, "linkage">): boolean` in `packages/contracts/src/approvals.ts`, used by storage, Gateway and cockpit.
- On an install-wide Inbox item, `source.workspaceId` is the Inbox's own workspace (the one the projection was read for), so every existing cockpit guard (`inboxMatchesWorkspace`, `matchesScope`, …) keeps holding.
- Linked approvals: the repository filter, the projection items, the cockpit reads (`fetchApproval(id, { workspaceId })`) and every workspace-mismatch guard stay byte-for-byte as today.
- Bounded read: no new SQL; the opt-in is a predicate in `listPage`'s existing in-memory filter, inside its existing fetch limits.
- Tests first (RED then GREEN). vitest always with `--maxWorkers=2`; Gateway vitest runs from `apps/gateway`; storage tests via `pnpm --filter @goatcitadel/storage exec tsx --test --test-name-pattern=<pattern> src/<file>.test.ts`. One heavy job at a time; never wrap tests in a timeout.
- Never `git stash`, never `pnpm architecture:baseline:update`, never `prettier --write` a directory glob (format only files you touched: `pnpm exec prettier --write <file> …`).
- After changing `packages/contracts` rebuild it: `pnpm --filter @goatcitadel/contracts build`. After changing `packages/mission-control-shared`, rebuild it too. After changing `packages/storage`, rebuild it (`pnpm --filter @goatcitadel/storage build`) before Gateway real-database tests.
- Visible copy follows `DESIGN.md` and `PRODUCT.md`: plain sentences, no internal identifiers or jargon ("install-wide" is a code/doc term, never shown to the operator).
- No new dependencies. Commit messages: conventional (`feat:`/`fix:`/`docs:`/`test:`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Write the message to a file and use `git commit -F <file>`.

## Review Focus

1. A row whose `linkage_json` is NULL but whose payload carries legacy embedded linkage naming another workspace must not appear in this workspace's Inbox (the repository maps it as linked). Pinned in Task 1.
2. An approval with linkage but no `workspaceId` (for example `{ toolName: "fs.write" }`) must not appear in any workspace's Inbox. Pinned in Tasks 1 and 2.
3. An item marked install-wide whose unscoped read returns a record linked to another workspace must be treated as not found, never shown or decided. Pinned in Task 3.
4. After an install-wide approval is decided in the Inbox, the settled receipt must not say the follow-on record "does not match this approval scope". Pinned in Task 3.
5. Paging a workspace page with the opt-in across a cursor returns every expected row once, with linked and install-wide rows interleaved by creation order. Pinned in Task 1.

## Approval kinds created install-wide

From an audit of every production approval creation site (2026-10-29):

| Kind | Linkage when created | Install-wide? |
|---|---|---|
| `skill.lifecycle` (`skill-state-service.ts`) | never any (direct detached create, no Gateway enrichment) | always |
| `capability.lifecycle` (`capability-system-service.ts`) | `{ workspaceId }`, or none for a legacy candidate with no recorded workspace | sometimes |
| `auth.device_access` (`settings-auth-service.ts`) | none in the input; the Gateway helper may add `correlationId`/`traceId`/`durableRunId` | only when nothing was added |
| any kind from `POST /api/v1/approvals` without a `linkage` body | none | yes |
| `verification.approval.wait` (dev verification routes only) | none | yes (dev only) |

Linkage without a workspace (NOT install-wide, still in no Inbox; a follow-up): `local_ai.serve`, `local_ai.serve_stop`, `local_ai.download`, `citadel_ward.a2a_outbound`, and sometimes tool approvals, `citadel_ward.integration_action`, `integration.dry_run_commit`.

One-click approve (`reviewedInPlace`) in the Inbox applies only to install-wide `skill.lifecycle` approvals: the operator asked for that change themselves, and the Skills tab already approves it in one click. Other install-wide kinds (a device asking for access is an outside request) keep the danger-level review step.

---

### Task 1: Storage page keeps install-wide approvals on request

**Files:**
- Modify: `packages/contracts/src/approvals.ts` (add `isInstallWideApproval`; export it from the package index if approvals exports are re-exported there)
- Modify: `packages/storage/src/approval-repo.ts` (`listPage`, ~line 584)
- Test: `packages/storage/src/approval-repo.test.ts` (new `describe("ApprovalRepository.listPage install-wide", …)`)

**Interfaces:**
- Produces: `isInstallWideApproval(approval: Pick<ApprovalRequest, "linkage">): boolean` from `@goatcitadel/contracts` — `true` exactly when `approval.linkage === undefined`. Doc comment: an approval with no linkage belongs to the install, not to a workspace (a skill switch change is one), so every workspace's Inbox lists it.
- Produces: `ApprovalRepository.listPage(input: { status?; limit?; cursor?; workspaceId?; includeExpired?; includeInstallWide?: boolean })`. With `workspaceId` and `includeInstallWide: true`, a row is kept when `linkage?.workspaceId === workspaceId` OR `isInstallWideApproval(row)`. Without `workspaceId` the flag changes nothing (an unscoped page already returns every row). Without the flag, behaviour is unchanged.

- [ ] **Step 1: Write the failing tests** in `approval-repo.test.ts`, using `createInMemoryHarness()`:
  - `it("keeps install-wide approvals in a workspace page only when asked")`: create, in order, `a1` (`repo.create` with `linkage: { workspaceId: "workspace-a" }`), `foreign` (`linkage: { workspaceId: "workspace-b" }`), `skill` (`repo.createDeterministicDetachedWithTtlDuration` with `kind: "skill.lifecycle"`, no `linkage`, a 64-hex-suffixed id), `toolOnly` (`linkage: { toolName: "fs.write" }`), `a2` (`linkage: { workspaceId: "workspace-a" }`). Assert `repo.listPage({ status: "pending", workspaceId: "workspace-a", includeInstallWide: true }).items.map(id)` deep-equals `[a2, skill, a1]` (newest first) and the same call without `includeInstallWide` returns `[a2, a1]`. Make creation timestamps distinct the way neighbouring tests in this file do.
  - `it("treats a row with legacy payload linkage as linked, not install-wide")`: create a pending approval with `linkage: { workspaceId: "workspace-b" }`, then move its linkage into the payload the way legacy rows stored it (`db.prepare("UPDATE approvals SET linkage_json = NULL, payload_json = ? WHERE approval_id = ?")` with the payload carrying the repository's `APPROVAL_LINKAGE_KEY` entry — read that constant's value in `approval-repo.ts`); assert it is absent from `listPage({ status: "pending", workspaceId: "workspace-a", includeInstallWide: true })` and present in the `workspace-b` page.
  - `it("pages install-wide and linked approvals with the cursor without loss or repeats")`: create 3 linked-to-A and 3 install-wide approvals alternating, plus 2 linked-to-B; walk `listPage({ status: "pending", workspaceId: "workspace-a", includeInstallWide: true, limit: 2, cursor })` until `nextCursor` is undefined; assert the concatenated ids equal the 6 expected ids newest first, with no duplicates.
- [ ] **Step 2: Run them to verify they fail**
  Run: `pnpm --filter @goatcitadel/storage exec tsx --test --test-name-pattern="install-wide|legacy payload linkage" src/approval-repo.test.ts`
  Expected: FAIL (install-wide rows missing from the first assertion).
- [ ] **Step 3: Implement** `isInstallWideApproval` in contracts, rebuild contracts, then add `includeInstallWide` to `listPage`'s input and its `accepted` filter.
- [ ] **Step 4: Run the new tests and the whole file**
  Run: `pnpm --filter @goatcitadel/storage exec tsx --test src/approval-repo.test.ts`
  Expected: PASS, no regressions.
- [ ] **Step 5: Typecheck storage and contracts**
  Run: `pnpm --filter @goatcitadel/contracts typecheck` and `pnpm --filter @goatcitadel/storage typecheck` (one after the other). Expected: exit 0. Then `pnpm --filter @goatcitadel/storage build`.
- [ ] **Step 6: Commit** (`feat(storage): a workspace approval page can keep install-wide approvals`).

### Task 2: Gateway Inbox projection lists install-wide approvals

**Files:**
- Modify: `packages/contracts/src/operator-inbox.ts` (`OperatorInboxItem.source.installWide?: true`)
- Modify: `apps/gateway/src/services/inbox-projection-service.ts` (approvals source, ~line 239; title/summary helpers near the top)
- Test: `apps/gateway/src/services/inbox-projection-service.test.ts` (mocked and real-SQLite cases)
- Create: `apps/gateway/src/services/inbox-projection-service.real-postgres.test.ts`
- Modify: `apps/gateway/package.json` (scripts `pretest:postgres:inbox`: `pnpm --filter @goatcitadel/storage build`; `test:postgres:inbox`: `vitest run src/services/inbox-projection-service.real-postgres.test.ts`)
- Modify: `.github/workflows/verification-fast.yml` (postgres job: step "Run real Postgres Gateway Inbox projection lane" → `pnpm --filter @goatcitadel/gateway test:postgres:inbox`, after the memory lifecycle step)
- Modify: `docs/CANONICAL_RUNTIME_STATE_MODEL.md` (Approval notes and Skill State notes)

**Interfaces:**
- Consumes: Task 1's `listPage({ …, includeInstallWide: true })` and `isInstallWideApproval`.
- Produces: `OperatorInboxItem.source.installWide?: true` — doc comment: the approval belongs to no workspace (install-wide, such as a skill switch change); every workspace's Inbox lists it, `workspaceId` is then the Inbox it is listed in, and its record is read without a workspace. Present only on approval items whose approval `isInstallWideApproval`.
- Produces: projection titles for `skill.lifecycle` items whose preview has `action: "skill_state_set"`, a non-empty string `skillId` and `state` in `enabled | sleep | disabled`: `Turn on skill <skillId>`, `Pause skill <skillId>`, `Turn off skill <skillId>`; any other `skill.lifecycle` item uses its preview's non-empty string `title`, else today's fallback. Every `skill.lifecycle` item's summary is `Applies to every workspace.` Other kinds keep today's title and summary.

- [ ] **Step 1: Write the failing tests** in `inbox-projection-service.test.ts`:
  - mocked: `it("asks the approvals owner for this workspace's approvals and install-wide ones")` — assert `deps.storage.approvals.listPage` was called with `{ status: "pending", limit: <SOURCE_LIMIT as today>, workspaceId: "workspace-a", includeInstallWide: true }`; given a returned linked approval and a returned skill approval with no linkage (preview `{ title: "Approve skill state change", action: "skill_state_set", skillId: "planner", state: "enabled", currentState: "disabled" }`), the skill item has `source: { workspaceId: "workspace-a", approvalId, installWide: true }`, `title: "Turn on skill planner"`, `summary: "Applies to every workspace."`, and the linked item has no `installWide` key.
  - real SQLite: `it("lists one install-wide skill approval in every workspace's Inbox and keeps linked ones scoped")` — `new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." })` + `createSqliteAsyncStorage` as the existing delegation test does; create linked-A, linked-B, a `skill.lifecycle` approval via `createDeterministicDetachedWithTtlDuration` (no linkage), and a `{ toolName: "fs.write" }`-only approval; assert the `workspace-a` projection's approval items are exactly [linked-A, skill] (by approvalId, any order), `workspace-b`'s exactly [linked-B, skill], the skill item `installWide: true` in both, and the tool-only approval in neither. Close the storage in `finally`.
- [ ] **Step 2: Run them to verify they fail**
  Run (from `apps/gateway`): `pnpm exec vitest run src/services/inbox-projection-service.test.ts --maxWorkers=2`
  Expected: the two new tests FAIL; the rest pass.
- [ ] **Step 3: Implement** the contract field (rebuild contracts), the `includeInstallWide: true` read, the `installWide` marker and the `skill.lifecycle` title/summary in the projection.
- [ ] **Step 4: Run the file again**. Expected: PASS.
- [ ] **Step 5: Write the real-PostgreSQL test** `inbox-projection-service.real-postgres.test.ts`, modelled on `improvement-review-precondition.real-postgres.test.ts` (`describe.skipIf(!url)`, `acquireGatewayLivePostgresTestLease`, an isolated `inbox_projection_<uuid hex>` schema, `runPostgresMigrations`, `createPostgresRemoteStorage`, drop the schema and release the lease in `afterAll`). Same scenario and assertions as the real-SQLite test, with the projection's other dependencies as minimal stubs returning empty data.
- [ ] **Step 6: Run it against the local PostgreSQL 16**
  Run (from `apps/gateway`, PowerShell): `$env:GOATCITADEL_TEST_POSTGRES_URL='postgresql://postgres:postgres@127.0.0.1:5432/goatcitadel_test'; pnpm run test:postgres:inbox -- --maxWorkers=2`
  Expected: PASS with the suite executed (not skipped). If the local database refuses the connection, report that in the task report rather than marking it passed.
- [ ] **Step 7: Wire CI** (the `package.json` scripts and the workflow step listed above).
- [ ] **Step 8: Document.** In `docs/CANONICAL_RUNTIME_STATE_MODEL.md` → `### Approval` → Notes, add: an approval with no linkage is install-wide; it belongs to the operator, not to a workspace; the Inbox projection (`apps/gateway/src/services/inbox-projection-service.ts`) lists each pending one in every workspace's Inbox with `source.installWide: true`; it is read without a workspace (a workspace-scoped read still answers not found) and decided once for the whole install; an approval whose linkage has no workspace is not install-wide and stays out of every Inbox; name the kinds that are created install-wide (from the kinds table above). In `### Skill State` → Notes, add one line: a waiting skill change is listed in every workspace's Inbox, where it can be approved or denied; the Skills tab still approves it in place.
- [ ] **Step 9: Typecheck the Gateway** (`pnpm --filter @goatcitadel/gateway typecheck`), run `pnpm docs:check` if it exists, then commit (`feat(gateway): list install-wide approvals in every workspace's Inbox`).

### Task 3: Cockpit Inbox reads and decides install-wide approvals

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/areas/inbox/InboxApprovalDetail.tsx`
- Modify: `apps/mission-control-next/src/cockpit/areas/inbox/InboxRowDecision.tsx`
- Modify: `apps/mission-control-next/src/cockpit/areas/inbox/LinkedApproval.tsx` (`LinkedApprovalDetail`)
- Modify: `apps/mission-control-next/src/cockpit/areas/inbox/approval-follow-on.ts` (`readApprovalFollowOn` scope check)
- Modify: `apps/mission-control-next/src/cockpit/areas/inbox/inbox-record-read.ts` (shared read helper)
- Modify (comments and test comments only): `capabilities/skills/SkillPanelSwitch.tsx:14`, `capabilities/skills/SkillRow.tsx:38`, `capabilities/skills/skill-view.ts:95`, `capabilities/skills/SkillsTab.test.tsx:307`, `capabilities/skills/skill-view.test.ts:184`, `capabilities/skills/SkillPanel.test.tsx:628`, `settings/SettingsApprovalSkipControl.test.tsx:70`
- Test: `InboxApprovalDetail.test.tsx`, `LinkedApproval.test.tsx`, `approval-follow-on.test.ts`, and a new `InboxArea.install-wide.test.tsx`

**Interfaces:**
- Consumes: `OperatorInboxItem.source.installWide` (Task 2), `isInstallWideApproval` (Task 1), PR 3b's `ApprovalDecisionBar` `workspaceId: string | null` and `reviewedInPlace`.
- Produces: `readInboxApproval(approvalId: string, options: { workspaceId: string; installWide: boolean; signal?: AbortSignal }): Promise<ApprovalRequest | null>` in `inbox-record-read.ts` — scoped `fetchApproval(id, { workspaceId, signal })` when not install-wide; otherwise `fetchApproval(id, { signal })` and then `null` unless `isInstallWideApproval(record)`; 404 → `null` (via `nullWhenMissing`).
- Produces: `inboxApprovalRecordKey(workspaceId: string, installWide: boolean, approvalId: string, identity: string)` → `["approvals", "record", installWide ? null : workspaceId, approvalId, identity]` (the key PR 3b's `SettingsApprovalDialog` and `ApprovalDecisionBar` already use for a detached record).

- [ ] **Step 1: Write the failing tests**
  - `InboxApprovalDetail.test.tsx`: `it("reads an install-wide approval without a workspace and decides it in place")` — item `source: { workspaceId: "default", approvalId, installWide: true }`, `fetchApproval` resolves a pending `skill.lifecycle` record with no linkage; assert `fetchApproval` was called with `(approvalId, expect.not.objectContaining({ workspaceId: expect.anything() }))`, the mocked `InboxApprovalActions` received `workspaceId: null` and `reviewedInPlace: true` (extend the mock to record its props). `it("treats an install-wide read that returns another workspace's approval as not available")` — the unscoped read returns the record with `linkage: { workspaceId: "workspace-b" }`; assert the "no longer waiting" line shows and no decision controls render. `it("keeps the danger review step for an install-wide approval that is not a skill change")` — an install-wide `auth.device_access` record at `danger`: `workspaceId: null`, `reviewedInPlace` false. Keep (or add) an assertion that a linked item still calls `fetchApproval(approvalId, expect.objectContaining({ workspaceId: "default" }))` and passes `workspaceId: "default"` with no `reviewedInPlace`.
  - `approval-follow-on.test.ts`: `it("accepts follow-on records of an install-wide approval that stay install-wide")` (replay and lifecycle approvals without linkage → resolves) and `it("refuses follow-on records of an install-wide approval that name a workspace")` (lifecycle approval with `linkage: { workspaceId: "default" }` → rejects with the existing scope message).
  - `LinkedApproval.test.tsx`: `it("opens a linked install-wide approval as an install-wide item")` — the unscoped linked read returns a record with no linkage; assert the detail's own read goes unscoped (no `workspaceId`) and decision controls render.
  - New `InboxArea.install-wide.test.tsx`, modelled on `InboxArea.test.tsx`'s harness (same mocks for `fetchOperatorInbox`, `fetchApproval`, `resolveApproval`, the inspector, and the Inbox-approval attempt reset): `it("shows a skill approval, opens it and approves it in one click")` — the projection holds one item `{ kind: "approval", group: "needs_decision", riskLevel: "danger", title: "Turn on skill planner", summary: "Applies to every workspace.", source: { workspaceId: "default", approvalId, installWide: true } }`; `fetchApproval` returns the pending `skill.lifecycle` record (preview and payload as in `SkillPanel.test.tsx`'s `skillApproval()`), then the approved one after `resolveApproval`. Assert: the row "Turn on skill planner" shows; clicking it opens the detail; exactly one click on the detail's "Approve" button calls `resolveApproval(approvalId, "approve")` once, with no second confirmation dialog. `it("denies a skill approval from the Inbox")` — one click on "Deny" calls `resolveApproval(approvalId, "reject")`.
- [ ] **Step 2: Run them to verify they fail**
  Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/inbox/InboxApprovalDetail.test.tsx src/cockpit/areas/inbox/approval-follow-on.test.ts src/cockpit/areas/inbox/LinkedApproval.test.tsx src/cockpit/areas/inbox/InboxArea.install-wide.test.tsx --maxWorkers=2`
  Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `InboxApprovalDetail`: `const installWide = item.source.installWide === true;` read through `readInboxApproval`, key with `inboxApprovalRecordKey`; pass `workspaceId={installWide ? null : workspaceId}` and `reviewedInPlace={installWide && approval.kind === "skill.lifecycle"}` to `InboxApprovalActions`. Everything else (Inbox invalidation, settlement, audit recovery) keeps the Inbox's `workspaceId`.
  - `InboxRowDecision`: same read, key and `workspaceId` rule (no `reviewedInPlace`: rows only decide safe/caution).
  - `LinkedApprovalDetail`: when `isInstallWideApproval(approval)`, the synthesized item's source gets `installWide: true`.
  - `readApprovalFollowOn`: the per-record scope check becomes: an install-wide `approval` requires each follow-on record to be install-wide; any other requires `record.linkage?.workspaceId === workspaceId` (unchanged).
- [ ] **Step 4: Run the four files again**. Expected: PASS. Then run the neighbouring suites that cover the touched components: `InboxArea.test.tsx`, `InboxItemCard.test.tsx`, `InboxApprovalActions.test.tsx`, `ApprovalSettlement.test.tsx`, `ApprovalAuditRecovery.test.tsx`, `LinkedApproval.settlement.test.tsx`, `ApprovalDecisionBar.test.tsx` (one vitest invocation, `--maxWorkers=2`). Expected: PASS.
- [ ] **Step 5: Skills tab copy.** The Skills tab keeps approving in place and still never links to the Inbox (one click where the change was asked for, no Inbox round-trip). Only the rationale changes: rewrite the listed comments and test descriptions so none says the Inbox can't show or list a skill approval; say instead that the change is approved in the skill's panel where it was asked for, and that it also waits in the Inbox. Do not change any assertion or visible string. Run `SkillsTab.test.tsx`, `skill-view.test.ts`, `SkillPanel.test.tsx` and `SettingsApprovalSkipControl.test.tsx` (one invocation, `--maxWorkers=2`). Expected: PASS.
- [ ] **Step 6: Typecheck and lint** the app: `pnpm --filter @goatcitadel/mission-control-next typecheck`, then `pnpm exec eslint <each touched file>` and `pnpm exec prettier --check <each touched file>`. Expected: exit 0.
- [ ] **Step 7: Commit** (`feat(cockpit): read and decide install-wide approvals in the Inbox`).
