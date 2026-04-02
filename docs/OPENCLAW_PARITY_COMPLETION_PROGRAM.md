# OpenClaw Parity Completion Program

Last updated: 2026-04-02
Scope: repo code, `GoatCitadel-mobile` runtime proof, manual operator proof lanes, and release/publication tasks required to truthfully close the parity roadmap

## Why This Exists

- `docs/OPENCLAW_PARITY_STATUS.md` records what has already landed.
- `docs/FOLLOW_ON_PARITY_REGISTER.md` records the follow-on foundations and safe claims.
- This document is the closeout program for everything still unfinished.
- The live OpenClaw parity report now classifies open work as repo-runtime, manual/operator-proof, external-repo, or publication blockers so closeout ownership stays explicit.

Until the external OpenClaw research matrix is refreshed in-repo, these three docs together are the operative parity contract for GoatCitadel.

## Already Complete

- `GC-P0-01` Shared channel runtime semantics
- `GC-P0-05` Channel action API completeness

## Unfinished Epic Checklist

### `GC-P0-02` Stabilize core beta channels

Current gap:
- It is still not safe to claim full inbound/outbound stabilization for Discord, Slack, Telegram, Google Chat, or Teams.

Completion checklist:
- Close the remaining runtime-hardening and inbound-normalization gaps for the current beta channels.
- Ensure guided setup, diagnostics, catalog maturity, and Mission Control discoverability all match real behavior.
- Add or tighten channel-by-channel smoke coverage for the final supported behavior of each beta channel.
- Re-run operator proof for the beta channels after the final runtime-hardening tranche.

### `GC-P0-03` Ship Tier-1 planned channels

Current gap:
- WhatsApp, iMessage/BlueBubbles, and Signal are still not parity-complete.

Completion checklist:
- Finish the connection model, diagnostics, and setup path for each Tier-1 channel.
- Complete the supported inbound/outbound capability set for each provider instead of leaving them as outbound-only bridges.
- Add runtime tests and channel smoke coverage for each Tier-1 channel before maturity is promoted.
- Update public setup/docs and catalog truth only after operator proof exists.

### `GC-P1-04` Ship Tier-2 planned channels

Current gap:
- Mattermost, LINE, Zalo OA, and Zalo Personal remain follow-on implementation work.

Completion checklist:
- Reuse the Tier-1 completion bar: setup, diagnostics, runtime behavior, tests, and operator proof.
- Treat existing outbound seams as starting points, not as finished parity.
- Keep catalog maturity truthful during rollout.
- Do not claim Tier-2 completion until runtime coverage and operator proof exist for every shipped channel.

### `GC-P0-06` Browser control parity

Current gap:
- Browser foundations exist and current April 2, 2026 operator-evidence bundles now cover `local_dev`, `trusted_local`, and `remote_hardened`, but parity still depends on keeping those bundles current and widening them beyond the local fixture lane when browser work becomes release-critical.

Completion checklist:
- Keep the System-generated browser proof lane current for `local_dev`, `trusted_local`, and `remote_hardened`.
- Preserve read, mutate, screenshot, guardrail, and error-path evidence from the live runtime whenever browser policy changes.
- Fix any deployment-profile or state-tool mismatches discovered by those reruns.
- Add a replayable higher-signal proof target if browser control becomes release-critical.

Proof artifact:
- `docs/testing/BROWSER_CONTROL_VALIDATION_CHECKLIST.md`
- `templates/verification/browser-control-proof-bundle.md`

### `GC-P0-07` Canvas / A2UI parity

Current gap:
- The gateway/session layer is proven, but the platform-side Android runtime proof bundle is still missing.

Completion checklist:
- Run the Mission-Control-first A2UI proof lane from System and export the proof artifact.
- Use the existing mobile Canvas/parity surface to execute the same contract from the Android side.
- Record the first Android/emulator proof bundle for the Office Lab handoff plus directed move lane.
- Harden any UI/runtime mismatches discovered by that run before broadening the contract surface.

Proof artifact:
- `docs/testing/A2UI_VALIDATION_CHECKLIST.md`
- `templates/verification/a2ui-proof-bundle.md`

### `GC-P1-08` Companion apps / nodes / device surfaces

Current gap:
- Gateway/session integrity is proven, but the Android runtime/UI lane is still not proven end to end.
- The current `GoatCitadel-mobile` repo can lint and build an Android APK locally, but the first runtime proof bundle is still blocked until a real Android device or emulator is available for operator execution.

