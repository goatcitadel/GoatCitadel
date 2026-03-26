# GoatCitadel Prompt Pack v2

Focused regression pack for recently expanded GoatCitadel capabilities. This pack intentionally complements the frozen v1 baseline in `goatcitadel_prompt_pack.md` instead of recreating the same 108-test balance.

# Chat

## No Tools

### TEST-C101: Workspace guidance precedence

Explain how GoatCitadel should resolve conflicting guidance between global guidance, workspace guidance, and repo docs. Do not invent files or hidden state. Prefer a crisp operator-facing answer over a generic policy essay.

### TEST-C102: Retrieval honesty under uncertainty

You suspect a memory or retrieval result may be stale. Explain how GoatCitadel should answer without pretending the memory is current, and describe what high-trust behavior looks like for the user.

### TEST-C103: Memory lifecycle admin expectations

Describe the operator-facing lifecycle for memory context packs and QMD-style memory runs in GoatCitadel. Focus on what can expire, what should be pruned, and what still needs human judgment.

### TEST-C104: Prompt Lab source of truth

Explain how GoatCitadel should treat markdown prompt-pack files, imported SQLite rows, and generated artifacts so prompt packs do not drift silently.

## Implicit Tools

### TEST-C105: Recent workspace and guidance functionality

Inspect the current GoatCitadel repo if needed and explain what was recently added around workspaces and runtime guidance. Keep the answer grounded in repo reality rather than generic multi-workspace advice.

### TEST-C106: Recent memory admin and QMD behavior

Inspect the repo if needed and explain the current state of memory admin, memory context composition, and QMD or retrieval-related operator controls. Be explicit about what exists versus what is still partial.

### TEST-C107: Cron review behavior

Inspect the repo if needed and explain how GoatCitadel currently handles built-in cron jobs, cron review items, and operator-visible maintenance runs. Focus on trust and reviewability.

### TEST-C108: Skill import trust posture

Inspect the repo if needed and explain GoatCitadel's current skill import posture: provenance, validation, risk scoring, high-risk confirmation, and overlap handling.

## Explicit Tools

### TEST-C109: Trace workspace guidance precedence in the repo

Use file or code inspection tools to trace how workspace guidance and related docs are resolved today. Cite the exact files you used and summarize the effective precedence order you found.

### TEST-C110: Compare the v1 and v2 prompt-pack source files

Use file tools to inspect `goatcitadel_prompt_pack.md` and `goatcitadel_prompt_pack_v2.md`. Explain how the packs differ in scope and why v2 is not just a smaller copy of the v1 baseline.

### TEST-C111: Inspect repo-managed skill source metadata

Use file or code tools to inspect how GoatCitadel stores repo-managed import provenance in `skills/extra/<skill-id>/source.json`. Summarize the metadata fields that matter for trust, overlap review, and upstream drift checks.

### TEST-C112: Inspect the daily update review wiring

Use file or code tools to inspect the built-in daily update review job, its artifact path, and its review queue behavior. Cite the exact files you used.

# Cowork

## No Tools

### TEST-W101: Roles in order Product, Architect, QA

Create a short role-labeled plan for how GoatCitadel prompt-pack v2 should test recently added functionality without repeating the old 108-test balance. Keep the sections in the requested role order.

### TEST-W102: Roles in order Researcher, QA

Produce role-labeled sections that define what "retrieval honesty" should mean in GoatCitadel when memory is stale, incomplete, or ambiguous.

### TEST-W103: Roles in order Product, Ops

Produce role-labeled sections for a report-only daily update review workflow that never auto-upgrades packages or skills but still gives operators a useful next action.

### TEST-W104: Roles in order Product, Researcher

Produce role-labeled sections for a Sulcus-inspired GoatCitadel memory-temperature layer that builds on current memory and QMD primitives instead of replacing them.

## Implicit Tools

### TEST-W105: Roles in order Architect, Coder, QA

Inspect the repo if needed and produce role-labeled sections describing the smallest safe regression slice for workspace guidance precedence and workspace-scoped behavior.

