# Follow-On Parity Register

Last updated: 2026-04-02
Scope: follow-on OpenClaw parity epics after core channel stabilization

## Purpose

This register turns the follow-on parity section from `OPENCLAW_PARITY_STATUS.md` into a concrete, truth-based backlog.

For the full closeout program across planned channels, proof lanes, mobile runtime proof, and publication work, also use `docs/OPENCLAW_PARITY_COMPLETION_PROGRAM.md`.

Use it to answer four questions for each epic:

1. What foundation already exists in the repo?
2. What is safe to claim now?
3. What is still missing?
4. What is the next smallest tranche that would move the epic forward safely?

## Status Legend

- `Have foundation`: meaningful repo-native contracts, routes, UI, or docs exist already.
- `Partial`: foundations exist, but parity claims would still overstate reality.
- `Missing`: docs/research only, or placeholder catalog entries without implementation.

## Epic Register

| Epic | Current state | Repo evidence | Main remaining gap | Recommended next slice |
|---|---|---|---|---|
| `GC-P0-06` Browser control parity | Partial | Browser tool registry/security families and execution runtime exist in `packages/policy-engine/src/tool-registry.ts`, `packages/policy-engine/src/tool-security.ts`, `packages/policy-engine/src/browser-tools.ts`, `docs/testing/BROWSER_CONTROL_VALIDATION_CHECKLIST.md`, `templates/verification/browser-control-proof-bundle.md`, and `apps/mission-control/src/pages/SystemPage.tsx`. Current April 2, 2026 operator-evidence bundles now also exist under `workspace/artifacts/follow-on-parity/browser/2026-04-02/` for `local_dev`, `trusted_local`, and `remote_hardened`. | The lane is no longer missing profile-specific proof exports; the remaining gap is keeping those bundles fresh and widening them beyond the local fixture lane if browser work becomes release-critical. The live report now also resolves browser cookie/storage state-tool access from the actual deployment-profile guardrail instead of implying a broader runtime than the route layer allows. | Keep the System-page browser proof-lane draft plus operator bundles current for each profile, then add a replayable higher-signal scenario if browser control becomes release-critical. |
| `GC-P0-07` Canvas / A2UI parity | Partial | A first-class `a2ui.v1` contract now exists in `packages/contracts/src/a2ui.ts`, the live parity report resolves it in `apps/gateway/src/services/follow-on-parity-report.ts`, the current operator definition is documented in `docs/A2UI_CONTRACT.md`, and System can now generate and export a Mission-Control-first A2UI proof artifact. Mission Control still has the concrete canvas-heavy surface in `apps/mission-control/src/components/PixelOfficeCanvas.tsx`, the current proof target is the Office Lab handoff plus directed seat/tile move, and the current mobile repo now has a companion-backed Canvas operator surface for the same lane. | The platform side still lacks an Android runtime proof bundle for the canvas contract even though the gateway/session layer is now proven. | Use the exported System-page A2UI proof artifact plus the mobile Canvas surface as the repeatable operator path for the Office Lab handoff and directed-move proof, then record the first Android/emulator proof bundle before broadening the contract surface further. |
| `GC-P1-09` Packaging and remote deployment parity | Partial | Installer/deployment docs and deployment-profile guards already exist in `docs/INSTALL_SETUP_TESTING.md`, `docs/PUBLIC_SHARE_CHECKLIST.md`, `docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md`, `templates/verification/packaging-deployment-proof-bundle.md`, `apps/gateway/src/deployment-profile-guard.ts`, and `apps/mission-control/src/pages/SystemPage.tsx`. The shared follow-on contract plus live report now also track whether the latest packaging proof artifact is missing, stale, or current and whether it still matches the active deployment profile. Current April 2, 2026 operator-evidence bundles now also exist under `workspace/artifacts/follow-on-parity/packaging/2026-04-02/` for `trusted_local` and `remote_hardened`. | The lane is no longer blocked on profile-specific proof exports alone; the remaining gap is repeatable clean-install, packaged-startup, and rollback evidence across target environments. | Keep the System-page packaging proof-lane draft plus operator bundles current, then rerun the checklist on a clean target environment and capture an explicit rollback pass. |
| `GC-P1-08` Companion apps / nodes / device surfaces | Partial | Android companion research/spec docs exist, device request/grant flows already ship in `apps/gateway/src/routes/auth.ts`, `apps/gateway/src/services/gateway-service.ts`, and Mission Control access/settings UI, `companion.android.v1` now has explicit shared auth/session types plus gateway routes for exchange/refresh/session info, signed companion mutation verification, replay protection, an Android bootstrap template under `templates/companion/goatcitadel-android/`, a System export path for a companion bootstrap brief, and an existing separate mobile repo/runtime in `GoatCitadel-mobile`. A March 31, 2026 local live-gateway proof now exists for approved-device bearer exchange into a signed companion session, signed companion mutations, SSE replay/resume, and refresh rotation against a non-loopback local address. The current mobile repo now also has companion-session bootstrap/storage, signed mutation headers, a foreground SSE-with-resume event lane wired against the shared contract, and operator-facing Canvas/Parity surfaces. | The current mobile repo is still not proven from the Android runtime/UI end to end; the remaining gap is no longer gateway/session integrity but the first Android/emulator proof bundle and operator validation path. | Use `companion.android.v1` plus the exported companion bootstrap brief and new mobile parity surfaces to record the first Android/emulator proof bundle, then harden the UI/runtime edges that fall out of that run. |
| `GC-P1-10` Long-tail parity register | Have foundation | This register now exists in `docs/FOLLOW_ON_PARITY_REGISTER.md`, the live runtime-backed parity report plus System-page surface ship in `apps/gateway/src/services/follow-on-parity-report.ts`, `apps/gateway/src/routes/dashboard.ts`, and `apps/mission-control/src/pages/SystemPage.tsx`, and checklist/template truth for the browser, packaging, A2UI, and voice proof lanes now resolves from a shared contract plus direct service-level coverage. | The remaining work is no longer just remembering to keep things aligned; future follow-on tranches still need to update the shared proof-lane truth and the roadmap docs together instead of introducing a second drifting source. | Keep this register, the shared proof-lane contract, and the live report aligned whenever a follow-on parity tranche moves, so roadmap truth stays repo-native instead of slipping back into doc drift. |
| `GC-P2-11` Extension / plugin SDK breadth | Partial | Add-on catalog/install lifecycle, integration plugin routes, skill import/bundle handling, a documented author contract, a local workspace author SDK package, a schema-validated reference add-on scaffold, a local installable reference integration-plugin scaffold, a repo-native extension starter-pack export path, and a System generate/export path for an extension SDK brief now exist in `apps/gateway/src/routes/addons.ts`, `apps/gateway/src/routes/integrations.ts`, `apps/gateway/src/routes/dashboard.ts`, `apps/gateway/src/services/integration-plugin-author-contract.ts`, `apps/gateway/src/services/integration-plugin-author-contract.test.ts`, `apps/gateway/src/services/extension-sdk-brief.ts`, `apps/gateway/src/services/extension-starter-pack.ts`, `packages/contracts/src/addons.ts`, `packages/contracts/src/follow-on-parity.ts`, `packages/extensions-sdk/`, `apps/gateway/src/services/follow-on-parity-report.ts`, `apps/mission-control/src/pages/SystemPage.tsx`, `templates/addons/reference-separate-repo-addon/`, `templates/integration-plugins/reference-integration-plugin/`, and `docs/PLUGIN_SDK_CONTRACT.md`. The live report now also resolves whether the local reference integration plugin is installed, enabled, and still sourced from the repo scaffold. | There is still no published SDK package or broader runtime contract beyond lifecycle metadata. | Keep the reference integration-plugin lifecycle smoke-tested, use the local workspace SDK plus the generated/exported extension SDK brief and starter pack when authoring decisions need to be handed off, then decide whether the next public step is publishing the SDK, broadening the runtime contract, or both. |
| `GC-P2-12` Voice Wake / Talk Mode parity | Partial | Voice contracts, runtime install/status, gateway routes, doctor checks, CLI, and Mission Control UI already exist in `packages/contracts/src/voice.ts`, `apps/gateway/src/routes/voice.ts`, `apps/gateway/src/voice-runtime/*`, and `apps/mission-control/src/pages/SettingsPage.tsx`, and the gateway/System surface now expose a dedicated voice proof-lane draft plus exportable proof artifact path with repo-native checklist/template coverage in `docs/testing/VOICE_VALIDATION_CHECKLIST.md` and `templates/verification/voice-proof-bundle.md`. Settings now also derives explicit operator recovery actions for runtime repair, missing-model recovery, stale talk cleanup, and wake cleanup, exported voice drafts carry those recovery notes directly, and gateway Talk/Wake starts now refuse to begin when the managed runtime is not ready, no model is selected, or the control is already active. | Existing voice support is local-first and operational, but not yet broad parity with a mature wake/talk product surface. | Run the voice proof lane consistently, export the real voice proof bundle from System, then use the embedded recovery actions plus the new blocked-start runtime state to harden runtime, model, talk-session, and wake-state recovery behavior. |

