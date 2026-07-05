# GoatCitadel Review 2 — QA1 Live Re-check (post-remediation)

- **HEAD:** a81eeccc4 ("fix: close streaming findings")
- **Stack:** UI http://127.0.0.1:5173 (200; served on `localhost`) · Gateway http://localhost:8787 (/health = ok/ready, migration **v74**)
- **Date:** 2026-07-02 · **Tool:** Playwright 1.58.2 chromium (headless), domcontentloaded + fixed waits
- **Note:** curl to `127.0.0.1:8787` times out but `localhost:8787` works (gateway binds where localhost→resolves). UI on `127.0.0.1:5173` is 200.

## The 6 findings

| # | Finding (Review-1) | Verdict | Evidence |
|---|---|---|---|
| 1 | MC-responsive-1 (High): drawer bottom-docks over sticky composer at 1100px, no scrim/auto-close | **PARTIAL** | At 1100px the shell inspector still geometrically overlaps the composer + Send (`drawerOverlapsComposer:true`, `sendCoveredByOther:true`), BUT a scrim now renders (`.mc-next-inspector-scrim.open`) and dismisses on click (`scrimClickCloses:true`); Escape also closes it. Modality + escape/scrim dismiss are the fix; the drawer is not usable *simultaneously* with the composer. `gallery/MC-responsive-1_drawer-1100-scrim_partial.png` |
| 2 | MC-responsive-2 (Med): grab cursor in 1024–1180 band but drag moves 0px | **STILL-PRESENT** | Grab cursor present (`cursor:grab`, `.draggable`), JS drag DOES update `--side-inspector-drag-x/y`, but drawer moves 0px at 1150/1100/1040 (`movedAfterDrag:false`). Root cause: `@media (max-width:1180px)` sets `transform:none` (mission-control-next.css ~L2194), nullifying the drag transform. `gallery/MC-responsive-2_drag-band_still.png` |
| 3 | MC-wip-changeset-2 (Med): composer route/model + tokens/cost strip vanishes when `mc-next:composer-v2='off'` | **RESOLVED** | Default: `.mc-next-composer-context-strip` present. With `composer-v2='off'`+reload: v2 strip gone BUT the always-present chip row survives and still shows route/model (`openai-codex / gpt-5.5` / "Route checking") AND tokens/cost (`0 tokens / $0.00`). Info no longer vanishes. localStorage restored. `gallery/MC-wip-changeset-2_killswitch-off_resolved.png` |
| 4 | MC-css-tokens-1 (Med a11y): footer status spans have bare-value accessible names | **RESOLVED** | Every footer pill now has a metric-identifying `aria-label`: Gateway="Gateway reachability and access checks passed.: Gateway ready"; Live updates="Live updates: Streaming[…]"; Sessions="Sessions: 200 visible"; Spend="Spend: $0.00"; Daemon="Daemon: Serving". `gallery/MC-css-tokens-1-2_footer_resolved.png` |
| 5 | MC-css-tokens-2 (Med a11y): Approvals footer button had no aria-label (name="0 pending") | **RESOLVED** | Approvals pill is a `<button class="mc-next-status-pill-action">` with `aria-label="Approvals: 0 pending"` and `title="Approvals"`. Names its purpose. |
| 6 | MC-a11y-2 (Med): Escape did not close right drawer | **RESOLVED** | Shell inspector opened → Escape → drawer closed (`drawerAfterEsc:false`), reproduced twice. Wired via `dismissTopmost` + `useShellKeyboardManager` (inspector > nav priority). `gallery/MC-a11y-2_after-escape_resolved.png` |

## TTFT-after
- **Median: 8338 ms** (trials 8338 / 21960 / 7532), delta **+5027 ms** vs 3311 ms baseline. `qa/ttft-after.json`.
- **CRITICAL CAVEAT — not a like-for-like comparison.** Every session in this workspace resolves to **Cowork** (Send button = "Delegate"); `?mode=chat` is overridden (see N3), so a plain-chat turn could not be produced. These are cowork agentic-orchestration turns (planner+workers, store-and-poll). Gateway log during the run shows provider `Chat completion timed out after 1500ms` with retries 0–2 and some fully failed turns → latency reflects local provider instability + orchestration overhead, not UI streaming regression. Treat the delta as environment/mode-driven, not a proven code regression.

## N1–N3
- **N1 (realtime):** **STILL "compatibility fallback"** (mostly). Dedicated 15s/6-sample watch on chat = stable "Live updates: Streaming (compatibility fallback)", topbar "Live fallback". (Footer intermittently flips to authoritative "Streaming" when an active SSE frame is authoritative — captured once — but the resting state is compatibility.) `qa/n1-realtime.json`
- **N2 (cowork task board hydration):** **RESOLVED / faster.** `/cowork/tasks` content appeared at **~808 ms** with **no long spinner** (was >4.5s). `qa/n2-cowork-hydration.json`, `gallery/N2_cowork-tasks-fast_resolved.png`
- **N3 (`?mode=chat` overriding a cowork-locked session):** **STILL not overriding.** Requested `/chat?mode=chat` → URL rewrites to `/chat?mode=cowork`, `data-active-mode=cowork`, Send="Delegate". Interactive mode-control "Chat" pin flips only the control's class (pending hint), not the bound session. `gallery/N3_mode-chat-override_still.png`

## P0 smoke + regression watch
All 7 surfaces PASS with **0 console errors** (no NEW runtime errors vs Review 1, no blank surfaces, no error boundaries). `qa/qa-results-pass2.csv`, `qa/smoke-console-errors.json`.

| surface | pass | console errors |
|---|---|---|
| chat | PASS | 0 |
| cowork | PASS | 0 |
| code | PASS | 0 |
| approvals | PASS | 0 |
| library | PASS | 0 |
| settings | PASS | 0 |
| projects | PASS | 0 |

**No live regressions observed.** The policy-engine/contracts module-load test regressions mentioned in the brief did not manifest as any runtime console error, blank surface, or broken behavior in the browser across all 7 surfaces.
