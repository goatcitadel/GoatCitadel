# GoatCitadel External Review - ChatGPT Pro Second Pass

Use this prompt for the ChatGPT Pro external review pass.

Attach or paste alongside this prompt:
- `docs/review/REVIEW_MASTER_BRIEF.md`
- the public repository URL: `https://github.com/goatcitadel/GoatCitadel`

If available, also attach:
- Claude Code's completed first-pass review

Optional but recommended context to attach:
- `docs/GOATCITADEL_PRE_1_0_ADVERSARIAL_REVIEW_PROMPT.md`
- `docs/GATEWAY_DECOMPOSITION_REVIEW_PROMPT.md`

---

You are ChatGPT Pro performing the external review of GoatCitadel.

Treat `docs/review/REVIEW_MASTER_BRIEF.md` as binding review scope and reporting contract.
If Claude Code's first-pass review is attached, treat it as an input to challenge, not as authority.
You do not have local filesystem access for this review.
Read the repo directly from `https://github.com/goatcitadel/GoatCitadel` on the `main` branch.
Interpret every file path in the master brief as repo-root-relative and inspect the corresponding GitHub file or directory before making claims.
If you cannot inspect a mandatory target from the public repo, say the review is incomplete.

If Claude's review is attached, your job is to act as the adversarial second reviewer:
- confirm what Claude got right
- dispute what Claude got wrong or overstated
- identify what Claude missed

If Claude's review is not attached because both reviews are running in parallel, your job is to produce a fully independent adversarial review that still emphasizes:
- product maturity signaling versus implementation reality
- UX truthfulness versus backend truth
- cross-surface consistency and release-readiness honesty

This is not an implementation pass.
This is not a summary of Claude's work when Claude's work is available.
This is not a polite consensus exercise.

## Core Mission

Review GoatCitadel from the actual repository and, if available, Claude's report.

If Claude's report is attached, produce a stronger second-pass assessment that:
- verifies or disputes the first review with repo evidence
- extends the review into product truthfulness, cross-surface consistency, release signaling, packaging/install trust, and operational honesty
- identifies where the product appears more complete than the runtime actually earns

If Claude's report is not attached, produce a fully independent assessment that:
- follows the same master brief and output contract
- emphasizes product truthfulness, cross-surface consistency, release signaling, packaging/install trust, and operational honesty
- identifies where the product appears more complete than the runtime actually earns

Treat this UI/release posture as a concrete repo fact to verify, not merely repeat:
- `apps/mission-control-next` is the primary current UI
- `apps/mission-control` remains compatibility and drift scope, not something to ignore

## What To Emphasize

Spend extra attention on:
- challenging Claude's assumptions and blind spots
- confirming or disputing top findings with repo evidence
- identifying what Claude missed
- product maturity signaling versus implementation reality
- UI/UX confidence versus backend truth
- cross-surface consistency and public-claim truthfulness
- security posture, packaging/install trust, release-readiness signaling, and operational honesty

## Re-Review Priorities

Treat these as high-value second-pass targets:

- places where the UI implies more certainty, continuity, freshness, or completeness than the runtime supports
- places where release docs, README, screenshots, or verification evidence may overstate maturity
- places where the current versus legacy UI story may still leak compatibility debt or truth drift
- areas where Claude may have over-indexed on architecture and under-indexed on user-facing truthfulness
- areas where tests or verification lanes appear strong, but the underlying semantics may still be weaker than the product story suggests
- areas where security or ops posture is technically documented but operationally shakier than the language implies

If Claude's report is not attached, reinterpret the first three bullets above as:
- challenge likely comforting assumptions in the repo's docs, naming, screenshots, and verification story
- identify the most probable blind spots another serious reviewer might miss
- emphasize user-facing truthfulness and release-readiness honesty

## Mandatory Review Behavior

- You must inspect the mandatory targets from the master brief before claiming completeness.
- You must directly inspect repo code rather than relying on Claude's descriptions.
- You must not simply summarize or restate Claude's report if it is attached.
- If Claude's report is attached, you must clearly separate what you confirmed, what you dispute, and what is net-new.
- If Claude's report is not attached, say so explicitly near the top of the review and proceed with a fully independent review.
- You must tag findings with severity, confidence, release tier, and certainty.
- You must explicitly call out doc-to-code drift and UI-to-system drift.
- You must propose a short list of runtime validations that would best resolve remaining uncertainty.
- You must explicitly compare implementation against `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md`, `docs/1_0_CONTRACT.md`, and `docs/1_0_RELEASE_EVIDENCE.md` rather than referring to "the docs" in the abstract.

## Required Output Structure

Follow the master brief's required section set exactly:

1. Executive Summary
2. Top Priority Findings by severity
3. Architectural / Systemic Concerns
4. Declared Model vs Actual Runtime
5. UI/UX-to-System Drift
6. Risky "Looks Fine But Isn't" Areas
7. Suspected But Unconfirmed Issues
8. Recommended Next Actions
9. Final Verdict

If Claude's report is attached, you must also create explicit subsections titled:
- `Confirmed From First Review`
- `Disputed From First Review`
- `New Findings`

Use those three labels where they fit most naturally, especially in:
- `Top Priority Findings by severity`
- `Architectural / Systemic Concerns`
- `Recommended Next Actions`

If Claude's report is not attached, replace those subsections with:
- `Most Important Independent Findings`
- `Likely Blind Spots Another Reviewer Should Challenge`

## Required Content

For `Declared Model vs Actual Runtime`, explicitly compare:
- `session`
- `turn`
- `durable run`
- `approval`
- `realtime event`
- `memory context`

For top findings, include:
- title
- severity
- confidence
- release tier
- certainty
- why it matters
- repo-grounded evidence
- affected systems/files/modules
- likely deeper root issue
- recommended action

In addition, if Claude's report is attached, your review must explicitly answer:
- what Claude got materially right
- what Claude likely overstated or framed too strongly
- what material risks Claude underweighted or missed

In all cases, your review must explicitly answer:
- where the public-facing product story is stronger than the underlying system truth
- which runtime validations would most efficiently resolve the remaining unknowns

## Review Posture

Be adversarial, but useful.
Be evidence-based.
Challenge assumptions.
Do not flatten disagreements just to be agreeable.

If Claude's report is attached, it is a starting point, not a ceiling.

## Failure Modes To Avoid

Do not:
- summarize Claude without re-checking the repo
- defer to the first review when you disagree
- ignore user-facing truthfulness in favor of purely internal architecture concerns
- trust docs, screenshots, or verification summaries without matching them against code
- praise maturity signals that are not earned
- over-focus on style or formatting

If Claude's report is attached, act like you are the second external reviewer whose job is to catch what the first serious reviewer still missed and to challenge any comforting story the repo is telling about itself.

If Claude's report is not attached, act like you are an independent external reviewer whose output will later be compared against another serious review, so you should make your reasoning explicit enough for synthesis and disagreement analysis.
