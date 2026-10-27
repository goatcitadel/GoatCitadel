// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnOnOutcome } from "./turn-on-channel";
import { useTurnOn } from "./use-turn-on";

const turnOnModule = vi.hoisted(() => ({
  turnOnChannelDraft: vi.fn(),
  acknowledgeCleanupAndTurnOn: vi.fn(),
}));
vi.mock("./turn-on-channel", () => turnOnModule);

const INPUT = {
  draftId: "draft-1",
  catalogId: "channel.telegram",
  requiredHosts: ["api.telegram.org"],
  shownHosts: ["api.telegram.org"],
};
const plan = { planId: "plan-1" } as never;

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useTurnOn>;

function Probe({ workspaceId, setupId }: { workspaceId: string; setupId?: string }) {
  current = useTurnOn(workspaceId, setupId);
  return null;
}

async function mount(workspaceId = "default", setupId?: string) {
  await act(async () => {
    root.render(createElement(Probe, { workspaceId, setupId }));
  });
}

async function run(action: () => Promise<void>) {
  await act(async () => {
    await action();
  });
}

/** A turn-on call that finishes only when the test says so. */
function pending() {
  let finish!: (outcome: TurnOnOutcome) => void;
  const promise = new Promise<TurnOnOutcome>((resolve) => (finish = resolve));
  return { promise, finish };
}

