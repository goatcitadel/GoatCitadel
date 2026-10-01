import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import {
  applyArchitectureServiceAllowances,
  readArchitectureServiceAllowances,
} from "./architecture-service-allowances.mjs";
import { compareArchitectureMetrics, countDependencyMemberAccesses, countHostMemberAccesses, readArchitectureMetricsBaseline } from "./architecture-metrics.mjs";

const baseline = await readArchitectureMetricsBaseline();
const document = await readArchitectureServiceAllowances();
const entry = document.entries[0];

test("native settlement integration preserves the original protected protocol owner ceiling", async () => {
  const path = "apps/gateway/src/services/remote-worker-assignment-execution-protocol-service.ts";
  const source = await fs.readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  assert.ok(countDependencyMemberAccesses(source, path) <= baseline.dependencyMemberAccessesByFile[path]);
  assert.ok(!document.entries.some(item => item.path === path), "Existing owner cannot receive a new-service allowance");
});

test("reviewed new owner gets only its explicit allowance without changing the baseline", () => {
  const before = structuredClone(baseline);
  const effective = applyArchitectureServiceAllowances(baseline, document);
  assert.deepEqual(baseline, before);
  assert.equal(effective.gatewayLineCount, baseline.gatewayLineCount);
  assert.equal(effective.gatewayPublicMethodCount, baseline.gatewayPublicMethodCount);
  assert.equal(effective.dependencyMemberAccessesByFile[entry.path], entry.maxDependencyMemberAccesses);
  for (const [name, limit] of Object.entries(baseline.dependencyMemberAccessesByFile)) {
    assert.equal(effective.dependencyMemberAccessesByFile[name], limit);
  }
  const comparison = compareArchitectureMetrics(effective, baseline, document);
  assert.deepEqual(comparison.regressions, []);
  assert.deepEqual(comparison.newServiceAllowances, document.entries);
});

test("allowance exhaustion and unlisted new owners still fail the gate", () => {
  for (const name of [entry.path, "apps/gateway/src/services/unreviewed-owner.ts"]) {
    const measured = applyArchitectureServiceAllowances(baseline, document);
    measured.dependencyMemberAccessesByFile[name] = (measured.dependencyMemberAccessesByFile[name] ?? 0) + 1;
    measured.totalDependencyMemberAccesses++;
    const result = compareArchitectureMetrics(measured, baseline, document);
    assert.ok(result.regressions.some((value) => value.includes(name)));
    assert.ok(
      result.regressions.some((value) =>
        value.startsWith("Extracted-service typed dependency member accesses increased from"),
      ),
    );
  }
});

test("unused new-service allowance cannot conceal existing-owner growth", () => {
  const measured = structuredClone(baseline);
  const name = Object.keys(baseline.dependencyMemberAccessesByFile)[0];
  measured.dependencyMemberAccessesByFile[name]++;
  measured.totalDependencyMemberAccesses++;
  assert.ok(compareArchitectureMetrics(measured, baseline, document).regressions.some((value) => value.includes(name)));
});

test("refuses allowances for existing owners including those with zero measured dependencies", () => {
  const zeroOwner = document.existingServicePaths.find((name) => !(name in baseline.dependencyMemberAccessesByFile));
  assert.ok(zeroOwner);
  for (const name of [zeroOwner, Object.keys(baseline.dependencyMemberAccessesByFile)[0]]) {
    assert.throws(
      () => applyArchitectureServiceAllowances(baseline, { ...document, entries: [{ ...entry, path: name }] }),
      /existing-owner limits/,
    );
  }
});

test("refuses stale, duplicate, malformed or unreviewed allowances", () => {
  for (const patch of [
    { baselineMeasuredSourceSha256: "0".repeat(64) },
    { entries: [entry, entry] },
    { entries: [{ ...entry, maxDependencyMemberAccesses: -1 }] },
    { entries: [{ ...entry, maxHostCallbacks: 1.5 }] },
    { entries: [{ ...entry, path: "apps/gateway/src/services/../existing.ts" }] },
    { entries: [{ ...entry, planStep: "unrelated" }] },
    { entries: [{ ...entry, reason: "" }] },
    { entries: [{ ...entry, evidence: "" }] },
    { existingServicePaths: [] },
  ])
    assert.throws(
      () => applyArchitectureServiceAllowances(baseline, { ...document, ...patch }),
      /existing-owner limits/,
    );
});

