import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { createSqliteAsyncStorage } from "./async-storage.js";
import { Storage } from "./index.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerInferenceRepository } from "./remote-worker-inference-repo.js";
import { RemoteWorkerRuntimeAdmissionRepository, type RemoteWorkerRuntimeAdmissionInput } from "./remote-worker-runtime-admission-repo.js";
import { RemoteWorkerNativeFileReceiptRepository } from "./remote-worker-native-file-receipt-repo.js";
import { RemoteWorkerNativeFileTransferRepository } from "./remote-worker-native-file-transfer-repo.js";
import { RemoteWorkerRuntimeInstallRepository, type RemoteWorkerRuntimeInstallRequestInput } from "./remote-worker-runtime-install-repo.js";

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
    assert.ok(storage.remoteWorkerRuntimeAdmissions instanceof RemoteWorkerRuntimeAdmissionRepository);
    assert.ok(storage.remoteWorkerRuntimeInstalls instanceof RemoteWorkerRuntimeInstallRepository);
    assert.ok(storage.remoteWorkerNativeFileReceipts instanceof RemoteWorkerNativeFileReceiptRepository);
    assert.ok(storage.remoteWorkerNativeFileTransfers instanceof RemoteWorkerNativeFileTransferRepository);
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
    await assert.rejects(storage.remoteWorkerRuntimeAdmissions.admitPreparedForAssignment({} as RemoteWorkerRuntimeAdmissionInput));
    await assert.rejects(storage.remoteWorkerRuntimeInstalls.retainRequestForAssignment({} as RemoteWorkerRuntimeInstallRequestInput));
    await assert.rejects(storage.remoteWorkerRuntimeInstalls.prepareRequestForAssignment({} as Parameters<RemoteWorkerRuntimeInstallRepository["prepareRequestForAssignment"]>[0]));
    await assert.rejects(storage.remoteWorkerRuntimeInstalls.validatePendingReviewForAssignment({} as Parameters<RemoteWorkerRuntimeInstallRepository["validatePendingReviewForAssignment"]>[0]));
    await assert.rejects(storage.remoteWorkerRuntimeInstalls.validateReviewForAssignment({} as Parameters<RemoteWorkerRuntimeInstallRepository["validateReviewForAssignment"]>[0]));
    await assert.rejects(storage.remoteWorkerRuntimeInstalls.readAdmissionMaterialForAssignment({} as Parameters<RemoteWorkerRuntimeInstallRepository["readAdmissionMaterialForAssignment"]>[0]));
    await assert.rejects(storage.remoteWorkerNativeFileReceipts.findForAssignment({} as Parameters<RemoteWorkerNativeFileReceiptRepository["findForAssignment"]>[0]));
    await assert.rejects(storage.remoteWorkerNativeFileTransfers.readForAssignment({} as Parameters<RemoteWorkerNativeFileTransferRepository["readForAssignment"]>[0]));
    assert.equal(await storage.remoteWorkerCells.getCell(cellKey), undefined, "rejected admission cannot create a cell");
  } finally {
    await storage.close();
  }
});
