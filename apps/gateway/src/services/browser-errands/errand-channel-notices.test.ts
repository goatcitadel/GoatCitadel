import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrandApprovalConversation } from "./errand-approval-delivery.js";
import {
  createErrandChannelNotices,
  ERRAND_BOT_CHECK_NOTICE_COPY,
  ERRAND_SIGN_IN_NOTICE_COPY,
  sendErrandChannelMessage,
  type ErrandChannelNoticeDeps,
} from "./errand-channel-notices.js";
import { ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE } from "./errand-approval-message.js";
import { ERRAND_ESCALATE_AFTER_MS } from "./errand-constants.js";
import type { ErrandOrigin } from "./errand-origin.js";

const PICKED: ErrandApprovalConversation = {
  connectionId: "conn-dm",
  channelKey: "telegram",
  target: "chat-dm",
  conversation: "direct",
};
const PC: ErrandOrigin = { kind: "pc" };
const direct: ErrandOrigin = {
  kind: "channel",
  connectionId: "conn-origin",
  channelKey: "telegram",
  target: "chat-origin",
  conversation: "direct",
  actorId: "owner",
};
const group: ErrandOrigin = { ...direct, conversation: "group" };

function build(overrides: Partial<ErrandChannelNoticeDeps> = {}) {
  const send = vi.fn(async (_input: unknown) => undefined);
  const notices = createErrandChannelNotices({
    send,
    pickedConversation: async () => PICKED,
    attachmentSessionId: async () => "session-1",
    ...overrides,
  });
  return { notices, send };
}

describe("errand channel notices", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends plain text with optional attachments", async () => {
    const send = vi.fn(async (_input: unknown) => undefined);
    await sendErrandChannelMessage({ send }, { connectionId: "c", target: "t", message: "hi", attachmentIds: ["a"] });
    await sendErrandChannelMessage({ send }, { connectionId: "c", target: "t", message: "hi" });
    expect(send).toHaveBeenNthCalledWith(1, {
      connectionId: "c",
      target: "t",
      message: "hi",
      plainText: true,
      attachmentIds: ["a"],
    });
    expect(send).toHaveBeenNthCalledWith(2, { connectionId: "c", target: "t", message: "hi", plainText: true });
  });

  it("tells a channel-started errand's conversation about a sign-in right away", async () => {
    const { notices, send } = build();
    notices.signInPaused(group, "sign_in");
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      connectionId: "conn-origin",
      target: "chat-origin",
      message: ERRAND_SIGN_IN_NOTICE_COPY,
      plainText: true,
    });
  });

  it("tells the picked conversation about a PC errand's sign-in only after 30 seconds", async () => {
    const { notices, send } = build();
    notices.signInPaused(PC, "sign_in");
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-dm", target: "chat-dm", message: ERRAND_SIGN_IN_NOTICE_COPY }),
    );
  });

  it("sends nothing when the pause ends before 30 seconds", async () => {
    const { notices, send } = build();
    const cancel = notices.signInPaused(PC, "sign_in");
    await vi.advanceTimersByTimeAsync(10_000);
    cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("says the bot-check copy, not the sign-in copy, for a bot-check pause", async () => {
    const { notices, send } = build();
    notices.signInPaused(direct, "bot_check");
    notices.signInPaused(PC, "bot_check");
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [input] of send.mock.calls) {
      expect((input as Record<string, unknown>).message).toBe(ERRAND_BOT_CHECK_NOTICE_COPY);
    }
  });

  it("sends nothing when the pause ends while the picked conversation is still being read", async () => {
    let answer: (conversation: ErrandApprovalConversation | undefined) => void = () => undefined;
    const { notices, send } = build({
      pickedConversation: () => new Promise((resolve) => (answer = resolve)),
    });
    const cancel = notices.signInPaused(PC, "sign_in");
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS);
    cancel();
    answer(PICKED);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing for a PC errand when no conversation is picked", async () => {
    const { notices, send } = build({ pickedConversation: async () => undefined });
    notices.signInPaused(PC, "sign_in");
    await vi.advanceTimersByTimeAsync(ERRAND_ESCALATE_AFTER_MS + 1);
    expect(send).not.toHaveBeenCalled();
  });

  it("attaches the final screenshot in a direct conversation", async () => {
    const { notices, send } = build();
    await notices.finished(direct, { sessionId: "session-1", finalScreenshotAttachmentId: "att-1" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-origin",
        target: "chat-origin",
        attachmentIds: ["att-1"],
        plainText: true,
      }),
    );
  });

  it("sends only the private-only line in a group, with no attachment", async () => {
    const { notices, send } = build();
    await notices.finished(group, { sessionId: "session-1", finalScreenshotAttachmentId: "att-1" });
    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.message).toBe(ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE);
    expect(sent).not.toHaveProperty("attachmentIds");
  });

  it("sends nothing for a PC errand, an errand with no screenshot, or another session's screenshot", async () => {
    const { notices, send } = build({ attachmentSessionId: async () => "other-session" });
    await notices.finished(PC, { sessionId: "session-1", finalScreenshotAttachmentId: "att-1" });
    await notices.finished(direct, { sessionId: "session-1" });
    await notices.finished(direct, { sessionId: "session-1", finalScreenshotAttachmentId: "att-1" });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps going when a send fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { notices } = build({ send: async () => Promise.reject(new Error("down")) });
    await expect(
      notices.finished(group, { sessionId: "s", finalScreenshotAttachmentId: "a" }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
