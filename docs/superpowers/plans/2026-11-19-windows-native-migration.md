# Windows Native Migration Implementation Plan

## Goal

Move small parts of GoatCitadel into the Windows host in independently verifiable releases. Start by shipping the process-ownership helper already exercised in the benchmark. Make a WinUI startup draft box the first native Chat feature.

## Architecture and stack

WinUI 3 and .NET own the desktop window, startup UI, and Windows integration. The existing Rust helper provides Windows process creation identity. WebView2 hosts the Cockpit. The Gateway owns authentication, Chat sends, policy, approvals, and persistence. Native UI uses the same Chat and Gateway contracts as the web surface.

The product and design references are [PRODUCT.md](../../../PRODUCT.md), [DESIGN.md](../../../DESIGN.md), and the [1.0 contract](../../1_0_CONTRACT.md).

## Starting evidence

The installed x64 `0.9.2-beta.2` uses PowerShell for process ownership checks. The native helper is already in workspace source. The archived x64 beta benchmark recorded 973 ms with PowerShell and 126 ms with the native helper for cold ownership checks after Gateway readiness. The latest archived-beta run measured 2.72 s of Gateway module loading, 5.08 s to Gateway readiness, 5.54 s to WebView2 page load, and 6.54 s to a confirmed Chat keystroke. Use these as reference measurements and establish a fresh baseline on the installed version.

## Rollout constraints

- Use exact process creation identity and existing ownership validation for every launch, stop, and restart operation. Select one lifecycle owner per launch before acquiring the runtime lock.
- Use the existing profile boundaries and Gateway authorization. Draft text, credentials, and credential receipts belong to their current owners. New startup milestones record timing and bounded result classes.
- Stage each candidate on a disposable profile first. Select the prior path at launch or reinstall the verified same-release legacy payload to roll back a pilot. Test upgrade and restart with a populated disposable profile to prove profile continuity.
- Use x64 for the first installed-beta comparison and verify the matching build and installed path for each architecture the release carries.

## Review focus

| Scenario | Owning test or milestone |
| --- | --- |
| Stale PID file, reused PID, or healthy foreign listener | Existing ownership tests plus the packaged run in milestone 1 |
| Launcher retry, profile switch, or navigation while a draft is pending | `StartupDraftHandoffTests` in milestone 2 |
| Existing web draft or duplicate acknowledgement | Cockpit startup draft bridge tests in milestone 2 |
| Empty credential, missing entry, or unavailable vault | Windows read parity in milestone 3 |
| Concurrent launches or updater restart during failed startup | Process supervisor proof in milestone 4 |

## Milestone 0. Establish the startup baseline

**Owners** `DesktopStartupDiagnostics.cs`, the Gateway startup phase recorder, and the installed-beta benchmark harness.

- [ ] Capture build version, source commit, architecture, and database mode. Give each launch a correlation ID. Reuse `DesktopStartupDiagnostics.RecordPhase` and the Gateway phase recorder. Add monotonic elapsed time for any new host milestones. Record lifecycle transport and phase results as bounded values.
- [ ] Run six launches per build and condition with alternating build order. Cold starts fresh Gateway and UI processes against a seeded disposable profile. Warm reopens the desktop window with the verified runtime running. Use the same package bases and profile settings within each comparison. Measure first launch after install separately.
- [ ] Save raw samples, medians, and paired differences for desktop window activation, Gateway ready, WebView2 page load, and a real key accepted and cleared in Chat. Record native draft input and Send availability as separate milestones when the draft pilot is active. Observe Send availability with an unsent test draft. Resolve fixture ownership or process reuse mismatches before recording comparable samples.

## Milestone 1. Ship the existing process-ownership helper

**Owners** `apps/mission-control-windows/Native/process_identity.rs`, `scripts/packaging/lib/build-windows-process-identity.mjs`, `scripts/packaging/build-windows-host.mjs`, and `scripts/lib/managed-runtime-lifecycle.mjs`.

- [ ] Add a candidate package check in `scripts/packaging/build-windows-host.test.mjs` for `app/desktop/GoatCitadel-Process-Identity.exe` and its package inventory entry. Exercise the real bundled Node launcher from the installed layout so the proof includes helper discovery.
- [ ] Keep the existing `queryWindowsProcessCreationIdentity(pid, options)` result contract. Compare kernel creation time with the legacy lookup for a live process. Exercise exited processes, stale PID data, PID reuse, and unrelated healthy listeners. Verify that native `missing` results retain the refusal outcome and that native `unavailable` results use the existing validated fallback.
- [ ] Run `node --test scripts/lib/managed-runtime-identity.test.mjs scripts/lib/managed-runtime-ownership.test.mjs scripts/lib/managed-runtime-lifecycle.test.mjs` and `pnpm verify:desktop`. Run the shared installer smoke against the x64 candidate in a clean Windows VM. Record which executable performed ownership checks and the time those checks took in the cold and warm benchmark. [Windows packaging and smoke procedures](../../PACKAGING.md)
- [ ] Test a packaged upgrade and restart with a populated disposable profile. Compare against an otherwise identical same-release legacy payload and retain that verified package for rollback. Promote the native candidate after installed smoke, ownership parity, and timing review.

