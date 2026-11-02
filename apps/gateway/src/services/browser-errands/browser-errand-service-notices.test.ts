import { describe, expect, it, vi } from "vitest";
import type { ErrandChannelNotices } from "./errand-channel-notices.js";
import { buildService, errandRequest, outcome } from "./browser-errand-test-fixtures.js";

function fakeNotices() {
  const cancel = vi.fn();
  const notices: ErrandChannelNotices = {
    signInPaused: vi.fn(() => cancel),
    finished: vi.fn(async () => undefined),
  };
  return { notices, cancel };
}

const repliesWith = (notices: ErrandChannelNotices) => () => ({
  handle: async () => ({ handled: false }) as never,
  send: async () => undefined,
  notices,
});

describe("BrowserErrandService channel notices", () => {
  it("starts the sign-in notice for a sign-in pause and withdraws it when the operator hands back", async () => {
    const { notices, cancel } = fakeNotices();
    let runs = 0;
    const { service, browser } = buildService(vi.fn, {
      channelReplies: repliesWith(notices),
      runLoop: async (deps) =>
        (runs += 1) === 1 ? (await deps.waitForHandBack("sign_in"), outcome("done")) : outcome("done"),
    });
    const running = service.run(errandRequest());
    await vi.waitFor(() => expect(notices.signInPaused).toHaveBeenCalledWith({ kind: "pc" }));
    expect(cancel).not.toHaveBeenCalled();
    browser.fireOverlay({ type: "hand_back" });
    await running;
    expect(cancel).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("sends no sign-in notice for an operator take over", async () => {
    const { notices } = fakeNotices();
    const { service, browser } = buildService(vi.fn, {
      channelReplies: repliesWith(notices),
      runLoop: async (deps) => (await deps.waitForHandBack("operator"), outcome("done")),
    });
    const running = service.run(errandRequest());
    await vi.waitFor(() => expect(service.getStatus("tool-run-1")?.state).toBe("taken_over"));
    browser.fireOverlay({ type: "hand_back" });
    await running;
    expect(notices.signInPaused).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("withdraws the notice when Stop ends the pause", async () => {
    const { notices, cancel } = fakeNotices();
    const { service } = buildService(vi.fn, {
      channelReplies: repliesWith(notices),
      runLoop: async (deps) => (await deps.waitForHandBack("bot_check"), outcome("stopped")),
    });
    const running = service.run(errandRequest());
    await vi.waitFor(() => expect(notices.signInPaused).toHaveBeenCalled());
    await service.stop(service.getStatus("tool-run-1")!.errandId, "operator");
    await running;
    expect(cancel).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("hands the errand's own session and final screenshot to the finished notice", async () => {
    const { notices } = fakeNotices();
    const { service } = buildService(vi.fn, {
      channelReplies: repliesWith(notices),
      runLoop: async () => outcome("done", { finalScreenshotPng: Buffer.from("png") }),
    });
    await service.run(errandRequest());
    expect(notices.finished).toHaveBeenCalledWith(
      { kind: "pc" },
      { sessionId: "session-1", finalScreenshotAttachmentId: "att-1" },
    );
    await service.dispose();
  });
});
