# GoatCitadel Prompt Pack v3.2 Fast Signal

Fast-iteration subset of `goatcitadel_prompt_pack_v3_signal.md`.

This pack is meant for rapid repair loops:
- it keeps representative coverage across Chat, Cowork, and Code
- it keeps at least one representative for each tool tier
- it keeps the current hardening seams
- it keeps every failure family visible in the latest full-pack run
- it drops same-behavior variants that mainly restate the same contract with different nouns

Use this pack when you want a high-signal rerun before paying the cost of the full 149-case suite.

## Pack-wide Quality Rules

### Evidence and honesty rules

- Do not invent files, routes, UI states, worker behavior, or hidden runtime state.
- If repo inspection is needed and unavailable, say so plainly instead of inferring implementation truth.
- Whenever a prompt touches cross-system state, distinguish:
  - **canonical truth**
  - **inferred or projected truth**
  - **unknown or missing evidence**
- Negative results count. A good answer says what was searched, what was not found, and what remains unproven.

### Mode-specific answer contracts

- **No Tools**
  - Prefer operator-safe honesty over confident reconstruction.
  - When uncertainty matters, separate **known**, **uncertain**, and **next verification step**.
  - Default to **160 words or fewer** unless the prompt explicitly asks for a longer artifact.
  - If the prompt gives exact labels or sections, return **only** those labels or sections and no recap or synthesis.
- **Implicit Tools**
  - If the model inspects the repo, it must separate **observed behavior**, **inferred behavior**, and **still unclear** behavior.
  - If the model does not inspect the repo, it must not claim repo-grounded certainty.
- **Explicit Tools**
  - Cite the exact files used.
  - Say which subsystem owns each observed behavior.
  - Call out one unresolved seam, invariant, or ambiguity that still deserves testing.
- **Cowork role prompts**
  - Preserve the exact requested role order.
  - Do not add synthesis, recap, or extra headings unless the prompt asks for them.
- **Code and test prompts**
  - Prefer the smallest repo-native test or patch that proves the seam.
  - Include setup, act, assert, and the failure signature that would prove the regression.
  - Name the subsystem boundary being tested, not just the local function.

### Precision rules for the hardening tests

- Do not ask for "a plan" or "an explanation" without forcing a concrete output shape.
- If a prompt asks for operator-facing copy, require the exact labels or bullets the answer must use.
- If a prompt asks for an overnight slice, seam suite, or matrix, require named test cases with:
  - scenario
  - action or trigger
  - expected observable
  - regression signal
- If a prompt asks for a minimal automated test, require:
  - target file or suite
  - fixture or setup state
  - act step
  - exact assertions
  - failure signature
- If a prompt asks for an exact patch plan, require:
  - files to edit
  - types, functions, or contracts to touch
  - compatibility or migration note
  - validation step

## Fast Coverage Goals

This fast pack intentionally centers:
- section-order and no-extra-heading discipline in Cowork
- explicit-evidence honesty in Chat and Cowork
- typed wake outcomes, canonical-versus-inferred truth, and multi-worker durability seams
- the current implicit-tools code failures that still need repair signal

# Chat

## No Tools

### TEST-C101: Operator-visible precedence conflict

An operator asks why a workspace instruction overrode a remembered preference while a repo doc seemed to say something else. Explain the effective precedence GoatCitadel should follow and what it should surface so the operator is not surprised. Keep the answer concise and do not invent hidden files or hidden state.

Answer contract:
- Use exactly three bullets labeled `Precedence`, `Why it won`, and `What to surface`.
- Keep each bullet to one sentence.
- Keep the whole answer under 120 words.

### TEST-C116: Choosing the right Prompt Lab action

Explain when an operator should choose a single rerun, a replay regression run, or a benchmark matrix. Make the answer decision-oriented rather than descriptive.

### TEST-C125: High-trust temporal caveat

Give a compact operator-facing answer for when GoatCitadel cannot confirm whether repo guidance is newer than workspace guidance. The answer must be honest, non-alarmist, and explicit about uncertainty.

### TEST-C133: Paused versus waiting operator explanation

A durable run is paused by an operator. Later, a linked approval resolves. Write the exact operator-facing message GoatCitadel should give when the run does **not** resume.

Answer contract:
- Use exactly three labeled bullets in this order: `What happened`, `Why it did not resume`, `What to check`.
- Explicitly contrast `paused` versus `waiting`.
- State one thing that **does** auto-resume and one thing that **does not**.
- Name the single evidence artifact the operator should look for.
- Do not mention hidden workers, hidden retries, or guessed run internals.

