# GoatCitadel Full Code Review - 2026-06-11

## Scope

This review-first pass covered the canonical Mission Control Next and Gateway stack with emphasis on runtime correctness, feature wiring, chat display quality, visual drift, performance, and stale code. The worktree was already dirty, so this pass preserved existing changes and only edited confirmed local findings.

Baseline captured before fixes:

- Branch: `main`
- HEAD: `937fc08a75fa1ea838b403026047850018c22688`
- Remote `origin/main`: `937fc08a75fa1ea838b403026047850018c22688`
- Existing dirty areas included gateway orchestration/prompt-pack work, `docs/dependency-policy.md`, `pnpm-workspace.yaml`, generated screenshots/reports/logs, Windows `bin`/`obj` folders, and `workspace/goatcitadel_out`.
- `apps/mission-control` had generated/runtime residue only (`dist`, `dist-node`, `node_modules`, logs); no active source files were found.

## Review Probes

- CodeRabbit: repo-wide and `apps/gateway/src` scans were blocked by the 150-file limit; scoped `packages/policy-engine/src` completed and found the WhatsApp reaction host gap. Scoped `docs` review found a current 1.0 contract/release-evidence ambiguity plus many historical-plan comments.
- Chat stack: focused Mission Control shared and threaded-surface tests passed for thread primitives, renderer tail behavior, scroll-to-bottom, attachment previews, timeline, page, and composer.
- Stale code: searched legacy Mission Control residue, office/pixel assets, route adapters, generated folders, and review-doc artifacts. No source deletion was proven safe in this pass.
- Visual: `verify:visual:regression` rendered the route matrix and produced screenshot artifacts, but failed on 40 diff-ratio cases. Console/page errors were 0 in the inspected failures.

## Fix Ledger

| ID | Severity | Subsystem | Finding | Fix | Validation | Residual Risk |
|---|---:|---|---|---|---|---|
| F-01 | P1 | Durable verification / Gateway dev diagnostics | `verify:durable:recovery` failed because the stack scenario performed a live API read before restart and could race the active worker while proving an orphaned approval-wait run. | `dev-verification` seed now returns raw seeded run statuses; the scenario asserts the seed payload, stops the first gateway immediately, then proves recovery after restart. | `pnpm verify:durable:recovery` passed (`artifacts/verification/2026-06-11T20-20-58-809Z-durable-recovery-e6debc66`); focused route test passed. | This fixes proof determinism, not a production durable-run bug. |
| F-02 | P2 | Policy engine / channels | `whatsapp.react` was missing the fixed outbound host mapping for Graph API access. | Added `whatsapp.react -> graph.facebook.com` and a focused test. | Focused policy test passed; policy-engine typecheck passed earlier; workspace typecheck passed. | `packages/policy-engine/src/tool-executor.ts` has unrelated pre-existing search-performance edits in the same diff. |
| F-03 | P3 | Release governance docs | `docs/1_0_CONTRACT.md` release gates could be read as excluding release-certificate-only checks. | Added a short clarification that release-certificate evidence is mapped through `release-certificate.json` and `docs/1_0_RELEASE_EVIDENCE.md`. | `pnpm docs:check` passed. | Historical docs review comments were not rewritten. |

## Feature And Integration Matrix

| Surface | Runtime Owner | Implementation Quality | Cross-Feature Behavior | Tests / Proof | Gaps |
|---|---|---|---|---|---|
| Chat | Gateway chat runtime, durable execution, shared chat packages | Good: shared rendering primitives, bottom-scroll hooks, attachment previews, and timeline tests are present. | Uses shared activity/runtime layers; approvals and user-input states are visible in visual scenarios. | Chat focused Vitest suites passed; `verify:fast`, `verify:runtime:truth`, and surface regression passed. | Visual diffs remain for laptop/mobile chat and blocked-state variants. |
| Cowork | Gateway orchestration, durable runs, approvals | Good runtime ownership; no bypass found in this pass. | Approval wait and restart recovery proof is now deterministic. | Durable recovery, runtime truth, surface regression passed. | Visual diffs remain for Cowork and board variants. |
| Code | Gateway Code Mode, policy engine, durable execution | Boundaries remain consistent with trusted-code, approval-gated posture. | Policy allowlists now cover WhatsApp reactions; no hostile-sandbox claim added. | Typecheck, policy focused test, perf budgets passed. | Desktop/laptop/narrow Code visual diffs remain. |
| Projects | Gateway/project APIs through Mission Control Next | No current issue found. | Fits route continuity and canonical shell expectations. | Visual route passed in sampled variants; surface regression passed. | None confirmed. |
| Library | Skills, memory, files, artifacts, capabilities, prompt packs | Generally wired to runtime/catalog owners. | Prompt-pack and memory surfaces are active and operator-visible. | Chat/library route coverage in visual lane; runtime truth passed. | Prompt-pack visual drift is the largest visual cluster; mobile memory diffs remain. |
| Ops | Gateway diagnostics, runtime, approvals, cost, quality | Strong ownership by Gateway/Ops routes. | Release and runtime proof lanes work; quality/kanban visual states need review. | `verify:runtime:truth`, `verify:surface:regression`, perf check passed. | Ops Quality and mobile Kanban visual diffs remain. |
| Settings | Gateway settings/provider/channel/auth/tool APIs | No confirmed wiring issue in this pass. | Settings routes largely stable across visual variants. | Settings variants mostly passed visual; surface regression passed. | Continue targeted checks when touching auth/provider/channel settings. |

