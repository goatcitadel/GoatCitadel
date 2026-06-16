# Full Code Review — GoatCitadel — 2026-05-28

Exhaustive, high-precision review of the entire monorepo (16 domains, ~250 findings), commissioned
to: fix bugs, optimize performance, add missing/improved functionality, and re-pass the chat
display layer. Delivered as focused PRs off `main`.

**Method & ground truth:** 16 parallel read-only reviewers, each adversarially skeptical (a shipped
v1.0 codebase previously audited). The prior `docs/review/*` docs are **stale** and were treated as
leads, not facts — every claim was re-verified against live source. Detailed per-domain findings
live in `.scratch/review-2026-05-28/findings-*.md` (uncommitted working notes); this doc is the
committed, prioritized index and is the campaign's source of truth.

**Severity reframe (auth model):** A global `onRequest` hook (`apps/gateway/src/plugins/auth.ts:84`)
enforces operator auth on all `/api/v1/*` except a small public allowlist (health, device-requests,
companion refresh, Slack OAuth callback, channel webhooks, loopback-onboarding). So "RCE-class"
findings below are **authenticated / supply-chain** severity (operator imports a malicious skill
source; or `auth.mode=none` deployments — which is exactly how the always-on PR test lane runs),
not unauthenticated-remote. Still High.

---

## Executive summary

| Severity | Count (approx) |
|---|---:|
| Critical | 2 |
| High | ~36 |
| Medium | ~95 |
| Low / Info | ~115 |

Headline: the product is **architecturally sound and genuinely well-defended** in its core
primitives (SSE backpressure, SSRF/path guards, durable-run CAS, auth hardening, idempotency — all
independently re-verified as correct). The findings cluster into a few **systemic themes** rather
than scattered one-offs, which makes them efficient to fix in themed PRs.

### The 2 Critical
- **C1 — Parallel Anthropic tool calls corrupt** (`AGENTORCH-001` / `LLM-001`).
  `llm-provider-anthropic.ts:143` hard-codes `tool_calls[].index: 0` for every `content_block_stop`
  even though the correct block index is in scope (`:131`). The agentic aggregator
  (`chat-agent-completion-adapters.ts:269`) keys by that index, so when a model emits **parallel**
  tool calls in one streamed turn they collapse into a single corrupted call (id/name overwritten,
  distinct JSON arg fragments concatenated into malformed JSON). Independently confirmed by two
  reviewers. The only Anthropic-streaming test exercises a single tool call, baking in the bug.
  → **B1, first PR.** Low-risk one-line root fix + aggregator test.
- **C2 — `verify:architecture:metrics` ratchet is RED on `main`** (`CI-001`). Recent merged work
  grew `GatewayService` (8855→8991 lines), public methods (251→254), and the route-composition port
  (151→154) past the committed baseline (`scripts/verification/baselines/architecture-metrics.json`)
  without updating it. The lane is PR-gating via `verification-truth-lanes.yml` (`pull_request:
  paths:` on `apps/**`, `packages/**`, `scripts/verification/**`), so **any PR touching app/package
  source inherits a red required job today.** → Must be reconciled in/before the first code PR.

### Cross-cutting themes (drive the PR grouping)
1. **Anthropic provider-shape correctness** — C1 + `LLM-002` (vision images sent in OpenAI
   `image_url` shape, rejected) + `LLM-003` (Anthropic path calls `response.json()` directly,
   regressing the S19 HTML-error-page hardening). One themed PR fixes the Anthropic adapter.
2. **Git argument injection (missing `--` separator)** — `IMPROVE-002` (skill clone),
   `INFRA-007` (update-review `git ls-remote`). Same root pattern; one defensive helper.
3. **Durable-write CAS omitted** — `ORCH-012` / `PPVM-001` (proactive `updateRun` without
   `expectedVersion` → lost updates vs the lease heartbeat).
4. **Non-atomic read-modify-write** — `STORAGE-002` (mesh lease → split-brain), `STORAGE-004`
   (many repos), `CHATTURN-004` (sequence allocation). Safe single-process; breaks multi-node/Postgres.
5. **React async-effect/unmount-guard gaps** — `MCNEXT-001/002/006`, `MCSHARED-003/005/006/008`.
   Root cause: `eslint-plugin-react-hooks` is installed but **not wired into `eslint.config.mjs`**
   (`CI-003`), so `exhaustive-deps`/`rules-of-hooks` are unenforced repo-wide.
6. **Defenses shipped disabled / dead ("trust theater")** — `INTEG-001` (bot-loop guard is dead
   code), `AGENTORCH-002` (tool-loop guard default `enabled:false`), `AGENTORCH-003` (per-mode
   timeouts overridden by a 30-min "testing" constant), `IMPROVE-004` (candidate eval always inserts
   `passed`).
