import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  A2A_FULL_LANE_COMMANDS,
  FAST_LANE_COMMANDS,
  buildOrchestrationPerformanceScenarioResult,
  deriveProviderStatus,
  exerciseMissionControlNextMobileRail,
  openMissionControlNextThreadedContext,
  performVerificationInteraction,
  requireCanonicalMemorySeed,
  runFastLane,
} from "./scenarios.mjs";
import { FAST_LANE_STAGES } from "./scenarios/fast-lane.mjs";
import { buildFastLanePerfPayload, finalizeRunContext, recordScenario } from "./shared.mjs";

test("Mission Control Next shell interaction targets Route details instead of Chat context", async () => {
  let inspectorVisible = false;
  let requestedName;
  const routeDetailsButton = {
    async waitFor() {},
    async textContent() {
      return inspectorVisible ? "Hide Route details" : "Open Route details";
    },
    async click() {
      inspectorVisible = true;
    },
    async evaluate() {
      inspectorVisible = true;
    },
  };
  const page = {
    getByRole(role, options) {
      assert.equal(role, "button");
      requestedName = options.name;
      return { first: () => routeDetailsButton };
    },
    locator(selector) {
      assert.equal(selector, ".mc-next-shell-inspector");
      return { isVisible: async () => inspectorVisible };
    },
    async waitForTimeout() {},
    async waitForSelector() {
      assert.fail("visible inspector should be observed without fallback waiting");
    },
  };

  await performVerificationInteraction(page, "open-inspector", "@goatcitadel/mission-control-next");

  assert.equal(inspectorVisible, true);
  assert.equal(requestedName.test("Open Route details"), true);
  assert.equal(requestedName.test("Hide Route details"), true);
  assert.equal(requestedName.test("Open Context"), false);
});

test("mobile Chat proof rejects shell inspector ownership and opens threaded Working Context", async () => {
  let contextVisible = false;
  let requestedRouteDetailsName;
  const contextButton = {
    async waitFor() {},
    async boundingBox() {
      return { x: 12, y: 20, width: 120, height: 36 };
    },
    async click() {
      contextVisible = true;
    },
  };
  const contextPanel = {
    async isVisible() {
      return contextVisible;
    },
    async waitFor() {
      assert.equal(contextVisible, true);
    },
  };
  const workingContext = {
    async waitFor() {
      assert.equal(contextVisible, true);
    },
  };
  const page = {
    getByRole(role, options) {
      assert.equal(role, "button");
      requestedRouteDetailsName = options.name;
      return { count: async () => 0 };
    },
    locator(selector) {
      if (selector === ".mc-next-shell-inspector") {
        return { count: async () => 0 };
      }
      if (selector === ".mc-next-threaded-mobile-bar .mc-next-threaded-menu-button") {
        return {
          filter({ hasText }) {
            assert.equal(hasText.test("Context"), true);
            return { first: () => contextButton };
          },
        };
      }
      if (selector === '.mc-next-threaded-context-panel[aria-label="Thread context drawer"]') {
        return { first: () => contextPanel };
      }
      if (selector === ".mc-next-threaded-context-panel .mc-next-context-drawer") {
        return {
          filter({ hasText }) {
            assert.equal(hasText.test("Working Context"), true);
            return { first: () => workingContext };
          },
        };
      }
      assert.fail(`unexpected locator: ${selector}`);
    },
    viewportSize() {
      return { width: 390, height: 844 };
    },
    async waitForTimeout() {},
  };

  await openMissionControlNextThreadedContext(page);

  assert.equal(contextVisible, true);
  assert.equal(requestedRouteDetailsName.test("Open Route details"), true);
});

test("mobile Chat proof fails closed when the generic Route details control is present", async () => {
  const page = {
    getByRole() {
      return { count: async () => 1 };
    },
    locator(selector) {
      assert.equal(selector, ".mc-next-shell-inspector");
      return { count: async () => 0 };
    },
  };

  await assert.rejects(
    () => openMissionControlNextThreadedContext(page),
    /generic Route details inspector instead of threaded Working Context/,
  );
});

