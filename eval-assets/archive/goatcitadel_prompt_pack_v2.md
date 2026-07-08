# GoatCitadel Prompt Pack v2

Expanded overnight hardening pack for recently added GoatCitadel capabilities. This version intentionally rewrites the prompt shapes instead of reusing the earlier focused prompts, and extends the pack so smaller local models can be stress-tested for a longer overnight run.

# Chat

## No Tools

### TEST-C101: Operator-visible precedence conflict

An operator asks why a workspace instruction overrode a remembered preference while a repo doc seemed to say something else. Explain the effective precedence GoatCitadel should follow and what it should surface so the operator is not surprised. Keep the answer concise and do not invent hidden files or hidden state.

### TEST-C102: Stale memory answer shape

Write the kind of answer GoatCitadel should give when a memory hit may be stale and live verification is unavailable. Explicitly separate what is known, what is uncertain, and the next verification step.

### TEST-C103: Reviewable memory lifecycle

Describe the operator-facing lifecycle for memory context packs and QMD-style distillation runs as a review checklist: what can expire, what should be pruned, and what should never be auto-promoted without human judgment.

### TEST-C104: Prompt-pack drift incident

An imported Prompt Lab pack, a markdown source file, and a generated report no longer agree. Explain the trust-preserving source-of-truth policy GoatCitadel should follow and what the operator should see.

### TEST-C113: User preference versus workspace override incident

A durable user preference conflicts with a workspace rule during an active task. Explain the user-visible resolution behavior and how GoatCitadel should avoid silent preference leaks across workspaces.

### TEST-C114: Report-only versus mutating maintenance

Explain the operator-facing difference between a report-only maintenance run and an auto-mutating maintenance run in GoatCitadel, as if you were warning a new operator what trust boundary changes.

### TEST-C115: Skill import outcome language

Write the operator-facing explanation GoatCitadel should give for four skill-import outcomes: install, overlap, reference-only, and reject. Focus on why each outcome happened and what the operator can do next.

### TEST-C116: Choosing the right Prompt Lab action

Explain when an operator should choose a single rerun, a replay regression run, or a benchmark matrix. Make the answer decision-oriented rather than descriptive.

### TEST-C125: High-trust temporal caveat

Give a compact operator-facing answer for when GoatCitadel cannot confirm whether repo guidance is newer than workspace guidance. The answer must be honest, non-alarmist, and explicit about uncertainty.

### TEST-C126: No-inspection conflict explanation

Without assuming tool access, explain how GoatCitadel should answer when two docs appear to conflict and it cannot verify which one is authoritative right now. Keep the answer practical and high-trust.

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

## Explicit Tools

### TEST-C109: Exact evidence for guidance precedence

Use file or code tools to inspect the current guidance-loading chain. Cite the exact files used and explain the precedence order you actually observed, plus one point that still looks ambiguous.

### TEST-C110: Exact evidence for v1 versus v2 scope

Use file tools to inspect `goatcitadel_prompt_pack.md` and `goatcitadel_prompt_pack_v2.md`. Explain how v2 differs in intent, shape, and operator use, without describing it as a mini-clone of v1.

### TEST-C111: Exact evidence for skill import provenance

Use file or code tools to inspect how repo-managed imported skills record trust metadata in `skills/extra/<skill-id>/source.json`. Summarize the fields an operator can actually use during overlap or provenance review.

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

# Cowork

## No Tools

### TEST-W101: Roles in order Product, Architect, QA

Create role-labeled sections for an overnight qwen-focused prompt-pack slice that tests fresh failure modes instead of repeating already-patched prompts. Keep the sections in the requested order. Do not add a synthesis section.

### TEST-W102: Roles in order Researcher, QA

Produce role-labeled sections defining how GoatCitadel should score retrieval honesty when evidence is partial, stale, or contradictory. Keep the requested role order and do not add extra headings.

### TEST-W103: Roles in order Product, Ops

Produce role-labeled sections for an overnight report-only evaluation run that may take many hours but must still leave the operator with one safe next action in the morning.