test("baseline file remains the pinned original threshold document", async () => {
  const disk = JSON.parse(
    await fs.readFile(new URL("../baselines/architecture-metrics.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(disk, baseline);
  assert.equal(document.baselineMeasuredSourceSha256, disk.measuredSourceSha256);
});

test("cockpit Inbox allowance retains raw coupling and the original limits", async () => {
  const path = "apps/gateway/src/services/inbox-projection-service.ts";
  const reviewed = document.entries.find((item) => item.path === path);
  assert.ok(reviewed);
  assert.equal(reviewed.planStep, "mission-control-cockpit:phase-3");
  assert.equal(reviewed.maxDependencyMemberAccesses, 24);
  assert.equal(reviewed.maxHostCallbacks, 0);
  assert.ok(!document.existingServicePaths.includes(path));
  const source = await fs.readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  assert.ok(countDependencyMemberAccesses(source, path) <= reviewed.maxDependencyMemberAccesses);
  assert.equal(countHostMemberAccesses(source, path), 0);

  const original = structuredClone(baseline);
  const measured = applyArchitectureServiceAllowances(baseline, document);
  const beforeComparison = structuredClone(measured);
  const comparison = compareArchitectureMetrics(measured, baseline, document);
  assert.deepEqual(baseline, original);
  assert.deepEqual(measured, beforeComparison);
  assert.equal(measured.dependencyMemberAccessesByFile[path], 24);
  assert.equal(
    comparison.deltas.totalDependencyMemberAccesses,
    measured.totalDependencyMemberAccesses - baseline.totalDependencyMemberAccesses,
  );
  assert.deepEqual(comparison.regressions, []);
  assert.deepEqual(comparison.newServiceAllowances.find((item) => item.path === path), reviewed);
});

test("cockpit allowance rejects exhausted caps, neighboring steps, and existing owners", () => {
  const reviewed = document.entries.find((item) => item.planStep === "mission-control-cockpit:phase-3");
  assert.ok(reviewed);
  for (const [perFile, total] of [
    ["dependencyMemberAccessesByFile", "totalDependencyMemberAccesses"],
    ["hostCallbacksByFile", "totalHostCallbacks"],
  ]) {
    const measured = applyArchitectureServiceAllowances(baseline, document);
    measured[perFile][reviewed.path]++;
    measured[total]++;
    assert.ok(compareArchitectureMetrics(measured, baseline, document).regressions
      .some((message) => message.includes(reviewed.path)));
  }
  for (const planStep of [
    "mission-control-cockpit",
    "mission-control-cockpit:phase-2",
    "mission-control-cockpit:phase-4",
    "mission-control-cockpit:phase-30",
  ]) {
    assert.throws(
      () => applyArchitectureServiceAllowances(baseline, { ...document, entries: [{ ...reviewed, planStep }] }),
      /existing-owner limits/,
    );
  }
  const zeroOwner = document.existingServicePaths.find((name) => !(name in baseline.dependencyMemberAccessesByFile));
  assert.ok(zeroOwner);
  for (const path of [zeroOwner, Object.keys(baseline.dependencyMemberAccessesByFile)[0]]) {
    assert.throws(
      () => applyArchitectureServiceAllowances(baseline, { ...document, entries: [{ ...reviewed, path }] }),
      /existing-owner limits/,
    );
  }
});

test("reviewed Phase 0d child owner admits only its measured responsibility and preserves existing caps", async () => {
  const path = "apps/gateway/src/services/orchestration-phase-child-service.ts";
  const reviewed = document.entries.find((item) => item.path === path);
  assert.ok(reviewed);
  assert.equal(reviewed.planStep, "mission-control-cockpit:phase-0d");
  assert.equal(reviewed.maxDependencyMemberAccesses, 7);
  assert.equal(reviewed.maxHostCallbacks, 6);
  assert.ok(!document.existingServicePaths.includes(path));
  const source = await fs.readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  assert.ok(countDependencyMemberAccesses(source, path) <= reviewed.maxDependencyMemberAccesses);
  assert.ok(countHostMemberAccesses(source, path) <= reviewed.maxHostCallbacks);
  const original = structuredClone(baseline);
  const inventory = structuredClone(document.existingServicePaths);
  const previous = { ...document, entries: document.entries.filter((item) => item.path !== path) };
  const before = applyArchitectureServiceAllowances(baseline, previous);
  const effective = applyArchitectureServiceAllowances(baseline, document);
  for (const key of ["hostCallbacksByFile", "dependencyMemberAccessesByFile"]) {
    for (const [name, limit] of Object.entries(before[key])) assert.equal(effective[key][name], limit);
  }
  assert.equal(effective.totalDependencyMemberAccesses, before.totalDependencyMemberAccesses + 7);
  assert.equal(effective.totalHostCallbacks, before.totalHostCallbacks + 6);
  assert.equal(effective.gatewayRouteCompositionPortMemberCount, before.gatewayRouteCompositionPortMemberCount);
  assert.equal(effective.gatewayLineCount, before.gatewayLineCount);
  assert.deepEqual(compareArchitectureMetrics(effective, baseline, document).regressions, []);
  assert.deepEqual(baseline, original);
  assert.deepEqual(document.existingServicePaths, inventory);
});

test("Phase 0d child allowance fails exhaustion, unreviewed neighboring steps and existing owners", () => {
  const reviewed = document.entries.find((item) => item.planStep === "mission-control-cockpit:phase-0d");
  assert.ok(reviewed);
  for (const [perFile, total] of [
    ["dependencyMemberAccessesByFile", "totalDependencyMemberAccesses"],
    ["hostCallbacksByFile", "totalHostCallbacks"],
  ]) {
    const measured = applyArchitectureServiceAllowances(baseline, document);
    measured[perFile][reviewed.path]++;
    measured[total]++;
    assert.ok(compareArchitectureMetrics(measured, baseline, document).regressions
      .some((message) => message.includes(reviewed.path)));
  }
  for (const planStep of [
    "mission-control-cockpit:phase-0",
    "mission-control-cockpit:phase-0c",
    "mission-control-cockpit:phase-0e",
    "mission-control-cockpit:phase-0D",
    "mission-control-cockpit:phase-0d-other",
  ]) {
    assert.throws(
      () => applyArchitectureServiceAllowances(baseline, { ...document, entries: [{ ...reviewed, planStep }] }),
      /existing-owner limits/,
    );
  }
  const zeroOwner = document.existingServicePaths.find((name) => !(name in baseline.dependencyMemberAccessesByFile));
  assert.ok(zeroOwner);
  for (const path of [zeroOwner, "apps/gateway/src/services/orchestration-lifecycle-service.ts"]) {
    assert.throws(
      () => applyArchitectureServiceAllowances(baseline, { ...document, entries: [{ ...reviewed, path }] }),
      /existing-owner limits/,
    );
  }
});

test("inherited setup registration admits exactly the reviewed owners with unchanged previous limits", async () => {
  const reviewed = document.entries.filter((item) => item.planStep === "llama-cpp-setup:settings-owner");
  assert.deepEqual(reviewed.map((item) => [item.path, item.maxDependencyMemberAccesses, item.maxHostCallbacks]), [
    ["apps/gateway/src/services/llama-cpp-setup-selection-service.ts", 5, 0],
    ["apps/gateway/src/services/llama-cpp-setup-service.ts", 11, 0],
  ]);
  const previous = applyArchitectureServiceAllowances(baseline, {
    ...document, entries: document.entries.filter((item) => item.planStep !== "llama-cpp-setup:settings-owner"),
  });
  const effective = applyArchitectureServiceAllowances(baseline, document);
  for (const item of reviewed) {
    assert.ok(!document.existingServicePaths.includes(item.path));
    const source = await fs.readFile(new URL(`../../../${item.path}`, import.meta.url), "utf8");
    assert.ok(countDependencyMemberAccesses(source, item.path) <= item.maxDependencyMemberAccesses);
    assert.equal(countHostMemberAccesses(source, item.path), 0);
  }
  for (const key of ["hostCallbacksByFile", "dependencyMemberAccessesByFile"]) {
    for (const [path, limit] of Object.entries(previous[key])) assert.equal(effective[key][path], limit);
  }
  assert.equal(effective.totalDependencyMemberAccesses, previous.totalDependencyMemberAccesses + 16);
  assert.equal(effective.totalHostCallbacks, previous.totalHostCallbacks);
  assert.deepEqual(compareArchitectureMetrics(effective, baseline, document).regressions, []);
});

test("setup registration rejects other paths, misleading steps, existing owners and exhausted caps", () => {
  const reviewed = document.entries.filter((item) => item.planStep === "llama-cpp-setup:settings-owner");
  for (const item of reviewed) {
    for (const [perFile, total] of [
      ["dependencyMemberAccessesByFile", "totalDependencyMemberAccesses"],
      ["hostCallbacksByFile", "totalHostCallbacks"],
    ]) {
      const measured = applyArchitectureServiceAllowances(baseline, document);
      measured[perFile][item.path]++;
      measured[total]++;
      assert.ok(compareArchitectureMetrics(measured, baseline, document).regressions
        .some((message) => message.includes(item.path)));
    }
    for (const patch of [
      { path: "apps/gateway/src/services/unreviewed-setup-owner.ts" },
      { path: "apps/gateway/src/services/../llama-cpp-setup-service.ts" },
      { path: document.existingServicePaths[0] },
      { planStep: "llama-cpp-setup" },
      { planStep: "llama-cpp-setup:settings" },
      { planStep: "llama-cpp-setup:settings-owner-extra" },
      { planStep: "mission-control-cockpit:phase-3" },
      { planStep: "mission-control-cockpit:phase-0d" },
      { planStep: "C0" },
    ]) {
      assert.throws(
        () => applyArchitectureServiceAllowances(baseline, { ...document, entries: [{ ...item, ...patch }] }),
        /existing-owner limits/,
      );
    }
  }
});

test("Phase 0d registers only the three reviewed extraction paths and fixed measured caps", async () => {
  const reviewed = document.entries.filter((item) => item.planStep === "mission-control-cockpit:phase-0d");
  assert.deepEqual(reviewed.map((item) => [item.path, item.maxDependencyMemberAccesses, item.maxHostCallbacks]), [
    ["apps/gateway/src/services/orchestration-phase-child-service.ts", 7, 6],
    ["apps/gateway/src/services/orchestration-phase-harvest-service.ts", 5, 0],
    ["apps/gateway/src/services/runtime-llama-setup-change.ts", 11, 0],
  ]);
  for (const item of reviewed) {
    const source = await fs.readFile(new URL(`../../../${item.path}`, import.meta.url), "utf8");
    assert.ok(source.trimEnd().split(/\r?\n/u).length <= 400);
    assert.ok(countDependencyMemberAccesses(source, item.path) <= item.maxDependencyMemberAccesses);
    assert.ok(countHostMemberAccesses(source, item.path) <= item.maxHostCallbacks);
    for (const patch of [
      { path: "apps/gateway/src/services/unreviewed-extraction.ts" },
      { path: "apps/gateway/src/services/orchestration-phase-execution-service.ts" },
      { path: "apps/gateway/src/services/runtime-configuration-change-plan-adapter.ts" },
      { planStep: "C0" },
      { planStep: "mission-control-cockpit:phase-3" },
      { planStep: "mission-control-cockpit:phase-0e" },
      { planStep: "llama-cpp-setup:settings-owner" },
    ]) {
      assert.throws(
        () => applyArchitectureServiceAllowances(baseline, { ...document, entries: [{ ...item, ...patch }] }),
        /existing-owner limits/,
      );
    }
    for (const [perFile, total] of [
      ["dependencyMemberAccessesByFile", "totalDependencyMemberAccesses"],
      ["hostCallbacksByFile", "totalHostCallbacks"],
    ]) {
      const measured = applyArchitectureServiceAllowances(baseline, document);
      measured[perFile][item.path]++;
      measured[total]++;
      assert.ok(compareArchitectureMetrics(measured, baseline, document).regressions
        .some((message) => message.includes(item.path)));
    }
  }
});
