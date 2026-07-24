import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { agentSendChatMessage, agentSendChatMessageStream, type ChatTurnEntryHost } from "./chat-turn-entry-service.js";
import { createAuthenticatedOperatorAdmissionContext } from "./session-control-service.js";

describe("Chat turn authenticated heartbeat preemption seam", () => {
  it("keeps an internal caller on the ordinary conflict path with no preemption authority", async () => {
    const conflict = new ConflictError({ message: "an active heartbeat owns the turn" });
    const admitOperatorChatTurn = vi.fn(() => {
      throw conflict;
    });
    const host = buildAdmissionOnlyHost(admitOperatorChatTurn);

    await expect(
      agentSendChatMessage(host, "session-1", {
        content: "internal work",
        operatorId: "operator-internal",
      }),
    ).rejects.toBe(conflict);

    expect(admitOperatorChatTurn).toHaveBeenCalledWith(
      expect.not.objectContaining({ authenticatedOperator: expect.anything() }),
    );
  });

  it("passes the separate authenticated route context to append and stream admission", async () => {
    const stopAfterAdmission = new Error("stop after admission capture");
    const admitOperatorChatTurn = vi.fn(() => {
      throw stopAfterAdmission;
    });
    const host = buildAdmissionOnlyHost(admitOperatorChatTurn);
    const authenticatedOperator = createAuthenticatedOperatorAdmissionContext({
      actorId: "operator-http",
      authActorSource: "loopback",
    });
    const request = {
      content: "operator work",
      operatorId: "operator-http",
      authActorId: "operator-http",
      authActorSource: "loopback" as const,
    };

    await expect(agentSendChatMessage(host, "session-1", request, { authenticatedOperator })).rejects.toBe(
      stopAfterAdmission,
    );
    await expect(
      consume(agentSendChatMessageStream(host, "session-1", request, { authenticatedOperator })),
    ).rejects.toBe(stopAfterAdmission);

    expect(admitOperatorChatTurn).toHaveBeenCalledTimes(2);
    for (const [input] of admitOperatorChatTurn.mock.calls) {
      expect(input).toMatchObject({
        sessionId: "session-1",
        request,
        actorId: "operator-http",
        authenticatedOperator,
      });
    }
  });
});

function buildAdmissionOnlyHost(admitOperatorChatTurn: ReturnType<typeof vi.fn>): ChatTurnEntryHost {
  return {
    withChatTurnWriteLease: async (_sessionId: string, _owner: string, operation: () => Promise<unknown>) =>
      operation(),
    withChatTurnWriteLeaseStream: (_sessionId: string, _owner: string, operation: () => AsyncGenerator<unknown>) =>
      operation(),
    sessionControlRuntimeOwner: {
      admitOperatorChatTurn,
      admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery: async (input: unknown) => admitOperatorChatTurn(input),
    },
    recoverDecisionCommittedHeartbeat: vi.fn(async () => undefined),
  } as unknown as ChatTurnEntryHost;
}

async function consume(stream: AsyncGenerator<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Admission throws before the first chunk; consuming drives that branch.
  }
}
