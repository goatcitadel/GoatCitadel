# Review 2 baseline verdict — HEAD a81eeccc4 (post-remediation)

Captured 2026-07-02. Compares against Review 1 baseline (67c3adb64 + WIP), which was 12/14 verify:fast with all test suites GREEN.

## Verdict: the remediation FIXED the CI-unblocker but INTRODUCED test-suite regressions. verify:fast dropped 12/14 → **9/14**.

| Check | R1 | R2 | Note |
|-------|----|----|------|
| lint (eslint .) | false-red (.claire) | ✅ PASS (307s) | clean now |
| typecheck (14 proj) | ✅ | ✅ PASS (270s) | no type regressions |
| **fast.repo-hygiene** | ❌ (F:\ leak) | ✅ **PASS** | **CI-unblocker RESOLVED** — F:\ path redacted, main fast lane un-red'd |
| fast.build | ✅ | ✅ PASS (5m20s) | |
| fast.smoke | ✅ | ✅ PASS (1m7s) | gateway RUNTIME still boots (important — see below) |
| fast.test.storage | ✅ | ✅ PASS (2m43s) | storage fixes held |
| **fast.test.gateway** | ✅ | ❌ **FAIL (7m40s)** | REGRESSION (was green) — likely cascade from module-load hang |
| **fast.test.policy-engine** | ✅ | ❌ **FAIL** | REGRESSION — `module-load-smoke`: `await import("./index.js")` **times out at 30s**. Policy-engine index hangs on load under vitest ESM. |
| **fast.test.libraries (contracts)** | ✅ | ❌ **FAIL** | REGRESSION — contracts `module-load-smoke` ("loads contracts index exports") + `domain-modules.coverage` both fail (~5s). Contracts index module-load broken. |
| **fast.test.mission-control-next** | ✅ | ❌ **FAIL (2m38s)** | REGRESSION — `PromptPacksWorkbenchPage.test.tsx` fails. |
| fast.extensions-sdk-package | ❌ | ❌ FAIL | NOT fixed — Windows `tar` drive-letter (was FW-F; not in the fix set). |
| perf:check budgets | ❌ 965,869B | ❌ **969,989B** | NOT fixed — ThreadedSurfaceRoute bundle now ~4KB WORSE (MC fixes added code). |

## Headline regression: module-load hangs in foundational packages
- `policy-engine` and `contracts` index imports now hang/timeout under vitest (`module-load-smoke`). Most likely a **circular import or blocking top-level init** introduced by the security-policy + platform-config hardening (contracts had 6 files changed; policy-engine 3).
- BUT `fast.smoke` (gateway runtime startup) still PASSES → the app likely still boots; this is a **test/module-init regression** (red CI gates + broken module-load contract), not confirmed runtime-down. R2 workflow finders are pinning the code-level root cause; QA1 confirms runtime.
- Cascade: `test.gateway` (imports policy-engine + contracts) failing is consistent with the same root cause.

## Cross-check to prior findings
- CI-unblocker (F:\ path): **RESOLVED**.
- extensions-sdk tar + bundle budget: still open (bundle slightly worse).
- New regressions above are the primary Review-2 story alongside the R2 workflow's per-finding verification.
