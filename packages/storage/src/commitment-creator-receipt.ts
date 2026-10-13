import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  readDurableChatTurnExecutionPayloadAuthority,
  type CommitmentCreatorReceipt,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export function commitmentSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}

/** A classifier may supply only a source pointer. Actor/profile evidence comes from the admitted durable owner. */
export function readCommitmentCreatorReceipt(
  db: DatabaseClient,
  input: {
    sourceTurnId?: string;
    sessionId: string;
    workspaceId: string;
  },
): CommitmentCreatorReceipt | undefined {
  if (!input.sourceTurnId) return undefined;
  const row = db
    .prepare(
      `
    SELECT a.*, d.durable_run_id, r.workflow_key, r.payload_json
    FROM chat_turn_session_incarnation_bindings b
    JOIN chat_session_mutation_admissions a ON a.admission_id = b.admission_id
    JOIN chat_turn_mutation_admission_durable_bindings d ON d.admission_id = a.admission_id
    JOIN durable_runs r ON r.run_id = d.durable_run_id
    WHERE b.turn_id = @sourceTurnId AND b.session_id = @sessionId AND b.workspace_id = @workspaceId
      AND a.turn_id = b.turn_id AND a.session_id = b.session_id AND a.workspace_id = b.workspace_id
      AND a.session_incarnation_id = b.session_incarnation_id AND a.admission_kind = 'turn_write'
      AND a.status <> 'cancelled' AND a.actor_kind = 'operator'
      AND d.turn_id = b.turn_id AND d.session_id = b.session_id AND d.workspace_id = b.workspace_id
      AND d.session_incarnation_id = b.session_incarnation_id AND r.status = 'completed'
  `,
    )
    .get<Record<string, unknown>>({
      sourceTurnId: input.sourceTurnId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    });
  if (!row || typeof row.payload_json !== "string") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload_json);
  } catch {
    return undefined;
  }
  const payload = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: row.workflow_key,
    durableRunId: row.durable_run_id,
    payload: raw,
  });
  if (
    !payload ||
    payload.turnId !== input.sourceTurnId ||
    payload.sessionId !== input.sessionId ||
    payload.workspaceId !== input.workspaceId ||
    payload.admissionId !== row.admission_id ||
    payload.sessionIncarnationId !== row.session_incarnation_id ||
    payload.admissionMaterialSha256 !== row.material_sha256 ||
    payload.admissionAggregateRevision !== Number(row.aggregate_revision) ||
    payload.admissionControllerGeneration !== Number(row.controller_generation) ||
    payload.requestActor.actorKind !== "operator" ||
    payload.requestActor.actorId !== row.actor_id
  )
    return undefined;
  const policy = payload.request.policyContext;
  const policyId =
    policy && typeof policy === "object" ? (policy as Record<string, unknown>).permissionProfileId : undefined;
  const profileId = payload.request.permissionProfileId ?? policyId;
  if (typeof profileId !== "string" || !profileId.trim() || profileId.length > 256) return undefined;
  if (typeof policyId === "string" && policyId !== profileId) return undefined;
  return {
    version: "commitment.creator.v1",
    sourceTurnId: payload.turnId,
    admissionId: payload.admissionId,
    sessionIncarnationId: payload.sessionIncarnationId,
    durableRunId: String(row.durable_run_id),
    admissionMaterialSha256: payload.admissionMaterialSha256,
    actorId: payload.requestActor.actorId,
    permissionProfileId: profileId,
  };
}
