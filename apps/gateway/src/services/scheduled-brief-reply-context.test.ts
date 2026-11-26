import { expect, it, vi } from "vitest";
import { readScheduledBriefReplyContext } from "./scheduled-brief-reply-context.js";

it("uses only the acknowledged scheduled brief in the same destination and inbound workspace", async () => {
  const storage = {
    chatSessionMeta: { get: vi.fn(async () => ({ workspaceId: "project" })) },
    commsDeliveries: {
      findSentByProviderMessage: vi.fn(async () => ({
        deliveryId: "delivery",
        channelKey: "discord",
        payload: {
          workspaceId: "project",
          runId: "chat-run",
          sessionId: "brief-chat",
          effectId: "connector-delivery:delivery-run",
          message: "1. Draft the report.\n2. Verify data access.",
        },
      })),
    },
    durableRuns: {
      getRun: vi.fn(async () => ({
        workflowKey: "chat.turn.execute",
        payload: { cronAdmission: { cronRunId: "occurrence" } },
        metadata: { autonomousChatPostCommit: { delivery: { status: "enqueued", runId: "delivery-run" } } },
      })),
    },
    cronRuns: {
      get: vi.fn(async () => ({
        action: "agent_turn",
        status: "completed",
        childSessionId: "brief-chat",
        childDurableRunId: "chat-run",
        outcome: { deliveryId: "delivery", providerMessageId: "123456789012345678" },
      })),
    },
  };
  const input = {
    sessionId: "inbound-chat",
    connectionId: "discord-1",
    target: "234567890123456789",
    providerMessageId: "123456789012345678",
  };
  await expect(readScheduledBriefReplyContext(storage as never, input)).resolves.toContain("2. Verify data access.");
  expect(storage.commsDeliveries.findSentByProviderMessage).toHaveBeenCalledWith(
    input.connectionId,
    `channel:${input.target}`,
    input.providerMessageId,
  );
  storage.chatSessionMeta.get.mockResolvedValueOnce({ workspaceId: "other" });
  await expect(readScheduledBriefReplyContext(storage as never, input)).resolves.toBeUndefined();
  const awaitingSweep = {
    action: "agent_turn",
    status: "waiting",
    childSessionId: "brief-chat",
    childDurableRunId: "chat-run",
    outcome: { deliveryId: "not-yet-settled", providerMessageId: "" },
    deliveryRunId: "delivery-run",
  };
  storage.cronRuns.get.mockResolvedValueOnce(awaitingSweep);
  await expect(readScheduledBriefReplyContext(storage as never, input)).resolves.toContain("2. Verify data access.");
  const wrongDelivery = { ...awaitingSweep, deliveryRunId: "another-run" };
  storage.cronRuns.get.mockResolvedValueOnce(wrongDelivery);
  await expect(readScheduledBriefReplyContext(storage as never, input)).resolves.toBeUndefined();
  storage.cronRuns.get.mockResolvedValueOnce({
    action: "agent_turn",
    status: "completed",
    childSessionId: "brief-chat",
    childDurableRunId: "chat-run",
    outcome: { deliveryId: "another-delivery", providerMessageId: input.providerMessageId },
  });
  await expect(readScheduledBriefReplyContext(storage as never, input)).resolves.toBeUndefined();
});