beforeEach(() => {
  turnOnModule.turnOnChannelDraft.mockReset();
  turnOnModule.acknowledgeCleanupAndTurnOn.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useTurnOn", () => {
  it("starts idle", async () => {
    await mount();
    expect(current.state).toBe("idle");
    expect(current.message).toBeUndefined();
    expect(current.approvalId).toBeUndefined();
    expect(current.reasons).toEqual([]);
  });

  it("turns the channel on in this workspace and says it is done", async () => {
    turnOnModule.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await mount("workspace-a");
    await run(() => current.turnOn(INPUT));
    expect(turnOnModule.turnOnChannelDraft).toHaveBeenCalledTimes(1);
    expect(turnOnModule.turnOnChannelDraft).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      draftId: "draft-1",
      catalogId: "channel.telegram",
      requiredHosts: ["api.telegram.org"],
      shownHosts: ["api.telegram.org"],
    });
    expect(current.state).toBe("done");
  });

  it("is working until the answer comes", async () => {
    const call = pending();
    turnOnModule.turnOnChannelDraft.mockReturnValue(call.promise);
    await mount();
    let started!: Promise<void>;
    await act(async () => {
      started = current.turnOn(INPUT);
      await Promise.resolve();
    });
    expect(current.state).toBe("working");
    await act(async () => {
      call.finish({ kind: "completed", plan });
      await started;
    });
    expect(current.state).toBe("done");
  });

  it("ignores another click while it is working", async () => {
    const call = pending();
    turnOnModule.turnOnChannelDraft.mockReturnValue(call.promise);
    await mount();
    let started!: Promise<void>;
    await act(async () => {
      started = current.turnOn(INPUT);
      // Two clicks in the same moment, before the page has drawn "working".
      void current.turnOn(INPUT);
      await Promise.resolve();
    });
    await run(() => current.turnOn(INPUT));
    expect(turnOnModule.turnOnChannelDraft).toHaveBeenCalledTimes(1);
    await act(async () => {
      call.finish({ kind: "completed", plan });
      await started;
    });
  });

  it("lets an answer that arrives after the page has gone pass without a trace", async () => {
    const call = pending();
    turnOnModule.turnOnChannelDraft.mockReturnValue(call.promise);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    let started!: Promise<void>;
    await act(async () => {
      started = current.turnOn(INPUT);
      await Promise.resolve();
    });
    act(() => root.unmount());
    await act(async () => {
      call.finish({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
      await started;
    });
    // Nothing runs on from a page that is gone: no follow-up call, no warning.
    expect(turnOnModule.acknowledgeCleanupAndTurnOn).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("drops the answer when the workspace changes", async () => {
    const call = pending();
    turnOnModule.turnOnChannelDraft.mockReturnValue(call.promise);
    await mount("workspace-a");
    let started!: Promise<void>;
    await act(async () => {
      started = current.turnOn(INPUT);
      await Promise.resolve();
    });
    await mount("workspace-b");
    expect(current.state).toBe("idle");
    await act(async () => {
      call.finish({ kind: "completed", plan });
      await started;
    });
    expect(current.state).toBe("idle");
  });

  it("starts clean for another setup, so an old failure is not shown against it", async () => {
    turnOnModule.turnOnChannelDraft.mockResolvedValue({ kind: "failed", message: "Telegram said no." });
    await mount("default", "draft-1");
    await run(() => current.turnOn(INPUT));
    expect(current.state).toBe("failed");
    await mount("default", "draft-2");
    expect(current.state).toBe("idle");
    expect(current.message).toBeUndefined();
  });

  it("keeps the reasons when the setup is not ready, one each", async () => {
    turnOnModule.turnOnChannelDraft.mockResolvedValue({ kind: "blocked", reasons: ["Add a chat.", "Check the key."] });
    await mount();
    await run(() => current.turnOn(INPUT));
    expect(current.state).toBe("blocked");
    expect(current.reasons).toEqual(["Add a chat.", "Check the key."]);
  });

  it("keeps the message when it fails", async () => {
    turnOnModule.turnOnChannelDraft.mockResolvedValue({ kind: "failed", message: "Telegram said no." });
    await mount();
    await run(() => current.turnOn(INPUT));
    expect(current.state).toBe("failed");
    expect(current.message).toBe("Telegram said no.");
  });

  it("shows a failure, and can be tried again, when the call itself throws", async () => {
    turnOnModule.turnOnChannelDraft.mockRejectedValueOnce(new Error("Boom."));
    await mount();
    await run(() => current.turnOn(INPUT));
    expect(current.state).toBe("failed");
    expect(current.message).toBe("Boom.");

    turnOnModule.turnOnChannelDraft.mockResolvedValueOnce({ kind: "completed", plan });
    await run(() => current.turnOn(INPUT));
    expect(current.state).toBe("done");
  });

  it("keeps the approval when the next step is in Inbox, and none when it is in Settings", async () => {
    turnOnModule.turnOnChannelDraft.mockResolvedValueOnce({ kind: "elsewhere", plan, approvalId: "approval-9" });
    await mount();
    await run(() => current.turnOn(INPUT));
    expect(current.state).toBe("elsewhere");
    expect(current.approvalId).toBe("approval-9");

    turnOnModule.turnOnChannelDraft.mockResolvedValueOnce({ kind: "elsewhere", plan });
    await run(() => current.turnOn(INPUT));
    expect(current.state).toBe("elsewhere");
    expect(current.approvalId).toBeUndefined();
    expect(current.reviewPlanId).toBeUndefined();
  });

  it("keeps the change to review in Inbox when this page didn't make it and it waits on no approval", async () => {
    turnOnModule.turnOnChannelDraft.mockResolvedValueOnce({ kind: "elsewhere", plan, inInbox: true });
    await mount();
    await run(() => current.turnOn(INPUT));
    expect(current.state).toBe("elsewhere");
    expect(current.reviewPlanId).toBe("plan-1");
    expect(current.approvalId).toBeUndefined();

    // One that waits on an approval goes to that approval instead.
    turnOnModule.turnOnChannelDraft.mockResolvedValueOnce({
      kind: "elsewhere",
      plan,
      inInbox: true,
      approvalId: "a-2",
    });
    await run(() => current.turnOn(INPUT));
    expect(current.approvalId).toBe("a-2");
    expect(current.reviewPlanId).toBeUndefined();
  });

  it("can be tried again after a failure, and forgets the old failure when it starts", async () => {
    turnOnModule.turnOnChannelDraft.mockResolvedValueOnce({ kind: "failed", message: "Telegram said no." });
    await mount();
    await run(() => current.turnOn(INPUT));
    expect(current.message).toBe("Telegram said no.");

    const call = pending();
    turnOnModule.turnOnChannelDraft.mockReturnValueOnce(call.promise);
    let started!: Promise<void>;
    await act(async () => {
      started = current.turnOn(INPUT);
      await Promise.resolve();
    });
    expect(current.state).toBe("working");
    expect(current.message).toBeUndefined();
    await act(async () => {
      call.finish({ kind: "completed", plan });
      await started;
    });
    expect(current.state).toBe("done");
  });

  it("asks to carry on when the test message could not be removed, then goes on from there", async () => {
    turnOnModule.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
    turnOnModule.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "completed", plan });
    await mount("workspace-a");
    await run(() => current.turnOn(INPUT));
    expect(current.state).toBe("cleanup");

    await run(() => current.acknowledgeCleanup());
    expect(turnOnModule.acknowledgeCleanupAndTurnOn).toHaveBeenCalledTimes(1);
    expect(turnOnModule.acknowledgeCleanupAndTurnOn).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      draftId: "draft-1",
      catalogId: "channel.telegram",
      evidenceId: "proof-1",
    });
    // It never tests again: another test would send another message.
    expect(turnOnModule.turnOnChannelDraft).toHaveBeenCalledTimes(1);
    expect(current.state).toBe("done");
  });

  it("does nothing on Continue unless a cleanup is waiting", async () => {
    await mount();
    await run(() => current.acknowledgeCleanup());
    expect(turnOnModule.acknowledgeCleanupAndTurnOn).not.toHaveBeenCalled();
    expect(current.state).toBe("idle");
  });

  it("ignores a second Continue while the first is working", async () => {
    turnOnModule.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
    const call = pending();
    turnOnModule.acknowledgeCleanupAndTurnOn.mockReturnValue(call.promise);
    await mount();
    await run(() => current.turnOn(INPUT));
    let started!: Promise<void>;
    await act(async () => {
      started = current.acknowledgeCleanup();
      void current.acknowledgeCleanup();
      await Promise.resolve();
    });
    expect(current.state).toBe("working");
    await act(async () => {
      call.finish({ kind: "failed", message: "No." });
      await started;
    });
    expect(turnOnModule.acknowledgeCleanupAndTurnOn).toHaveBeenCalledTimes(1);
    expect(current.state).toBe("failed");
  });

  it("asks again if a second test message cannot be removed either", async () => {
    turnOnModule.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
    turnOnModule.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-2" });
    await mount();
    await run(() => current.turnOn(INPUT));
    await run(() => current.acknowledgeCleanup());
    expect(current.state).toBe("cleanup");
    turnOnModule.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "completed", plan });
    await run(() => current.acknowledgeCleanup());
    expect(turnOnModule.acknowledgeCleanupAndTurnOn).toHaveBeenLastCalledWith(
      expect.objectContaining({ evidenceId: "proof-2" }),
    );
    expect(current.state).toBe("done");
  });
});
