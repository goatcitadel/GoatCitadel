import { describe, expect, it, vi } from "vitest";
import { sanitizeChannelOutboundMessage } from "@goatcitadel/contracts";
import type {
  ChatAttachmentRecord,
  IntegrationConnection,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { commsActivity, commsReact, commsSend, commsUnsend, type CommsHost } from "./comms-service.js";

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
    getIntegrationConnection: vi.fn(
      () =>
        ({
          connectionId: "conn-1",
          kind: "channel",
          key: "telegram",
          label: "Telegram",
          config: {},
        }) as IntegrationConnection,
    ),
    emitDiscordTyping: vi.fn(),
    emitTelegramTyping: vi.fn(),
    emitChannelActivity: vi.fn(async () => [{ effect: "mission_control", supported: true, status: "sent" }]),
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

  it("strips hidden reasoning blocks before final channel delivery, including fenced-code delivery text", async () => {
    const host = createHost();
    host.getIntegrationConnection = vi.fn(
      () =>
        ({
          connectionId: "conn-1",
          kind: "channel",
          key: "discord",
          label: "Discord",
          config: {},
        }) as IntegrationConnection,
    );

    await commsSend(host, {
      connectionId: "conn-1",
      target: "#ops",
      message: [
        "Visible answer.",
        "<thinking>private chain of thought</thinking>",
        "authorization: Bearer secret-token-value-1234567890",
        "```xml",
        "<thinking>literal example with sk-abcdefghijklmnopqrstuvwx</thinking>",
        "@everyone should not page from code fences",
        "```",
        '[tool_call]{"name":"secret"}[/tool_call]',
        "Done.",
      ].join("\n"),
    });

    const request = host.invokeAndUnwrap.mock.calls[0]![0] as ToolInvokeRequest;
    expect(request.args).toMatchObject({
      message: [
        "Visible answer.",
        "",
        "authorization: Bearer [REDACTED]",
        "```xml",
        "",
        "@ everyone should not page from code fences",
        "```",
        "",
        "Done.",
      ].join("\n"),
      outboundSanitizer: {
        removedBlockCount: 3,
        redactedSecretCount: 1,
        neutralizedMentionCount: 1,
        policy: "strip_internal_reasoning_blocks_redact_secrets",
      },
    });
  });

  it("keeps ordinary discussion of thinking when it is not a hidden provider block", () => {
    expect(sanitizeChannelOutboundMessage("We should think through rollback before sending.")).toMatchObject({
      message: "We should think through rollback before sending.",
      removedBlockCount: 0,
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

  it("routes shared channel activity through the activity host", async () => {
    const host = createHost();

    const result = await commsActivity(host, {
      connectionId: "conn-1",
      target: "chat-1",
      messageId: "message-1",
      phase: "thinking",
      sessionId: "session-1",
    });

    expect(host.emitChannelActivity).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-1", kind: "channel" }),
      expect.objectContaining({ phase: "thinking", messageId: "message-1" }),
      expect.objectContaining({ emoji: "🧠", typing: true }),
    );
    expect(result).toMatchObject({
      connectionId: "conn-1",
      messageId: "message-1",
      phase: "thinking",
      emoji: "🧠",
      status: "sent",
    });
  });
});
