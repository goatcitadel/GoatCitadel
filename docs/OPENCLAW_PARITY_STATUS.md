# OpenClaw Parity Status

Last updated: 2026-03-31
Scope: public-repo parity work against the external OpenClaw research matrix

## Source Of Truth

- Implementation priority remains the external OpenClaw parity matrix.
- This document records what GoatCitadel has actually landed in-repo so parity claims stay truthful.

## Current Tranche

This tranche completes the shared contract and public API foundation for:

- `GC-P0-01` Shared channel runtime semantics
- `GC-P0-05` Channel action API completeness

## Landed In This Tranche

### Shared channel-core

- Added a reusable channel capability model in `packages/contracts`:
  - `ChannelCapabilities`
  - `ChannelRuntimePolicy`
  - `ChannelPairingRecord`
  - `ChannelRuntimeStatus`
- Added `ChannelReplyInput`, `ChannelTypingInput`, and `ChannelTypingResult` so reply and typing are first-class contracts.
- Added `packages/gateway-core/src/channel-core.ts` to compute shared capability, setup, and runtime metadata for built-in channels.

### Gateway API completeness

- Preserved existing `send`, `react`, and `unsend` routes.
- Added explicit public routes for:
  - `POST /api/v1/comms/reply`
  - `POST /api/v1/comms/typing`
  - `GET /api/v1/comms/capabilities/:connectionId`
  - `GET /api/v1/comms/diagnostics/:connectionId`
- Added durable connector-delivery support for `channel.reply` and `channel.typing`.

### Runtime behavior and discoverability

- Generalized channel diagnostics to use the shared `channel-core` capability rules.
- Exposed capability metadata on connector records so Mission Control and gateway APIs use the same source.
- Exposed the guided channel-setup definition list through the gateway so Mission Control discovers guided coverage from backend truth instead of a UI-only allowlist.
- Replaced misleading planned-channel auto-promotion with truth-based catalog maturity:
  - built-in, not-yet-parity-complete channels resolve to `beta`
  - plugin-backed planned channels resolve to `plugin` only when installed

### Verification

- Added shared `channel-core` contract tests.
- Added gateway route tests for reply, typing, capabilities, and diagnostics.
- Added connector delivery and connector registry coverage for the new actions and metadata.
- Added Mission Control tests to confirm the UI prefers shared `channelCapabilities` metadata.

## Status By Epic