### TEST-W104: Roles in order Product, Researcher

Produce role-labeled sections arguing for and against a memory-freshness tier in GoatCitadel that builds on existing primitives instead of replacing them.

### TEST-W113: Roles in order Architect, Product, QA

Produce role-labeled sections for expanding v2 into a longer overnight pack without drifting into generic duplicates from the frozen baseline.

### TEST-W114: Roles in order Product, Ops, Researcher

Produce role-labeled sections for an operator playbook that distinguishes pack drift, score drift, and provider drift after an overnight evaluation run.

### TEST-W115: Roles in order Researcher, Architect, QA

Produce role-labeled sections defining how GoatCitadel should report unresolved conflicts between workspace guidance, repo docs, and remembered user preferences while preserving trust.

### TEST-W116: Roles in order Product, QA

Produce role-labeled sections for when Prompt Lab should show a result as "useful but not decision-grade" rather than simply pass or fail.

### TEST-W125: Roles in order Product, QA

Create role-labeled sections for a qwen-specific no-tools slice that tests strict section discipline, no extra headings, and uncertainty labeling. Keep the requested role order only.

### TEST-W126: Roles in order Researcher, Architect

Create role-labeled sections for a qwen-specific overnight pack that intentionally mixes prompts likely to trigger over-scaffolding, weak handoffs, and fake certainty. Keep the requested role order only.

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

Use file or code tools to inspect `apps/gateway/src/services/skill-import-service.ts`, repo-managed `source.json` metadata, and related trust logic. Produce role-labeled sections explaining the next fresh provenance and overlap checks.

### TEST-W130: Roles in order Researcher, Architect, QA

Use file or code tools to inspect prompt-pack judge target selection, score fallback behavior, and auto-score note rendering. Produce role-labeled sections with exact file citations and the most fragile remaining edge.

### TEST-W131: Roles in order Product, Ops

Use file or code tools to inspect prompt-pack source selection, import labeling, and export or report artifacts. Produce role-labeled sections for what an operator should trust first after an overnight run.

### TEST-W132: Roles in order Researcher, QA, Product

Use file or code tools to inspect repo-binding and tool-path resolution for prompt-pack runs. Produce role-labeled sections for the next negative-result honesty checks and cite the exact files used.

# Code

## No Tools

### TEST-D101: Overlapping skill family safeguard

Propose the smallest repo-native change that prevents users from installing multiple overlapping skill families into `skills/extra` while still allowing one clear primary choice.

### TEST-D102: Report-only update review path

Propose the smallest repo-native implementation path for a report-only update review job that checks dependency drift and source drift but never mutates installed state.

### TEST-D103: Memory freshness design spike

Propose a doc-only GoatCitadel memory-freshness layer over current memory context and distillation primitives. Keep it operator-visible and reversible.

### TEST-D104: Prompt Lab rollout slice

Propose the smallest rollout slice for an expanded overnight v2 pack so GoatCitadel can harden new behavior without rerunning the frozen baseline immediately.

### TEST-D113: Source-label provenance fix

Propose the smallest repo-native fix that preserves the real source label or file name when GoatCitadel auto-loads a prompt pack from an environment path.

### TEST-D114: Focused gate-runner targeting

Propose the smallest repo-native change that lets prompt-pack gate runs target a focused expansion pack without depending on legacy baseline-only codes.

### TEST-D115: Prompt-pack discoverability improvement

Propose the smallest repo-native improvement that makes it obvious which prompt-pack source files exist and which one Prompt Lab actually imported last.

### TEST-D116: Expanded v2 rollout with replay and trends

Propose the smallest repo-native rollout plan that uses replay regression, benchmark runs, and capability trends to harden a longer overnight v2 pack.

### TEST-D125: Stale-prompt retirement policy

Propose the smallest repo-native change that lets operators retire or quarantine stale prompt-pack tests without silently erasing historical scores.

### TEST-D126: Overnight wall-clock safeguard

Propose the smallest repo-native safeguard that helps operators target an overnight run length without turning Prompt Lab into a scheduler.

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
