#!/usr/bin/env node
// Head-to-head benchmark runner.
//
// Executes each scenario against each available target, scores per axis, and
// writes benchmark/out/scorecard.json + scorecard.md.
//
// What runs TODAY (keys-free, no competitors needed):
//   - All TRUST/RELIABILITY in-process scenarios against GoatCitadel's shipped dist.
//   - The evidence-receipt HTTP scenario IF a gateway is reachable (or --spin).
// What is SKIPPED with a clear note until edges arrive:
//   - CAPABILITY scenarios (need a provider key).
//   - Every competitor scenario (need OpenClaw/Hermes builds in targets.json).
//
// Usage:
//   node benchmark/run.mjs                 run everything available, write scorecard
//   node benchmark/run.mjs --list          list scenarios + which are skipped and why
//   node benchmark/run.mjs --help          show this help
//   node benchmark/run.mjs --axis TRUST    only TRUST scenarios (repeatable)
//   node benchmark/run.mjs --scenario trust.deny-wins-ward   only matching ids (repeatable, substring)
//   node benchmark/run.mjs --spin          auto-spin an isolated gateway for HTTP scenarios
//   node benchmark/run.mjs --json          print the scorecard JSON to stdout too

import { loadTargets, allTargets, goatcitadelDistReady } from "./lib/targets.mjs";
import { scenarios as allScenarios } from "./scenarios/index.mjs";
import { STATUS, isReachable } from "./lib/harness.mjs";
import { buildScorecard, writeScorecard, renderMarkdown } from "./lib/scorecard.mjs";

function parseArgs(argv) {
  const opts = { axes: [], scenarioFilters: [], spin: false, list: false, help: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--list":
        opts.list = true;
        break;
      case "--spin":
        opts.spin = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--axis":
        opts.axes.push((argv[++i] ?? "").toUpperCase());
        break;
      case "--scenario":
        opts.scenarioFilters.push(argv[++i] ?? "");
        break;
      default:
        if (arg?.startsWith("--axis=")) opts.axes.push(arg.slice(7).toUpperCase());
        else if (arg?.startsWith("--scenario=")) opts.scenarioFilters.push(arg.slice(11));
        else console.warn(`[bench] ignoring unknown argument: ${arg}`);
    }
  }
  return opts;
}

function selectScenarios(opts) {
  let selected = allScenarios;
  if (opts.axes.length > 0) {
    selected = selected.filter((s) => opts.axes.includes(s.axis));
  }
  if (opts.scenarioFilters.length > 0) {
    selected = selected.filter((s) => opts.scenarioFilters.some((f) => s.id.includes(f)));
  }
  return selected;
}

function printHelp() {
  const text = `
GoatCitadel head-to-head benchmark

Proves CAPABILITY / TRUST / RELIABILITY claims against GoatCitadel and (when
configured) OpenClaw + Hermes. Trust/reliability scenarios run today with no API
keys by exercising the product's shipped enforcement code.

Usage:
  node benchmark/run.mjs [options]

Options:
  -h, --help              Show this help and exit
      --list              List scenarios and which targets they run/skip on, then exit
      --axis <AXIS>       Filter by axis: CAPABILITY | TRUST | RELIABILITY (repeatable)
      --scenario <id>     Filter by scenario id substring (repeatable)
      --spin              Auto-spin an isolated local gateway for HTTP scenarios
      --json              Also print the scorecard JSON to stdout

Output:
  benchmark/out/scorecard.json   machine-readable scorecard
  benchmark/out/scorecard.md     readable summary

Edges (drop-in wiring): see EDGES.md at the repo root and benchmark/targets.example.json.
`;
  console.log(text.trim());
}

