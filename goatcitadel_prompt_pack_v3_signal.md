# GoatCitadel Prompt Pack v3.1 Signal

Expanded overnight hardening pack for recently added GoatCitadel capabilities. This version keeps the v2 coverage, raises the answer-quality bar, and tightens prompt contracts that were previously producing avoidable invalids, stale-default policy traps, or extra-heading noise instead of clean benchmark signal.

This pack is designed as a **drop-in v3 replacement** for v2:
- existing IDs `101-132` are preserved for compatibility
- new hardening-focused tests start at `133`
- pack-wide quality rules now apply to every prompt

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

### Precision rules for the `133+` hardening tests

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
- For exact-evidence prompts, prefer at least two local repo artifacts and optionally one remote artifact, such as a GitHub PR, issue, or design note, when it sharpens intended behavior.
- If remote evidence such as GitHub, PRs, or external docs is used, label it separately as **remote evidence** and do not let it override local repo truth unless the prompt explicitly asks for intended behavior rather than current behavior.

### Cross-system hardening targets

The added tests intentionally stress:
- paused versus waiting durable-run semantics
- approval wake ordering and skip or failure visibility
- multi-worker lease, heartbeat, and recovery ownership
- canonical linkage versus inferred linkage
- Mission Control truthfulness about canonical, inferred, and missing relationships
- explicit event links and classification versus repo-side inference
- partial-failure visibility across approval, durable, event, and UI paths
- degraded live-stream behavior versus durable or queryable truth

### Judge focus

Score answers on:
- provenance honesty
- canonical-versus-inferred discipline
- cross-system reasoning
- failure-path clarity
- operator-visible trustworthiness
- output-contract compliance

## Hardening Coverage Map

These new tests are aimed at the cross-system work in the durable / approval / lifecycle hardening plan:

- **Rank 1: paused versus waiting, wake correctness, operator-trust semantics**
  - Chat: `C133-C137`, `C139-C146`
  - Cowork: `W133`, `W135`, `W137`, `W139`, `W141`, `W144`
  - Code: `D133-D134`, `D138-D139`, `D147-D148`
- **Rank 2: storage-backed ownership, leases, heartbeats, multi-worker recovery**
  - Chat: `C138`, `C143`, `C147`
  - Cowork: `W136`, `W138`, `W143`
  - Code: `D133`, `D140-D143`, `D149`, `D153`
- **Rank 3: canonical linkage first, inference visibility, Mission Control truthfulness**
  - Chat: `C134`, `C140`, `C142`, `C144`, `C148-C150`
  - Cowork: `W134`, `W139-W140`, `W142`, `W145`
  - Code: `D135-D136`, `D144-D146`, `D150-D152`
- **Rank 4: approval effects visibility and idempotent downstream work**
  - Chat: `C137`, `C141`
  - Cowork: `W144`
  - Code: `D137`, `D154`

# Chat

## No Tools


### TEST-C101: Operator-visible precedence conflict

An operator asks why a workspace instruction overrode a remembered preference while a repo doc seemed to say something else. Explain the effective precedence GoatCitadel should follow and what it should surface so the operator is not surprised. Keep the answer concise and do not invent hidden files or hidden state.

Answer contract:
- Use exactly three bullets labeled `Precedence`, `Why it won`, and `What to surface`.
- Keep each bullet to one sentence.
- Keep the whole answer under 120 words.

### TEST-C102: Stale memory answer shape

Write the kind of answer GoatCitadel should give when a memory hit may be stale and live verification is unavailable. Explicitly separate what is known, what is uncertain, and the next verification step.

Answer contract:
- Use exactly three bullets labeled `Known`, `Uncertain`, and `Next verification step`.
- Keep each bullet to one sentence.
- Keep the whole answer under 110 words.

### TEST-C103: Reviewable memory lifecycle

Describe the operator-facing lifecycle for memory context packs and QMD-style distillation runs as a review checklist: what can expire, what should be pruned, and what should never be auto-promoted without human judgment.

Answer contract:
- Use exactly three bullets labeled `Can expire`, `Should be pruned`, and `Never auto-promote`.
- Each bullet must name one class of item and one operator expectation.
- Keep the whole answer under 140 words.

### TEST-C104: Prompt-pack drift incident

An imported Prompt Lab pack, a markdown source file, and a generated report no longer agree. Explain the trust-preserving source-of-truth policy GoatCitadel should follow and what the operator should see.

Answer contract:
- Use exactly three bullets labeled `Source of truth`, `What to show`, and `What not to trust`.
- Keep each bullet to one sentence.
- Keep the whole answer under 130 words.

### TEST-C113: User preference versus workspace override incident

A durable user preference conflicts with a workspace rule during an active task. Explain the user-visible resolution behavior and how GoatCitadel should avoid silent preference leaks across workspaces.

Answer contract:
- Use exactly three bullets labeled `Resolved by`, `What stays scoped`, and `What to surface`.
- `Resolved by` must name the winning scope.
- Keep the whole answer under 130 words.

### TEST-C114: Report-only versus mutating maintenance

Explain the operator-facing difference between a report-only maintenance run and an auto-mutating maintenance run in GoatCitadel, as if you were warning a new operator what trust boundary changes.

Answer contract:
- Return exactly two bullets labeled `Report-only` and `Auto-mutating`.
- Each bullet must name the trust boundary and the operator risk.
- Keep the whole answer under 100 words.

### TEST-C115: Skill import outcome language

