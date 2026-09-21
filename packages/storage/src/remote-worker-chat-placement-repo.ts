import {
  ConflictError,
  normalizeRemoteWorkerInferenceOperationIdentifier,
  readDurableChatTurnExecutionPayloadAuthority,
  remoteWorkerInferenceCanonicalSha256,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";

export interface ChatExecutionPlacement {
  readonly durableRunId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly payloadSha256: string;
  readonly executionKind: "local" | "remote_worker";
  readonly registryWorkspaceId?: string;
  readonly assignmentId?: string;
  readonly createdAt: string;
}

export type ChatExecutionPlacementClaim = Pick<DurableRunRecord, "runId" | "leaseOwnerId" | "attemptCount">;

interface PlacementRow {
  durable_run_id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string;
  payload_sha256: string;
  execution_kind: "local" | "remote_worker";
  registry_workspace_id: string | null;
  assignment_id: string | null;
  created_at: string;
}

/** A turn selects one execution location before starting its first runner.
 * The current durable lease still governs every attempt and write afterward. */
export class RemoteWorkerChatPlacementRepository {
  constructor(private readonly db: DatabaseClient) {}

  public get(runId: string): ChatExecutionPlacement | undefined {
    const row = this.db
      .prepare("SELECT * FROM chat_execution_placements WHERE durable_run_id = ?")
      .get<PlacementRow>(id(runId));
    return row
      ? {
          durableRunId: row.durable_run_id,
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          payloadSha256: row.payload_sha256,
          executionKind: row.execution_kind,
          createdAt: row.created_at,
          ...(row.registry_workspace_id ? { registryWorkspaceId: row.registry_workspace_id } : {}),
          ...(row.assignment_id ? { assignmentId: row.assignment_id } : {}),
        }
      : undefined;
  }

  /** Existing worker assignments take precedence, including those admitted
   * before this ledger existed. Recovery never changes an existing choice. */
  public claimLocal(claim: ChatExecutionPlacementClaim): ChatExecutionPlacement {
    return this.claim(claim);
  }

  /** The offer owner calls this in the same transaction as assignment creation. */
  public claimRemote(
    claim: ChatExecutionPlacementClaim,
    registryWorkspaceId: string,
    assignmentId: string,
  ): ChatExecutionPlacement {
    return this.claim(claim, { registryWorkspaceId: id(registryWorkspaceId), assignmentId: id(assignmentId) });
  }

  /** Called with the parent run locked, even for direct/legacy offer creation. */
  public assertRemoteAllowed(runId: string, registryWorkspaceId: string, assignmentId: string): void {
    const current = this.get(runId);
    if (
      current &&
      (current.executionKind !== "remote_worker" ||
        current.registryWorkspaceId !== registryWorkspaceId ||
        current.assignmentId !== assignmentId)
    )
      throw conflict("Chat execution already belongs to another runner.");
  }

  private claim(
    claim: ChatExecutionPlacementClaim,
    requested?: {
      registryWorkspaceId: string;
      assignmentId: string;
    },
  ): ChatExecutionPlacement {
    return this.db.transaction("immediate", () => {
      const runs = new DurableRunRepository(this.db);
      const observed = runs.getRun(id(claim.runId));
      const payload = readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: observed.workflowKey,
        durableRunId: observed.runId,
        payload: observed.payload,
      });
      if (!payload || !claim.leaseOwnerId) throw conflict("Chat placement requires an admitted durable execution.");
      // Same roots/order as offer creation and worker claim. Heartbeats may
      // advance the run version, but another lease owner/attempt cannot choose.
      if (this.db.dialect === "postgres") {
        for (const key of [...new Set([payload.sessionId, payload.workspaceId])].sort()) {
          this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@key, 411)) AS locked").get({ key });
        }
      }
      new SessionMutationAdmissionRepository(this.db).assertActiveTurnWrite({
        admissionId: payload.admissionId,
        sessionIncarnationId: payload.sessionIncarnationId,
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        durableClaim: {
          durableRunId: observed.runId,
          leaseOwnerId: claim.leaseOwnerId,
          attemptCount: claim.attemptCount,
        },
        requireExactDurablePayloadIdentity: true,
      });
      const run = runs.lockFreshActiveLeaseForUpdate(observed.runId, claim.leaseOwnerId);
      if (
        !run ||
        run.attemptCount !== claim.attemptCount ||
        remoteWorkerInferenceCanonicalSha256(run.payload) !== remoteWorkerInferenceCanonicalSha256(observed.payload)
      )
        throw conflict("Chat placement lost its active execution claim.");
      // User-input answers extend a turn through immutable continuation seals;
      // they do not select another runner. The admission check above validates
      // every response against those seals before excluding them from identity.
      const { userInputResponses, ...admittedPayload } = run.payload;
      const identity = {
        durableRunId: run.runId,
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        payloadSha256: remoteWorkerInferenceCanonicalSha256(admittedPayload),
      };
      const existing = this.get(run.runId);
      if (existing) {
        // Older ledgers hashed the full payload. Accept only a prefix of the
        // now-verified continuation set, retaining every other payload byte.
        const compatibleHashes = new Set([identity.payloadSha256]);
        if (Array.isArray(userInputResponses)) {
          for (let count = 0; count <= userInputResponses.length; count++) {
            compatibleHashes.add(
              remoteWorkerInferenceCanonicalSha256({
                ...admittedPayload,
                userInputResponses: userInputResponses.slice(0, count),
              }),
            );
          }
        }
        if (
          Object.entries(identity).some(([key, value]) =>
            key === "payloadSha256"
              ? !compatibleHashes.has(existing.payloadSha256)
              : existing[key as keyof ChatExecutionPlacement] !== value,
          )
        )
          throw conflict("Chat execution placement differs from its admitted identity.");
        if (requested) this.assertRemoteAllowed(run.runId, requested.registryWorkspaceId, requested.assignmentId);
        return existing;
      }
      const assignments = this.db
        .prepare(
          `SELECT registry_workspace_id, assignment_id, execution_workspace_id,
        session_id, turn_id FROM remote_worker_assignments WHERE durable_run_id = ? LIMIT 2`,
        )
        .all<{
          registry_workspace_id: string;
          assignment_id: string;
          execution_workspace_id: string;
          session_id: string | null;
          turn_id: string | null;
        }>(run.runId);
      if (assignments.length > 1) throw conflict("Chat has multiple existing worker assignments.");
      const assignment = assignments[0];
      if (
        assignment &&
        (assignment.execution_workspace_id !== identity.workspaceId ||
          assignment.session_id !== identity.sessionId ||
          assignment.turn_id !== identity.turnId)
      )
        throw conflict("Chat worker assignment belongs to another scope.");
      if (
        requested &&
        (!assignment ||
          assignment.registry_workspace_id !== requested.registryWorkspaceId ||
          assignment.assignment_id !== requested.assignmentId)
      )
        throw conflict("Chat placement requires its exact persisted worker assignment.");
      this.db
        .prepare(
          `INSERT INTO chat_execution_placements
        (durable_run_id, workspace_id, session_id, turn_id, payload_sha256, execution_kind,
         registry_workspace_id, assignment_id, created_at)
        VALUES (@durableRunId, @workspaceId, @sessionId, @turnId, @payloadSha256, @executionKind,
          @registryWorkspaceId, @assignmentId, @createdAt)`,
        )
        .run({
          ...identity,
          executionKind: assignment ? "remote_worker" : "local",
          registryWorkspaceId: assignment?.registry_workspace_id ?? null,
          assignmentId: assignment?.assignment_id ?? null,
          createdAt: new Date().toISOString(),
        });
      return this.get(run.runId)!;
    });
  }
}

const id = (value: string) => normalizeRemoteWorkerInferenceOperationIdentifier(value, "Chat placement identity");
const conflict = (message: string) => new ConflictError({ message });
