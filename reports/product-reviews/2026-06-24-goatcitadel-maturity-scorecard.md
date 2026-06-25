# GoatCitadel Maturity Scorecard - 2026-06-24

Status: post-repair review. Source/runtime hardening in this branch repaired the
fast verification blockers called out by the original scorecard.

Scorer: the UAA-P1-088 eight-dimension module maturity scorer. Each module is
scored 0-5 for product usefulness, safety boundary clarity, test depth, UI
visibility, CLI parity, evidence quality, operator ergonomics, and
implementation maturity. Composite score is:

```text
floor(sum(dimension_scores) * 100 / 40)
```

## Verdict

GoatCitadel scores as a strong product candidate with the fast gate repaired.
This checkout is still not a final delivery-ready product baseline because the
module average remains below the 90+ delivery-ready band and the broader
release-proof lanes still need to be refreshed on the target SHA.

| Metric | Result |
|---|---:|
| Module average | 82 / 100 |
| Delivery gate | Fast gate green; delivery proof still required |
| Hard blocker | None in `pnpm verify:fast` |
| Fast lane outcome | 10 passed, 0 failed |
| Current label | `product_candidate_fast_gate_green` |

Interpretation: the repo is meaningfully more mature than a validated
foundation. It has a real shell, durable runtime state, approvals/policy,
release truth, memory ownership, Code Mode governance, integrations, and
verification lanes. The prior hard blocker was fast-gate redness in
Realtime/SSE and Chat smoke. Those blockers are repaired in this branch; the
remaining product-deliverable work is release-proof breadth, sustained gate
stability, and raising the lower-scored partial lanes.

## Evidence Reviewed

| Source | Use in this review |
|---|---|
| `AGENTS.md` | Current invariants and claim boundaries |
| `README.md` | Current release truth and public product posture |
| `docs/1_0_CONTRACT.md` | Product promise, release gates, non-claims |
| `docs/1_0_RELEASE_EVIDENCE.md` | Claim-to-proof map |
| `docs/CANONICAL_RUNTIME_STATE_MODEL.md` | Durable state, approvals, realtime, memory context model |
| `docs/1_0_RELEASE_SURFACE_SCOPE.md` | Route/surface scope |
| `docs/review/goatcitadel-1_0-readiness-review-2026-06-13.md` | Prior readiness comparison |
| `docs/review/proof-closeout-2026-06-03.md` | Prior proof closeout |
| `docs/review/surface-area-review-2026-06-20.md` | Maintainability and validation routing gaps |
| `artifacts/verification/2026-06-25T00-04-11-153Z-fast-5c622a48/summary.md` | Current passing fast-gate evidence |

## Current Gate Snapshot

Command:

```bash
pnpm verify:fast
```

Environment:

| Tool | Version |
|---|---|
| Node | `v22.23.0` |
| pnpm | `10.31.0` |

Result:

| Fast scenario | Status | Meaning |
|---|---|---|
| `fast.skills-catalog` | passed | Catalog proof is healthy |
| `fast.repo-hygiene` | passed | Repo hygiene lane is healthy |
| `fast.storage-migration-parity` | passed | Storage migration parity is healthy |
| `fast.extensions-sdk-build` | passed | Extension SDK build is healthy |
| `fast.extensions-sdk-package` | passed | Extension package proof is healthy |
| `fast.typecheck` | passed | TypeScript boundary is healthy |
| `fast.test` | passed | Unit and integration test lane is healthy |
| `fast.smoke` | passed | Gateway smoke lane is healthy |
| `fast.build` | passed | Production build is healthy |
| `fast.docs` | passed | Docs checks are healthy |

The first attempted fast run failed immediately because `pnpm` was missing from
PATH. A temporary Corepack shim supplied the repo-pinned `pnpm@10.31.0`. The
original real fast lane then found two blockers; after repairs, the passing fast
artifact above is the current gate evidence.

## P0 Repair Closeout

| Finding | Original evidence | Repair | Current evidence |
|---|---|---|---|
| Realtime/SSE client stream tests were red | `packages/mission-control-shared/src/api/client-event-stream.test.ts`; `artifacts/verification/2026-06-24T22-56-49-462Z-fast-ab1ce097/summary.md` | Hardened async flushing in the EventSource bridge tests so fetch/Response microtasks settle before assertions. | Focused test passed; `fast.test` passed in `artifacts/verification/2026-06-25T00-04-11-153Z-fast-5c622a48/summary.md`. |
| Gateway smoke chat attachment upload returned 400 instead of 201 | `apps/gateway/src/smoke.ts:194`; `artifacts/verification/2026-06-24T22-56-49-462Z-fast-ab1ce097/summary.md` | Hardened policy path-jail, grant matching, tool path resolution, attachment artifact path normalization, workbench realpath checks, and related gateway expectations for macOS `/var` -> `/private/var` canonical paths. | `fast.smoke` passed in `artifacts/verification/2026-06-25T00-04-11-153Z-fast-5c622a48/summary.md`. |

Repair retest:

```bash
pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/api/client-event-stream.test.ts
pnpm --filter @goatcitadel/gateway smoke
pnpm verify:fast
```

## Module Ranking

Legend: `P` product usefulness, `S` safety boundary clarity, `T` test depth,
`UI` UI visibility, `CLI` CLI parity, `Ev` evidence quality, `Erg` operator
ergonomics, `Impl` implementation maturity.

