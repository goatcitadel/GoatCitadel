# Mission Control test bench, phase 1: live console — design

- **Date:** 2026-10-03
- **Status:** Approved direction (operator review in chat, 2026-10-03); pending spec review
- **Surface:** `apps/mission-control-next` (new dev-only page), `scripts/testbench*.mjs` (new launcher), root `package.json` (one script). No Gateway changes.
- **Evidence:** repository inventory on 2026-10-03 (route-access manifest, shared API clients, verification lanes, existing demo entry)
- **Phasing:** phase 1 is the live console plus the shared page shell (this spec). Phase 2 is a fixture-driven UI gallery tab (separate spec). A headless CLI is a possible later addition.

> File and line anchors come from `main` on 2026-10-03 and are approximate. Verify them at implementation time.

## 1. Goal

Give the operator one dev-only page that exercises GoatCitadel's functionality quickly and honestly: run every check that is allowed on the current gateway, see what passed, failed, was blocked, or was skipped, and see how much of the Gateway API the checks actually cover.

"Every bit of functionality" is measured, not asserted. The Gateway exposes about 930 `/api/v1` routes across about 35 areas. The page reports covered routes against the Gateway's own route list and lists every route that no check claims.

## 2. Decisions

| Question | Decision |
| --- | --- |
| What kind of test page | Hybrid: live API console (phase 1) plus fixture UI gallery (phase 2), as tabs on one page |
| Which gateway | An isolated sandbox runs the full suite. The operator's real gateway runs read-only checks plus allowlisted external checks that the operator confirms one at a time |
| Test depth | Probes (one per route) plus journeys (hand-written multi-step flows) |
| Headless | Page only. The catalog and runner contain no React or DOM code so a CLI can be added later |
| Approach | Route-manifest-driven catalog that runs in the page and calls the shared API client |
| Layout | Three-pane inspector: area rail, check list, detail drawer |

Rejected approaches: wrapping the `scripts/verification` scenarios (needs a Node bridge process and gives no per-route coverage) and a Gateway self-test endpoint (skips the browser-to-Gateway path, adds Gateway code, and runs in-process on the real runtime).

## 3. Existing pieces this builds on

| Piece | Where | Use |
| --- | --- | --- |
| Dev-only Vite HTML entry | `apps/mission-control-next/chat-demo.html` | Precedent. The production build has no `rollupOptions.input`, so only `index.html` ships |
| Gateway origin override | `packages/mission-control-shared/src/api/client-core.ts:27-55` | The `goatcitadel-gateway-origin` meta tag wins over `VITE_GATEWAY_URL` and is read once at module load. It accepts loopback `http` origins only |
| Generic authenticated request | `client-core.ts:162` (`request<T>`) | Auto-probes and routes without a client function |
| Shared API client functions | `packages/mission-control-shared/src/api/*.ts` (about 830 functions) | Hand-written checks call these |
| Route list | `GET /api/v1/dev/verification/route-access-manifest` (`apps/gateway/src/routes/dev-verification.ts:111`) | Coverage denominator: method, URL pattern, and access class per route |
| Sandbox identity | `GET /api/v1/dev/verification/status` returns `rootDir` | Third condition of the sandbox check |
| Scenario seeds | `POST /api/v1/dev/verification/*` (seed, chat-approval, user-input, attachment, agentic-task, memory-item, durable-recovery, realtime-truth) | Journey setup |
| Dev endpoint gating | `GOATCITADEL_DEV_DIAGNOSTICS_ENABLED`, default on when `NODE_ENV !== production` | Dev endpoints return 404 on a production runtime |
| Isolated stack | `scripts/verification/lib/runtime.mjs` (`startVerificationStack`, `stopVerificationStack`) and `scripts/verification/lib/scenarios/deterministic-llm-stub.mjs` | The `pnpm testbench` launcher |

## 4. Entry, gating, and launcher

### 4.1 Page entry

- New `apps/mission-control-next/testbench.html` loads `src/__testbench__/main.tsx` into its own root element, mirroring `chat-demo.html`.
- `vite.config.ts` is not changed. The dev server serves the HTML file; the production build ignores it.
- Second guard: if `import.meta.env.PROD` is true, the entry renders a refusal screen and loads nothing else.

### 4.2 Target selection