Write the operator-facing explanation GoatCitadel should give for four skill-import outcomes: install, overlap, reference-only, and reject. Focus on why each outcome happened and what the operator can do next.

Answer contract:
- Return exactly four bullets in this order: `Install`, `Overlap`, `Reference-only`, `Reject`.
- Each bullet must contain why it happened and one next action.
- Keep each bullet to one sentence.

### TEST-C116: Choosing the right Prompt Lab action

Explain when an operator should choose a single rerun, a replay regression run, or a benchmark matrix. Make the answer decision-oriented rather than descriptive.

### TEST-C125: High-trust temporal caveat

Give a compact operator-facing answer for when GoatCitadel cannot confirm whether repo guidance is newer than workspace guidance. The answer must be honest, non-alarmist, and explicit about uncertainty.

### TEST-C126: No-inspection conflict explanation

Without assuming tool access, explain how GoatCitadel should answer when two docs appear to conflict and it cannot verify which one is authoritative right now. Keep the answer practical and high-trust.

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

### TEST-C135: Wake outcome language

Write concise operator-facing language for four approval-wake outcomes:
- wake succeeded
- wake skipped because the run was paused
- wake skipped because the run was not waiting
- wake failed after approval resolution

Keep the tone calm and specific.

Answer contract:
- Return exactly four bullets, one per outcome, in the listed order.
- Each bullet must contain:
  - the outcome label
  - the status distinction the operator should infer
  - the next safe operator action, if any
- Keep each bullet to one sentence.

### TEST-C136: Live feed degraded versus durable truth

A realtime stream gap occurs during an approval wake incident, but durable state remains queryable. Explain what an operator should trust first, what may be missing from the live feed, and how GoatCitadel should avoid overstating certainty.

Answer contract:
- Use exactly three bullets labeled `Trust first`, `May be missing`, and `Do not claim`.
- `Trust first` must name the durable or queryable source of truth.
- `May be missing` must mention at least one class of live event or UI update that could be absent.
- `Do not claim` must include one example of an overstatement GoatCitadel should avoid.

### TEST-C137: Partial-failure trust boundary

An approval is resolved, but downstream wake or follow-on work is not yet confirmed. Write the operator-facing explanation GoatCitadel should give without pretending the whole chain completed.

Answer contract:
- Use exactly two labeled bullets: `Approval state` and `Downstream effect`.
- `Approval state` must describe only the canonical approval fact.
- `Downstream effect` must describe the unresolved wake or follow-on status plus one verification step.
- Do not collapse both states into one success statement.

### TEST-C138: Multi-worker recovery explanation

One worker owns a durable-run lease and another worker sees the run but cannot recover it yet. Write the operator-facing explanation GoatCitadel should give for why the second worker did nothing and what should happen next.

Answer contract:
- Use exactly three bullets labeled `Current owner`, `Why no recovery happened`, and `What happens next`.
- Explain the non-action as intentional lease or ownership protection, not a silent failure.
- Include the condition that would permit recovery later.

## Implicit Tools


### TEST-C105: Repo-grounded guidance chain

Inspect the repo if needed and explain the current guidance resolution chain as three buckets: observed behavior, inferred behavior, and still-unclear behavior.

### TEST-C106: Repo-grounded memory review controls

Inspect the repo if needed and explain what operator-visible controls currently exist for memory context composition, QMD-style distillation, and lifecycle review. Separate existing controls from backend-heavy gaps.

### TEST-C107: Cron review traceability

Inspect the repo if needed and explain how a built-in report-only cron flow currently becomes visible to operators. Focus on reviewability, artifacts, and manual next steps.

### TEST-C108: Import provenance trust posture

Inspect the repo if needed and explain how GoatCitadel currently handles skill provenance, overlap review, and risky imports. Call out what looks enforced versus advisory.

### TEST-C117: Prompt Lab evaluation surface map

Inspect the repo if needed and explain the current Prompt Lab evaluation surfaces as an operator map: single runs, replay, benchmark, trends, and exports. Be explicit about what each surface can actually prove.

### TEST-C118: Workspace override loading today

Inspect the repo if needed and summarize how global guidance, workspace guidance, and repo docs are currently loaded. Present the answer as an observed chain plus one ambiguity worth testing.

### TEST-C119: Update review outputs today

Inspect the repo if needed and explain what a careful operator can currently inspect after an update-review style run. Focus on artifacts, cached summaries, and review queues.

### TEST-C120: Memory pack inspection today

Inspect the repo if needed and explain what an operator can currently list, inspect, or prune around memory context packs. Separate what is clearly supported from what still appears partial.

### TEST-C127: Prompt-pack source loading today

Inspect the repo if needed and explain how prompt-pack markdown is auto-loaded or imported today, including any source-label or source-of-truth ambiguity that remains.

### TEST-C128: Repo reality versus generated artifacts

Inspect the repo if needed and explain where prompt-pack reality lives today versus where generated artifacts are merely reports. Keep the answer grounded in exact repo behavior.

### TEST-C129: Benchmark caveats for small models

Inspect the repo if needed and explain what caveats an operator should keep in mind when reading benchmark or auto-score results for smaller local models. Separate policy from implementation evidence.

### TEST-C139: Repo-grounded pause/wait/resume boundary

Inspect the repo if needed and explain the current paused versus waiting behavior across durable runs, approval wake paths, and operator resume behavior. Present the answer as:
- confirmed behavior
- inferred behavior
- one ambiguity worth testing

