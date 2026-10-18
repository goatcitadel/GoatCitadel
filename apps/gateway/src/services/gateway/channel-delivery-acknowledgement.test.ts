import { describe, expect, it, vi } from "vitest";
import { buildChannelDeliveryPayload, sendQueuedChannelDelivery } from "./channel-delivery-helpers.js";

const input = {
  deliveryId: "delivery-1",
  connectionId: "connection-1",
  channelKey: "telegram",
  target: "-123456",
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:01.000Z",
  payload: { connectionId: "connection-1", target: "-123456", message: "hello" },
} as const;

describe("channel provider acknowledgement", () => {
  it.each([{}, { status: "queued" }, { status: "sent", deliveryStatus: "blocked" }])(
    "refuses an unacknowledged or inconsistent provider result %j",
    async (result) => {
      await expect(sendQueuedChannelDelivery(async () => result, input)).rejects.toMatchObject({
        deliveryStatus: "manual_reconciliation_required",
      });
    },
  );

  it("accepts an explicit provider success even for providers without message ids", async () => {
    await expect(sendQueuedChannelDelivery(async () => ({ status: "sent" }), input)).resolves.toEqual({
      providerMessageId: undefined,
    });
  });

  it("carries the original reply anchor on every chunk while chaining the reply id", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ status: "sent", providerMessageId: "p1" })
      .mockResolvedValueOnce({ status: "sent", providerMessageId: "p2" });
    await sendQueuedChannelDelivery(send, {
      ...input,
      payload: { ...input.payload, replyToMessageId: "inbound-1", messageParts: ["a", "b"] },
    });
    expect(send.mock.calls.map(([call]) => [call.replyToMessageId, call.replyAnchorMessageId])).toEqual([
      ["inbound-1", "inbound-1"],
      ["p1", "inbound-1"],
    ]);
  });

  it("splits WeCom and QQBot deliveries at their conservative chunk limits", () => {
    const wecom = buildChannelDeliveryPayload({ connectionId: "c", target: "t", message: "x".repeat(1500) }, "wecom");
    expect((wecom.messageParts as string[]).every((part) => part.length <= 680)).toBe(true);
    const qq = buildChannelDeliveryPayload({ connectionId: "c", target: "t", message: "x".repeat(4500) }, "qqbot");
    expect((qq.messageParts as string[]).every((part) => part.length <= 2000)).toBe(true);
  });

  it("preserves the earlier acknowledgement when a later chunk has no send outcome", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ status: "sent", providerMessageId: "provider-first" })
      .mockResolvedValueOnce({ status: "queued" });
    await expect(
      sendQueuedChannelDelivery(send, {
        ...input,
        payload: { ...input.payload, messageParts: ["first", "second", "third"] },
      }),
    ).rejects.toMatchObject({
      deliveryStatus: "manual_reconciliation_required",
      providerMessageId: "provider-first",
      message: expect.stringContaining("1 of 3 chunks"),
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
