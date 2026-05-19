# A2UI Contract

Last updated: 2026-03-30
Contract id: `a2ui.v1`

## Purpose

This document defines the first repo-native A2UI contract for GoatCitadel.

The goal is to separate three things that were previously blurred together:

- Mission Control canvas/UI work
- companion-platform canvas capabilities
- future runtime/proof-lane work that will sit behind those surfaces

`a2ui.v1` is a contract and coordination baseline, not a claim that a full A2UI runtime already ships.

## Scope

`a2ui.v1` currently covers two scopes:

- `ui_canvas`
- `platform_canvas`

The first operator surface is `mission_control`.

## Transport Lanes

`a2ui.v1` currently recognizes two transport lanes:

- `local_session`
- `companion_session`

`local_session` is the current Mission Control-first lane.
`companion_session` is declared so Android/iOS platform tracks can inherit the same contract without pretending that a companion runtime already ships.

## Capability Shape

### UI canvas capabilities

- `scene_view`
- `selection`
- `inspect`
- `agent_apply`

### Platform canvas capabilities

- `scene_view`
- `camera_input`
- `screen_input`
- `voice_input`

## Current Repo Mapping

- Contract types live in `packages/contracts/src/a2ui.ts`.
- The paired companion bootstrap contract now lives in `docs/COMPANION_CONTRACT.md` and `packages/contracts/src/companion.ts`.
- The live follow-on parity report includes the resolved contract under the canvas lane.
- The integration catalog now treats `automation.canvas-a2ui` as a named capability surface instead of a generic visual-workspace placeholder.
- Mission Control can now generate and export A2UI proof data from live runtime state before operators record a bundle.
- The current concrete Mission-Control-first proof action is the Office Lab handoff plus directed move path: selecting an agent must change both the `Citadel One` readout and the Inspector panel from zone context to agent context, then a seat/tile command must appear in both the readout and the Inspector canvas-command field.

## Not Claimed Yet

`a2ui.v1` does not claim:

- production-grade mobile/session transport
- full parity between Mission Control canvas work and device surfaces

## Next Safe Slice

Keep the Mission-Control-first A2UI proof flow aligned with the current verification artifact locations, and only reopen the lane when the contract, deployment profile, or operator flow changes. Do not cite `artifacts/follow-on-parity/a2ui/` as checked-in evidence unless that bundle is regenerated and committed.
