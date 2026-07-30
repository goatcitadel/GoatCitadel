import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { generateVerificationReview, validateExplicitReviewTarget } from "./review.mjs";

test("verification review classifies accessibility failures and recommends the focused smoke lane", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-accessibility-review-"));
  try {
    const manifest = {
      runId: "accessibility-run",
      lane: "accessibility-smoke",
      status: "failed",
      startedAt: "2026-07-12T00:00:00.000Z",
      finishedAt: "2026-07-12T00:00:01.000Z",
      durationMs: 1000,
      counts: { passed: 0, failed: 1, degraded: 0, skipped: 0, notConfigured: 0 },
      scenarios: [
        {
          id: "accessibility-smoke.settings-permissions",
          lane: "accessibility-smoke",
          title: "Settings Permissions accessibility",
          subsystem: "mission-control-accessibility",
          status: "failed",
          notes: [],
          error: "axe-core found blocking accessibility violations: select-name (critical, 2 nodes)",
          artifacts: {
            diagnostics: ["diagnostics/accessibility.json"],
            screenshots: ["screenshots/accessibility.png"],
            traces: ["playwright/accessibility-trace.zip"],
            logs: [],
            perf: [],
            playwright: [],
          },
        },
      ],
    };

    const { review, repairPlan } = await generateVerificationReview({ artifactRoot }, { manifest });

    assert.equal(review.items[0].family, "accessibility");
    assert.equal(review.items[0].severity, "high");
    assert.ok(review.items[0].likelySurfaces.includes("apps/mission-control-next"));
    assert.ok(repairPlan.recommendedReruns.includes("pnpm verify:accessibility:smoke"));
    await fs.access(path.join(artifactRoot, "review.json"));
    await fs.access(path.join(artifactRoot, "repair-plan.md"));
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("verification review classifies backup runtime failures without mistaking assertOk for SSE", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-backup-review-"));
  try {
    const manifest = buildFailedReviewManifest(artifactRoot, {
      id: "backup-roundtrip.runtime.config-restore",
      lane: "backup-roundtrip",
      title: "Backup create, verify, and restore returns the minimum backup set",
      subsystem: "runtime",
      error:
        "Error: create runtime backup failed (400): ENOENT lstat config/.goatcitadel-generation.tmp\n    at assertOk (scripts/verification/lib/scenarios.mjs:4305:11)",
    });

    const { review, repairPlan } = await generateVerificationReview({ artifactRoot }, { manifest });

    assert.equal(review.items[0].family, "backup_runtime");
    assert.equal(review.items[0].severity, "medium");
    assert.ok(review.items[0].likelySurfaces.includes("apps/gateway/src/services/backup-retention-service.ts"));
    assert.ok(!review.items[0].likelySurfaces.includes("apps/gateway/src/routes/gateway-events.ts"));
    assert.ok(review.items[0].checklist.some((item) => item.includes("backup snapshot")));
    assert.ok(review.items[0].checklist.every((item) => !item.includes("SSE lifecycle")));
    assert.deepEqual(repairPlan.recommendedReruns, ["pnpm verify:backup:roundtrip"]);
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("verification review does not classify an assertOk-only stack as SSE", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-assert-review-"));
  try {
    const manifest = buildFailedReviewManifest(artifactRoot, {
      id: "runtime.generic-failure",
      lane: "runtime-truth",
      title: "Generic runtime check",
      subsystem: "runtime",
      error: "Error: generic failure\n    at assertOk (scripts/verification/lib/scenarios.mjs:4305:11)",
    });

    const { review } = await generateVerificationReview({ artifactRoot }, { manifest });

    assert.equal(review.items[0].family, "unknown");
    assert.ok(!review.items[0].likelySurfaces.includes("apps/gateway/src/routes/gateway-events.ts"));
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("verification review still classifies an explicit SSE reconnect failure", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-sse-review-"));
  try {
    const manifest = buildFailedReviewManifest(artifactRoot, {
      id: "realtime-truth.disconnect-reconnect-resubscribe",
      lane: "runtime-truth",
      title: "SSE reconnect resumes the retained event stream",
      subsystem: "runtime",
      error: "SSE reconnect failed after the gateway restart",
    });

    const { review } = await generateVerificationReview({ artifactRoot }, { manifest });

    assert.equal(review.items[0].family, "sse");
    assert.equal(review.items[0].severity, "critical");
    assert.ok(review.items[0].likelySurfaces.includes("apps/gateway/src/routes/gateway-events.ts"));
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("verification review classifies direct compatibility redirects before generic timeouts", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-route-compat-review-"));
  try {
    const manifest = buildFailedReviewManifest(artifactRoot, {
      id: "surface-regression.direct-compatibility.direct-cowork",
      lane: "surface-regression",
      title: "direct-cowork direct compatibility path resolves in Mission Control Next",
      subsystem: "mission-control",
      error: "page.waitForFunction: Timeout 30000ms exceeded.",
      artifacts: {
        diagnostics: ["diagnostics/direct-cowork-browser.json"],
        screenshots: ["screenshots/direct-cowork.png"],
        logs: ["playwright/direct-cowork-console.json"],
        perf: [],
        playwright: ["playwright/direct-cowork-console.json", "playwright/direct-cowork-trace.zip"],
        traces: ["playwright/direct-cowork-trace.zip"],
      },
    });

    const { review, repairPlan } = await generateVerificationReview({ artifactRoot }, { manifest });

    assert.equal(review.items[0].family, "route_compatibility");
    assert.equal(review.items[0].severity, "medium");
    assert.ok(review.items[0].likelySurfaces.includes("apps/mission-control-next/src/app/MissionControlNextApp.tsx"));
    assert.ok(!review.items[0].likelySurfaces.includes("apps/gateway/src/services/llm-service.ts"));
    assert.ok(review.items[0].checklist.some((item) => item.includes("canonical path")));
    assert.deepEqual(review.items[0].artifacts, [
      "diagnostics/direct-cowork-browser.json",
      "screenshots/direct-cowork.png",
      "playwright/direct-cowork-console.json",
      "playwright/direct-cowork-trace.zip",
    ]);
    assert.deepEqual(repairPlan.recommendedReruns, ["pnpm verify:surface:regression"]);
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("verification review reports a manifest-level failure when no scenario captured the setup error", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-manifest-failure-review-"));
  try {
    const manifest = {
      ...buildExplicitReviewManifest(artifactRoot),
      status: "failed",
      counts: { passed: 0, failed: 0, degraded: 0, skipped: 0, notConfigured: 0 },
      scenarios: [],
    };

    const { review } = await generateVerificationReview({ artifactRoot }, { manifest });

    assert.equal(review.status, "issues_found");
    assert.equal(review.summary.totalFailures, 1);
    assert.equal(review.items[0].scenarioId, "all.manifest");
    assert.equal(review.items[0].severity, "high");
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("explicit verification review accepts the expected fresh finalized all-lane manifest", () => {
  const artifactRoot = path.join(os.tmpdir(), "verification-all-run");
  const manifest = buildExplicitReviewManifest(artifactRoot);

  assert.equal(
    validateExplicitReviewTarget({
      artifactRoot,
      latestPointer: { runId: manifest.runId, artifactRoot },
      manifest,
      expectedRunId: manifest.runId,
      startedAfter: "2026-07-25T23:59:59.000Z",
    }),
    manifest,
  );
});

test("explicit verification review rejects a running or unfinalized manifest", () => {
  const artifactRoot = path.join(os.tmpdir(), "verification-all-run");
  const manifest = {
    ...buildExplicitReviewManifest(artifactRoot),
    status: "running",
    finishedAt: undefined,
  };

  assert.throws(
    () =>
      validateExplicitReviewTarget({
        artifactRoot,
        latestPointer: { runId: manifest.runId, artifactRoot },
        manifest,
        expectedRunId: manifest.runId,
      }),
    /running or unfinalized/u,
  );
});

test("explicit verification review rejects a non-all lane", () => {
  const artifactRoot = path.join(os.tmpdir(), "verification-all-run");
  const manifest = { ...buildExplicitReviewManifest(artifactRoot), lane: "runtime-truth" };

  assert.throws(
    () =>
      validateExplicitReviewTarget({
        artifactRoot,
        latestPointer: { runId: manifest.runId, artifactRoot },
        manifest,
        expectedRunId: manifest.runId,
      }),
    /expected lane all/u,
  );
});

test("explicit verification review permits only an exact expected-lane override", () => {
  const artifactRoot = path.join(os.tmpdir(), "verification-runtime-truth-run");
  const manifest = { ...buildExplicitReviewManifest(artifactRoot), lane: "runtime-truth" };
  const latestPointer = { runId: manifest.runId, artifactRoot };

  assert.equal(
    validateExplicitReviewTarget({
      artifactRoot,
      latestPointer,
      manifest,
      expectedRunId: manifest.runId,
      expectedLane: "runtime-truth",
    }),
    manifest,
  );
  assert.throws(
    () =>
      validateExplicitReviewTarget({
        artifactRoot,
        latestPointer,
        manifest,
        expectedRunId: manifest.runId,
        expectedLane: "auth-matrix",
      }),
    /expected lane auth-matrix/u,
  );
});

test("explicit verification review rejects pointer, manifest, and freshness mismatches", () => {
  const artifactRoot = path.join(os.tmpdir(), "verification-all-run");
  const manifest = buildExplicitReviewManifest(artifactRoot);

  assert.throws(
    () =>
      validateExplicitReviewTarget({
        artifactRoot,
        latestPointer: { runId: "different-run", artifactRoot },
        manifest,
        expectedRunId: manifest.runId,
      }),
    /does not match manifest run/u,
  );
  assert.throws(
    () =>
      validateExplicitReviewTarget({
        artifactRoot,
        latestPointer: { runId: manifest.runId, artifactRoot: path.join(os.tmpdir(), "different-run") },
        manifest,
        expectedRunId: manifest.runId,
      }),
    /pointer artifact path/u,
  );
  assert.throws(
    () =>
      validateExplicitReviewTarget({
        artifactRoot,
        latestPointer: { runId: manifest.runId, artifactRoot },
        manifest,
        expectedRunId: "different-run",
      }),
    /Expected verification run/u,
  );
  assert.throws(
    () =>
      validateExplicitReviewTarget({
        artifactRoot,
        latestPointer: { runId: manifest.runId, artifactRoot },
        manifest: { ...manifest, artifactRoot: path.join(os.tmpdir(), "different-run") },
        expectedRunId: manifest.runId,
      }),
    /manifest artifact path/u,
  );
  assert.throws(
    () =>
      validateExplicitReviewTarget({
        artifactRoot,
        latestPointer: { runId: manifest.runId, artifactRoot },
        manifest,
      }),
    /requires an explicit freshness guard/u,
  );
  assert.throws(
    () =>
      validateExplicitReviewTarget({
        artifactRoot,
        latestPointer: { runId: manifest.runId, artifactRoot },
        manifest,
        startedAfter: "2026-07-26T00:00:01.000Z",
      }),
    /before required freshness boundary/u,
  );
});

function buildExplicitReviewManifest(artifactRoot) {
  return {
    runId: path.basename(artifactRoot),
    lane: "all",
    status: "passed",
    startedAt: "2026-07-26T00:00:00.000Z",
    finishedAt: "2026-07-26T00:00:01.000Z",
    durationMs: 1000,
    artifactRoot,
    counts: { passed: 1, failed: 0, degraded: 0, skipped: 0, notConfigured: 0 },
    scenarios: [],
  };
}

function buildFailedReviewManifest(artifactRoot, scenario) {
  return {
    runId: path.basename(artifactRoot),
    lane: scenario.lane,
    status: "failed",
    startedAt: "2026-07-30T10:44:44.183Z",
    finishedAt: "2026-07-30T11:07:43.505Z",
    durationMs: 1_379_322,
    artifactRoot,
    counts: { passed: 0, failed: 1, degraded: 0, skipped: 0, notConfigured: 0 },
    scenarios: [
      {
        ...scenario,
        status: "failed",
        notes: [],
        artifacts: {
          diagnostics: [],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
          ...scenario.artifacts,
        },
      },
    ],
  };
}