### TEST-W106: Roles in order Architect, Ops, QA

Inspect the repo if needed and produce role-labeled sections describing how a new built-in cron job should surface report artifacts, review items, and manual follow-up without becoming an auto-updater.

### TEST-W107: Roles in order Researcher, Architect, Product

Inspect the repo if needed and produce role-labeled sections explaining how requested external skills should be classified into install, conditional, reference-only, overlap, or reject buckets.

### TEST-W108: Roles in order Architect, QA

Inspect the repo if needed and produce role-labeled sections for how Prompt Lab replay and regression features should be used against the new v2 pack before broader rollout.

## Explicit Tools

### TEST-W109: Roles in order Researcher, Architect, QA

Use file or code tools to inspect workspace routes, guidance docs, and related services. Produce role-labeled sections that explain what should be regression tested first and cite the exact files used.

### TEST-W110: Roles in order Architect, QA

Use file or code tools to inspect memory routes and memory context services. Produce role-labeled sections on the current admin lifecycle and the most important residual risks.

### TEST-W111: Roles in order Researcher, Product

Use file or code tools to inspect `apps/gateway/src/services/skill-import-service.ts` plus the bundled vetting and self-improvement skills. Produce role-labeled sections deciding which requested skills are overlaps versus install candidates.

### TEST-W112: Roles in order Ops, QA

Use file or code tools to inspect the daily update review implementation and its artifact/report path. Produce role-labeled sections explaining how an operator should interpret the output and what QA should verify after each run.

# Code

## No Tools

### TEST-D101: Overlapping Cloudflare family installs

Propose the smallest repo-native change that prevents users from installing multiple overlapping Cloudflare or DNS skills into `skills/extra` while still allowing one primary skill in that family.

### TEST-D102: Report-only update review

Propose the smallest repo-native implementation path for a daily update review job that checks dependency drift and skill source drift but never mutates lockfiles or installed skills.

### TEST-D103: Memory temperature design spike

Propose a doc-only GoatCitadel memory-temperature design layer over current memory context and QMD primitives. Keep it local-first and operator-visible.

### TEST-D104: Prompt Lab rollout slice

Propose the smallest Prompt Lab rollout slice for the new v2 pack so GoatCitadel can tighten recent feature quality without immediately rerunning the entire v1 baseline.

## Implicit Tools

### TEST-D105: Minimal parser test for wrapped dependents

Inspect the repo if needed and propose the exact minimal automated test that proves GoatCitadel can parse `pnpm outdated -r` output even when the dependents column wraps across multiple lines.

### TEST-D106: Minimal duplicate-family test

Inspect the repo if needed and propose the exact minimal automated test that proves overlapping skill families are blocked from being installed into `skills/extra`.

### TEST-D107: Minimal v2 prompt-pack parser test

Inspect the repo if needed and propose the exact minimal automated test that proves `goatcitadel_prompt_pack_v2.md` parses cleanly and stays distinct from the frozen v1 pack.

### TEST-D108: Minimal cron seed test

Inspect the repo if needed and propose the exact minimal automated check that proves the daily update review job is treated like a first-party built-in cron job.

## Explicit Tools

### TEST-D109: Exact patch plan for skill import trust metadata

Use file or code tools to inspect `apps/gateway/src/services/skill-import-service.ts` and propose the exact surgical patch points needed to add provenance metadata, overlap detection, and safe review posture for requested skills.

### TEST-D110: Exact patch plan for update review daily

Use file or code tools to inspect the built-in cron wiring and identify the exact insertion points needed to add `update-review-daily`, artifact generation, and a cron review queue entry.

### TEST-D111: Exact assertions for the v2 pack

Use file or code tools to inspect prompt-pack parsing tests and propose the exact assertions needed so GoatCitadel keeps the v2 pack distinct from the v1 baseline.

### TEST-D112: Exact file-grounded memory-temperature design

Use file or code tools to inspect GoatCitadel's memory routes and memory context services, then draft a compact memory-temperature design plan grounded in the exact files you inspected.
