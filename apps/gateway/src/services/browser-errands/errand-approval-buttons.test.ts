import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, type DurableCheckpointRecord } from "@goatcitadel/contracts";
import {
  clearErrandApprovalButtons,
  connectorDeliveryProviderMessageId,
  createGatewayErrandButtonClearer,
} from "./errand-approval-buttons.js";
import type { ErrandTrackedDelivery } from "./errand-approval-delivery.js";

function delivery(partial: Partial<ErrandTrackedDelivery> = {}): ErrandTrackedDelivery {
  return {
    approvalId: "approval-1",
    connectionId: "conn-1",
    target: "chat-1",
    deliveryRunId: "run-1",
    buttons: true,
    sentAt: async () => 1,
    providerMessageId: async () => "msg-1",
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clearErrandApprovalButtons", () => {
  it("takes the buttons off each delivered message that carried them", async () => {
    const clear = vi.fn(async () => undefined);

    await clearErrandApprovalButtons(
      [
        delivery(),
        delivery({
          connectionId: "conn-2",
          target: "dm-2",
          deliveryRunId: "run-2",
          providerMessageId: async () => "m2",
        }),
      ],
      clear,
    );

    expect(clear).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledWith({ connectionId: "conn-1", target: "chat-1", messageId: "msg-1" });
    expect(clear).toHaveBeenCalledWith({ connectionId: "conn-2", target: "dm-2", messageId: "m2" });
  });

  it("skips a message sent without buttons, and one whose provider message isn't known", async () => {
    const clear = vi.fn(async () => undefined);

    await clearErrandApprovalButtons(
      [
        delivery({ buttons: false }),
        delivery({ providerMessageId: async () => undefined }),
        delivery({ providerMessageId: async () => "   " }),
        delivery({ providerMessageId: undefined }),
      ],
      clear,
    );

    expect(clear).not.toHaveBeenCalled();
  });

  it("never throws: a failed edit or read logs one bounded warning and the rest still go", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clear = vi.fn(async (message: { messageId: string }) => {
      if (message.messageId === "msg-1") throw new Error(`telegram said no ${"x".repeat(2_000)}`);
    });

    await expect(
      clearErrandApprovalButtons(
        [
          delivery(),
          delivery({
            deliveryRunId: "run-unreadable",
            providerMessageId: async () => {
              throw new Error("storage offline");
            },
          }),
          delivery({ deliveryRunId: "run-3", providerMessageId: async () => "msg-3" }),
        ],
        clear,
      ),
    ).resolves.toBeUndefined();

    expect(clear).toHaveBeenCalledWith(expect.objectContaining({ messageId: "msg-3" }));
    expect(warn).toHaveBeenCalledTimes(2);
    const [message, context] = warn.mock.calls[0] as [string, { detail: string; approvalId: string }];
    expect(message).toBe("[goatcitadel] errand approval buttons could not be removed");
    expect(context.approvalId).toBe("approval-1");
    expect(context.detail.length).toBeLessThanOrEqual(500);
  });

  it("is built from the Gateway's channel button clearing", async () => {
    const clearChannelMessageButtons = vi.fn(async () => undefined);
    const clearer = createGatewayErrandButtonClearer({ clearChannelMessageButtons });

    await clearer([delivery()]);

    expect(clearChannelMessageButtons).toHaveBeenCalledWith({
      connectionId: "conn-1",
      target: "chat-1",
      messageId: "msg-1",
    });
  });
});

describe("connectorDeliveryProviderMessageId", () => {
  const checkpoint = (state: Record<string, unknown>): DurableCheckpointRecord =>
    ({ checkpointId: "cp-1", runId: "run-1", checkpointKind: "run_completed", state }) as DurableCheckpointRecord;

  it("reads the provider message id the completed delivery recorded", async () => {
    const getLatestCheckpointByKind = vi.fn(async () => checkpoint({ result: { providerMessageId: " 4242 " } }));

    await expect(connectorDeliveryProviderMessageId({ getLatestCheckpointByKind }, "run-1")).resolves.toBe("4242");
    expect(getLatestCheckpointByKind).toHaveBeenCalledWith("run-1", "run_completed");
  });

  it.each([
    ["no completed checkpoint", undefined],
    ["no result", checkpoint({ deliveryStatus: "already_committed" })],
    ["a non-string id", checkpoint({ result: { providerMessageId: 4242 } })],
  ])("reads %s as unknown", async (_label, recorded) => {
    await expect(
      connectorDeliveryProviderMessageId({ getLatestCheckpointByKind: async () => recorded }, "run-1"),
    ).resolves.toBeUndefined();
  });

  it("reads a missing run as unknown and lets other read failures through", async () => {
    await expect(
      connectorDeliveryProviderMessageId(
        {
          getLatestCheckpointByKind: async () => {
            throw new NotFoundError({ entity: "Durable run", id: "run-1" });
          },
        },
        "run-1",
      ),
    ).resolves.toBeUndefined();
    await expect(
      connectorDeliveryProviderMessageId(
        {
          getLatestCheckpointByKind: async () => {
            throw new Error("storage offline");
          },
        },
        "run-1",
      ),
    ).rejects.toThrow("storage offline");
  });
});
