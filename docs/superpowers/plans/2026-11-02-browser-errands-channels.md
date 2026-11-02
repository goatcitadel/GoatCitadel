# Browser Errands Away From the PC — Implementation Plan (PR 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Errands can be started from a channel conversation by the operator, and errand approvals reach the operator away from the PC. A channel-started errand asks in that conversation right away. A PC-started errand asks in the window and Chat first, then after 30 seconds also on the phone and in one channel conversation the operator picked. Answers come back through buttons where the platform has them, or a whole-message `APPROVE` / `DENY` / `STOP` reply.

**Architecture:**
- **Delivery.** Errand approvals keep their single Gateway approval record (kind `browser.errand.action`).
- **Who counts as the operator.** A new owner rule in `browser-errands/errand-owner.ts` decides who counts as the operator in a channel. It is used everywhere: starting an errand, button presses on errand approvals, and text replies.
- **Delivery mechanics.**
  - Delivery reuses the remote-token machinery (`createApprovalRemoteActionToken` → `enqueueApprovalRemoteTokenConnectorDelivery`).
  - It adds a per-delivery conversation target and an errand-specific message: a plain line plus the spotlight screenshot.
  - Discord gets message-component buttons beside Telegram's inline buttons.
  - Text replies are intercepted once, in `InboundChannelEventService.processClaim`, before a message becomes a Chat turn.
- **Escalation.** A 30-second escalation timer lives in the approval gate.
- **Phone.** The phone push for errand approvals is deferred to that timer.

