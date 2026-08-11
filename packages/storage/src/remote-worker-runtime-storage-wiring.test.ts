import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { createSqliteAsyncStorage } from "./async-storage.js";
import { Storage } from "./index.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerInferenceRepository } from "./remote-worker-inference-repo.js";

const cellKey = {
  registryWorkspaceId: "workspace-runtime-wiring",
  assignmentId: "assignment-runtime-wiring",
  assignmentGeneration: 1,
} as const;

const inferenceKey = {
  ...cellKey,
  inferenceRequestId: "inference-runtime-wiring",
  attempt: 1,
} as const;

test("Storage owns the shipped remote-worker cell and inference repositories", () => {
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: os.tmpdir(),
    auditDir: os.tmpdir(),
    modelUsageRecoverySweepIntervalMs: 60_000,
  });
  try {
    assert.ok(storage.remoteWorkerCells instanceof RemoteWorkerCellRepository);
    assert.ok(storage.remoteWorkerInference instanceof RemoteWorkerInferenceRepository);
    assert.equal(storage.remoteWorkerCells.getCell(cellKey), undefined);
    assert.equal(storage.remoteWorkerInference.getRequest(inferenceKey), undefined);
  } finally {
    storage.close();
  }
});

test("AsyncStorage exposes the canonical remote-worker runtime repository owners", async () => {
  const storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: os.tmpdir(),
      auditDir: os.tmpdir(),
      modelUsageRecoverySweepIntervalMs: 60_000,
    }),
  );
  try {
    assert.equal(await storage.remoteWorkerCells.getCell(cellKey), undefined);
    assert.equal(await storage.remoteWorkerInference.getRequest(inferenceKey), undefined);
  } finally {
    await storage.close();
  }
});