Completion checklist:
- Use `companion.android.v1` plus the exported companion bootstrap brief as the execution handoff.
- Record the first Android/emulator proof bundle for approved-device exchange, signed mutations, SSE replay/resume, and refresh rotation.
- Fix any mobile-runtime or UI-state defects that fall out of that proof run.
- Re-run the proof until the Android lane is current and reproducible.

Proof artifact:
- `docs/COMPANION_CONTRACT.md`
- mobile repo proof bundle produced from `GoatCitadel-mobile`

### `GC-P1-09` Packaging and remote deployment parity

Current gap:
- The checklist, template, and current April 2, 2026 `trusted_local` plus `remote_hardened` operator-evidence bundles now exist, but parity still depends on repeatable clean-install, packaged-startup, and rollback evidence across target environments.

Completion checklist:
- Keep the System-generated packaging proof lane current for the active deployment profile.
- Collect repeatable clean-install, packaged-startup, `remote_hardened`, and rollback evidence on target environments instead of only on the developer workstation.
- Refresh stale or profile-mismatched proof artifacts before relying on them.
- Re-run the lane whenever deployment posture changes.

Proof artifact:
- `docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md`
- `templates/verification/packaging-deployment-proof-bundle.md`

### `GC-P1-10` Long-tail parity register

Current gap:
- The repo has shared truth now, but future parity tranches can still drift if the contract, report, and docs are not updated together.

Completion checklist:
- Keep the parity status doc, follow-on register, and this completion program aligned in every parity tranche.
- Update the shared contracts before changing the report or docs.
- Update the live report and System-page copy in the same tranche as any parity move.
- Keep blocker classification aligned too, so repo-runtime work does not get mislabeled as manual-only and external/publication blockers do not get hidden inside repo backlog language.
- Do not let proof-lane truth fork into UI-only or doc-only metadata again.

### `GC-P2-11` Extension / plugin SDK breadth

Current gap:
- The local workspace SDK exists, but there is still no published SDK package or broader runtime contract.
- The repo-local reference integration-plugin lifecycle is now proven through live install/enable runs, but public publication is still blocked until GitHub Packages/npm auth is configured on the publishing machine.

Completion checklist:
- Publish `@goatcitadel/extensions-sdk`.
- Keep the reference integration-plugin lifecycle smoke-tested after publication.
- Make the runtime-contract boundary explicit: widen `packages/contracts` only where third-party runtime behavior must be stable.
- Update the parity report/docs so they distinguish “published SDK complete” from any still-open runtime-contract work.

### `GC-P2-12` Voice Wake / Talk Mode parity

Current gap:
- The current voice lane is local-first and operational, but not yet mature parity.

Completion checklist:
- Run the System-generated voice proof lane and export the current proof artifact.
- Use the embedded recovery actions to harden runtime repair, model repair, stale talk cleanup, and wake cleanup.
- Re-test blocked starts, recovery behavior, and steady-state operation after each hardening tranche.
- Repeat until the voice artifact is current and the lane is no longer relying on hand-waved recovery assumptions.

Proof artifact:
- `docs/testing/VOICE_VALIDATION_CHECKLIST.md`
- `templates/verification/voice-proof-bundle.md`

## Completion Order

This is the full-program closeout order. It is intentionally broader than the follow-on-only order in `docs/FOLLOW_ON_PARITY_REGISTER.md`.

1. `GC-P1-10` Long-tail parity register
2. `GC-P2-12` Voice Wake / Talk Mode parity
3. `GC-P0-06` Browser control parity
4. `GC-P1-09` Packaging and remote deployment parity
5. `GC-P1-08` Companion apps / nodes / device surfaces
6. `GC-P0-07` Canvas / A2UI parity
7. `GC-P0-02` Stabilize core beta channels
8. `GC-P0-03` Ship Tier-1 planned channels
9. `GC-P1-04` Ship Tier-2 planned channels
10. `GC-P2-11` Extension / plugin SDK breadth

## Done Means

Parity is only finished when all of these are true:

- Every open epic above is marked complete in `docs/OPENCLAW_PARITY_STATUS.md`.
- The “not safe to claim yet” list no longer contains an open item unless it is explicitly de-scoped.
- Every proof-driven lane has a current artifact, not just code or docs.
- Mission Control, gateway reports, setup/docs, catalog maturity, and tests all agree on the final state.
- `GoatCitadel-mobile` has produced the required Android/emulator proof for companion and platform-side A2UI work.
- `@goatcitadel/extensions-sdk` is published and its public boundary is explicit.

## Assumptions

- This program is for full closeout, not repo-only cleanup.
- Manual/operator proof is required for completion; code-complete without proof does not count.
- TUI/Mission Control surface mirroring is already sufficient; the remaining blockers are parity breadth, hardening, proof, and publication.
