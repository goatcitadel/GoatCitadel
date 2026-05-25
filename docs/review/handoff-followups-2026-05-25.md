# Mission Control Next — handoff for finishing remaining work

**Date:** 2026-05-25
**Last commit on `main`:** `f4e4d723` (W4.4 shell extraction + W4.5 CSS trim + W5 Phase 1)
**Purpose:** Self-contained brief for a fresh session picking up the remaining post-ship work. Paste the entire "Pickup brief" section below as the first message of a new thread.

---

## Pickup brief

> Copy everything in this code block to start a fresh session.

```
# Finish Mission Control Next ship-readiness — pickup brief

You're picking up a multi-day Mission Control Next ship-readiness effort
mid-stream. All CRITICAL + HIGH ship-blockers are CLOSED; what remains is
post-ship polish, a few owner-blocked items, and the larger code-health
refactors that didn't fit in prior sessions.

## Repository layout
- Working dir: `F:\code\personal-ai`
- Ship target: `apps/mission-control-next` (Vite + React 19 + TS)
- Legacy app (mid-retirement): `apps/mission-control`
- Desktop: `apps/mission-control-desktop` (Tauri, iframes mc-next, Path A locked = stays)
- Shared: `packages/mission-control-shared`, `packages/threaded-surface-core`

## Read these FIRST before you do anything
1. `C:/Users/spurn/.claude/plans/swirling-questing-pizza.md` — the approved plan
2. `docs/review/mission-control-next-ship-punchlist.md` — what was triaged
3. `docs/review/mission-control-next-ship-bar.md` — the shipping rubric
4. `docs/review/legacy-mission-control-retirement-plan.md` — W5 phased kill order
5. `docs/review/mission-control-next-css-budget-analysis.md` — budget background
6. `docs/review/handoff-followups-2026-05-25.md` — this doc

## State of the repo (HEAD: f4e4d723 on origin/main)

**Green guardrails:**
- typecheck PASS · 417 tests PASS · perf:check FULLY GREEN
- legacy-check, token-drift, CSS budget (156130 / 184320 bytes, 28KB headroom) all green
- PromptPacks orchestrator is 293 lines (was 2872); 16 module split

**9 commits landed across the prior sessions** (in chronological order):
3ab0b283 foundation · 537ed700 reviews · ad0f993a sprint 1 · 8df31849
waivables · 2f6e1b11 H-7 keyboard · d1e657ea sprint 2 · dfab572a closure
· c4122c90 post-ship wave 1 · f4e4d723 W4.4+W4.5+W5 Phase 1

## What's left (priority order)

### Owner-blocked (ask the user FIRST before touching)
1. **TC-2 (#19) Citadel Light palette decision** — `tokens.css` declares
   warm-cream `--bg-surface-2: #eeeae0` matching brand-spec's "warm
   paper-white" + `--brand: #f4ead6` (cream-gold); `mission-control-next.css`
   declares cool-blue `rgba(248,250,253,0.98)` which is what currently
   renders in Citadel Light theme. Owner picks one. Then unblocks #15.
2. **#15 W1.1 Phase B token sweep** — once palette is decided, mechanically
   alias `--mc-*` / `--gc-*` declarations in the 5 grandfathered files to
   canonical names. See `scripts/check-mission-control-next-token-drift.mjs`
   `GRANDFATHERED_FILES` allowlist — shrink it to just `mission-control-next.css`.
3. **W-3 cross-project Recent sessions** — needs new backend data shape
   (cross-project session aggregation). Not just UI. Confirm with owner
   whether to ship Projects without it or extend a contract.

### Safe to drive without owner input
4. **W5 Phase 2: remove legacy discoverability** — `dev:ui:legacy` script
   in root `package.json`, `LEGACY_UI_PACKAGE` in `scripts/lib/ui-target.mjs`,
   `GOATCITADEL_UI_PACKAGE` legacy fallback in `bin/goatcitadel.mjs` and
   `scripts/dev.mjs`. README "compatibility-only" line + `docs/1_0_RELEASE_EVIDENCE.md`
   wording. `RELEASE_SURFACE_MANIFEST` (legacy 15-surface) in
   `scripts/verification/lib/release-surface-manifest.mjs` + paired
   validator update at `scripts/validate-governance-docs.mjs:439, 474`.
   **WARNING**: these files police each other's wording — touch them in
   one atomic commit.