test("mobile shell proof exercises accessible scope controls and the drawer Command Palette", async () => {
  let railVisible = true;
  let paletteVisible = false;
  const activated = [];
  const visibleLocator = (label, onClick) => ({
    async waitFor({ state }) {
      if (state === "visible") {
        assert.equal(label === "rail" ? railVisible : label === "palette" ? paletteVisible : true, true);
      } else if (state === "hidden") {
        assert.equal(label === "palette" ? paletteVisible : false, false);
      }
    },
    async boundingBox() {
      return { x: 12, y: 20, width: 160, height: 36 };
    },
    async click() {
      activated.push(label);
      await onClick?.();
    },
  });
  const rail = visibleLocator("rail");
  const closeNavigation = visibleLocator("Close navigation");
  const controls = new Map([
    ["Active Citadel", visibleLocator("Active Citadel")],
    ["Active Workspace", visibleLocator("Active Workspace")],
    [
      "Open Command Palette",
      visibleLocator("Open Command Palette", () => {
        railVisible = false;
        paletteVisible = true;
      }),
    ],
    [
      "Open navigation",
      visibleLocator("Open navigation", () => {
        railVisible = true;
      }),
    ],
    ["Close navigation", closeNavigation],
  ]);
  const page = {
    locator(selector) {
      assert.equal(selector, ".mc-next-rail.open");
      return { first: () => rail };
    },
    getByRole(role, { name }) {
      if (role === "dialog") {
        assert.equal(name.test("Command Palette"), true);
        return { first: () => visibleLocator("palette") };
      }
      if (role === "combobox" || role === "button") {
        assert.ok(controls.has(name), `unexpected accessible control: ${String(name)}`);
        return { first: () => controls.get(name) };
      }
      assert.fail(`unexpected role: ${role}`);
    },
    viewportSize() {
      return { width: 390, height: 844 };
    },
    async waitForTimeout() {},
    async waitForFunction() {
      assert.equal(railVisible, false);
    },
    keyboard: {
      async press(key) {
        assert.equal(key, "Escape");
        paletteVisible = false;
      },
    },
  };

  const result = await exerciseMissionControlNextMobileRail(page);

  assert.equal(result.railCloseButton, closeNavigation);
  assert.deepEqual(activated, ["Open Command Palette", "Open navigation"]);
  assert.equal(railVisible, true);
  assert.equal(paletteVisible, false);
});

test("canonical memory seed validation fails closed on incomplete or foreign ownership", () => {
  assert.equal(
    requireCanonicalMemorySeed({ itemId: "memory-1", workspaceId: "workspace-a" }, "workspace-a", "test seed"),
    "memory-1",
  );
  assert.throws(
    () => requireCanonicalMemorySeed({ workspaceId: "workspace-a" }, "workspace-a", "test seed"),
    /test seed did not return canonical ownership/,
  );
  assert.throws(
    () => requireCanonicalMemorySeed({ itemId: "memory-1", workspaceId: "workspace-b" }, "workspace-a", "test seed"),
    /test seed did not return canonical ownership/,
  );
});

test("fast verification lane keeps required fast commands", () => {
  const commandArgs = new Set(FAST_LANE_COMMANDS.map((command) => command.args.join(" ")));
  const commandIds = new Set(FAST_LANE_COMMANDS.map((command) => command.id));

  for (const expected of [
    "verify:repo:hygiene",
    "verify:storage:migration-parity",
    "--filter @goatcitadel/extensions-sdk build",
    "verify:extensions:package:from-build",
    "typecheck",
    "smoke -- --profile fast",
    "build",
    "docs:check",
  ]) {
    assert.ok(commandArgs.has(expected), `fast lane should include ${expected}`);
  }

  for (const expectedId of [
    "fast.test.gateway",
    "fast.test.storage",
    "fast.test.mission-control-next",
    "fast.test.policy-engine",
    "fast.test.libraries",
  ]) {
    assert.ok(commandIds.has(expectedId), `fast lane should include split test scenario ${expectedId}`);
  }

  assert.equal(commandArgs.has("-r --workspace-concurrency=1 test"), false);
});

test("fast verification split tests preserve recursive package coverage", () => {
  const commandById = new Map(FAST_LANE_COMMANDS.map((command) => [command.id, command]));
  assert.deepEqual(commandById.get("fast.test.gateway")?.args, ["--filter", "@goatcitadel/gateway", "test:coverage"]);
  assert.deepEqual(commandById.get("fast.test.storage")?.args, ["--filter", "@goatcitadel/storage", "test:coverage"]);
  assert.deepEqual(commandById.get("fast.test.mission-control-next")?.args, [
    "--filter",
    "@goatcitadel/mission-control-next",
    "test:coverage",
  ]);
  assert.deepEqual(commandById.get("fast.test.policy-engine")?.args, [
    "--filter",
    "@goatcitadel/policy-engine",
    "test:coverage",
  ]);

  const libraryArgs = commandById.get("fast.test.libraries")?.args ?? [];
  for (const expectedPackage of [
    "@goatcitadel/contracts",
    "@goatcitadel/extensions-sdk",
    "@goatcitadel/gateway-core",
    "@goatcitadel/memory-core",
    "@goatcitadel/mesh-core",
    "@goatcitadel/mission-control-desktop",
    "@goatcitadel/mission-control-shared",
    "@goatcitadel/orchestration",
    "@goatcitadel/skills",
    "@goatcitadel/threaded-surface-core",
  ]) {
    assert.ok(libraryArgs.includes(expectedPackage), `library test group should include ${expectedPackage}`);
  }
  assert.ok(libraryArgs.includes("--workspace-concurrency=2"));

  assert.equal(commandById.get("fast.test.gateway")?.env?.GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD, "1");
  assert.deepEqual(commandById.get("fast.smoke")?.args, ["smoke", "--", "--profile", "fast"]);
  assert.equal(commandById.get("fast.smoke")?.env?.GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD, "1");
});

