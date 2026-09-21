import { seedFencedAssignment } from "./remote-worker-assignment-fence-test-fixture.js";
import {
  bootstrapInput,
  protectedCredentialNonce,
  seedProtectedFenceHarness,
} from "./remote-worker-protected-fence-fixture.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
  REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
  REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerAssignmentEventInput,
  type RemoteWorkerAssignmentManifest,
  type RemoteWorkerRuntimeCredentialRecord,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import { DurableRunRepository } from "./durable-run-repo.js";
import { prepareChatOfferFixture } from "./remote-worker-chat-offer-fixture.js";
import { verifyWorkerChatApprovalResume } from "./remote-worker-chat-resume-fixture.js";
import { verifyNativeRuntimeLeaseResume } from "./remote-worker-native-runtime-resume-fixture.js";
import { verifyRetainedNativeChatResult } from "./remote-worker-native-chat-result-fixture.js";
import { verifyWorkerChatParentRecovery } from "./remote-worker-chat-parent-recovery-fixture.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import {
  RemoteWorkerAssignmentRepository,
  type RemoteWorkerAssignmentProtectedCommitFence,
} from "./remote-worker-assignment-repo.js";
import { TaskRepository } from "./task-repo.js";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { verifyWorkerToolBudgets } from "./remote-worker-tool-budget-fixture.js";
import { verifyWorkerArtifactContinuation } from "./remote-worker-artifact-continuation-fixture.js";
import { verifyWorkerTerminalRenewal } from "./remote-worker-terminal-renewal-fixture.js";
import { verifyRemoteWorkerMeshSettlements } from "./remote-worker-mesh-settlement-fixture.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { capacityInventoryFixture } from "../../contracts/src/remote-worker-cell-capacity-inventory-test-fixture.js";
import { remoteWorkerCellCapacityInventorySha256 } from "@goatcitadel/contracts";
import { RemoteWorkerCellCapacityAdmissionRepository } from "./remote-worker-cell-capacity-admission-repo.js";
import { RemoteWorkerCellProvisioningRepository } from "./remote-worker-cell-provisioning-repo.js";
import { NATIVE_CELL_PREPARATION_TEST_POLICY } from "./remote-worker-cell-preparation-fixture.js";
import { verifyNativePolicyReservation } from "./remote-worker-native-policy-reservation-fixture.js";
import { REMOTE_WORKER_RUNTIME_APPROVAL_POSTGRES_SQL } from "./remote-worker-runtime-approval-schema.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const FUTURE = "2099-01-01T00:00:00.000Z";

postgresIt("native approval binding upgrades existing PostgreSQL expectation rows", { timeout: 120_000 }, async () => {
  assert.ok(postgresConnectionString);
  const scope = await createRemoteWorkerPostgresTestScope(postgresConnectionString, "approval_upgrade");
  try {
    // A session-owned temporary table models the pre-migration shape without
    // altering the canonical test tables or touching any installed database.
    scope.db.exec(`CREATE TEMP TABLE approvals (approval_id TEXT PRIMARY KEY);
      CREATE TEMP TABLE remote_worker_runtime_expectations (nonce TEXT PRIMARY KEY, expectation_json TEXT NOT NULL);
      INSERT INTO remote_worker_runtime_expectations VALUES ('legacy', '{"retained":true}');`);
    scope.db.exec(REMOTE_WORKER_RUNTIME_APPROVAL_POSTGRES_SQL);
    scope.db.exec(REMOTE_WORKER_RUNTIME_APPROVAL_POSTGRES_SQL);
    assert.deepEqual(
      scope.db.prepare("SELECT * FROM remote_worker_runtime_expectations WHERE nonce = 'legacy'").get(),
      { nonce: "legacy", expectation_json: '{"retained":true}', approval_id: null },
    );
    assert.throws(() =>
      scope.db
        .prepare("INSERT INTO remote_worker_runtime_expectations VALUES ('invalid', '{}', 'missing-approval')")
        .run(),
    );
  } finally {
    await scope.teardown();
  }
});

for (const decision of ["approve", "reject"] as const) {
  const verify = async (db: DatabaseClient, seed: string) => {
    const h = seedProtectedFenceHarness(db, seed, true);
    await verifyNativeRuntimeLeaseResume(
      db,
      seed,
      {
        workerId: h.finalized.generation.workerId,
        workerGeneration: h.finalized.generation.workerGeneration,
        nodeId: h.finalized.generation.nodeId,
        nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
      },
      h.fence,
      decision,
    );
  };
  it(`native runtime lease resume ${decision} on SQLite`, async () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      await verify(db, `native-${decision}-sqlite`);
    } finally {
      db.close();
    }
  });
  postgresIt(`native runtime lease resume ${decision} on PostgreSQL`, { timeout: 120_000 }, async () => {
    assert.ok(postgresConnectionString);
    const scope = await createRemoteWorkerPostgresTestScope(postgresConnectionString, `native_${decision}`);
    try {
      await verify(scope.db, `native-${decision}-pg`);
    } finally {
      await scope.teardown();
    }
  });
}

for (const dialect of ["SQLite", "PostgreSQL"] as const) {
  const run = dialect === "SQLite" ? it : postgresIt;
  run(`retained native result reaches canonical Chat on ${dialect}`, { timeout: 120_000 }, async () => {
    const pg =
      dialect === "PostgreSQL"
        ? await createRemoteWorkerPostgresTestScope(postgresConnectionString!, "native_chat_result")
        : undefined;
    const db = pg?.db ?? createDatabase({ dbPath: ":memory:" });
    try {
      const seed = `native-result-${dialect.toLowerCase()}`,
        h = seedProtectedFenceHarness(db, seed, true);
      await verifyRetainedNativeChatResult(
        db,
        seed,
        {
          workerId: h.finalized.generation.workerId,
          workerGeneration: h.finalized.generation.workerGeneration,
          nodeId: h.finalized.generation.nodeId,
          nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
        },
        h.fence,
        (authority) => verifyNativePolicyReservation(db, authority),
      );
    } finally {
      if (pg) await pg.teardown();
      else db.close();
    }
  });
}

postgresIt(
  "cell preparation has one creation winner under concurrent PostgreSQL requests",
  { timeout: 120_000 },
  async () => {
    assert.ok(postgresConnectionString);
    const scope = await createRemoteWorkerPostgresTestScope(postgresConnectionString, "cell_prepare_race");
    const workers: FencedRepositoryWorker[] = [];
    let hold: Awaited<ReturnType<typeof holdAdvisoryLock>> | undefined;
    try {
      const h = seedProtectedFenceHarness(scope.db, "native-prepare-race", true);
      const token = D("native-prepare-race:lease");
      const { assignmentId } = seedFencedAssignment(
        h,
        "native-prepare-race",
        "cell",
        h.meshFence.admissionGeneration,
        token,
      );
      const input = {
        registryWorkspaceId: "default",
        assignmentId,
        assignmentGeneration: 1,
        leaseRevision: 1,
        leaseTokenSha256: token,
        protectedAuthority: h.fence,
        policy: NATIVE_CELL_PREPARATION_TEST_POLICY,
        submission: { kind: "cell.provisioning.prepare", parentIdentityHex: "0100000000000000" + "1".repeat(32) },
      };
      const connection = new URL(postgresConnectionString);
      connection.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
      const database = decodeURIComponent(connection.pathname.slice(1)) || "postgres";
      hold = await holdAdvisoryLock(scope.scopedPool, 411, "default");
      for (const name of ["native-create-one", "native-create-two"])
        workers.push(
          runFencedRepositoryWorker(connection.toString(), database, name, {
            repositoryModule: "remote-worker-cell-provisioning-repo",
            repositoryExport: "RemoteWorkerCellProvisioningRepository",
            operation: "prepareForAssignment",
            args: [input],
          }),
        );
      await Promise.all(workers.map((worker) => worker.ready));
      // Observe both transactions actually waiting on the held canonical lock.
      await waitForAdvisoryLockWait(scope.scopedPool, "native-create-one", ", 411)");
      await waitForAdvisoryLockWait(scope.scopedPool, "native-create-two", ", 411)");
      await hold.release();
      const results = await Promise.all(workers.map((worker) => worker.result));
      for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
      const values = results.map((result) => {
        assert.ok(result.ok);
        return result.value;
      });
      assert.deepEqual(values.map((value) => value.decision).sort(), ["create_once", "reconcile"]);
      const [left, right] = values;
      assert.ok(left && right);
      assert.deepEqual(left.exchange, right.exchange);
      const key = { registryWorkspaceId: "default", assignmentId };
      assert.equal(
        countRows(
          scope.db,
          `SELECT COUNT(*) AS count FROM remote_worker_cells
      WHERE registry_workspace_id=@registryWorkspaceId AND assignment_id=@assignmentId`,
          key,
        ),
        1,
      );
      assert.equal(
        countRows(
          scope.db,
          `SELECT COUNT(*) AS count FROM remote_worker_cell_provisioning
      WHERE registry_workspace_id=@registryWorkspaceId AND assignment_id=@assignmentId`,
          key,
        ),
        1,
      );
    } finally {
      await hold?.release();
      await Promise.allSettled(workers.map((worker) => worker.result));
      await scope.teardown();
    }
  },
);

