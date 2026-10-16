# WS2 — Mail Send and Calendar Create Execute: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An approved `communications.mail.send` or `communications.calendar.create` approval actually sends the mail or creates the event exactly once, drafts survive a Gateway restart, and IMAP/SMTP accounts can send.

**Architecture:** Two new approval effect kinds run in `ApprovalEffectsService`, following the `mesh_capability_activation_apply` enqueue/handle pair. Each effect calls a new executor, `CommunicationsApprovalEffectService`. The executor re-reads the approved approval and checks its SHA-256 `payloadHash`. It then calls the existing comms functions with idempotency key `communications:<approvalId>`. Those functions run inside `runIdempotentExternalSideEffect`, so a replayed effect never reaches the provider twice. The policy engine still evaluates the tool call, but it must not raise a second approval. To prevent that, the comms function records a `pending_approval_actions` row for the exact tool request at execution time and invokes with `consentContext.reason = "approval:<approvalId>"`. This is the bypass `executeApprovedAction` / `getVerifiedApprovalBypassId` already use. Mail drafts move from an in-memory `Map` to a `MailDraftRepository` (SQLite + Postgres + convergence migration).

**Tech Stack:** TypeScript (pnpm monorepo), Fastify gateway, vitest (gateway, UI), `node:test` via `tsx --test` (storage), SQLite + Postgres, `nodemailer` (new, Task 4 only).

**Spec:** [2026-10-15-gap-closure-program.md](2026-10-15-gap-closure-program.md), section "WS2 — Mail send and calendar create actually execute", plus its Global Constraints and Review Focus.

## Global Constraints

- Work only in this worktree. Never edit the main checkout `C:\personal-ai`. Never `git stash`.
- Search with `git grep` (the Grep tool silently omits matches on this tree).
- Vitest: `pnpm --filter @goatcitadel/gateway exec vitest run <file> --maxWorkers=2`, at low priority, one heavy job at a time. Re-run a failed file alone before treating it as a real failure.
- Storage tests: `pnpm --filter @goatcitadel/storage exec tsx --test <file>`. Test SQLite through `TempSqliteFiles`.
- Gateway tests that `vi.mock("@goatcitadel/storage")` must spread any new real storage export (`...actual`).
- Any new Postgres table needs a convergence migration, tested on a fresh install and on an upgraded install.
- Never run `architecture:baseline:update`. Add each new gateway service file to `scripts/verification/baselines/architecture-new-service-allowances.json`.
- No personal paths in tracked files (`node scripts/verify-repo-hygiene.mjs`).
- Run `prettier --write` only on the files you changed.
- Rebuild `@goatcitadel/contracts` (`pnpm --filter @goatcitadel/contracts build`) after changing it; package tests resolve contracts from `dist`.
- Commits: `<type>: <description>`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `nodemailer` is the only new dependency. Pin `10.0.12` (more than two weeks old). If it cannot be installed or typed, stop Task 4 and take the `send_unavailable` fallback described there.

## Review Focus

1. **Double approval, double resolve, or restart mid-send.** The provider must be called exactly once. Pinned in Task 5 (handler runs twice; a fresh `ApprovalEffectsService` re-runs a reclaimed effect) and in Task 2 (calendar key twice).
2. **Payload drift after approval.** A tampered stored payload (subject, recipients, times) must fail closed and send nothing. Pinned in Task 5.
3. **Approval-bypass row already settled.** If the `pending_approval_actions` row for this approval is already resolved, the executor must not invoke the tool, because that would mint a second approval. Pinned in Task 2 (`recordPendingAction` refuses a non-pending row).
4. **Account without a send-capable provider (`manual`, unknown, deleted connection).** The effect fails with an operator-readable reason, and the draft becomes `failed` with `failureReason`. Pinned in Task 5.
5. **Gateway restart between draft creation and send.** The draft and its `approvalId` survive. A replayed `POST …/send` returns the recorded draft instead of creating a second approval. Pinned in Task 3.

---

## File Map

