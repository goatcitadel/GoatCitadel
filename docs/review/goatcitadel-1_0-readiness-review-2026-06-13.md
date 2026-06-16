# GoatCitadel 1.0 Readiness Review — 2026-06-13

**Scope:** full-repo, execution-backed, report-only (no source changed).
**Commit reviewed:** `8f550da17` on `main` (re-confirmed unchanged at end of run).
**Method:** 10 read-only review subagents (backend, core packages, security ×2, frontend, shared-UI, product-truth, CI/release, native, known-blocker closure) + a live gate sweep of **44 lanes** (lint/type/build/test/coverage, ~27 `verify:*` lanes, native Tauri/.NET, Trivy). Logs: `.scratch/readiness-2026-06-13/` (per-lane `*.log` + `results.tsv`).
**Toolchains present:** Node 24.14, pnpm 10.31, Rust/cargo 1.94, .NET 10. **Absent:** Python (NPU sidecar = static-only), Postgres server (SQLite path exercised; PG = static/CI-deferred).

---

## 1. Verdict — CONDITIONAL-GO for manual QA

**Manual QA may proceed.** The app builds and runs, **native targets all build/pass**, and **~27 runtime/proof verify lanes are green** — including the two prior hard blockers, which are now **CLOSED**: `architecture-metrics` (G2) and loop-detection-in-shipped-config (G3). Security posture is deeply hardened (three security-focused passes found no Blocker-class auth/secret/sandbox holes). The product **code** is in strong 1.0 shape.

**But clear these first — they are red gates or false-truth on the candidate:**

| # | Must-clear-before/at-QA | Effort | Why |
|---|---|---|---|
| B1 | `pnpm test` is **RED** (3 mc-next route tests) → blocks `coverage:collect` | 1 line | Test/coverage gate red on the candidate |
| B2 | `visual-regression` is **RED** — 62/368 scenarios diff | triage | Dark-theme library/settings/ops surfaces; rebaseline-vs-regression unknown |
| B3 | **README route count is false** (says 41/36 ship; actual **44/39**) | 1 line | Public "Current Release Truth" is wrong; `docs:check` doesn't catch it |

**And before *declaring*/cutting 1.0 (does not block QA, but blocks a trustworthy release):**

| # | Release-identity / governance | Why |
|---|---|---|
| B4 | **`v1.0.0` tag is 447 commits stale** (`085ebebe`, 2026-05-06), no committed exact-SHA proof | Published tag ≠ current main; current main is unproven/untagged |
| B5 | CI has **no required status checks** → the live red test could merge to `main` | Convention/admin-only protection (needs GitHub-settings confirmation) |

The headline: **product is QA-ready; the gaps are a live red test, public-truth/doc accuracy, an open visual sweep, and release-governance plumbing** — not runtime correctness.

---

## 2. Gate sweep — measured results (44 lanes)

All green **except** the rows called out. Two early "lint FAIL" rows were **invocation/pollution artifacts** — real product lint is GREEN (see note).