## Safe Claims Today

### Cross-cutting visibility

- Mission Control and the gateway now have a live follow-on parity report for browser, canvas/A2UI, deployment, companion/device, plugin breadth, and voice.
- That report now includes operator-facing blockers and recommended next actions for browser, packaging, canvas, companion, extension breadth, and voice.
- Follow-on status is no longer discoverable only by reading code and this markdown register together.
- Browser, packaging, A2UI, and voice proof lanes now share checklist/template truth through the contracts layer, and gateway service tests lock the live report plus exported drafts to that same source.

### Browser

- GoatCitadel already has a first-class browser tool family, not just placeholder names.
- Browser session state includes cookies, storage, and context configuration.
- Browser access is already policy-aware and split between read and control families.
- The live parity report now distinguishes current browser guardrail posture from the remaining validation work.
- The live parity report and exported browser proof lane now enumerate which registered cookie/storage state tools are allowed versus blocked in the current deployment profile, so `local_dev`, `trusted_local`, and `remote_hardened` no longer share hand-waved browser-state claims.
- A current April 2, 2026 operator-evidence set now exists for browser in `local_dev`, `trusted_local`, and `remote_hardened`, including successful `trusted_local` cookie/storage proof and explicit `remote_hardened` blocked-state proof.
- A dedicated browser validation checklist and proof-bundle template now exist for read, mutate, screenshot, guardrail, and error-path proof.
- System can now generate a browser proof-lane draft from live runtime state before operators execute the checklist.
- System can now export the current browser proof lane as a workspace artifact instead of leaving it as page-only state.