| Epic | Status | Notes |
|---|---|---|
| `GC-P0-01` Shared channel runtime semantics | Complete for contract/core foundation | Shared capability negotiation, runtime policy, setup diagnostics, and pairing/runtime metadata are landed. |
| `GC-P0-05` Channel action API completeness | Complete for public API foundation | Reply, typing, capabilities, and diagnostics are public and covered by tests. |
| `GC-P0-02` Stabilize core beta channels | In progress | Guided setup, discoverability, and operator onboarding now cover Discord, Slack, Telegram, Google Chat, and Teams. Guided smoke probes now span all current beta setup channels, Discord has focused runtime coverage for DM pairing/open/disabled flows, Slack now has signed Events API ingress, and Telegram now has secret-token webhook ingress plus reply-path parity and typing-indicator parity. |
| `GC-P0-03` Ship Tier-1 planned channels | Pending | WhatsApp, iMessage/BlueBubbles, and Signal still need full inbound/outbound parity work. |
| `GC-P1-04` Ship Tier-2 planned channels | Pending | Mattermost, LINE, Zalo OA, and Zalo Personal remain follow-on implementation work. |
| `GC-P0-06` Browser control parity | In progress | Browser tool registry, policy families, execution runtime, a live follow-on parity report, a dedicated browser validation checklist/proof template, and System-page browser proof-lane draft/export support now exist, but parity still depends on operators running that lane consistently. The live browser report/proof lane now also resolves cookie/storage state-tool access from the actual deployment-profile guardrail, so `local_dev` no longer overstates stateful browser support. See `docs/FOLLOW_ON_PARITY_REGISTER.md`, `docs/testing/BROWSER_CONTROL_VALIDATION_CHECKLIST.md`, and `templates/verification/browser-control-proof-bundle.md`. |
| `GC-P0-07` Canvas / A2UI parity | In progress | A first-class `a2ui.v1` contract now exists in `packages/contracts/src/a2ui.ts`, the live follow-on parity report resolves it, `docs/A2UI_CONTRACT.md` defines the current operator baseline, the System page can generate and export a Mission-Control-first A2UI proof artifact centered on the Office Lab handoff plus directed seat/tile move, and the current mobile repo now has a companion-backed Canvas operator surface plus a parity console for the same lane. Companion-session proof is now real at the live gateway/session layer, but Android runtime proof for the platform-side A2UI surface is still open. See `docs/FOLLOW_ON_PARITY_REGISTER.md`, `docs/testing/A2UI_VALIDATION_CHECKLIST.md`, and `templates/verification/a2ui-proof-bundle.md`. |
| `GC-P1-09` Packaging and remote deployment parity | In progress | Installer docs, deployment profiles, public-share/release hardening checklists, a dedicated packaging parity checklist, a reusable proof bundle template, and System-page packaging proof-lane draft/export support now exist. The live report now also marks the latest packaging proof bundle as missing, stale, or current and notes whether that bundle still matches the active deployment profile, but parity still depends on operators collecting clean install, remote_hardened, and rollback evidence consistently. See `docs/FOLLOW_ON_PARITY_REGISTER.md`, `docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md`, and `templates/verification/packaging-deployment-proof-bundle.md`. |
| `GC-P1-08` Companion apps / nodes / device surfaces | In progress | Android companion research plus device approval/grant plumbing exist, planned companion targets now show up in the live follow-on parity report, `companion.android.v1` defines the Android-first separate-repo bootstrap lane, the gateway now has companion session exchange/refresh/signing/replay foundation, an Android bootstrap template now exists, System can export a companion bootstrap brief, and an external `GoatCitadel-mobile` repo/runtime already exists. A March 31, 2026 local live-gateway proof now exists for approved-device bearer exchange into a signed companion session, signed companion mutations, SSE replay/resume, and refresh rotation against a non-loopback local address. The current mobile repo now also has companion-session bootstrap/storage, signed mutation headers, a foreground SSE-with-resume event lane wired against the shared contract, and operator-facing Canvas/Parity surfaces, but full Android runtime proof for `companion.android.v1` is still open. See `docs/FOLLOW_ON_PARITY_REGISTER.md` and `docs/COMPANION_CONTRACT.md`. |
| `GC-P1-10` Long-tail parity register | In progress | Explicit follow-on and de-scope register now lives in `docs/FOLLOW_ON_PARITY_REGISTER.md`, the gateway/system surface exposes a live follow-on parity report, and the browser/packaging/A2UI/voice proof lanes now resolve checklist/template truth from a shared contract with direct service-level coverage; broader implementation tranches remain pending. |
| `GC-P2-11` Extension / plugin SDK breadth | In progress | Add-on lifecycle routes, integration plugin routes, skill bundle import foundations, a documented author contract, a local workspace author SDK package, a schema-validated reference add-on scaffold, a local installable reference integration-plugin scaffold, a repo-native extension starter-pack export path, and a System generate/export path for the extension SDK brief now exist. The live follow-on parity report now also shows whether the local reference integration plugin is installed, enabled, and still aligned to the repo scaffold source, but there is still no published SDK package or broader runtime contract. See `docs/FOLLOW_ON_PARITY_REGISTER.md`, `docs/PLUGIN_SDK_CONTRACT.md`, `templates/addons/reference-separate-repo-addon/`, `templates/integration-plugins/reference-integration-plugin/`, and `packages/extensions-sdk/`. |
| `GC-P2-12` Voice Wake / Talk Mode parity | In progress | Local-first voice contracts, runtime management, gateway routes, CLI, doctor checks, and Mission Control UI already exist, runtime readiness/talk/wake state now appear in the live follow-on parity report, System can now generate and export a dedicated voice proof-lane artifact with checklist/template support, Settings plus the exported proof draft now expose explicit recovery actions for runtime/model/talk/wake cleanup, and gateway Talk/Wake starts now refuse to begin when runtime/model posture is not actually ready. Broader parity and product hardening remain open. See `docs/FOLLOW_ON_PARITY_REGISTER.md`. |

