# GoatCitadel head-to-head benchmark

A runnable harness that proves GoatCitadel's product claims across three axes and,
once competitor builds are dropped in, measures **"we beat OpenClaw + Hermes."**

| Axis | What it proves | Example scenarios |
| --- | --- | --- |
| **CAPABILITY** | The agent completes real provider-backed work | provider-backed completion |
| **TRUST** | The system fails closed and is tamper-evident | deny-wins Ward, dry-run→commit hash binding, unknown-sender rejection, evidence-receipt offline verify |
| **RELIABILITY** | Work survives crashes and never leaks processes | no-orphan-on-timeout, durable resume after worker death |

The trust/reliability scenarios run **today with no API keys** because they execute
GoatCitadel's *shipped enforcement code* (built `dist/`) directly — not a
re-implementation. The capability scenario and every competitor scenario are
**skipped with a clear, actionable note** until their edge (a provider key, a
competitor binary) is supplied.

## Quick start

```bash
# from the repo root
node benchmark/run.mjs            # run everything available, write a scorecard
node benchmark/run.mjs --list     # list scenarios + which targets run vs skip (and why)
node benchmark/run.mjs --help     # full usage
```

Outputs:

- `benchmark/out/scorecard.json` — machine-readable scorecard (per-target, per-axis)
- `benchmark/out/scorecard.md` — readable summary with a verdict line

`out/` and `targets.json` are git-ignored (see `benchmark/.gitignore`).

### Prerequisite: build the gateway dist

The in-process scenarios import built modules under `apps/gateway/dist` and
`packages/contracts/dist`. If `--list` reports *"GoatCitadel dist built: no"*, run:

```bash
pnpm --filter @goatcitadel/gateway... build
```

A missing build makes the in-process scenarios **skip** (never a false competitive
loss).

## What runs today vs. what's pending

| Scenario | Axis | Mode | Runs today? |
| --- | --- | --- | --- |
| `trust.deny-wins-ward` | TRUST | in-process | ✅ yes (keys-free) |
| `trust.dry-run-hash-mismatch` | TRUST | in-process | ✅ yes (keys-free) |
| `trust.unknown-sender-rejected` | TRUST | in-process | ✅ yes (keys-free) |
| `reliability.no-orphan-on-timeout` | RELIABILITY | in-process | ✅ yes (keys-free) |
| `reliability.durable-resume` | RELIABILITY | in-process | ✅ yes (keys-free) |
| `trust.evidence-receipt-verify` | TRUST | http | ✅ when a gateway from *this tree* is reachable (or `--spin`) |
| `capability.agent-task` | CAPABILITY | http | ⏳ needs a **valid provider key** (the "provider keys" edge) |
| *all competitor rows* | — | — | ⏳ need **OpenClaw/Hermes** in `targets.json` |

> Note: HTTP scenarios skip (not fail) when the reachable gateway is an **older build**
> that predates a route (e.g. the evidence-receipts route). Restart the gateway from
> this worktree, or pass `--spin`, to measure them.

## Targets (the pluggable seams)

Copy the example and fill in what you have. Anything left absent is skipped, not failed.

```bash
cp benchmark/targets.example.json benchmark/targets.json
# edit benchmark/targets.json  (gitignored)
```

- **`goatcitadel`** — `baseUrl` of the local gateway (+ optional auth). In-process
  scenarios need neither a URL nor keys. HTTP scenarios use `baseUrl`, or `--spin`
  to auto-build+start an isolated gateway.
- **`openclaw` / `hermes`** — a `command` (binary path the runner can spawn) **or** a
  `baseUrl` of an already-running instance, plus optional auth.

Environment variables override the file (handy for CI). The exact names are defined
in `benchmark/lib/targets.mjs` (`ENV_OVERRIDES`):

| Var | Overrides |
| --- | --- |
| `BENCH_GOATCITADEL_BASE_URL` | gateway base URL |
| `BENCH_GOATCITADEL_AUTH_MODE` / `BENCH_GOATCITADEL_TOKEN` | gateway auth (`token` → `Authorization: Bearer …`) |
| `BENCH_OPENCLAW_COMMAND` / `BENCH_OPENCLAW_BASE_URL` / `BENCH_OPENCLAW_TOKEN` | OpenClaw target |
| `BENCH_HERMES_COMMAND` / `BENCH_HERMES_BASE_URL` / `BENCH_HERMES_TOKEN` | Hermes target |

See **`EDGES.md`** at the repo root for the full "drop-it-here" wiring of all four
user-provided edges (provider keys, competitor builds, code-signing/notarization,
test channels), each cited to the real integration point in code.

## Scoring

- Each scenario returns `pass` / `fail` / `skip` (+ `error` for harness faults).
- The scorecard tallies **per target, per axis**.
- The **verdict** compares GoatCitadel's pass count to each *configured* competitor.
  Unconfigured competitors render **"pending build"** so the headline never claims a
  win it hasn't measured.
- The runner exits **non-zero only on a real `fail`/`error`** — a `skip` (missing
  edge) is expected and exits 0.

## Adding a scenario

1. Create `benchmark/scenarios/<axis>-<name>.mjs` that default-exports a scenario
   object (shape documented at the top of `benchmark/lib/harness.mjs`):

   ```js
   import { pass, fail, skip } from "../lib/harness.mjs";

   export default {
     id: "trust.my-new-proof",
     axis: "TRUST",                 // CAPABILITY | TRUST | RELIABILITY
     title: "One-line claim",
     description: "What property this asserts and why it matters.",
     requiresEdges: [],             // e.g. ["provider-api-keys"]
     mode: "in-process",            // "in-process" (imports dist) | "http" (hits baseUrl)
     async run(target, ctx) {
       if (target.kind === "competitor") return skip("no equivalent API");
       // ...assert and return pass()/fail()...
       return pass("evidence string shown verbatim in the scorecard");
     },
   };
   ```

2. Register it in `benchmark/scenarios/index.mjs` (order = report order).
3. `node benchmark/run.mjs --list` to confirm it shows up, then run it.

### Conventions that keep the scorecard honest

- **Skip, don't fail, for missing edges or environment gaps** (no key, competitor
  absent, route not on an older build). A `fail` must mean the asserted property is
  genuinely broken.
- **Prefer importing shipped `dist/` over re-implementing rules** — that's what makes
  a pass evidence of the *product's* behavior, not the test's.
- **`run()` returns a result for expected negatives; it only throws on infrastructure
  faults** (the runner records a thrown error as `error`).
