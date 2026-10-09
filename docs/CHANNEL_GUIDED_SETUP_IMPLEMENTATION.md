# Channels guided setup implementation

Initially implemented and validated against
`e7303e0780d3364db71c88d66674e96f5b84c5c5` in an isolated checkout.
The primary checkout and its existing processes were preserved. The initial
implementation handoff preceded publication; its evidence is recorded below.

## Delivered behavior

- All fourteen existing adapters use prerequisite, identity, destination/access,
  reviewed-check, governed-activation and first-message guidance. Both Cockpit
  and the Classic rollback owner consume the shared definitions and controls.
- Telegram and Slack use destination cards that preserve canonical targets,
  threads and explicit defaults. Inbound webhook setups persist their sender
  policy; empty allowlists deny access. Telegram pairing and authorization change
  together under the current connection revision. Discord retains its separate
  direct-message and guild rules.
- Telegram discovery resolves owner-bound credentials inside the Gateway and
  never removes an active webhook, changes a destination or authorizes a sender.
- Slack authorization is operator/installation/workspace/draft/revision bound.
  Callbacks stage credentials, expose an exact public installation receipt and
  require explicit adoption before validation and Change Plan activation.
- Immutable, redacted SQLite/PostgreSQL evidence persists test outcomes,
  acknowledgements and activation linkage. Database append order, exact input
  fingerprints and transactional latest-proof checks prevent stale success or
  acknowledgement reuse. Unknown warnings and required skipped/failed checks
  block activation; supported deferrals remain visibly deferred.
- Saved drafts reopen their bounded immutable check history. Only fresh exact
  Gateway proof resumes current eligibility without another test message. Runtime
  version or credential changes, newer failures and expiry invalidate reuse;
  delayed responses cannot override local edits or a newer operation.
- Chat reviews the exact Settings-origin plan without inventing a session origin.
  Canonical approval and explicit continuation govern activation. Reload and
  return restore the matching draft or activation receipt. Cancelling a reviewed
  plan cannot silently delete newer draft edits or hide failed owner cleanup.
- Revision recovery permits local editing while writes remain blocked. Only an
  exact Gateway-authored rejection before side effects permits precommit recovery;
  post-send conflicts and unknown outcomes cannot silently unlock retries.
- The journey follows canonical accepted ingress, turn and reply links for the
  accepted connection generation. Provider retries retain their deduplication
  identity across configuration changes. Completed first-conversation proof and
  the latest reply outcome are displayed separately.
- Teams guidance uses current Workflows trigger URLs and the adapter's supported
  Anyone authentication. Saved and environment-backed URLs receive the same
  structural checks without public credential disclosure. Signed/error endpoint
  text is redacted before storage and presentation.

The remaining adapter-specific boundaries, setup requirements and API compatibility
notes are recorded in [Channels guided setup](./CHANNEL_GUIDED_SETUP.md).
No new adapter, dependency, Slack Socket Mode, personal WhatsApp QR flow or Signal
receive path was introduced.

## Source owners

| Layer | Relevant source |
| --- | --- |
| Contracts | `packages/contracts/src/channel-wizard.ts`, `channel-oauth.ts`, `channel-setup-evidence.ts`, `channel-setup-operations.ts` |
| Persistence | `packages/storage/src/channel-guided-setup-schema.ts`, evidence/OAuth repositories and `channel-setup-draft-repo.ts` |
| Runtime | Gateway `channel-setup-*`, `channel-oauth-*`, pairing, probe, ingress and channel setup routes |
| Guided UI | Mission Control `features/native-routes/settings/channel-setup`, channel settings hooks and Cockpit settings owners |
| Chat review | `packages/threaded-surface-core/src/chat/WorkspaceChannelPlanReview.tsx` and the exact shared handoff client |
| Browser proof | `scripts/verification/lib/scenarios/channel-guided-setup-lane.mjs` and existing revision/visual/accessibility lanes |

SQLite migration **252** and PostgreSQL migration **198** are additive. Existing
published migration definitions were preserved. Deploy backend contracts and
migrations before changing UI callers. Publication integration preserved main's
independent SQLite statement-cache changes rather than replacing the file.

## Verification boundary

Focused contract, storage, Gateway and UI regressions passed. The expanded channel
parity gate includes authorization, discovery, OAuth binding, evidence,
eligibility, revision recovery, journeys, cancellation and adapter transport
checks. Real PostgreSQL 16 proof applied all 198 migrations in a disposable schema
and checked immutable receipts and OAuth CAS guards; its task-owned cluster was
stopped and removed.

