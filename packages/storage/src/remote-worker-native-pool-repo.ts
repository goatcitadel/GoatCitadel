import { canonicalJsonString, normalizeRemoteWorkerCellProvisioningHistory, normalizeRemoteWorkerNativePoolSnapshot,
  remoteWorkerCellCanonicalSha256, REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION,
  createRemoteWorkerNativePoolPage, normalizeRemoteWorkerNativePoolPageSubmission,
  type RemoteWorkerNativePoolPageSubmission } from "@goatcitadel/contracts";
import { normalizeRemoteWorkerNativePoolCleanupSnapshot, REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION,
  REMOTE_WORKER_NATIVE_POOL_MAXIMUM_RUNTIME_ATTEMPTS, createRemoteWorkerNativePoolCleanupPage,
  normalizeRemoteWorkerNativePoolCleanupPageSubmission, type RemoteWorkerNativePoolCleanupPageSubmission } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { snapshotRemoteWorkerCellCapacityAuthority, type RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { RemoteWorkerCellConflictError, RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerCellProvisioningRepository } from "./remote-worker-cell-provisioning-repo.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { RemoteWorkerRuntimeInstallRepository } from "./remote-worker-runtime-install-repo.js";

const conflict = () => new RemoteWorkerCellConflictError("Native pool lookup lost its protected assignment or retained membership.");

/** Internal metadata read under current protected assignment authority. The
 * worker scope is derived from the lease, never supplied separately. This is
 * neither execution authority nor a durable pool reservation: native capture
 * must still hold writer exclusion and verify exact physical membership. */
export class RemoteWorkerNativePoolRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public readPageForAssignment(input: RemoteWorkerCellCapacityAuthority & { readonly submission: RemoteWorkerNativePoolPageSubmission }) {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input);
    const submission = normalizeRemoteWorkerNativePoolPageSubmission(input.submission);
    return createRemoteWorkerNativePoolPage(this.readSnapshotForAssignment(command), submission);
  }
  public readCleanupPageForAssignment(input: RemoteWorkerCellCapacityAuthority & { readonly submission: RemoteWorkerNativePoolCleanupPageSubmission }) {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input);
    const submission = normalizeRemoteWorkerNativePoolCleanupPageSubmission(input.submission);
    return createRemoteWorkerNativePoolCleanupPage(this.readCleanupForAssignment(command), submission);
  }

  /** Complete historical writer coverage for every retained member, including
   * older worker/assignment generations. Current authority belongs only to the
   * requesting lease; no historical member receives a fabricated live lease.
   * Local reconciliation and writer exclusion are still required for capture. */
  public readCleanupForAssignment(input: RemoteWorkerCellCapacityAuthority) {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input);
    return this.db.transaction("immediate", () => {
      const retained = this.readForAssignment(command), pool = this.readSnapshotForAssignment(command);
      const runtimes = new RemoteWorkerRuntimeResultRepository(this.db), installations = new RemoteWorkerRuntimeInstallRepository(this.db);
      const read = () => {
        let total = 0;
        return Object.freeze(pool.members.map(member => {
          const scope = { registryWorkspaceId: pool.registryWorkspaceId, assignmentId: member.assignmentId, assignmentGeneration: member.assignmentGeneration };
          const expectations = runtimes.readRetainedCleanupForPool(scope, member.history);
          total += expectations.length;
          if (total > REMOTE_WORKER_NATIVE_POOL_MAXIMUM_RUNTIME_ATTEMPTS) throw conflict(); // Refuse, never truncate a complete pool.
          return Object.freeze({ ...scope, expectations, installation: installations.readRetainedCleanupForPool(scope, member.history) });
        }));
      };
      const members = read();
      if (canonicalJsonString(this.readForAssignment(command)) !== canonicalJsonString(retained) ||
          canonicalJsonString(read()) !== canonicalJsonString(members)) throw conflict();
      this.readForAssignment(command);
      return normalizeRemoteWorkerNativePoolCleanupSnapshot({ schemaVersion: REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION, pool, members });
    });
  }

  /** Credential-free transport projection. Older members carry resource
   * history, never a fabricated active lease or provisioning owner. */
  public readSnapshotForAssignment(input: RemoteWorkerCellCapacityAuthority) {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input);
    return this.db.transaction("immediate", () => {
      const retained = this.readForAssignment(command);
      const members = retained.members.map(({ cell, provisioning }) => ({
        assignmentId: cell.assignmentId, assignmentGeneration: cell.assignmentGeneration,
        workerGeneration: cell.workerGeneration, cellId: cell.cellId, profileSha256: cell.profileSha256,
        history: provisioning ? normalizeRemoteWorkerCellProvisioningHistory({
          plan: provisioning.plan.plan, planSha256: provisioning.plan.planSha256,
          records: provisioning.checkpoints.map(item => item.recordHex),
          volumeRecords: provisioning.volumeCheckpoints.map(item => item.recordHex),
          formatRecords: provisioning.formatCheckpoints.map(item => item.recordHex),
          protectionRecords: provisioning.protectionCheckpoints.map(item => item.recordHex),
          mountRecords: provisioning.mountCheckpoints.map(item => item.recordHex),
          mountedWorkspaceRecords: provisioning.mountedWorkspaceCheckpoints.map(item => item.recordHex),
        }) : null,
      }));
      const result = normalizeRemoteWorkerNativePoolSnapshot({ schemaVersion: REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION,
        registryWorkspaceId: retained.registryWorkspaceId, assignmentId: command.assignmentId,
        assignmentGeneration: command.assignmentGeneration, leaseRevision: command.leaseRevision,
        workerId: retained.workerId, workerGeneration: retained.workerGeneration,
        members, membershipSha256: remoteWorkerCellCanonicalSha256(members) });
      if (canonicalJsonString(this.readForAssignment(command)) !== canonicalJsonString(retained)) throw conflict();
      return result;
    });
  }

  public readForAssignment(input: RemoteWorkerCellCapacityAuthority) {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input);
    return this.db.transaction("immediate", () => {
      const assignments = new RemoteWorkerAssignmentRepository(this.db);
      const cells = new RemoteWorkerCellRepository(this.db);
      const provisioning = new RemoteWorkerCellProvisioningRepository(this.db);
      const current = () => {
        const resolved = assignments.resolveActiveAuthorityByLeaseTokenHash(command.leaseTokenSha256, command.protectedAuthority);
        if (!resolved || resolved.assignment.registryWorkspaceId !== command.registryWorkspaceId ||
            resolved.assignment.assignmentId !== command.assignmentId || resolved.generation.assignmentGeneration !== command.assignmentGeneration ||
            resolved.lease.leaseRevision !== command.leaseRevision) throw conflict();
        return resolved;
      };
      const authority = current();
      const scope = Object.freeze({ registryWorkspaceId: command.registryWorkspaceId, workerId: authority.generation.workerId });
      const read = () => Object.freeze(cells.listRetainedNativeCellsForWorker(scope).map(cell => Object.freeze({
        cell, provisioning: provisioning.getSnapshot(cell) ?? null,
      })));
      const members = read();
      // Detect changed/incomplete retained data without filtering it away. A
      // missing history is explicit and cannot be treated as a ready member.
      const before = canonicalJsonString(members);
      const latest = current();
      if (latest.generation.workerId !== authority.generation.workerId ||
          latest.generation.workerGeneration !== authority.generation.workerGeneration || canonicalJsonString(read()) !== before) throw conflict();
      current();
      return Object.freeze({ ...scope, workerGeneration: authority.generation.workerGeneration, members });
    });
  }
}
