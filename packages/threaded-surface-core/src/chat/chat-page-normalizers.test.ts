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

  it("flattens user and assistant messages from thread turns", () => {
    expect(flattenThreadMessages(null)).toEqual([]);
    expect(
      flattenThreadMessages({
        sessionId: "session-1",
        activeLeafTurnId: "turn-2",
        selectedTurnId: "turn-2",
        turns: [
          {
            turnId: "turn-1",
            userMessage: { messageId: "user-1", role: "user", content: "One" },
            assistantMessage: { messageId: "assistant-1", role: "assistant", content: "Two" },
          },
          {
            turnId: "turn-2",
            userMessage: { messageId: "user-2", role: "user", content: "Three" },
          },
        ],
      } as never).map((message) => message.messageId),
    ).toEqual(["user-1", "assistant-1", "user-2"]);
  });
});
