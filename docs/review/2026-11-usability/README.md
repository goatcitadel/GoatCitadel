# 2026-11 usability review (Cockpit)

Review-only. Nothing under `apps/`, `packages/`, `scripts/`, `config/` or `skills/` is edited. Plan: `docs/superpowers/plans/2026-11-14-usability-review.md`.

## Pinned source

`PINNED_SHA` = `996d052fae96b7592b9f3851dc073734b998babe` (`origin/main` when the worktree was created; never moved).
Worktree: `.claude/worktrees/usability-review-2026-11`, branch `review/usability-2026-11`.

## Files

| Path | Purpose |
|---|---|
| `findings.json` | Array of finding records (shape in the plan) |
| `prior-register.json` | Phase 1 verdicts on earlier findings (created in Phase 1) |
| `journeys.md` | The journey files under `journeys/` concatenated in task order, unchanged (the report's journey table is in `../2026-11-usability-review.md`) |
| `tools/report-numbers.cjs` | Prints every number the report states; `--check <report>` checks the report's ids, journey table and paths |
| `evidence/<prefix>/` | Screenshots and logs per area prefix, lower case (`gl` = everywhere) |
| `tools/shot.cjs` | Playwright screenshot helper |
| `tools/check-register.cjs` | Phase 1 register checker |
| `tools/seed.mjs` | Seeds a sandbox Gateway (demo bootstrap + verification fixture) |

## Sandbox recipe (auth mode `none`, stub model)

1. Install: `HUSKY=0`, `pnpm install --offline --frozen-lockfile`. A fresh empty store next to the worktree cannot satisfy `--offline`, so the default pnpm store was read instead (reads only). No junctions into another checkout.
2. Build: `pnpm --filter "@goatcitadel/contracts" build`, then `pnpm --filter "mission-control-next^..." build`.
3. Start, hidden, in the background, output to a log file (never a visible console window):
   `Start-Process -FilePath pnpm.cmd -ArgumentList testbench -WindowStyle Hidden -RedirectStandardOutput <log> -RedirectStandardError <log2> -PassThru`
   The testbench prints `[testbench]` lines with the UI, Gateway and stop-file path. It uses its own runtime root, home, SQLite database and backup directory in the OS temp folder, the deterministic LLM stub, and no keychain.
4. Stop: create the stop file the testbench printed (`artifacts/testbench/<run>/stop`). Do not kill the launcher: killing it skips teardown. Before stopping any process, confirm its command line belongs to this worktree.

The UI, Gateway and stop-file URLs change on every start, so read them from the `[testbench]` lines of that run's log instead of from this file.

## Rebuilding findings.json

`findings.json` is generated; never edit it by hand. Rebuild it with:

```
node docs/review/2026-11-usability/tools/build-findings.cjs
```

It runs three steps in order: `apply-verdicts.cjs` (carried findings from `prior-verdicts/*.json`), `apply-new-findings.cjs` (Phase 2 findings from `new-findings/*.json`) and `apply-overrides.cjs` (Task 15: `overrides.json` corrections, root causes, merges and removals, then the ranking). Ids are stable through the append-only `_ids.json` maps, which are keyed by title, so a finding's wording is corrected in `overrides.json`, never in its source file. Removed findings are listed in `withdrawn.json`; root causes are in `root-causes.md`. Running the build twice gives the same `findings.json` byte for byte.

## Screenshots

```
REVIEW_WORKSPACE_ID=<workspace id> node docs/review/2026-11-usability/tools/shot.cjs <url> <out.png> [--phone] [--light]
```

Sets localStorage `goatcitadel.ui.workspace_id.v1`, `goatcitadel.ui.citadel_id.v1` (default `personal`) and `goatcitadel.ui.theme.v1` before navigation, waits for `#main-content`, grows the viewport to fit that scroll container (cap 8000 px), saves the element screenshot, and prints console errors, page errors, failed requests and HTTP >= 400 responses as JSON lines. Default 1440x900 dark; `--phone` 375x812; `--light` light theme. Optional `--workspace`, `--citadel`, `--wait <ms>`. Playwright 1.58.2 comes from the worktree's installed packages.

## Register check

`node docs/review/2026-11-usability/tools/check-register.cjs [prefix...]` prints `unverdicted: N` and `uncarried: N` and exits 1 when either is above 0.

## What is seeded

- `POST /api/v1/demo/bootstrap`: workspace "GoatCitadel Demo", project "Adoption Tour", one demo chat session, two demo tasks, one memory seed, one pending first-run approval checkpoint.
- `scripts/verification/lib/scenarios/fixture-seeding.mjs` via `tools/seed.mjs`: workspace "Mission Control Next Verification Workspace" (the one the screenshots use), 8 sessions (one long thread, one pending approval, one pending user input), generated artifact, project "Mission Control Verification" with 3 sessions, 2 agents, Citadel charter with 2 chambers and 2 wards, 4 tasks with agentic runs, Ops board, memory admin flag on, one memory item, one file under `workspace/verification/`, one prompt pack.
- In this run the Ops board step did NOT return 403 under auth `none`, so the fixture finished on its own. My first run then also executed the by-hand memory/file/prompt-pack steps, so the sandbox holds a duplicate prompt pack ("Mission Control Next Verification Pack" twice), one extra memory item and one overwritten file. `tools/seed.mjs` now skips the by-hand steps when the fixture completes.
- Three pending approvals in total.

## Token-mode recipe (not started)

A second Gateway for Task 13: port 18787, scratch directories, keychain off, auth `token`, UI origin in CORS.

```
GOATCITADEL_ROOT_DIR=<scratch>/root
GOATCITADEL_HOME=<scratch>/home
GOATCITADEL_BACKUP_DIR=<scratch>/backups
GOATCITADEL_LOCAL_ENV_FILE=<scratch>/.env
GOATCITADEL_DISABLE_SECRET_STORE=true
GOATCITADEL_AUTH_MODE=token
GOATCITADEL_AUTH_TOKEN=<a throwaway test token generated for the run>
GOATCITADEL_DATABASE_DRIVER=sqlite
GOATCITADEL_ALLOWED_ORIGINS=<UI origin of the Vite instance used, e.g. http://127.0.0.1:5173>
GOATCITADEL_RATE_LIMIT_ENABLED=false
GOATCITADEL_DEV_DIAGNOSTICS_ENABLED=true
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=18787
```

Start with `node apps/gateway/dist/main.js` hidden with log redirection, with a UI whose `VITE_` Gateway origin points at 18787. These names come from `scripts/verification/lib/runtime.mjs` and `scripts/testbench-runtime.mjs`; confirm the token variable name against `docs/` when Task 13 starts. Stop the auth-`none` testbench first (one heavy job at a time).
