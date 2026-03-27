import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "@goatcitadel/contracts";
import {
  formatSessionLabel,
  looksMachineSessionLabel,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldApplyFetchedMessagesAfterStream,
  shouldShowTracePanel,
} from "./ChatPage";
import type { ChatThreadResponse } from "@goatcitadel/contracts";

function makeMessage(
  messageId: string,
  role: "user" | "assistant",
  content: string,
): ChatMessageRecord {
  return {
    messageId,
    sessionId: "sess-1",
    role,
    actorType: role === "user" ? "user" : "agent",
    actorId: role === "user" ? "operator" : "assistant",
    content,
    timestamp: "2026-03-06T00:00:00.000Z",
  };
}

function makeSession(
  overrides: Partial<Parameters<typeof formatSessionLabel>[0]> = {},
): Parameters<typeof formatSessionLabel>[0] {
  return {
    sessionId: "sess_123456",
    sessionKey: "mission:operator:chat_123456",
    workspaceId: "default",
    scope: "mission",
    origin: "operator",
    includeInHistory: true,
    title: undefined,
    pinned: false,
    lifecycleStatus: "active",
    archivedAt: undefined,
    projectId: undefined,
    projectName: undefined,
    channel: "mission",
    account: "operator",
    updatedAt: "2026-03-06T00:00:00.000Z",
    lastActivityAt: "2026-03-06T00:00:00.000Z",
    tokenTotal: 0,
    costUsdTotal: 0,
    ...overrides,
  };
}

describe("chat session rail labels", () => {
  it("detects machine-generated labels", () => {
    expect(looksMachineSessionLabel(undefined, "mission:operator:chat_123456")).toBe(true);
    expect(looksMachineSessionLabel("mission:operator:chat_123456", "mission:operator:chat_123456")).toBe(true);
    expect(looksMachineSessionLabel("external:slack:thread_1")).toBe(true);
    expect(looksMachineSessionLabel(":operator:chat_abcdef")).toBe(true);
    expect(looksMachineSessionLabel("Release checklist", "mission:operator:chat_123456")).toBe(false);
  });

  it("formats human and fallback labels for the session rail", () => {
    expect(formatSessionLabel(makeSession({
      title: "Release checklist",
    }))).toBe("Release checklist");

    expect(formatSessionLabel(makeSession({
      title: "mission:operator:chat_123456",
    }))).toBe("Mission chat - 123456");

    expect(formatSessionLabel(makeSession({
      sessionId: "sess_654321",
      sessionKey: "external:slack:thread_1",
      scope: "external",
      title: "external:slack:thread_1",
      channel: "slack",
      account: "ops",
    }))).toBe("External chat - slack / ops");
  });
});

describe("shouldApplyFetchedMessagesAfterStream", () => {
  it("rejects stale fetched messages that would wipe a finalized streamed assistant reply", () => {
    const current = [
      makeMessage("user-1", "user", "what's going on with Kristi Noem lately?"),
      makeMessage("assistant-1", "assistant", "Latest news summary"),
    ];
    const fetched = [
      makeMessage("user-1", "user", "what's going on with Kristi Noem lately?"),
    ];

    expect(shouldApplyFetchedMessagesAfterStream(current, fetched, {
      sessionId: "sess-1",
      placeholderId: "stream-1",
      messageId: "assistant-1",
      content: "Latest news summary",
    })).toBe(false);
  });

  it("rejects fetched messages with matching content but the wrong assistant message id", () => {
    const current = [
      makeMessage("user-1", "user", "what's going on with Kristi Noem lately?"),
      makeMessage("assistant-1", "assistant", "Latest news summary"),
    ];
    const fetched = [
      makeMessage("user-1", "user", "what's going on with Kristi Noem lately?"),
      makeMessage("assistant-older", "assistant", "Latest   news   summary"),
    ];

    expect(shouldApplyFetchedMessagesAfterStream(current, fetched, {
      sessionId: "sess-1",
      placeholderId: "stream-1",
      messageId: "assistant-1",
      content: "Latest news summary",
    })).toBe(false);
  });

  it("accepts fetched messages once the persisted assistant reply matches the finalized streamed message id", () => {
    const current = [
      makeMessage("user-1", "user", "what's going on with Kristi Noem lately?"),
      makeMessage("assistant-1", "assistant", "Latest news summary"),
    ];
    const fetched = [
      makeMessage("user-1", "user", "what's going on with Kristi Noem lately?"),
      makeMessage("assistant-1", "assistant", "Latest   news   summary"),
    ];

    expect(shouldApplyFetchedMessagesAfterStream(current, fetched, {
      sessionId: "sess-1",
      placeholderId: "stream-1",
      messageId: "assistant-1",
      content: "Latest news summary",
    })).toBe(true);
  });

  it("accepts fetched messages when there is no finalized streamed placeholder to protect", () => {
    const current = [
      makeMessage("user-1", "user", "hello"),
    ];
    const fetched = [
      makeMessage("user-1", "user", "hello"),
      makeMessage("assistant-1", "assistant", "hi"),
    ];

    expect(shouldApplyFetchedMessagesAfterStream(current, fetched, null)).toBe(true);
  });
});

