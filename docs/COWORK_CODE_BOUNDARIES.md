# Cowork / Code Boundary Truth

Last updated: 2026-05-05

This document defines the current GoatCitadel boundary between Cowork, Code, self-improvement, and external agentic harness parity work.

## Current Contract

GoatCitadel keeps one governed runtime spine for Chat, Cowork, and Code, but the operator surfaces have different jobs:

- Chat is for lightweight conversation and drafting.
- Cowork is for visible multi-step orchestration, delegation, approvals, checkpoints, and operator steering.
- Code is for implementation work that must be reviewable, bounded, and validated.

Cowork and Code may share durable runs, approvals, skills, capability catalogs, and runtime lifecycle exports. They should not hide source-of-truth transitions behind surface-specific state.

## Cowork Owns

- task decomposition and workflow visibility
- role handoffs and specialist delegation
- operator steering, retry, pause, and approval checkpoints
- synthesis and final-response ownership when multiple roles participate
- external harness comparison evidence when an external harness is available and intentionally invoked

Cowork must show enough state for an operator to understand what is running, what is waiting, what failed, and what still requires judgment.

## Code Owns

- repository inspection, patch planning, implementation, test selection, and validation reporting
- code-focused claims about files touched, tests run, failures found, and follow-up risk
- Code Mode runs that are governed by capability snapshots, policy snapshots, approval state, recorded artifact hashes, and execution-time hash checks

Code Mode is a trusted-code, operator-governed surface. It is not a hostile-code sandbox claim. Host isolation adapters may provide additional defense when available, and required isolation must fail closed when the host cannot satisfy it, but that is different from promising arbitrary hostile-code containment.

## Self-Improvement Boundary

GoatCitadel self-improvement is review-first:

- runtime, approval, evaluation, and benchmark signals can create inspectable improvement records
- generated candidates remain proposals or candidates until reviewed and activated
- callable catalogs must not include inactive proposals
- mutation paths require explicit approval and provenance
- review artifacts should explain evidence, rollback posture, and operator decision points

This means Hermes/OpenClaw-style curator or autonomous improvement patterns can be useful references, but GoatCitadel should not silently install or activate generated behavior just because a harness produced it.

## External Harness Boundary

External harnesses are gated by availability and operator intent:

- A lane may verify that GoatCitadel has the anchors needed to call or compare against a harness.
- A lane must report `not_configured` or fail with a clear missing-anchor error when required local anchors are absent.
- A lane must not claim full parity with OpenClaw, Hermes, or any external agent unless that harness is present, invoked, and its output is captured as evidence.
- External harness output is evidence for review, not a replacement for GoatCitadel contracts, storage truth, approval policy, or operator-visible state.

## Source Anchors

Current source anchors for this boundary include:

- `packages/contracts/src/agentic-runtime.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/improvement.ts`
- `apps/gateway/src/orchestration/policies/cowork-policy.ts`
- `apps/gateway/src/orchestration/policies/code-policy.ts`
- `apps/gateway/src/services/improvement-service.ts`
- `apps/gateway/src/services/capability-system-service.ts`
- `apps/gateway/src/routes/orchestration.ts`
- `apps/gateway/src/routes/improvement.ts`
- `apps/gateway/src/routes/capabilities.ts`
- `docs/CANONICAL_RUNTIME_STATE_MODEL.md`
- `docs/CAPABILITY_SYSTEM_V1.md`
- `docs/HARNESS_AUDIT_LENS.md`

## Verification Lanes

The agentic parity lanes are focused behavior-backed lanes. They do not replace broad end-to-end runtime validation, but they now exercise concrete runtime anchors for the Cowork/Code boundary instead of serving as scaffold-only placeholders.

- `verify:agentic:contracts` (`agentic-contracts`) checks the contract, route, service, workbench, channel, and boundary-document anchors for governed Cowork/Code agentic runtime truth.
- `verify:agentic:governance` (`agentic-governance`) checks review-first self-improvement, callable-vs-inspectable capability boundaries, marketplace/provider governance, approvals, and durable runtime ownership anchors.
- `verify:agentic:harnesses` (`agentic-harnesses`) checks external harness boundary documentation, availability-gated comparison anchors, and behavioral callable-boundary proof.
- `verify:agentic:proof` (`agentic-proof`) runs the contract, governance, and harness proof families together as targeted contract/behavior proof; it is not a live end-to-end product proof. `verify:agentic:parity` remains a compatibility alias for the same aggregate lane.
- `verify:code:workbench-loop` (`agentic-workbench-loop`) focuses the Code Workbench patch, test, apply, export, and revert behavior.
- `verify:channels:runtime` (`agentic-channels-runtime`) focuses durable channel delivery retry, stale-state, and route behavior.
- `verify:harness:availability` (`agentic-harness-availability`) focuses agentic availability routes plus callable-boundary behavior when external harness anchors are absent or present.
- `verify:plugins:marketplace` (`agentic-plugins-marketplace`) focuses plugin/provider marketplace callable-boundary behavior.
- `verify:self-improvement:trust` (`agentic-self-improvement-trust`) focuses review-first self-improvement and curator trust behavior.

These lanes are intentionally fail-closed on missing source anchors so parity claims cannot drift ahead of implemented or documented runtime truth.
