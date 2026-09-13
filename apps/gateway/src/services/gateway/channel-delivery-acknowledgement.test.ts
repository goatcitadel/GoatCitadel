import { describe, expect, it, vi } from "vitest";
import { sendQueuedChannelDelivery } from "./channel-delivery-helpers.js";

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