| File | Change | Responsibility |
|---|---|---|
| `packages/contracts/src/personal-ops.ts` | modify | `MailDraftRecord.failureReason?`, `sentAt?`, status `"send_unavailable"` (fallback only) |
| `packages/contracts/src/approvals.ts` | modify | effect kinds `communications_mail_send_apply`, `communications_calendar_create_apply`; target kinds `mail_draft`, `calendar_event` |
| `packages/storage/src/mail-draft-repo.ts` | create | `MailDraftRepository` |
| `packages/storage/src/mail-draft-schema.ts` | create | SQLite DDL, PG additive SQL, PG convergence SQL |
| `packages/storage/src/postgres/migrations.ts`, SQLite schema bootstrap, storage registration (`index.ts`, async storage), migration manifest, `scripts/verify-storage-migration-parity.test.mjs` | modify | register the table + repo |
| `packages/storage/src/mail-draft-repo.test.ts`, `mail-draft-repo.postgres.test.ts` | create | both dialects + both PG lineages |
| `apps/gateway/src/services/comms-service.ts` | modify | `CommsPreApproval` option; calendar create ledger; `commsSmtpSend` |
| `apps/gateway/src/services/communications-approval-payload.ts` | create | canonical send/create inputs + `computeCommunicationsPayloadHash` |
| `apps/gateway/src/services/communications-dashboard-service.ts` | modify | repo-backed drafts; payload hash + idempotency key; copy |
| `apps/gateway/src/services/communications-approval-effect-service.ts` | create | executor for both approval kinds |
| `apps/gateway/src/services/approval-resolution-effects-service.ts` | modify | enqueue + handle the two effect kinds |
| `apps/gateway/src/services/gateway-service.ts`, `apps/gateway/src/routes/communications.ts` | modify | wiring only |
| `packages/policy-engine/src/tool-executor/smtp-mail-executor.ts` | create | `smtp.send` via nodemailer, host pinned to connection |
| `packages/policy-engine/src/tool-registry.ts`, `tool-executor/comms-executor.ts` (3-line dispatch only, WS5 shares this file) | modify | register + dispatch `smtp.send` |
| `packages/mission-control-shared/src/content/communications-approval-evidence.ts`, `apps/mission-control-next/src/cockpit/areas/library/LibraryMailCompose.tsx`, `.../inbox/inbox-vocabulary.ts`, `features/native-routes/library/LibraryCommunicationsSection.tsx` | modify | truthful copy, new effect-kind labels |
| `docs/1_0_CONTRACT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md` | modify | state that approved mail/calendar requests execute |

---

### Task 1: Persist mail drafts (spec 2.2, storage half)

**Files:** see the File Map rows for storage.

**Interfaces — Produces:**
```ts
export interface MailDraftTransition {
  status: MailDraftRecord["status"];
  approvalId?: string;
  failureReason?: string;
  sentAt?: string;
  updatedAt: string;
}
export class MailDraftRepository {
  constructor(db: DatabaseClient);
  create(record: MailDraftRecord): MailDraftRecord;            // throws on duplicate draftId
  find(draftId: string): MailDraftRecord | undefined;
  get(draftId: string): MailDraftRecord;                       // NotFoundError when absent
  /** Compare-and-set: applies only while the current status is in `from`; returns undefined otherwise. */
  transition(draftId: string, from: readonly MailDraftRecord["status"][], patch: MailDraftTransition): MailDraftRecord | undefined;
}
// AsyncStorage gains `mailDrafts` with the same methods returning Promises.
```

Table `mail_drafts`: `draft_id TEXT PRIMARY KEY`, `workspace_id TEXT`, `account_id TEXT NOT NULL`, `to_json TEXT NOT NULL`, `cc_json TEXT NOT NULL`, `bcc_json TEXT NOT NULL`, `subject TEXT NOT NULL`, `body_text TEXT NOT NULL`, `approval_id TEXT`, `status TEXT NOT NULL CHECK(status IN ('draft','approval_required','sent','failed','send_unavailable'))`, `failure_reason TEXT`, `sent_at TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`. Index `idx_mail_drafts_approval ON mail_drafts(approval_id)`. Use only TEXT columns, no inline UNIQUE and no DESC index, so the PG v2 live render and the additive migration have the same shape.