5. **W4.2 NativeRoutePages.tsx decomp** (3369 lines) — likely a route
   registry that grew. Read the file first; expect per-route extraction
   into sibling files. Use the same strangler-fig pattern that worked for
   W4.3 PromptPacks.
6. **W4.1 SettingsNativePage.tsx decomp** (8842 lines, biggest beast) —
   cut by brand-spec 4-group IA: Foundations / Identity / Surfaces /
   Operations. Strangler-fig: build new files alongside, route by feature
   flag if needed, cut over per-group. NOTE: this file has the H-9 unsaved-
   state plumbing (`useFormDirty` integration) — preserve carefully.
7. **W5 Phase 3-5**: archive `apps/mission-control/` source + dead-code
   sweep `packages/mission-control-shared/src/` (candidates: `CoworkCanvasPanel`,
   shared `CodeWorkbenchPanel`, `ConfigureHubLayout`, `EmbeddedPageChrome`)
   + desktop disposition doc-update (Path A = stays).
8. **W6.1 visual regression baselines** — capture screenshots via
   Playwright (already in `.playwright-cli/`) at 1440×900, 1280×800,
   1024×768, both themes. Store in `docs/review/baselines/`.

## Critical patterns / constraints (don't relearn the hard way)
- **Token-drift guard active** — adding new `--mc-*`/`--gc-*` CSS declarations
  fails the perf:check chain. Use canonical `--bg-*`/`--fg-*`/`--brand`/`--r-*`/`--text-*`/`--area-*`/`--risk-*` names.
- **legacy-check forbids `chat-v11` substring** anywhere in `apps/mission-control-next/src/` — even in comments. The legacy `ChatQueueBar` shared component now emits BOTH legacy + new class (`chat-v11-queue-bar mc-queue-bar`) so legacy app still works.
- **File-size lint**: 1000-line max. Documented `eslint-disable max-lines`
  with plan-file reference is the escape hatch (see `MissionControlNextApp.tsx:1`
  and `MemoryRoutePage.tsx:1` for the pattern).
- **Don't add `eslint-disable react/jsx-no-useless-fragment`** — that rule's
  plugin isn't loaded; the disable comment itself errors.
- **Test files with DOM/JSX need `.test.tsx` + `// @vitest-environment happy-dom`** directive at top (see `use-shell-keyboard-manager.test.tsx`).
- **Pre-commit hook** runs prettier + eslint via lint-staged. Trust it; fix
  what it flags rather than skipping.
- **Pushing to main** — repo has "changes via PR" rule but bypass-permission
  is granted; direct push to main works. CodeQL scan runs async on each
  push (informational message in push output).
- **CSS additions are CHEAP**: budget headroom is currently 28KB. Don't
  bloat carelessly, but don't squeeze pennies either.

## Suggested first move
Start by reading the 6 review docs above, then ask the owner about
**TC-2 palette** + **W-3 cross-project Recent sessions backend** in a
single round of questions. Those unblock the most downstream work.
Then dispatch parallel subagents for W4.1 + W4.2 (biggest remaining
refactors) while you drive W5 Phase 2 + W5 Phase 3 yourself. W6.1 last
since it's deployment-dependent.

Be ambitious with parallel subagent dispatches — the owner has consistently
preferred wide sweeps over sequential work this session. But check in
before touching files where multiple subagents might collide
(MissionControlNextApp.tsx, NativeRoutePageLayout.tsx, native-routes.css).
```

---

## Optional dial-up / dial-down phrases

Append one of these to the pickup brief depending on appetite:

| Mode | Append phrase |
|---|---|
| **Speed (default this session)** | `Auto Mode is on — dispatch wide parallel sweeps when independent items align.` |
| **Cautious** | `Single-track work only. Verify between items.` |
| **Scope-limited** | `Just close W5 Phase 2 + W4.2 NativeRoutePages decomp this session; defer the rest.` |
| **Sequential biggest-first** | `Drive W4.1 SettingsNativePage decomp alone — that's the biggest debt. Defer everything else.` |

## Task list state at handoff time

Pending across the Claude task list:
- `#15` W1.1 Phase B token sweep (blocked on #19)
- `#19` TC-2 Citadel Light palette (owner decision)

Both are also captured in the pickup brief above. Claude task list entries don't persist across machines / fresh sessions — this doc + the linked plan are the durable record.