Answer contract:
- Cite at least two repo artifacts or clearly say none were inspected.
- `confirmed behavior` must mention one observed path for `paused` and one for `waiting`.
- `inferred behavior` must not contain file-grounded certainty.
- `one ambiguity worth testing` must be a concrete seam, not a general wish.

### TEST-C140: Repo-grounded lifecycle provenance map

Inspect the repo if needed and explain how runtime lifecycle currently distinguishes canonical linkage, inferred linkage, and missing linkage across approvals, durable runs, sessions, and turns.

Answer contract:
- Use exactly four bullets labeled `Canonical`, `Inferred`, `Missing`, and `Overstatement risk`.
- Ground each of the first three bullets in a concrete observed data path or say it remains unproven.
- `Overstatement risk` must name one specific operator-facing phrase or surface that could imply too much certainty.

### TEST-C141: Repo-grounded partial-failure visibility

Inspect the repo if needed and explain whether approval resolution and downstream wake or effect work are currently one coherent transaction or several visible stages.

Answer contract:
- Use exactly three bullets labeled `Observed stages`, `Operator-visible evidence`, and `Still unclear`.
- `Observed stages` must say whether the chain is atomic or staged based on inspected evidence.
- `Operator-visible evidence` must list the artifact or surface an operator could actually see for each stage.
- `Still unclear` must name the missing proof.

### TEST-C142: Repo-grounded durable truth versus live truth

Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded but durable state, approval state, or lifecycle views still load. Separate:
- authoritative state
- projected state
- still-unclear state

Answer contract:
- Cite the exact files or APIs inspected if any.
- `authoritative state` must identify the durable source that should win.
- `projected state` must identify one smoothed or live-derived surface.
- `still-unclear state` must describe a concrete gap that the inspected code does not settle.

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

### TEST-C110: Exact evidence for v1 versus v2 scope

Use file tools to inspect `goatcitadel_prompt_pack.md` and `goatcitadel_prompt_pack_v2.md`. Explain how v2 differs in intent, shape, and operator use, without describing it as a mini-clone of v1.

### TEST-C111: Exact evidence for skill import provenance

Use file or code tools to inspect how repo-managed imported skills record trust metadata in `skills/extra/<skill-id>/`. Summarize the provenance fields an operator can actually use during overlap or provenance review.

Answer contract:
- Cite the exact files used.
- Return exactly three bullets labeled `Observed fields`, `Operator-usable fields`, and `Still ambiguous`.
- Do not return JSON.

### TEST-C112: Exact evidence for update review wiring

Use file or code tools to inspect the current update-review implementation, including any cron seed, report artifact path, or review queue behavior. Cite the exact files used.

### TEST-C121: Exact evidence for memory routes

Use file or code tools to inspect memory routes, memory context services, and any related UI or copy. Explain the current operator-facing lifecycle with exact citations from the files you used.

### TEST-C122: Exact evidence for Prompt Lab benchmark and replay

Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend/report wiring. Explain what each file owns and what an operator can and cannot infer from the outputs.

### TEST-C123: Exact evidence for workspace override resolution

Use file or code tools to inspect how GoatCitadel resolves global docs, workspace docs, and repo guidance at runtime. Summarize the observed chain and cite the exact files used.

### TEST-C124: Exact evidence for overlap and provenance review

Use file or code tools to inspect the skill import path, overlap handling, and provenance review evidence. Summarize what an operator can concretely inspect today and cite the exact files used.

### TEST-C130: Exact evidence for tool-path binding

Use file or code tools to inspect repo/project binding and tool-path resolution for prompt-pack runs. Explain how repo-bound explicit-tool prompts are anchored today, with exact file citations.

### TEST-C131: Exact evidence for prompt-pack source labeling

Use file or code tools to inspect prompt-pack import, source labeling, and export rendering. Explain where the real source label comes from today and where silent drift could still occur.

### TEST-C132: Exact evidence for result interpretation surfaces

Use file or code tools to inspect report rendering, trend rendering, and benchmark status/report APIs. Explain what evidence each surface exposes to an operator and cite the exact files used.

### TEST-C145: Exact evidence for paused versus waiting enforcement

Use file or code tools to inspect durable-run wake logic, approval wake helpers, and any operator resume path.

Answer contract:
- Cite at least three exact files.
- Use exactly four bullets labeled `Files inspected`, `Observed disjointness`, `Counterexample not found`, and `Implicit invariant`.
- `Observed disjointness` must name the check or branch that keeps `paused` distinct from `waiting`, if it exists.
- `Counterexample not found` must state the negative search result plainly.

### TEST-C146: Exact evidence for approval wake ordering

Use file or code tools to inspect approval wait resolution, downstream wake calls, and operational event emission.

Answer contract:
- Cite the exact files used.
- Present the answer as a numbered sequence of the observed write or call order.
- End with two bullets labeled `Operator-visible partial failure` and `Still not proven`.
- If a step was inferred rather than observed, label it inline as `(inferred)`.

### TEST-C147: Exact evidence for multi-worker durable ownership

Use file or code tools to inspect durable claim, recovery, heartbeat, lease, or run-processing logic.

Answer contract:
- Cite the exact files used.
- Use exactly four bullets labeled `Ownership model`, `Persistence evidence`, `Local-only evidence`, and `First two-worker failure`.
- `First two-worker failure` must name the first concrete race or double-processing symptom you expect.

### TEST-C148: Exact evidence for canonical linkage versus inference

Use file or code tools to inspect lifecycle assembly, approval linkage loading, realtime-event linkage, and Mission Control approvals or runtime views.