### TEST-C134: Canonical versus inferred linkage honesty

An approval detail shows a session and turn as canonical links, while the live feed hints at a durable run but no canonical run link exists. Write the operator-facing answer GoatCitadel should give. Separate:
- canonical link
- inferred relationship
- unknown

Do not guess a run ID.

Answer contract:
- Use those three labels exactly.
- The `canonical link` line must name only the entities that are truly linked.
- The `inferred relationship` line must describe the live-feed hint without upgrading it to truth.
- The `unknown` line must say whether a durable run link is missing or unverified.
- Do not guess a run ID or a missing link target.

### TEST-C137: Partial-failure trust boundary

An approval is resolved, but downstream wake or follow-on work is not yet confirmed. Write the operator-facing explanation GoatCitadel should give without pretending the whole chain completed.

Answer contract:
- Use exactly two labeled bullets: `Approval state` and `Downstream effect`.
- `Approval state` must describe only the canonical approval fact.
- `Downstream effect` must describe the unresolved wake or follow-on status plus one verification step.
- Do not collapse both states into one success statement.

## Implicit Tools

### TEST-C105: Repo-grounded guidance chain

Inspect the repo if needed and explain the current guidance resolution chain as three buckets: observed behavior, inferred behavior, and still-unclear behavior.

### TEST-C108: Import provenance trust posture

Inspect the repo if needed and explain how GoatCitadel currently handles skill provenance, overlap review, and risky imports. Call out what looks enforced versus advisory.

### TEST-C120: Memory pack inspection today

Inspect the repo if needed and explain what an operator can currently list, inspect, or prune around memory context packs. Separate what is clearly supported from what still appears partial.

### TEST-C140: Repo-grounded lifecycle provenance map

Inspect the repo if needed and explain how runtime lifecycle currently distinguishes canonical linkage, inferred linkage, and missing linkage across approvals, durable runs, sessions, and turns.

Answer contract:
- Use exactly four bullets labeled `Canonical`, `Inferred`, `Missing`, and `Overstatement risk`.
- Ground each of the first three bullets in a concrete observed data path or say it remains unproven.
- `Overstatement risk` must name one specific operator-facing phrase or surface that could imply too much certainty.

### TEST-C143: Repo-grounded multi-worker readiness

Inspect the repo if needed and explain whether durable execution is actually multi-worker-safe today.

Answer contract:
- Use exactly three bullets labeled `Observed implementation`, `Desired but not proven`, and `Best next regression`.
- `Observed implementation` must state whether ownership is persisted, local, mixed, or unknown.
- `Best next regression` must be a single concrete two-worker test idea with a failure signature.

### TEST-C144: Repo-grounded Mission Control honesty

Inspect the repo if needed and explain where Mission Control currently shows canonical truth, inferred relationships, or smoothed projections for approvals and runtime lifecycle.

Answer contract:
- Use exactly four bullets labeled `Canonical surface`, `Inferred surface`, `Projected surface`, and `Risk to operator trust`.
- Ground each surface in inspected evidence when available.
- Keep the wording operator-centered rather than implementation-only.

## Explicit Tools

### TEST-C109: Exact evidence for guidance precedence

Use file or code tools to inspect the current guidance-loading chain. Cite the exact files used and explain the precedence order you actually observed, plus one point that still looks ambiguous.

### TEST-C111: Exact evidence for skill import provenance

Use file or code tools to inspect how repo-managed imported skills record trust metadata in `skills/extra/<skill-id>/`. Summarize the provenance fields an operator can actually use during overlap or provenance review.

Answer contract:
- Cite the exact files used.
- Return exactly three bullets labeled `Observed fields`, `Operator-usable fields`, and `Still ambiguous`.
- Do not return JSON.

### TEST-C121: Exact evidence for memory routes

Use file or code tools to inspect memory routes, memory context services, and any related UI or copy. Explain the current operator-facing lifecycle with exact citations from the files you used.

### TEST-C123: Exact evidence for workspace override resolution

Use file or code tools to inspect how GoatCitadel resolves global docs, workspace docs, and repo guidance at runtime. Summarize the observed chain and cite the exact files used.

### TEST-C131: Exact evidence for prompt-pack source labeling

Use file or code tools to inspect prompt-pack import, source labeling, and export rendering. Explain where the real source label comes from today and where silent drift could still occur.

### TEST-C145: Exact evidence for paused versus waiting enforcement

Use file or code tools to inspect durable-run wake logic, approval wake helpers, and any operator resume path.

