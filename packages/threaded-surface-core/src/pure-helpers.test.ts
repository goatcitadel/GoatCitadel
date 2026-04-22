import { describe, expect, it } from "vitest";
import {
  formatSessionLabel,
  resolveOptimisticChatPrefs,
  resolveSelectedTurnId,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
} from "./pure-helpers";

describe("threaded-surface-core pure helpers", () => {
  it("clears the selected model when the provider changes without an explicit model patch", () => {
    const currentPrefs = {
      mode: "chat",
      planningMode: "off",
      providerId: "openai",
      model: "gpt-5.4-mini",
      webMode: "auto",
      memoryMode: "workspace",
      thinkingLevel: "balanced",
      toolAutonomy: "manual",
      visionFallbackModel: undefined,
      orchestrationEnabled: false,
      orchestrationIntensity: "normal",
      orchestrationVisibility: "summary",
      orchestrationProviderPreference: "speed",
      orchestrationReviewDepth: "standard",
      orchestrationParallelism: "balanced",
      codeAutoApply: false,
      proactiveMode: "off",
      autonomyBudget: { maxActionsPerHour: 12, maxActionsPerTurn: 4, cooldownSeconds: 30 },
      retrievalMode: "auto",
      reflectionMode: "auto",
    } as const;

    const nextPrefs = resolveOptimisticChatPrefs(currentPrefs as never, {
      providerId: "anthropic",
    });

    expect(nextPrefs.providerId).toBe("anthropic");
    expect(nextPrefs.model).toBeUndefined();
  });

  it("merges autonomy budget patches without dropping the existing budget fields", () => {
    const currentPrefs = {
      mode: "chat",
      planningMode: "off",
      providerId: "openai",
      model: "gpt-5.4-mini",
      webMode: "auto",
      memoryMode: "workspace",
      thinkingLevel: "balanced",
      toolAutonomy: "manual",
      visionFallbackModel: undefined,
      orchestrationEnabled: false,
      orchestrationIntensity: "normal",
      orchestrationVisibility: "summary",
      orchestrationProviderPreference: "speed",
      orchestrationReviewDepth: "standard",
      orchestrationParallelism: "balanced",
      codeAutoApply: false,
      proactiveMode: "off",
      autonomyBudget: { maxActionsPerHour: 12, maxActionsPerTurn: 4, cooldownSeconds: 30 },
      retrievalMode: "auto",
      reflectionMode: "auto",
    } as const;

    const nextPrefs = resolveOptimisticChatPrefs(currentPrefs as never, {
      autonomyBudget: { maxActionsPerHour: 24 },
    });

    expect(nextPrefs.autonomyBudget).toEqual({
      maxActionsPerHour: 24,
      maxActionsPerTurn: 4,
      cooldownSeconds: 30,
    });
  });

  it("prefers a matching pending route turn before current or selected turn ids", () => {
    const thread = {
      selectedTurnId: "turn-selected",
      activeLeafTurnId: "turn-active",
      turns: [{ turnId: "turn-1" }, { turnId: "turn-2" }, { turnId: "turn-route" }],
    };

    expect(resolveSelectedTurnId(thread, "turn-2", "turn-route")).toBe("turn-route");
    expect(resolveSelectedTurnId(thread, "turn-2", "turn-missing")).toBe("turn-2");
  });

  it("keeps the local streamed assistant message until fetched messages contain the finalized content", () => {
    const currentMessages = [{ messageId: "placeholder-1", role: "assistant", content: "Thinking..." }];
    const finalizedMessage = {
      sessionId: "session-1",
      placeholderId: "placeholder-1",
      content: "Finished answer",
    };

    expect(
      shouldApplyFetchedMessagesAfterStream(currentMessages as never, currentMessages as never, finalizedMessage),
    ).toBe(false);

    expect(
      shouldApplyFetchedMessagesAfterStream(
        currentMessages as never,
        [{ messageId: "assistant-1", role: "assistant", content: "Finished answer" }] as never,
        finalizedMessage,
      ),
    ).toBe(true);
  });

  it("only treats slash-prefixed send actions as local chat commands", () => {
    expect(shouldExecuteLocalChatCommand("send", "/help")).toBe(true);
    expect(shouldExecuteLocalChatCommand("send", "normal message")).toBe(false);
    expect(shouldExecuteLocalChatCommand("retry", "/help")).toBe(false);
  });

  it("formats fallback mission and external labels for machine-generated session titles", () => {
    expect(
      formatSessionLabel({
        sessionId: "mission-session-abc123",
        sessionKey: "mission:chat_123",
        title: "mission:chat_123",
        scope: "mission",
      } as never),
    ).toBe("Mission chat - abc123");

    expect(
      formatSessionLabel({
        sessionId: "external-session-xyz789",
        sessionKey: "external:operator:chat_1",
        title: "external:operator:chat_1",
        scope: "external",
        channel: "Slack",
        account: "Support",
      } as never),
    ).toBe("External chat - Slack / Support");
  });

  it("keeps trace visibility calm for chat but always visible for non-chat surfaces", () => {
    const quietTurn = {
      trace: {
        status: "completed",
        failure: null,
        toolRuns: [],
        routing: { fallbackUsed: false },
        orchestration: null,
      },
    };

    expect(shouldShowTracePanel("chat", quietTurn as never)).toBe(false);
    expect(shouldShowTracePanel("code", quietTurn as never)).toBe(true);
  });

  it("exposes suggestions more aggressively outside chat and keeps chat proactive-aware", () => {
    expect(
      shouldShowSuggestionsPanel("chat", {
        capabilitySuggestionCount: 0,
        specialistSuggestionCount: 0,
        specialistCandidateCount: 0,
        proactiveSuggestionCount: 1,
        hasDelegationSuggestion: false,
      }),
    ).toBe(true);

    expect(
      shouldShowSuggestionsPanel("code", {
        capabilitySuggestionCount: 0,
        specialistSuggestionCount: 0,
        specialistCandidateCount: 0,
        proactiveSuggestionCount: 1,
        hasDelegationSuggestion: false,
      }),
    ).toBe(false);

    expect(
      shouldShowSuggestionsPanel("cowork", {
        capabilitySuggestionCount: 0,
        specialistSuggestionCount: 0,
        specialistCandidateCount: 0,
        proactiveSuggestionCount: 0,
        hasDelegationSuggestion: false,
      }),
    ).toBe(true);
  });

  it("only hides learned memory in chat when there is nothing to show", () => {
    expect(shouldShowLearnedMemoryPanel("chat", 0)).toBe(false);
    expect(shouldShowLearnedMemoryPanel("chat", 2)).toBe(true);
    expect(shouldShowLearnedMemoryPanel("code", 0)).toBe(true);
  });
});