## Dead-Code And Residue Ledger

| Area | Classification | Evidence | Decision |
|---|---|---|---|
| `apps/mission-control` | Generated/runtime residue | Search found no active source files, only generated build/runtime folders and logs. | Do not revive; do not delete generated local residue in this source review. |
| `packages/mission-control-shared/src/pixel-office` and Office canvas components | Retained asset / active references | Referenced by `OfficeCanvas`, `PixelOfficeCanvas`, public office assets, and manifest docs. | Keep unless a separate product decision removes the office/pixel experience. |
| Legacy route adapters in Mission Control Next | Deprecated-but-needed compatibility | `pnpm check:legacy:next` passed; no forbidden threaded legacy imports found. | Keep for route continuity until the legacy checker and route manifest say otherwise. |
| `docs/review/*`, `reports/*`, screenshots, `.scratch`, logs | Generated or review artifacts | Present as untracked local outputs before this pass. | Preserve; no cleanup performed. |
| Windows `bin`/`obj` folders | Generated build residue | Untracked under `apps/mission-control-windows`. | Preserve; cleanup belongs in a separate generated-output sweep. |

## Validation

Passed:

- `pnpm --dir apps/gateway exec vitest run src/routes/dev-verification.test.ts`
- `pnpm --filter @goatcitadel/policy-engine test -- tool-executor.test.ts -t "adds the fixed WhatsApp Graph host"`
- Chat focused Vitest suites in `@goatcitadel/mission-control-shared` and `@goatcitadel/mission-control-next`
- `pnpm docs:check`
- `pnpm typecheck`
- `pnpm verify:fast` (`artifacts/verification/2026-06-11T20-24-09-972Z-fast-c2878db9`)
- `pnpm verify:runtime:truth` (`artifacts/verification/2026-06-11T20-34-36-877Z-runtime-truth-a0afad36`)
- `pnpm verify:surface:regression` (`artifacts/verification/2026-06-11T20-34-36-879Z-surface-regression-8a8315fe`)
- `pnpm verify:durable:recovery` (`artifacts/verification/2026-06-11T20-20-58-809Z-durable-recovery-e6debc66`)
- `pnpm check:legacy:next`
- `pnpm perf:check:next`
- Scoped `git diff --check` for files touched by this pass

Failed / residual:

- `pnpm verify:visual:regression` failed with 328 passed and 40 failed screenshot comparisons (`artifacts/verification/2026-06-11T20-38-07-316Z-visual-regression-760517ba`). Failures were diff-ratio based; inspected summary entries reported 0 console errors and 0 page errors.
- Full `git diff --check` still fails on pre-existing dirty files, especially `apps/gateway/src/services/prompt-pack-service.ts` trailing whitespace and `apps/gateway/src/services/chat-agent-orchestrator.loop24.test.ts` blank EOF.
- Full `tool-executor.test.ts` was not rerun after the focused WhatsApp test because a prior full run hit an unrelated existing timeout in the filesystem/git read-only coverage case.

## Recommended Follow-Up

1. Triage the 40 visual-regression diffs from the artifact set. If the current UI is correct, rebaseline intentionally; if not, fix the affected route clusters (`chat`, `cowork`, `code`, `library/prompt-packs`, `library/memory`, `ops-quality`, `ops-kanban`) in narrow batches.
2. Run a separate dirty-tree hygiene pass for the pre-existing prompt-pack whitespace churn before expecting global `git diff --check` to pass.
3. Re-run CodeRabbit in smaller scoped batches if more external-review coverage is desired; repo-wide review is over the tool's current file limit.
4. Keep stale-code deletion separate from this review. The only safe conclusion here is "do not delete yet" for retained office/pixel assets and generated local residue.
