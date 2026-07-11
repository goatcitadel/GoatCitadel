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

  it("persists only a keychain reference and hydrates the bearer at final transport", async () => {
    const rawToken = `grat_${"h".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_123";
    const persistedPayload = buildChannelDeliveryPayload(createInput(tokenRef), "discord");
    const send = vi.fn(async (input: ChannelSendInput) => {
      expect(input.interactiveActions?.buttons).toEqual([
        { label: "Approve", callbackData: `gca:${rawToken}:a` },
        { label: "Deny", callbackData: `gca:${rawToken}:r` },
      ]);
      return { status: "sent", providerMessageId: "provider-1" };
    });
    const deleteInteractiveActionToken = vi.fn();

    expect(JSON.stringify(persistedPayload)).not.toContain(rawToken);
    expect(JSON.stringify(persistedPayload)).toContain(tokenRef);

    await sendQueuedChannelDelivery(send, createRuntimeInput(persistedPayload), {
      tokenSecrets: {
        resolve: vi.fn(() => rawToken),
        delete: deleteInteractiveActionToken,
      },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(deleteInteractiveActionToken).toHaveBeenCalledWith(tokenRef);
  });

  it("keeps the keychain secret available when provider delivery fails before completion", async () => {
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_retry";
    const persistedPayload = buildChannelDeliveryPayload(createInput(tokenRef), "discord");
    const deleteInteractiveActionToken = vi.fn();

    await expect(
      sendQueuedChannelDelivery(
        vi.fn(async () => {
          throw new Error("provider unavailable");
        }),
        createRuntimeInput(persistedPayload),
        {
          tokenSecrets: {
            resolve: vi.fn(() => `grat_${"r".repeat(43)}`),
            delete: deleteInteractiveActionToken,
          },
        },
      ),
    ).rejects.toThrow("provider unavailable");

    expect(deleteInteractiveActionToken).not.toHaveBeenCalled();
  });

  it("deletes and blocks an expired action before resolving or calling the provider", async () => {
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_expired";
    const input = createInput(tokenRef);
    input.interactiveActionTemplate!.expiresAt = "2020-07-10T00:00:00.000Z";
    const persistedPayload = buildChannelDeliveryPayload(input, "discord");
    const resolveInteractiveActionToken = vi.fn();
    const deleteInteractiveActionToken = vi.fn();
    const send = vi.fn();

    await expect(
      sendQueuedChannelDelivery(send, createRuntimeInput(persistedPayload), {
        tokenSecrets: {
          resolve: resolveInteractiveActionToken,
          delete: deleteInteractiveActionToken,
        },
      }),
    ).rejects.toMatchObject({
      message: "Approval interactive-action token expired before provider dispatch.",
      deliveryStatus: "blocked",
    });

    expect(deleteInteractiveActionToken).toHaveBeenCalledWith(tokenRef);
    expect(resolveInteractiveActionToken).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

function createInput(tokenRef: string): ChannelSendInput {
  return {
    connectionId: "connection-1",
    target: "channel-1",
    message: "Approval requested.",
    interactiveActionTemplate: {
      platform: "discord",
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
