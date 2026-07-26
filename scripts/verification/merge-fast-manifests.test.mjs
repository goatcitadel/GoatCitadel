import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  FAST_LANE_COMMANDS,
  FAST_LANE_STAGES,
  resolveFastLaneSelection,
  selectFastLaneStages,
} from "./lib/scenarios/fast-lane.mjs";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "merge-fast-manifests.mjs");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const allCommandIds = FAST_LANE_COMMANDS.map((command) => command.id);

describe("fast lane command selection", () => {
  it("treats an empty selection as the whole lane", () => {
    assert.equal(resolveFastLaneSelection(undefined), undefined);
    assert.equal(resolveFastLaneSelection(""), undefined);
    assert.equal(resolveFastLaneSelection("  ,  "), undefined);
    assert.deepEqual(selectFastLaneStages(FAST_LANE_STAGES, undefined), FAST_LANE_STAGES);
  });

  it("rejects an unknown command id instead of running nothing", () => {
    assert.throws(() => resolveFastLaneSelection("fast.test.gatway"), /Unknown fast lane command id/);
  });

  it("keeps only the selected commands and drops emptied stages", () => {
    const selection = resolveFastLaneSelection("fast.test.storage,fast.docs");
    const stages = selectFastLaneStages(FAST_LANE_STAGES, selection);
    assert.deepEqual(
      stages.flatMap((stage) => stage.commands),
      ["fast.test.storage", "fast.docs"],
    );
    for (const stage of stages) {
      assert.ok(stage.commands.length > 0);
    }
  });

  it("covers every command exactly once when the shards are unioned", () => {
    const shards = ["fast.test.gateway.shard1", "fast.test.storage"];
    const rest = allCommandIds.filter((id) => !shards.includes(id));
    const scheduled = [
      ...selectFastLaneStages(FAST_LANE_STAGES, resolveFastLaneSelection(shards.join(","))),
      ...selectFastLaneStages(FAST_LANE_STAGES, resolveFastLaneSelection(rest.join(","))),
    ].flatMap((stage) => stage.commands);
    assert.deepEqual([...scheduled].sort(), [...allCommandIds].sort());
  });
});