## Milestone 2. Pilot the native Chat draft box

**Owners** `apps/mission-control-windows/MainWindow.xaml`, `apps/mission-control-windows/MainWindow.xaml.cs`, `apps/mission-control-windows/Services/NavigationPolicy.cs`, and `apps/mission-control-next/src/cockpit/areas/chat/ChatTextComposer.tsx`. Add `Services/StartupDraftHandoff.cs` and `Tests/StartupDraftHandoffTests.cs` under `apps/mission-control-windows` and a `startup-draft-bridge.ts` sibling of the web composer.

- [ ] Review a mockup in the existing WinUI startup panel. Add a launch-time pilot setting and a keyboard-accessible draft field whose buffer lives for the current window. Keep the draft accessible through a native action if the startup panel closes during a conflict. Show the destination before an explicit insert into an existing conversation.
- [ ] Use version `1` of the `goatcitadel.startup-draft` exchange over the WebView2 message API. The web `ready` message identifies the top-level document and Chat context. The host `offer` adds an offer ID and text. The web `ack` returns those identifiers and `applied` or `held`. Derive profile identity from the active host and validate the exact approved scheme, host, and port in both directions. Recheck the document and Chat context at offer and acknowledgement. Route insertion through `onDraftChange`. Clear the buffer on an `applied` acknowledgement, explicit discard, or profile change. Chat's existing send action owns submission. [Microsoft WebView2 security guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security)
- [ ] Test automatic handoff into a ready, empty new Chat. An existing draft calls for an explicit insert decision. A stale document or mismatched origin keeps the draft in the host. A duplicate offer carries the same acknowledgement after one insertion. Test retry and navigation with pending text. Verify focus, keyboard-only operation, screen reader labels, IME input, and paste in the packaged window. Run `pnpm verify:desktop` and focused Cockpit tests.
- [ ] Show with a real keystroke that the native field works during Gateway startup. Compare time to first typing, time to web composer handoff, and Send availability across cold and warm launches. Use the pilot setting to exercise recovery on the same profile.

## Milestone 3. Move Windows credential reads to WinRT

**Owners** `apps/gateway/src/services/secret-store-service.ts` and `apps/gateway/src/services/secret-store-service.test.ts`. Credential write receipts are owned by `apps/gateway/src/services/windows-credential-write-receipt.ts`.

- [ ] Limit the first adapter to `getSecretAsync(account)` on Windows. Use `PasswordVault` from a compiled helper called by the Gateway, which can run independently of the desktop. Use the canonical resource and account lookup, bounded redirected process pipes, and distinct found, missing, and unavailable results. Select compatibility fallback for unavailable reads. [Microsoft Credential Locker documentation](https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker)
- [ ] Compare the two read paths with disposable vault entries. Test profile isolation, Unicode, empty and missing entries, a helper timeout, and redacted diagnostics. Record credential lookup duration and its overlap with Gateway build and listen in the startup trace. Require a separate receipt-parity pass before migrating writes or deletes.

## Milestone 4. Move Windows launch supervision in small steps

**Owners** `apps/mission-control-windows/Services/LauncherService.cs`, `apps/mission-control-windows/Services/RuntimeStatusService.cs`, `bin/goatcitadel.mjs`, and the managed runtime lifecycle modules.

- [ ] First compare read-only native status with the existing launcher. Check owned runtime, foreign port, startup timeout, and status after exit. Return the existing `DesktopRuntimeStatus` shape and reuse its readiness and authorization evidence.
- [ ] After status parity, route start and stop through one compiled Windows supervisor behind the existing launcher contract. Select its ownership before the runtime lock. Test concurrent desktop and CLI launches, cancellation, crash recovery, tray reopen, startup failure, and installer exit and restart. Run `pnpm verify:desktop` and the installed-beta cold and warm comparison.
- [ ] Use the new trace to choose the next conversion. Prototype direct desktop asset hosting if the Node UI server still accounts for meaningful handoff time. Validate the approved UI origin, bootstrap values, Gateway authentication and CORS, browser security headers, and deep links. Treat the updater's PowerShell handoff as a separate reliability slice that uses verified installer and process ownership checks. [WebView2 local content options](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content)