Answer contract:
- Cite at least three exact files.
- Use exactly four bullets labeled `Files inspected`, `Observed disjointness`, `Counterexample not found`, and `Implicit invariant`.
- `Observed disjointness` must name the check or branch that keeps `paused` distinct from `waiting`, if it exists.
- `Counterexample not found` must state the negative search result plainly.

### TEST-C148: Exact evidence for canonical linkage versus inference

Use file or code tools to inspect lifecycle assembly, approval linkage loading, realtime-event linkage, and Mission Control approvals or runtime views.

Answer contract:
- Cite the exact files used.
- Use exactly three bullets labeled `Canonical path`, `Inference path`, and `Fallback gap`.
- `Canonical path` must name the authoritative field, table, or response source if present.
- `Inference path` must name the code path that fills gaps from payload, preview, or events.
- Do not return a table.

### TEST-C150: Exact evidence for event envelope authority

Use file or code tools to inspect approval, run, session, task, or proactive event publishing and storage.

Answer contract:
- Cite the exact files used.
- Use exactly four bullets labeled `Authored eventClass`, `Authored eventAuthority`, `Authored links`, and `Inference still required`.
- If a field is missing entirely, say `not found` rather than describing a desired state.

# Cowork

## No Tools

### TEST-W101: Roles in order Product, Architect, QA

Create role-labeled sections for an overnight qwen-focused prompt-pack slice that tests fresh failure modes instead of repeating already-patched prompts. Keep the sections in the requested order. Do not add a synthesis section.

Answer contract:
- Keep exactly these sections in order: `Product`, `Architect`, `QA`.
- Do not add any intro, recap, or synthesis section.
- Each section must contain exactly two bullets.

### TEST-W115: Roles in order Researcher, Architect, QA

Produce role-labeled sections defining how GoatCitadel should report unresolved conflicts between workspace guidance, repo docs, and remembered user preferences while preserving trust.

Answer contract:
- Keep exactly these sections in order: `Researcher`, `Architect`, `QA`.
- Do not add any intro, recap, or synthesis section.
- `Researcher` must define the evidence hierarchy.
- `Architect` must define the reporting rule.
- `QA` must define two probes that would catch fake certainty.

### TEST-W116: Roles in order Product, QA

Produce role-labeled sections for when Prompt Lab should show a result as "useful but not decision-grade" rather than simply pass or fail.

Answer contract:
- Keep exactly these sections in order: `Product`, `QA`.
- Do not add any intro, recap, or synthesis section.
- `Product` must define exactly three triggers for `useful but not decision-grade`.
- `QA` must define exactly three checks that justify showing that state.

### TEST-W133: Roles in order Architect, QA, Product

Produce role-labeled sections for the smallest fresh overnight regression slice that validates:
- paused versus waiting semantics
- approval wake correctness
- operator-visible canonical versus inferred linkage

Keep the requested role order only and do not add extra headings.

Answer contract:
- `Architect` must name exactly three tests and the seam each one covers.
- `QA` must give setup, trigger, expected observable, and failure signal for each named test.
- `Product` must state which single overnight decision this slice unlocks and which risk it does **not** cover.

### TEST-W134: Roles in order Researcher, Architect, QA

Produce role-labeled sections defining how GoatCitadel should grade answers when canonical linkage, inferred linkage, and live-feed hints disagree. Keep the requested role order only.

Answer contract:
- `Researcher` must define the evidence hierarchy with a concrete good-answer and bad-answer example.
- `Architect` must translate that hierarchy into a grading rule with pass, soft-fail, and hard-fail conditions.
- `QA` must give three judge probes that would distinguish those outcomes.

## Implicit Tools

### TEST-W105: Roles in order Architect, Coder, QA

Inspect the repo if needed and produce role-labeled sections describing the smallest fresh regression slice for guidance precedence, repo binding, and operator-visible override clarity.

### TEST-W106: Roles in order Architect, Ops, QA

Inspect the repo if needed and produce role-labeled sections for how a built-in report-only cron flow should surface artifacts, review items, and manual recovery after a long run.

### TEST-W119: Roles in order Architect, QA

Inspect the repo if needed and produce role-labeled sections describing the current lifecycle of memory context packs and the highest-value expiry or pruning regression to add next.

### TEST-W137: Roles in order Architect, QA, Product

Inspect the repo if needed and produce role-labeled sections describing the smallest high-signal seam suite for Rank 1 hardening: paused versus waiting, approval wake skips, and operator-visible wake outcomes.

