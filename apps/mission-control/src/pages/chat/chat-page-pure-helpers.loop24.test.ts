import type { ChatGeneratedArtifactRecord, ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  isConfirmableCapabilityAction,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  revealGeneratedArtifactInSurface,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
} from "./chat-page-pure-helpers";

function makePrefs(overrides: Partial<ChatSessionPrefsRecord> = {}): ChatSessionPrefsRecord {
  return {
    sessionId: "session-1",
    mode: "chat",
    planningMode: "off",
    providerId: "openai",
    model: "gpt-5.4-mini",
    imageProviderId: "openai",
    imageModel: "gpt-image-2",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    visionFallbackModel: "gpt-5.4-vision",
    orchestrationEnabled: true,
    orchestrationIntensity: "minimal",
    orchestrationVisibility: "summarized",
    orchestrationProviderPreference: "speed",
    orchestrationReviewDepth: "off",
    orchestrationParallelism: "auto",
    codeAutoApply: "manual",
    proactiveMode: "auto_safe",
    autonomyBudget: {
      maxActionsPerHour: 6,
      maxActionsPerTurn: 2,
      cooldownSeconds: 60,
    },
    retrievalMode: "standard",
    reflectionMode: "off",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

function makeAssistantMessage(messageId: string, content: string) {
  return {
    messageId,
    sessionId: "session-1",
    role: "assistant" as const,
    actorType: "agent" as const,
    actorId: "assistant",
    content,
    timestamp: "2026-05-14T00:00:00.000Z",
  };
}

function makeArtifact(overrides: Partial<ChatGeneratedArtifactRecord> = {}): ChatGeneratedArtifactRecord {
  return {
    artifactId: "artifact-1",
    sessionId: "session-artifact",
    workspaceId: "default",
    turnId: "turn-artifact",
    title: "Generated patch",
    kind: "code",
    content: "export const ok = true;",
    language: "ts",
    sourceSurface: "code",
    version: 1,
    providerId: "openai",
    model: "gpt-5.4-mini",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("chat-page-pure-helpers loop 24 coverage", () => {
  it("classifies explicit refresh topics and heuristic fallbacks without over-refreshing preference echoes", () => {
    expect(resolveChatRefreshPlan({ eventType: "fallback_poll", reason: "timer", source: "poller" })).toEqual({
      refreshSidebar: true,
      refreshSession: "light",
    });
    expect(
      resolveChatRefreshPlan(
        { eventType: "chat_session_updated", reason: "proactive policy saved", source: "operator" },
        true,
      ),
    ).toEqual({
      refreshSidebar: false,
      refreshSession: "none",
    });
    expect(resolveChatRefreshPlan({ eventType: "memory_qmd_generated", reason: "memory", source: "gateway" })).toEqual({
      refreshSidebar: false,
      refreshSession: "light",
    });
    expect(resolveChatRefreshPlan({ eventType: "session_event", reason: "tool heartbeat", source: "runtime" })).toEqual(
      {
        refreshSidebar: false,
        refreshSession: "none",
      },
    );
    expect(
      resolveChatRefreshPlan({
        eventType: "custom",
        reason: "workspace binding renamed after assistant message",
        source: "gateway",
      }),
    ).toEqual({
      refreshSidebar: true,
      refreshSession: "full",
    });
    expect(
      resolveChatRefreshPlan({ eventType: "custom", reason: "retrieval policy changed", source: "gateway" }),
    ).toEqual({
      refreshSidebar: false,
      refreshSession: "light",
    });
  });

  it("returns confirmation copy for every confirmable capability action", () => {
    expect(isConfirmableCapabilityAction("enable_skill")).toBe(true);
    expect(isConfirmableCapabilityAction("switch_tool_profile")).toBe(false);
    expect(
      getCapabilitySuggestionConfirmationCopy({
        recommendedAction: "enable_skill",
        title: "Filesystem",
        riskLevel: "low",
      } as any),
    ).toMatchObject({
      title: "Enable skill",
      confirmLabel: "Enable and resume",
      danger: false,
    });
    expect(
      getCapabilitySuggestionConfirmationCopy({
        recommendedAction: "install_skill_disabled",
        title: "Browser",
        riskLevel: "medium",
      } as any),
    ).toMatchObject({
      title: "Install skill for review",
      confirmLabel: "Install disabled",
    });
    expect(
      getCapabilitySuggestionConfirmationCopy({
        recommendedAction: "install_skill_enable",
        title: "Hosted Files",
        riskLevel: "high",
      } as any),
    ).toMatchObject({
      title: "Install and enable hosted skill",
      danger: true,
    });
    expect(
      getCapabilitySuggestionConfirmationCopy({
        recommendedAction: "add_mcp_template",
        title: "Linear",
        riskLevel: "low",
      } as any),
    ).toMatchObject({
      title: "Add MCP template",
      confirmLabel: "Add template",
      danger: false,
    });
    expect(
      getCapabilitySuggestionConfirmationCopy({
        recommendedAction: "switch_tool_profile",
        title: "Review profile",
        riskLevel: "medium",
      } as any),
    ).toBeNull();
    expect(getDeleteSessionConfirmationMessage("Operator review")).toBe(
      'Delete "Operator review" permanently? This removes its messages, traces, session history, and attached files.',
    );
  });

  it("normalizes optimistic preference patches and preserves preset autonomy defaults", () => {
    const next = resolveOptimisticChatPrefs(makePrefs({ autonomyBudget: undefined }), {
      providerId: "   ",
      model: "   ",
      imageProviderId: "google",
      imageModel: "   ",
      visionFallbackModel: "   ",
      autonomyBudget: {
        maxActionsPerTurn: 9,
      },
      retrievalMode: "layered",
    });

    expect(next.providerId).toBeUndefined();
    expect(next.model).toBeUndefined();
    expect(next.imageProviderId).toBe("google");
    expect(next.imageModel).toBeUndefined();
    expect(next.visionFallbackModel).toBeUndefined();
    expect(next.autonomyBudget).toEqual({
      maxActionsPerHour: 6,
      maxActionsPerTurn: 9,
      cooldownSeconds: 60,
    });
    expect(next.retrievalMode).toBe("layered");
  });

  it("protects finalized stream messages until fetched messages contain an equivalent assistant reply", () => {
    expect(
      shouldApplyFetchedMessagesAfterStream([], [makeAssistantMessage("assistant-1", "Done")], {
        sessionId: "session-1",
        placeholderId: "placeholder-1",
        content: "Done",
      }),
    ).toBe(true);
    expect(
      shouldApplyFetchedMessagesAfterStream(
        [makeAssistantMessage("placeholder-1", "Draft reply")],
        [makeAssistantMessage("assistant-older", "Different reply")],
        {
          sessionId: "session-1",
          placeholderId: "placeholder-1",
          content: "Draft reply",
        },
      ),
    ).toBe(false);
    expect(
      shouldApplyFetchedMessagesAfterStream(
        [makeAssistantMessage("placeholder-1", "Draft reply")],
        [makeAssistantMessage("assistant-2", "Draft   reply")],
        {
          sessionId: "session-1",
          placeholderId: "placeholder-1",
          content: "Draft reply",
        },
      ),
    ).toBe(true);
    expect(
      shouldApplyFetchedMessagesAfterStream(
        [makeAssistantMessage("placeholder-1", "")],
        [makeAssistantMessage("assistant-2", "")],
        {
          sessionId: "session-1",
          placeholderId: "placeholder-1",
          content: "   ",
        },
      ),
    ).toBe(true);
  });

  it("reveals generated artifacts without mutating compact shell controls on roomy layouts", async () => {
    const artifact = makeArtifact();
    const olderDuplicate = makeArtifact({ artifactId: "artifact-1", title: "Old copy" });
    const otherArtifact = makeArtifact({ artifactId: "artifact-2", title: "Other artifact" });
    const loadSessionCoreState = vi.fn(async () => undefined);
    const setSessionRailOpen = vi.fn();
    const setDockOpen = vi.fn();
    const setActiveGeneratedArtifact = vi.fn();
    const setSelectedTurnId = vi.fn();
    let generatedArtifacts: { items: ChatGeneratedArtifactRecord[] } | null = {
      items: [otherArtifact, olderDuplicate],
    };
    const setGeneratedArtifacts = vi.fn((updater) => {
      generatedArtifacts = updater(generatedArtifacts);
    });
    const handleNavigateSurface = vi.fn();

    expect(shouldExecuteLocalChatCommand("send", " /goal status")).toBe(true);
    expect(shouldExecuteLocalChatCommand("retry", " /goal status")).toBe(false);

    await revealGeneratedArtifactInSurface({
      artifact,
      compactSurfaceLayout: false,
      messageMode: "code",
      loadSessionCoreState,
      setSessionRailOpen,
      setDockOpen,
      setActiveGeneratedArtifact,
      setSelectedTurnId,
      setGeneratedArtifacts,
      handleNavigateSurface,
    });

    expect(setSessionRailOpen).not.toHaveBeenCalled();
    expect(setDockOpen).not.toHaveBeenCalled();
    expect(setActiveGeneratedArtifact).toHaveBeenCalledWith(artifact);
    expect(setSelectedTurnId).toHaveBeenCalledWith("turn-artifact");
    expect(loadSessionCoreState).toHaveBeenCalledWith("session-artifact", {
      background: true,
      includeThread: true,
    });
    expect(generatedArtifacts?.items.map((item) => item.artifactId)).toEqual(["artifact-1", "artifact-2"]);
    expect(generatedArtifacts?.items[0]).toBe(artifact);
    expect(handleNavigateSurface).toHaveBeenCalledWith("code", {
      sessionId: "session-artifact",
      turnId: "turn-artifact",
      artifactId: "artifact-1",
    });
  });
});
