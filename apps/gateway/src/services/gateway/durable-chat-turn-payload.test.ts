import type { ChatSendMessageRequest } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { createDurableChatTurnPayload } from "./durable-chat-turn-payload.js";

type Prepared = Parameters<typeof createDurableChatTurnPayload>[0];

const request = { content: "Plan the release" } as ChatSendMessageRequest;

function prepared(overrides: Partial<Record<string, unknown>> = {}): Prepared {
  return {
    turnId: "turn-1",
    userEventId: "user-1",
    assistantMessageId: "assistant-1",
    branchKind: "append",
    session: { sessionId: "session-1" },
    turnAdmission: {
      identity: {
        admissionId: "admission-1",
        sessionIncarnationId: "incarnation-1",
        materialSha256: "a".repeat(64),
        workspaceId: "workspace-1",
        aggregateRevision: 3,
        controllerGeneration: 2,
      },
      admittedRequest: request,
      requestActor: { actorId: "operator" },
    },
    ...overrides,
  } as unknown as Prepared;
}

describe("createDurableChatTurnPayload", () => {
  it("builds the frozen v2 payload and derives the policy run id from the durable run", () => {
    const payload = createDurableChatTurnPayload(prepared(), request, "chat_thread_turn_appended", " run-1 ");

    expect(payload).toMatchObject({
      version: "chat.turn.execute.v2",
      admissionId: "admission-1",
      sessionIncarnationId: "incarnation-1",
      workspaceId: "workspace-1",
      admissionAggregateRevision: 3,
      admissionControllerGeneration: 2,
      sessionId: "session-1",
      turnId: "turn-1",
      threadEventType: "chat_thread_turn_appended",
      policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "run-1" },
      request: { content: "Plan the release" },
    });
    expect(payload.effectiveRequestMaterialSha256).toEqual(expect.any(String));
  });

  it("fails closed without a frozen admission or a durable run identity", () => {
    expect(() =>
      createDurableChatTurnPayload(
        prepared({ turnAdmission: undefined }),
        request,
        "chat_thread_turn_retried",
        "run-1",
      ),
    ).toThrow(/has no frozen mutation admission/);
    expect(() => createDurableChatTurnPayload(prepared(), request, "chat_thread_turn_edited", "  ")).toThrow(
      /has no durable run identity/,
    );
  });
});