for (const inventoryAdmission of [false, true]) {
  postgresIt(
    `cell capacity ${inventoryAdmission ? "inventory" : "admission"} has one winner under concurrent PostgreSQL requests`,
    { timeout: 120_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const scope = await createRemoteWorkerPostgresTestScope(postgresConnectionString, "cell_capacity_race");
      const workers: FencedRepositoryWorker[] = [];
      let hold: Awaited<ReturnType<typeof holdAdvisoryLock>> | undefined;
      try {
        const h = seedProtectedFenceHarness(scope.db, "capacity-admission-race", true);
        const token = D("capacity-admission-race:lease");
        const { assignmentId } = seedFencedAssignment(
          h,
          "capacity-admission-race",
          "cell",
          h.meshFence.admissionGeneration,
          token,
        );
        const authority = {
          registryWorkspaceId: "default",
          assignmentId,
          assignmentGeneration: 1,
          leaseRevision: 1,
          leaseTokenSha256: token,
          protectedAuthority: h.fence,
        };
        new RemoteWorkerCellProvisioningRepository(scope.db).prepareForAssignment({
          ...authority,
          policy: NATIVE_CELL_PREPARATION_TEST_POLICY,
          submission: { kind: "cell.provisioning.prepare", parentIdentityHex: "0100000000000000" + "1".repeat(32) },
        });
        const owner = new RemoteWorkerCellCapacityAdmissionRepository(scope.db),
          cell = owner.readForAssignment(authority);
        const input = {
          ...authority,
          expectedCapacityRevision: cell.capacityRevision,
          expectedCleanupRevision: cell.cleanupRevision,
          expectedExecutionRevision: cell.executionRevision,
          observation: {
            reservation: cell.capacity,
            incomingBytes: 1_000,
            peakDiskBytes: 1_000,
            peakMemoryBytes: 10,
            peakFileCount: 1,
            peakProcessCount: 1,
            rawOutputBytes: 100,
            footprint: {
              schemaVersion: cell.capacity.schemaVersion,
              mutableRootBytes: 1_000,
              inputStagingBytes: 0,
              backupStagingBytes: 0,
              artifactStagingBytes: 0,
              immutableArtifactBytes: 0,
              retainedOutboxBytes: 0,
              databaseSidecarBytes: 0,
              backupPublicationBytes: 0,
              manifestBytes: 0,
              proxySidecarBytes: 0,
              diagnosticBytes: 0,
              failedCleanupBytes: 0,
              quarantineEvidenceBytes: 0,
            },
          },
        };
        const evidenceCount = () =>
          countRows(
            scope.db,
            `SELECT COUNT(*) AS count FROM remote_worker_cell_evidence
      WHERE registry_workspace_id=@registryWorkspaceId AND assignment_id=@assignmentId AND domain='capacity'`,
            { registryWorkspaceId: "default", assignmentId },
          );
        const beforeEvidence = evidenceCount();
        const inventory = capacityInventoryFixture(cell.profileSha256, "concurrent-inventory");
        const requestInput = inventoryAdmission
          ? {
              ...input,
              expectedBackupRevision: cell.backupRevision,
              inventory,
              inventoryBinding: {
                profileSha256: inventory.profileSha256,
                captureSha256: inventory.captureSha256,
                inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory),
              },
            }
          : input;
        const connection = new URL(postgresConnectionString);
        connection.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
        const database = decodeURIComponent(connection.pathname.slice(1)) || "postgres";
        hold = await holdAdvisoryLock(scope.scopedPool, 411, "default");
        for (const name of ["capacity-admit-one", "capacity-admit-two"])
          workers.push(
            runFencedRepositoryWorker(connection.toString(), database, name, {
              repositoryModule: "remote-worker-cell-capacity-admission-repo",
              repositoryExport: "RemoteWorkerCellCapacityAdmissionRepository",
              operation: inventoryAdmission ? "admitInventory" : "admit",
              args: [requestInput],
            }),
          );
        await Promise.all(workers.map((worker) => worker.ready));
        await waitForAdvisoryLockWait(scope.scopedPool, "capacity-admit-one", ", 411)");
        await waitForAdvisoryLockWait(scope.scopedPool, "capacity-admit-two", ", 411)");
        await hold.release();
        const results = await Promise.all(workers.map((worker) => worker.result));
        assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
        const refused = results.find((result) => !result.ok);
        assert.ok(refused && !refused.ok && /capacity revision/u.test(refused.error), JSON.stringify(results));
        const winner = results.find((result) => result.ok);
        assert.ok(winner?.ok);
        assert.equal(winner.value.decision, "accept");
        assert.equal(owner.readForAssignment(authority).capacityRevision, cell.capacityRevision + 1);
        assert.equal(evidenceCount(), beforeEvidence + 1);
        if (inventoryAdmission) {
          assert.equal(
            countRows(
              scope.db,
              `SELECT COUNT(*) AS count FROM remote_worker_cell_capacity_inventories
        WHERE registry_workspace_id=@registryWorkspaceId AND assignment_id=@assignmentId`,
              { registryWorkspaceId: "default", assignmentId },
            ),
            1,
          );
          assert.equal(
            owner.readInventory({ ...authority, capacityRevision: cell.capacityRevision + 1 })!.accounting
              .hostAllocatedBytes,
            86_016,
          );
        }
      } finally {
        await hold?.release();
        await Promise.allSettled(workers.map((worker) => worker.result));
        await scope.teardown();
      }
    },
  );
}

function verifyInventoryInodeLimit(db: DatabaseClient, seed: string): void {
  const h = seedProtectedFenceHarness(db, seed, true),
    token = D(`${seed}:lease`);
  const { assignmentId } = seedFencedAssignment(h, seed, "cell", h.meshFence.admissionGeneration, token);
  const authority = {
    registryWorkspaceId: "default",
    assignmentId,
    assignmentGeneration: 1,
    leaseRevision: 1,
    leaseTokenSha256: token,
    protectedAuthority: h.fence,
  };
  new RemoteWorkerCellProvisioningRepository(db).prepareForAssignment({
    ...authority,
    policy: {
      ...NATIVE_CELL_PREPARATION_TEST_POLICY,
      capacity: { ...NATIVE_CELL_PREPARATION_TEST_POLICY.capacity, fileLimit: 4, inodeLimit: 4 },
    },
    submission: { kind: "cell.provisioning.prepare", parentIdentityHex: "0100000000000000" + "1".repeat(32) },
  });
  const owner = new RemoteWorkerCellCapacityAdmissionRepository(db),
    cell = owner.readForAssignment(authority);
  const inventory = capacityInventoryFixture(cell.profileSha256, seed);
  const command = () => {
    const current = owner.readForAssignment(authority);
    return {
      ...authority,
      expectedCapacityRevision: current.capacityRevision,
      expectedExecutionRevision: current.executionRevision,
      expectedCleanupRevision: current.cleanupRevision,
      expectedBackupRevision: current.backupRevision,
      inventory,
      inventoryBinding: {
        profileSha256: inventory.profileSha256,
        captureSha256: inventory.captureSha256,
        inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory),
      },
      observation: {
        reservation: current.capacity,
        incomingBytes: 1,
        peakDiskBytes: 0,
        peakMemoryBytes: 0,
        peakFileCount: 0,
        peakProcessCount: 0,
        rawOutputBytes: 0,
      },
    };
  };
  const exceeded = owner.admitInventory(command());
  assert.equal(exceeded.decision, "quarantine");
  assert.match(exceeded.reason, /inode count/u);
  assert.equal(exceeded.cell.peakFileCount, 4);
  inventory.areas[0]!.objects.splice(2, 1);
  inventory.captureSha256 = D(`${seed}:lower-capture`);
  const lower = owner.admitInventory(command());
  assert.equal(lower.decision, "quarantine");
  const retained = owner.readInventory({ ...authority, capacityRevision: lower.cell.capacityRevision })!;
  assert.equal(retained.peakInodeCount, 5);
  const rawCommand = command();
  const raw = owner.admit({
    ...rawCommand,
    observation: { ...rawCommand.observation, footprint: retained.accounting.footprint },
  });
  assert.equal(raw.decision, "quarantine", "footprint-only admission cannot forget a retained inode violation");
  assert.match(raw.reason, /inode count/u);
}
it("cell capacity inventory retains inode violations on SQLite", () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try {
    verifyInventoryInodeLimit(db, "inventory-inodes-sqlite");
  } finally {
    db.close();
  }
});
postgresIt("cell capacity inventory retains inode violations on PostgreSQL", { timeout: 120_000 }, async () => {
  assert.ok(postgresConnectionString);
  const scope = await createRemoteWorkerPostgresTestScope(postgresConnectionString, "inventory_inodes");
  try {
    verifyInventoryInodeLimit(scope.db, "inventory-inodes-postgres");
  } finally {
    await scope.teardown();
  }
});

it("worker tool model budgets use canonical protected authority on SQLite", () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try {
    seedProtectedFenceHarness(db, "sqlite-existing-worker");
    prepareChatOfferFixture(db, true, "-existing-budget-profile");
    const h = seedProtectedFenceHarness(db, "sqlite-tool-budget", true);
    verifyWorkerToolBudgets(
      db,
      "sqlite-tool-budget",
      {
        workerId: h.finalized.generation.workerId,
        workerGeneration: h.finalized.generation.workerGeneration,
        nodeId: h.finalized.generation.nodeId,
        nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
      },
      h.fence,
    );
  } finally {
    db.close();
  }
});