function makeTurn(
  overrides: Partial<ChatThreadResponse["turns"][number]["trace"]> = {},
): ChatThreadResponse["turns"][number] {
  return {
    turnId: "turn-1",
    branchKind: "append",
    userMessage: makeMessage("user-1", "user", "hello"),
    assistantMessage: makeMessage("assistant-1", "assistant", "hi"),
    trace: {
      turnId: "turn-1",
      sessionId: "sess-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      branchKind: "append",
      status: "completed",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: "2026-03-08T00:00:00.000Z",
      finishedAt: "2026-03-08T00:00:01.000Z",
      toolRuns: [],
      citations: [],
      routing: {},
      ...overrides,
    },
    toolRuns: [],
    citations: [],
    branch: {
      siblingTurnIds: ["turn-1"],
      activeSiblingIndex: 0,
      siblingCount: 1,
      isSelectedPath: true,
      newestLeafTurnId: "turn-1",
    },
  };
}

describe("Wave 2 surface helpers", () => {
  it("keeps normal chat trace panels hidden unless something notable happened", () => {
    expect(shouldShowTracePanel("chat", makeTurn())).toBe(false);
    expect(shouldShowTracePanel("chat", makeTurn({
      toolRuns: [
        {
          toolRunId: "tool-1",
          turnId: "turn-1",
          sessionId: "sess-1",
          toolName: "browser.navigate",
          status: "failed",
          startedAt: "2026-03-08T00:00:00.200Z",
        },
      ],
    }))).toBe(true);
    expect(shouldShowTracePanel("cowork", makeTurn())).toBe(true);
  });

  it("shows suggestions only where they materially help", () => {
    expect(shouldShowSuggestionsPanel("chat", {
      capabilitySuggestionCount: 0,
      specialistSuggestionCount: 0,
      specialistCandidateCount: 0,
      proactiveSuggestionCount: 0,
      hasDelegationSuggestion: false,
    })).toBe(false);
    expect(shouldShowSuggestionsPanel("chat", {
      capabilitySuggestionCount: 1,
      specialistSuggestionCount: 0,
      specialistCandidateCount: 0,
      proactiveSuggestionCount: 0,
      hasDelegationSuggestion: false,
    })).toBe(true);
    expect(shouldShowSuggestionsPanel("code", {
      capabilitySuggestionCount: 0,
      specialistSuggestionCount: 0,
      specialistCandidateCount: 0,
      proactiveSuggestionCount: 2,
      hasDelegationSuggestion: true,
    })).toBe(false);
    expect(shouldShowSuggestionsPanel("code", {
      capabilitySuggestionCount: 0,
      specialistSuggestionCount: 1,
      specialistCandidateCount: 0,
      proactiveSuggestionCount: 0,
      hasDelegationSuggestion: false,
    })).toBe(true);
    expect(shouldShowSuggestionsPanel("cowork", {
      capabilitySuggestionCount: 0,
      specialistSuggestionCount: 0,
      specialistCandidateCount: 0,
      proactiveSuggestionCount: 0,
      hasDelegationSuggestion: false,
    })).toBe(true);
  });

  it("keeps learned memory off the chat surface until there is something to review", () => {
    expect(shouldShowLearnedMemoryPanel("chat", 0)).toBe(false);
    expect(shouldShowLearnedMemoryPanel("chat", 2)).toBe(true);
    expect(shouldShowLearnedMemoryPanel("cowork", 0)).toBe(true);
    expect(shouldShowLearnedMemoryPanel("code", 0)).toBe(true);
  });
});