7. **Event-loop blocking** — `STORAGE-003` (synchronous Postgres client via `Atomics.wait`),
   `PPVM-002` (synchronous `execFileSync` ffmpeg+whisper on the request path).
8. **Untrusted-input validation gaps** — `COREPKG-010` (sandbox jail root `[""]` resolves to repo
   root → whole-repo write/code-mode), `MCSHARED-001` (realtime SSE events `JSON.parse`+cast, no
   validation → a malformed frame throws and breaks live updates), `COREPKG-017` (secret-redaction
   regex suffix-anchored → `secretValue`/in-value secrets not scrubbed).
9. **CI false-confidence** — `CI-001..005`: ESLint runs in no CI workflow; provider "truth" lanes
   count auth-fail/404/insufficient-credits as `not_configured` (green with zero working providers);
   the only always-on PR lane runs `AUTH_MODE=none`.

---

## Progress — fixes shipped as PRs off `main` (2026-05-28)

| PR | Findings resolved | Notes |
|----|-------------------|-------|
| #30 | CI-001 | architecture-metrics baseline reconciled (un-reds main CI) |
| #31 | AGENTORCH-001 / LLM-001 (**Critical**), LLM-002, LLM-003 | Anthropic adapter correctness |
| #32 | CHATTURN-001 | live-tail `wait()` listener leak (extracted `wait.ts`) |
| #33 | STORAGE-001 | + bonus `idx_comms_deliveries_idempotency` partial index |
| #34 | COREPKG-010 | sandbox jail-root empty-string fail-open |
| #35 | INFRA-001, INFRA-002 | MCP EPIPE crash + Windows zombie processes |
| #36 | GWROUTES-001 | + bonus chat-attachments CSP clobber |
| #37 | IMPROVE-002, IMPROVE-003, INFRA-007 | skill-import git-arg + path-traversal hardening (quiet) |
| #38 | AGENTORCH-004 | repair/synthesis/image usage accounting |

**Resolved:** the Critical + ~12 High. Each PR is TDD'd and independently gated (lint/typecheck/tests); each notes the #30 dependency for `verify:architecture:metrics`.

**Remaining B1:** AGENTORCH-002/003 (shipped-default flips — loop guard, 30-min timeout), AGENTORCH-005 (tool allow-map), ORCH-001/002/003 + worktree (durable-execution; characterization-first), INTEG-001/002 + gating, INFRA-003 (SSE replay window), COREPKG-017 (secret redaction — false-positive care), the MCNEXT/MCSHARED async-guard cluster, and the Medium/Low tail. **Then** B2 (chat display), B3 (perf), B4 (refactors), B5 (features), B6 (cleanup/CI-hardening).

## Critical & High findings (actionable backlog)

> Detail beyond the table is in the per-domain `.scratch/review-2026-05-28/findings-*.md` files.
> Batch legend: B1 bug · B3 perf · B4 refactor · B5 feature · B6 cleanup.

### Critical
| ID | Title | Location | Batch |
|---|---|---|---|
| AGENTORCH-001 / LLM-001 | Parallel Anthropic tool calls collapse (hardcoded `index:0`) | `llm-provider-anthropic.ts:143`; `chat-agent-completion-adapters.ts:269` | B1 |
| CI-001 | architecture-metrics ratchet red on main; PR-gating via truth-lanes | `scripts/verification/baselines/architecture-metrics.json` | B4/B6 |

