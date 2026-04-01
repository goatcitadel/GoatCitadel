# A2UI Validation Checklist

Last updated: 2026-03-30
Scope: `GC-P0-07` Canvas / A2UI parity

## Purpose

Use this checklist when claiming progress on A2UI parity.

This is the operator-proof lane for the current `a2ui.v1` contract. It is Mission-Control-first by design and should not be used to imply that the existing mobile lane already has companion-session A2UI parity.

## Operator Flow

1. Generate or export the current A2UI proof artifact from Mission Control System to capture the live contract, scope, transport, and platform-target state.
1. Confirm the current `a2ui.v1` contract summary before touching any canvas workflow.
1. Run the Mission Control proof items below and fill the proof bundle template.
1. Record the current companion-session boundary honestly instead of implying companion-session proof that has not been run.

## Required Proof Areas

Every A2UI parity claim should leave evidence for all of these:

1. Contract-state proof
1. Mission Control canvas proof
1. Agent-applied or operator-visible canvas update proof
1. Companion-session boundary honesty

## Contract-State Proof

- Record the active contract id.
- Record the current scopes and transports.
- Record the current operator surface.
- Confirm the proof claim matches the declared contract instead of making up a broader runtime story.

Minimum artifact:
- System-page note or screenshot showing the contract summary

## Mission Control Canvas Proof

- Use Office Lab as the current Mission Control canvas operator path.
- Start with a zone-level state, then select an agent from the canvas or deck controls.
- Confirm both the `Citadel One` readout and the Inspector panel switch from zone context to agent context.
- After selection, direct the same agent to a seat or tile and confirm the movement command appears in both the readout and the Inspector canvas-command field.
- Capture a before/after note that a reviewer can understand without replaying the whole session.

Minimum artifact:
- before/after screenshot pair or short operator note showing the zone-to-agent handoff plus the directed move/re-seat command

## Operator-Visible Update Proof

- Use the Office Lab selection handoff plus directed seat/tile command as the minimum concrete visible update.
- Record both the visible movement in the canvas and the matching command summary in operator-visible UI state.
- If no deeper applied change exists beyond the directed move/re-seat, record that honestly instead of inflating the claim.

Minimum artifact:
- before/after screenshot pair or operator note showing the visible move/re-seat result and matching readout/Inspector command summary

## Companion-Session Boundary Honesty

- Record the currently declared platform targets, if any.
- Confirm whether those targets are only declared in catalog/contract state, represented by a generic mobile runtime, or backed by a proven companion-session implementation.
- Keep the current proof claim Mission-Control-first unless a real companion-session proof run is involved.

Minimum artifact:
- platform target list plus one note that explains what is declared versus what actually ships

## Suggested Evidence Bundle

For each tranche, store or link:

- System-page contract summary
- Mission Control canvas evidence
- before/after applied-change evidence
- companion-boundary note

Reusable template:
- `templates/verification/a2ui-proof-bundle.md`

## Recommended Next Tranche

After this checklist is in use:

1. Keep the System-page A2UI proof-lane draft aligned with `a2ui.v1` as the contract evolves.
2. Extend the same lane to companion-session proof only when the existing mobile runtime is wired to a real companion-session run.
