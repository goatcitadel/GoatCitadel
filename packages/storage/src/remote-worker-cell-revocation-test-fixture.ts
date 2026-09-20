import { seedProtectedFenceHarness } from "./remote-worker-protected-fence-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { verifyCellCapacityExchange } from "./remote-worker-cell-capacity-fixture.js";
import { verifyNativePoolMembership } from "./remote-worker-native-pool-fixture.js";
import { verifyCellObjectInventoryExchange } from "./remote-worker-cell-object-inventory-fixture.js";
import { verifyCellObjectInventoryPages } from "./remote-worker-cell-object-inventory-pages-fixture.js";
import { verifyCellBackingCapacityExchange } from "./remote-worker-cell-backing-capacity-fixture.js";
import { verifyCellCapacityAdmission } from "./remote-worker-cell-capacity-admission-fixture.js";
import { verifyCellCapacityInventory } from "./remote-worker-cell-capacity-inventory-fixture.js";
import { verifyNativeCapacityDelivery } from "./remote-worker-native-capacity-delivery-fixture.js";
import { verifyNativePoolCapacityDelivery } from "./remote-worker-native-pool-capacity-delivery-fixture.js";
import {
  verifyNativeCapacityPages,
  verifyInstallationCapacityPages,
  verifyNativePoolCapacityPages,
  verifyPoolInstallationCapacityPages,
} from "./remote-worker-native-capacity-pages-fixture.js";
import { verifyNativeCellPreparation } from "./remote-worker-cell-preparation-fixture.js";
import { verifyRuntimeResultRetention } from "./remote-worker-runtime-result-fixture.js";
import { verifyRuntimeInstallRetention } from "./remote-worker-runtime-install-fixture.js";
import { verifyRuntimeAdmission } from "./remote-worker-runtime-admission-fixture.js";
import { verifyRuntimeOutputRetention, verifyNativeFileDisclosure } from "./remote-worker-runtime-output-fixture.js";
import { verifyRuntimeResultPages } from "./remote-worker-runtime-result-pages-fixture.js";
import { seedFencedAssignment } from "./remote-worker-assignment-fence-test-fixture.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

// Separate entrypoints let the coverage runner distribute the full authority matrix.
export function registerCellRevocationTests(boundary: "worker" | "mesh_authority" | "parent"): void {
  for (const { kind, verifyExchange } of [
    { kind: "provisioning exchange", verifyExchange: verifyCellProvisioningExchange },
    { kind: "capacity observation", verifyExchange: verifyCellCapacityExchange },
    { kind: "native pool membership", verifyExchange: verifyNativePoolMembership },
    { kind: "object inventory observation", verifyExchange: verifyCellObjectInventoryExchange },
    { kind: "object inventory pages", verifyExchange: verifyCellObjectInventoryPages },
    { kind: "runtime result retention", verifyExchange: verifyRuntimeResultRetention },
    { kind: "runtime installation retention", verifyExchange: verifyRuntimeInstallRetention },
    { kind: "runtime admission", verifyExchange: verifyRuntimeAdmission },
    { kind: "runtime output retention", verifyExchange: verifyRuntimeOutputRetention },
    { kind: "native file disclosure", verifyExchange: verifyNativeFileDisclosure },
    { kind: "runtime result pages", verifyExchange: verifyRuntimeResultPages },
    { kind: "backing capacity observation", verifyExchange: verifyCellBackingCapacityExchange },
    { kind: "capacity admission", verifyExchange: verifyCellCapacityAdmission },
    { kind: "capacity inventory", verifyExchange: verifyCellCapacityInventory },
    { kind: "native capacity delivery", verifyExchange: verifyNativeCapacityDelivery },
    { kind: "native pool capacity delivery", verifyExchange: verifyNativePoolCapacityDelivery },
    { kind: "native capacity staging", verifyExchange: verifyNativeCapacityPages },
    { kind: "installation capacity staging", verifyExchange: verifyInstallationCapacityPages },
    { kind: "native pool capacity staging", verifyExchange: verifyNativePoolCapacityPages },
    { kind: "pool installation capacity staging", verifyExchange: verifyPoolInstallationCapacityPages },
    { kind: "preparation", verifyExchange: verifyNativeCellPreparation },
  ]) {
    const verify = (db: DatabaseClient, seed: string) => {
      const h = seedProtectedFenceHarness(db, seed, true);
      const token = D(`${seed}:lease`);
      // These composed authority fixtures exercise many independent rollback
      // boundaries; PostgreSQL can exceed a minute without a worker heartbeat.
      const longRuntimeFixture =
        kind === "runtime output retention" ||
        kind === "native file disclosure" ||
        kind === "installation capacity staging" ||
        kind === "pool installation capacity staging";
      const { assignmentId, durableRunId } = seedFencedAssignment(
        h,
        seed,
        "cell",
        h.meshFence.admissionGeneration,
        token,
        longRuntimeFixture ? 300 : 60,
        kind === "native file disclosure",
      );
      verifyExchange(
        db,
        { registryWorkspaceId: "default", assignmentId, assignmentGeneration: 1 },
        token,
        h.fence,
        () => {
          if (boundary === "worker")
            h.workerAdmissions.revokeGeneration({
              registryWorkspaceId: "default",
              workerId: h.meshFence.workerId,
              workerGeneration: h.meshFence.workerGeneration,
              reasonCode: "operator_revoked",
              reasonSha256: D("cell-revoke"),
              actorId: "operator-a",
              idempotencyKey: `${seed}:revoke`,
            });
          else if (boundary === "mesh_authority")
            h.meshNodeAdmissions.revokeJoinAuthority({
              registryWorkspaceId: "default",
              workerId: h.meshFence.workerId,
              workerGeneration: h.meshFence.workerGeneration,
              workspaceId: h.meshFence.workspaceId,
              joinAuthorityGeneration: h.meshFence.joinAuthorityGeneration,
              reasonCode: "operator_revoked",
              reason: "Controlled cell exchange test",
              revokedByActorId: "operator-a",
              idempotencyKey: `${seed}:revoke`,
            });
          else {
            const parent = h.durableRuns.getRun(durableRunId);
            h.durableRuns.updateRun({
              runId: durableRunId,
              status: "cancelled",
              clearLease: true,
              expectedVersion: parent.version,
            });
          }
        },
      );
    };
    it(`cell ${kind} rejects ${boundary} revocation on SQLite`, () => {
      const db = createDatabase({
        dbPath: kind.endsWith("capacity staging")
          ? join(mkdtempSync(join(tmpdir(), "gc-native-capacity-staging-")), "proof.db")
          : ":memory:",
      });
      try {
        verify(db, `sqlite-cell-${boundary}`);
      } finally {
        db.close();
      }
    });
    postgresIt(
      `cell ${kind} rejects ${boundary} revocation on PostgreSQL`,
      {
        timeout:
          kind === "runtime installation retention"
            ? 300_000
            : kind.endsWith("capacity staging") || ["runtime output retention", "native file disclosure"].includes(kind)
              ? 240_000
              : 120_000,
      },
      async () => {
        assert.ok(postgresConnectionString);
        const scope = await createRemoteWorkerPostgresTestScope(postgresConnectionString, "cell_exchange");
        try {
          verify(scope.db, `pg-cell-${boundary}`);
        } finally {
          await scope.teardown();
        }
      },
    );
  }
}
