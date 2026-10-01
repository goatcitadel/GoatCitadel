# Cockpit first-run evidence

Reviewed: 2026-10-01 UTC. This records completed source-checkout checkpoints. Native installed Windows, real keychain custody, and a clean published revision remain separate proof.

## October 1 UTC source checkpoint

`pnpm verify:install` produced `artifacts/verification/2026-10-01T03-35-03-455Z-install-smoke-5de00538/manifest.json`: **10/10 passed**, total duration **57,158 ms**, cold start through the first canonical verified answer **54,547 ms** against the **180,000 ms** target. It independently read session `sess_68eb01f292c55957bc0dd1d2` and turn `a547bc62-a155-426c-b574-3aa58b507d61`, recorded four loopback dispatches, and preserved settings.

This uses source Gateway and the development UI with an environment-backed synthetic credential. It does not measure human onboarding or time to first token, provision a real local model, or prove the installed-app/keychain path. Demo HTTP 207 retains its memory-feature skip. The screenshot review below belongs to `f2fd08f8`; it is not transferred to the newer run.

The standalone run passed before later source corrections. Its retained run-context lease caused seven following named checks to stop at preflight. The source now releases that exact lease after owned stack and provider cleanup; fresh install and following named checks must verify that correction on the latest source. The clean installed Windows profile test remains operator-deferred.

## Recorded September 30 named run

`pnpm verify:install` produced `artifacts/verification/2026-09-30T18-26-06-622Z-install-smoke-f2fd08f8/manifest.json`.

- Result: **10 passed, 0 failed, 0 skipped, 0 degraded, 0 not configured**.
- Total lane duration: **61,138 ms**.
- Cold source start through the first canonical verified Chat answer: **60,043 ms**, below the **180,000 ms** target.
- The elapsed measurement starts before stack startup and includes the preceding desktop and phone negative fixtures. It is not a measured human onboarding time or time to first token.
- Gateway workspace dependencies were refreshed; the UI ran through the Vite development server. The manifest does not pin a clean source commit or content fingerprint.

The fixture provisions a provider through Gateway bootstrap/setup APIs with an environment-backed synthetic credential and a deterministic loopback provider. It leaves the real onboarding marker incomplete before the browser journeys. OS keychain access and the maintenance scheduler are disabled in this isolated runtime.

## Native negative journeys

Both `install.ui.first-run-guards.desktop` (1280 × 900) and `install.ui.first-run-guards.mobile` (390 × 844) passed:

| Check | Actual evidence and boundary |
|---|---|
| Draft and exit cancellation | A changed approval-rule draft opened the leave dialog; Cancel dispatched no settings or completion write. |
| Stale completion preflight | Exactly one intercepted onboarding GET returned an explicitly modified settings revision. The UI withheld completion. This contradictory response is an injected fixture, not a claimed canonical owner revision. |
| Unconfirmed completion | Exactly one completion POST was intercepted and aborted **before forwarding**. This proves the client's unknown-response lock; it does not prove a committed lost response. |
| Navigation and remount | Exit and return within the same document retained the lock and disabled completion. Document reload count remained zero. |
| Preservation | Independent owner reads confirmed the actual incomplete marker, settings, and first-task status were unchanged. No provider inference occurred in these negative cases. |

The guard implementation is [cockpit-first-run-proof.mjs](../scripts/verification/lib/scenarios/cockpit-first-run-proof.mjs). It uses fresh browser contexts for the two widths, separate from the following successful journey.

## Successful source journey

`install.ui.first-answer` used a fresh browser context and the actual incomplete Gateway owner. It reviewed and kept the existing safe approval rule, completed the setup marker through the native cockpit, opened Chat, created a conversation, and sent a message. It then independently read both the onboarding owner and the exact Chat thread.

The checks bind the completed marker, unchanged settings, verified provider/model, session, turn, completed trace, routing provider, and actual assistant text. Four loopback provider completion dispatches were recorded during this scenario; the test does not claim exactly one provider call per user message.

| Owner field | Recorded value |
|---|---|
| Provider | `openai` |
| Model | `verification-stub-chat` |
| Session | `sess_fb47c24bc5c173b784891550` |
| Turn | `363649de-034a-4f83-85a4-7ac1e13281b7` |
| Independent canonical turn readback | Passed |
| Settings preserved | Passed |

The setup page was reopened after completion, and Step 3 displayed the Gateway's verified first-response state. Assertions and timing are owned by [verify-install.mjs](../scripts/verify-install.mjs).

## Screenshot review

All five retained images under the run's `screenshots/` directory were inspected:

- `install-first-run-desktop-cancel-review.png` and `install-first-run-mobile-cancel-review.png`: leave-dialog text and actions fit their viewports, with no observed horizontal clipping. The helper also checked dialog/action bounds and document overflow.
- `install-first-run-desktop-unknown.png` and `install-first-run-mobile-unknown.png`: setup controls fit; the warning is below the desktop crop and only partly visible at the bottom of the phone crop. These images alone do not fully show the warning. The browser assertions separately confirmed the alert, disabled completion, and retained lock after remount.
- `install-source-first-answer.png`: all three steps show Done; the verified response explanation and Open Chat action are visible.

These are viewport/layout observations, not a light/dark theme matrix or a full accessibility certification. Both retained viewport sets visibly use the dark application theme.

## Advanced native source journey

The separate completed `artifacts/verification/2026-09-30T22-59-41-670Z-ux-budgets-dd9813ad` run passed `ux-budgets.cockpit-first-run-advanced.{desktop,mobile}` (2/2; whole selected run 4/4). It used the compiled cockpit and matching disposable Gateway.

