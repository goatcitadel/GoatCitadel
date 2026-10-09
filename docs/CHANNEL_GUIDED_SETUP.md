# Channels guided setup

Channels uses the existing fourteen adapters. The Gateway owns setup drafts,
credential custody, checks, evidence and activation; Mission Control renders that
state. Setup follows prerequisites, account identity, destinations and access,
reviewed checks, governed activation, then first-message verification.

## Operator flow

- Start from **Needs attention**, **Connected accounts**, **Resume setup**, or
  **Add channel**. Repair and credential rotation hydrate a revision-bound draft.
- Complete account credentials and choose destinations. Slack and Telegram use
  editable destination cards with one explicit default. Discovery adds candidates
  for review and preserves existing thread information and selections.
- For inbound webhook adapters, choose who may message the bot. Destination IDs
  are routing configuration; sender identities authorize incoming conversations.
  An empty allowlist denies all senders. Existing open legacy access remains
  visible until an operator deliberately changes it.
  Removing an individual pairing or allowlist entry does not create a per-user
  deny inside an explicitly open legacy policy; select allowlist access to
  restrict who can start new work.
- Review the exact live-test input before dispatch. Provider acceptance, cleanup,
  deferred checks, failure details and timestamps are separate evidence.
- Reopen a saved draft to inspect its bounded check history. Fresh proof for the
  unchanged setup resumes automatically without sending another test message.
  Historical, expired or superseded receipts remain visible but cannot enable
  activation.
- Review and apply the exact Settings-origin Change Plan in Chat. Returning to
  Channels restores the draft or connection within the matching workspace. A
  workspace mismatch requires an explicit workspace selection before review.
  The review contains bounded public destination, access and installation details;
  structured edits remain in Channels and do not become JSON fields in Chat.
  After its canonical approval, select **Continue after approval** on that exact
  plan; channel approval does not silently resume activation.
- After activation, inspect transport readiness, accepted ingress and its linked
  reply. Historical activity from a different connection generation cannot
  complete a changed setup.

Instructions and checklist acknowledgements are preparation, not proof of
connectivity. Advanced input remains secondary and obeys the setup definition's
manual-mode policy. Configured credentials are masked and never copied back into
form controls.

## Channel boundaries

| Channel | Supported setup and completion evidence |
| --- | --- |
| Telegram | Bot identity, explicit chats/default, webhook secret and coordinated pairing/sender allowlist; an authorized incoming message and linked provider-accepted reply. |
| Discord | Paired direct messages or separately allowlisted server/guild/channel/user/role rules; identity/intents and invitation guidance. DM-only destination checks may remain deferred until runtime activation and pairing. |
| Slack | Explicit adoption of a bound OAuth install or existing supported credentials, workspace/channel membership and scopes, signed Events callbacks when configured; linked ingress/reply evidence for conversations. |
| WhatsApp | Business Cloud API sender phone-number resource and recipient. Both app secret and webhook verify token are needed for inbound routing. Personal WhatsApp QR linking is unavailable. |
| LINE | Messaging API identity and user/group/room destinations; sender authorization is distinct from destination selection. Signed webhook ingress and its reply prove a conversation. |
| Nextcloud Talk | Registered bot/room and shared signing token, reviewed live send and signed callback; authorized ingress and linked reply. |
| ntfy | Server/topic/auth and subscription guidance; dry-run, published notification and manual receipt remain distinct. |
| Google Chat | Space/thread incoming webhook and reviewed card delivery; provider acceptance and human receipt are separate. |
| Teams | Signed Workflows webhook with Anyone trigger authentication, explicit flow owner/co-owner and reviewed Adaptive Card delivery. Tenant-authenticated triggers need bearer support that this adapter does not provide. Retired connector URLs require migration; provider acceptance and visible destination receipt remain separate. |
| Mattermost | Server, bot, team/channel and permissions; action-specific outbound receipts. |
| Signal | Existing bridge/account/recipient and outbound receipt. Receive remains prohibited until the bridge provides durable acknowledgement and replay. |
| iMessage | Callable BlueBubbles bridge, chat/handle and action-specific Private API requirements. Photon/Spectrum remains diagnostics-only. |
| Zalo OA | Official Account token and eligible recipient; narrow outbound receipt and separate human confirmation. |
| Zalo User | Authenticated zca bridge, existing linked profile and supported target/media limits; credential aliases remain supported. |

Adapters without an inbound transport omit conversation requirements. A successful
notification send does not establish human receipt. Attachments, approvals,
scheduled delivery and reconnect behavior remain bounded by each adapter's
advertised capabilities and existing policy.

## Evidence and eligibility