Answer contract:
- Cite the exact files used.
- Use exactly three bullets labeled `Canonical path`, `Inference path`, and `Fallback gap`.
- `Canonical path` must name the authoritative field, table, or response source if present.
- `Inference path` must name the code path that fills gaps from payload, preview, or events.
- Do not return a table.

### TEST-C149: Exact evidence for operator truth labeling

Use file or code tools to inspect Mission Control approvals, runtime, and live-feed UI plus the related APIs.

Answer contract:
- Cite the exact files used.
- Use exactly four bullets labeled `Canonical label`, `Inferred label`, `Missing label`, and `UI honesty gap`.
- If any label does not exist, say so directly instead of paraphrasing intent.

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

### TEST-W102: Roles in order Researcher, QA

Produce role-labeled sections defining how GoatCitadel should score retrieval honesty when evidence is partial, stale, or contradictory. Keep the requested role order and do not add extra headings.

Answer contract:
- Keep exactly these sections in order: `Researcher`, `QA`.
- Do not add any intro, recap, or synthesis section.
- `Researcher` must define three evidence states: partial, stale, contradictory.
- `QA` must define one scoring probe per state.

### TEST-W103: Roles in order Product, Ops

Produce role-labeled sections for an overnight report-only evaluation run that may take many hours but must still leave the operator with one safe next action in the morning.

Answer contract:
- Keep exactly these sections in order: `Product`, `Ops`.
- Do not add any intro, recap, or synthesis section.
- `Product` must define the trust boundary and the one safe morning action.
- `Ops` must define timeout, artifact minimums, and the first morning check.
- Keep the whole answer under 180 words.

### TEST-W104: Roles in order Product, Researcher

Produce role-labeled sections arguing for and against a memory-freshness tier in GoatCitadel that builds on existing primitives instead of replacing them.

Answer contract:
- Keep exactly these sections in order: `Product`, `Researcher`.
- Do not add any intro, recap, or synthesis section.
- `Product` must argue for the tier in exactly two bullets.
- `Researcher` must argue against it in exactly two bullets.

### TEST-W113: Roles in order Architect, Product, QA

Produce role-labeled sections for expanding v2 into a longer overnight pack without drifting into generic duplicates from the frozen baseline.

Answer contract:
- Keep exactly these sections in order: `Architect`, `Product`, `QA`.
- Do not add any intro, recap, or synthesis section.
- `Architect` must name exactly three non-duplicate additions.
- `Product` must say what new operator decision each one unlocks.
- `QA` must give one regression signal per addition.

### TEST-W114: Roles in order Product, Ops, Researcher

Produce role-labeled sections for an operator playbook that distinguishes pack drift, score drift, and provider drift after an overnight evaluation run.

Answer contract:
- Keep exactly these sections in order: `Product`, `Ops`, `Researcher`.
- Do not add any intro, recap, or synthesis section.
- Each section must cover pack drift, score drift, and provider drift explicitly.
- Keep the whole answer under 220 words.

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

### TEST-W125: Roles in order Product, QA

Create role-labeled sections for a qwen-specific no-tools slice that tests strict section discipline, no extra headings, and uncertainty labeling. Keep the requested role order only.

Answer contract:
- Keep exactly these sections in order: `Product`, `QA`.
- Do not add any intro, recap, or synthesis section.
- `Product` must name exactly three slice goals.
- `QA` must define exactly three checks aligned to those goals.

### TEST-W126: Roles in order Researcher, Architect

Create role-labeled sections for a qwen-specific overnight pack that intentionally mixes prompts likely to trigger over-scaffolding, weak handoffs, and fake certainty. Keep the requested role order only.

Answer contract:
- Keep exactly these sections in order: `Researcher`, `Architect`.
- Do not add any intro, recap, or synthesis section.
- `Researcher` must name exactly three failure modes.
- `Architect` must map each failure mode to one prompt shape.

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

### TEST-W135: Roles in order Ops, Product, QA

Produce role-labeled sections for the operator playbook when an approval is resolved, the durable run remains paused, and live updates are degraded. Keep the requested role order only.

Answer contract:
- `Ops` must provide a three-step operator checklist.
- `Product` must define the exact operator-facing status wording.
- `QA` must define the single regression test that proves the wording does not imply auto-resume.
- End the `QA` section with one safe next action for the operator.

### TEST-W136: Roles in order Architect, Product

Produce role-labeled sections for an overnight extension pack that stresses multi-worker lease recovery, restart safety, and cross-system partial failures without duplicating baseline prompts. Keep the requested role order only.

Answer contract:
- `Architect` must name exactly four new tests: one lease exclusivity, one lease expiry recovery, one restart safety, and one partial-failure visibility test.
- `Product` must justify why each test is new signal rather than a duplicate of baseline behavior.

## Implicit Tools


### TEST-W105: Roles in order Architect, Coder, QA

Inspect the repo if needed and produce role-labeled sections describing the smallest fresh regression slice for guidance precedence, repo binding, and operator-visible override clarity.

### TEST-W106: Roles in order Architect, Ops, QA

Inspect the repo if needed and produce role-labeled sections for how a built-in report-only cron flow should surface artifacts, review items, and manual recovery after a long run.

### TEST-W107: Roles in order Researcher, Architect, Product

Inspect the repo if needed and produce role-labeled sections explaining how requested external skills should be classified into install, overlap, conditional, reference-only, or reject buckets.

### TEST-W108: Roles in order Architect, QA