### Canvas / A2UI

- Mission Control already uses canvas-based presentation surfaces.
- Platform catalog placeholders already acknowledge native canvas/camera/screen capability tracks.
- A first-class `a2ui.v1` contract now exists for separating Mission Control canvas scope from companion-platform canvas scope.
- System can now generate and export an A2UI proof artifact from live runtime state before operators collect the bundle.
- The current mobile repo now has a companion-backed Canvas operator surface and a parity console that expose the same live follow-on lane from the mobile side.

### Packaging / Deployment

- Installer-first docs exist.
- Remote deployment posture already has explicit profiles and startup guards.
- Public-share/release checklists exist, even if they are not yet framed as parity work.
- The live parity report now surfaces current deployment/auth posture plus the next packaging proof steps.
- The live parity report now also records whether the latest packaging proof bundle is missing, stale, or current and whether it still matches the active deployment profile.
- A current April 2, 2026 operator-evidence set now exists for packaging in `trusted_local` and `remote_hardened`, so the lane now has posture proof beyond the older `local_dev` export.
- The live parity report now also records whether the latest browser, A2UI, and voice proof bundles are missing, stale, or current and whether they still match the active deployment profile.
- The live parity report now also records whether the latest companion bootstrap brief and extension SDK brief are missing, stale, or current.
- A dedicated packaging/deployment parity checklist now exists for clean install, auth posture, remote_hardened proof, and rollback evidence.
- A reusable packaging proof bundle template now exists under `templates/verification/packaging-deployment-proof-bundle.md`.
- System can now generate a packaging proof-lane draft from live runtime state before operators collect the bundle.
- System can now export the current packaging proof lane as a workspace artifact instead of leaving it as page-only state.

### Companion / Device

