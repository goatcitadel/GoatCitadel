import { describe, expect, it, vi } from "vitest";
import type { ChannelSendInput } from "@goatcitadel/contracts";
import { buildChannelDeliveryPayload, sendQueuedChannelDelivery } from "./channel-delivery-helpers.js";

describe("channel approval action secret hydration", () => {
  it("rejects raw approval bearers before the durable channel queue", () => {
    const rawToken = `grat_${"q".repeat(43)}`;
    expect(() =>
      buildChannelDeliveryPayload(
        {
          connectionId: "connection-1",
          target: "channel-1",
          message: "Approval requested.",
          interactiveActions: {
            tokenId: "rat_raw",
            buttons: [{ label: "Approve", callbackData: `gca:${rawToken}:a` }],
          },
        },
        "discord",
      ),
    ).toThrow(/cannot be queued/i);
  });

  it("rejects raw approval bearers hidden in an interactive action template", () => {
    const rawToken = `grat_${"t".repeat(43)}`;

    expect(() => buildChannelDeliveryPayload(createInput(rawToken), "telegram")).toThrow(/cannot be queued/i);
  });

  it("persists only a keychain reference and carries the template to the protected tool-host boundary", async () => {
    const rawToken = `grat_${"h".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_123";
    const persistedPayload = buildChannelDeliveryPayload(createInput(tokenRef), "telegram");
    const send = vi.fn(async (input: ChannelSendInput) => {
      expect(input.interactiveActions).toBeUndefined();
      expect(input.interactiveActionTemplate).toMatchObject({ tokenRef, tokenId: "rat_123" });
      expect(JSON.stringify(input)).not.toContain(rawToken);
      return { status: "sent", providerMessageId: "provider-1" };
    });

    expect(JSON.stringify(persistedPayload)).not.toContain(rawToken);
    expect(JSON.stringify(persistedPayload)).toContain(tokenRef);

    await sendQueuedChannelDelivery(send, createRuntimeInput(persistedPayload));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the keychain secret available when provider delivery fails before completion", async () => {
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_retry";
    const persistedPayload = buildChannelDeliveryPayload(createInput(tokenRef), "discord");

    await expect(
      sendQueuedChannelDelivery(
        vi.fn(async () => {
          throw new Error("provider unavailable");
        }),
        createRuntimeInput(persistedPayload),
      ),
    ).rejects.toThrow("provider unavailable");
  });

  it("leaves expiry enforcement to the protected provider boundary without hydrating in the queue worker", async () => {
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_expired";
    const input = createInput(tokenRef);
    input.interactiveActionTemplate!.expiresAt = "2020-07-10T00:00:00.000Z";
    const persistedPayload = buildChannelDeliveryPayload(input, "discord");
    const send = vi.fn(async (sendInput: ChannelSendInput) => {
      expect(sendInput.interactiveActionTemplate?.expiresAt).toBe("2020-07-10T00:00:00.000Z");
      expect(sendInput.interactiveActions).toBeUndefined();
      return { status: "sent", providerMessageId: "provider-expired-fixture" };
    });

    await sendQueuedChannelDelivery(send, createRuntimeInput(persistedPayload));

    expect(send).toHaveBeenCalledTimes(1);
  });
});

function createInput(tokenRef: string): ChannelSendInput {
  return {
    connectionId: "connection-1",
    target: "channel-1",
    message: "Approval requested.",
    interactiveActionTemplate: {
      platform: "telegram",
      tokenId: "rat_123",
      tokenRef,
      expiresAt: "2099-07-10T00:15:00.000Z",
      buttons: [
        { label: "Approve", decision: "a" },
        { label: "Deny", decision: "r" },
      ],
    },
  };
}

function createRuntimeInput(payload: Record<string, unknown>) {
  return {
    deliveryId: "delivery-1",
    connectionId: "connection-1",
    channelKey: "discord",
    target: "channel-1",
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:01.000Z",
    payload,
  } as const;
}