it("worker artifact publication preserves continuous authority on SQLite", () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try {
    const h = seedProtectedFenceHarness(db, "sqlite-artifact", true);
    verifyWorkerArtifactContinuation(
      db,
      "sqlite-artifact",
      {
        workerId: h.finalized.generation.workerId,
        workerGeneration: h.finalized.generation.workerGeneration,
        nodeId: h.finalized.generation.nodeId,
        nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
      },
      h.fence,
    );
  } finally {
    db.close();
  }
});

it("worker terminal renewal and settlement commit atomically on SQLite", () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try {
    const h = seedProtectedFenceHarness(db, "sqlite-terminal", true);
    verifyWorkerTerminalRenewal(
      db,
      "sqlite-terminal",
      {
        workerId: h.finalized.generation.workerId,
        workerGeneration: h.finalized.generation.workerGeneration,
        nodeId: h.finalized.generation.nodeId,
        nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
      },
      h.fence,
    );
  } finally {
    db.close();
  }
});

for (const boundary of ["worker", "mesh_authority"] as const) {
  const verify = (db: DatabaseClient, seed: string) => {
    const h = seedProtectedFenceHarness(db, seed, true);
    verifyRemoteWorkerMeshSettlements(db, seed, h.meshFence, h.finalized.generation.clientCertificateSha256, () => {
      if (boundary === "worker") {
        h.workerAdmissions.revokeGeneration({
          registryWorkspaceId: h.meshFence.registryWorkspaceId,
          workerId: h.meshFence.workerId,
          workerGeneration: h.meshFence.workerGeneration,
          reasonCode: "operator_revoked",
          reasonSha256: D(`${seed}:reason`),
          actorId: "operator-a",
          idempotencyKey: `${seed}:revoke`,
        });
      } else {
        h.meshNodeAdmissions.revokeJoinAuthority({
          registryWorkspaceId: h.meshFence.registryWorkspaceId,
          workerId: h.meshFence.workerId,
          workerGeneration: h.meshFence.workerGeneration,
          workspaceId: h.meshFence.workspaceId,
          joinAuthorityGeneration: h.meshFence.joinAuthorityGeneration,
          reasonCode: "operator_revoked",
          reason: "Controlled revocation",
          revokedByActorId: "operator-a",
          idempotencyKey: `${seed}:revoke`,
        });
      }
    });
  };
  it(`native mesh settlement rejects ${boundary} revocation on SQLite`, () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      verify(db, `sqlite-mesh-${boundary}`);
    } finally {
      db.close();
    }
  });
  postgresIt(`native mesh settlement rejects ${boundary} revocation on PostgreSQL`, { timeout: 120_000 }, async () => {
    assert.ok(postgresConnectionString);
    const scope = await createRemoteWorkerPostgresTestScope(postgresConnectionString, "mesh_settlement");
    try {
      verify(scope.db, `pg-mesh-${boundary}`);
    } finally {
      await scope.teardown();
    }
  });
}