- Device approval and grant flows already exist for new devices.
- Mission Control can request approval from another authenticated device.
- Android companion work now has gateway server foundation plus a separate-repo bootstrap direction.
- The live parity report now makes it explicit that declared companion targets have server-foundation auth/session support while the existing mobile runtime still lacks companion.android.v1 proof: `companion.android.v1` names the bootstrap lane, session posture, server prerequisites, and remaining runtime gap.
- System can now export a companion bootstrap brief so the Android-first separate-repo handoff is repeatable from live runtime truth.
- A March 31, 2026 local live-gateway run has now proven approved-device bearer exchange, signed companion mutations, SSE replay/resume, and refresh rotation on the companion session path without relying on loopback bypass.

### Extension / Plugin

- Add-ons are a real runtime surface with catalog, install, launch, stop, update, and uninstall routes.
- Integration plugins are already installable and enable/disable-able.
- Skills already support bundled, managed, workspace, extra, and remote-bundle import flows.
- The live parity report now separates operator breadth from the still-missing public author SDK contract.
- A documented author-contract baseline now exists in `docs/PLUGIN_SDK_CONTRACT.md`.
- A local workspace author SDK package now exists in `packages/extensions-sdk/`.
- A schema-validated reference add-on scaffold now exists in `templates/addons/reference-separate-repo-addon/`.
- A local installable reference integration-plugin scaffold now exists in `templates/integration-plugins/reference-integration-plugin/`.
- System can now generate and export an extension SDK brief so the current contract boundary and next published-SDK/runtime-contract decision can be handed off from live runtime truth.
- System can now generate and export a repo-native extension starter pack that bundles the contract doc plus the current reference add-on and integration-plugin scaffolds.
- The live parity report now shows whether the local reference integration plugin is installed, enabled, and still aligned to the repo scaffold source instead of collapsing extension breadth into raw counts alone.

### Voice

- Voice is not a stub. It already has contracts, API routes, UI, CLI/runtime management, and doctor checks.
- Talk mode and wake mode are already distinct runtime concepts in the contracts and gateway.
- The live parity report now surfaces readiness, recent runtime failure context, and the next operator recovery steps.
- System can now generate a voice proof-lane draft so transcription, talk, and wake validation follow a repeatable operator path.
- System can now export the current voice proof lane as a workspace artifact instead of leaving the proof bundle as page-only state.
- Settings now exposes explicit recovery actions for the common local-first failure states instead of making operators infer the next repair step manually.
- Voice proof exports now include explicit recovery actions alongside the blocked/ready lane steps.
- Gateway Talk Mode and Wake Mode starts are now runtime-truthful: they refuse to start when the managed runtime is broken or missing, when no active model is selected, or when the control is already active, and Settings re-syncs live voice state after those blocked attempts.

## Not Safe To Claim Yet

- Full browser parity as an operator-polished product surface
- Full A2UI runtime parity
- End-to-end packaging/deployment parity across all target environments
- A shipped mobile companion or broader device-node ecosystem
- A stable public plugin SDK for third-party authors
- Full talk-mode / wake-mode parity beyond the local-first voice runtime lane

## De-Scope Register

These should remain explicitly de-scoped until a dedicated tranche is opened:

- Shipping a production Android companion inside this monorepo
- Claiming iOS parity from catalog placeholders alone
- Calling the current contract baseline a shipped A2UI runtime
- Calling add-on lifecycle routes a complete plugin SDK
- Claiming cloud-grade voice parity from the current local-first runtime

## Recommended Order

If follow-on parity work starts before Tier-1 and Tier-2 channel completion, the safest follow-on-only order is:

1. `GC-P1-10` Long-tail parity register maintenance
2. `GC-P2-12` Voice Wake / Talk Mode parity hardening
3. `GC-P0-06` Browser control parity hardening
4. `GC-P2-11` Extension / plugin SDK contract definition
5. `GC-P1-09` Packaging and remote deployment parity checklisting
6. `GC-P1-08` Companion app contract/bootstrap work
7. `GC-P0-07` Canvas / A2UI contract definition

## Exit Criteria For This Register

This register is doing its job when:

- every follow-on epic has a truthful current-state note
- no epic is described as "nothing yet" when meaningful foundations already exist
- de-scoped claims are explicit instead of implied
- the next tranche can pick a single follow-on epic without re-discovering the whole area
