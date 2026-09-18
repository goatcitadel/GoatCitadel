import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import {
  applyArchitectureServiceAllowances,
  readArchitectureServiceAllowances,
} from "./architecture-service-allowances.mjs";
import { compareArchitectureMetrics, countDependencyMemberAccesses, readArchitectureMetricsBaseline } from "./architecture-metrics.mjs";

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
