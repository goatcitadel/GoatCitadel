# Native Google Workspace Completion Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task in this chat, followed by the independently reviewed final diff, as approved by the operator.

**Goal:** Implement the approved native Gmail and Calendar action gaps without widening existing read allowances or bypassing approval.

**Architecture:** Extend the existing Google OAuth owner and comms side-effect ledger. Extract Google-specific payload execution into focused policy modules behind the comms executor's allowlisted HTTP port. Share action definitions, schemas and capability requirements through contracts/registry owners.

**Tech Stack:** TypeScript, Fastify, existing nodemailer, Vitest, existing Gateway artifacts and policy/path boundaries.

**Spec:** `docs/superpowers/specs/2026-11-18-google-workspace-completion-design.md` (approved in this Chat).

## Execution result — 2026-11-18

Implemented in this Chat and installed locally with the authorized managed restart. The independent review findings were resolved, including complete draft-header review, externalized text MIME bodies, preserved threading, unique frozen Message-IDs, strict argument validation and the canonical read-to-reply source reference.

Proof: focused contracts, policy, Gateway, shared review and setup UI suites; lock-wrapped contracts/policy/Gateway/UI typechecks; `docs:check`, `verify:gateway:async-boundary` and `git diff --check`. The final `verify:durable:recovery` run passed all four scenarios with an unchanged candidate: `artifacts/verification/2026-11-19T01-35-32-214Z-durable-recovery-a159a129/manifest.json` (604 passed tests, four skipped, plus the stack-backed restart/recovery proof).

Rendered checks covered Google access review, mail and Calendar previews, full-read approval, disclosures, cancel/focus return, and desktop/390px phone layouts in light/dark fixture states. The real installed Google review also showed nine choices with the original four enabled and the five additions off. Screenshots and installed readbacks are under `.tmp/google-workspace-completion/`. The native desktop host was reopened and rendered Chat with core checks passing.

The installation receipt and backup are at `%LOCALAPPDATA%\GoatCitadel\google-workspace-completion-patch.json` and `%LOCALAPPDATA%\GoatCitadel\google-workspace-backup-20261118-174239`. All 532 staged file hashes were verified, covering 26 scoped runtime modules and a cache-versioned copy of the existing UI graph with four module changes. Configuration hashes were unchanged, and the previously installed capability guide was retained.

Limits: no live Google consent exchange, mail sends, draft/inbox changes, attachment exports or Calendar mutations were performed. Installed MIME and secondary-calendar identity checks used offline composition/injected responses. New capabilities remain opt-in through Reconnect Google. Source is uncommitted and unpublished; the local installed patch can be replaced by a later app update. The detailed tasks below are retained as the original acceptance checklist; this result records the proof actually produced.

## Global constraints

- Preserve existing unrelated changes; no commits or pushes.
- All new scopes opt-in. No live mail/calendar mutation for tests.
- Metadata grants remain metadata-only; new full reads have distinct tool identities.
- Every remote mutation remains approval-gated, scoped, ledgered and non-retryable after an ambiguous send.
- Limits: 25 search results/page, 50 thread messages, 128 KiB/message text, 1 MiB/thread text, 10 MiB/attachment, 20 MiB/outgoing message, 20 calendars and 31 days/free-busy query.

## Review focus

- Concurrent draft edits: verify reviewed message identity and send frozen MIME.
- Attachment substitution and path escape: immutable hashes and scoped artifact lookup, never model-named host URLs.
- New full reads versus old allowances: exact tool/selector/sign-in binding.
- Free/busy POST: read classification and partial calendar errors.
- Recurring/all-day changes: explicit occurrence/series choice and exclusive end dates.

## Tasks

### 1. Native action contracts and permission matrix

Files: `packages/contracts/src/google-workspace.ts`, focused adjacent action/schema module and tests, `apps/gateway/src/services/google-workspace-oauth-service.ts`, integration catalog and Google setup tests.
Interfaces: export explicit action definitions and `googleWorkspaceCapabilitiesForTool(toolName, args)`; keep `googleWorkspaceCapabilityForTool` backward compatible. Add separately enabled full Gmail content, drafts, inbox management, calendar discovery and availability capabilities.

- [ ] Write/run failing permission and old-grant compatibility tests.
- [ ] Implement cumulative scopes, switches, schema/label definitions, and normalized account binding for new tools.
- [ ] Run focused contracts/OAuth tests and lock-wrapped typechecks.

### 2. Gmail reads, pagination and immutable attachment handling

Files: new `packages/policy-engine/src/tool-executor/google-workspace-runtime.ts`, `google-mail-content.ts`, focused tests; narrow comms dispatcher integration; Gateway Google artifact adapter.
Interfaces: injected HTTP port receives `{method, body, readOnly}`; return explicit untrusted records/continuation. Full message/thread reads are distinct from `gmail.read`; attachment export returns a scoped artifact reference/hash.

- [ ] Test MIME decoding, truncation, repeated/invalid cursors, missing messages, attachment bounds and cross-workspace denial.
- [ ] Implement explicit bounded text/attachment results and account/query-bound pagination.
- [ ] Run read/attachment and existing Google metadata regression tests.

### 3. Gmail composition, replies/forwards, drafts and inbox actions

Files: new `google-mail-compose.ts`, Google runtime tests, `tool-action-approval-preview.ts`, policy registry/mutation/security/host classifiers, Gateway prepared-message/attachment owner.
Interfaces: immutable outgoing MIME with reviewed recipients/body/attachment hashes/source identity; nodemailer stream composition with URL/file access disabled. Draft send requires draft access and send consent and uses frozen `message.raw`.

- [ ] Test Unicode MIME, CC/BCC, header injection, real threading headers, selected forward attachments, stale drafts, labels/Trash and ambiguous sends.
- [ ] Implement compose/send/draft/modify operations and exact approval previews.
- [ ] Verify fake-provider sends cross the effect boundary once; read grants never authorize these actions.

### 4. Complete Calendar actions

Files: new `google-calendar-runtime.ts` and focused tests; registry/previews/capability mappings.
Interfaces: paged calendars/events, event get, read-only free/busy POST; timed/all-day/recurring creation, reminders/Meet; etag-guarded update/delete; secondary RSVP authenticated through primary calendar discovery.

- [ ] Test pagination, mixed free/busy errors, all-day dates, recurrence scope, notifications, stale etags and authenticated attendee identity.
- [ ] Implement allowlisted payload builders and preserve ambiguous mutation handling.
- [ ] Verify existing primary RSVP and Calendar read grants remain compatible.

### 5. Operator truth and rendered acceptance

Files: Google integration catalog, Google sign-in components/tests, tool labels/groups, Google Workspace guide and relevant operating-guide material.

- [ ] Keep scope review, action availability, approval summaries and limitations aligned with implementation.
- [ ] Render setup and new approval/result states using a disposable fake provider; exercise disclosures/controls at desktop/mobile widths.
- [ ] Record screenshots and identify any untested real-provider behavior.

### 6. Final proof, review and installed rollout

- [ ] Run focused suites, typechecks, docs checks, appropriate named provider/approval/durable lanes and diff checks on a frozen candidate.
- [ ] Independent final review; fix and revalidate actionable findings.
- [ ] Prepare backed-up scoped installed update; use the approved managed restart only after ownership checks and coordination.
- [ ] Read installed tool/permission state, preserve old grants, and hand new Google consent to the operator. Report exact validation limits.
