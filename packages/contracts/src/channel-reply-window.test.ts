import { describe, expect, it } from "vitest";
import {
  WHATSAPP_REPLY_WINDOW_CLOSED,
  WHATSAPP_REPLY_WINDOW_MS,
  isChannelReplyWindowClosed,
} from "./channel-reply-window.js";

describe("channel reply window", () => {
  const now = new Date("2026-10-29T12:00:00Z");

  it("closes WhatsApp's window at 24 hours and never closes another channel's", () => {
    // Exactly 24 hours ago: closed. One minute short of it: open.
    expect(isChannelReplyWindowClosed("whatsapp", "2026-10-28T12:00:00Z", now)).toBe(true);
    expect(isChannelReplyWindowClosed("whatsapp", "2026-10-28T12:01:00Z", now)).toBe(false);
    // WhatsApp with no message from the person on record has nothing to reply to.
    expect(isChannelReplyWindowClosed("whatsapp", undefined, now)).toBe(true);
    // Only WhatsApp has a window.
    expect(isChannelReplyWindowClosed("telegram", undefined, now)).toBe(false);
    expect(isChannelReplyWindowClosed("telegram", "2026-10-01T12:00:00Z", now)).toBe(false);
    expect(isChannelReplyWindowClosed(undefined, undefined, now)).toBe(false);
  });

  it("treats a last message it cannot read as outside the window", () => {
    expect(isChannelReplyWindowClosed("whatsapp", "not a time", now)).toBe(true);
    expect(isChannelReplyWindowClosed("whatsapp", "", now)).toBe(true);
  });

  it("keeps a last message dated ahead of the clock inside the window", () => {
    expect(isChannelReplyWindowClosed("whatsapp", "2026-10-29T12:05:00Z", now)).toBe(false);
  });

  it("states the window as 24 hours and says what reopens it", () => {
    expect(WHATSAPP_REPLY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(WHATSAPP_REPLY_WINDOW_CLOSED).toBe(
      "WhatsApp allows a reply only within 24 hours of their last message. Once they message again, you can reply.",
    );
  });
});
