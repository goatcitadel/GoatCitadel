# GoatCitadel Channel Adapter Checklist

Use this checklist when adding or upgrading a messaging channel. It is inspired by Hermes' platform-adapter guide, but maps to GoatCitadel's TypeScript gateway, contracts, setup wizard, policy, and Mission Control surfaces.

## Required Adapter Shape

- Add or update the integration catalog entry and channel setup definition.
- Define channel capabilities through `ChannelCapabilities`.
- Normalize inbound payloads into GoatCitadel channel messages.
- Route inbound messages through: adapter -> authorization -> command dispatch -> active agent guard -> reply delivery.
- Support target-directory entries where the platform can expose or infer chat targets.
- Show setup diagnostics, live-auth checks, live-send checks, and operator-facing common failures.
- Render approvals in the native platform when supported, with text fallback.
- Keep terminal, filesystem, network mutation, and connector mutation requests policy- and approval-gated.
- Show active personality, home channel, tool posture, and trust posture in operator surfaces.
- Add focused tests for normalization, setup validation, command handling, target resolution, and approval rendering.

## Telegram V1 Expectations

- `/start` explains pairing and setup.
- `/status` shows connection state, home channel, trust posture, and active personality.
- `/sethome` stores the current chat as `defaultChannelId`.
- `/personality` lists built-in personality overlays.
- `/tools` explains available tool families and approval requirements.
- Target discovery uses recent Telegram updates first, then connection-config fallbacks.

## Curator Rule

Curation review/reporting may recommend changes, but it must not mutate skills or memory directly. Every proposed prune, merge, rewrite, promote, or memory update needs visible approval, provenance, trust state, and rollback information.