describe("RemoteWorkerAssignmentRepository live PostgreSQL authority", () => {
  postgresIt(
    "migrates SQL and serializes parent heartbeat/context drift against worker progress",
    { timeout: 120_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx501_assignment_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const setupDb = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx501-assignment-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        const h = seedPostgresHarness(setupDb, suffix);
        const started = h.assignments.startGeneration(h.startInput);
        assert.equal(started.lease.parentDispatchAuthority.durableRunVersion, 1);
        assert.ok(started.lease.expiresAt <= started.lease.parentDispatchAuthority.durableRunLeaseExpiresAt);

        const protectedAdmissionEnvelopeSha256 = D(`${suffix}:protected-envelope`);
        const protectedAdmissionContextSha256 = D(`${suffix}:protected-context`);
        const protectedCommitFence = {
          credentialAuthority: {
            registryWorkspaceId: h.worker.generation.registryWorkspaceId,
            bootstrapId: h.worker.generation.bootstrapId,
            workerId: h.worker.generation.workerId,
            workerGeneration: h.worker.generation.workerGeneration,
            credentialId: h.worker.credential.credentialId,
            credentialGeneration: h.worker.credential.credentialGeneration,
            authorizationCredentialSha256: D(`${suffix}:credential`),
            nodeId: h.worker.generation.nodeId,
            clientCertificateSha256: h.worker.generation.clientCertificateSha256,
            runtimeManifestSha256: h.worker.generation.runtimeManifestSha256,
            workspaceCeilingSha256: h.worker.generation.workspaceCeilingSha256,
            capabilityCeilingSha256: h.worker.generation.capabilityCeilingSha256,
            protectedAdmissionEnvelopeSha256,
            protectedAdmissionContextSha256,
            claimsSha256: h.worker.credential.claimsSha256,
          },
          meshAdmission: {
            schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
            registryWorkspaceId: h.worker.generation.registryWorkspaceId,
            bootstrapId: h.worker.generation.bootstrapId,
            workerId: h.worker.generation.workerId,
            workerGeneration: h.worker.generation.workerGeneration,
            credentialId: h.worker.credential.credentialId,
            credentialGeneration: h.worker.credential.credentialGeneration,
            workspaceId: "default",
            nodeId: h.worker.generation.nodeId,
            admissionGeneration: h.nodeAdmission.admissionGeneration,
            joinAuthorityGeneration: 1,
            joinCredentialSha256: D(`${suffix}:protected-join`),
            protectedAdmissionEnvelopeSha256,
            protectedAdmissionContextSha256,
          },
        } as const;
        h.workerAdmissions.rotateRuntimeCredential({
          registryWorkspaceId: h.worker.generation.registryWorkspaceId,
          workerId: h.worker.generation.workerId,
          workerGeneration: h.worker.generation.workerGeneration,
          expectedCredentialId: h.worker.credential.credentialId,
          expectedCredentialGeneration: h.worker.credential.credentialGeneration,
          verifiedTransportReceiptSha256: D(`${suffix}:rotation-transport`),
          verifiedProofOfPossessionReceiptSha256: D(`${suffix}:rotation-pop`),
          credentialIssuanceProofSha256: D(`${suffix}:rotation-issuance`),
          expiresInSeconds: 600,
          credentialTokenSha256: D(`${suffix}:rotation-credential`),
          idempotencyKey: `${suffix}:rotation`,
        });
        assert.throws(
          () =>
            h.assignments.resolveActiveAuthorityByLeaseTokenHash(h.startInput.leaseTokenSha256, protectedCommitFence),
          /protected commit authority/u,
        );

        const missingManifestField = { ...h.manifest } as Record<string, unknown>;
        delete missingManifestField.maxEventBytes;
        const missingManifestJson = JSON.stringify(missingManifestField);
        assertDirectPostgresManifestRejected(setupDb, h, `${suffix}:manifest-missing-field`, missingManifestJson);
        const validManifestJson = JSON.stringify(h.manifest);
        const duplicateManifestJson = `${validManifestJson.slice(0, -1)},"maxEventBytes":${h.manifest.maxEventBytes}}`;
        assertDirectPostgresManifestRejected(setupDb, h, `${suffix}:manifest-duplicate-key`, duplicateManifestJson);

        const parentV2 = h.durableRuns.renewLeaseWithDatabaseClock({
          runId: h.durableRunId,
          workerId: "gateway-a",
          leaseDurationMs: 120_000,
        });
        assert.equal(parentV2?.version, 2);
        const firstEvent = statusEvent(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 5);
        assert.throws(() =>
          h.assignments.appendEvents({
            registryWorkspaceId: "default",
            assignmentId: h.assignmentId,
            expectedAssignmentGeneration: 1,
            expectedLeaseRevision: 1,
            leaseTokenSha256: h.startInput.leaseTokenSha256,
            events: [firstEvent],
          }),
        );

        const leaseV2Token = D(`${suffix}:lease:2`);
        const leaseV2 = h.assignments.renewLease({
          registryWorkspaceId: "default",
          assignmentId: h.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          expectedLeaseTokenSha256: h.startInput.leaseTokenSha256,
          leaseTokenSha256: leaseV2Token,
          workerSentThrough: 5,
          idempotencyKey: `${suffix}:renew:2`,
        }).lease;
        assert.equal(leaseV2.parentDispatchAuthority.durableRunVersion, 2);
        assert.equal(leaseV2.parentDispatchAuthority.durableRunLeaseExpiresAt, parentV2?.leaseExpiresAt);
        assert.ok(leaseV2.expiresAt <= leaseV2.parentDispatchAuthority.durableRunLeaseExpiresAt);
        const appended = h.assignments.appendEvents({
          registryWorkspaceId: "default",
          assignmentId: h.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 2,
          leaseTokenSha256: leaseV2Token,
          events: [firstEvent],
        });
        assert.equal(appended.acknowledgedThrough, 1);

        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:status-duplicate-key`,
          "status",
          `{"schemaVersion":"${REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION}","phase":"running","statusSha256":"${D(`${suffix}:status-first`)}","statusSha256":"${D(`${suffix}:status-second`)}"}`,
        );

        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:terminal-negative`,
          "terminal_output",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            stream: "stdout",
            chunkSha256: D(`${suffix}:terminal-negative`),
            byteLength: -1,
          },
        );
        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:terminal-text`,
          "terminal_output",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            stream: "stdout",
            chunkSha256: D(`${suffix}:terminal-text`),
            byteLength: "1",
          },
        );
        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:terminal-oversize`,
          "terminal_output",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            stream: "stderr",
            chunkSha256: D(`${suffix}:terminal-oversize`),
            byteLength: 65_537,
          },
        );
        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:transcript-non-text`,
          "transcript_delta",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            role: "assistant",
            text: 7,
          },
        );
        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:status-missing-digest`,
          "status",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            phase: "running",
          },
        );
        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:watermark-over-manifest`,
          "status",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            phase: "running",
            statusSha256: D(`${suffix}:watermark-over-manifest`),
          },
          101,
        );

        const parentV3 = h.durableRuns.renewLeaseWithDatabaseClock({
          runId: h.durableRunId,
          workerId: "gateway-a",
          leaseDurationMs: 120_000,
        });
        assert.equal(parentV3?.version, 3);
        const leaseV3Token = D(`${suffix}:lease:3`);
        const leaseV3 = h.assignments.renewLease({
          registryWorkspaceId: "default",
          assignmentId: h.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 2,
          expectedLeaseTokenSha256: leaseV2Token,
          leaseTokenSha256: leaseV3Token,
          workerSentThrough: 5,
          idempotencyKey: `${suffix}:renew:3`,
        }).lease;
        assert.equal(leaseV3.parentDispatchAuthority.durableRunVersion, 3);
        assert.ok(leaseV3.expiresAt <= leaseV3.parentDispatchAuthority.durableRunLeaseExpiresAt);

        const lockClient = await scopedPool.connect();
        const secondEvent = statusEvent(2, appended.events[0]!.eventSha256, 5);
        let worker: ReturnType<typeof runAssignmentWorker> | undefined;
        try {
          await lockClient.query("BEGIN");
          await lockClient.query("UPDATE tasks SET deleted_at = '2026-07-14T00:00:00.000Z' WHERE task_id = $1", [
            h.taskId,
          ]);
          const workerApplicationName = `hx501-race-${suffix}`;
          worker = runAssignmentWorker(scopedUrl.toString(), database, workerApplicationName, {
            registryWorkspaceId: "default",
            assignmentId: h.assignmentId,
            expectedAssignmentGeneration: 1,
            expectedLeaseRevision: 3,
            leaseTokenSha256: leaseV3Token,
            events: [secondEvent],
          });
          await worker.ready;
          let workerSettled = false;
          void worker.result.then(
            () => {
              workerSettled = true;
            },
            () => {
              workerSettled = true;
            },
          );
          await waitForParentTaskShareLock(scopedPool, workerApplicationName);
          assert.equal(workerSettled, false, "worker progress must wait for the parent-task ownership row");
          await lockClient.query("COMMIT");
          const workerResult = await worker.result;
          assert.equal(workerResult.ok, false);
          if (workerResult.ok) assert.fail("worker progress crossed a committed parent-context drift");
          assert.match(workerResult.error, /canonical durable parent context|durable assignment authority/u);
        } catch (error) {
          await lockClient.query("ROLLBACK").catch(() => undefined);
          await worker?.result.catch(() => undefined);
          throw error;
        } finally {
          lockClient.release();
        }

        const now = h.durableRuns.readDatabaseNow();
        const payloadJson = canonicalJsonString(secondEvent.payload);
        assert.throws(() =>
          setupDb
            .prepare(
              `INSERT INTO remote_worker_assignment_events (
                 registry_workspace_id, assignment_id, assignment_generation, sequence, event_id,
                 event_type, payload_json, payload_sha256, previous_event_sha256, event_sha256,
                 worker_sent_through, received_at
               ) VALUES (
                 'default', @assignmentId, 1, 2, 'direct-after-drift', 'status', @payloadJson,
                 @payloadSha256, @previousEventSha256, @eventSha256, 5, @receivedAt
               )`,
            )
            .run({
              assignmentId: h.assignmentId,
              payloadJson,
              payloadSha256: D(payloadJson),
              previousEventSha256: appended.events[0]!.eventSha256,
              eventSha256: D("direct-after-drift"),
              receivedAt: now,
            }),
        );
        assert.throws(() =>
          setupDb
            .prepare(
              `INSERT INTO remote_worker_assignment_settlements (
                 registry_workspace_id, assignment_id, assignment_generation, schema_version,
                 outcome, origin, gateway_actor_id, recovery_evidence_sha256,
                 final_event_sequence, final_event_sha256, result_sha256, output_manifest_sha256,
                 failure_sha256, idempotency_key, request_sha256, settled_at
               ) VALUES (
                 'default', @assignmentId, 1, 'goatcitadel.remote-worker-assignment-settlement.v1',
                 'completed', 'worker', NULL, NULL, 1, @finalEventSha256, @resultSha256,
                 @outputManifestSha256, NULL, @idempotencyKey, @requestSha256, @settledAt
               )`,
            )
            .run({
              assignmentId: h.assignmentId,
              finalEventSha256: appended.events[0]!.eventSha256,
              resultSha256: D("direct-result"),
              outputManifestSha256: D("direct-output"),
              idempotencyKey: `${suffix}:direct-settlement`,
              requestSha256: D("direct-settlement"),
              settledAt: now,
            }),
        );
      } finally {
        setupDb.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );

  // The M3 live-PostgreSQL contention proof for protected routes 2-6. Every
  // race below queues real concurrent transactions on the owner's canonical
  // advisory locks (namespaces 411/412/501-504), verifies the loser is
  // genuinely blocked via pg_stat_activity, commits the winning authority
  // mutation, and then proves the stale side is REJECTED by the in-transaction
  // protected commit fence (never interleaved) while the winning side commits
  // exactly once:
  //   1. protected-context drift racing an exact-fence event append;
  //   2. duplicate lease-renewal replay racing the first consume;
  //   3. credential rotation committing against in-flight fenced read + write;
  //   4. duplicate settlement replay racing the first settlement insert;
  //   5. mesh join-authority revoke committing ahead of queued fenced
  //      read + write, plus a stale post-revoke settlement.
  postgresIt(
    "serializes rotation, protected-context drift, join-authority revoke, and duplicate replay against in-flight fenced routes 2-6",
    { timeout: 180_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx502_fence_race_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const setupDb = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx502-fence-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      const spawnedWorkers: Array<Promise<WorkerResult>> = [];
      const spawnFencedWorker = (applicationName: string, request: FencedRepositoryWorkerRequest) => {
        const worker = runFencedRepositoryWorker(scopedUrl.toString(), database, applicationName, request);
        spawnedWorkers.push(worker.result.catch(() => ({ ok: false as const, error: "worker cleanup" })));
        return worker;
      };

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        const h = seedProtectedFenceHarness(setupDb, suffix);
        const toolBudget = seedProtectedFenceHarness(setupDb, `${suffix}-tool-budget`, true);
        verifyWorkerToolBudgets(
          setupDb,
          `${suffix}-tool-budget`,
          {
            workerId: toolBudget.finalized.generation.workerId,
            workerGeneration: toolBudget.finalized.generation.workerGeneration,
            nodeId: toolBudget.finalized.generation.nodeId,
            nodeAdmissionGeneration: toolBudget.admitted.admission.admissionGeneration,
          },
          toolBudget.fence,
        );
        const artifactWorker = seedProtectedFenceHarness(setupDb, `${suffix}-artifact`, true);
        verifyWorkerArtifactContinuation(
          setupDb,
          `${suffix}-artifact`,
          {
            workerId: artifactWorker.finalized.generation.workerId,
            workerGeneration: artifactWorker.finalized.generation.workerGeneration,
            nodeId: artifactWorker.finalized.generation.nodeId,
            nodeAdmissionGeneration: artifactWorker.admitted.admission.admissionGeneration,
          },
          artifactWorker.fence,
        );
        const terminalWorker = seedProtectedFenceHarness(setupDb, `${suffix}-terminal`, true);
        verifyWorkerTerminalRenewal(
          setupDb,
          `${suffix}-terminal`,
          {
            workerId: terminalWorker.finalized.generation.workerId,
            workerGeneration: terminalWorker.finalized.generation.workerGeneration,
            nodeId: terminalWorker.finalized.generation.nodeId,
            nodeAdmissionGeneration: terminalWorker.admitted.admission.admissionGeneration,
          },
          terminalWorker.fence,
        );
        await verifyWorkerChatParentRecovery(
          setupDb,
          suffix,
          {
            workerId: h.finalized.generation.workerId,
            workerGeneration: h.finalized.generation.workerGeneration,
            nodeId: h.finalized.generation.nodeId,
            nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
          },
          h.fence,
        );
        for (const decision of ["approve", "reject", "edit"] as const) {
          await verifyWorkerChatApprovalResume(
            setupDb,
            `${suffix}-${decision}`,
            {
              workerId: h.finalized.generation.workerId,
              workerGeneration: h.finalized.generation.workerGeneration,
              nodeId: h.finalized.generation.nodeId,
              nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
            },
            h.fence,
            decision,
          );
        }
        // An expired retained lease authenticates only a read while the exact
        // Chat parent is parked. It cannot revive execution, renewal or events.
        const waitToken = D(`${suffix}:wait:lease`);
        const waitSeed = prepareChatOfferFixture(setupDb, true, `-wait-${suffix}`);
        const waitAssignment = h.assignments.createAssignment({
          ...waitSeed.legacyCommand,
          manifest: {
            ...waitSeed.legacyCommand.manifest,
            leaseTtlSeconds: 1,
            requiredCapabilityClasses: ["durable_compute", "gateway_inference"],
          },
        }).assignment;
        const parked = { assignmentId: waitAssignment.assignmentId, durableRunId: waitSeed.durableRunId };
        h.assignments.startGeneration({
          registryWorkspaceId: "default",
          assignmentId: parked.assignmentId,
          workerId: h.finalized.generation.workerId,
          workerGeneration: h.finalized.generation.workerGeneration,
          nodeId: h.finalized.generation.nodeId,
          nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
          dispatchOwnerId: waitSeed.offerInput.dispatchOwnerId,
          durableRunAttempt: waitSeed.offerInput.durableRunAttempt,
          leaseTokenSha256: waitToken,
          idempotencyKey: `${suffix}:wait:generation`,
        });
        const waitInput = {
          registryWorkspaceId: "default",
          assignmentId: parked.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          leaseTokenSha256: waitToken,
        };
        assert.equal(h.assignments.resolveWaitingChatAssignmentByLeaseTokenHash(waitInput, h.fence), undefined);
        const originalWait = h.assignments.findAssignmentAggregate("default", parked.assignmentId);
        const parentWait = h.durableRuns.getRun(parked.durableRunId);
        h.durableRuns.updateRun({
          runId: parentWait.runId,
          status: "waiting",
          clearLease: true,
          expectedVersion: parentWait.version,
        });
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        assert.ok(Date.parse(originalWait!.lease!.expiresAt) <= Date.parse(h.durableRuns.readDatabaseNow()));
        assert.equal(
          h.assignments.resolveWaitingChatAssignmentByLeaseTokenHash(waitInput, h.fence)?.assignment.assignmentId,
          parked.assignmentId,
        );
        assert.equal(h.assignments.resolveActiveAuthorityByLeaseTokenHash(waitToken, h.fence), undefined);
        for (const changed of [{ leaseTokenSha256: D("wrong-wait-token") }, { expectedLeaseRevision: 2 }])
          assert.equal(
            h.assignments.resolveWaitingChatAssignmentByLeaseTokenHash({ ...waitInput, ...changed }, h.fence),
            undefined,
          );
        assert.throws(() =>
          h.assignments.resolveWaitingChatAssignmentByLeaseTokenHash(waitInput, {
            ...h.fence,
            credentialAuthority: {
              ...h.fence.credentialAuthority,
              authorizationCredentialSha256: D("wrong-credential"),
            },
          }),
        );
        assert.throws(() =>
          h.assignments.renewLease(
            {
              ...waitInput,
              expectedLeaseTokenSha256: waitToken,
              leaseTokenSha256: D("forbidden-wait-renewal"),
              workerSentThrough: 0,
              idempotencyKey: `${suffix}:wait:renew`,
            },
            h.fence,
          ),
        );
        assert.deepEqual(h.assignments.findAssignmentAggregate("default", parked.assignmentId), originalWait);
        const queuedWait = h.durableRuns.updateRun({
          runId: parentWait.runId,
          status: "queued",
          expectedVersion: h.durableRuns.getRun(parentWait.runId).version,
        });
        assert.equal(h.assignments.resolveWaitingChatAssignmentByLeaseTokenHash(waitInput, h.fence), undefined);
        h.durableRuns.updateRun({ runId: parentWait.runId, status: "waiting", expectedVersion: queuedWait.version });
        const workerId = h.finalized.generation.workerId;
        const nodeId = h.finalized.generation.nodeId;
        const leaseA1 = D(`${suffix}:alpha:lease:1`);
        const assignmentA = seedFencedAssignment(h, suffix, "alpha", h.admitted.admission.admissionGeneration, leaseA1);
        const eventCount = (assignmentId: string) =>
          countRows(
            setupDb,
            `SELECT COUNT(*) AS count FROM remote_worker_assignment_events
             WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
            { assignmentId },
          );
        const leaseCount = (assignmentId: string, leaseRevision?: number) =>
          countRows(
            setupDb,
            `SELECT COUNT(*) AS count FROM remote_worker_assignment_leases
             WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId
               ${leaseRevision === undefined ? "" : "AND lease_revision = @leaseRevision"}`,
            leaseRevision === undefined ? { assignmentId } : { assignmentId, leaseRevision },
          );
        const settlementCount = (assignmentId: string) =>
          countRows(
            setupDb,
            `SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements
             WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
            { assignmentId },
          );

        // The complete M2+M3 protected commit fence PASSES live before any race.
        assert.equal(
          h.assignments.resolveActiveAuthorityByLeaseTokenHash(leaseA1, h.fence)?.assignment.assignmentId,
          assignmentA.assignmentId,
        );

        // Race 1 — protected-context drift racing an exact-fence write. Both
        // transactions queue on the held executionWorkspace advisory lock so
        // they are provably concurrent; after release the exact fence commits
        // its append exactly once and the drifted-context fence is rejected by
        // the in-transaction recheck AFTER the canonical locks, not at intake.
        const driftedFence: RemoteWorkerAssignmentProtectedCommitFence = {
          ...h.fence,
          credentialAuthority: {
            ...h.fence.credentialAuthority,
            protectedAdmissionContextSha256: D(`${suffix}:drifted-protected-context`),
          },
        };
        const appendCommandOne = {
          registryWorkspaceId: "default",
          assignmentId: assignmentA.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          leaseTokenSha256: leaseA1,
          events: [statusEvent(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 1)],
        } as const;
        let firstEventSha256 = "";
        {
          const hold = await holdAdvisoryLock(scopedPool, 411, "default");
          try {
            const appendWorker = spawnFencedWorker(`hx502-drift-append-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "appendEvents",
              args: [appendCommandOne, h.fence],
            });
            const driftWorker = spawnFencedWorker(`hx502-drift-read-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "resolveActiveAuthorityByLeaseTokenHash",
              args: [leaseA1, driftedFence],
            });
            await Promise.all([appendWorker.ready, driftWorker.ready]);
            await waitForAdvisoryLockWait(scopedPool, `hx502-drift-append-${suffix}`, ", 411)");
            await waitForAdvisoryLockWait(scopedPool, `hx502-drift-read-${suffix}`, ", 411)");
            await hold.release();
            const [appendResult, driftResult] = await Promise.all([appendWorker.result, driftWorker.result]);
            assert.equal(appendResult.ok, true, `exact-fence append must win: ${JSON.stringify(appendResult)}`);
            if (appendResult.ok) {
              assert.equal(appendResult.value.disposition, "appended");
              assert.equal(appendResult.value.acknowledgedThrough, 1);
              firstEventSha256 = String(appendResult.value.events[0].eventSha256);
            }
            assert.equal(driftResult.ok, false, "drifted protected-context fence must lose");
            if (!driftResult.ok) assert.match(driftResult.error, /protected commit authority/u);
          } finally {
            await hold.release();
          }
        }
        assert.equal(eventCount(assignmentA.assignmentId), 1);
        assert.equal(
          h.assignments.resolveActiveAuthorityByLeaseTokenHash(leaseA1, h.fence)?.assignment.assignmentId,
          assignmentA.assignmentId,
        );

        // Race 2 — duplicate lease-renewal replay racing the first consume:
        // two byte-identical fenced renewals queue concurrently; exactly one
        // consumes lease revision 1 and the other replays the identical
        // canonical lease without a second materialization.
        const leaseA2 = D(`${suffix}:alpha:lease:2`);
        const renewCommand = {
          registryWorkspaceId: "default",
          assignmentId: assignmentA.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          expectedLeaseTokenSha256: leaseA1,
          leaseTokenSha256: leaseA2,
          workerSentThrough: 1,
          idempotencyKey: `${suffix}:alpha:renew:2`,
        } as const;
        {
          const hold = await holdAdvisoryLock(scopedPool, 411, "default");
          try {
            const renewOne = spawnFencedWorker(`hx502-renew-one-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "renewLease",
              args: [renewCommand, h.fence],
            });
            const renewTwo = spawnFencedWorker(`hx502-renew-two-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "renewLease",
              args: [renewCommand, h.fence],
            });
            await Promise.all([renewOne.ready, renewTwo.ready]);
            await waitForAdvisoryLockWait(scopedPool, `hx502-renew-one-${suffix}`, ", 411)");
            await waitForAdvisoryLockWait(scopedPool, `hx502-renew-two-${suffix}`, ", 411)");
            await hold.release();
            const results = await Promise.all([renewOne.result, renewTwo.result]);
            for (const result of results) {
              assert.equal(result.ok, true, `fenced renewal race must never interleave: ${JSON.stringify(result)}`);
            }
            const renewals = results.map((result) => (result.ok ? result.value : assert.fail("unreachable")));
            assert.deepEqual(renewals.map((outcome) => String(outcome.disposition)).sort(), [
              "renewed",
              "replayed_without_lease_secret",
            ]);
            assert.equal(canonicalJsonString(renewals[0]!.lease), canonicalJsonString(renewals[1]!.lease));
            assert.equal(Number(renewals[0]!.lease.leaseRevision), 2);
          } finally {
            await hold.release();
          }
        }
        assert.equal(leaseCount(assignmentA.assignmentId, 2), 1);
        assert.equal(leaseCount(assignmentA.assignmentId), 2);

        // Race 3 — credential rotation committing against an in-flight fenced
        // write (event append) and read (active-authority sync). Both fenced
        // transactions are queued and provably still blocked when the rotation
        // commits; on release the storage recheck inside their transactions
        // observes the committed rotation and rejects both without writing.
        const rotatedCredentialTokenSha256 = D(`${suffix}:rotation-credential`);
        let rotatedCredential: RemoteWorkerRuntimeCredentialRecord | undefined;
        {
          const hold = await holdAdvisoryLock(scopedPool, 411, "default");
          try {
            const staleWrite = spawnFencedWorker(`hx502-rotation-write-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "appendEvents",
              args: [
                {
                  registryWorkspaceId: "default",
                  assignmentId: assignmentA.assignmentId,
                  expectedAssignmentGeneration: 1,
                  expectedLeaseRevision: 2,
                  leaseTokenSha256: leaseA2,
                  events: [statusEvent(2, firstEventSha256, 2)],
                },
                h.fence,
              ],
            });
            const staleRead = spawnFencedWorker(`hx502-rotation-read-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "resolveActiveAuthorityByLeaseTokenHash",
              args: [leaseA2, h.fence],
            });
            await Promise.all([staleWrite.ready, staleRead.ready]);
            await waitForAdvisoryLockWait(scopedPool, `hx502-rotation-write-${suffix}`, ", 411)");
            await waitForAdvisoryLockWait(scopedPool, `hx502-rotation-read-${suffix}`, ", 411)");
            const rotated = h.workerAdmissions.rotateRuntimeCredential({
              registryWorkspaceId: "default",
              workerId,
              workerGeneration: h.finalized.generation.workerGeneration,
              expectedCredentialId: h.finalized.credential.credentialId,
              expectedCredentialGeneration: h.finalized.credential.credentialGeneration,
              verifiedTransportReceiptSha256: D(`${suffix}:rotation-transport`),
              verifiedProofOfPossessionReceiptSha256: D(`${suffix}:rotation-pop`),
              credentialIssuanceProofSha256: D(`${suffix}:rotation-issuance`),
              expiresInSeconds: 600,
              credentialTokenSha256: rotatedCredentialTokenSha256,
              idempotencyKey: `${suffix}:rotation`,
            });
            assert.equal(rotated.disposition, "created");
            rotatedCredential = rotated.credential;
            assert.equal(
              await isWaitingOnAdvisoryLock(scopedPool, `hx502-rotation-write-${suffix}`, ", 411)"),
              true,
              "the fenced write must still be blocked when the rotation commits",
            );
            assert.equal(
              await isWaitingOnAdvisoryLock(scopedPool, `hx502-rotation-read-${suffix}`, ", 411)"),
              true,
              "the fenced read must still be blocked when the rotation commits",
            );
            await hold.release();
            const [writeResult, readResult] = await Promise.all([staleWrite.result, staleRead.result]);
            assert.equal(writeResult.ok, false, "the stale fenced write must lose to the committed rotation");
            if (!writeResult.ok) assert.match(writeResult.error, /protected commit authority/u);
            assert.equal(readResult.ok, false, "the stale fenced read must lose to the committed rotation");
            if (!readResult.ok) assert.match(readResult.error, /protected commit authority/u);
          } finally {
            await hold.release();
          }
        }
        assert.ok(rotatedCredential);
        assert.equal(eventCount(assignmentA.assignmentId), 1);
        assert.equal(leaseCount(assignmentA.assignmentId), 2);
        assert.equal(
          countRows(
            setupDb,
            `SELECT COUNT(*) AS count FROM remote_worker_runtime_credentials
             WHERE registry_workspace_id = 'default' AND worker_id = @workerId AND credential_generation = 2`,
            { workerId },
          ),
          1,
          "the winning rotation must commit exactly one generation-2 credential",
        );

        // Rebuild a CURRENT authority under the rotated credential exactly the
        // way the committed regressions do: revoke the superseded admission,
        // issue a replacement join authority, re-admit, and re-fence.
        h.capabilityAdmissions.revoke({
          workspaceId: "default",
          nodeId,
          admissionGeneration: h.admitted.admission.admissionGeneration,
          reason: "credential rotated before replacement admission",
          revokedByActorId: "operator-a",
          idempotencyKey: `${suffix}:admission-revoke:1`,
        });
        const rawMeshNodeCredentialTwo = "b".repeat(43);
        const secondIssued = h.meshNodeAdmissions.issueJoinAuthority({
          ...h.joinAuthorityInput,
          idempotencyKey: `${suffix}:mesh-authority:2`,
          rawMeshNodeCredential: rawMeshNodeCredentialTwo,
        });
        assert.equal(secondIssued.disposition, "created");
        const secondAdmitted = h.meshNodeAdmissions.admitWithNonce({
          nonce: protectedCredentialNonce(setupDb, rotatedCredential, `${suffix}:admit:2`),
          command: {
            ...h.admissionCommand,
            rawMeshNodeCredential: rawMeshNodeCredentialTwo,
            protocolBodySha256: D(`${suffix}:admission-body:2`),
            transportReceiptSha256: D(`${suffix}:admission-transport:2`),
            proofOfPossessionReceiptSha256: D(`${suffix}:admission-pop:2`),
            tlsExporterSha256: D(`${suffix}:admission-exporter:2`),
            idempotencyKey: `${suffix}:mesh-admission:2`,
          },
        });
        assert.equal(secondAdmitted.disposition, "admitted");
        const rotatedMeshFence = h.meshNodeAdmissions.resolveCurrentForRuntimeCredential({
          ...h.credentialResolutionInput,
          credentialId: rotatedCredential.credentialId,
          credentialGeneration: rotatedCredential.credentialGeneration,
          authorizationCredentialSha256: rotatedCredentialTokenSha256,
        });
        assert.ok(rotatedMeshFence);
        const rotatedFence: RemoteWorkerAssignmentProtectedCommitFence = {
          credentialAuthority: {
            ...h.claimAuthority,
            credentialId: rotatedCredential.credentialId,
            credentialGeneration: rotatedCredential.credentialGeneration,
            authorizationCredentialSha256: rotatedCredentialTokenSha256,
            claimsSha256: rotatedCredential.claimsSha256,
          },
          meshAdmission: rotatedMeshFence,
        };
        // Parking does not preserve revoked credentials or an obsolete mesh
        // admission, even when the worker still possesses its retained token.
        assert.throws(() => h.assignments.resolveWaitingChatAssignmentByLeaseTokenHash(waitInput, h.fence));
        assert.throws(() => h.assignments.resolveWaitingChatAssignmentByLeaseTokenHash(waitInput, rotatedFence));
        const leaseB1 = D(`${suffix}:beta:lease:1`);
        const assignmentB = seedFencedAssignment(
          h,
          suffix,
          "beta",
          secondAdmitted.admission.admissionGeneration,
          leaseB1,
        );
        const leaseC1 = D(`${suffix}:gamma:lease:1`);
        const assignmentC = seedFencedAssignment(
          h,
          suffix,
          "gamma",
          secondAdmitted.admission.admissionGeneration,
          leaseC1,
        );
        assert.equal(
          h.assignments.resolveActiveAuthorityByLeaseTokenHash(leaseB1, rotatedFence)?.assignment.assignmentId,
          assignmentB.assignmentId,
        );
        assert.equal(
          h.assignments.resolveControlReadAuthorityByLeaseTokenHash(
            {
              registryWorkspaceId: "default",
              assignmentId: assignmentC.assignmentId,
              expectedAssignmentGeneration: 1,
              expectedLeaseRevision: 1,
              leaseTokenSha256: leaseC1,
            },
            rotatedFence,
          )?.disposition,
          "active",
        );

        // Race 4 — duplicate settlement replay racing the first settlement:
        // two byte-identical fenced settlements queue concurrently; exactly one
        // inserts the terminal settlement row and the other replays it.
        const settleCommand = {
          registryWorkspaceId: "default",
          assignmentId: assignmentC.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          leaseTokenSha256: leaseC1,
          outcome: "failed",
          origin: "worker",
          finalEventSequence: 0,
          finalEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
          failureSha256: D(`${suffix}:gamma:failure`),
          idempotencyKey: `${suffix}:gamma:settle`,
        } as const;
        {
          const hold = await holdAdvisoryLock(scopedPool, 411, "default");
          try {
            const settleOne = spawnFencedWorker(`hx502-settle-one-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "settleAssignment",
              args: [settleCommand, rotatedFence],
            });
            const settleTwo = spawnFencedWorker(`hx502-settle-two-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "settleAssignment",
              args: [settleCommand, rotatedFence],
            });
            await Promise.all([settleOne.ready, settleTwo.ready]);
            await waitForAdvisoryLockWait(scopedPool, `hx502-settle-one-${suffix}`, ", 411)");
            await waitForAdvisoryLockWait(scopedPool, `hx502-settle-two-${suffix}`, ", 411)");
            await hold.release();
            const results = await Promise.all([settleOne.result, settleTwo.result]);
            for (const result of results) {
              assert.equal(result.ok, true, `fenced settlement race must never interleave: ${JSON.stringify(result)}`);
            }
            const settlements = results.map((result) => (result.ok ? result.value : assert.fail("unreachable")));
            assert.deepEqual(settlements.map((outcome) => String(outcome.disposition)).sort(), ["replayed", "settled"]);
            assert.equal(
              canonicalJsonString(settlements[0]!.settlement),
              canonicalJsonString(settlements[1]!.settlement),
            );
          } finally {
            await hold.release();
          }
        }
        assert.equal(settlementCount(assignmentC.assignmentId), 1);

        // Race 5 — mesh join-authority revoke racing fenced assignment read +
        // write. The held node advisory lock (412) freezes the revoke AFTER it
        // owns the workspace lock (411), so the queue order is pinned: revoke
        // commits first, then the queued fenced renewal and control read must
        // observe the committed revocation and reject without writing.
        {
          const hold = await holdAdvisoryLock(scopedPool, 412, `default:${nodeId}`);
          try {
            const revokeWorker = spawnFencedWorker(`hx502-revoke-${suffix}`, {
              repositoryModule: "remote-worker-mesh-node-admission-repo",
              repositoryExport: "RemoteWorkerMeshNodeAdmissionRepository",
              operation: "revokeJoinAuthority",
              args: [
                {
                  registryWorkspaceId: "default",
                  workerId,
                  workerGeneration: h.finalized.generation.workerGeneration,
                  workspaceId: "default",
                  joinAuthorityGeneration: secondIssued.authority.joinAuthorityGeneration,
                  reasonCode: "operator.revoked",
                  reason: "live contention proof revocation",
                  revokedByActorId: "operator-a",
                  idempotencyKey: `${suffix}:mesh-authority-revoke:2`,
                },
              ],
            });
            await revokeWorker.ready;
            await waitForAdvisoryLockWait(scopedPool, `hx502-revoke-${suffix}`, ", 412)");
            const staleRenew = spawnFencedWorker(`hx502-revoke-renew-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "renewLease",
              args: [
                {
                  registryWorkspaceId: "default",
                  assignmentId: assignmentB.assignmentId,
                  expectedAssignmentGeneration: 1,
                  expectedLeaseRevision: 1,
                  expectedLeaseTokenSha256: leaseB1,
                  leaseTokenSha256: D(`${suffix}:beta:lease:2`),
                  workerSentThrough: 0,
                  idempotencyKey: `${suffix}:beta:renew:2`,
                },
                rotatedFence,
              ],
            });
            const staleControlRead = spawnFencedWorker(`hx502-revoke-read-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "resolveControlReadAuthorityByLeaseTokenHash",
              args: [
                {
                  registryWorkspaceId: "default",
                  assignmentId: assignmentB.assignmentId,
                  expectedAssignmentGeneration: 1,
                  expectedLeaseRevision: 1,
                  leaseTokenSha256: leaseB1,
                },
                rotatedFence,
              ],
            });
            await Promise.all([staleRenew.ready, staleControlRead.ready]);
            await waitForAdvisoryLockWait(scopedPool, `hx502-revoke-renew-${suffix}`, ", 411)");
            await waitForAdvisoryLockWait(scopedPool, `hx502-revoke-read-${suffix}`, ", 411)");
            await hold.release();
            const [revokeResult, renewResult, controlReadResult] = await Promise.all([
              revokeWorker.result,
              staleRenew.result,
              staleControlRead.result,
            ]);
            assert.equal(revokeResult.ok, true, `the queued revoke must commit: ${JSON.stringify(revokeResult)}`);
            assert.equal(renewResult.ok, false, "the fenced renewal must lose to the committed revocation");
            if (!renewResult.ok) assert.match(renewResult.error, /protected commit authority/u);
            assert.equal(controlReadResult.ok, false, "the fenced control read must lose to the committed revocation");
            if (!controlReadResult.ok) assert.match(controlReadResult.error, /protected commit authority/u);
          } finally {
            await hold.release();
          }
        }
        assert.equal(leaseCount(assignmentB.assignmentId), 1);
        assert.equal(eventCount(assignmentB.assignmentId), 0);
        assert.equal(settlementCount(assignmentB.assignmentId), 0);
        assert.equal(
          countRows(
            setupDb,
            `SELECT COUNT(*) AS count FROM remote_worker_mesh_join_authority_revocations
             WHERE registry_workspace_id = 'default' AND worker_id = @workerId
               AND join_authority_generation = @joinAuthorityGeneration`,
            { workerId, joinAuthorityGeneration: secondIssued.authority.joinAuthorityGeneration },
          ),
          1,
          "the winning revoke must commit exactly one revocation row",
        );

        // A stale post-revoke settlement is rejected by the same fence before
        // any terminal write.
        assert.throws(
          () =>
            h.assignments.settleAssignment(
              {
                registryWorkspaceId: "default",
                assignmentId: assignmentB.assignmentId,
                expectedAssignmentGeneration: 1,
                expectedLeaseRevision: 1,
                leaseTokenSha256: leaseB1,
                outcome: "failed",
                origin: "worker",
                finalEventSequence: 0,
                finalEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
                failureSha256: D(`${suffix}:beta:failure`),
                idempotencyKey: `${suffix}:beta:settle`,
              },
              rotatedFence,
            ),
          /protected commit authority/u,
        );
        assert.equal(settlementCount(assignmentB.assignmentId), 0);
      } finally {
        await Promise.allSettled(spawnedWorkers);
        setupDb.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );
});

function seedPostgresHarness(db: PostgresSyncDatabaseClient, seed: string) {
  const tasks = new TaskRepository(db);
  const durableRuns = new DurableRunRepository(db);
  const mesh = new MeshRepository(db);
  const nodeAdmissions = new MeshCapabilityNodeAdmissionRepository(db);
  const workerAdmissions = new RemoteWorkerAdmissionRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const now = durableRuns.readDatabaseNow();
  const taskId = `task-${seed}`;
  const durableRunId = `run-${seed}`;
  tasks.create({ title: "PG remote assignment", workspaceId: "default" }, now, { taskId });
  const parentInput = { executionWorkspaceId: "default", durableRunId, taskId } as const;
  const parentContext = buildRemoteWorkerAssignmentParentContext(parentInput);
  const parentContextSha256 = remoteWorkerAssignmentParentContextSha256(parentInput);
  durableRuns.createRun({
    runId: durableRunId,
    workflowKey: "chat.turn.execute",
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    leaseOwnerId: "gateway-a",
    leaseHeartbeatAt: now,
    leaseExpiresAt: FUTURE,
    version: 1,
    startedAt: now,
    now,
    metadata: {
      remoteWorkerAssignmentParentContext: parentContext,
      remoteWorkerAssignmentParentContextSha256: parentContextSha256,
    },
  });
  const bootstrap = workerAdmissions.createBootstrap(bootstrapInput(seed)).record;
  const worker = workerAdmissions.finalizeBootstrapAdmission(finalizeInput(bootstrap, seed));
  const tlsFingerprint = `sha256:${bootstrap.nodeId}`;
  const joinToken = `join:${seed}`;
  mesh.upsertNode({
    nodeId: bootstrap.nodeId,
    transport: "lan",
    status: "online",
    capabilities: [],
    tlsFingerprint,
    joinedAt: now,
    lastSeenAt: now,
  });
  mesh.issueJoinToken(joinToken, FUTURE);
  assert.equal(mesh.consumeJoinToken(joinToken, bootstrap.nodeId, now), true);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(bootstrap.nodeId, joinToken).tokenHash;
  assert.ok(joinTokenSha256);
  const nodeAdmission = nodeAdmissions.admit({
    workspaceId: "default",
    nodeId: bootstrap.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256,
    mtlsRequired: true,
    tlsFingerprint,
    admittedByActorId: "operator-a",
    idempotencyKey: `${seed}:node-admission`,
  });
  const manifest: RemoteWorkerAssignmentManifest = {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    registryWorkspaceId: "default",
    ...parentInput,
    capabilityProfileSha256: D(`${seed}:capability-profile`),
    contextSnapshotSha256: D(`${seed}:context`),
    toolEffectPostureSha256: D(`${seed}:posture`),
    pathJailSha256: D(`${seed}:jail`),
    parentContextSha256,
    requiredCapabilityClasses: ["durable_compute", "gateway_inference"],
    deadlineAt: FUTURE,
    leaseTtlSeconds: 60,
    maxEventCount: 100,
    maxEventBytes: 4_096,
    eventLowWatermark: 2,
    eventHighWatermark: 5,
    maxOutputBytes: 131_072,
    maxArtifactBytes: 1_048_576,
  };
  const assignment = assignments.createAssignment({
    manifest,
    createdByActorId: "gateway-a",
    idempotencyKey: `${seed}:assignment`,
  }).assignment;
  const startInput = {
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    nodeId: bootstrap.nodeId,
    nodeAdmissionGeneration: nodeAdmission.admissionGeneration,
    dispatchOwnerId: "gateway-a",
    durableRunAttempt: 1,
    leaseTokenSha256: D(`${seed}:lease:1`),
    idempotencyKey: `${seed}:generation:1`,
  } as const;
  return {
    durableRuns,
    workerAdmissions,
    assignments,
    worker,
    nodeAdmission,
    durableRunId,
    taskId,
    manifest,
    assignmentId: assignment.assignmentId,
    startInput,
  };
}

function assertDirectPostgresManifestRejected(
  db: PostgresSyncDatabaseClient,
  h: ReturnType<typeof seedPostgresHarness>,
  seed: string,
  manifestJson: string,
): void {
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO remote_worker_assignments (
           registry_workspace_id, assignment_id, execution_workspace_id, durable_run_id, task_id,
           session_id, turn_id, manifest_json, manifest_sha256, created_by_actor_id,
           idempotency_key, request_sha256, created_at
         ) VALUES (
           'default', @directAssignmentId, 'default', @durableRunId, @taskId,
           NULL, NULL, @manifestJson, @manifestSha256, 'gateway-a',
           @idempotencyKey, @requestSha256, @createdAt
         )`,
      )
      .run({
        directAssignmentId: `assignment-${seed}`,
        durableRunId: h.durableRunId,
        taskId: h.taskId,
        manifestJson,
        manifestSha256: D(manifestJson),
        idempotencyKey: `assignment:${seed}`,
        requestSha256: D(`assignment:${seed}`),
        createdAt: h.durableRuns.readDatabaseNow(),
      }),
  );
}

