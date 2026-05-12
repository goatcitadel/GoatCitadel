import { describe, expect, it } from "vitest";

import {
  flattenThreadMessages,
  normalizeComparableAssistantContent,
  normalizeSpecialistFingerprint,
  toTitleCase,
} from "./chat-page-normalizers";

describe("chat-page-normalizers", () => {
  it("normalizes assistant content, titles, and specialist fingerprints", () => {
    expect(normalizeComparableAssistantContent("  hello\n\nworld\t ")).toBe("hello world");
    expect(normalizeComparableAssistantContent(undefined)).toBe("");
    expect(toTitleCase("senior_security-reviewer role")).toBe("Senior Security Reviewer Role");
    expect(toTitleCase("___")).toBe("");
    expect(normalizeSpecialistFingerprint({ role: " QA Lead ", title: "Threat / Review!!" })).toBe(
      "qa-lead:threat-review",
    );
    expect(normalizeSpecialistFingerprint({})).toBe(":");
  });

  it("flattens user and assistant thread messages in turn order", () => {
    expect(flattenThreadMessages(null)).toEqual([]);

    const userOne = { messageId: "user-1", role: "user", content: "one" };
    const assistantOne = { messageId: "assistant-1", role: "assistant", content: "reply" };
    const userTwo = { messageId: "user-2", role: "user", content: "two" };
    expect(
      flattenThreadMessages({
        sessionId: "session-1",
        activeLeafTurnId: "turn-2",
        turns: [
          { turnId: "turn-1", userMessage: userOne, assistantMessage: assistantOne },
          { turnId: "turn-2", userMessage: userTwo, assistantMessage: null },
        ],
      } as never),
    ).toEqual([userOne, assistantOne, userTwo]);
  });
});