async function resolveGatewayContext(targets, opts) {
  // For HTTP scenarios we need a reachable GoatCitadel base URL. Prefer a
  // configured/already-running gateway; optionally spin an isolated one.
  let baseUrl = targets.goatcitadel.baseUrl;
  let reachable = await isReachable(baseUrl);
  let spun = null;

  if (!reachable && opts.spin) {
    try {
      const { startVerificationStack } = await import("../scripts/verification/lib/runtime.mjs");
      const { createRunContext } = await import("../scripts/verification/lib/shared.mjs");
      console.log("[bench] --spin: building + starting an isolated gateway (this can take a few minutes)…");
      const context = await createRunContext("benchmark", { profile: "local" });
      const stack = await startVerificationStack(context, {
        includeUi: false,
        gatewayPort: 0,
        gatewayEnv: { GOATCITADEL_AUTH_MODE: "none", GOATCITADEL_DISABLE_SECRET_STORE: "true" },
      });
      baseUrl = stack.gatewayUrl;
      reachable = await isReachable(baseUrl);
      spun = stack;
      console.log(`[bench] spun gateway at ${baseUrl} (reachable=${reachable})`);
    } catch (error) {
      console.warn(`[bench] --spin failed (${error instanceof Error ? error.message : error}); HTTP scenarios will skip.`);
    }
  }

  return { baseUrl, reachable, spun };
}

async function runScenario(scenario, target, ctx) {
  try {
    const result = await scenario.run(target, ctx);
    if (!result || !result.status) {
      return { status: STATUS.ERROR, evidence: "scenario returned no status", detail: null };
    }
    return result;
  } catch (error) {
    return {
      status: STATUS.ERROR,
      evidence: `scenario threw: ${error instanceof Error ? error.message : String(error)}`,
      detail: error instanceof Error ? { stack: error.stack } : null,
    };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  const targets = loadTargets();
  const selected = selectScenarios(opts);
  const dist = goatcitadelDistReady();

  if (opts.list) {
    console.log(`Targets source: ${targets.source}`);
    console.log(`GoatCitadel dist built: ${dist.ready ? "yes" : `no (missing ${dist.missing.length} module(s))`}`);
    console.log("");
    console.log(`Scenarios (${selected.length}):`);
    for (const s of selected) {
      const edges = s.requiresEdges.length ? `requires: ${s.requiresEdges.join(", ")}` : "no edges required";
      console.log(`  - [${s.axis}] ${s.id} (${s.mode}) — ${edges}`);
      console.log(`      ${s.title}`);
    }
    console.log("");
    console.log("Targets:");
    for (const t of allTargets(targets)) {
      const note = t.configured ? "configured" : `SKIPPED — ${t.skipReason}`;
      console.log(`  - ${t.id}: ${note}`);
    }
    return 0;
  }

  const gatewayCtx = await resolveGatewayContext(targets, opts);
  const results = [];

  try {
    for (const target of allTargets(targets)) {
      const ctx = {
        baseUrl: target.kind === "primary" ? gatewayCtx.baseUrl : target.baseUrl,
        reachable: target.kind === "primary" ? gatewayCtx.reachable : await isReachable(target.baseUrl),
      };
      for (const scenario of selected) {
        const result = await runScenario(scenario, target, ctx);
        results.push({ target, scenario, result });
        const tag = result.status.toUpperCase().padEnd(5);
        console.log(`[${tag}] ${target.id} :: ${scenario.id} — ${result.evidence}`);
      }
    }
  } finally {
    if (gatewayCtx.spun) {
      try {
        const { stopVerificationStack } = await import("../scripts/verification/lib/runtime.mjs");
        await stopVerificationStack(gatewayCtx.spun);
      } catch (error) {
        console.warn(`[bench] failed to stop spun gateway: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  const scorecard = buildScorecard({
    targets,
    scenarios: selected,
    results,
    meta: {
      gatewayReachable: gatewayCtx.reachable,
      spun: Boolean(gatewayCtx.spun),
      distReady: dist.ready,
      argv: process.argv.slice(2),
    },
  });
  const paths = writeScorecard(scorecard);

  console.log("");
  console.log(renderMarkdown(scorecard));
  console.log("");
  console.log(`[bench] scorecard written: ${paths.json}`);
  console.log(`[bench] summary written:   ${paths.markdown}`);

  if (opts.json) {
    console.log(JSON.stringify(scorecard, null, 2));
  }

  // Exit non-zero only on a real FAIL or ERROR (a SKIP is expected when edges are absent).
  const hardFailures = results.filter(
    (r) => r.result.status === STATUS.FAIL || r.result.status === STATUS.ERROR,
  );
  return hardFailures.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[bench] fatal:", error);
    process.exit(2);
  });