| Verification | Result |
| --- | --- |
| Full workspace `pnpm typecheck` | Passed with repository output locks. |
| `verify:channels:parity` | Passed: 452 Gateway tests across 31 files, 20 capability tests, 17 targeted provider-adapter tests and inventory checks. Unrelated provider tests were deliberately filtered. |
| `verify:channels:guided` | Passed: all 14 guides on desktop and at 390 pixels, accessibility/overflow checks, 98 keyboard step activations, destination cards, persisted-test resume without resending and exact approval/cancellation/reload/return. |
| `verify:channels:revisions` | Passed again after the final resume changes: stale connection rejection, retained edits and explicit current-revision review. |
| `verify:channels:runtime` | Passed canonical durable ingress/reply checks; this is not external provider acceptance. |
| `verify:storage:migration-parity` | Passed migration registry, integrity and runtime-schema checks for SQLite 252/PostgreSQL 198. |
| Actual PostgreSQL 16 | All 198 migrations applied; immutable receipts, OAuth CAS and atomic superseded/unbound-failure guards passed. Disposable cluster stopped and removed. |
| Focused final storage/UI/script tests | SQLite evidence 7/7; Channels UI 86/86; browser-lane/logger 18/18. Additional focused Gateway/client regressions passed before integration gates. |
| `verify:surface:regression` | All 101 scenarios passed before the final draft-resume addition; the final guided/revision lanes cover that addition. |
| `verify:accessibility:smoke` | All 8 existing operator-surface scenarios passed; the final guided lane separately audits all 14 adapters and narrow screens. |
| Selected `verify:visual:regression` | All 12 Channels/Connections/Chat comparisons passed across desktop/mobile and dark/light variants. |
| `verify:ui:parity` | Passed all six existing Classic rollback owner probes with seeded-state, workspace-isolation and strict console-health assertions. Temporary owner visits are explicit; Cockpit coverage is in the guided/surface lanes. |
| `verify:gateway:async-boundary` | Passed scanner regressions and 1,134 production source files. |
| `docs:check` and `git diff --check` | Passed. |

Failed browser attempts were retained as diagnostics and
repaired; they are not counted as passing evidence. Only the two reviewed Channels
mobile visual snapshots were refreshed.

Successful local browser receipt IDs (artifacts are retained locally, not committed):

- Guided setup: `2026-10-09T04-44-06-242Z-channel-guided-setup-74d5efc9`
- Revision recovery: `2026-10-09T04-45-42-325Z-channel-connection-review-d656136f`
- Visual regression: `2026-10-09T04-51-38-758Z-visual-regression-2b7272c9`
- Operator UI parity: `2026-10-09T04-56-05-610Z-ui-parity-bb01b194`
- Surface regression: `2026-10-09T04-10-25-147Z-surface-regression-5db2ee5f`

Final proof servers are stopped: no Node process referenced the task checkout,
and all eight Gateway/UI ports from the four final browser runs were free at
handoff. Existing primary-checkout processes were left alone.

## Publication integration proof

Reconciled the channel commit onto GitHub main `c0e89ee0f`, preserving newer
runtime/Chat changes and both upstream mobile visual baselines. Main's per-test
temporary-directory rule is applied to the two new disk-backed SQLite fixtures.

Fresh integrated proof passed: full workspace typecheck; channel parity
(452 Gateway tests); migration parity (252 SQLite/198 PostgreSQL migrations);
11 evidence/OAuth fixture tests; documentation checks; all-14 guided desktop/mobile
and Chat activation flows; and all 12 selected visual comparisons against main's
baselines. Integrated local browser receipts:

- Guided setup: `2026-10-09T05-23-32-302Z-channel-guided-setup-ef3edbd4`
- Visual regression: `2026-10-09T05-25-08-231Z-visual-regression-609b2c9e`

## External acceptance and delivery

Live Telegram/Discord/Slack sandbox acceptance is **pending**: approved/rejected
senders, linked replies, approvals, attachments, scheduled delivery, reconnect and
duplicates still need operator-designated accounts. Other real provider and bridge
delivery, including Microsoft tenant workflow receipt, was not exercised.
Loopback notification delivery, mocked provider receipts and browser setup tests
do not certify those external services. Installed app cutover and deployment were
not performed.
