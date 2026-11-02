import { describe, expect, it, vi } from "vitest";
import type { ErrandTrackedDelivery } from "./errand-approval-delivery.js";
import { buildService, errandRequest, fakeGate, outcome } from "./browser-errand-test-fixtures.js";

const tracked = (deliveryRunId: string): ErrandTrackedDelivery => ({
  approvalId: "approval-1",
  connectionId: "conn-1",
  target: "chat-1",
  deliveryRunId,
  buttons: true,
  sentAt: async () => 1,
  providerMessageId: async () => `msg-${deliveryRunId}`,
});

/** An errand that waits in one approval until `answer` (or Stop) decides it. */
function waitingErrand() {
  const clearButtons = vi.fn(async (_deliveries: readonly ErrandTrackedDelivery[]) => undefined);
  let answer: (decision: "approved" | "stopped") => void = () => undefined;
  const gate = fakeGate(vi.fn, {
    request: vi.fn(
      () =>
        new Promise<"approved" | "stopped">((resolve) => {
          answer = resolve;
        }),
    ),
  });
  const { service } = buildService(vi.fn, {
    channelReplies: () => ({
      handle: async () => ({ handled: false }) as never,
      send: async () => undefined,
      clearButtons,
    }),
    createGate: (deps) => {
      deps.signal.addEventListener("abort", () => answer("stopped"), { once: true });
      return gate;
    },
    runLoop: async (deps) => outcome((await deps.requestApproval({} as never)) === "stopped" ? "stopped" : "done"),
  });
  return { service, gate, clearButtons, answer: (decision: "approved" | "stopped") => answer(decision) };
}

describe("BrowserErrandService approval buttons", () => {
  it("takes the buttons off the channel messages once the approval is answered", async () => {
    const { service, gate, clearButtons, answer } = waitingErrand();
    const running = service.run(errandRequest());
    await vi.waitFor(() => expect(gate.request).toHaveBeenCalled());
    service.recordDelivery(tracked("run-1"));
    expect(clearButtons).not.toHaveBeenCalled();

    answer("approved");
    await running;

    expect(clearButtons).toHaveBeenCalledTimes(1);
    const [deliveries] = clearButtons.mock.calls[0]!;
    expect(deliveries).toEqual([expect.objectContaining({ deliveryRunId: "run-1", buttons: true })]);
    // The recorded message id reader is kept, so the channel edit can name the message.
    await expect(deliveries[0]!.providerMessageId?.()).resolves.toBe("msg-run-1");
    await service.dispose();
  });

  it("takes them off when Stop ends the wait, and never twice for one message", async () => {
    const { service, gate, clearButtons } = waitingErrand();
    const running = service.run(errandRequest());
    await vi.waitFor(() => expect(gate.request).toHaveBeenCalled());
    service.recordDelivery(tracked("run-1"));
    service.recordDelivery(tracked("run-2"));

    await service.stop(service.getStatus("tool-run-1")!.errandId, "operator");
    await running;

    const cleared = clearButtons.mock.calls.flatMap(([deliveries]) => deliveries.map((item) => item.deliveryRunId));
    expect(cleared.sort()).toEqual(["run-1", "run-2"]);
    await service.dispose();
  });

  it("never lets a failed clear touch the errand", async () => {
    const { service, gate, clearButtons, answer } = waitingErrand();
    clearButtons.mockRejectedValue(new Error("channel offline"));
    const running = service.run(errandRequest());
    await vi.waitFor(() => expect(gate.request).toHaveBeenCalled());
    service.recordDelivery(tracked("run-1"));

    answer("approved");

    await expect(running).resolves.toMatchObject({ outcome: "done" });
    await service.dispose();
  });
});