- The entry reads `?target=sandbox|real` **before** importing anything from the shared client, injects the `goatcitadel-gateway-origin` meta tag, then imports the app module dynamically.
- `sandbox` resolves to `VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN`. `real` resolves to `VITE_GOATCITADEL_TESTBENCH_REAL_ORIGIN` when set, otherwise the normal default (`VITE_GATEWAY_URL` or the inferred default gateway).
- A production Gateway only accepts browser origins on its CORS allowlist (ports 5173, 4173, 8787 by default). Real-gateway testing of an installed runtime therefore works from the everyday dev server on port 5173; from the launcher's port the page shows the unreachable state with that hint.
- With no `target`, the default is `sandbox` when the launcher supplied a sandbox origin, otherwise `real`.
- Switching target reloads the page. Nothing in `client-core.ts` changes.
- Gateway auth uses the existing preflight (`preflightGatewayAccess`). A `needs-auth` or `unreachable` result is shown as a page state, not as failed checks.

### 4.3 `pnpm testbench` launcher

New `scripts/testbench.mjs`, exposed as the root script `testbench`. It sits beside `scripts/dev.mjs`, following the repo's flat layout for dev launchers:

1. Start the deterministic LLM stub (`startDeterministicLlmStub`).
2. Build the scratch runtime root with `prepareUsabilityRuntime(runId, stub.baseUrl)`. It reads only the tracked `config/goatcitadel.example.json` and writes the stub as the only provider. It never reads gitignored real config, secrets, or `workspaces/`. The stock `prepareVerificationRuntime` copies all of `config/` and `workspaces/`, so the launcher does not use it. The fixture copies the whole `skills/` directory, so the launcher then replaces that copy with the git-tracked skill files only (`git ls-files`); untracked workspace skills never reach the sandbox, and the launcher refuses to start when git cannot answer.
3. Call `startVerificationStack` with that `runtimeRoot` and `gatewayMode: "built"`. Gateway environment: SQLite, `GOATCITADEL_AUTH_MODE=none`, `GOATCITADEL_DISABLE_SECRET_STORE=true`, dev diagnostics on, rate limiting off, bundled Postgres, llama.cpp, and NPU off, Code Mode v1 on (`GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED=true`, so the `host` check can run), memory lifecycle admin on (`GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED=true`; the shipped example config turns it off, which would leave the memory journey blocked), the stub key, and the path variables `GOATCITADEL_HOME`, `GOATCITADEL_BACKUP_DIR`, `GOATCITADEL_LOCAL_ENV_FILE`, and the two Code Mode roots pinned inside the scratch root (otherwise backups default to the operator's real `~/.GoatCitadel/backups`; the stack also pins `GOATCITADEL_ROOT_DIR`). Secret-bearing variables are omitted from both children (`collectVerificationSecretEnvKeys`). So are the path overrides the test bench does not pin (`GOATCITADEL_CAPABILITY_CANDIDATE_ROOT`, `GOATCITADEL_LLM_MODEL_METADATA_PATH`, `GOATCITADEL_LLM_MODEL_CATALOG_CACHE_PATH`, `GOATCITADEL_PROMPT_PACK_PATH`), so an operator shell that exports them cannot point the sandbox at operator files and the gateway uses its defaults inside the scratch root. Any other path variable the operator shell exports is still inherited. The UI runs in Vite dev mode with `VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN`, `VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT`, and `VITE_GOATCITADEL_TESTBENCH_REAL_ORIGIN` (`http://127.0.0.1:8787`) set.
4. Complete onboarding on the sandbox (`ensureOnboardingComplete`) so Chat is not routed to setup.
5. Print `<uiUrl>/testbench.html?target=sandbox` and the log folder. `startVerificationStack` always builds the Gateway workspace first and buffers child output until exit, so the launcher prints a line before and after each phase.
6. Do not hold the verification run context: it takes the worktree output lock, which would block every build and typecheck while the test bench runs. Logs go to `artifacts/testbench/<runId>/` (gitignored).
7. Shutdown is armed before anything starts, so a stop request at any point leads to the same teardown. The triggers are Ctrl+C, SIGTERM, and a stop file at `artifacts/testbench/<runId>/stop` (a background launcher on Windows cannot be sent Ctrl+C, and killing it would skip teardown). A startup phase already in progress is awaited to completion first so that everything it started can be stopped; the synchronous gateway workspace build therefore delays a stop until it returns. An unexpected exit of the sandbox gateway or the UI also triggers teardown and a non-zero exit code. Teardown closes the stub and calls `stopVerificationStack` (never throws), which stops only the processes the launcher started and deletes the scratch root.

The operator's everyday `pnpm dev` server also serves `/testbench.html?target=real`, so the launcher is not needed for real-gateway checks.

## 5. Target and safety model

### 5.1 Tiers

Every check declares exactly one tier.

| Tier | Meaning | Sandbox | Real gateway |
| --- | --- | --- | --- |
| `read` | GET and SSE reads with no side effects | Runs automatically | Runs automatically |
| `mutate` | Changes Gateway data: sessions, memory, approvals, durable runs, backups | Runs automatically | Never. Shown disabled with the reason |
| `host` | Runs processes or touches files on this machine: Code Mode, shell tools, sidecars | Only when the per-run "allow host checks" box is ticked | Never |
| `external` | Leaves the machine or costs money: provider calls, channel sends, outbound webhooks, web search | Each check enabled and confirmed by the operator | Only checks marked `realSafe`, each confirmed: the live model catalog (reaches the provider's API, spends no tokens, saves nothing) and the provider exercise (spends tokens and records model-usage entries on that Gateway). The confirmation states which applies |

Code Mode is `host`, not `mutate`: a throwaway Gateway still executes code on the operator's machine. Nothing in the page claims hostile-code sandboxing.

An external confirmation covers exactly one run of exactly one check; it is never remembered. The dialog says where the check runs (the sandbox gateway, or the real gateway at its origin), that it leaves this machine, and then shows that check's own `description`. The description is where each check states its cost (tokens spent, provider API reached, usage entries recorded), so every `external` check must carry one; the catalog integrity test enforces it.

### 5.2 Sandbox check

The page treats the gateway as the sandbox only when all three conditions hold:

1. The URL has `target=sandbox`.
2. The resolved origin equals `VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN`.
3. `GET /api/v1/dev/verification/status` succeeds and its `rootDir` equals `VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT`, after path normalization.

If any condition fails, the page applies real-gateway rules and the target badge names the failed condition.

This check prevents accidents. It is not a security boundary. Gateway policy, approvals, path jails, and auth remain authoritative, and the page never bypasses them. Journeys that settle approvals use the normal approvals API, and only in the sandbox.

### 5.3 Run behavior

- `read` checks run with a concurrency limit of 4. `mutate`, `host`, and `external` checks and all journeys run one at a time.
- "Run all allowed" never runs `external` checks, including ones confirmed earlier: it carries no confirmations, so they are skipped with the reason "External checks run only after you confirm them." Each external check runs from its own Run button after its own confirmation.
- A global Stop aborts in-flight work through an `AbortSignal` passed to every check.
- In the sandbox, each "Run all" seeds a fresh test workspace and passes its id through the check context, so runs stay independent.
- Results live in page memory only. They are never written to Gateway or runtime storage. "Copy report" puts a Markdown summary on the clipboard.

## 6. Catalog and runner

### 6.1 File layout

```text
apps/mission-control-next/
  testbench.html
  src/__testbench__/
    main.tsx            # PROD guard, target meta injection, dynamic import
    gateway-target/             # target resolution, sandbox check
    runner/             # check model, tier policy, error classification, scheduler, reducer
    catalog/            # index.ts registry, auto-probes, exclusions, one file per area
    ui/                 # React page, three-pane layout, styles
scripts/
  testbench.mjs               # launcher
  testbench-runtime.mjs       # runtime root + child environment builders
  testbench-runtime.test.mjs  # node:test, like dev-bootstrap.test.mjs
```

`runner/` and `catalog/` import no React and touch no DOM. Files stay under 400 lines; split areas by sub-domain when needed (for example `chat-sessions.ts` and `chat-turns.ts`).

### 6.2 Check model

```ts
type CheckTier = "read" | "mutate" | "host" | "external";
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
// Spelled exactly as the route-access manifest spells it, including :params.
type RouteKey = `${HttpMethod} /api/v1/${string}`;

type CheckKind = "auto" | "probe" | "journey";

interface CheckContext {
  target: TargetInfo; // kind, origin, sandboxVerified, reason
  workspaceId?: string; // seeded per run in the sandbox
  signal: AbortSignal;
  log(message: string, data?: unknown): void; // evidence for the drawer
  step<T>(title: string, run: () => Promise<T>): Promise<T>; // a named journey stage
}

interface CheckResult {
  status: "pass" | "fail" | "blocked";
  summary: string;
  evidence?: unknown; // shown only as secondary raw detail
}

// One shape for auto-probes, hand-written probes, and journeys.
interface CheckDef {
  id: string;
  kind: CheckKind;
  domain: string;
  title: string;
  tier: CheckTier;
  routes: RouteKey[];
  description?: string; // required on external checks: states the check's own cost
  realSafe?: true; // external only
  needsWorkspace?: true; // needs the per-run seeded workspace (sandbox only)
  steps?: string[]; // declared journey step titles, in order
  timeoutMs?: number;
  run(ctx: CheckContext): Promise<CheckResult>;
}
```

- A journey is a `CheckDef` with `kind: "journey"`, not a separate type. Its `run` body wraps each stage in `ctx.step(title, fn)`; the scheduler records the step as running, then passed or failed, and the drawer shows the declared `steps` titles that were never reached as `○ <title> (not run)`. A journey declares at least two steps. The scheduler abandons a stopped or timed-out check at its next `ctx.step` boundary, so journeys route every mutating call through a step.
- Hand-written checks call shared client functions. They use `request()` only for routes without a client function. No raw `fetch`.
- Small assertion helpers check results, reusing schemas that `@goatcitadel/contracts` already exports. No new dependencies.
- Journeys use the `/api/v1/dev/verification/*` seed endpoints for setup.

### 6.3 Result states

| State | Meaning |
| --- | --- |
| `pass` | All assertions held |
| `fail` | An assertion failed or an unexpected error occurred |
| `blocked` | The feature is disabled or unavailable on this gateway (recognized feature-flag 404, provider-not-configured 503, dev endpoints off) |
| `skipped` | The check's tier is not allowed on this target. The reason is stored |
| `cancelled` | Stopped by the operator |
| `not run` | Never started in this page session |

Only `pass` renders as success. If the gateway is unreachable, the run stops with a banner instead of failing every remaining check.

**Seeding.** In the sandbox each run seeds one test workspace before the checks that need it. If seeding fails, those checks finish with the classification of the seed error and the summary prefix "Could not seed a test workspace: ". `blocked` is for a disabled or unavailable feature, so a seed error that the table above classifies as `blocked` (disabled, feature flag off, access refused, 503) stays `blocked`; any other seed error, including an unexpected one, is `fail`. An unreachable gateway ends the run, and a Stop during seeding leaves those checks `cancelled`. On a target that cannot seed (the real gateway) they finish `blocked` with "No seeded test workspace is available on this target."

The Gateway has no dedicated "feature disabled" error code, so classification matches the known shapes (all through `ApiRequestError`, which carries `kind`, `status`, and the parsed `body`):

| Response | Result |
| --- | --- |
| `kind: "network"` | Unreachable: stop the run |
| `AbortError` | `cancelled` |
| 404 whose `body.error` mentions "disabled" | `blocked` |
| 409 with `body.code === "STATE_CONFLICT"` and `body.details.flag` | `blocked` (feature flag) |
| 400 whose `body.error` contains "is disabled" (Code Mode) | `blocked` |
| 401 or 403 | `blocked` (access refused) |
| 503 | `blocked` (unavailable or not configured) |
| Anything else | `fail` |

A message taken from a non-JSON response body is capped at 300 characters with an ellipsis; the full body stays in the evidence.

### 6.4 Coverage and auto-probes

- **Covered** means a route in the Gateway's route list that at least one check claims. The meter shows covered over total.
- **Auto-probes:** at runtime the catalog generates a `read` probe for every manifest `GET` route with no `:param`. It skips SSE routes (`sse-read` access class), the dev seed endpoints, and a curated exclusion list in `catalog/auto-probe-exclusions.ts` where each entry carries a reason (reaches a remote provider, streams, downloads a large payload). On the real target, auto-probes also skip whole areas whose reads may reach the network (providers, integrations, MCP, mesh, A2A, voice) until their routes are reviewed into the catalog.
- An auto-probe passes on a 2xx response with parseable JSON. A recognized feature-disabled response marks it `blocked`.
- A hand-written check that claims a route replaces that route's auto-probe.
- **Stale claims:** a check that claims a route missing from the route list is flagged in the Uncovered tab. This catches renamed or removed routes.
- When the route list is unavailable (dev endpoints off on a production runtime), the meter reads "unavailable", not zero, and only catalog checks run.

### 6.5 State

Run state is an immutable reducer. The runner emits events: `run-started`, `check-skipped`, `check-started`, `step-started`, `step-finished`, `check-logged`, `check-finished`, and `run-finished` with `reason: completed | stopped | unreachable` (plus the banner text for `unreachable`). When a run ends, checks that never finished settle as `cancelled` after a stop and as `not run` after an unreachable gateway. The UI renders state and dispatches commands only.

## 7. Page UI

- **Top bar:** target badge (`SANDBOX ✓ verified` in teal, or `REAL` in amber) with origin and, for the sandbox, the root folder; the failed sandbox condition when there is one; the coverage meter; Run all allowed, Stop, and Copy report.
- **Tabs:** Live console, and Uncovered routes (every unclaimed route grouped by area, plus stale claims). The UI gallery tab arrives in phase 2; no placeholder tab before then.
- **Filters:** status (failing, blocked, skipped, not run), tier, and search across check titles and route keys.
- **Three panes:**
  - Rail: areas with pass over total.
  - List: rows with status, title, kind (auto, probe, journey), tier, duration, and a Run button.
  - Drawer: summary, journey steps with per-step status, the error, and a collapsed raw response labelled as secondary detail.
- **Disallowed checks:** the Run button stays visible but disabled, with the reason stated (for example "Host checks are not allowed for this run" or "Mutating checks never run on the real gateway").
- **External checks:** a confirmation dialog names where the check runs and shows the check's own description of its cost (section 5.1).
- **Narrow screens:** the rail becomes a dropdown and the drawer a bottom sheet. No horizontal page scroll.
- **Design and accessibility:** use `mission-control-next-tokens.css` tokens and existing primitives with no hard-coded font sizes. Every status pairs an icon with a word. The list is semantic, with arrow-key navigation and visible focus. One polite live region announces when a run finishes, not on every row.

## 8. Phase 1 scope

Infrastructure: the page entry, target selection, sandbox check, runner, reducer, three-pane UI, Uncovered tab, Copy report, the `pnpm testbench` launcher, and auto-probes with the curated exclusion list.

First wave of hand-written checks:

| Area | Checks (tier) |
| --- | --- |
| Health | `/health`, `/livez`, readiness (`read`) |
| Providers | Provider list and LLM config (`read`); chat completion through the active provider, which is the stub in the sandbox (`mutate`); live model catalog (`external`, `realSafe`); provider exercise (`external`, `realSafe`) |
| Chat | Session lifecycle: create, rename, archive, restore (`mutate`); route preflight then streamed reply from the stub, which fails unless the stream reports no error, sends its final message and `done`, and the streamed deltas add up exactly to the final message (`mutate`); cancel a turn that is waiting for approval (`mutate`); attachment upload with SHA-256 round trip (`mutate`) |
| Approvals | Journey: seed, approval appears, reject, approval recorded as rejected (`mutate`). Journey: seed, approve, the response must link to the seeded turn's durable run (resumed, same run id), the run leaves `waiting` for a woken status (`queued`, `running`, or `completed`), approval recorded as approved (`host`, because approving the seeded `shell.exec` approval may run its `pnpm test` command on this machine; the check proves the wake linkage and does not verify that the command ran or what it did) |
| User input | Journey: seed, answer the single-select prompt; the answer must report that the turn resumed (and, when it names a run, the seeded durable run); the prompt clears from the thread (`mutate`) |
| Memory | Journey: seed an item, edit it (approval-first: 202 pending approval), approve, history shows the update, forget it, approve, item is forgotten (`mutate`) |
| Durable | Journey: seed recovery runs, cancel the orphaned run (reseeding up to three times when the Gateway's worker reclaims it first), recover the dead-lettered run through its dead-letter entry, and confirm it is back in the queue (`queued`, `running`, or `completed`) (`mutate`) |
| Capabilities | Invariants: every callable entry has `callable: true`, no candidate or proposal is callable, callable is a subset of inspectable, and the drift metrics report a valid subset (`read`) |
| Realtime | Open the event stream, create a session, observe its `chat_session_updated` event (`mutate`) |
| Backups | Create a backup in the sandbox backup folder, then list it (`mutate`) |
| Code Mode | Journey: create a run, approve its `code_mode.run` approval, poll until it finishes, artifact `sha256` values recorded (`host`) |

Out of phase 1: hand-written checks for the remaining non-GET routes (later waves, one area at a time, tracked by the Uncovered tab), the UI gallery tab (phase 2), and the headless CLI.

## 9. Testing and proof

Test conventions: the app has no Testing Library. DOM tests use `// @vitest-environment happy-dom` with `createRoot` and `act`. The coverage gate counts every non-test file under `apps/mission-control-next/src/` (75% lines, 60% branches for the tier), so every catalog area gets a test that mocks the shared client and runs each check against canned responses.

**Unit tests (vitest, `apps/mission-control-next`):**

- Target resolution and the sandbox check. Each of the three conditions failing alone falls back to real-gateway rules with the right reason.
- The tier policy matrix, `realSafe`, and the per-run host opt-in.
- Error classification: feature-disabled maps to `blocked`, assertion failure to `fail`, unreachable to a stopped run.
- Auto-probe generation from a manifest fixture, the exclusions, the real-target area exclusions, and replacement by hand-written checks.
- Coverage math and stale-claim detection.
- Reducer transitions, scheduler concurrency limits, and Stop aborting in-flight work.

**Catalog integrity test:**

- Check ids are unique and route keys are well-formed.
- A check claiming a non-GET route cannot be tier `read`.
- `realSafe` appears only on `external` checks.
- Any check that calls Code Mode or a shell tool is tier `host`.
- Every `external` check has a non-empty `description` (its own cost).

**Component tests:** the three panes render every result state; disabled buttons show their reason; external checks require confirmation; keyboard navigation works; the live region announces once per run.

**Launcher test (`scripts/testbench-runtime.test.mjs`, node:test):** given a source root whose gitignored `config/goatcitadel.json` holds a sentinel secret and which has a `workspaces/` folder, the runtime root contains neither; the Gateway environment keeps `GOATCITADEL_HOME` and `GOATCITADEL_BACKUP_DIR` inside the runtime root and turns Code Mode v1 on; the inherited path overrides are listed for omission and none of them is also pinned; and the UI environment carries the sandbox origin, root, and real origin.

**Proof before hand-back:**

- `pnpm --filter @goatcitadel/mission-control-next typecheck` and the app tests
- `pnpm --filter @goatcitadel/mission-control-next perf:check`
- `git diff --check`
- `pnpm verify:repo:hygiene` (tracked files must not contain personal paths)
- `pnpm docs:check`, which includes `check-launcher-ui-target` (the launcher must resolve the UI through `scripts/lib/ui-target.mjs`), `check-button-types`, and `check-no-empty-catch`
- A real run in the built-in browser: start `pnpm testbench`, Run all, screenshot the result including the coverage number
- When the everyday gateway is running, a read-only `?target=real` pass

Anything not run is reported as not run.

## 10. Risks and things to verify at implementation time

- **Shared working tree.** `apps/mission-control-next/src/main.tsx`, `vite.config.ts`, and root `package.json` had uncommitted changes from another session on 2026-10-03. This design does not touch `main.tsx` or `vite.config.ts`. Adding the `testbench` script to `package.json` must re-read the file first and preserve those changes.
- **Stub provider wiring (resolved 2026-10-03).** `prepareUsabilityRuntime` writes the stub provider config, and the Gateway reads the stub key from `GOATCITADEL_VERIFY_STUB_LLM_KEY`. This mirrors `scripts/verification/cockpit-chat-rendering-proof.mjs`.
- **Chat send needs a route decision.** A send without a fresh `routeDecision` from `preflightChatRoute` gets 409 `route_changed`, and its `providerId` and `model` must equal the decision's effective values.
- **Auto-probe safety.** Some GET routes may reach the network or be slow. The exclusion list starts conservative; review it against the manifest before the first real-target run.
- **Auth on the real target.** Auth storage is per browser origin. Opening `?target=real` from the launcher's Vite port may need sign-in; the page shows the preflight state instead of failing checks.
- **Output lock.** Verification stacks share a per-worktree output lock, so `pnpm testbench` cannot run alongside a verification lane in the same worktree. The launcher reports this clearly.
- **First-launch time.** `startVerificationStack` may build the Gateway workspace first. The launcher prints progress so a long start does not look hung.
