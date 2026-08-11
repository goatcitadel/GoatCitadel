import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import { readDurableChatTurnExecutionPayloadAuthority } from "./durable-chat-turn-payload.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function canonicalPayload() {
  const durableRunId = "run-task-bound-chat";
  const request = Object.freeze({ content: "Execute the durable task.", policyTaskId: "task-a" });
  const admissionMaterialSha256 = D(canonicalJsonString({ version: 2, request }));
  return {
    durableRunId,
    payload: Object.freeze({
      version: "chat.turn.execute.v2",
      admissionId: "admission-a",
      sessionIncarnationId: "incarnation-a",
      admissionMaterialSha256,
      workspaceId: "workspace-a",
      admissionAggregateRevision: 3,
      admissionControllerGeneration: 2,
      effectiveRequestMaterialSha256: D(canonicalJsonString({ version: 1, admissionMaterialSha256, request })),
      policyRunIdDerivation: Object.freeze({ version: 1, kind: "durable_run_id", runId: durableRunId }),
      requestActor: Object.freeze({ actorKind: "operator", actorId: "operator-a" }),
      sessionId: "session-a",
      turnId: "turn-a",
      userMessageId: "message-user-a",
      assistantMessageId: "message-assistant-a",
      capabilityProfileId: "profile-a",
      capabilityProfileHash: D("profile-a"),
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      request,
    }),
  } as const;
}

describe("durable Chat turn payload authority", () => {
  it("accepts the canonical structural and cryptographic authority", () => {
    const input = canonicalPayload();
    const parsed = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: "chat.turn.execute",
      durableRunId: input.durableRunId,
      payload: input.payload,
    });
    expect(parsed).toBe(input.payload);
  });

  it("rejects the prior minimal remote-workload fixture and the wrong workflow", () => {
    const input = canonicalPayload();
    expect(
      readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: "chat.turn.execute",
        durableRunId: input.durableRunId,
        payload: {
          version: "chat.turn.execute.v2",
          workspaceId: "workspace-a",
          sessionId: "session-a",
          turnId: "turn-a",
          request: { policyTaskId: "task-a", content: "Execute the durable task." },
        },
      }),
    ).toBeUndefined();
    expect(
      readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: "different.workflow",
        durableRunId: input.durableRunId,
        payload: input.payload,
      }),
    ).toBeUndefined();
  });

  it("rejects request-hash drift, caller actor projection, and raw routed context", () => {
    const input = canonicalPayload();
    const read = (payload: Record<string, unknown>) =>
      readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: "chat.turn.execute",
        durableRunId: input.durableRunId,
        payload,
      });
    expect(read({ ...input.payload, admissionMaterialSha256: D("wrong") })).toBeUndefined();
    expect(
      read({ ...input.payload, request: { ...input.payload.request, authActorId: "caller-owned" } }),
    ).toBeUndefined();
    expect(read({ ...input.payload, routedContext: { sourceContent: "raw" } })).toBeUndefined();
  });
});