| Lane | Result | Note |
|---|---|---|
| typecheck | ✅ PASS | `tsc -b` all packages |
| **lint** (`eslint . --max-warnings 0`) | ✅ **PASS** | The 2 "FAIL" rows in `results.tsv` are artifacts: (a) my `pnpm lint -- --max-warnings 0` passed a literal `--` to eslint; (b) `eslint .` crashed loading a nested `eslint.config.mjs` inside the **untracked `.scratch/external-repo-review/hermes-agent`** copy. Re-run excluding `.scratch/` → **exit 0**. |
| build (`pnpm build`) | ✅ PASS | incl. mc-next Vite production build |
| **test** (`pnpm test`) | ❌ **FAIL** | 3 failures in `mission-control-next` (F-B1) |
| **coverage:collect / gate / gate:production** | ❌ **BLOCKED** | collection aborts on the 3 red tests → gate can't run (not a low-coverage failure) |
| coverage:uncovered | ✅ PASS | branch-gap report only |
| docs:check, git diff --check, repo-hygiene | ✅ PASS | |
| format:check | ⚠️ FAIL (Low) | 30 pre-existing prettier-dirty files (scripts/, tsconfig*, fixtures) — **not a CI gate** |
| security-evals, artifacts-redaction, storage-migration-parity, mcp-conformance, skills-catalog, design-quality | ✅ PASS | |
| **architecture-metrics** | ✅ **PASS** | **prior G2 blocker — CLOSED** |
| dependency-risk, api-compat, catalog-parity | ✅ PASS | |
| runtime-truth, realtime-truth, memory-truth | ✅ PASS | |
| durable-recovery, operator-proof, auth-matrix | ✅ PASS | |
| agentic-governance, agentic-proof, agentic-parity | ✅ PASS | |
| code-mode-sandbox, code-mode-hostile-sandbox | ✅ PASS | |
| mesh-readiness, backup-roundtrip | ✅ PASS | |
| surface-regression | ✅ PASS | |
| **visual-regression** | ❌ **FAIL** | 62/368 diff (61 critical, 1 medium), ratio 5.73% > 4% (F-B2) |
| trivy | ⚠️ INCONCLUSIVE | binary present (0.69.3) but vuln-DB download timed out (network); covered by `security-trivy.yml` CI; local `dependency:risk` passed |
| **Native — windows:test (.NET)** | ✅ PASS | 31/31 |
| **Native — desktop:build (Tauri)** | ✅ PASS | release `.exe` built in 2m15s |
| verify:install, verify:desktop, check:legacy:next, perf:check:next | ✅ PASS | install-smoke 7/7; budgets/contrast/typography ok |

---

## 3. Findings (prioritized, tagged to the manual QA cases they threaten)

Severity = impact on a 1.0 / on the QA pass. "✓verified" = I personally confirmed the file:line.

### Blockers

**F-B1 [Blocker] `pnpm test` RED — `buildAppHref` writes `theme=` into URLs; 3 route tests expect it stripped.** ✓verified
`apps/mission-control-next/src/app/route-model.ts:968` (`writeParam(params, "theme", next.theme)`). Today's commit `819ef761f` ("drop stale theme-in-URL assertions") changed 3 assertions in `legacy-route-adapter.test.ts` + `route-model.loop26.test.ts` to expect **no** theme, on the premise that `41b59db46` stopped writing it — but pickaxe shows the theme-write line predates `41b59db46` and was never removed, so the tests went red on that commit and remain red. This **blocks `coverage:collect`**, so the coverage gate is unmeasurable.
*Fix direction (not applied):* drop `route-model.ts:968` (matches the stated intent: theme is a global localStorage pref, not per-URL state) **or** revert the 3 assertions. *Jeopardizes QA:* PRE-02 (automated baseline), NAV-02, NAV-03.

**F-B2 [Blocker] `visual-regression` RED — 62/368 scenarios diff (5.73% > 4% threshold).** ✓verified (ran the lane)
Artifact `artifacts/verification/2026-06-13T21-43-24-159Z-visual-regression-4e229b27/` (manifest + `repair-plan.md`). Failures cluster in **dark-theme** renders of `library-{skills,capabilities,artifacts,memory,files}`, `settings-{personalities,access,local-ai,integrations,channels}`, `ops-quality`, `projects`. Prior review counted ~40; it is now 62 at HEAD — likely recent theme/contrast commits outran the baselines, but **rebaseline-vs-real-regression has not been triaged**. The lane cannot self-distinguish "intended restyle" from "regression."
*Fix direction:* triage each diff; rebaseline the intended ones, fix the rest; re-run `verify:visual:regression` to green before declaring the visual surface stable. *Jeopardizes QA:* NAV-04 (light/dark layout) and every per-surface visual case.