## What Is Now Safe To Claim

- GoatCitadel has a shared channel capability contract instead of inferring support only from catalog metadata.
- Gateway clients can call explicit reply and typing APIs without channel-specific branching.
- Mission Control and gateway diagnostics now derive from the same channel capability surface.
- Built-in planned channels are no longer mislabeled as `native` just because a partial runtime seam exists.
- Guided Google Chat and Teams setup can now issue sandbox webhook probes instead of stopping at structural validation alone.
- Guided Slack and Telegram setup now run sandbox send-and-cleanup probes on the recommended bot/token paths.
- The public setup guide now includes channel-by-channel onboarding and troubleshooting coverage for every guided beta setup channel.
- Discord gateway DM routing now has explicit runtime coverage for approved pairing, open DM mode, disabled DM mode, and deferred slash-command pairing prompts.
- Telegram bot connections can now ingest secret-token Bot API webhooks and route inbound user messages into bound chat sessions.
- Telegram bot connections can now emit Bot API typing indicators through the shared `channel.typing` contract.
- Follow-on parity work now has an explicit register for browser, canvas/A2UI, packaging, companion/device, plugin breadth, and voice instead of placeholder-only status lines.
- Mission Control and the gateway now expose live follow-on blockers and recommended next actions for those lanes instead of raw counts alone.
- Browser, packaging, A2UI, and voice proof-lane drafts now pull checklist/template truth from a shared contract surface instead of duplicating that metadata inside each gateway builder.
- Browser follow-on reporting now names the exact registered cookie/storage state tools that are allowed versus blocked in the current deployment profile, matching the same `trusted_local`-only state-tool guardrail enforced by the tool invoke route.
- Packaging follow-on reporting now shows whether the latest proof bundle is missing, stale, or current and whether it still matches the active deployment profile.
- Canvas / A2UI no longer relies on placeholder wording alone; GoatCitadel now has a repo-native `a2ui.v1` contract for distinguishing Mission Control canvas scope from companion-platform canvas scope.
- Extension follow-on reporting now distinguishes local reference-plugin lifecycle truth from the still-missing published SDK/runtime-contract layer, and System can export both an SDK brief and a repo-native starter pack from that live state while the local workspace SDK package remains publication-ready but unpublished.
- GoatCitadel now has a locally executed live proof that an approved-device bearer can exchange into a signed companion session, issue signed mutations, replay/resume SSE, and rotate refresh tokens against the gateway on a non-loopback local address.
- Voice Talk Mode and Wake Mode now block on real runtime/model posture instead of claiming to start unconditionally, and Settings re-syncs the recorded failure state after blocked attempts.

## What Is Not Safe To Claim Yet

- Broad OpenClaw channel parity
- Full inbound/outbound stabilization for Slack, Telegram, Google Chat, Teams, or Discord
- Full inbound normalization and routing parity outside the current Discord, Slack, and Telegram paths
- Tier-1 or Tier-2 planned channel completion
- Browser, canvas, device, packaging, plugin-SDK, or voice parity completion
- Full Android UI/emulator proof for `companion.android.v1` or platform-side A2UI parity

## Exit Criteria For The Next Tranche

- Stabilize each core beta channel against `channel-core`
- Add channel-by-channel smoke coverage
- Keep docs, catalog maturity, and Mission Control discoverability aligned with actual behavior
- Expand inbound normalization and runtime-hardening coverage beyond the current Discord-first path
