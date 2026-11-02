# Browser errands PR 3: signed phone approvals (Gateway side)

Date: 2026-11-02
Spec: `docs/superpowers/specs/2026-11-01-browser-errands-design.md` ("Phone", "Routing", test list)
Stacks on: PR 2 (`feat/browser-errands-channels`)

## Goal

A paired phone can approve or edit an approval only with a valid Ed25519 signature from its grant's active approval
key, over the existing `goatcitadel.mobile-approval-decision.v1` contract. The capability ships switched off. The
phone also gets the errand's spotlight screenshot and one plain line when it loads a waiting errand approval.

## Decisions

- **Contract.** The signing payload stays exactly `buildMobileApprovalDecisionSigningPayload` in
  `apps/gateway/src/services/mobile-approval-key-service.ts`. The payload hash is the sha256 hex of the empty string
  for `approve`, and of `canonicalJsonString(editedPayload)` (from `@goatcitadel/contracts`) for `edit`.
- **Binding.** The Gateway, not the request, supplies the approval id (route parameter), the decision (request body),
  the grant id and the companion session id (the authenticated companion session). A signature made for anything
  else fails.
- **Single use, durably.** The signed message names one approval and one decision. The approval's own `status`
  column moves from `pending` exactly once, under a compare-and-swap in `approvals.resolve`. So a nonce can be
  accepted at most once, and a replay, before or after a restart, finds the approval answered and is refused with a
  plain 409. No new table or migration is needed.
- **Switch.** `COMPANION_SIGNED_APPROVALS_ENABLED` in `apps/gateway/src/services/companion-signed-approval.ts` is
  `false`. The composition passes it to the mobile route port; only tests build the port with `true`. While it is off,
  a companion approve or edit gets today's 403 with today's message. Flipping it is a follow-up, recorded in the spec
  and in `docs/DESKTOP_AUTOMATION_SAFETY.md`, once the phone app's matching release passes its device proof.
- **Not approvable from the phone.** Device access requests stay operator-only, signed or not.
- **Reject** from a companion works without a signature, as today.
- **Phone view.** For `browser.errand.action` only, only on a companion read of a waiting approval, the approval
  response carries `errandPhoneView`: one plain line ("GoatCitadel wants to: …", no ids), the page (origin and path),
  and the spotlight screenshot as base64 PNG when it is the approval's own screenshot (same chat session, matching
  sha256) and at most 4 MiB.
- **Phone-started errands.** A companion cannot send a Chat turn today, so there is no "started from the phone"
  origin to route on. That is a follow-up, not part of this PR.

## Tasks

### Task 1: signed decision admission (new file, no typed dependency reads)

`apps/gateway/src/services/companion-signed-approval.ts`: the switch, the request schema for `signedDecision`, the
payload hash, and `admitCompanionSignedDecision`, which returns either the verified key or a plain refusal (status
and message) for: switch off, no signature, missing companion grant or session, a malformed request, no active key,
an inactive grant, a stale or future timestamp, and a bad signature.

Tests (`companion-signed-approval.test.ts`): payload hash for approve and edit; switch off refuses; missing signature
refuses; each verifier reason maps to its plain message; a verified result passes through the key id.

### Task 2: wire it into the approvals route

- `mobile-route-service.ts`: a new `admitSignedCompanionDecision` method on the mobile port, using the key service's
  `verifyApprovalDecisionSignature` and the switch. Consolidate reads so the file stays at its cap.
- `gateway-route-composition-runtime.ts`: pass the shipped switch.
- `routes/approvals.ts`: a companion approve or edit goes through the admission; then the approval must be waiting
  and not a device access request; then it resolves as `companion:<session>`.

Tests (`routes/approvals.signed-companion.test.ts`, real SQLite storage, a real key service and a test signer):
approve accepted; edit accepted (the edited payload is the one signed); replay refused, including after closing the
database and opening a fresh app and service over the same file; stale and future timestamps; revoked key; wrong
approval; wrong decision; switch off refuses with today's message; reject still works unsigned.

### Task 3: errand phone view

`apps/gateway/src/services/browser-errands/errand-phone-approval-view.ts` builds the view from the approval and a
screenshot reader; `routes/approvals.ts` adds it to a companion `GET /api/v1/approvals/:approvalId` for errand
approvals only.

Tests: the companion read of an errand approval carries the line, page and screenshot; an operator read does not; a
non-errand approval does not; an answered errand approval does not; a screenshot from another session or with a
different sha256 is left out; the line carries no ids.

### Task 4: docs and Settings copy

- `docs/DESKTOP_AUTOMATION_SAFETY.md`: until the phone app update ships, the phone can see and deny errand
  approvals; approving happens in the window, Chat or a channel. The Gateway side of signed phone approvals exists
  but is off; the flip is a follow-up.
- Settings › Tools approval conversation help: the same sentence.
- The spec: record the switch flip and phone-started errands as follow-ups.

Tests: the Settings field test asserts the new help text; `pnpm docs:check`.

## Checks before push

Gateway `tsc --noEmit`, `architecture-metrics`, `gateway-async-boundary`, `check-no-empty-catch`, `pnpm docs:check`,
`git diff --check`, eslint on touched files.
