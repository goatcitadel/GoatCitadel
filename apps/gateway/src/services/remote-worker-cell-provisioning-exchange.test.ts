import { describe, expect, it, vi } from "vitest";
import type {
  RemoteWorkerCellProvisioningAssignmentInput,
  RemoteWorkerCellPreparationAssignmentInput,
} from "@goatcitadel/storage";
import { REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { objectInventoryHistoryFixture } from "../../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import {
  exchangeRemoteWorkerCellProvisioning,
  prepareRemoteWorkerCellProvisioning,
} from "./remote-worker-cell-provisioning-exchange.js";

describe("provisioning exchange snapshots", () => {
  it.each(["exchange", "prepare"] as const)("freezes %s scope and authority before yielding", async (mode) => {
    const history = objectInventoryHistoryFixture();
    const input = {
      registryWorkspaceId: history.registryWorkspaceId,
      assignmentId: history.assignmentId,
      assignmentGeneration: history.assignmentGeneration,
      leaseRevision: history.leaseRevision,
      leaseTokenSha256: "1".repeat(64),
      protectedAuthority: {
        credentialAuthority: { credentialGeneration: 1 },
        meshAdmission: { admissionGeneration: 1 },
      },
      submission:
        mode === "prepare"
          ? { kind: "cell.provisioning.prepare", parentIdentityHex: history.plan.parentIdentityHex }
          : { kind: "cell.provisioning.snapshot" },
    };
    const observe = async (
      value: RemoteWorkerCellProvisioningAssignmentInput | RemoteWorkerCellPreparationAssignmentInput,
    ) => {
      await Promise.resolve();
      input.assignmentId = "changed-during-await";
      input.protectedAuthority.credentialAuthority.credentialGeneration = 9;
      input.submission.parentIdentityHex = "0".repeat(48);
      expect(value.assignmentId).toBe(history.assignmentId);
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.submission)).toBe(true);
      expect(Object.isFrozen(value.protectedAuthority.credentialAuthority)).toBe(true);
      expect(Object.isFrozen(value.protectedAuthority.meshAdmission)).toBe(true);
    };
    const owner = {
      exchange: vi.fn(async (value: RemoteWorkerCellProvisioningAssignmentInput) => {
        await observe(value);
        return history;
      }),
      prepare: vi.fn(async (value: RemoteWorkerCellPreparationAssignmentInput) => {
        await observe(value);
        return {
          schemaVersion: REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION,
          decision: "reconcile" as const,
          provisioningExpiresAt: "2099-01-01T00:00:00.000Z",
          exchange: history,
        };
      }),
    };
    if (mode === "exchange")
      await expect(
        exchangeRemoteWorkerCellProvisioning(owner, input as unknown as RemoteWorkerCellProvisioningAssignmentInput),
      ).resolves.toEqual(history);
    else
      await expect(
        prepareRemoteWorkerCellProvisioning(owner, input as unknown as RemoteWorkerCellPreparationAssignmentInput),
      ).resolves.toMatchObject({ exchange: history });
  });
});