test("fast verification test commands instrument coverage so the gate can reuse this run", () => {
  const testCommands = FAST_LANE_COMMANDS.filter((command) => command.id.startsWith("fast.test."));
  assert.equal(testCommands.length, 5);
  for (const command of testCommands) {
    assert.ok(
      command.args.includes("test:coverage"),
      `${command.id} must run test:coverage so pnpm coverage:collect --skip-run can aggregate this run`,
    );
    assert.equal(
      command.args.includes("test"),
      false,
      `${command.id} must not fall back to the uninstrumented test script`,
    );
  }
});

test("fast verification stage plan isolates policy and schedules every command exactly once", () => {
  assert.deepEqual(FAST_LANE_STAGES, [
    {
      id: "fast.prerequisites",
      mode: "serial",
      commands: [
        "fast.skills-catalog",
        "fast.repo-hygiene",
        "fast.storage-migration-parity",
        "fast.extensions-sdk-build",
        "fast.extensions-sdk-package",
        "fast.typecheck",
      ],
    },
    {
      id: "fast.test.gateway",
      mode: "serial",
      commands: ["fast.test.gateway"],
    },
    {
      id: "fast.test.storage",
      mode: "serial",
      commands: ["fast.test.storage"],
    },
    {
      id: "fast.test.policy-engine",
      mode: "serial",
      commands: ["fast.test.policy-engine"],
    },
    {
      id: "fast.test.safe-parallel",
      mode: "parallel",
      concurrency: 2,
      commands: ["fast.test.mission-control-next", "fast.test.libraries"],
    },
    {
      id: "fast.post-tests",
      mode: "serial",
      commands: ["fast.smoke", "fast.build", "fast.docs"],
    },
  ]);

  const plannedCommandIds = FAST_LANE_STAGES.flatMap((stage) => stage.commands);
  assert.equal(new Set(plannedCommandIds).size, plannedCommandIds.length, "stage commands must be unique");
  assert.deepEqual(
    new Set(plannedCommandIds),
    new Set(FAST_LANE_COMMANDS.map((command) => command.id)),
    "stage plan must neither drop nor invent fast-lane commands",
  );
});

test("fast lane perf budget reports passed, warn, and failed status", () => {
  const base = {
    runId: "perf-test",
    lane: "fast",
    scenarios: [
      { id: "fast.test.gateway", title: "Gateway tests", status: "passed", durationMs: 50_000 },
      { id: "fast.test.storage", title: "Storage tests", status: "passed", durationMs: 30_000 },
      { id: "fast.smoke", title: "Smoke", status: "passed", durationMs: 30_000 },
    ],
  };

  assert.equal(buildFastLanePerfPayload({ ...base, durationMs: 120_000 }).status, "passed");
  assert.equal(
    buildFastLanePerfPayload({
      ...base,
      durationMs: 220_000,
      scenarios: [
        ...base.scenarios,
        { id: "fast.test.libraries", title: "Library tests", status: "passed", durationMs: 60_000 },
      ],
    }).status,
    "warn",
  );
  assert.equal(buildFastLanePerfPayload({ ...base, durationMs: 301_000 }).status, "failed");
});