describe("fast lane manifest merge", () => {
  it("recomposes partial manifests into one run", () => {
    withTempDir((tempDir) => {
      const outDir = path.join(tempDir, "merged");
      writePart(tempDir, "part-a", ["fast.test.gateway.shard1"], "2026-07-25T10:00:00.000Z");
      writePart(
        tempDir,
        "part-b",
        allCommandIds.filter((id) => id !== "fast.test.gateway.shard1"),
        "2026-07-25T10:00:30.000Z",
      );

      const result = runMerge([tempDir, `--out=${outDir}`]);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
      assert.equal(manifest.lane, "fast");
      assert.equal(manifest.status, "passed");
      assert.equal(manifest.scenarios.length, allCommandIds.length);
      assert.equal(manifest.counts.passed, allCommandIds.length);
      assert.equal(manifest.metadata.mergedPartCount, 2);
      // Run bounds span every part rather than restarting from the merge itself.
      assert.equal(manifest.startedAt, "2026-07-25T10:00:00.000Z");
      assert.ok(Date.parse(manifest.finishedAt) > Date.parse("2026-07-25T10:00:30.000Z"));

      assert.ok(fs.existsSync(path.join(outDir, "summary.md")));
      assert.ok(fs.existsSync(path.join(outDir, "junit.xml")));
      const perf = JSON.parse(fs.readFileSync(path.join(outDir, "perf", "fast-lane-timing.json"), "utf8"));
      assert.equal(perf.integrityFailure, false);
    });
  });

  it("writes the latest-run pointer beside the merged run, not into the repo", () => {
    withTempDir((tempDir) => {
      const outDir = path.join(tempDir, "merged");
      const repoPointer = path.join(repoRoot, "artifacts", "verification", "latest-run.json");
      const repoPointerBefore = fs.existsSync(repoPointer) ? fs.readFileSync(repoPointer, "utf8") : undefined;
      writePart(tempDir, "part-a", allCommandIds, "2026-07-25T10:00:00.000Z");

      const result = runMerge([tempDir, `--out=${outDir}`]);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

      const pointer = JSON.parse(fs.readFileSync(path.join(tempDir, "latest-run.json"), "utf8"));
      assert.equal(pointer.artifactRoot, outDir);
      // A merge that repointed the repo would send the staging script — which reads
      // this pointer to find the run it must upload — at a directory in someone
      // else's temp dir.
      const repoPointerAfter = fs.existsSync(repoPointer) ? fs.readFileSync(repoPointer, "utf8") : undefined;
      assert.equal(repoPointerAfter, repoPointerBefore);
    });
  });

  it("finds parts nested the way download-artifact leaves them", () => {
    withTempDir((tempDir) => {
      const outDir = path.join(tempDir, "merged");
      // parts/<artifact-name>/artifacts/verification/<runId>/manifest.json
      writePart(tempDir, "parts/verification-fast-part-checks/artifacts/verification/run-1", ["fast.docs"], "2026-07-25T10:00:00.000Z");
      writePart(
        tempDir,
        "parts/verification-fast-part-tests-gateway/artifacts/verification/run-2",
        allCommandIds.filter((id) => id !== "fast.docs"),
        "2026-07-25T10:00:05.000Z",
      );

      const result = runMerge([path.join(tempDir, "parts"), `--out=${outDir}`]);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
      assert.equal(manifest.scenarios.length, allCommandIds.length);
    });
  });

  it("fails closed when a shard never reported its commands", () => {
    withTempDir((tempDir) => {
      writePart(tempDir, "part-a", ["fast.test.gateway.shard1"], "2026-07-25T10:00:00.000Z");

      const result = runMerge([tempDir, `--out=${path.join(tempDir, "merged")}`]);
      assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(`${result.stderr}${result.stdout}`, /missing \d+ command\(s\)/);
      assert.match(`${result.stderr}${result.stdout}`, /fast\.docs/);
    });
  });

  it("fails when two shards ran the same command", () => {
    withTempDir((tempDir) => {
      writePart(tempDir, "part-a", allCommandIds, "2026-07-25T10:00:00.000Z");
      writePart(tempDir, "part-b", ["fast.build"], "2026-07-25T10:00:30.000Z");

      const result = runMerge([tempDir, `--out=${path.join(tempDir, "merged")}`]);
      assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(`${result.stderr}${result.stdout}`, /same scenario more than once/);
    });
  });

  it("propagates a failed scenario into the merged status", () => {
    withTempDir((tempDir) => {
      const outDir = path.join(tempDir, "merged");
      writePart(tempDir, "part-a", ["fast.test.gateway.shard1"], "2026-07-25T10:00:00.000Z", { status: "failed" });
      writePart(
        tempDir,
        "part-b",
        allCommandIds.filter((id) => id !== "fast.test.gateway.shard1"),
        "2026-07-25T10:00:30.000Z",
      );

      const result = runMerge([tempDir, `--out=${outDir}`]);
      assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
      assert.equal(manifest.status, "failed");
      assert.equal(manifest.counts.failed, 1);
    });
  });
});

function runMerge(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
}

function withTempDir(body) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-fast-merge-"));
  try {
    body(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writePart(tempDir, name, commandIds, startedAt, overrides = {}) {
  const partDir = path.join(tempDir, name);
  fs.mkdirSync(partDir, { recursive: true });
  let cursor = Date.parse(startedAt);
  const scenarios = commandIds.map((id) => {
    const scenarioStartedAt = new Date(cursor).toISOString();
    cursor += 1_000;
    return {
      id,
      lane: "fast",
      title: id,
      subsystem: "fast",
      status: overrides.status ?? "passed",
      startedAt: scenarioStartedAt,
      finishedAt: new Date(cursor).toISOString(),
      durationMs: 1_000,
      notes: [],
      metrics: {},
      artifacts: { diagnostics: [], screenshots: [], traces: [], logs: [], perf: [], playwright: [] },
    };
  });
  fs.writeFileSync(
    path.join(partDir, "manifest.json"),
    JSON.stringify({
      runId: `run-${name}`,
      lane: "fast",
      startedAt,
      finishedAt: new Date(cursor).toISOString(),
      durationMs: cursor - Date.parse(startedAt),
      status: overrides.status === "failed" ? "failed" : "passed",
      repoRoot: tempDir,
      artifactRoot: partDir,
      metadata: { profile: "local" },
      counts: {
        passed: overrides.status === "failed" ? 0 : scenarios.length,
        failed: overrides.status === "failed" ? scenarios.length : 0,
        skipped: 0,
        degraded: 0,
        notConfigured: 0,
      },
      scenarios,
    }),
    "utf8",
  );
}