- The fixture establishes token auth with loopback bypass off through the actual governed auth owner, exact canonical approval and revision/nonce-bound continuation. It reuses an existing synthetic fixture token; no credential is replaced. Restoration uses the same owner flow.
- Native defaults preserve numeric settings CAS and the incomplete setup marker. Cancel makes zero writes, a contradictory owner revision withholds confirmation, and a request aborted before Gateway forwarding retains an uncertainty lock through native and same-document classic navigation.
- Actual demo preparation returns `ready`; its workspace, project, conversation and child records are independently read. Opening the recorded demo is navigation plus a precisely bound read-only routing inspection. It dispatches no Chat inference, tool execution or browser approval decision.
- Demo readiness, the installation completion marker and first-answer evidence remain separate. Owner-generated observation timestamps and task array ordering are compared according to their real contracts; all persisted identity and content fields remain checked.
- Desktop dark defaults review and phone light uncertainty screenshots were inspected. The dialog and controls fit their viewports. This supplements the timed source checkpoint above; it does not measure installed first-run time or certify the entire theme matrix.

## Remaining proof boundaries

- Provider provisioning through the native credential editor was **not** part of this timed journey; the provider was seeded through real setup APIs.
- Live external provider inference, actual local-model startup, OS keychain custody, and native installer behavior were **not** exercised.
- The safe demo scenario returned HTTP 207 and explicitly skipped memory seeding because its feature flag was disabled. That does not establish memory setup parity.
- The user deferred the clean installed Windows profile test. That acceptance gate remains unproven; this source result does not close it.
- Future source changes require matching verification. This passing checkpoint does not by itself authorize a default-shell cutover or establish the other release gates.

- Localized built Llama setup passed 2/2 in `2026-10-01T05-25-36-433Z-ux-budgets-6b9306d2`, with exact approval inspection, explicit same-document UI return and retained inputs. Its plan-only fixture made zero approval writes and started no model process or Chat diagnostic; it supplies no installed first-run, keychain or real local-inference proof.

## October 1 UTC: final remainder browser checkpoint

The final coherent three-stage browser queue completed successfully: [composer/rendering/project](../artifacts/verification/2026-10-01T15-05-24-967Z-ux-budgets-978712f1/manifest.json) **6/6**, [all 58 owner selectors](../artifacts/verification/2026-10-01T15-07-15-640Z-ux-budgets-094dc9e6/manifest.json) **119/119**, and the seven dedicated Chat wrappers **14/14**, with zero failed, skipped, degraded or not-configured scenarios. Composer and owner checks use built Gateway and production UI preview; the dedicated wrappers use source Gateway and Vite development UI. Their deterministic/loopback fixtures do not certify installed Windows, keychain custody, hardware inference or arbitrary external providers. Earlier failed and mixed manifests remain unchanged.

The current owner run's actual local-background journeys record desktop: 4 control POSTs, 3 applied controls, 1 real precommit 409s and 0 locally withheld stale reviews; phone: 4 control POSTs, 3 applied controls, 1 real precommit 409s and 0 locally withheld stale reviews. Both retain a real lease advance, zero review-cancel writes, one child stream and canonical cancellation/executor closure. The 105-record list pair records desktop: 13 unique status IDs within its bound of 73; phone: 1 unique status IDs within its bound of 1, and zero domain mutations. These current counts are distinct from earlier snapshots.

Classic remains default and cockpit is opt-in. The clean installed Windows profile test remains operator-deferred. Strict visual coverage still needs 200 approved Linux cockpit images; the 416 existing Classic files are not fresh comparisons. Linux is unavailable. Fresh remote Chat placement remains disabled under the current live-capability contract. This isolated checkout is uncommitted and unpublished. Complete uninstrumented Fast plus the sixteen other named lanes is the separate final repository gate.

The final browser queue preserves the advanced defaults/demo/verification source journey and its separate completion marker, demo readiness and first-answer evidence. The subsequent named install run must independently remeasure source first-answer time and verify exact run-context lease release. The deferred clean installed Windows profile is not replaced by any source, preview or provisioner result.

## October 1 UTC: completed local closure

The final source is applied in the isolated cockpit worktree and matches the verified candidate across 7,847 paths before these documentation updates. The work remains uncommitted/unpublished. [The progress ledger](MISSION_CONTROL_COCKPIT_PROGRESS.md) records the completed original sweep, passing corrective runs, preserved failures and exact proof boundaries. Classic remains default; Linux visual baselines and the operator-deferred clean installed Windows profile retain their release holds.

The final [named source install lane](../artifacts/verification/2026-10-01T19-08-45-265Z-install-smoke-a7bbb448/manifest.json) passes **10/10** after the Settings split and exact run-context lease cleanup. Cold source startup through the first canonical verified answer takes **64,812 ms** against **180,000 ms**. The actual session `sess_914d2b5647246e69e0dfb4d0` and turn `6939603b-e652-440f-88f4-d50f229e8dd5` are independently read; 4 deterministic loopback provider dispatches are recorded and settings remain unchanged. The following named checks do not stop on a retained run-context lease.

This source fixture provisions the provider through Gateway setup APIs, not the native credential editor. Desktop/phone negative review, stale-read, pre-forward abort and retained uncertainty cases preserve their boundaries. Demo HTTP 207 still reports the memory-feature skip. The final source first-answer screenshot was inspected: three Done steps, the verified-answer explanation and Open Chat action are visible. The earlier 18:15 screenshot and 46,329 ms result remain a separate checkpoint. Neither source result replaces the operator-deferred clean installed Windows profile, keychain custody, hardware inference or a published revision.