- [ ] **Step 1: Contracts.** Add `failureReason?: string; sentAt?: string;` to `MailDraftRecord`, and add `"send_unavailable"` to its status union. Build contracts.
- [ ] **Step 2: Failing SQLite repo test** (`mail-draft-repo.test.ts`, `TempSqliteFiles`). Cases:
  - `create` → `find` round-trips every field, including empty `cc`/`bcc` arrays.
  - Duplicate `create` throws.
  - `transition(id, ["draft"], {status:"approval_required", approvalId:"ap-1", …})` returns the updated row. A second identical call returns `undefined` and leaves the row unchanged.
  - Reopening a new repository on the same file still finds the draft (restart).
- [ ] **Step 3:** Run it. Expect FAIL (module missing).
- [ ] **Step 4: Implement** `mail-draft-schema.ts` and `mail-draft-repo.ts`, modeled on `channel-setup-draft-repo.ts` (prepared statements, `db.dialect` branches only where needed). Register the SQLite DDL wherever the existing schema bootstrap creates `channel_setup_drafts` (find it with `git grep -n "channel_guided_setup\|CHANNEL_GUIDED_SETUP" packages/storage/src`). Expose `mailDrafts` on storage and AsyncStorage, the same way `channelSetupDrafts` is exposed.
- [ ] **Step 5:** Run it. Expect PASS.
- [ ] **Step 6: Postgres migrations.**
  - Append v212 `mail_drafts` with the additive SQL (`CREATE TABLE IF NOT EXISTS …`, `CREATE INDEX IF NOT EXISTS …`).
  - Append v213 `mail_drafts_schema_convergence`. Make it idempotent and forward-only: re-assert every column type (`ALTER TABLE mail_drafts ALTER COLUMN <c> TYPE TEXT` for each column), drop and recreate `idx_mail_drafts_approval`, and recreate the status CHECK under a fixed name with `DROP CONSTRAINT IF EXISTS`.
  - Follow `schema-convergence-v200.ts` for file layout and the `integritySha256` convention.
  - Run `pnpm update:storage:migration-manifest`.
  - Bump the reviewed literals in `scripts/verify-storage-migration-parity.test.mjs` (count, last name, any lists that name sqlPayload-less migrations).
- [ ] **Step 7: Real-PG lineage test** `mail-draft-repo.postgres.test.ts`, skipped unless `GOATCITADEL_TEST_POSTGRES_URL` is set (copy the schema-scoped setup from `channel-guided-setup.postgres.test.ts`).
  - (a) *Fresh*: run the full `POSTGRES_MIGRATIONS`, then repo round-trip and CAS `transition`.
  - (b) *Upgraded*: in a second schema, run `POSTGRES_MIGRATIONS.filter(m => m.version <= 211)`, `DROP TABLE mail_drafts`, then run the full list. It must succeed, which includes the schema-shape gate. Then round-trip.
  - Run it locally against a disposable cluster: `"C:\Program Files\PostgreSQL\16\bin\initdb.exe" -D <scratchpad>\pg -U postgres -A trust`, `pg_ctl -D … -o "-p 54329" start`, `createdb -p 54329 -U postgres goatcitadel_test`, then `GOATCITADEL_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:54329/goatcitadel_test`. Stop the cluster afterwards.
- [ ] **Step 8:** Run `node --test scripts/verify-storage-migration-parity.test.mjs` and the storage package typecheck. Commit `feat: persist mail drafts in storage`.

### Task 2: Pre-approved comms invocation + idempotent calendar create (spec 2.3)

**Files:** `apps/gateway/src/services/comms-service.ts`, `comms-service.test.ts`.