function assertDirectPostgresEventRejected(
  db: PostgresSyncDatabaseClient,
  h: ReturnType<typeof seedPostgresHarness>,
  previousEventSha256: string,
  seed: string,
  eventType: RemoteWorkerAssignmentEventInput["eventType"],
  payload: Record<string, unknown> | string,
  workerSentThrough = 5,
): void {
  const payloadJson = typeof payload === "string" ? payload : JSON.stringify(payload);
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO remote_worker_assignment_events (
           registry_workspace_id, assignment_id, assignment_generation, sequence, event_id,
           event_type, payload_json, payload_sha256, previous_event_sha256, event_sha256,
           worker_sent_through, received_at
         ) VALUES (
           'default', @assignmentId, 1, 2, @eventId, @eventType, @payloadJson, @payloadSha256,
           @previousEventSha256, @eventSha256, @workerSentThrough, @receivedAt
         )`,
      )
      .run({
        assignmentId: h.assignmentId,
        eventId: `direct-invalid-${seed}`,
        eventType,
        payloadJson,
        payloadSha256: D(`payload:${seed}`),
        previousEventSha256,
        eventSha256: D(`event:${seed}`),
        workerSentThrough,
        receivedAt: h.durableRuns.readDatabaseNow(),
      }),
  );
}

function finalizeInput(
  bootstrap: ReturnType<RemoteWorkerAdmissionRepository["createBootstrap"]>["record"],
  seed: string,
): FinalizeRemoteWorkerBootstrapAdmissionCommand {
  return {
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: D(`${seed}:spki`),
    verifiedClientCertificateSha256: D(`${seed}:certificate`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: D(`${seed}:anchor`),
    verifiedTransportReceiptSha256: D(`${seed}:transport`),
    verifiedProofOfPossessionReceiptSha256: D(`${seed}:pop`),
    verifiedDownloadReceiptSha256: D(`${seed}:download`),
    verifiedInstalledTreeAttestationSha256: D(`${seed}:attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${seed}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${seed}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${seed}:credential`),
    exchangeIdempotencyKey: `${seed}:exchange`,
  };
}

function statusEvent(
  sequence: number,
  previousEventSha256: string,
  workerSentThrough: number,
): RemoteWorkerAssignmentEventInput {
  return {
    sequence,
    eventId: `status-${sequence}`,
    eventType: "status",
    payload: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      phase: "running",
      statusSha256: D(`status:${sequence}`),
    },
    previousEventSha256,
    workerSentThrough,
  };
}

type WorkerResult = { ok: true; value: Record<string, any> } | { ok: false; error: string };
type WorkerMessage = { kind: "ready" } | { kind: "result"; result: WorkerResult };

async function waitForParentTaskShareLock(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity activity
         WHERE activity.application_name = $1
           AND activity.wait_event_type = 'Lock'
           AND position('SELECT workspace_id, deleted_at FROM tasks' IN activity.query) > 0
           AND position('FOR SHARE' IN activity.query) > 0
       ) AS waiting`,
      [applicationName],
    );
    if (state.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${applicationName} to block on the repository task FOR SHARE lock`);
}

function runAssignmentWorker(
  connectionString: string,
  database: string,
  applicationName: string,
  input: unknown,
): { ready: Promise<void>; result: Promise<WorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(ASSIGNMENT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      input,
      repositoryModuleUrl: new URL(`./remote-worker-assignment-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let readyReceived = false;
  let resultReceived = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (result: WorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: WorkerMessage) => {
    if (message.kind === "ready") {
      readyReceived = true;
      resolveReady();
      return;
    }
    resultReceived = true;
    if (!readyReceived) rejectReady(new Error("HX-502/HX-504 assignment worker reported before its ready barrier"));
    resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    const error = new Error(`HX-502/HX-504 assignment worker exited before reporting (${code})`);
    if (!readyReceived) rejectReady(error);
    if (!resultReceived) rejectResult(error);
  });
  return { ready, result };
}

