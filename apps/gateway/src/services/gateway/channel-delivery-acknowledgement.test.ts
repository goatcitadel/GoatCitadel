import { describe, expect, it, vi } from "vitest";
import {
  buildChannelDeliveryPayload,
  readChannelDeliveryOwnDelivery,
  sendQueuedChannelDelivery,
} from "./channel-delivery-helpers.js";

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

  it("sends nothing when a passive QQBot reply would need more than 5 parts", async () => {
    const send = vi.fn().mockResolvedValue({ status: "sent", providerMessageId: "p" });
    await expect(
      sendQueuedChannelDelivery(send, {
        ...input,
        channelKey: "qqbot",
        payload: {
          ...input.payload,
          replyToMessageId: "inbound-1",
          messageParts: ["a", "b", "c", "d", "e", "f"],
        },
      }),
    ).rejects.toThrow(/at most 5 passive replies/);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing when a passive QQBot C2C (user:) reply would need 5 parts", async () => {
    const send = vi.fn().mockResolvedValue({ status: "sent", providerMessageId: "p" });
    await expect(
      sendQueuedChannelDelivery(send, {
        ...input,
        channelKey: "qqbot",
        target: "user:U1",
        payload: {
          ...input.payload,
          target: "user:U1",
          replyToMessageId: "inbound-1",
          messageParts: ["a", "b", "c", "d", "e"],
        },
      }),
    ).rejects.toThrow(/at most 4 passive replies/);
    expect(send).not.toHaveBeenCalled();
  });

  it("still sends 5 passive QQBot group parts", async () => {
    const send = vi.fn().mockResolvedValue({ status: "sent", providerMessageId: "p" });
    await sendQueuedChannelDelivery(send, {
      ...input,
      channelKey: "qqbot",
      target: "group:G1",
      payload: {
        ...input.payload,
        target: "group:G1",
        replyToMessageId: "inbound-1",
        messageParts: ["a", "b", "c", "d", "e"],
      },
    });
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("does not apply the QQBot passive-reply limit to active (no anchor) deliveries", async () => {
    const send = vi.fn().mockResolvedValue({ status: "sent", providerMessageId: "p" });
    await sendQueuedChannelDelivery(send, {
      ...input,
      channelKey: "qqbot",
      payload: { ...input.payload, messageParts: ["a", "b", "c", "d", "e", "f"] },
    });
    expect(send).toHaveBeenCalledTimes(6);
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

describe("own-delivery fact on the queued payload", () => {
  it("records it only from the server-side option and reads back only a literal true", () => {
    const send = { connectionId: "c", target: "t", message: "m" };
    expect(buildChannelDeliveryPayload(send, "telegram", { ownDelivery: true })).toMatchObject({ ownDelivery: true });
    expect(buildChannelDeliveryPayload(send, "telegram")).not.toHaveProperty("ownDelivery");
    // A flag on the public send input is not copied: the payload uses an explicit field list.
    expect(buildChannelDeliveryPayload({ ...send, ownDelivery: true } as never, "telegram")).not.toHaveProperty(
      "ownDelivery",
    );
    expect(readChannelDeliveryOwnDelivery({ ownDelivery: true })).toEqual({ ownDelivery: true });
    for (const value of [undefined, false, "true", 1, {}]) {
      expect(readChannelDeliveryOwnDelivery({ ownDelivery: value })).toBeUndefined();
    }
  });
});
