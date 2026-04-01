# Browser Control Validation Checklist

Last updated: 2026-03-30
Scope: `GC-P0-06` browser control parity

## Purpose

Use this checklist when claiming progress on browser control parity.

This is the operator-proof lane for GoatCitadel browser work. It complements the live follow-on parity report and the deployment-profile guardrails already enforced in runtime code.

## Operator Flow

1. Generate the current browser proof-lane draft from Mission Control System to capture live runtime counts, posture, and guardrail notes.
1. Confirm deployment profile and auth mode before touching browser state.
1. Verify which browser tools are actually registered in the current runtime.
1. Run the remaining checklist items below and fill the proof bundle template.

## Required Proof Areas

Every browser parity claim should leave evidence for all of these:

1. Read-only browser flow
2. Mutating browser flow
3. Screenshot or extraction proof
4. Deployment-profile guardrail behavior
5. Error-path honesty

## Read-Only Flow Proof

- Run one search, navigation, or extraction flow that does not mutate remote state.
- Confirm the result is usable and grounded in the actual page state.
- Confirm the operator can see what step ran and what evidence came back.

Minimum artifact:
- tool transcript or operator note plus extracted output

## Mutating Flow Proof

- Run one browser interaction that would mutate page state, such as a form fill or button click.
- In `remote_hardened`, confirm explicit confirm-before-submit or equivalent mutating guardrails are respected.
- In `trusted_local` or `local_dev`, confirm the flow still behaves honestly and does not imply hardened behavior when it is not present.

Minimum artifact:
- tool transcript or operator note showing the guarded mutating step

## Screenshot / Extraction Proof

- Capture one screenshot or equivalent page-state artifact.
- Confirm the artifact matches the claimed page or state.
- If extraction is used instead of screenshot, capture enough evidence that a reviewer can understand what page was actually inspected.

Minimum artifact:
- screenshot path or extracted-state artifact path

## Deployment-Profile Guardrail Proof

- Record the deployment profile used for the run.
- If the run is in `remote_hardened`, confirm cookie and storage expectations match hardened policy.
- If the run is in `trusted_local`, confirm broader browser tools work without claiming hardened parity.

Minimum artifact:
- runtime note or System page note showing deployment profile and browser posture

## Error-Path Honesty Proof

- Trigger or record at least one failure or blocked path when practical.
- Confirm the error reported to the operator is honest and actionable.
- Do not treat silent failure or misleading fallback as passing behavior.

Minimum artifact:
- error transcript or operator-facing blocked-state note

## Suggested Evidence Bundle

For each tranche, store or link:

- read-flow transcript
- mutating-flow transcript
- screenshot or extraction artifact
- deployment-profile note
- blocked or error-path note

Reusable template:
- `templates/verification/browser-control-proof-bundle.md`

## Recommended Next Tranche

After this checklist is in use:

1. Keep the System-page proof-lane draft aligned with runtime truth as browser guardrails evolve.
2. Add a replayable browser proof path if GoatCitadel starts depending on browser control for release-critical operator workflows.