Inspect the repo if needed and produce role-labeled sections for how replay, benchmark, and trend views should be used together before trusting a prompt-pack expansion.

### TEST-W117: Roles in order Architect, Product, QA

Inspect the repo if needed and produce role-labeled sections describing the smallest high-signal benchmark matrix for an overnight qwen-focused extension pack.

### TEST-W118: Roles in order Researcher, Architect, Product

Inspect the repo if needed and produce role-labeled sections describing the current workspace override model and the most valuable next simplification for operators.

### TEST-W119: Roles in order Architect, QA

Inspect the repo if needed and produce role-labeled sections describing the current lifecycle of memory context packs and the highest-value expiry or pruning regression to add next.

### TEST-W120: Roles in order Researcher, Product

Inspect the repo if needed and produce role-labeled sections describing how GoatCitadel should explain overlap, reject, conditional, and reference-only skill outcomes to advanced operators.

### TEST-W127: Roles in order Architect, QA, Product

Inspect the repo if needed and produce role-labeled sections for the smallest qwen-specific rerun slice that would validate judge defaults, report wording, and role-order discipline.

### TEST-W128: Roles in order Researcher, Product, QA

Inspect the repo if needed and produce role-labeled sections for how Prompt Lab should message observed, inferred, and missing-evidence claims in overnight reports.

### TEST-W129: Roles in order Ops, Architect, QA

Inspect the repo if needed and produce role-labeled sections for running an overnight prompt-pack extension safely, including when to stop, resume, or distrust the final report.

### TEST-W137: Roles in order Architect, QA, Product

Inspect the repo if needed and produce role-labeled sections describing the smallest high-signal seam suite for Rank 1 hardening: paused versus waiting, approval wake skips, and operator-visible wake outcomes.

Answer contract:
- Cite the exact files inspected if any.
- `Architect` must name the smallest suite and why each test belongs.
- `QA` must give setup, act, assert, and failure signature for each test.
- `Product` must state the operator-visible behavior each test protects.

### TEST-W138: Roles in order Researcher, Architect, QA

Inspect the repo if needed and produce role-labeled sections describing the highest-signal multi-worker lease and recovery matrix for overnight testing. Keep the requested role order only.

Answer contract:
- `Researcher` must identify the ownership facts already proven versus assumed.
- `Architect` must define a matrix with exact rows for claim race, heartbeat freshness, lease expiry, and recovery.
- `QA` must attach an observable and failure signature to each row.

### TEST-W139: Roles in order Product, Ops, QA

Inspect the repo if needed and produce role-labeled sections for operator-trust checks covering:
- canonical versus inferred linkage
- degraded live feed
- approval resolved but downstream work not yet confirmed

Keep the requested role order only.

Answer contract:
- `Product` must define the operator trust promise for each of the three listed conditions.
- `Ops` must name the first surface the operator should trust and the fallback surface.
- `QA` must define one concrete check per condition that would catch overstated certainty.

### TEST-W140: Roles in order Architect, QA

Inspect the repo if needed and produce role-labeled sections for the smallest regression slice that proves explicit event links and classification survive from producer to operator-visible surfaces. Keep the requested role order only.

Answer contract:
- `Architect` must name the minimal producer -> storage -> API/UI path under test.
- `QA` must give one test for happy-path propagation and one test for missing-field honesty.

## Explicit Tools


### TEST-W109: Roles in order Researcher, Architect, QA

Use file or code tools to inspect workspace routes, guidance docs, and related services. Produce role-labeled sections for the first fresh regression checks to add, and cite the exact files used.

### TEST-W110: Roles in order Architect, QA

Use file or code tools to inspect memory routes and memory context services. Produce role-labeled sections on the current admin lifecycle, residual risks, and the single most useful new overnight check.

### TEST-W111: Roles in order Researcher, Product

Use file or code tools to inspect `apps/gateway/src/services/skill-import-service.ts` plus related vetting or overlap logic. Produce role-labeled sections deciding which fresh overlap cases should be added next.

### TEST-W112: Roles in order Ops, QA

Use file or code tools to inspect the update-review implementation and artifact or report path. Produce role-labeled sections explaining how an operator should read the output after a long unattended run.

### TEST-W121: Roles in order Researcher, Architect, QA

Use file or code tools to inspect Prompt Lab benchmark, replay regression, and capability trend files. Produce role-labeled sections recommending the first fresh overnight regression checks and cite the exact files used.

### TEST-W122: Roles in order Ops, QA, Product

Use file or code tools to inspect update-review scheduling, artifact generation, and operator summary behavior. Produce role-labeled sections for operating this flow safely and cite the exact files used.

### TEST-W123: Roles in order Researcher, Architect

Use file or code tools to inspect workspace loading, guidance docs, and project-binding behavior. Produce role-labeled sections summarizing the effective override chain and cite the exact files used.

### TEST-W124: Roles in order Researcher, Product, QA

Use file or code tools to inspect `apps/gateway/src/services/skill-import-service.ts`, repo-managed imported-skill provenance metadata, and related trust logic. Produce role-labeled sections explaining the next fresh provenance and overlap checks.

Answer contract:
- Cite the exact files used.
- Keep exactly these sections in order: `Researcher`, `Product`, `QA`.
- Do not add any intro, recap, or synthesis section.
- Do not return JSON.

### TEST-W130: Roles in order Researcher, Architect, QA

Use file or code tools to inspect prompt-pack judge target selection, score fallback behavior, and auto-score note rendering. Produce role-labeled sections with exact file citations and the most fragile remaining edge.

