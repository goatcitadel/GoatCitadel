# GoatCitadel External Review Master Brief

This is the shared source of truth for GoatCitadel's external review kit.

Use it as the binding scope and reporting contract for both reviewers:
- first pass: Claude Code
- second pass: ChatGPT Pro

The review is intentionally exhaustive, adversarial, repo-grounded, long-form, nitpicky, and architecture-first.

## Repo Access Modes

Canonical public repository:
- `https://github.com/goatcitadel/GoatCitadel`

Current local checkout for local-first reviewers:
- `F:\code\personal-ai`

Path resolution rules:
- all file paths in this brief are repo-root-relative unless explicitly stated otherwise
- Claude Code should inspect those paths from the local checkout
- ChatGPT Pro should inspect those same paths from the public GitHub repository on the `main` branch
- when useful for remote review, translate a repo-root-relative path like `apps/gateway/src/services/gateway-service.ts` to a GitHub file URL under `https://github.com/goatcitadel/GoatCitadel/blob/main/...`

## Review Objective

Determine, from the actual current repository, what is still structurally weak, misleading, fragile, inconsistent, incomplete, or more mature in appearance than in reality.

This is not a generic best-practices audit.
This is not a praise pass.
This is not a rewrite pitch.

The goal is to produce decision-grade findings that help the founder decide:
- what is safe enough for broader testing
- what is close but still risky
- what is not yet trustworthy
- what is true 1.0 risk versus legacy or experimental debt

## Scope

The review covers the full repository, but every finding must be tiered by release relevance.

Use exactly these release-tier tags:
- `shipped`: release-bearing, public-claim-bearing, or current primary-surface behavior
- `legacy`: compatibility paths, previous shell behavior, redirects, legacy UI, or code still affecting transition posture
- `experimental`: optional, non-release, sidecar, smoke-only, template, or future-facing scope unless it directly distorts shipped claims

Use exactly these certainty tags:
- `confirmed`: directly supported by repo evidence
- `likely`: strong static evidence, but not fully proven
- `runtime-validation-needed`: meaningful suspicion that requires live validation to resolve

The review must stay full-repo, but findings should be prioritized in this order:
1. `shipped`
2. `legacy` when it can still distort shipped behavior or user trust
3. `experimental` when it leaks into claims, architecture, or operator understanding

## Repo Truth To Anchor On

Treat these as current repo-grounded review anchors:

- `apps/mission-control-next` is the current primary UI used by default runtime commands.
- `apps/mission-control` remains in scope for compatibility, drift, redirect behavior, shared-state assumptions, and migration debt.
- `packages/mission-control-shared` and `packages/threaded-surface-core` are part of the real UI/runtime behavior surface and must not be treated as optional helpers.
- `apps/gateway/src/services/gateway-service.ts` is a major ownership-risk hotspot and must be treated as an active false-centralization suspicion, not just a large file.
- Existing review docs, release docs, and verification lanes are inputs to verify, not proof by themselves.
- Green tests or green verification lanes may prove certain contracts, but they do not automatically prove coherent architecture, truthful UX, or clean ownership boundaries.

## Source-of-Truth Order

When claims conflict, resolve them in this order:
1. current implementation under `apps/` and `packages/`
2. `docs/CANONICAL_RUNTIME_STATE_MODEL.md`
3. `docs/1_0_CONTRACT.md`
4. `docs/1_0_RELEASE_EVIDENCE.md`
5. `docs/ENGINEERING_HANDBOOK.md`

If code and docs disagree, code wins.
Call the disagreement out explicitly.

## Existing Review Inputs To Reuse, Not Trust Blindly

These are useful source materials to mine and challenge:
- `docs/GOATCITADEL_PRE_1_0_ADVERSARIAL_REVIEW_PROMPT.md`
- `docs/GATEWAY_DECOMPOSITION_REVIEW_PROMPT.md`
- `docs/CANONICAL_RUNTIME_STATE_MODEL.md`
- `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md`
- `docs/1_0_CONTRACT.md`
- `docs/1_0_RELEASE_EVIDENCE.md`
- `docs/QA_MANUAL_TEST_PLAN.md`
- `scripts/verification/run.mjs`
- `scripts/verification/lib/scenarios.mjs`
- `scripts/verification/lib/release-surface-manifest.mjs`

## Mandatory Inspection Targets

You must inspect these concrete files or file groups before claiming the review is complete.

### Gateway and runtime authority

- `apps/gateway/src/services/gateway-service.ts`
- `apps/gateway/src/services/service-context.ts`
- `apps/gateway/src/services/approval-lifecycle-service.ts`
- `apps/gateway/src/services/durable-run-service.ts`
- `apps/gateway/src/services/memory-facade-service.ts`

### Route and operator-truth surfaces

- `apps/gateway/src/routes/approvals.ts`
- `apps/gateway/src/routes/orchestration.ts`
- `apps/gateway/src/routes/events.ts`
- `apps/gateway/src/routes/memory.ts`

### Storage and contract truth

- `packages/storage/src/realtime-event-repo.ts`
- `packages/storage/src/memory-context-repo.ts`

### Current and legacy UI surface

- `apps/mission-control-next/**`
- `apps/mission-control/**`
- `packages/mission-control-shared/**`
- `packages/threaded-surface-core/**`

### Release, docs, and verification truth