**Tech Stack:** TypeScript, Fastify Gateway, policy-engine comms executor (Telegram Bot API, discord.js), React cockpit, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-browser-errands-design.md` — sections "Channels", "Decisions made on the operator's behalf", "Phone", "Approval integrity".

**Out of this PR:** signed phone approvals (PR 3). The phone receives errand approval notices here, and can deny and stop them as today.

## Global Constraints

**Text replies**
- Only a message whose whole text, trimmed of surrounding whitespace, is exactly `APPROVE`, `DENY` or `STOP` counts.
- Lower- or mixed-case variants and the words `yes` / `ok` get the reply `Reply APPROVE in capitals to approve.`
- This only happens while an errand approval delivered to that conversation is pending. Otherwise the message is ordinary chat.
- `APPROVE` / `DENY` resolve only the latest pending errand approval delivered to that conversation. `STOP` ends the errand.

**Who counts as the operator**
- `APPROVE` / `DENY` / `STOP`, the buttons, and starting an errand count only from the operator's own account: an `ownerActorIds` entry ("This is you") that is either:
  - allowlisted under `inboundAccessMode: "allowlist"` (the existing `isAllowlistedChannelOwner`); or
  - on a pairing-mode connection, still approved: Telegram `config.telegramPairing.approved`, or a Discord pairing record with `status: "approved"`.
- Revoking the pairing stops it.
- Anyone else gets `Only the owner can answer this.` (for approvals) or `Only the owner can start a browser errand here.` (for starting one).

**Conversations**
- Screenshots go only to direct (private) conversations. A group conversation gets text only, plus the line `Screenshots are only sent in a private conversation.`
- Direct versus group comes from the session binding's `ChatChannelConversation.kind`. Treat it as missing → group.

**Approval messages**
- No IDs, risk enums, kinds, token ids or expiry times on screen.
- An errand approval message is: `GoatCitadel wants to: <preview.summary>` + newline + `Page: <preview.url>` (already stored without query or fragment), then either `Tap Approve or Deny.` (buttons) or `Reply APPROVE or DENY. Reply STOP to end the errand.` (no buttons).

**Escalation timing**
- 30 seconds (`ERRAND_ESCALATE_AFTER_MS = 30_000`), measured from approval creation, for PC-started errands. Cancelled when the approval resolves or the errand stops.
- Each re-ask is a new approval and gets its own timer.

**Phone**
- No immediate push for `browser.errand.action` approvals.
- One push at escalation, sent only if the approval is still pending at send time.

**Settings**
- One governed string setting, `browserErrands.approvalSessionId`: the Chat session id of a direct channel conversation marked as the operator's own.
- Empty means no channel escalation; the phone still gets its push.
- Edited next to the "Browser errands" switch. The picker lists only conversations where `own === true` and `kind === "direct"`.

**Operational rules**
- Remote tokens are bound to one connector each. Issue with `issuedBy: "system:errand"` and `expiresInMs` equal to the approval's remaining TTL.
- Keep the architecture-metrics allowances as recorded (composition 8, service 12, fixtures 2, gate 23, loop 16). New owners get new C0 allowances only with the operator's sign-off. Prefer adding new files whose dependency reads are hoisted.
- No new runtime dependency. `gateway-service.ts` stays ≤13132 lines (currently 13121). Never `architecture:baseline:update`.
- Tests: vitest `--maxWorkers=2`; Gateway tests from `apps/gateway`. Rebuild contracts/policy-engine dist after changing them. Never `git stash`. Prettier only on touched files.
- Commit with a new uniquely named message file, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, on branch `feat/browser-errands-channels`.

## Review Focus

1. **The same `APPROVE` reaches two pending approvals.** Say a PC errand escalated to the operator's DM, while a channel errand also waits in that DM. Only one errand runs at a time, so this can only happen via a stale approval. The reply resolves the newest pending errand approval delivered to that conversation, and older stale ones are ignored. Pinned in Task 5.
2. **A button or `APPROVE` arrives after the approval was resolved elsewhere.** The token is already expired by resolution, so the press does nothing and answers `This was already answered.`. Pinned in Tasks 4 and 5.
3. **A pairing is revoked while the errand runs.** The next `APPROVE` from that account is refused as not the owner. Pinned in Task 1.
4. **The channel connection is disconnected or unready when escalation fires.** Escalation skips the channel, logs a warning, and still sends the phone push. The errand keeps waiting in the window and Chat. Pinned in Task 6.
5. **A Telegram photo caption longer than 1024 characters.** The errand message must stay under 1024 characters with the buttons attached to the photo. Truncate the summary and never drop the buttons. Pinned in Task 2.

---

### Task 1: Who counts as the operator, and channel-started errands

**Files:**
- Create: `apps/gateway/src/services/browser-errands/errand-owner.ts` (+ test).
- Create: `apps/gateway/src/services/browser-errands/errand-origin.ts` (+ test).
- Modify: `browser-errand-service.ts`.
  - Replace the `sessionChannel !== "mission"` refusal with the owner rule.
  - Delete `BROWSER_ERRAND_CHANNEL_MESSAGE` and add the two refusal strings.
- Modify: `browser-errand-composition.ts` to wire the readers.
- Modify: the runner's errand exposure gate if it hides `browser.errand` on channel turns. Expose it on channel turns; the server-side owner check is authoritative.

**Interfaces:**
- `isErrandOwner(input: { channelKey: string; config: Record<string, unknown>; actorId: string; discordApprovedActorIds?: readonly string[] }): boolean` (pure).
  - True when the lowercased actor is in `resolveChannelOwnerActorIds(config)` AND any of:
    - `isAllowlistedChannelOwner(config, actorId)`;
    - `channelKey === "telegram"` and the actor is in `config.telegramPairing.approved[].actorId`;
    - `channelKey === "discord"` and the actor is in `discordApprovedActorIds`.
- `ErrandOrigin` is one of:
  - `{ kind: "pc" }`
  - `{ kind: "channel"; connectionId: string; channelKey: string; target: string; conversation: "direct" | "group"; actorId: string }`
- `resolveErrandOrigin(deps, sessionId: string, turnId: string): Promise<ErrandOrigin>`.
  - `channel` session → `chatSessionBindings.get(sessionId)` + the turn's user message `actorId`.
  - `mission` → `pc`.
- `BrowserErrandService.run` calls `resolveErrandOrigin`. For `channel` it loads the connection config (plus Discord approved pairings via `readDiscordPairings`) and refuses non-owners. It stores `origin` on the active errand.

- [ ] **Step 1: write failing tests.**
  - Owner-rule table, which must include:
    - allowlist owner → true;
    - Telegram owner in `approved` on a pairing-mode connection → true;
    - Telegram owner whose pairing was revoked (removed from `approved`) → false;
    - Discord owner with an approved record → true;
    - Discord record `revoked` → false;
    - a paired non-owner → false;
    - an owner on an `open_legacy` connection without pairing → false.
  - Service tests:
    - an owner in a Telegram direct conversation starts an errand;
    - a non-owner gets `Only the owner can start a browser errand here.`;
    - a mission session still runs with origin `pc`.
- [ ] **Step 2: run them, see them fail.**
- [ ] **Step 3: implement.**
- [ ] **Step 4: run them plus the existing browser-errands suite. Gateway `tsc --noEmit`; architecture metrics.**
- [ ] **Step 5: commit** `feat(gateway): let the operator start browser errands from their channels`.

### Task 2: Errand approval messages to a conversation (Telegram photo + buttons)

**Files:**
- Modify: `apps/gateway/src/services/approval-connector-delivery.ts`.
  - `buildApprovalRemoteTokenConnectorDeliveryPayload` accepts an optional `delivery?: { target: string; message: string; attachmentIds?: string[] }` that overrides `approvalDeliveryTarget` and the default message.
  - The default message path is unchanged for other kinds.
- Modify: `approval-remote-action-service.ts` / `approval-runtime-service.ts`. `createApprovalRemoteActionToken` accepts and passes through the same optional `delivery`.
- Create: `apps/gateway/src/services/browser-errands/errand-approval-message.ts` (+ test).
- Modify: `packages/policy-engine/src/tool-executor/comms-executor.ts`. `telegramSendAttachment` accepts `replyMarkup` and passes `reply_markup` to `sendPhoto`. `telegramSend` passes the inline keyboard on the attachment path too.
- Create: `apps/gateway/src/services/browser-errands/errand-approval-delivery.ts` (+ test).

**Interfaces:**
- `buildErrandApprovalMessage(input: { summary: string; pageUrl?: string; buttons: boolean }): string`, using the exact copy from Global Constraints. The result is ≤1024 characters (truncate the summary with `…`).
- `deliverErrandApproval(deps, input: { approval: ApprovalRequest; origin: Extract<ErrandOrigin, {kind:"channel"}> | { connectionId: string; channelKey: string; target: string; conversation: "direct" | "group" }; screenshotAttachmentId?: string }): Promise<{ delivered: boolean; reason?: string }>`
  - Issues a token via `createApprovalRemoteActionToken(approval.approvalId, { connectorId: \`integration:${connectionId}\`, issuedBy: "system:errand", expiresInMs, delivery })`.
  - Attaches the screenshot only for `direct`.
  - Uses buttons when `approvalInlineActionsReady`.
  - Records `{ approvalId, connectionId, target }` in the errand's in-memory delivery list (consumed by Task 5).

- [ ] **Step 1: failing tests.**
  - The message copy for the buttons and no-buttons variants.
  - 1024-character truncation keeps the trailing instruction.
  - The payload builder with `delivery` uses that target and message, and leaves other kinds byte-identical (snapshot an existing kind).
  - The comms executor sends `sendPhoto` with `reply_markup` when both an attachment and inline actions are present (mock fetch).
  - `deliverErrandApproval`:
    - group → no attachment plus the private-only line;
    - direct → attachmentIds set;
    - a token issued once per connector.
- [ ] **Step 2–4: implement and verify.** Policy-engine tests; Gateway tests; `tsc`; metrics.
- [ ] **Step 5: commit** `feat(gateway): send errand approvals to a conversation with the screenshot`.

### Task 3: Discord approval buttons

**Files:**
- Modify: `packages/policy-engine/src/tool-executor/comms-executor.ts`.
  - Discord messages accept an `interactiveActionTemplate`. Build one action row with two buttons, `Approve` (style 3) and `Deny` (style 4).
  - `custom_id` is `gca:<rawToken>:a` / `gca:<rawToken>:r`, resolved at the provider boundary like Telegram's.
  - Relax the Telegram-only guards (~L292, ~L303) to allow `discord` when the connection is in gateway (bot) mode.
- Modify: `apps/gateway/src/services/connector-registry.ts:81`. `approvalInlineActionsReady` is also true for a connected Discord connection in bot/gateway runtime mode.
- Modify: `apps/gateway/src/services/discord-runtime-service.ts`. `interactionCreate` gets an `isButton()` branch:
  1. Parse `^gca:([^:]+):(a|r)$`.
  2. Apply the existing guild-allowlist and pairing checks.
  3. Find the token id.
  4. Dispatch a durable inbound command `discord-approval-button` (mirroring `telegram-approval-callback`).
  5. Answer with an ephemeral reply.
- Modify: `discord-runtime-bridge-service.ts`. Execute that command via `resolveApprovalWithRemoteTokenId` with `resolvedBy: "discord:<actorId>"`.

- [ ] **Steps 1–5 (TDD):**
  - The executor builds `components` with the two buttons, and the raw token appears only in `custom_id`.
  - A button press with a valid token → resolve (approve / reject).
  - A malformed `custom_id` is ignored.
  - A non-paired user is refused.
  - An already-resolved token → `This was already answered.`
  - Commit `feat(discord): Approve and Deny buttons for approvals`.

### Task 4: Owner check on errand approval buttons

**Files:** the Telegram callback path (`telegram-update-processor.ts` / `telegram-inbound-command-service.ts`) and the Discord button path from Task 3.

**Interfaces:** before resolving, load the approval. If `kind === "browser.errand.action"`, require `isErrandOwner(...)` for the presser, otherwise answer `Only the owner can answer this.` and leave the approval pending. Other kinds are unchanged.

- [ ] **Steps 1–5 (TDD):**
  - Telegram: a paired non-owner presses Approve on an errand approval → refused, approval still pending.
  - Telegram: the owner → approved.
  - Telegram: a non-errand approval from a paired non-owner → still allowed, unchanged behavior.
  - The same three on Discord.
  - Commit `fix(channels): only the owner answers errand approvals`.

### Task 5: Whole-message `APPROVE` / `DENY` / `STOP` replies

**Files:**
- Create: `apps/gateway/src/services/browser-errands/errand-channel-replies.ts` (+ test).
- Modify: `apps/gateway/src/services/inbound-channel-event-service.ts` `processClaim`. Before `ingestChannelMessage` (step 4), call an injected `handleErrandReply` hook. If it returns `handled`, send its reply and stop: no Chat turn, no ingest.
- Modify: `BrowserErrandService`. Expose `pendingDeliveryFor(connectionId, target)`, which returns the newest pending errand approval delivered there, and `stop(errandId, actorId)` (exists).

**Interfaces:**
- `classifyErrandReply(text: string): "approve" | "deny" | "stop" | "near_miss" | null`.
  - Exact `APPROVE` / `DENY` / `STOP` after trim.
  - `near_miss` for a case-insensitive match that isn't exact, or for `yes` / `ok`.
  - Otherwise `null`.
- `handleErrandReply(input: { connectionId; channelKey; target; actorId; text }): Promise<{ handled: false } | { handled: true; reply: string }>`.
  - Returns `null` / `{handled:false}` when no errand approval is pending for that conversation.
  - Non-owner → `Only the owner can answer this.`
  - Approve / deny → `resolveApproval(id, …, { resolvedBy: \`${channelKey}:${actorId}\` })` → reply `Approved.` / `Denied. The errand will stop.`
  - Stop → `Stopping the errand.`
  - Near miss → the Global Constraints hint.
  - Already resolved → `This was already answered.`

- [ ] **Steps 1–5 (TDD):**
  - The classifier table, which must include `APPROVE`, `  APPROVE \n`, `approve`, `Approve`, `APPROVE please`, `yes`, `ok`, `DENY`, `STOP`, `stop`.
  - An exact `APPROVE` with a pending delivery resolves it, and no Chat turn is ingested (assert `ingestChannelMessage` not called).
  - With no pending delivery, the text passes through to a normal turn.
  - A non-owner is refused.
  - Review Focus 1: two deliveries to the same target, so the newest is resolved.
  - Review Focus 2: an already-resolved approval.
  - Commit `feat(gateway): answer errand approvals with APPROVE, DENY or STOP`.

### Task 6: Escalation and deferred phone push

**Files:**
- Modify: `errand-approval-gate.ts`. New optional dep `escalate?(approval: ApprovalRequest, origin: ErrandOrigin): Promise<void>`.
  - In `requestOnce`, after `ask`:
    - channel origin → call immediately;
    - pc origin → `setTimeout(ERRAND_ESCALATE_AFTER_MS)`.
  - Clear it in the existing `finally`. Keep dependency reads hoisted; the gate cap is 23.
- Create: `apps/gateway/src/services/browser-errands/errand-escalation.ts` (+ test). It implements `escalate`:
  - channel origin → `deliverErrandApproval` to the origin conversation;
  - pc origin → `deliverErrandApproval` to the conversation resolved from the `browserErrands.approvalSessionId` setting (session binding → connection/target/conversation), plus the phone push.
- Modify: `mobile-push-service.ts`.
  - `enqueueMobilePushApprovalRefresh` skips events whose approval kind is `browser.errand.action`. Read the kind from the event payload; if it is absent there, add `kind` to the `approval_created` payload in `approval-observability.ts`.
  - New `enqueueMobilePushApprovalRefreshNow(storage, approvalId)`.
  - `deliverClaimed` skips (marks done) approvals no longer pending, for every kind.

- [ ] **Steps 1–5 (TDD):**
  - Gate, with fake timers:
    - pc origin escalates at 30 s, not before;
    - resolved at 10 s → never escalates;
    - channel origin escalates immediately;
    - each re-ask gets its own timer.
  - Escalation:
    - setting empty → only the phone;
    - a disconnected connection → phone only plus a warning (Review Focus 4).
  - Push:
    - an errand approval creation enqueues nothing;
    - the escalation enqueues one;
    - a resolved approval is not sent.
  - Commit `feat(gateway): send waiting errand approvals out after 30 seconds`.

### Task 7: The errand approval conversation setting and picker

**Files:** follow `publicWebAddress` end to end, with a `runtime_configuration` operation `browser_errand_approval_conversation`:
- `packages/contracts`: an operation type plus a guard, the change-plan validator case, and the config schema.
- `apps/gateway/src/config.ts`, `config-sync-lib.ts`, `runtime-settings.ts`, `settings-auth-service.ts`.
- `routes/dashboard.ts`, `dashboard-settings-change-plan.ts`, `routes/change-plans.ts`.
- `runtime-configuration-change-plan-adapter.ts` (apply / patch / matches / describe). The describe copy is `Send waiting browser errand approvals to <conversation title>` or `Stop sending browser errand approvals to a channel`.
- `mission-control-shared` settings types.
- `apps/mission-control-next/src/cockpit/areas/settings/`:
  - new `BrowserErrandsApprovalConversationField.tsx` (+ test), placed under `BrowserErrandsControl`;
  - `settings-approval-owner.ts`;
  - `query-keys.ts` (`SETTINGS_READER_KEYS`).

**Interfaces:**
- The Gateway validates that the session id is a channel conversation with a writable binding and `kind === "direct"`. Otherwise it rejects with `Pick one of your own private conversations.`
- The UI picker uses `useMessagingOverview`, lists `own && kind === "direct"` conversations as `<channel label> · <title>`, and has a `None` option.
- Help text: `When you're away from the PC, errand approvals go here and to your phone if you haven't answered in 30 seconds.`

- [ ] **Steps 1–5 (TDD):**
  - Gateway: the plan round-trip, rejecting a group conversation, and clearing to empty.
  - UI: lists only own direct conversations; selecting creates the plan; settings-readers inventory green.
  - Checks: mission-control-next typecheck, cockpit-semantics + page-anatomy guards (live regions ≤904, padded-panel ≤54).
  - Commit `feat(settings): choose where waiting errand approvals go`.

### Task 8: Channel notices and results

**Files:** `browser-errand-service.ts` (or a new `errand-channel-notices.ts` to protect the service's cap of 12), plus tests.

**Behavior:**
- **Sign-in pause** (hand-over for sign-in or a bot check): send `GoatCitadel needs you at the PC to sign in. The errand is paused.` as a plain channel message.
  - Channel origin → to the origin conversation right away.
  - PC origin → after 30 s, to the setting's conversation.
  - Not a phone push.
- **Errand end, channel origin:**
  - The Chat turn's reply already goes back as text.
  - Additionally send the final screenshot to the origin conversation only when it is `direct`.
  - In a group, send the private-only line once.
- **Sends:** all of these go through the same `channel.send` path as Task 2, without tokens. Factor out a small `sendErrandChannelMessage(deps, {connectionId, target, message, attachmentIds?})`.

- [ ] **Steps 1–5 (TDD):**
  - Sign-in pause notices for the channel-origin and pc-origin paths (fake timers).
  - Final screenshot: direct gets an attachment, group gets text only.
  - No notice when the setting is empty and the origin is pc.
  - Commit `feat(gateway): tell the operator's channel about sign-ins and send the final screenshot`.

### Task 9: Docs and proof

**Files:**
- `docs/DESKTOP_AUTOMATION_SAFETY.md`, Browser errands section:
  - channels are now in;
  - who counts as the operator;
  - `APPROVE` / `DENY` / `STOP`;
  - screenshots only in private conversations;
  - the 30-second hand-off;
  - the phone still can't approve (PR 3).
- The spec status note.
- `scripts/dev/errand-local-proof.mjs`: add a `--channel` note describing a manual channel check. No automation of real channels.

- [ ] **Step 1: update the docs truthfully.** Claim nothing that wasn't built.
- [ ] **Step 2: run** `pnpm docs:check`, `git diff --check`.
- [ ] **Step 3: commit** `docs: browser errands in channels`.