const ASSIGNMENT_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    let result;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { RemoteWorkerAssignmentRepository } = await tsImport(
        workerData.repositoryModuleUrl,
        workerData.repositoryModuleUrl,
      );
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      parentPort.postMessage({ kind: "ready" });
      result = { ok: true, value: new RemoteWorkerAssignmentRepository(db).appendEvents(workerData.input) };
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : "opaque assignment failure" };
    } finally {
      if (db) db.close();
    }
    parentPort.postMessage({ kind: "result", result });
  })();
`;

// ---------------------------------------------------------------------------
// M3 live-contention fixture: the full protected-provenance authority chain
// (protected bootstrap evidence -> M2 credential -> M3 join authority ->
// nonce-consumed admission -> current mesh fence) that lets the complete
// routes 2-6 protected commit fence PASS against live PostgreSQL, plus the
// advisory-lock race harness that queues real concurrent transactions on the
// owner's canonical locks.
// ---------------------------------------------------------------------------

function countRows(db: PostgresSyncDatabaseClient, sql: string, params: Record<string, unknown>): number {
  return Number(db.prepare(sql).get<{ count: number | bigint }>(params)?.count ?? 0);
}

interface HeldAdvisoryLock {
  release(): Promise<void>;
}

/**
 * Holds one of the assignment owner's canonical pg_advisory_xact_lock keys in
 * an open raw transaction so fenced repository transactions queue behind it.
 * `release()` commits and returns the connection; it is idempotent so a phase
 * can release inside its body and again in its finally block.
 */
async function holdAdvisoryLock(pool: Pool, namespace: 411 | 412, key: string): Promise<HeldAdvisoryLock> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, ${namespace})) AS locked`, [key]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw error;
  }
  let settled = false;
  return {
    release: async () => {
      if (settled) return;
      settled = true;
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
  };
}