`channel_setup_evidence` stores immutable redacted test, acknowledgement and
activation receipts. It excludes raw credentials, custody locators, arbitrary
provider payloads and incoming message bodies. Test evidence records its original
draft and connection revisions and input fingerprint. Activation evidence also
records the exact draft revision consumed by activation and commits
with the connection and draft removal in the same storage transaction.
Database append order selects the latest result even when timestamps tie. A newer
failed result supersedes older proof and acknowledgements; activation rechecks
that ordering atomically rather than trusting a process cache.

The Gateway computes finalization eligibility. Required failures, unknown
warnings, skipped required checks and ambiguous sends block activation. Optional
sandbox cleanup can remain advisory only when a successful provider receipt and
an explicit acknowledgement exist. Acknowledging cleanup preserves warning
severity. Legitimate post-activation checks remain deferred rather than becoming
fabricated passes. Fresh unchanged-input evidence can be restored after restart;
changed inputs, connection revisions or expired proof require retesting.
Current runtime content, validation and test versions also invalidate older proof.
Gateway-resolved credential changes invalidate its private input fingerprint.
Current results expose the original `proofExpiresAt`; acknowledgements never
extend it. An open editor disables preparation and acknowledgement at expiry
while retaining historical receipts.
The read-only draft-evidence API returns history separately from the Gateway's
current eligibility decision; reading it does not run probes or write draft state.

The bounded journey projection follows canonical ingress, turn and delivery
links. The Gateway stamps accepted ingress with its connection revision. Provider
retries preserve their original event identity and accepted generation across
configuration changes; only authority metadata is excluded from duplicate-content
comparison.
First-conversation completion and latest reply delivery are separate observations;
a later failed or uncertain reply cannot be presented as an older successful
receipt. Endpoint URLs in unstructured evidence text are redacted.

Teams guidance was checked against [Microsoft's Workflows webhook instructions](https://support.microsoft.com/en-us/workflows/send-messages-in-teams-using-incoming-webhooks)
and [connector retirement notice](https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams/).
The existing HTTP card adapter supports the unsigned-header Anyone trigger;
structural URL recognition never establishes successful delivery.

## API compatibility

- `GET /api/v1/channels/drafts/:draftId/evidence?expectedRevision=<revision>`
  requires the exact saved draft revision and current connection review. It
  returns at most twenty immutable receipts and an optional current test. A
  revision conflict requires refresh; history alone does not authorize activation.
- Telegram owner-reference discovery accepts either a draft ID and numeric
  revision or a connection ID and opaque revision. Credentials resolve only at
  the Gateway. The legacy token/env discovery API remains validated for existing
  callers. First-party UI callers use owner references.
- An active Telegram webhook is never deleted for discovery. Configured,
  accepted-ingress and pairing destinations remain usable candidates; unavailable
  update polling is explained. Discovery grants no access and selects no default.
- Telegram pairing list/approve/revoke APIs expose bounded public identities and
  require the current connection revision for writes. Approval and revocation
  update both pairing and sender authorization under one connection CAS. Existing
  pairing records gain no silent permissions; already accepted work is retained.
- Slack OAuth start requires an authenticated operator, workspace, draft and
  current revision. Attempts bind the server installation and any current
  connection revision, expire and consume callbacks once. Exact attempt status
  returns public install identity/scopes. Unbound starts return actionable errors.
- Slack callback completion stages credentials in temporary custody. It neither
  activates a connection nor replaces an existing install. Adoption explicitly
  updates the bound draft, invalidates old test proof and requires the normal
  validation and Change Plan activation flow. Cancel, expiry, interrupted
  exchange recovery and draft discard clean up task-owned temporary custody.
- Public draft PATCH and advanced edits retain Gateway-authored Slack install
  receipt fields and reject fabricated, replaced or cleared receipt metadata.
- The compatibility shared-client name `startSlackOAuth` now requires the same
  binding input. Availability-only status remains a read-only compatibility API.

SQLite migration 252 and PostgreSQL migration 198 append the evidence and OAuth
attempt tables, immutable evidence guards and OAuth binding/CAS guards. No existing
active account, legacy target format or historical pairing is bulk-rewritten.
Deploy backend contracts and migrations before UI callers. Use the documented
offline backup/recovery path for rollback rather than rewriting migration history.

## Verification and external acceptance

Focused contract, storage, Gateway and UI tests precede locked typechecks and the
channel runtime, parity, revisions, storage migration, accessibility, visual and
documentation lanes. Browser proof uses disposable runtime data and test-owned
processes; it does not change installed accounts or operate another agent's stack.

Live Telegram/Discord/Slack acceptance remains a separate operator-designated
sandbox pass. Check approved and rejected senders, linked replies, approvals,
attachments, scheduled delivery, reconnect and duplicate events. For every result,
record the connection revision, provider receipt, timestamp and any deferred or
unknown outcome. Automated test doubles and browser preparation are not evidence
that this external acceptance passed.