**Interfaces — Produces:**
```ts
export interface CommsPreApproval {
  approvalId: string;
  /** Persist the exact normalized tool request as the approval's pending action; must throw if that row is not still `pending`. */
  recordPendingAction(request: ToolInvokeRequest): Promise<void>;
}
export async function commsGmailSend(host: CommsHost, input: GmailSendInput, preApproval?: CommsPreApproval): Promise<…>;
export async function commsCalendarCreate(host: CommsHost, input: CalendarCreateEventInput & { idempotencyKey?: string }, preApproval?: CommsPreApproval): Promise<…>;
export function buildCommsPreApproval(storage: Pick<AsyncStorage,"pendingApprovalActions">, approvalId: string, now?: () => Date): CommsPreApproval;
```
`invokeCommsTool` gains an optional `preApproval`. When it is present, it builds the normalized request, awaits `preApproval.recordPendingAction(request)`, and invokes with `consentContext: { source: "ui", reason: \`approval:${approvalId}\` }`. `requestMatchesPendingApproval` ignores `consentContext`, so the stored and presented requests match. `buildCommsPreApproval` calls `pendingApprovalActions.upsertPending({approvalId, actionType:"tool.invoke", request, expiresAt: now+15min})`. It then re-reads the row with `find` and throws `Error("Approved communications action already settled; refusing to invoke again.")` unless `resolutionStatus === "pending"`. That throw happens inside the runner's `execute` before `markExternalCallStarted`, so the ledger records failed-before-boundary and no second approval is ever minted.