### TEST-W131: Roles in order Product, Ops

Use file or code tools to inspect prompt-pack source selection, import labeling, and export or report artifacts. Produce role-labeled sections for what an operator should trust first after an overnight run.

### TEST-W132: Roles in order Researcher, QA, Product

Use file or code tools to inspect repo-binding and tool-path resolution for prompt-pack runs. Produce role-labeled sections for the next negative-result honesty checks and cite the exact files used.

### TEST-W141: Roles in order Researcher, Architect, QA

Use file or code tools to inspect durable, approval, lifecycle, and Mission Control files. Produce role-labeled sections recommending the first exact cross-system regression additions, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- `Researcher` must summarize the most relevant observed seam evidence.
- `Architect` must recommend exactly three new regressions.
- `QA` must define the pass condition and failure signature for each regression.

### TEST-W142: Roles in order Ops, QA, Product

Use file or code tools to inspect Mission Control approvals and live-feed UI plus related lifecycle APIs. Produce role-labeled sections for the operator-visible failure matrix the pack should test, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- `Ops` must define the operator-visible surfaces in scope.
- `QA` must present a matrix with exact rows for canonical-missing, inferred-only, live-feed-gap, and downstream-unconfirmed.
- `Product` must say which copy promises are protected by that matrix.

### TEST-W143: Roles in order Researcher, Architect

Use file or code tools to inspect durable claim, recovery, and worker-processing logic. Produce role-labeled sections defining the exact two-worker harness scenarios the overnight pack should add, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- `Researcher` must list the observed ownership assumptions.
- `Architect` must define exactly two harness scenarios: claim race and recovery after lease expiry.
- Each scenario must include trigger, expected winner, and failure signature.

### TEST-W144: Roles in order Researcher, Product, QA

Use file or code tools to inspect approval resolution, wake helpers, and downstream effect visibility. Produce role-labeled sections explaining which partial-failure cases must be added next and cite the exact files used.

Answer contract:
- Cite the exact files used.
- `Researcher` must distinguish canonical approval success from downstream uncertainty.
- `Product` must say what the operator must and must not infer.
- `QA` must propose exactly three partial-failure cases with setup, observable, and failure wording.

### TEST-W145: Roles in order Product, Ops, QA

Use file or code tools to inspect lifecycle response shaping and Mission Control rendering. Produce role-labeled sections for how the UI should present canonical, inferred, and missing relationships during hardening, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- `Product` must define the exact distinction the UI should communicate.
- `Ops` must define what an operator should check when the UI shows each state.
- `QA` must define one assertion per state that would fail if the UI silently promotes inference to truth.

# Code

## No Tools


### TEST-D101: Overlapping skill family safeguard

Propose the smallest repo-native change that prevents users from installing multiple overlapping skill families into `skills/extra` while still allowing one clear primary choice.

Answer contract:
- Use exactly three bullets labeled `Observed`, `Inferred fix`, and `Validation`.
- If the repo was not inspected, `Observed` must say `none`.
- Keep the whole answer under 150 words.

### TEST-D102: Report-only update review path

Propose the smallest repo-native implementation path for a report-only update review job that checks dependency drift and source drift but never mutates installed state.

Answer contract:
- Use exactly three bullets labeled `Observed`, `Smallest path`, and `Validation`.
- If the repo was not inspected, `Observed` must say `none`.
- Keep the whole answer under 150 words.

### TEST-D103: Memory freshness design spike

Propose a doc-only GoatCitadel memory-freshness layer over current memory context and distillation primitives. Keep it operator-visible and reversible.

Answer contract:
- Use exactly three bullets labeled `Observed`, `Design spike`, and `Reversal path`.
- If the repo was not inspected, `Observed` must say `none`.
- Keep the whole answer under 150 words.

### TEST-D104: Prompt Lab rollout slice

Propose the smallest rollout slice for an expanded overnight v2 pack so GoatCitadel can harden new behavior without rerunning the frozen baseline immediately.

Answer contract:
- Use exactly three bullets labeled `Observed`, `Smallest slice`, and `Validation`.
- If the repo was not inspected, `Observed` must say `none`.
- Keep the whole answer under 150 words.

### TEST-D113: Source-label provenance fix

Propose the smallest repo-native fix that preserves the real source label or file name when GoatCitadel auto-loads a prompt pack from an environment path.

Answer contract:
- Use exactly three bullets labeled `Observed`, `Inferred fix`, and `Validation`.
- If the repo was not inspected, `Observed` must say `none`.
- Keep the answer implementation-focused and under 150 words.

### TEST-D114: Focused gate-runner targeting

Propose the smallest repo-native change that lets prompt-pack gate runs target a focused expansion pack without depending on legacy baseline-only codes.

### TEST-D115: Prompt-pack discoverability improvement

Propose the smallest repo-native improvement that makes it obvious which prompt-pack source files exist and which one Prompt Lab actually imported last.

Answer contract:
- Use exactly three bullets labeled `Observed`, `Inferred improvement`, and `Validation`.
- If the repo was not inspected, `Observed` must say `none`.
- Keep the whole answer under 150 words.

### TEST-D116: Expanded v2 rollout with replay and trends

Propose the smallest repo-native rollout plan that uses replay regression, benchmark runs, and capability trends to harden a longer overnight v2 pack.

### TEST-D125: Stale-prompt retirement policy

Propose the smallest repo-native change that lets operators retire or quarantine stale prompt-pack tests without silently erasing historical scores.