async function isWaitingOnAdvisoryLock(pool: Pool, applicationName: string, lockLiteral: string): Promise<boolean> {
  const state = await pool.query<{ waiting: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_stat_activity activity
       WHERE activity.application_name = $1
         AND activity.wait_event_type = 'Lock'
         AND activity.wait_event = 'advisory'
         AND position($2 IN activity.query) > 0
     ) AS waiting`,
    [applicationName, lockLiteral],
  );
  return state.rows[0]?.waiting === true;
}

async function waitForAdvisoryLockWait(pool: Pool, applicationName: string, lockLiteral: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isWaitingOnAdvisoryLock(pool, applicationName, lockLiteral)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${applicationName} to block on the "${lockLiteral}" advisory lock`);
}

interface FencedRepositoryWorkerRequest {
  readonly repositoryModule:
    | "remote-worker-assignment-repo"
    | "remote-worker-mesh-node-admission-repo"
    | "remote-worker-cell-provisioning-repo"
    | "remote-worker-cell-capacity-admission-repo";
  readonly repositoryExport:
    | "RemoteWorkerAssignmentRepository"
    | "RemoteWorkerMeshNodeAdmissionRepository"
    | "RemoteWorkerCellProvisioningRepository"
    | "RemoteWorkerCellCapacityAdmissionRepository";
  readonly operation: string;
  readonly args: readonly unknown[];
}

