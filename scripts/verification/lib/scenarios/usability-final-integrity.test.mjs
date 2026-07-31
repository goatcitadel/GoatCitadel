import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertArtifactRedactionGate } from "../../../verify-artifact-redaction.mjs";
import {
  beginUsabilitySourceGuard,
  combineUsabilityPrimaryAndIntegrityErrors,
  completeUsabilityFinalIntegrity,
} from "./usability-final-integrity.mjs";

const STARTED_SOURCE_STATE = Object.freeze({
  mode: "final",
  baseSha: "a".repeat(40),
  sourceModified: false,
  diffSha256: "b".repeat(64),
  changedPathCount: 0,
});

test("final usability integrity scans the exact run even when the latest pointer races to a sibling", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-usability-final-integrity-"));
  try {
    const exactRoot = path.join(root, "exact-usability-run");
    const racedRoot = path.join(root, "concurrent-run");
    const pointerPath = path.join(root, "latest-run.json");
    await fs.mkdir(path.join(exactRoot, "diagnostics"), { recursive: true });
    await fs.mkdir(racedRoot, { recursive: true });
    await fs.writeFile(
      path.join(racedRoot, "provider.log"),
      "Authorization: Bearer sk-concurrent-run-secret-that-must-be-detected",
      "utf8",
    );
    await fs.writeFile(
      pointerPath,
      `${JSON.stringify({ runId: "concurrent-run", artifactRoot: racedRoot })}\n`,
      "utf8",
    );

    await assert.rejects(assertArtifactRedactionGate(racedRoot), /artifact redaction found/u);
    const result = await completeUsabilityFinalIntegrity(
      { artifactRoot: exactRoot, latestRunPointerPath: pointerPath, repoRoot: root },
      STARTED_SOURCE_STATE,
      {
        snapshotUsabilitySourceState: () => STARTED_SOURCE_STATE,
      },
    );

    assert.equal(result.artifactRoot, exactRoot);
    const sourceProof = JSON.parse(await fs.readFile(result.sourceStatePath, "utf8"));
    assert.deepEqual(sourceProof, {
      schemaVersion: 1,
      started: STARTED_SOURCE_STATE,
      completed: STARTED_SOURCE_STATE,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("final usability integrity scans the persisted completed source-state proof", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-usability-final-source-proof-"));
  try {
    const artifactRoot = path.join(root, "run");
    await fs.mkdir(path.join(artifactRoot, "diagnostics"), { recursive: true });

    await assert.rejects(
      completeUsabilityFinalIntegrity({ artifactRoot, repoRoot: root }, STARTED_SOURCE_STATE, {
        snapshotUsabilitySourceState: () => STARTED_SOURCE_STATE,
        writeJson: async (target, value) => {
          await fs.writeFile(
            target,
            `${JSON.stringify({
              ...value,
              injectedFixture: "Authorization: Bearer sk-final-source-state-secret-that-must-be-detected",
            })}\n`,
            "utf8",
          );
        },
      }),
      /artifact redaction found/u,
    );

    const persisted = await fs.readFile(
      path.join(artifactRoot, "diagnostics", "usability-source-state.json"),
      "utf8",
    );
    assert.match(persisted, /sk-final-source-state-secret-that-must-be-detected/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("final usability integrity retains the completed source state and rejects a changed HEAD", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-usability-source-guard-"));
  try {
    const artifactRoot = path.join(root, "run");
    await fs.mkdir(path.join(artifactRoot, "diagnostics"), { recursive: true });
    const completedSourceState = { ...STARTED_SOURCE_STATE, baseSha: "c".repeat(40) };

    await assert.rejects(
      completeUsabilityFinalIntegrity({ artifactRoot, repoRoot: root }, STARTED_SOURCE_STATE, {
        snapshotUsabilitySourceState: () => completedSourceState,
      }),
      /source changed during verification \(baseSha\)/u,
    );

    const sourceProof = JSON.parse(
      await fs.readFile(path.join(artifactRoot, "diagnostics", "usability-source-state.json"), "utf8"),
    );
    assert.deepEqual(sourceProof.completed, completedSourceState);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source guard validates the initial snapshot before prerequisites", () => {
  let calls = 0;
  assert.deepEqual(
    beginUsabilitySourceGuard("C:/fixture/repo", "final", {
      snapshotUsabilitySourceState: (repoRoot, mode) => {
        calls += 1;
        assert.equal(repoRoot, "C:/fixture/repo");
        assert.equal(mode, "final");
        return STARTED_SOURCE_STATE;
      },
    }),
    STARTED_SOURCE_STATE,
  );
  assert.equal(calls, 1);
});

test("failed-run integrity aggregation preserves the primary error and redacts secondary details", () => {
  const primary = new Error("primary usability lane failure");
  const unsafeIntegrity = new Error(
    "could not inspect C:\\private\\provider.log containing Authorization: Bearer sk-secret-that-must-not-escape",
  );

  const combined = combineUsabilityPrimaryAndIntegrityErrors(primary, unsafeIntegrity);

  assert.ok(combined instanceof AggregateError);
  assert.equal(combined.errors[0], primary);
  assert.equal(combined.cause, primary);
  assert.equal(combined.errors[1]?.message, "usability final integrity gate failed");
  assert.match(combined.message, /^primary usability lane failure\nSecondary usability final-integrity failure:/u);
  assert.doesNotMatch(combined.message, /private|provider\.log|Authorization|sk-secret/iu);
  assert.doesNotMatch(combined.errors[1]?.message ?? "", /private|provider\.log|Authorization|sk-secret/iu);
});