### TEST-D126: Overnight wall-clock safeguard

Propose the smallest repo-native safeguard that helps operators target an overnight run length without turning Prompt Lab into a scheduler.

### TEST-D133: Runnable-not-running wake contract

Propose the smallest repo-native change that makes wake or resume move a durable run into a **claimable** state rather than immediately treating it as actively running once storage-backed worker ownership exists.

Answer contract:
- Name the subsystem boundary being changed.
- Specify the state transition before and after the change.
- Name the type, enum, or status field that must change.
- Include one targeted validation step and the failure signature it would catch.

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

### TEST-D137: Rank 1 to Rank 4 effect-state bridge

Propose the smallest repo-native data-shape change that lets Rank 1 wake-status hardening land now without forcing the repo to carry two conflicting approval-effect state machines when a later outbox pipeline is added.

Answer contract:
- Name the new data shape.
- State which existing state it replaces or wraps.
- Explain how it remains compatible with a later outbox or effect pipeline.
- Include one migration or compatibility risk and one test.

## Implicit Tools


### TEST-D105: Minimal wrapped-dependents parser test

Inspect the repo if needed and propose the exact minimal automated test that proves GoatCitadel can parse `pnpm outdated -r` output even when the dependents column wraps.

### TEST-D106: Minimal duplicate-family install test

Inspect the repo if needed and propose the exact minimal automated test that proves overlapping skill families are blocked from being installed into `skills/extra`.

### TEST-D107: Minimal v2 parser distinction test

Inspect the repo if needed and propose the exact minimal automated test that proves `goatcitadel_prompt_pack_v2.md` parses cleanly and remains distinct from the frozen baseline.

### TEST-D108: Minimal cron seed test

Inspect the repo if needed and propose the exact minimal automated check that proves the daily update review job is treated as a first-party built-in cron job.

### TEST-D117: Minimal source-label preservation test

Inspect the repo if needed and propose the exact minimal automated test that proves an env-loaded prompt pack preserves its real source label instead of being mislabeled.

### TEST-D118: Minimal focused-pack gate selection test

Inspect the repo if needed and propose the exact minimal automated test that proves gate selection can intentionally target an expansion pack without silently preferring the older baseline.

### TEST-D119: Minimal workspace guidance precedence test

Inspect the repo if needed and propose the exact minimal automated check that keeps workspace-scoped guidance precedence both stable and operator-visible.

### TEST-D120: Minimal memory lifecycle admin test

Inspect the repo if needed and propose the exact minimal automated check that supports operator review and pruning of memory context packs.

### TEST-D127: Minimal judge-default selection test

Inspect the repo if needed and propose the exact minimal automated test that proves prompt-pack judging prefers the dedicated judge target when a stronger provider or model is available.

### TEST-D128: Minimal cowork extra-heading regression test

Inspect the repo if needed and propose the exact minimal automated test that catches small models adding fake cowork headings or inline contract echoes.

### TEST-D129: Minimal negative-result honesty test

Inspect the repo if needed and propose the exact minimal automated test that proves repo-bound explicit-tool prompts report searched paths and missing evidence honestly.

### TEST-D138: Minimal paused-run wake skip test

Inspect the repo if needed and propose the exact minimal automated test that proves approval resolution does **not** resume a paused durable run, including linked wake-helper paths when they exist.

Answer contract:
- Name the target test file or suite.
- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.
- `Assert` must include both the paused state and the absence of an auto-resume side effect.

### TEST-D139: Minimal wake-ordering integrity test

Inspect the repo if needed and propose the exact minimal automated test that proves approval-wait state is not marked complete before a durable wake is actually confirmed.

Answer contract:
- Name the target test file or suite.
- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.
- `Assert` must distinguish pre-wake, wake-attempt, and post-confirmation state.

### TEST-D140: Minimal two-worker claim exclusivity test

Inspect the repo if needed and propose the exact minimal automated test that proves two workers sharing one database cannot both claim the same queued durable run.

Answer contract:
- Name the target harness or test file.
- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.
- `Assert` must prove one winner and one loser against the same queued run.

### TEST-D141: Minimal lease-expiry recovery test

Inspect the repo if needed and propose the exact minimal automated test that proves an expired durable-run lease can be recovered by a different worker without requeueing a still-active leased run.

Answer contract:
- Name the target harness or test file.
- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.
- `Assert` must cover both expiry recovery and the negative case for an active lease.

### TEST-D142: Minimal retry-backoff claim gating test

Inspect the repo if needed and propose the exact minimal automated test that proves retry-gated queued durable runs are not claimed before their backoff window expires.

Answer contract:
- Name the target test file or suite.
- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.
- `Assert` must cover before-window and after-window claim behavior.

### TEST-D143: Minimal lease-release transition test

Inspect the repo if needed and propose the exact minimal automated test that proves waiting, paused, and terminal durable-run transitions release any active lease.

Answer contract:
- Name the target test file or suite.
- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.
- `Assert` must cover all three transitions separately.

### TEST-D144: Minimal canonical-over-inferred lifecycle test

Inspect the repo if needed and propose the exact minimal automated test that proves runtime lifecycle prefers canonical linkage over payload, preview, or event inference when they disagree, and that diagnostics expose the fallback path.

Answer contract:
- Name the target test file or suite.
- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.
- `Setup` must create a disagreement between canonical and inferred data.
- `Assert` must cover both chosen linkage and emitted diagnostics.

### TEST-D145: Minimal explicit-event-link propagation test

