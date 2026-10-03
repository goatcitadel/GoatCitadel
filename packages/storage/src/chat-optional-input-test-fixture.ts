import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function createOptionalInputFixture(
  db: DatabaseClient,
  options: {
    actorKind?: "operator" | "system" | "external_companion";
    actorId?: string;
  } = {},
) {
  const workspaceId = "workspace-continuation";
  const sessionId = "session-continuation";
  const turnId = "turn-continuation";
  const runId = "run-continuation";
  const promptId = "prompt-continuation";
  const lifecycle = new ChatSessionLifecycleRepository(db).initialize({
    workspaceId,
    sessionId,
    actorId: "operator-a",
    idempotencyKey: "lifecycle:init:session-continuation",
    correlationId: "correlation:init:session-continuation",
  });
  const actorKind = options.actorKind ?? "operator";
  const actorId = options.actorId ?? (actorKind === "operator" ? "operator-a" : `actor-${actorKind}`);
  const controllerGeneration = 1;
  const request = { content: "Continue after operator input." };
  const materialSha256 = sha256(canonicalJsonString({ version: 2, request }));
  const repo = new SessionMutationAdmissionRepository(db);
  const admitted = repo.admit({
    workspaceId,
    sessionId,
    expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
    turnId,
    runtimeOwnerId: "request-runtime-continuation",
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration,
    actorKind,
    actorId,
    operation: "chat.turn.execute",
    materialSha256,
    idempotencyKey: "admission:continuation",
    correlationId: "correlation:continuation",
  }).admission;
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: admitted.admissionId,
    sessionIncarnationId: admitted.sessionIncarnationId,
    admissionMaterialSha256: materialSha256,
    workspaceId,
    admissionAggregateRevision: 1,
    admissionControllerGeneration: controllerGeneration,
    sessionId,
    turnId,
    userMessageId: "message-continuation",
    assistantMessageId: "assistant-continuation",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId },
    request,
    requestActor: { actorKind, actorId },
    effectiveRequestMaterialSha256: sha256(
      canonicalJsonString({ version: 1, admissionMaterialSha256: materialSha256, request }),
    ),
    userInputResponses: [],
  };
  const pendingPrompt = {
    promptId,
    turnId,
    kind: "text",
    title: "Operator input",
    question: "What should the durable run do next?",
  };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO durable_runs (
       run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
       version, created_at, updated_at
     ) VALUES (
       @runId, 'chat.turn.execute', 'waiting', 0, 3, @payloadJson, @metadataJson,
       2, @now, @now
     )`,
  ).run({
    runId,
    payloadJson: canonicalJsonString(payload),
    metadataJson: canonicalJsonString({
      waitForEvent: { eventKey: "chat.user_input.resolved", correlationId: promptId },
    }),
    now,
  });
  db.prepare(
    `INSERT INTO chat_turn_traces (
       turn_id, session_id, user_message_id, status, mode, web_mode, memory_mode,
       thinking_level, routing_json, pending_user_input_json, durable_json, started_at
     ) VALUES (
       @turnId, @sessionId, 'message-continuation', 'waiting_for_user_input', 'chat',
       'off', 'off', 'standard', '{}', @pendingUserInputJson, @durableJson, @now
     )`,
  ).run({
    turnId,
    sessionId,
    pendingUserInputJson: canonicalJsonString(pendingPrompt),
    durableJson: canonicalJsonString({ runId }),
    now,
  });
  repo.bindDurableRun({
    admissionId: admitted.admissionId,
    sessionIncarnationId: admitted.sessionIncarnationId,
    workspaceId,
    sessionId,
    turnId,
    durableRunId: runId,
    requestRuntimeClaim: {
      runtimeOwnerId: admitted.runtimeOwnerId!,
      leaseRevision: admitted.runtimeLeaseRevision!,
    },
  });
  return {
    repo,
    runId,
    turnId,
    resolution: {
      admissionIdentity: {
        admissionId: admitted.admissionId,
        sessionIncarnationId: admitted.sessionIncarnationId,
        workspaceId,
        sessionId,
        turnId,
        aggregateRevision: 1,
        controllerGeneration,
        materialSha256,
      },
      durableRunId: runId,
      expectedWaitingRunVersion: 2,
      promptId,
      eventKey: "chat.user_input.resolved" as const,
      correlationId: promptId,
      responder: { actorId: "operator-a", authActorSource: "token" as const },
      response: { kind: "text" as const, text: "Proceed with the verified plan." },
    },
  };
}