**F-B3 [Blocker] README "Current Release Truth" undercounts the shipped surface and is ungated.** ✓verified
`README.md:116` — "41 routes: 36 `ship`, 0 `needs_release_polish`, 5 `experimental`." Ground truth (counted): `route-model.ts` `ROUTE_RELEASE_SCOPE` = **44 routes, 39 ship, 5 experimental**; `release-surface-manifest.mjs` and `docs/1_0_RELEASE_EVIDENCE.md:39` both agree at 44/39. README is the only doc carrying 41/36. `scripts/validate-governance-docs.mjs` checks the count regex against `1_0_RELEASE_EVIDENCE.md` only, so `docs:check` passes green on a false public claim — material for a "governance-first, honest" product.
*Fix direction:* correct README:116 to 44/39 **and** extend `validate-governance-docs.mjs` to assert the README count against the canonical source. *Jeopardizes QA:* Product Truth, NAV-01.

**F-B4 [Blocker] `v1.0.0` tag is 447 commits stale with no committed exact-SHA proof.** ✓verified
`v1.0.0 = 085ebebe` (2026-05-06, "fix: clean long installer paths"); `main = 8f550da17`; `git rev-list --count v1.0.0..main = 447`. No `release-certificate*.json` is committed; the tag's `1_0_RELEASE_EVIDENCE.md` is a claims-map, not a pass record. If 1.0 ships from current main, the existing tag is unrepresentative; if from `085ebebe`, its proof lives only in CI history and predates the 2026-06-02 coverage re-baseline and 447 commits of runtime/CI change.
*Fix direction:* re-tag 1.0 at a proven current-main SHA (or attach the exact-SHA `release-certificate.json` for `085ebebe`) before declaring readiness. *Jeopardizes QA:* release-gating (identity).

**F-B5 [Blocker, process — requires GitHub-settings confirmation] No required status checks on `main`.** (SA8; corroborated by prior session notes)
`code-quality.yml` and `verification-fast.yml` trigger on push/PR and **do** detect the current red state (`verification-fast` runs `pnpm -r test` + the fail-closed coverage gate), but nothing in-repo marks them required (no committed ruleset/branch-protection; no CODEOWNERS). So the live F-B1 red state can merge to `main`.
*Fix direction:* make code-quality + verification-fast + docs-check + security-trivy **required** for merge; verify in repo Settings → Rules. *Jeopardizes QA:* release-gating (all).

### High