- [ ] **Step 1: Failing tests** in `comms-service.test.ts`, reusing the existing gmail-send ledger fixtures:
  - "calendar create with the same idempotency key twice invokes `calendar.create_event` once": the second call returns `externalSideEffectReplay`-style output and `invokeAndUnwrap` is called once.
  - "pre-approval records the exact request and presents `approval:<id>` consent": `recordPendingAction` receives a request deep-equal to the invoked one minus `consentContext`, and the invoked request carries `consentContext.reason === "approval:ap-1"`.
  - "a settled pending action stops the invoke": `recordPendingAction` throws, `invokeAndUnwrap` is never called, and the result is a failure without `approval_required`.
  - `buildCommsPreApproval` against an in-memory fake: a resolved row → throws; a fresh row → resolves.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3: Implement.** Wrap `commsCalendarCreate` in `runIdempotentExternalSideEffect` with boundary `comms_calendar_create`, actionId `calendar.create_event`, catalog fallback `automation.google-calendar` (use the connection's `catalogId` when found). The payload is the event fields. The pre/post-boundary classification copies the gmail block, so extract the shared classifier into one local helper used by both instead of duplicating it.
- [ ] **Step 4:** Run them. Expect PASS, and the existing comms-service tests stay green.
- [ ] **Step 5:** Commit `feat: make calendar create idempotent and support pre-approved comms invokes`.

### Task 3: Repo-backed drafts and hashed approval payloads (spec 2.1 payload + 2.2 service half)

**Files:** create `communications-approval-payload.ts`; modify `communications-dashboard-service.ts` (+ test), `routes/communications.ts`.

**Interfaces — Produces:**
```ts
export const COMMUNICATIONS_IDEMPOTENCY_PREFIX = "communications:";
export function communicationsIdempotencyKey(approvalId: string): string; // "communications:<approvalId>"
export interface MailSendApprovalInput { draftId: string; accountId: string; to: string[]; cc: string[]; bcc: string[]; subject: string; bodyText: string }
export interface CalendarCreateApprovalInput { eventId: string; accountId: string; calendarId?: string; title: string; description?: string; startIso: string; endIso: string; attendees: string[]; location?: string }
export function computeCommunicationsPayloadHash(input: MailSendApprovalInput | CalendarCreateApprovalInput): string; // sha256 hex of canonicalJsonString(input), absent optionals omitted
export function readMailSendApprovalInput(payload: Record<string, unknown>): MailSendApprovalInput | undefined;
export function readCalendarCreateApprovalInput(payload: Record<string, unknown>): CalendarCreateApprovalInput | undefined;
```
Approval payloads keep every existing top-level field, because `communicationsMailSendApprovalEvidence` reads them. They add `payloadHash` and `idempotencyKeyPrefix: "communications:"`. The key itself needs the approvalId, which only exists after creation, so the executor derives it with `communicationsIdempotencyKey(approval.approvalId)`. `CommunicationsDashboardServiceDependencies` gains `mailDrafts: Pick<AsyncStorage["mailDrafts"], "create" | "find" | "transition">`. `createDraft` becomes async.

- [ ] **Step 1: Failing tests** (`communications-dashboard-service.test.ts`, plus a small `communications-approval-payload.test.ts`):
  - The hash is stable under key reordering and changes when `subject` changes.
  - The send approval payload carries `payloadHash === computeCommunicationsPayloadHash(readMailSendApprovalInput(payload))`. The calendar approval does the same.
  - Previews contain no "does not send" / "does not mutate" text. New copy: mail `"Approving sends this exact message once through the connected account."`, calendar `"Approving creates this exact event once on the connected calendar."`
  - Restart: build service A with an in-memory `mailDrafts` fake (or real SQLite repo via `TempSqliteFiles`), `createDraft` + `sendDraft`. Then build service B over the same repo: `sendDraft(sameId)` returns status `approval_required` with the same `approvalId`, and `createApproval` was called exactly once.
  - The calendar approval linkage now carries `workspaceId` when one is given.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3: Implement.** Replace the `drafts` `Map` with the repo. Keep the in-flight `sending` map: it only de-dupes concurrent requests within one process. Use `transition(["draft"] → "approval_required")` to settle; on approval-creation failure use `transition(["draft"] → "failed", failureReason)`. An unknown draft id still returns the transient `failed` record but does not persist it. In the route, call `await service.createDraft(...)` and pass `mailDrafts: fastify.services.storage?.mailDrafts` (find the route-level storage accessor with `git grep -n "fastify.services.storage" apps/gateway/src/routes | head`).
- [ ] **Step 4:** Run them. Expect PASS.
- [ ] **Step 5:** Commit `feat: persist mail drafts and hash communications approvals`.

### Task 4: SMTP send for IMAP/SMTP accounts (spec 2.4)

**Files:** create `packages/policy-engine/src/tool-executor/smtp-mail-executor.ts` (+ test); modify `tool-registry.ts`, `comms-executor.ts` (dispatch only), `packages/policy-engine/package.json`, `pnpm-lock.yaml`; gateway `comms-service.ts` (`commsSmtpSend`).

**Interfaces — Produces:**
```ts
// policy-engine
export interface SmtpTransportFactory { (options: { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } }): { sendMail(message: { from: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string }): Promise<{ messageId?: string }> } }
export async function smtpSend(config: Record<string, unknown>, args: Record<string, unknown>, allowlist: string[], grantAllowlist?: string[], createTransport?: SmtpTransportFactory): Promise<string>; // returns provider messageId
// gateway
export async function commsSmtpSend(host: CommsHost, input: GmailSendInput, preApproval?: CommsPreApproval): Promise<ToolInvokeResult | Record<string, unknown>>; // boundary "comms_smtp_send", toolName "smtp.send"
```
Connection config keys: `smtpHost` (required), `smtpPort` (default 587), `smtpSecure` (default `port === 465`), `smtpUser`, the password through the existing `secretFrom(config, "smtpPassword", "smtpPasswordEnv")` helper, and `fromAddress` (else `address`/`email`). Host pinning: the only host the transport may contact is `smtpHost`. It must also pass the same allowlist check `fetchAllowlisted` applies to `https://<smtpHost>/`; reuse that module's host matcher instead of writing a new one. Otherwise throw a pre-boundary error whose message `classifyChannelDeliveryFailure` maps to `blocked`. Call `markMutationRequestStarted` (the boundary tracker the fetch path uses) immediately before `sendMail`.

- [ ] **Step 1: Install.** `pnpm --filter @goatcitadel/policy-engine add nodemailer@10.0.12` and `add -D @types/nodemailer@8.0.2` (drop the types package if nodemailer ships its own). If the install fails or the typecheck cannot be satisfied, jump to the **fallback** below.
- [ ] **Step 2: Failing tests** (`smtp-mail-executor.test.ts`, with a fake `createTransport`):
  - It sends with the pinned host/port/auth and returns the messageId.
  - A missing `smtpHost` → throws before transport creation.
  - A host absent from the allowlist → throws a `blocked` class error and the transport is never created.
  - `to` empty → throws.
  - Registry: `smtp.send` is `category:"comms", riskLevel:"danger", requiresApproval:true, pack:"comms"`.
- [ ] **Step 3: Implement.** Use `nodemailer.createTransport` as the default factory. Dispatch from `executeCommsProviderTool` with `if (toolName === "smtp.send") return smtpSend(connectionConfig, args, allowlist, grantAllowlist);` next to `gmail.send`. Update any registry snapshot or count tests that list comms tools (`git grep -n '"gmail.send"' packages/policy-engine/src`).
- [ ] **Step 4: Gateway `commsSmtpSend`.** Same shape as `commsGmailSend` (boundary `comms_smtp_send`, actionId `smtp.send`). Add a test: same key twice → one invoke.
- [ ] **Step 5:** Run the policy-engine and gateway comms tests. Commit `feat: add governed SMTP send for IMAP/SMTP mail accounts`.

**Fallback (only if nodemailer is unworkable):** do not add `smtp.send`. In the executor (Task 5), imap/smtp accounts fail with code `send_unavailable`, and the draft transitions to status `send_unavailable` with reason `"Sending from IMAP/SMTP accounts is not available in this build."`. Record the ruling in the PR body and in this plan.

### Task 5: Execute approved communications through effect kinds (spec 2.1)

**Files:** create `communications-approval-effect-service.ts` (+ test). Modify `approval-resolution-effects-service.ts` and its test, `packages/contracts/src/approvals.ts`, `gateway-service.ts` (wiring), and the new-service allowances baseline.

**Interfaces — Consumes:** Task 1 `mailDrafts`, Task 2 `CommsPreApproval`/`buildCommsPreApproval`/`commsCalendarCreate`, Task 3 payload readers and hash, Task 4 `commsSmtpSend`.

**Produces:**
```ts
export const COMMUNICATIONS_MAIL_SEND_EFFECT_KIND = "communications_mail_send_apply" as const;
export const COMMUNICATIONS_CALENDAR_CREATE_EFFECT_KIND = "communications_calendar_create_apply" as const;
export type CommunicationsEffectErrorCode = "approval_not_approved" | "invalid_payload" | "payload_hash_mismatch" | "provider_unavailable" | "send_unavailable" | "delivery_failed" | "outcome_unknown";
export class CommunicationsApprovalEffectError extends Error { constructor(public readonly code: CommunicationsEffectErrorCode, message: string) }
export interface CommunicationsApprovalEffectDeps {
  storage: Pick<AsyncStorage, "approvals" | "mailDrafts" | "pendingApprovalActions">;
  getIntegrationConnection(connectionId: string): Promise<IntegrationConnection>;
  commsGmailSend(input: GmailSendInput, preApproval: CommsPreApproval): Promise<ToolInvokeResult | Record<string, unknown>>;
  commsSmtpSend(input: GmailSendInput, preApproval: CommsPreApproval): Promise<ToolInvokeResult | Record<string, unknown>>;
  commsCalendarCreate(input: CalendarCreateEventInput & { idempotencyKey: string }, preApproval: CommsPreApproval): Promise<ToolInvokeResult | Record<string, unknown>>;
  now?: () => Date;
}
export class CommunicationsApprovalEffectService {
  executeApprovedMailSend(input: { approvalId: string }): Promise<{ disposition: "sent"; providerMessageId?: string; replayed: boolean }>;
  executeApprovedCalendarCreate(input: { approvalId: string }): Promise<{ disposition: "created"; providerEventId?: string; replayed: boolean }>;
}
// ApprovalEffectsServiceDeps gains:
executeApprovedCommunicationsMailSend?(input: { approvalId: string }): Promise<{ disposition: "sent"; providerMessageId?: string; replayed: boolean }>;
executeApprovedCommunicationsCalendarCreate?(input: { approvalId: string }): Promise<{ disposition: "created"; providerEventId?: string; replayed: boolean }>;
```
Executor algorithm (mail; calendar is the same, without the draft):
1. `approval = storage.approvals.get(approvalId)`. It must be kind `communications.mail.send` with status `approved`; otherwise `approval_not_approved`.
2. `input = readMailSendApprovalInput(approval.payload)`; missing → `invalid_payload`. `computeCommunicationsPayloadHash(input) !== approval.payload.payloadHash` → `payload_hash_mismatch`, and the draft goes to `failed` with that reason.
3. `connection = getIntegrationConnection(input.accountId)`; on a throw → `provider_unavailable`. Provider: gmail → `commsGmailSend`; imap/smtp → `commsSmtpSend` (or `send_unavailable` under the fallback); anything else → `provider_unavailable` with message `"This mail account (<provider>) cannot send; connect Gmail or an SMTP account."`. Export `resolveMailProvider` from the dashboard service and reuse it.
4. Call with `{ connectionId: input.accountId, to, cc, bcc, subject, bodyText, idempotencyKey: communicationsIdempotencyKey(approvalId) }` and `buildCommsPreApproval(storage, approvalId)`.
5. Classify the result:
   - `status === "sent"` (or executed with a `providerMessageId`) → draft `transition(["approval_required","failed"] → "sent", sentAt)`; `replayed` comes from the `externalSideEffectReplay` output.
   - A ToolInvokeResult whose outcome is not executed, or `status === "failed"` with `deliveryStatus` `blocked`/`not_available` → `delivery_failed`.
   - A failed delivery after the boundary, or a ledger `in_progress`/unknown → `outcome_unknown`. The effect fails and the draft is marked `failed` with reason "Delivery outcome is unknown; check the mailbox before retrying."

Effects service:
- Enqueue in `enqueueResolutionEffects` when `approval.kind === "communications.mail.send" && decision === "approve"`. The upsert copies the mesh pair: targetKind `mail_draft`, targetId `draftId`, `idempotencyKey: buildApprovalEffectIdempotencyKey({...})`, payload `{ draftId, accountId, payloadHash }`. Calendar uses targetKind `calendar_event`, targetId `eventId`. A payload missing its ids → throw `ConflictError` like the memory lifecycle enqueue does.
- The handlers copy `handleMeshCapabilityActivationApply`. A `CommunicationsApprovalEffectError` → `failEffect` with `lastError: error.message`, `result: { errorCode }`. Any other error → `deferClaimedEffectForRetry`. A missing executor → `failEffect` "Communications effect is missing its executor."

- [ ] **Step 1: Contracts.** Add both effect kinds to `ApprovalEffectKind` and both target kinds to `ApprovalEffectTargetKind`. Build contracts. Add the two labels to `inbox-vocabulary.ts` ("Send the approved email", "Create the approved calendar event"), since its `Record<ApprovalEffectKind,…>` will not typecheck otherwise.
- [ ] **Step 2: Failing executor tests** (`communications-approval-effect-service.test.ts`) using real storage via the gateway test storage helper the effects tests already use, a recording `commsGmailSend` stub backed by the real `runIdempotentExternalSideEffect` path (call the real `commsGmailSend` with a fake `CommsHost` whose `invokeAndUnwrap` counts calls and whose ledger stores are real storage):
  1. Approve → send once; the draft is `sent`; the invoked request carries `approval:<id>` consent; the approval was created once.
  2. The executor runs twice → `invokeAndUnwrap` count is 1; the second result has `replayed: true` (Review Focus #1).
  3. Payload tampered after approval (update the stored approval payload's `subject` through the repo or raw SQL) → rejects with `payload_hash_mismatch`; invoke count 0; the draft is `failed`.
  4. A `manual` provider account → rejects `provider_unavailable` with a readable message; the draft is `failed` with `failureReason`.
  5. Calendar: approve → `calendar.create_event` invoked once; twice → still once.
- [ ] **Step 3:** Run them. Expect FAIL. Implement the executor. Run them. Expect PASS.
- [ ] **Step 4: Failing effects-service tests** (`approval-resolution-effects-service.test.ts`, mirroring the mesh test at `mesh-capability-activation-service.test.ts:860-920`):
  - Approve → the enqueued effect has kind `communications_mail_send_apply` and targetId = draftId.
  - Processing calls the executor once and completes the effect with `result.disposition === "sent"`.
  - Re-enqueueing the same resolution returns the same effectId (double resolve).
  - Restart: complete one worker run, then mark the effect `pending` again (or construct a second `ApprovalEffectsService` over the same storage after forcing lease expiry). Processing again with the same real executor + ledger → the provider invoke count stays 1 and the effect completes with `replayed: true`.
  - An executor throwing `CommunicationsApprovalEffectError("provider_unavailable", …)` → the effect is `failed`, `result.errorCode === "provider_unavailable"`, `lastError` readable.
  - Rejecting the approval enqueues no communications effect.
- [ ] **Step 5:** Run them. Expect FAIL. Implement the enqueue branches, the switch cases and the handlers. Run them. Expect PASS.
- [ ] **Step 6: Wire `gateway-service.ts`.** Construct `CommunicationsApprovalEffectService` lazily in the effects deps (`executeApprovedCommunicationsMailSend: (input) => this.communicationsApprovalEffects.executeApprovedMailSend(input)`). Build its comms host from the same factory the communications route composition uses (`gateway-route-composition-integrations.ts:605`). Keep the gateway-service delta to a few lines. Add the new file(s) to `architecture-new-service-allowances.json`. Run `pnpm verify:architecture:metrics`.
- [ ] **Step 7:** Commit `feat: execute approved mail send and calendar create through approval effects`.

### Task 6: Truthful copy and docs

**Files:** `communications-approval-evidence.ts` (+ test), `LibraryMailCompose.tsx` (+ test), `ApprovalReviewSummary.test.tsx`, `LibraryCommunicationsSection.tsx`, `docs/1_0_CONTRACT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md`.

- [ ] **Step 1: Update tests first**, to the new strings:
  - Evidence consequence: `"Approving sends this exact message once through the connected account. GoatCitadel records the delivery outcome on the draft."`
  - Compose intro: `"What you type stays in this browser session. Review saves the draft, including Bcc, on the Gateway. Only Request send approval asks for an approval; approving sends this exact message once."`
  - Receipt callout: `"Send approval requested. Nothing has been sent yet. Approving sends this exact message once."`
  - Review dialog: `"Approving sends this exact message once through the connected account."`
  - The draft status `sent`/`failed`/`send_unavailable` renders a status line (`"Sent."`, `"Not sent: <failureReason>"`).
  - Keep the "Request send approval" and Cancel/Confirm behaviors unchanged.
- [ ] **Step 2:** Run the UI tests (`pnpm --filter @goatcitadel/mission-control-next exec vitest run <files> --maxWorkers=2`) and the shared test. Expect FAIL. Update the components. Run them again. Expect PASS.
- [ ] **Step 3: Docs.** In the External writeback paragraphs, add one sentence: "Approved `communications.mail.send` and `communications.calendar.create` approvals execute once through approval effects; Gmail, SMTP and calendar sends claim idempotency on `comms_gmail_send`, `comms_smtp_send` and `comms_calendar_create` keyed `communications:<approvalId>`." Then `git grep -n -i "does not send\|does not mutate the external calendar"` over apps/packages/docs: no WS2 hits remain.
- [ ] **Step 4:** Commit `docs: describe executing communications approvals`.

### Task 7: Proof lane and PR

- [ ] `pnpm typecheck`
- [ ] Focused tests from Tasks 1–6 (storage, policy-engine, gateway, UI, shared)
- [ ] `pnpm verify:architecture:metrics`
- [ ] `node scripts/verify-repo-hygiene.mjs` (run it from PowerShell, because Git Bash false-reds)
- [ ] `git diff --check`
- [ ] `pnpm verify:fast` (background, low priority)
- [ ] Push with `git -c credential.helper='!gh auth git-credential' push -u origin HEAD`. Open the PR against main. Its body lists the WS2 tasks, the Review Focus pins, the nodemailer ruling, and the PG migration versions (212/213; a sibling workstream may need to renumber). End the body with the Claude Code line.

## Self-review notes

- Spec coverage: 2.1 → Tasks 3 and 5 (payload hash, idempotency key, effect kinds, no second approval, the four required tests, copy removal in Tasks 3 and 6); 2.2 → Tasks 1 and 3; 2.3 → Task 2; 2.4 → Task 4 with the fallback.
- "Settles failed" is read as: the approval stays `approved` (the operator did approve), the effect settles `failed` with `errorCode` + readable `lastError`, and the draft records `failed` + `failureReason`.
- Why not the generic `pending_action_execute`: the program plan keeps the richer custom previews. The pending-action row is written only at execution time, after `enqueueResolutionEffects` has run, so the generic path never sees it.
