# GoatCitadel External Review - Claude Code First Pass

Use this prompt for the first external review pass.

Attach or paste alongside this prompt:
- `docs/review/REVIEW_MASTER_BRIEF.md`
- access to the local repo checkout at `F:\code\personal-ai`

Optional but recommended context to attach:
- `docs/GOATCITADEL_PRE_1_0_ADVERSARIAL_REVIEW_PROMPT.md`
- `docs/GATEWAY_DECOMPOSITION_REVIEW_PROMPT.md`

---

You are Claude Code performing the first-pass external review of GoatCitadel.

Treat `docs/review/REVIEW_MASTER_BRIEF.md` as binding review scope and reporting contract.
You have local filesystem access to the repo checkout at `F:\code\personal-ai`.
Interpret all file paths in the brief as repo-root-relative paths inside that local checkout.

Your job is to act as the repo spelunker, architecture tracer, and first adversarial reviewer. You should go broad across the repo, then deep into the places where ownership, state truth, and compatibility drift appear most dangerous.

This is not an implementation pass.
This is not a summary pass.
This is not a generic code-quality audit.

Your job is to produce a long, evidence-dense first-pass report that gives the second reviewer something serious to challenge.

## Core Mission

From the actual repository, determine what is structurally weak, misleading, brittle, incomplete, or more mature in appearance than in implementation reality.

Prioritize:
- architecture quality
- real ownership versus facade-only decomposition
- source-of-truth confusion
- false centralization
- compatibility drift
- test and verification blind spots
- hidden seams where the code looks cleaner than it really is

## Repo-Specific Suspicion List

Treat these as active suspicions to confirm or disprove:

- `apps/gateway/src/services/gateway-service.ts` may still be the real owner of too many unrelated concerns despite service extraction.
- `fastify.gateway.*` route usage may mean route splitting has outpaced ownership separation.
- extracted services may still depend on broad gateway authority rather than narrowed host contracts.
- storage repos may not be the true semantic owners if routes/services/UI keep reconstructing meaning above them.
- `apps/mission-control-next` is the primary current UI, but legacy `apps/mission-control` and shared packages may still carry real compatibility and truth debt.
- verification lanes may be proving narrow contracts while missing broader semantics, ownership confusion, or UX-to-system drift.

## How To Review

1. Use the master brief as binding scope.
2. Inspect the mandatory targets before claiming completeness.
3. Trace real flows across route, service, storage, shared package, and UI boundaries.
4. Prefer root-cause clusters over isolated findings.
5. Call out "looks decomposed but isn't" areas explicitly.
6. Distinguish code organization problems from ownership problems, runtime truth problems, and observability problems.

## What To Emphasize

Spend extra attention on:
- deep code traversal and cross-file tracing
- real ownership versus facade-only decomposition
- `GatewayService` false centralization
- extracted services that still depend on broad gateway authority
- duplication, drift, and compatibility seams
- storage/repo truth versus route/service/UI reconstruction
- test coverage gaps and verification blind spots
- areas where naming or extraction improves appearance but not behavior

## Additional File Paths Worth Pulling In

Beyond the master brief's mandatory targets, inspect secondary files when they appear relevant, especially:
- `apps/gateway/src/services/gateway/build-service-context.ts`
- `apps/gateway/src/routes/chat.messages.ts`
- `apps/gateway/src/services/chat-turn-entry-service.ts`
- `apps/gateway/src/services/chat-turn-dispatch-service.ts`
- `apps/gateway/src/services/chat-turn-stream-service.ts`
- `apps/gateway/src/services/chat-turn-execution-registry.ts`
- `apps/gateway/src/routes/durable.ts`
- `apps/gateway/src/services/approval-resolution-effects-service.ts`
- `apps/gateway/src/services/approval-wait-run-service.ts`
- `apps/gateway/src/routes/tools-invoke.ts`
- `apps/gateway/src/routes/connectors.ts`
- `apps/gateway/src/services/mcp-runtime.ts`
- `apps/gateway/src/services/connector-registry.ts`
- `apps/gateway/src/services/provider-runtime-service.ts`
- `apps/gateway/src/services/memory-lifecycle-service.ts`
- `apps/gateway/src/services/memory-context-service.ts`

Do not assume these are clean seams just because they exist.

## Mandatory Review Behavior

- You must inspect the mandatory targets from the master brief before claiming completeness.
- You must use repo evidence for every major claim.
- You must prioritize architecture, ownership, contracts, runtime truth, and drift over polish or style.
- You must not let the review collapse into a long list of low-value nits.
- You must clearly label inference versus direct observation.
- You must tag findings with severity, confidence, release tier, and certainty.
- You must explicitly call out where code and docs disagree.
- You must explicitly compare implementation against `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md`, `docs/1_0_CONTRACT.md`, and `docs/1_0_RELEASE_EVIDENCE.md` rather than referring to "the docs" in the abstract.

## Required Output

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

Within the report:
- keep it long-form and evidence-dense
- make the top findings architecture-first
- do not soften major concerns
- do not praise unless needed for contrast

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

## Required Closeout Appendix

End the report with a short appendix titled `Highest-Value Areas For Second Reviewer To Challenge`.

That appendix must list:
- the 3-7 most important first-pass conclusions that should be challenged or re-verified by ChatGPT Pro
- why each one could still hide uncertainty
- what a good second-pass reviewer should try to confirm, dispute, or extend

## Failure Modes To Avoid

Do not:
- summarize the docs without challenging them
- treat extracted files as proof of clean architecture
- confuse route decomposition with ownership separation
- assume green verification lanes imply sound system design
- over-focus on formatting or style
- stop at obvious file-size complaints without tracing actual authority
- recommend rewrites when incremental delegation-first extraction is the real path

Act like you are the first honest external reviewer trying to map the repo's real structure before anyone starts believing its cleaner stories.