| ID | Finding | Location | QA |
|---|---|---|---|
| F-H1 | **Per-agent tool-policy validated as `z.unknown()`** while the TS type is a structured allow/deny/profile object → a malformed per-agent override silently drops its `deny` (runs broader than intended) or throws a TypeError that crashes all tool eval for that agent. ✓verified | `packages/contracts/src/config-schemas.ts:81` → consumed `packages/policy-engine/src/policy-resolver.ts:19,35,41` | SET-05, OPS, CODE, APPR |
| F-H2 | **Mesh session-owner takeover lacks epoch-CAS** — `UPDATE mesh_session_owners … WHERE session_id` has no `AND epoch = @expected` and never checks `changes`; two concurrent claims at the same epoch both win → split-brain on the async/Postgres/multi-node backend (lease path CASes correctly; owner path doesn't). ✓verified | `packages/storage/src/mesh-repo.ts:146-152` + `:403-421` | OPS (mesh failover), DUR, INT |
| F-H3 | **Ops Costs/Improvement/Runtime render "$0.00 healthy" with no degraded banner when the gateway is down** — `useOpsRuntimeSnapshot.load()` swallows fetch errors so `error` stays null and the page shows zeroed data; these 3 sections don't render the needs-attention card. Prohibited "fresh truth while failing." | `…/ops/RuntimeRoutePage.tsx:676-788`, `packages/mission-control-shared/src/hooks/useOpsRuntimeSnapshot.ts:77-130` | OPS-ACT-02, INST-02 |
| F-H4 | **Always-visible footer shows stale dashboard truth** (pending approvals / sessions / spend) after a dashboard refresh fails; the "needs refresh" chip is gated to the stage header, which is hidden on ops/library/settings/projects/cowork-tasks. | `apps/mission-control-next/src/app/use-shell-status.ts:67-76`, `MissionControlNextApp.tsx:827-855` | INST-02, OPS-ACT-02 |
| F-H5 | **`CAPABILITY_SYSTEM_V1.md` (a QA Product-Truth Source Anchor) cites the deleted `apps/mission-control/src/...` as the current Mission Control implementation** — violates the canonical-shell truth; the doc is entirely outside `docs:check`. ✓verified (`apps/mission-control/src` absent) | `docs/CAPABILITY_SYSTEM_V1.md:70-75` | Product Truth (claim 1), CODE |
| F-H6 | **WinUI WebView2 host has no `NewWindowRequested` handler** — only `NavigationStarting` is guarded, so `window.open`/`target=_blank` from agent-rendered content opens an off-loopback popup WebView with no address bar (phishing/containment gap). ✓verified (no handler in any `.cs`) | `apps/mission-control-windows/MainWindow.xaml.cs:181-189` | INST-06 |
| F-H7 | **Release certificate `--require-success` accepts a green-but-stale-SHA lane run** — path-filtered lane workflows can be green on an older SHA; `resolveLaneProof` returns that success and the exact-SHA umbrella run never overrides it; the mismatch is recorded in `exactShaStatus` but never blocks. | `scripts/release/write-release-certificate.mjs:129-134`, `release-certificate-proof.mjs:16-35` | release-gating |
| F-H8 | **Windows hostile-sandbox proof is never fed into the release certificate** — `release-installers.yml` omits `--hostile-sandbox-proof`, so `hostileSandboxWindowsClaim.publicClaimAllowed` is always false (lane green still satisfies `--require-success`) → the AppContainer security claim is unproven on every signed release. | `.github/workflows/release-installers.yml:505-515` → `write-release-certificate.mjs:358-389` | release-gating, claim 5 |
| F-H9 | **`contracts` / `extensions-sdk` publish workflows ship to the registry with no test/lint/typecheck/proof gate** (build → `npm publish` on tag, no `--provenance`). | `.github/workflows/publish-contracts.yml:31-37`, `publish-extensions-sdk.yml:30-36` | release-gating (pkg dist) |

### Medium

| ID | Finding | Location | QA |
|---|---|---|---|
| F-M1 | Idempotency: a handler-emitted **4xx burns the mutation `Idempotency-Key` as `completed`** (only ≥500 is revivable), so a correct client retry is rejected 409 even though nothing executed. | `apps/gateway/src/plugins/idempotency.ts:79-93`, `packages/storage/src/mutation-idempotency-repo.ts:142-156` | APPR, COWORK, CODE, SET |
| F-M2 | Event-ingest dedup **ignores the stored `payloadHash`** — a reused `(endpoint, idempotencyKey)` with different content returns `accepted:true, deduped:true` and the new content is silently dropped (inbound message loss). | `packages/gateway-core/src/event-ingest.ts:60-70`, `packages/storage/src/idempotency-repo.ts:43-59` | CHAT, LIB-COMM, INT |
| F-M3 | Event-ingest dedup **overwrites a prior `accepted` row's status → `deduped` and bumps `processed_at`** (audit/state corruption of the original event). | `packages/gateway-core/src/event-ingest.ts:63`, `idempotency-repo.ts:86-93` | OPS, INT |
| F-M4 | `session-key` `normalizeSegment` **collapses every `:` to `_`**, so distinct peers/rooms whose IDs contain `:` (JIDs, composite IDs) **collide into one session** → cross-wired transcripts (privacy/data-integrity). | `packages/gateway-core/src/session-key.ts:60-66` | CHAT, LIB-COMM, INT |
| F-M5 | `listReplicationEvents(cursor)` returns `[]` when the cursor id no longer exists (pruned) — indistinguishable from "caught up" → silent **replication stall**. | `packages/storage/src/mesh-repo.ts:172-187` | OPS (mesh), DUR |
| F-M6 | IPv4-mapped IPv6 SSRF guard **misses the uncompressed `0:0:0:0:0:ffff:` form** on the bare-host path (full-URL inputs are canonicalized and safe). | `packages/policy-engine/src/sandbox/network-guard.ts:693-711` | SET-03, INT-02 |
| F-M7 | **NPU sidecar exposes unauthenticated inference endpoints and honors `GOATCITADEL_NPU_HOST=0.0.0.0`** — one env override turns it into a network-reachable, unauthenticated LLM + paid-upstream proxy. | `apps/npu-sidecar/server.py:393-395`, routes `:196-387` | SETUP-04 |
| F-M8 | Generic `/:channel/inbound` webhook **skips the sender allowlist and bot-loop guard** the 5 named channels enforce (HMAC still required, so authN is intact; authZ/loop control is not). | `apps/gateway/src/routes/integration-webhooks.ts:103-115` | INT-02, INT-03 |
| F-M9 | Generic inbound body can **self-assign `actorType:"agent"/"system"` and `role:"assistant"`** (provenance pollution; named channels hardcode `user`). | `apps/gateway/src/routes/integration-webhook-schemas.ts:25-26` | INT, provenance |
| F-M10 | Windows `goatcitadel://` deep links registered via **HKCU `shell\open\command` are dropped** (raw-argv activations aren't `Protocol`-kind) — deep-link/notification "open approval" no-ops on unsigned/HKCU installs. | `scripts/packaging/build-windows-native-installer.mjs:211-215` vs `apps/mission-control-windows/Services/ActivationService.cs:72-87` | INST-06 |
| F-M11 | **3 of 5 experimental surfaces (curator, improvement, kanban) are in no rail and no command palette**, and none of the 5 carry an on-surface "Experimental" badge (only a footer pill); personalities has the weakest labeling. | `apps/mission-control-next/src/app/MissionControlNextApp.tsx:237-241,183-204` | NAV-01, NAV-02, Product Truth claim 7 |
| F-M12 | The new `ErrorState` primitive is **not adopted on Library/Settings sections** — their error path is the old `.mc-next-directory-alert` with no `role="alert"` and no retry (operator must reload the whole app). | `…/shared/library-primitives.tsx:20-27`, `settings/SettingsShared.tsx:156-163` | error-recovery UX |
| F-M13 | `colorizeCache` is an **unbounded module-level `Map`** (no LRU/eviction) — bounded for the static layout, but unbounded if any path feeds varying h/s/b/c. | `packages/mission-control-shared/src/pixel-office/colorize.ts:12,19-25` | n/a |
| F-M14 | `PixelOfficeCanvas` agent-id map + numeric counter **grow monotonically** as agent IDs churn (never pruned on removal). | `packages/mission-control-shared/src/components/PixelOfficeCanvas.tsx:101,168-198` | n/a |
| F-M15 | **Doc-integrity gate gaps** enabling F-B3/F-H5: README count unchecked; archived-shell scan runs on 1 doc only; `PACKAGING.md`/`CAPABILITY_SYSTEM_V1.md` outside `docs:check`; hostile-sandbox "green" wording ungated. | `scripts/validate-governance-docs.mjs:431-448` | Product Truth / doc-gate |
| F-M16 | Tag push doesn't re-run `verify:fast`/coverage on the tag SHA (coverage gate lives only in `verification-fast.yml`, no `tags:` trigger) → certificate relies on possibly-stale fast/coverage evidence. | `.github/workflows/verification-fast.yml:3-8` | release-gating (coverage) |

### Low (condensed — 18)

Format-check drift in 30 non-app files (`format:check`); approval/durable `resolvedBy` collapses to `auth:none` in default mode (audit fidelity, `routes/approvals.ts:82`); skills loader swallows all source/parse errors (`packages/skills/src/loader.ts:46-71`); SKILL.md frontmatter cast without Zod (`frontmatter.ts:22-41`); approval `riskLevel` persisted without enum validation (`packages/storage/src/approval-repo.ts:118`); `validateStructuralSafety` skips host check when `url`/`host` arg empty (`policy-engine/src/engine.ts:1073`); promptware scanner defined but unwired into ingestion (`assembled-prompt-injection-guard.ts:15-52`); several services use raw `fetch()` instead of `fetchAllowlisted` (regression-hardening; `llm-service.ts`, `skill-import-service.ts`, …); macOS keychain write passes secret as argv (`secret-store-service.ts:198`); `@ts-nocheck` on `spriteCache.ts` masks a zero-row-sprite crash outside the React error boundary; `SurfaceReconnectBanner` 1s interval never torn down after reconnect; shared packages ship `dist` with no prepublish/build guard (dev-staleness only); Telegram/LINE/WhatsApp/Nextcloud webhook HMACs have no timestamp replay window (forgery prevented; replay bounded by idempotency store); Discord inbound bypasses the shared bot-loop rate cap (self-filter + active-run guard remain); Tauri CSP allows any `localhost:*` port in `frame-src`/`connect-src`; Windows uninstaller force-deletes `{app}\app` + `{app}\bin` under a user-supplied `/DIR` (INST-05 under custom dir); **`.scratch/`, `reports/`, `workspace/goatcitadel_out/` are not gitignored** (tree pollution — broke the lint run and is a `git add -A` hazard); contracts uses interface-not-Zod systemically (F-H1 is the concrete reachable case).

---

## 4. Known-blocker closure (vs prior reviews)

| Item | Status | Evidence |
|---|---|---|
| **G2 `architecture-metrics` red on main** | ✅ **CLOSED** | live lane PASS; baseline reconciled `fe1a0ade3` (`gatewayLineCount 9129` vs actual 9121) |
| **G3 loop-detection disabled in shipped config** | ✅ **CLOSED** | shipped `config/tool-policy.example.json:20` `enabled:true` (+ all 3 detectors, circuit breaker, wired in orchestrator). The old finding inspected the **gitignored danger profile** `config/tool-policy.json` (intentionally off). Schema default is also `enabled:true` (`config-schemas.ts:67`). |
| **Prompt-lab answer-fabrication layer** | ✅ **CLOSED** | `applyPromptPackHarnessNormalization` deleted; canned-answer fns gone; residual cowork canned branches dead on eval turns (gated); lease 120s, budget 240/150s; no CRLF churn |
| **Coverage 63/45 baseline + ratchets** | ✅ CLOSED (rationale) | documented in `coverage-collect.mjs:12-78` w/ climb-back plan; **live numbers BLOCKED by F-B1** |
| **~40 visual-regression diffs** | ❌ **OPEN** | now **62/368** at HEAD (F-B2); real fixes + baseline refresh landed but no full-matrix green exists |
| Gap-review P0: Trust UI / Universal Run Detail / first-run job | ✅ CLOSED | `route-model.ts:446-450,786-806`; `ops/RunDetailRoutePage.tsx`; `settings-onboarding` |
| Gap-review P1: semantic memory / browser sessions / governed remote MCP | ✅ CLOSED | `memory-core/candidate-ranker.ts:22-132`; `ops/BrowserSessionsRoutePage.tsx`; `mcp-runtime.ts` + OAuth |
| Gap-review P1: red-team / injection eval packs | ⚠️ PARTIAL | a defensive prompt-pack lane ships; not the full 4-vector (prompt/tool/web/memory) suite |

---

## 5. Native targets

| Target | Build/Test | Static review |
|---|---|---|
| **Tauri desktop** (`apps/mission-control-desktop`) | ✅ release `.exe` built (2m15s) | Capabilities least-privilege (`core:default`+`notification:default`); IPC doesn't bypass the gateway plane; CSP port-wildcard = Low |
| **WinUI/.NET host** (`apps/mission-control-windows`) | ✅ 31/31 tests | Nav allowlist robust; **F-H6 (NewWindowRequested)** + **F-M10 (HKCU activation)** + uninstaller Low |
| **Python NPU sidecar** (`apps/npu-sidecar`) | — (no Python runtime) | static only → **F-M7** (unauth + bind override) |
| Installers | `verify:install`/`verify:desktop` ✅ | macOS arm64 ad-hoc/experimental labeling correct |

---

## 6. Coverage & security posture

- **Coverage:** unmeasurable this run — `coverage:collect` aborts on F-B1. Documented baseline (2026-06-02): 64.29% line overall; gateway/shared tier 53.99% (floor 52, ratchet → 60 → 80). Re-run `coverage:collect` + `coverage:gate:production` once F-B1 is green.
- **Security:** three passes (cross-cutting, webhook/A2A, native) found **no Blocker-class** auth/secret/sandbox hole. Confirmed sound: empty network allowlist = deny-all; timing-safe auth; atomic `O_EXCL 0600` secret writes; no secret logging; Code-Mode claim honesty (`publicClaimAllowed` fail-closed); `spawn(..., shell:false)`; parameterized SQL; A2A disabled-by-default + fail-closed + can't act as operator; all 6 webhook routes HMAC-verified + timing-safe. Residual items are Medium/Low (F-M6/M7/M8/M9 + Lows).

---

## 7. Recommended action lists

**Clear before / at the start of manual QA (small):**
1. **F-B1** — drop `route-model.ts:968` (or revert the 3 assertions) → `pnpm test` green → `pnpm coverage:collect && pnpm coverage:gate` re-measurable.
2. **F-B3** — correct `README.md:116` to 44/39 (and gate it — F-M15).
3. **F-H1** — give the per-agent `agents` block a real Zod schema (security, trivial).
4. **F-B2** — triage the 62 visual diffs; rebaseline intended ones, fix the rest; re-run `verify:visual:regression`.

**Before declaring / cutting 1.0 (separate from QA):**
5. **F-B4** — re-tag at a proven current-main SHA (or attach the exact-SHA cert).
6. **F-B5** — make code-quality + verification-fast + docs-check + security-trivy required on `main`.
7. **F-H7/F-H8** — enforce exact-SHA in `--require-success` and feed the hostile-sandbox proof into the certificate.
8. **F-H9** — gate the `contracts`/`extensions-sdk` publishes (test/typecheck + provenance).

**QA-awareness (verify behavior, fix as feasible):** F-H2/H3/H4/H6, F-M1–M12. Each row above carries the QA case(s) it threatens so testers start from a known baseline.

---

## 8. Method & limits

- **Report-only:** no source changed. Writes were the report, `.scratch/readiness-2026-06-13/` logs, and gitignored `dist/coverage/artifacts`.
- **Measured vs inferred:** §2 is measured (lanes actually run). Findings marked ✓verified were confirmed at file:line by the reviewer; others are static-inferred at the stated confidence.
- **Not exercised here:** Postgres storage path (SQLite covered; PG static/CI-deferred); Python sidecar runtime (absent); Trivy CVE scan (network-blocked locally — CI covers); **F-B5** (required checks) and the v1.0.0 CI proof status need GitHub-settings/Actions confirmation; the 62 visual diffs were **not** individually triaged rebaseline-vs-regression.
- **Working tree:** dirty — 25 untracked entries incl. multi-MB `.scratch/`/`reports/` external-repo copies (not gitignored). QA preflight (PRE-01) should run from a clean tree or record this. HEAD held at `8f550da17` throughout.
