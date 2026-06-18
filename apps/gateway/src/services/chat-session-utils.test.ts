import { describe, expect, it } from "vitest";
import {
  assertChatSessionActive,
  buildChatSessionUpdatedPayload,
  deriveChatSessionTitleFromContent,
  shouldAllowCrossProviderFallback,
} from "./chat-session-utils.js";

describe("chat session utils", () => {
  it("blocks archived sessions with the standard error message", () => {
    expect(() => assertChatSessionActive("sess-1", "active")).not.toThrow();
    expect(() => assertChatSessionActive("sess-1", "archived")).toThrow("Session sess-1 is archived");
  });

  it("derives sanitized first-line titles for untitled sessions", () => {
    expect(deriveChatSessionTitleFromContent("1.   First useful title\nMore detail")).toBe("First useful title");
    expect(deriveChatSessionTitleFromContent("   \n\n-    ")).toBeUndefined();
    expect(deriveChatSessionTitleFromContent(`# ${"A".repeat(100)}`)).toBe("A".repeat(72));
  });

  it("only blocks cross-provider fallback when the provider is explicitly pinned", () => {
    expect(shouldAllowCrossProviderFallback({})).toBe(true);
    expect(shouldAllowCrossProviderFallback({ providerId: "openai" })).toBe(false);
    expect(shouldAllowCrossProviderFallback({ model: "gpt-4.1-mini" })).toBe(true);
    expect(shouldAllowCrossProviderFallback({ providerId: "openai", model: "gpt-4.1-mini" })).toBe(false);
  });

  it("builds consistent realtime payloads for session update events", () => {
    expect(
      buildChatSessionUpdatedPayload("chat_session_pinned", {
        sessionId: "sess-1",
        pinned: true,
        lifecycleStatus: "active",
        archivedAt: undefined,
        projectId: undefined,
      }),
    ).toEqual({
      type: "chat_session_pinned",
      sessionId: "sess-1",
      pinned: true,
    });

    expect(
      buildChatSessionUpdatedPayload("chat_session_archived", {
        sessionId: "sess-1",
        pinned: false,
        lifecycleStatus: "archived",
        archivedAt: "2026-03-07T00:00:00.000Z",
        projectId: undefined,
      }),
    ).toEqual({
      type: "chat_session_archived",
      sessionId: "sess-1",
      lifecycleStatus: "archived",
      archivedAt: "2026-03-07T00:00:00.000Z",
    });

    expect(
      buildChatSessionUpdatedPayload("chat_session_project_assigned", {
        sessionId: "sess-1",
        pinned: false,
        lifecycleStatus: "active",
        archivedAt: undefined,
        projectId: "project-1",
      }),
    ).toEqual({
      type: "chat_session_project_assigned",
      sessionId: "sess-1",
      projectId: "project-1",
    });
  });
});