- `docs/CANONICAL_RUNTIME_STATE_MODEL.md`
- `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md`
- `docs/1_0_CONTRACT.md`
- `docs/1_0_RELEASE_EVIDENCE.md`
- `docs/QA_MANUAL_TEST_PLAN.md`
- `scripts/verification/run.mjs`
- `scripts/verification/lib/scenarios.mjs`
- `scripts/verification/lib/release-surface-manifest.mjs`

If you skip any mandatory target, say the review is incomplete.

## Common Coverage Matrix

The review must explicitly investigate all of these areas so one subsystem does not dominate the output.

### 1. Runtime authority and source-of-truth ownership

Inspect:
- where truth lives for session, turn, durable run, approval, realtime event, and memory context
- whether truth is canonical, reconstructed, compatibility-derived, or ambiguous
- whether state ownership is explicit or scattered across service, route, storage, and UI layers

### 2. Approvals, orchestration, and durable recovery

Inspect:
- approval lifecycle ownership
- pause/resume/cancel/retry semantics
- durable versus non-durable behavior boundaries
- follow-on effects, wake/replay behavior, and partial-failure handling

### 3. Memory lifecycle and UI exposure

Inspect:
- ownership of memory creation, retrieval, maintenance, summarization, learned memory, context packs, and operator admin flows
- whether route/service/storage/UI layers form one architecture or a set of adjacent features

### 4. Current UI, legacy UI, redirects, and cross-surface parity

Inspect:
- current primary UI behavior in `apps/mission-control-next`
- lingering compatibility assumptions from `apps/mission-control`
- redirect and route mapping behavior
- drift between UI claims and backend/runtime truth

### 5. Contracts, migrations, compatibility paths, and event envelopes

Inspect:
- API and envelope compatibility claims
- migration seams and additive-contract behavior
- where compatibility layers may be preserving old ownership or inconsistent semantics

### 6. Policy engine, auth, tool governance, connectors, plugins, and MCP

Inspect:
- whether governance posture is truly shared and enforceable
- whether connectors and MCP are modeled cleanly or via special-case branching
- whether auth, approvals, and tool gating stay coherent across surfaces

### 7. Docs, public claims, and release evidence versus implementation truth

Inspect:
- whether docs overstate maturity or ownership clarity
- whether release evidence proves what it claims to prove
- whether public-facing truth is honest about limits, staging, and compatibility debt

### 8. Verification harness quality and test blind spots

Inspect:
- what is well-proven
- what is only lightly covered
- what is likely missed because the harness checks a narrow contract while deeper semantics remain weak

### 9. Packaging, install, and ops posture

Inspect:
- installer and Docker claims
- local-first and auth posture truthfulness
- backup/restore/operator safety claims
- whether operational ergonomics imply confidence the system has not fully earned

### 10. Performance, scalability, observability, accessibility, and UX truthfulness

Inspect:
- hot spots, giant owner files, likely scaling pain, and event volume concerns
- whether failures are traceable without guesswork
- whether UX implies stronger certainty, continuity, or freshness than the runtime actually supports
- whether accessibility or operator scanability debt undermines the "mission control" claim

## Evidence Rules

Every major claim must meet these standards:

- cite concrete repo evidence
- include file paths for all major findings
- line references are strongly preferred for the top findings
- distinguish direct observation from inference
- explain exactly what in the cited file triggered the conclusion
- if docs and code disagree, cite both and state that code is more authoritative

Do not:
- make evidence-free claims
- blur "I saw this" with "this seems plausible"
- treat green verification lanes as proof of architectural safety
- treat recent file extraction or new naming as proof that ownership is solved

## Severity, Confidence, and Finding Tags

Use these severity labels:
- `critical`
- `high`
- `medium`
- `low`

Use these confidence labels:
- `high`
- `medium`
- `low`

Use these required finding tags on every material finding:
- `release_tier`: `shipped`, `legacy`, or `experimental`
- `certainty`: `confirmed`, `likely`, or `runtime-validation-needed`

For top findings, include all of:
- title
- severity
- confidence
- release tier
- certainty
- why it matters
- evidence paths
- affected subsystem(s)
- likely root cause
- recommended action

## Mandatory Output Sections

Every completed review must include these sections:

1. Executive Summary
2. Top Priority Findings by severity
3. Architectural / Systemic Concerns
4. Declared Model vs Actual Runtime
5. UI/UX-to-System Drift
6. Risky "Looks Fine But Isn't" Areas
7. Suspected But Unconfirmed Issues
8. Recommended Next Actions
9. Final Verdict

The review must also explicitly cover these entities inside `Declared Model vs Actual Runtime`:
- `session`
- `turn`
- `durable run`
- `approval`
- `realtime event`
- `memory context`

## Completion Rule

If the review does not inspect the mandatory targets, it must say so plainly and mark itself incomplete.

If the review relies on docs or verification claims without comparing them to code, it is incomplete.

If the review is mostly style feedback or generic advice, it has failed the brief.

## Failure Modes To Avoid

Do not:
- give generic best-practice advice detached from this repo
- write praise-heavy filler
- trust docs without verifying implementation
- let style-only or lint-level nits crowd out structural issues
- assume green tests or green verification lanes imply architectural safety
- confuse modular filenames with clear ownership
- confuse UI polish with backend truth
- confuse compatibility layers with coherence
- spend most of the output on cosmetic cleanup instead of decision-grade risk

## Review Posture

Be harsh but fair.
Be evidence-based.
Be architecture-first.
Be specific to GoatCitadel.
Optimize for founder decision-making, not politeness.

This review should feel like the last honest checkpoint before the repo gets treated as a real 1.0 candidate.
