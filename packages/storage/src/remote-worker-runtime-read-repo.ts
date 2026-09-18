import {
  ConflictError,
  REMOTE_WORKER_ASSIGNMENT_RUNTIME_SCHEMA_VERSION,
  normalizeRemoteWorkerAssignmentRuntime,
  normalizeRemoteWorkerRuntimeReadKey,
  type RemoteWorkerAssignmentRuntime,
  type RemoteWorkerCellRuntimeProjection,
  type RemoteWorkerRuntimeReadKey,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ModelUsageEventRepository } from "./model-usage-event-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerNonceRepository } from "./remote-worker-nonce-repo.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import type { RemoteWorkerRuntimeOutputArtifact } from "@goatcitadel/contracts";
import { RemoteWorkerNativeFileReceiptRepository } from "./remote-worker-native-file-receipt-repo.js";

interface AssignmentHead {
  manifest_sha256: string;
  assignment_generation: number | null;
  worker_id: string | null;
  worker_generation: number | null;
}

const SCOPE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration";
const INFERENCE_SCOPE = "i.registry_workspace_id = @registryWorkspaceId AND i.assignment_id = @assignmentId AND i.assignment_generation = @assignmentGeneration";

/** Bounded, read-only projections from retained owners. These observations do not
 * establish process liveness or authorize execution. Concurrent owner updates may
 * appear on the next read, but assignment generations must never be combined. */
export class RemoteWorkerRuntimeReadRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public readNativeOutputArtifact(input: RemoteWorkerRuntimeReadKey & { assignmentGeneration: number; nonce: string }): RemoteWorkerRuntimeOutputArtifact | null {
    return new RemoteWorkerRuntimeResultRepository(this.db).readOutputArtifactForOperator(input);
  }

  public findAssignmentRuntime(input: RemoteWorkerRuntimeReadKey): RemoteWorkerAssignmentRuntime | undefined {
    const key = normalizeRemoteWorkerRuntimeReadKey(input);
    const head = this.readHead(key);
    if (!head) return undefined;
    const generation = head.assignment_generation === null ? null : Number(head.assignment_generation);
    const workerGeneration = head.worker_generation === null ? null : Number(head.worker_generation);
    const scope = { ...key, assignmentGeneration: generation };
    let usageAndCost: RemoteWorkerAssignmentRuntime["usageAndCost"]["value"] = null;
    let resourceCell: RemoteWorkerCellRuntimeProjection | null = null;
    let artifactAndEffects: RemoteWorkerAssignmentRuntime["artifactAndEffects"]["value"] = null;
    let contact: RemoteWorkerAssignmentRuntime["connectionHealth"]["value"] = null;
    if (generation !== null) {
      if (head.worker_id === null || workerGeneration === null) throw new ConflictError({ message: "Remote worker assignment identity is unavailable." });
      contact = new RemoteWorkerNonceRepository(this.db).readContact({ registryWorkspaceId: key.registryWorkspaceId, workerId: head.worker_id, workerGeneration });
      // A reservation can be committed before the inference request attaches its
      // receipt. Join its canonical operation/generation, never the optional receipt.
      const holds = this.db.prepare(`SELECT COUNT(*) AS pending, COALESCE(SUM(requests), 0) AS requests,
        COALESCE(SUM(cost), 0) AS cost FROM (
          SELECT r.reserved_requests AS requests, r.reserved_cost_microusd AS cost
            FROM remote_worker_budget_reservations r
            JOIN remote_worker_inference_requests i ON i.operation_id = r.operation_id AND i.dispatch_generation = r.dispatch_generation
            WHERE ${INFERENCE_SCOPE} AND r.status = 'held'
          UNION ALL
          SELECT 1 AS requests, d.reserved_cost_microusd AS cost FROM remote_worker_budget_dispatches d
            JOIN remote_worker_budget_reservations r ON r.reservation_id = d.parent_reservation_id
            JOIN remote_worker_inference_requests i ON i.operation_id = r.operation_id AND i.dispatch_generation = r.dispatch_generation
            WHERE ${INFERENCE_SCOPE} AND d.status = 'held'
          UNION ALL
          SELECT 1 AS requests, reserved_cost_microusd AS cost FROM remote_worker_tool_budget_dispatches
            WHERE ${SCOPE} AND status = 'held'
        ) held`).get<{ pending: number; requests: number; cost: number }>(scope)!;
      usageAndCost = {
        usage: ModelUsageEventRepository.summarizeRemoteWorkerAssignment(this.db, key.registryWorkspaceId, key.assignmentId, generation),
        pendingReservations: Number(holds.pending), reservedRequests: Number(holds.requests), reservedCostMicrousd: Number(holds.cost),
      };
      const cell = new RemoteWorkerCellRepository(this.db).getCell({ ...key, assignmentGeneration: generation });
      if (cell) {
        if (cell.workerId !== head.worker_id || cell.workerGeneration !== workerGeneration) throw new ConflictError({ message: "Remote worker cell binding changed. Refresh the assignment." });
        resourceCell = {
          cellId: cell.cellId, backend: cell.backend,
          executionState: cell.executionState, executionRevision: cell.executionRevision,
          cleanupState: cell.cleanupState, cleanupRevision: cell.cleanupRevision,
          backupState: cell.backupState, backupRevision: cell.backupRevision, capacity: cell.capacity,
          peakDiskBytes: cell.peakDiskBytes, peakMemoryBytes: cell.peakMemoryBytes,
          peakFileCount: cell.peakFileCount, peakProcessCount: cell.peakProcessCount,
          retainedDiagnosticBytes: cell.retainedDiagnosticBytes, failedCleanupRetainedBytes: cell.failedCleanupRetainedBytes,
          quarantineRetainedBytes: cell.quarantineRetainedBytes, updatedAt: cell.updatedAt,
        };
      }
      const artifacts = this.db.prepare(`SELECT COUNT(*) AS uploads,
        COALESCE(SUM(CASE WHEN upload_state = 'committed' THEN 1 ELSE 0 END), 0) AS committed,
        COALESCE(SUM(CASE WHEN upload_state = 'quarantined' THEN 1 ELSE 0 END), 0) AS quarantined,
        COALESCE(SUM(CASE WHEN cleanup_state IN ('pending', 'manual_reconciliation') THEN 1 ELSE 0 END), 0) AS cleanup_pending,
        MAX(m.file_count) AS file_count, MAX(m.total_bytes) AS total_bytes,
        MAX(CASE WHEN m.manifest_id IS NOT NULL THEN u.verification_gate_state END) AS verification
        FROM remote_worker_artifact_uploads u
        LEFT JOIN remote_worker_artifact_manifests m
          ON m.registry_workspace_id = u.registry_workspace_id AND m.assignment_id = u.assignment_id
          AND m.assignment_generation = u.assignment_generation AND m.upload_id = u.upload_id
          AND u.upload_state = 'committed' AND m.manifest_sha256 = u.committed_manifest_sha256
        WHERE u.registry_workspace_id = @registryWorkspaceId AND u.assignment_id = @assignmentId
          AND u.assignment_generation = @assignmentGeneration`)
        .get<{ uploads: number; committed: number; quarantined: number; cleanup_pending: number;
          file_count: number | null; total_bytes: number | null; verification: "not_required" | "pending" | "satisfied" | null }>(scope)!;
      const effects = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM remote_worker_effect_intents WHERE ${SCOPE}) AS intents,
        (SELECT COUNT(*) FROM remote_worker_effect_receipts WHERE ${SCOPE}) AS receipts,
        (SELECT COUNT(*) FROM remote_worker_effect_receipts WHERE ${SCOPE} AND receipt_state = 'manual_reconciliation') AS reconciliation`)
        .get<{ intents: number; receipts: number; reconciliation: number }>(scope)!;
      artifactAndEffects = {
        nativeOutputArtifacts: new RemoteWorkerRuntimeResultRepository(this.db).listOutputArtifactNoncesForOperator({ ...key, assignmentGeneration: generation }),
        nativeFileArtifacts: new RemoteWorkerNativeFileReceiptRepository(this.db).listReceiptNoncesForOperator({ ...key, assignmentGeneration: generation }),
        uploadCount: Number(artifacts.uploads), committedUploadCount: Number(artifacts.committed),
        quarantinedUploadCount: Number(artifacts.quarantined), cleanupPendingCount: Number(artifacts.cleanup_pending),
        manifestFileCount: artifacts.file_count === null ? null : Number(artifacts.file_count),
        manifestTotalBytes: artifacts.total_bytes === null ? null : Number(artifacts.total_bytes), verificationState: artifacts.verification,
        effectIntentCount: Number(effects.intents), effectReceiptCount: Number(effects.receipts), effectReconciliationCount: Number(effects.reconciliation),
      };
    }
    const current = this.readHead(key);
    if (!current || current.manifest_sha256 !== head.manifest_sha256 || current.assignment_generation !== head.assignment_generation ||
      current.worker_id !== head.worker_id || current.worker_generation !== head.worker_generation) {
      throw new ConflictError({ message: "Remote worker assignment generation changed. Refresh the assignment." });
    }
    const observedAt = new Date().toISOString();
    return normalizeRemoteWorkerAssignmentRuntime({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_RUNTIME_SCHEMA_VERSION, readOnly: true, mutationSemantics: "none",
      workspaceId: key.registryWorkspaceId, assignmentId: key.assignmentId,
      assignmentGeneration: generation, workerId: head.worker_id, workerGeneration, observedAt,
      usageAndCost: { value: usageAndCost, owner: "storage.remoteWorkerRuntimeReads", authorityClass: "derived_projection", observedAt },
      resourceCell: { value: resourceCell, owner: "storage.remoteWorkerCells", authorityClass: "canonical_record", observedAt },
      artifactAndEffects: { value: artifactAndEffects, owner: "storage.remoteWorkerRuntimeReads", authorityClass: "derived_projection", observedAt },
      connectionHealth: contact === null
        ? { value: null, owner: "gateway.remoteWorkerListener", authorityClass: "unavailable", observedAt }
        : { value: contact, owner: "storage.remoteWorkerNonces", authorityClass: "derived_projection", observedAt },
    });
  }

  private readHead(key: RemoteWorkerRuntimeReadKey): AssignmentHead | undefined {
    return this.db.prepare(`SELECT a.manifest_sha256, g.assignment_generation, g.worker_id, g.worker_generation
      FROM remote_worker_assignments a LEFT JOIN remote_worker_assignment_generations g
        ON g.registry_workspace_id = a.registry_workspace_id AND g.assignment_id = a.assignment_id
        AND g.assignment_generation = (SELECT MAX(cg.assignment_generation) FROM remote_worker_assignment_generations cg
          WHERE cg.registry_workspace_id = a.registry_workspace_id AND cg.assignment_id = a.assignment_id)
      WHERE a.registry_workspace_id = @registryWorkspaceId AND a.assignment_id = @assignmentId`).get<AssignmentHead>({ ...key });
  }
}