Inspect the repo if needed and propose the exact minimal automated test that proves explicit `eventClass`, `eventAuthority`, and `links` survive from event producer to storage to operator-facing API.

Answer contract:
- Name the target test file or suite.
- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.
- `Assert` must name all three fields at producer, persisted, and operator-facing stages.

### TEST-D146: Minimal no-canonical-run UI honesty test

Inspect the repo if needed and propose the exact minimal automated test that proves Mission Control approval views show “no canonical durable run linked” rather than guessing from a projected list.

Answer contract:
- Name the target UI test file or suite.
- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.
- `Setup` must include projected or inferred run-like data without a canonical run link.

## Explicit Tools


### TEST-D109: Exact patch plan for skill import trust metadata

Use file or code tools to inspect `apps/gateway/src/services/skill-import-service.ts` and identify the exact patch points needed to strengthen provenance metadata, overlap handling, and operator review posture.

### TEST-D110: Exact patch plan for `update-review-daily`

Use file or code tools to inspect built-in cron wiring and identify the exact insertion points needed to add or harden `update-review-daily`, artifact generation, and review queue behavior.

### TEST-D111: Exact assertions for v2 pack identity

Use file or code tools to inspect prompt-pack parsing tests and identify the exact assertions needed so GoatCitadel keeps the expanded v2 pack distinct from the frozen baseline.

### TEST-D112: Exact file-grounded memory freshness design

Use file or code tools to inspect GoatCitadel memory routes and memory context services, then draft a compact memory-freshness design plan grounded in the exact files you inspected.

### TEST-D121: Exact patch plan for env-loaded prompt-pack provenance

Use file or code tools to inspect `apps/gateway/src/services/prompt-pack-service.ts` and identify the exact patch points needed so env-loaded prompt packs preserve their real source label or file name.

### TEST-D122: Exact patch plan for focused-pack gate selection

Use file or code tools to inspect `scripts/run-prompt-pack-gates.ts` and related prompt-pack APIs. Identify the exact patch points needed so gate runs can intentionally target the expanded overnight v2 pack.

### TEST-D123: Exact assertions for workspace guidance precedence

Use file or code tools to inspect workspace loading, guidance resolution, and related tests. Propose the exact assertions needed so GoatCitadel keeps workspace-scoped guidance precedence stable.

### TEST-D124: Exact rollout wiring for expanded v2 evaluation

Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend-reporting files. Draft an exact file-grounded rollout plan for evaluating the longer overnight v2 pack with minimal operational churn.

### TEST-D130: Exact patch plan for prompt-pack import metadata

Use file or code tools to inspect prompt-pack import, storage, and report or export rendering. Identify the exact patch points needed so operators can see source markdown identity, import time, and refresh provenance.

### TEST-D131: Exact patch plan for overnight extension targeting

Use file or code tools to inspect prompt-pack selection, benchmark inputs, and gate-runner APIs. Identify the exact patch points needed to support a qwen-focused overnight extension pack cleanly.

### TEST-D132: Exact patch plan for runtime telemetry in reports

Use file or code tools to inspect report rendering and benchmark status surfaces. Identify the exact patch points needed so operators can see per-model wall-clock timing and estimate overnight run length.

### TEST-D147: Exact patch plan for typed wake outcomes

Use file or code tools to inspect durable-run wake logic, approval-wait wake handling, and related operator-visible status shaping. Identify the exact patch points needed to add a typed wake outcome contract and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Name the contract file, producer call sites, and consumer call sites.
- Include one compatibility note and one validation step.

### TEST-D148: Exact patch plan for wake lifecycle ordering

Use file or code tools to inspect approval-wait storage, approval wake orchestration, and durable wake calls. Identify the exact patch points needed so wake lifecycle writes reflect actual outcome ordering, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Present the patch plan as ordered steps.
- Each step must name the file, function, and write or event ordering change.
- End with the partial-failure case the patch is meant to preserve visibly.

### TEST-D149: Exact patch plan for persisted durable leases

Use file or code tools to inspect durable-run storage, claim logic, recovery logic, and any worker-processing nudges. Identify the exact patch points needed for persisted leases, heartbeats, compare-and-swap safety, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Name the schema or storage changes, claim path changes, recovery path changes, and heartbeat path changes separately.
- Include one migration note and one two-worker validation step.

### TEST-D150: Exact patch plan for lifecycle provenance and canonical-first reads

Use file or code tools to inspect lifecycle assembly, approval linkage loading, realtime-event linkage, and any lifecycle diagnostics. Identify the exact patch points needed for canonical-linkage-first reads plus fallback provenance fields, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Name the reader path, provenance field additions, and diagnostics path separately.
- Include one response-shape example and one regression test to add.

### TEST-D151: Exact patch plan for Mission Control truth labeling

Use file or code tools to inspect approvals or runtime pages plus their backing APIs. Identify the exact patch points needed so the UI distinguishes canonical, inferred, and missing links without silently promoting projections to truth.

Answer contract:
- Cite the exact files used.
- Name the API field changes and UI rendering changes separately.
- Provide the exact label set the UI should use.
- Include one UI regression check.

### TEST-D152: Exact patch plan for explicit event authority envelope

Use file or code tools to inspect event producers, realtime-event storage, and related contracts. Identify the exact patch points needed so approval, run, session, task, and proactive events publish explicit `eventClass`, `eventAuthority`, and `links`, and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Separate the plan into producer contract, storage contract, and consumer contract.
- Name at least one event family that already fits and one that requires a patch.
- Include one propagation test to add.

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