test("failing orchestration performance gates retain their structured report", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-perf-failure-"));
  const reportPath = path.join(artifactRoot, "perf", "orchestration-performance.json");
  const diagnosticsRoot = path.join(artifactRoot, "diagnostics");
  try {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.mkdir(diagnosticsRoot, { recursive: true });
    await fs.writeFile(
      reportPath,
      JSON.stringify({
        passed: false,
        aggregate: { measuredRunCount: 11, totalRetries: 2, totalDuplicateDispatches: 1 },
        comparisons: {
          serialVsParallel: {
            serialMedianEndToEndMs: 100,
            parallelMedianEndToEndMs: 80,
            medianSpeedupRatio: 1.25,
          },
        },
        performanceGate: { thresholdFailures: ["parallel p95 exceeded 100ms"] },
      }),
      "utf8",
    );

    const result = await buildOrchestrationPerformanceScenarioResult(
      { artifactRoot },
      {
        code: 1,
        durationMs: 123,
        stdout: "raw stdout",
        stderr: "raw stderr",
        stdoutPath: path.join(diagnosticsRoot, "perf.stdout.log"),
        stderrPath: path.join(diagnosticsRoot, "perf.stderr.log"),
      },
      reportPath,
    );

    assert.equal(result.status, "failed");
    assert.equal(result.error, "parallel p95 exceeded 100ms");
    assert.equal(result.metrics.measuredRunCount, 11);
    assert.equal(result.metrics.totalRetries, 2);
    assert.equal(result.metrics.totalDuplicateDispatches, 1);
    assert.deepEqual(result.artifacts.perf, ["perf/orchestration-performance.json"]);
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("fail-fast finalization still writes manifest, summary, junit, and timing artifact", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-fast-finalize-"));
  try {
    const context = {
      lane: "fast",
      runId: "fail-fast-finalize-test",
      artifactRoot,
      manifest: {
        runId: "fail-fast-finalize-test",
        lane: "fast",
        startedAt: new Date(Date.now() - 1_000).toISOString(),
        repoRoot: "repo",
        artifactRoot,
        metadata: {},
        counts: {
          passed: 0,
          failed: 0,
          skipped: 0,
          degraded: 0,
          notConfigured: 0,
        },
        scenarios: [],
      },
    };

    await assert.rejects(
      runFastLane(context, { failFast: true, injectFailureScenario: "fast.skills-catalog" }),
      /Fast lane stopped after failed scenario fast\.skills-catalog/,
    );
    const manifest = await finalizeRunContext(context, "failed");
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.scenarios.length, 1);
    assert.equal(manifest.scenarios[0].id, "fast.skills-catalog");
    assert.equal(manifest.scenarios[0].status, "failed");
    assert.equal(manifest.metadata.fastLanePerf.artifact, "perf/fast-lane-timing.json");
    await fs.access(path.join(artifactRoot, "manifest.json"));
    await fs.access(path.join(artifactRoot, "summary.md"));
    await fs.access(path.join(artifactRoot, "junit.xml"));
    await fs.access(path.join(artifactRoot, "perf", "fast-lane-timing.json"));
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("parallel scenario recording keeps the manifest artifact complete", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-fast-record-"));
  try {
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    const context = {
      lane: "fast",
      runId: "parallel-record-test",
      artifactRoot,
      manifest: {
        runId: "parallel-record-test",
        lane: "fast",
        startedAt,
        repoRoot: "repo",
        artifactRoot,
        metadata: {},
        counts: {
          passed: 0,
          failed: 0,
          skipped: 0,
          degraded: 0,
          notConfigured: 0,
        },
        scenarios: [],
      },
    };

    await Promise.all(
      ["fast.test.mission-control-next", "fast.test.policy-engine", "fast.test.libraries"].map((id) =>
        recordScenario(context, {
          id,
          lane: "fast",
          title: id,
          subsystem: "fast",
          status: "passed",
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: 1,
          correlationId: id,
        }),
      ),
    );

    const manifest = JSON.parse(await fs.readFile(path.join(artifactRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.scenarios.length, 3);
    assert.deepEqual(
      new Set(manifest.scenarios.map((scenario) => scenario.id)),
      new Set(["fast.test.mission-control-next", "fast.test.policy-engine", "fast.test.libraries"]),
    );
    assert.equal(manifest.counts.passed, 3);
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("A2A full lane keeps governed gateway and contract proof commands", () => {
  const commandArgs = new Set(A2A_FULL_LANE_COMMANDS.map((command) => command.args.join(" ")));

  for (const expected of [
    "--filter @goatcitadel/contracts build",
    "--filter @goatcitadel/storage build",
    "verify:storage:migration-parity",
    "--filter @goatcitadel/mission-control-shared build",
    "--filter @goatcitadel/gateway typecheck",
    "--filter @goatcitadel/gateway exec vitest run src/services/a2a-grpc-service.test.ts src/services/a2a-route-service.test.ts src/routes/tasks.test.ts",
  ]) {
    assert.ok(commandArgs.has(expected), `A2A full lane should include ${expected}`);
  }
});

test("provider truth status fails configured auth, route, and protocol errors", () => {
  assert.equal(deriveProviderStatus({ ok: true }), "passed");
  assert.equal(deriveProviderStatus({ error: "missing OpenAI API key" }), "not_configured");
  assert.equal(deriveProviderStatus({ error: "missing OpenAI API key" }, { providerConfigured: true }), "failed");

  for (const error of [
    "invalid API key",
    "authentication_error: unauthorized",
    "404 model not found",
    "response_format protocol mismatch",
    "bad request: tools are not available",
  ]) {
    assert.equal(deriveProviderStatus({ error }, { providerConfigured: true }), "failed");
  }

  for (const error of ["unsupported provider feature", "model not supported", "model unavailable now"]) {
    assert.equal(deriveProviderStatus({ error }, { providerConfigured: true }), "degraded");
  }
});
