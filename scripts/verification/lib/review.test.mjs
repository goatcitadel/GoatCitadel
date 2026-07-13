import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { generateVerificationReview } from "./review.mjs";

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