Answer contract:
- Cite the exact files inspected if any.
- `Architect` must name the smallest suite and why each test belongs.
- `QA` must give setup, act, assert, and failure signature for each test.
- `Product` must state the operator-visible behavior each test protects.

### TEST-W140: Roles in order Architect, QA

Inspect the repo if needed and produce role-labeled sections for the smallest regression slice that proves explicit event links and classification survive from producer to operator-visible surfaces. Keep the requested role order only.

Answer contract:
- `Architect` must name the minimal producer -> storage -> API/UI path under test.
- `QA` must give one test for happy-path propagation and one test for missing-field honesty.

## Explicit Tools

### TEST-W109: Roles in order Researcher, Architect, QA

Use file or code tools to inspect workspace routes, guidance docs, and related services. Produce role-labeled sections for the first fresh regression checks to add, and cite the exact files used.

### TEST-W111: Roles in order Researcher, Product

Use file or code tools to inspect `apps/gateway/src/services/skill-import-service.ts` plus related vetting or overlap logic. Produce role-labeled sections deciding which fresh overlap cases should be added next.

### TEST-W123: Roles in order Researcher, Architect

Use file or code tools to inspect workspace loading, guidance docs, and project-binding behavior. Produce role-labeled sections summarizing the effective override chain and cite the exact files used.

### TEST-W141: Roles in order Researcher, Architect, QA

Use file or code tools to inspect durable, approval, lifecycle, and Mission Control files. Produce role-labeled sections recommending the first exact cross-system regression additions, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- `Researcher` must summarize the most relevant observed seam evidence.
- `Architect` must recommend exactly three new regressions.
- `QA` must define the pass condition and failure signature for each regression.

### TEST-W144: Roles in order Researcher, Product, QA

Use file or code tools to inspect approval resolution, wake helpers, and downstream effect visibility. Produce role-labeled sections explaining which partial-failure cases must be added next and cite the exact files used.

Answer contract:
- Cite the exact files used.
- `Researcher` must distinguish canonical approval success from downstream uncertainty.
- `Product` must say what the operator must and must not infer.
- `QA` must propose exactly three partial-failure cases with setup, observable, and failure wording.

# Code

## No Tools

### TEST-D101: Overlapping skill family safeguard

Propose the smallest repo-native change that prevents users from installing multiple overlapping skill families into `skills/extra` while still allowing one clear primary choice.

Answer contract:
- Use exactly three bullets labeled `Observed`, `Inferred fix`, and `Validation`.
- If the repo was not inspected, `Observed` must say `none`.
- Keep the whole answer under 150 words.

### TEST-D104: Prompt Lab rollout slice

Propose the smallest rollout slice for an expanded overnight v2 pack so GoatCitadel can harden new behavior without rerunning the frozen baseline immediately.

Answer contract:
- Use exactly three bullets labeled `Observed`, `Smallest slice`, and `Validation`.
- If the repo was not inspected, `Observed` must say `none`.
- Keep the whole answer under 150 words.

### TEST-D134: Typed wake outcome contract

Propose the smallest repo-native change that replaces stringly or implicit wake outcomes with a typed contract shared across durable-run logic, approval wake helpers, and operator-visible reporting.

Answer contract:
- Propose the exact wake outcome variants.
- Name the shared contract location.
- Identify the producer path and the operator-visible consumer path.
- Include one backward-compatibility note and one proving test.

### TEST-D135: Lifecycle provenance contract

Propose the smallest repo-native change that lets GoatCitadel report where each linked entity came from, for example:
- canonical field
- canonical side-table
- durable or task reference
- compatibility fallback inference

Keep the design compact and operator-visible.

Answer contract:
- Name the exact provenance field or shape you would add.
- Show one example response fragment.
- State where canonical data wins over inferred data.
- Include one validation step that proves the provenance survives to an operator-visible surface.
- Do not return a table.

### TEST-D136: Canonical versus inferred UI truth labels

Propose the smallest repo-native Mission Control change that makes approvals and runtime views clearly distinguish:
- canonical link
- inferred relationship
- no known relationship

Do not solve this by hiding useful inferred information.

Answer contract:
- Propose the smallest UI state or prop change.
- Provide the exact three labels or badges the UI should render.
- State which API field each label depends on.
- Include one regression test idea for mislabeling.

## Implicit Tools

### TEST-D105: Minimal wrapped-dependents parser test

Inspect the repo if needed and propose the exact minimal automated test that proves GoatCitadel can parse `pnpm outdated -r` output even when the dependents column wraps.