| Rank | Module | P | S | T | UI | CLI | Ev | Erg | Impl | Score | Status |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | Durable Execution / Runtime State | 5 | 5 | 4 | 4 | 4 | 5 | 4 | 5 | 90 | Mature strength |
| 2 | Evidence / Release Truth | 5 | 5 | 4 | 4 | 5 | 5 | 4 | 4 | 90 | Gate green; proof refresh needed |
| 3 | Code Mode | 5 | 5 | 4 | 4 | 4 | 5 | 4 | 4 | 87 | Mature strength |
| 4 | Approvals / Auth / Policy | 5 | 5 | 4 | 4 | 4 | 5 | 4 | 4 | 87 | Mature strength |
| 5 | Runtime / Gateway Core | 5 | 5 | 4 | 4 | 4 | 5 | 4 | 4 | 87 | Strong |
| 6 | Memory Lifecycle / Retrieval | 4 | 5 | 4 | 4 | 4 | 5 | 4 | 4 | 85 | Strong |
| 7 | Surface Governance / Product Truth | 4 | 5 | 4 | 4 | 4 | 5 | 4 | 4 | 85 | Strong |
| 8 | Mission Control Shell | 5 | 4 | 4 | 5 | 3 | 4 | 4 | 4 | 82 | Strong product surface |
| 9 | Tools / Capability Registry | 4 | 5 | 4 | 4 | 4 | 4 | 4 | 4 | 82 | Strong |
| 10 | Chat Surface | 5 | 4 | 4 | 5 | 3 | 5 | 4 | 4 | 82 | Fast smoke repaired |
| 11 | Realtime / Event Stream | 4 | 4 | 4 | 4 | 3 | 5 | 4 | 4 | 82 | Realtime regression repaired |
| 12 | Cowork / Orchestration | 4 | 4 | 4 | 5 | 3 | 4 | 4 | 4 | 80 | Product candidate |
| 13 | Integrations / MCP / A2A / Mesh | 4 | 5 | 4 | 4 | 4 | 4 | 3 | 4 | 80 | Product candidate |
| 14 | Extensions / Skills / Add-ons | 4 | 4 | 4 | 3 | 4 | 4 | 3 | 3 | 72 | Partial product lane |
| 15 | Desktop / Packaging / Installers | 4 | 4 | 3 | 4 | 4 | 4 | 3 | 3 | 72 | Partial product lane |
| 16 | Local AI / NPU / Provider Diagnostics | 3 | 4 | 3 | 4 | 3 | 4 | 3 | 3 | 67 | Bounded partial |

## Comparison To UAA Scorer Baseline

This uses the same scorer shape as UAA's V2 module review, not a new
GoatCitadel-specific rubric.

| Area | UAA V2 pattern | GoatCitadel current read |
|---|---|---|
| Average module score | UAA V2 snapshot average was 68 | GoatCitadel average is 82 |
| Strongest evidence | UAA memory and HITL/proposal safety | GoatCitadel durable execution, Code Mode governance, release truth, approvals/policy |
| Main blocker type | UAA was still graduating modules from contract/proposal into product loop | GoatCitadel has product loop shape and fast gate is green; remaining blocker is broader release-proof maturity |
| Memory posture | UAA memory scored very high because its bounded recall/review path was deeply evidenced | GoatCitadel memory is strong, but advanced vector-like retrieval remains a future milestone |
| Product shell | UAA Control Center was emerging | GoatCitadel Mission Control is broad and canonical |
| Release posture | UAA was not a product-deliverable baseline | GoatCitadel is much closer, but should not claim delivery-ready until release-proof lanes are refreshed and lower-scored partial lanes are raised |

## What GoatCitadel Needs For Product-Deliverable Status

| Priority | Lane | Purpose | Exit condition |
|---|---|---|---|
| P0 | Fast gate stewardship | Keep the repaired fast gate clean | `pnpm verify:fast` stays green with no accepted failures |
| P1 | Release proof refresh | Convert strong architecture into current evidence | Runtime, durable, memory, realtime, Code Mode, mesh, docs, and visual proof lanes are green on the target SHA |
| P2 | Recurring maturity manifest | Make this score retestable instead of a one-off review | Repo-owned JSON scorecard plus verifier remains updated after gate changes |
| P3 | Maintainability routing | Reduce slow/large review surfaces without weakening release proof | PR-time lane routing, shared scan helper, and first service/UI monolith extractions land with focused tests |
| P4 | Advanced retrieval milestone | Keep a safe path toward vector-like or HRR-style retrieval | Explicit milestone with recall-only semantics, provenance, evaluations, operator-visible source attribution, and no hidden context injection |

## Retest Metric

Use this as the repeatable score protocol:

1. Run `pnpm verify:fast`.
2. If red, score hard gate as blocked and cap delivery status at
   `product_candidate_blocked_by_fast_gate`.
3. If green, run the release-relevant focused lanes for touched areas and use
   `product_candidate_fast_gate_green` until broader release proof is refreshed.
4. Recompute module scores using the eight-dimension table.
5. Promote to delivery-ready candidate only when module average is at least 90
   and hard gates are green on the target SHA.

Recommended retest bundle for the next maturity report:

```bash
pnpm verify:fast
pnpm verify:runtime:truth
pnpm verify:durable:recovery
pnpm verify:memory:truth
pnpm verify:realtime:truth
pnpm verify:code-mode:sandbox
pnpm verify:mesh:readiness
pnpm docs:check
```

## Bottom Line

GoatCitadel is not an immature repo. It is a serious product candidate with a
large amount of governed runtime, evidence, and operator shell work already in
place. The honest current status after repair is: this checkout has a clean fast
gate, but the repo still needs broader release-proof refresh and sustained
partial-lane hardening before it should be treated as a deliverable product
baseline.