### High
| ID | Title | Location | Batch |
|---|---|---|---|
| LLM-002 | Vision images sent to Anthropic in OpenAI `image_url` shape → rejected | `llm-provider-anthropic.ts:388`; `chat-turn-user-message.ts:138` | B1 |
| LLM-003 | Anthropic path uses `response.json()` directly → regresses S19 HTML-error hardening | `llm-provider-anthropic.ts:34/63/590/595` | B1 |
| CHATTURN-001 | Abort-listener leak: `{once:true}` added every 200ms live-tail poll, removed only on abort | `gateway-service.ts:8975` | B1 |
| ORCH-001 | Non-transactional run creation → duplicate active runs per plan on double-POST | `orchestration-lifecycle-service.ts:480`; `orchestration-repo.ts:248` | B1 |
| ORCH-002 | Crash mid-phase re-executes the phase (re-dispatch child turn, re-mutate worktree) | `orchestration-lifecycle-service.ts:838-1009` | B1 |
| ORCH-003 | Orphan worktree reaper implemented + tested but never invoked in production | `orchestration-worktree-service.ts:81` | B5 |
| STORAGE-001 | Partial unique index emitted as FULL unique on Postgres → breaks candidate dedup/reopen | storage schema blueprint (improvement_candidates) | B1 |
| STORAGE-002 | Mesh lease acquire/renew non-atomic (no fencing/epoch/txn) → split-brain | `mesh-repo` lease methods | B1 |
| STORAGE-003 | Synchronous Postgres client blocks the event loop (`Atomics.wait`) per query | storage sync postgres client | B3 |
| COREPKG-010 | Sandbox `writeJailRoots`/`readOnlyRoots` accept `[""]` → resolves to repo root (fail-open) | `config-schemas.ts:67-76` | B1 |
| COREPKG-017 | Secret-redaction regex suffix-anchored; in-value/contains-key secrets not redacted | `gateway-core/logger.ts:30-31` | B1 |
| INTEG-001 | `ChannelBotLoopGuard` is dead code (documented protection never wired) | channel ingest/dispatch path | B1 |
| INTEG-002 | No sender allowlist on Slack/WhatsApp/LINE/NextCloud → any signed stranger opens a session | channel webhook handlers | B5 |
| AGENTORCH-002 | Tool-loop guard ships `enabled:false`; loop/no-progress detection never runs | `config-schemas.ts:9`; `config/tool-policy.json:64` | B1 |
| AGENTORCH-003 | Per-turn/completion timeouts overridden by a 30-min "testing" constant | `chat-agent-budget.ts:28-167` | B1 |
| AGENTORCH-004 | Repair/synthesis/image provider calls never accrue usage → cost under-reported | `chat-agent-orchestrator.ts:4343/4425` | B1 |
| AGENTORCH-005 | User-content tool tokens injected into the canonical allow-map (defense-in-depth bypass) | `chat-agent-orchestrator.ts:3012-3022` | B1 |
| IMPROVE-001 | Decision-replay auto-tune writes runtime settings with no approval/gate | `improvement-service.ts:4474-4586` | B1 |
| IMPROVE-002 | `git clone` arg injection via leading-dash `sourceRef` (no `--`) → RCE (authed/supply-chain) | `skill-import-service.ts:1337` | B1 |
| IMPROVE-003 | Path traversal via skill frontmatter `name:".."` → `fs.rm` can wipe `skills/` | `skill-import-service.ts:933-943,2486` | B1 |
| PPVM-001 | Proactive `updateRun` omits `expectedVersion` → lost updates vs lease heartbeat | `chat-proactive-service.ts:866-989` | B1 |
| PPVM-002 | Synchronous ffmpeg+whisper `execFileSync` on request path blocks the event loop | `media-voice-service.ts:462-466,1366` | B3 |
| INFRA-001 | MCP stdio children killed with bare SIGTERM (no SIGKILL/taskkill) → Windows zombies | `mcp-runtime.ts:429,548,579` | B1 |
| INFRA-002 | MCP `stdin.write` has no error handler → EPIPE can crash the gateway | `mcp-runtime.ts:521,573` | B1 |
| GWROUTES-001 | Global `onSend` CSP overwrites the `/files/preview` hardened `script-src 'none'` sandbox | gateway onSend hook + files preview route | B1 |
| MCNEXT-001 | `useAsyncLoad` (2 copies) has no unmount/stale-response guard → races on workspace switch | `native-helpers.ts:70`; `SettingsShared.tsx:149` | B1 |
| MCNEXT-002 | Realtime SSE reconnects + resets stores on every notification-preference toggle | `use-event-stream.ts:54-93` | B1 |
| MCSHARED-001 | Realtime events `JSON.parse`+cast, no validation → malformed frame breaks live-update pipeline | `client.ts:974`; `realtime-derived.ts:383` | B1 |
| MCSHARED-002 | Unguarded `localStorage` get/set → throws out of UI setters in private-mode/quota | `ui-preferences.tsx:264` | B1 |
| DESKTOP-001 | Primary install path bypasses the release-signing chain (`iwr…|iex` + unpinned `git clone`) | `README.md`; `install.ps1` | B6/B5 |
| CI-002 | ESLint runs in no CI workflow (only local pre-commit) | `.github/workflows/*` | B6 |
| CI-003 | `eslint-plugin-react-hooks` installed but not wired into `eslint.config.mjs` | `eslint.config.mjs` | B6 |
| CI-004 | Provider "truth" lanes count auth-fail/404 as `not_configured` → green with zero providers | `scripts/verification/lib/scenarios.mjs` | B6 |
| CI-005 | Only always-on PR lane runs gateway with `AUTH_MODE=none`; richer lanes path-filtered | `.github/workflows/verification-fast.yml` | B6 |