### TEST-D106: Minimal duplicate-family install test

Inspect the repo if needed and propose the exact minimal automated test that proves overlapping skill families are blocked from being installed into `skills/extra`.

### TEST-D107: Minimal v2 parser distinction test

Inspect the repo if needed and propose the exact minimal automated test that proves `goatcitadel_prompt_pack_v2.md` parses cleanly and remains distinct from the frozen baseline.

### TEST-D117: Minimal source-label preservation test

Inspect the repo if needed and propose the exact minimal automated test that proves an env-loaded prompt pack preserves its real source label instead of being mislabeled.

### TEST-D118: Minimal focused-pack gate selection test

Inspect the repo if needed and propose the exact minimal automated test that proves gate selection can intentionally target an expansion pack without silently preferring the older baseline.

### TEST-D119: Minimal workspace guidance precedence test

Inspect the repo if needed and propose the exact minimal automated check that keeps workspace-scoped guidance precedence both stable and operator-visible.

### TEST-D127: Minimal judge-default selection test

Inspect the repo if needed and propose the exact minimal automated test that proves Prompt Lab chooses the intended judge defaults for the expanded pack instead of silently inheriting the frozen baseline's assumptions.

### TEST-D128: Minimal cowork extra-heading regression test

Inspect the repo if needed and propose the exact minimal automated test that catches small models adding fake cowork headings or inline contract echoes.

### TEST-D139: Minimal wake-ordering integrity test

Inspect the repo if needed and propose the exact minimal automated test that proves approval-wait state is not marked complete before a durable wake is actually confirmed.

Answer contract:
- Name the target test file or suite.
- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.
- `Assert` must distinguish pre-wake, wake-attempt, and post-confirmation state.

## Explicit Tools

### TEST-D109: Exact patch plan for skill import trust metadata

Use file or code tools to inspect `apps/gateway/src/services/skill-import-service.ts` and identify the exact patch points needed to strengthen provenance metadata, overlap handling, and operator review posture.

### TEST-D122: Exact patch plan for focused-pack gate selection

Use file or code tools to inspect `scripts/run-prompt-pack-gates.ts` and related prompt-pack APIs. Identify the exact patch points needed so gate runs can intentionally target the expanded overnight v2 pack.

### TEST-D123: Exact assertions for workspace guidance precedence

Use file or code tools to inspect workspace loading, guidance resolution, and related tests. Propose the exact assertions needed so GoatCitadel keeps workspace-scoped guidance precedence stable.

### TEST-D124: Exact rollout wiring for expanded v2 evaluation

Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend-reporting files. Draft an exact file-grounded rollout plan for evaluating the longer overnight v2 pack with minimal operational churn.

### TEST-D130: Exact patch plan for prompt-pack import metadata

Use file or code tools to inspect prompt-pack import, storage, and report or export rendering. Identify the exact patch points needed so operators can see source markdown identity, import time, and refresh provenance.

### TEST-D147: Exact patch plan for typed wake outcomes

Use file or code tools to inspect durable-run wake logic, approval-wait wake handling, and related operator-visible status shaping. Identify the exact patch points needed to add a typed wake outcome contract and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Name the contract file, producer call sites, and consumer call sites.
- Include one compatibility note and one validation step.

### TEST-D150: Exact patch plan for lifecycle provenance and canonical-first reads

Use file or code tools to inspect lifecycle assembly, approval linkage loading, realtime-event linkage, and any lifecycle diagnostics. Identify the exact patch points needed for canonical-linkage-first reads plus fallback provenance fields, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Name the reader path, provenance field additions, and diagnostics path separately.
- Include one response-shape example and one regression test to add.

### TEST-D153: Exact patch plan for two-worker harness coverage

Use file or code tools to inspect durable execution tests or adjacent harnesses. Identify the exact patch points needed to add a real two-worker claim and recovery test instead of relying on single-process behavior, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Name the harness entrypoint, worker orchestration helper, and assertion surface.
- Define exactly two new scenarios: claim race and lease-expiry recovery.
- Include the failure signature each scenario should surface.

### TEST-D154: Exact patch plan for approval-effects hardening

Use file or code tools to inspect approval resolution, downstream effect handling, and operator-visible effect status paths. Identify the exact patch points needed to add idempotent effect tracking or an outbox path without corrupting canonical approval state, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Separate canonical approval writes from downstream effect tracking writes.
- Name the idempotency key or dedupe mechanism you would use.
- Include one migration or rollout risk and one proving test.
