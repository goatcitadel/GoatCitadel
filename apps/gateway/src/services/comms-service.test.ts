import { describe, expect, it, vi } from "vitest";
import type {
  ChatAttachmentRecord,
  IntegrationConnection,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { commsReact, commsSend, commsUnsend, type CommsHost } from "./comms-service.js";

function createHost(): CommsHost & { invokeAndUnwrap: ReturnType<typeof vi.fn> } {
  return {
    invokeAndUnwrap: vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-1",
        policyReason: "allowed",
        result: { status: "sent" },
      }),
    ),
    readChatAttachmentContent: vi.fn(async () => ({
      record: { attachmentId: "attachment-1", fileName: "a.txt", mimeType: "text/plain" } as ChatAttachmentRecord,
      bytes: Buffer.from("hello"),
    })),
    getIntegrationConnection: vi.fn(() => ({ connectionId: "conn-1", kind: "channel" }) as IntegrationConnection),
    emitDiscordTyping: vi.fn(),
    emitTelegramTyping: vi.fn(),
  };
}

describe("comms service governance", () => {
  it("carries channel governance into the final channel.send tool request", async () => {
    const host = createHost();

    await commsSend(host, {
      connectionId: "conn-1",
      target: "#ops",
      message: "hello",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agentId: "agent-1",
      taskId: "task-1",
      runId: "run-1",
      operatorId: "operator-1",
      authActorId: "actor-1",
      authActorSource: "loopback",
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
      surface: "cowork",
    });

    const request = host.invokeAndUnwrap.mock.calls[0]![0] as ToolInvokeRequest;
    expect(request).toMatchObject({
      toolName: "channel.send",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agentId: "agent-1",
      taskId: "task-1",
      runId: "run-1",
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
      surface: "cowork",
      consentContext: {
        operatorId: "operator-1",
        source: "agent",
      },
      policyContext: {
        operatorId: "operator-1",
        authActorId: "actor-1",
        authActorSource: "loopback",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        taskId: "task-1",
        runId: "run-1",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
        surface: "cowork",
      },
    });
  });

  it("carries channel governance into reaction and unsend requests", async () => {
    const host = createHost();
    const governance = {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agentId: "agent-1",
      taskId: "task-1",
      runId: "run-1",
      operatorId: "operator-1",
      authActorId: "actor-1",
      authActorSource: "loopback" as const,
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
      surface: "chat" as const,
    };

    await commsReact(host, {
      connectionId: "conn-1",
      messageId: "message-1",
      reaction: "+1",
      ...governance,
    });
    await commsUnsend(host, {
      connectionId: "conn-1",
      messageId: "message-1",
      ...governance,
    });

    for (const [request] of host.invokeAndUnwrap.mock.calls) {
      expect(request).toMatchObject({
        workspaceId: "workspace-1",
        runId: "run-1",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
        policyContext: expect.objectContaining({
          operatorId: "operator-1",
          authActorId: "actor-1",
          runId: "run-1",
        }),
      });
    }
  });
});