### Medium / Low / Info (by domain — full detail in `.scratch/`)
gateway-routes 10 · gateway-chat-turn 15 · gateway-orchestration 12 · gateway-llm 12 ·
policy-engine 12 · storage 12 · core-packages 27 · integrations 10 · chat-agent-orchestrator 11 ·
self-improvement 13 · prompt-proactive-voice 9 · gateway-infra 14 · mc-next-surfaces 16 ·
mc-shared 13 · desktop-launcher 13 · verification-ci 15. Notable Mediums to fold into themed PRs:
`POLICY-001` (signal not forwarded to child procs), `POLICY-003` (undici Agent leak per fetch),
`INFRA-003` (SSE listener registered after replay → window of lost events), `INFRA-007` (git
ls-remote injection), `PPVM-005` (ftyp brand defaults to video → smuggling), `STORAGE-005`
(unindexed `created_at` ledger scans), `DESKTOP-003/004` (cmd.exe arg escaping; PID-reuse kill).

---

## Verified-NOT-a-problem (stale claims refuted — do not re-open)
- R1-001 narrow chat-turn host: DONE (`buildChatTurnRuntimeHost` literal; ratchet metric 0).
- SSE backpressure: correct at the write boundary (`sse-writer.ts` awaits drain; pull-based).
- Worktree cleanup: wired on every terminal outcome (the *reaper* is the gap — ORCH-003).
- Orchestration phase execution: dispatches real agent work (not animation).
- Auto-mode cost propagation: works (`costIncrementUsd` → `advancePhase`).
- SSRF/path guards (policy-engine), durable-run/approval CAS, idempotency lifecycle, auth
  X-Forwarded-For/loopback hardening, no SQL injection, Tauri ACL minimal: all re-verified correct.

---

## Proposed PR sequence (focused, off `main`, each fully gated)

**B1 — confirmed bugs (value-first, low risk).** Group by theme:
1. `pr/chat-anthropic-toolcalls` — C1 (index fix) + LLM-002 (image mapping) + LLM-003 (HTML-safe parse). *(includes the architecture-metrics baseline reconciliation if the diff touches gated paths)*
2. `pr/ci-architecture-baseline` — reconcile C2 so subsequent PRs are mergeable (and note B4 will ratchet down).
3. `pr/chatturn-abort-listener-leak` — CHATTURN-001.
4. `pr/orchestration-run-idempotency` — ORCH-001 + ORCH-002 + worktree `--force`/prune (ORCH-004).
5. `pr/storage-pg-correctness` — STORAGE-001 (partial index) + STORAGE-002 (mesh lease CAS).
6. `pr/sandbox-and-redaction-hardening` — COREPKG-010 + COREPKG-017.
7. `pr/agent-loop-guards` — AGENTORCH-002 + AGENTORCH-003 + AGENTORCH-004 + AGENTORCH-005.
8. `pr/skill-import-safety` — IMPROVE-002 + IMPROVE-003 + INFRA-007 (shared git-arg-injection helper) + IMPROVE-001 (auto-tune gate).
9. `pr/channel-botloop-and-gating` — INTEG-001 (wire guard) + INTEG-003/004/005.
10. `pr/mcp-process-lifecycle` — INFRA-001 + INFRA-002 + INFRA-003.
11. `pr/files-preview-csp` — GWROUTES-001.
12. `pr/ui-async-guards` — MCNEXT-001/002/006 + MCSHARED-001/002/003 (+ wire react-hooks lint to prevent regressions, mc-next only — see Mission Control eslint scope note).

**B2 — chat display layer** (PR-C1..C6 per the design): scroll-hook extraction, markdown perf,
a11y correctness, axe-core guardrail, UX polish, deferred virtualization.

**B3 — performance**: STORAGE-003 (async PG / off-thread), PPVM-002 (async transcription),
CHATTURN-002/003 (per-token DB writes, poll→event live-tail), POLICY-003 (undici Agent reuse).

**B4 — architectural refactors** (ratchet-gated, characterization-first): browser-tools out of
policy-engine (R1-006); finish the LLM provider seam (R1-003); configurable fallback (R1-005);
split `chat-turn-stream-service.ts`; **and the newly-surfaced monolith targets**
`chat-agent-orchestrator.ts` (15,178 lines) and `prompt-pack-service.ts` (9,248). Each drives the
architecture-metrics baseline **down**.

**B5 — features (propose → approve)**: wire the orphan reaper (ORCH-003); per-channel sender
allowlist (INTEG-002); per-wave budget enforcement (ORCH-005); + the ClawHub-adoption shortlist.

**B6 — cleanup & CI hardening**: CI-002/003/004/005 (lint in CI, wire react-hooks, fix lane
false-greens); large-file decomposition (SettingsNativePage, NativeRoutePages); install-signing
(DESKTOP-001); dead-code sweep.

## Verification per PR
`pnpm typecheck` · `pnpm lint` · the PR's `pnpm -r test` suites · `pnpm coverage:gate:production` ·
relevant `pnpm verify:*` lane(s) · `pnpm docs:check`. Refactor PRs additionally run
`pnpm verify:architecture:metrics` and lower the baseline. Chat PRs: chat component suites +
`verify:surface:regression`; rebaseline only intentional pixel changes.