interface FencedRepositoryWorker {
  ready: Promise<void>;
  result: Promise<WorkerResult>;
}

function runFencedRepositoryWorker(
  connectionString: string,
  database: string,
  applicationName: string,
  request: FencedRepositoryWorkerRequest,
): FencedRepositoryWorker {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(FENCED_REPOSITORY_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      repositoryExport: request.repositoryExport,
      operation: request.operation,
      args: request.args,
      repositoryModuleUrl: new URL(`./${request.repositoryModule}${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let readyReceived = false;
  let resultReceived = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (result: WorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: WorkerMessage) => {
    if (message.kind === "ready") {
      readyReceived = true;
      resolveReady();
      return;
    }
    resultReceived = true;
    if (!readyReceived) rejectReady(new Error("M3 fenced repository worker reported before its ready barrier"));
    resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    const error = new Error(`M3 fenced repository worker exited before reporting (${code})`);
    if (!readyReceived) rejectReady(error);
    if (!resultReceived) rejectResult(error);
  });
  return { ready, result };
}

const FENCED_REPOSITORY_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    let result;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const repositoryModule = await tsImport(workerData.repositoryModuleUrl, workerData.repositoryModuleUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      const repository = new repositoryModule[workerData.repositoryExport](db);
      parentPort.postMessage({ kind: "ready" });
      const value = repository[workerData.operation](...workerData.args);
      result = { ok: true, value: value === undefined ? null : value };
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : "opaque fenced repository failure" };
    } finally {
      if (db) db.close();
    }
    parentPort.postMessage({ kind: "result", result });
  })();
`;
