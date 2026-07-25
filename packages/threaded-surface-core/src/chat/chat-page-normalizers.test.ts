import { describe, expect, it } from "vitest";
import {
  flattenThreadMessages,
  normalizeComparableAssistantContent,
  normalizeSpecialistFingerprint,
  toTitleCase,
} from "./chat-page-normalizers";

describe("chat-page-normalizers", () => {
  it("normalizes display and comparison text", () => {
    expect(normalizeComparableAssistantContent("  hello\n\nworld\t")).toBe("hello world");
    expect(toTitleCase("agentic_review-pack")).toBe("Agentic Review Pack");
    expect(normalizeSpecialistFingerprint({ role: " Senior QA ", title: "Coverage & Safety!" })).toBe(
      "senior-qa:coverage-safety",
    );
    expect(normalizeSpecialistFingerprint({})).toBe(":");
  });

  it("flattens conversation and system-notice messages in chronological order", () => {
    expect(flattenThreadMessages(null)).toEqual([]);
    expect(
      flattenThreadMessages({
        sessionId: "session-1",
        activeLeafTurnId: "turn-2",
        selectedTurnId: "turn-2",
        turns: [
          {
            turnId: "turn-1",
            userMessage: {
              messageId: "user-1",
              role: "user",
              content: "One",
              timestamp: "2026-07-15T10:00:00.000Z",
            },
            assistantMessage: {
              messageId: "assistant-1",
              role: "assistant",
              content: "Two",
              timestamp: "2026-07-15T10:00:01.000Z",
            },
          },
          {
            turnId: "turn-2",
            userMessage: {
              messageId: "user-2",
              role: "user",
              content: "Three",
              timestamp: "2026-07-15T10:02:00.000Z",
            },
          },
        ],
        systemNotices: [
          {
            noticeId: "heartbeat-1",
            message: {
              messageId: "heartbeat-1",
              role: "assistant",
              content: "Disk pressure high",
              timestamp: "2026-07-15T10:01:00.000Z",
            },
          },
        ],
      } as never).map((message) => message.messageId),
    ).toEqual(["user-1", "assistant-1", "heartbeat-1", "user-2"]);
  });

  it("preserves user-before-assistant and stable notice order when timestamps tie", () => {
    const timestamp = "2026-07-15T10:00:00.000Z";
    expect(
      flattenThreadMessages({
        sessionId: "session-1",
        turns: [
          {
            turnId: "turn-1",
            userMessage: { messageId: "z-user", timestamp },
            assistantMessage: { messageId: "a-assistant", timestamp },
          },
        ],
        systemNotices: [
          { noticeId: "notice-z", message: { messageId: "notice-z", timestamp } },
          { noticeId: "notice-a", message: { messageId: "notice-a", timestamp } },
        ],
      } as never).map((message) => message.messageId),
    ).toEqual(["z-user", "a-assistant", "notice-z", "notice-a"]);
  });
});
