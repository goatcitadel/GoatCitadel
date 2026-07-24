import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WorkerCellBackupError,
  WorkerCellBackupPort,
  type WorkerCellBackupOwnerPort,
  type WorkerCellLivenessEvidence,
  type WorkerCellRestoreExpectation,
} from "./remote-worker-cell-backup-port.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function owner(overrides: Partial<WorkerCellBackupOwnerPort> = {}): WorkerCellBackupOwnerPort {
  return {
    stagePrivately: async () => ({ stagingSha256: D("staging"), stagedBytes: 1_000 }),
    publishAtomically: async () => ({ publicationSha256: D("publication"), publishedBytes: 1_000 }),
    reverify: async () => ({ matches: true, observedSha256: D("publication") }),
    restoreToNewRoot: async () => ({ matches: true, restoredSha256: D("restored"), restoredBytes: 1_000 }),
    ...overrides,
  };
}

const liveness: WorkerCellLivenessEvidence = {
  executionState: "exited",
  zeroProcessConfirmed: true,
  networkClosedConfirmed: true,
  rootIdentityUnchanged: true,
};

const expectation: WorkerCellRestoreExpectation = {
  profileSha256: D("profile"),
  assignmentManifestSha256: D("manifest"),
  imageDigest: `sha256:${"a".repeat(64)}`,
  allocatedDiskBytes: 4_000_000,
};

describe("HX-505 cell backup port — backup after confirmed zero liveness", () => {
  it("stages, publishes, and verifies a backup to verified", async () => {
    const outcome = await new WorkerCellBackupPort(owner()).planBackup({ liveness, cellStateSha256: D("state") });
    expect(outcome.nextBackupState).toBe("verified");
    expect(outcome.stagedThrough).toBe("verified");
    expect(outcome.retainedBytes).toBe(1_000);
  });

  it("refuses to back up a live, unknown-liveness, or unconfirmed cell", async () => {
    const port = new WorkerCellBackupPort(owner());
    for (const bad of [
      { executionState: "running" as const },
      { executionState: "liveness_unknown" as const },
      { zeroProcessConfirmed: false },
      { networkClosedConfirmed: false },
      { rootIdentityUnchanged: false },
    ]) {
      await expect(port.planBackup({ liveness: { ...liveness, ...bad }, cellStateSha256: D("state") })).rejects.toThrow(
        WorkerCellBackupError,
      );
    }
  });

  it("preserves bytes and enters manual reconciliation when the publication fails reverification", async () => {
    const port = new WorkerCellBackupPort(
      owner({ reverify: async () => ({ matches: false, observedSha256: D("drift") }) }),
    );
    const outcome = await port.planBackup({ liveness, cellStateSha256: D("state") });
    expect(outcome.nextBackupState).toBe("manual_reconciliation");
    expect(outcome.stagedThrough).toBe("corrupt");
    expect(outcome.retainedBytes).toBe(2_000);
  });
});

describe("HX-505 cell backup port — restore under approval and exact validation", () => {
  it("restores to ready with approval, a new empty root, and exact validation", async () => {
    const outcome = await new WorkerCellBackupPort(owner()).planRestore({
      approvalReceiptSha256: D("approval"),
      newRootEmpty: true,
      publicationSha256: D("publication"),
      expected: expectation,
      observed: expectation,
    });
    expect(outcome.nextBackupState).toBe("restored");
    expect(outcome.targetExecutionState).toBe("ready");
  });

  it("requires an approval receipt and a new empty root", async () => {
    const port = new WorkerCellBackupPort(owner());
    await expect(
      port.planRestore({
        newRootEmpty: true,
        publicationSha256: D("publication"),
        expected: expectation,
        observed: expectation,
      }),
    ).rejects.toThrow(/approval receipt/u);
    await expect(
      port.planRestore({
        approvalReceiptSha256: D("approval"),
        newRootEmpty: false,
        publicationSha256: D("publication"),
        expected: expectation,
        observed: expectation,
      }),
    ).rejects.toThrow(/new empty root/u);
  });

  it("enters manual reconciliation on identity/profile/digest/capacity drift", async () => {
    const port = new WorkerCellBackupPort(owner());
    const outcome = await port.planRestore({
      approvalReceiptSha256: D("approval"),
      newRootEmpty: true,
      publicationSha256: D("publication"),
      expected: expectation,
      observed: { ...expectation, allocatedDiskBytes: 9_000_000 },
    });
    expect(outcome.nextBackupState).toBe("manual_reconciliation");
  });
});
