import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildFastLanePerfPayload, finalizeRunContext, runCommand } from "./shared.mjs";

test("verification commands omit inherited secrets while retaining explicit safe values", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-command-env-"));
  const previousSecret = process.env.GOATCITADEL_VERIFY_SENTINEL_SECRET;
  process.env.GOATCITADEL_VERIFY_SENTINEL_SECRET = "must-not-reach-child";
  try {
    const result = await runCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({secret:process.env.GOATCITADEL_VERIFY_SENTINEL_SECRET,safe:process.env.GOATCITADEL_VERIFY_SAFE}))",
      ],
      {
        artifactRoot,
        logName: "environment-scrub",
        omitEnv: ["GOATCITADEL_VERIFY_SENTINEL_SECRET"],
        env: { GOATCITADEL_VERIFY_SAFE: "retained" },
      },
    );
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { safe: "retained" });
  } finally {
    if (previousSecret === undefined) delete process.env.GOATCITADEL_VERIFY_SENTINEL_SECRET;
    else process.env.GOATCITADEL_VERIFY_SENTINEL_SECRET = previousSecret;
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("fast test budget measures the observed test-phase elapsed time", () => {
  const scenarios = [
    fastTestScenario("fast.test.gateway", "2026-07-11T00:00:00.000Z", "2026-07-11T00:00:20.000Z"),
    fastTestScenario("fast.test.storage", "2026-07-11T00:00:20.000Z", "2026-07-11T00:00:40.000Z"),
    fastTestScenario("fast.test.policy-engine", "2026-07-11T00:00:40.000Z", "2026-07-11T00:01:00.000Z"),
    fastTestScenario("fast.test.mission-control-next", "2026-07-11T00:01:00.000Z", "2026-07-11T00:02:00.000Z"),
    fastTestScenario("fast.test.libraries", "2026-07-11T00:01:00.000Z", "2026-07-11T00:01:50.000Z"),
  ];

  const payload = buildFastLanePerfPayload({
    runId: "fast-test-phase",
    lane: "fast",
    startedAt: "2026-07-10T23:59:50.000Z",
    finishedAt: "2026-07-11T00:02:50.000Z",
    durationMs: 180_000,
    scenarios,
  });
  const testBudget = payload.budgets.find((budget) => budget.id === "fast.test");

  assert.equal(testBudget?.durationMs, 120_000);
  assert.equal(testBudget?.calculation, "test_phase_elapsed");
  assert.equal(testBudget?.status, "passed");
  assert.equal(payload.scenarios[0]?.startedAt, scenarios[0].startedAt);
  assert.equal(payload.scenarios[0]?.finishedAt, scenarios[0].finishedAt);
});

test("fast test budget retains duration-sum compatibility for incomplete legacy manifests", () => {
  const payload = buildFastLanePerfPayload({
    runId: "fast-legacy-timings",
    lane: "fast",
    durationMs: 180_000,
    scenarios: [
      { id: "fast.test.gateway", title: "Gateway", status: "passed", durationMs: 100_000 },
      { id: "fast.test.storage", title: "Storage", status: "passed", durationMs: 40_000 },
    ],
  });
  const testBudget = payload.budgets.find((budget) => budget.id === "fast.test");

  assert.equal(testBudget?.durationMs, 140_000);
  assert.equal(testBudget?.calculation, "scenario_duration_sum");
  assert.equal(testBudget?.status, "warn");
});

test("fast test budget rejects a forged zero-length interval for a long scenario", () => {
  const payload = buildFastLanePerfPayload({
    runId: "fast-forged-zero-interval",
    lane: "fast",
    startedAt: "2026-07-11T00:00:00.000Z",
    finishedAt: "2026-07-11T00:04:00.000Z",
    durationMs: 240_000,
    scenarios: [
      {
        ...fastTestScenario("fast.test.policy-engine", "2026-07-11T00:00:10.000Z", "2026-07-11T00:00:10.000Z"),
        durationMs: 200_000,
      },
    ],
  });
  const testBudget = payload.budgets.find((budget) => budget.id === "fast.test");

  assert.equal(testBudget?.durationMs, 200_000);
  assert.equal(testBudget?.calculation, "scenario_duration_sum");
  assert.equal(testBudget?.status, "warn");
});

test("fast test budget rejects intervals outside the manifest run bounds", () => {
  const payload = buildFastLanePerfPayload({
    runId: "fast-out-of-run-interval",
    lane: "fast",
    startedAt: "2026-07-11T00:00:00.000Z",
    finishedAt: "2026-07-11T00:01:00.000Z",
    durationMs: 60_000,
    scenarios: [fastTestScenario("fast.test.gateway", "2026-07-10T23:59:40.000Z", "2026-07-11T00:00:00.000Z")],
  });
  const testBudget = payload.budgets.find((budget) => budget.id === "fast.test");

  assert.equal(testBudget?.durationMs, 20_000);
  assert.equal(testBudget?.calculation, "scenario_duration_sum");
});

test("fast test budget accepts the documented clock-call tolerance", () => {
  const scenario = fastTestScenario("fast.test.gateway", "2026-07-11T00:00:10.000Z", "2026-07-11T00:00:30.000Z");
  scenario.durationMs = 20_200;
  const payload = buildFastLanePerfPayload({
    runId: "fast-clock-call-tolerance",
    lane: "fast",
    startedAt: "2026-07-11T00:00:00.000Z",
    finishedAt: "2026-07-11T00:01:00.000Z",
    durationMs: 60_000,
    scenarios: [scenario],
  });
  const testBudget = payload.budgets.find((budget) => budget.id === "fast.test");

  assert.equal(testBudget?.durationMs, 20_000);
  assert.equal(testBudget?.calculation, "test_phase_elapsed");
});

test("fast test budget fails explicitly when no fast test scenario was recorded", () => {
  const payload = buildFastLanePerfPayload({
    runId: "fast-missing-tests",
    lane: "fast",
    startedAt: "2026-07-11T00:00:00.000Z",
    finishedAt: "2026-07-11T00:01:00.000Z",
    durationMs: 60_000,
    scenarios: [],
  });
  const testBudget = payload.budgets.find((budget) => budget.id === "fast.test");

  assert.equal(testBudget?.durationMs, 0);
  assert.equal(testBudget?.calculation, "missing_scenarios");
  assert.equal(testBudget?.status, "failed");
  assert.equal(testBudget?.integrityFailure, true);
  assert.match(testBudget?.reason ?? "", /no fast\.test scenarios/i);
  assert.equal(payload.status, "failed");
  assert.equal(payload.integrityFailure, true);
});

test("fast test budget fails integrity for invalid scenario durations", async (t) => {
  for (const [label, durationMs] of [
    ["missing", undefined],
    ["not-a-number", Number.NaN],
    ["positive-infinity", Number.POSITIVE_INFINITY],
    ["negative-infinity", Number.NEGATIVE_INFINITY],
    ["negative", -1],
  ]) {
    await t.test(label, () => {
      const scenario = fastTestScenario(`fast.test.${label}`, "2026-07-11T00:00:10.000Z", "2026-07-11T00:00:30.000Z");
      scenario.durationMs = durationMs;
      const payload = buildFastLanePerfPayload({
        runId: `fast-invalid-duration-${label}`,
        lane: "fast",
        startedAt: "2026-07-11T00:00:00.000Z",
        finishedAt: "2026-07-11T00:01:00.000Z",
        durationMs: 60_000,
        scenarios: [scenario],
      });
      const testBudget = payload.budgets.find((budget) => budget.id === "fast.test");

      assert.equal(testBudget?.durationMs, 0);
      assert.equal(testBudget?.calculation, "invalid_scenario_duration");
      assert.equal(testBudget?.status, "failed");
      assert.equal(testBudget?.integrityFailure, true);
      assert.match(testBudget?.reason ?? "", new RegExp(`fast\\.test\\.${label}`));
      assert.equal(payload.status, "failed");
      assert.equal(payload.integrityFailure, true);
    });
  }
});

test("non-strict finalization fails measurement-integrity errors", async () => {
  const context = await createFinalizeTestContext({ scenarios: [] });
  await withNonStrictPerfBudget(async () => {
    try {
      const manifest = await finalizeRunContext(context);

      assert.equal(manifest.status, "failed");
      assert.equal(manifest.metadata.fastLanePerf.status, "failed");
      assert.equal(manifest.metadata.fastLanePerf.strict, false);
      assert.equal(manifest.metadata.fastLanePerf.integrityFailure, true);
      const summary = await fs.readFile(path.join(context.artifactRoot, "summary.md"), "utf8");
      assert.match(summary, /measurement integrity failure; enforced/i);
      assert.doesNotMatch(summary, /not enforced/i);
    } finally {
      await fs.rm(context.artifactRoot, { recursive: true, force: true });
    }
  });
});

test("non-strict finalization does not enforce an ordinary over-budget result", async () => {
  const now = Date.now();
  const scenario = {
    ...fastTestScenario(
      "fast.test.gateway",
      new Date(now - 299_000).toISOString(),
      new Date(now - 298_000).toISOString(),
    ),
    subsystem: "fast",
    notes: [],
    metrics: {},
    artifacts: emptyArtifacts(),
  };
  const context = await createFinalizeTestContext({
    startedAt: new Date(now - 301_000).toISOString(),
    scenarios: [scenario],
  });
  await withNonStrictPerfBudget(async () => {
    try {
      const manifest = await finalizeRunContext(context);

      assert.equal(manifest.status, "passed");
      assert.equal(manifest.metadata.fastLanePerf.status, "failed");
      assert.equal(manifest.metadata.fastLanePerf.strict, false);
      assert.equal(manifest.metadata.fastLanePerf.integrityFailure, false);
      const summary = await fs.readFile(path.join(context.artifactRoot, "summary.md"), "utf8");
      assert.match(summary, /not enforced/i);
    } finally {
      await fs.rm(context.artifactRoot, { recursive: true, force: true });
    }
  });
});

test("finalization reclaims the latest-run pointer after a nested verification run", async () => {
  const context = await createFinalizeTestContext({
    lane: "all",
    scenarios: [],
  });
  const latestRunPointerPath = path.join(context.artifactRoot, "latest-run.json");
  context.latestRunPointerPath = latestRunPointerPath;
  await fs.writeFile(
    latestRunPointerPath,
    `${JSON.stringify({
      runId: "nested-install-smoke",
      artifactRoot: path.join(context.artifactRoot, "nested-install-smoke"),
      startedAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  try {
    const manifest = await finalizeRunContext(context);
    const pointer = JSON.parse(await fs.readFile(latestRunPointerPath, "utf8"));

    assert.equal(manifest.status, "passed");
    assert.deepEqual(pointer, {
      runId: context.runId,
      artifactRoot: context.artifactRoot,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      status: "passed",
    });
  } finally {
    await fs.rm(context.artifactRoot, { recursive: true, force: true });
  }
});

function fastTestScenario(id, startedAt, finishedAt) {
  return {
    id,
    title: id,
    status: "passed",
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
  };
}

test("a sliced run is not judged against the whole lane's budgets", async () => {
  // Most slices carry no fast.test scenario, which the lane budget reads as a
  // missing measurement. Judging a part that way failed every non-test CI job.
  const context = await createFinalizeTestContext({ scenarios: [], metadata: { commandSelection: "fast.docs" } });
  await withNonStrictPerfBudget(async () => {
    try {
      const manifest = await finalizeRunContext(context);

      assert.equal(manifest.status, "passed");
      assert.equal(manifest.metadata.fastLanePerf, undefined);
      assert.equal(manifest.metadata.commandSelection, "fast.docs");
      const perfWritten = await fs
        .access(path.join(context.artifactRoot, "perf", "fast-lane-timing.json"))
        .then(() => true)
        .catch(() => false);
      assert.equal(perfWritten, false);
    } finally {
      await fs.rm(context.artifactRoot, { recursive: true, force: true });
    }
  });
});

async function createFinalizeTestContext({
  startedAt = new Date(Date.now() - 1_000).toISOString(),
  lane = "fast",
  scenarios,
  metadata = {},
}) {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-fast-perf-integrity-"));
  return {
    lane,
    runId: "fast-perf-integrity",
    artifactRoot,
    manifest: {
      runId: "fast-perf-integrity",
      lane,
      startedAt,
      repoRoot: "repo",
      artifactRoot,
      metadata,
      counts: {
        passed: scenarios.length,
        failed: 0,
        skipped: 0,
        degraded: 0,
        notConfigured: 0,
      },
      scenarios,
    },
  };
}

async function withNonStrictPerfBudget(fn) {
  const previous = process.env.GOATCITADEL_VERIFY_PERF_BUDGET;
  delete process.env.GOATCITADEL_VERIFY_PERF_BUDGET;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.GOATCITADEL_VERIFY_PERF_BUDGET;
    } else {
      process.env.GOATCITADEL_VERIFY_PERF_BUDGET = previous;
    }
  }
}

function emptyArtifacts() {
  return {
    diagnostics: [],
    screenshots: [],
    traces: [],
    logs: [],
    perf: [],
    playwright: [],
  };
}
