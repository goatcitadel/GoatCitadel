import { describe, expect, it, vi } from "vitest";
import {
  buildSuggestionSyncKey,
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  groupDelegatedSessionsForRail,
  isConfirmableCapabilityAction,
  parseBtwCommand,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  resolveSelectedTurnId,
  revealGeneratedArtifactInSurface,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
} from "./chat-page-pure-helpers";

describe("chat-page-pure-helpers coverage", () => {
  it("builds compact stable suggestion sync keys without full-object serialization", () => {
    const capability = {
      kind: "skill_import",
      title: "Browser research",
      summary: "Install browser support.",
      reason: "The turn needs a page inspection.",
      sourceProvider: "local",
      sourceRef: "browser",
      recommendedAction: "install_skill_enable",
      requiresUserApproval: true,
    } as const;
    const specialist = {
      candidateId: "candidate-1",
      title: "QA reviewer",
      role: "qa",
      summary: "Review the change.",
      reason: "The turn needs validation.",
      source: "runtime_gap",
      confidence: 0.8,
      suggestedStatus: "suggested",
      suggestedRoutingMode: "manual_only",
      requiresApproval: true,
      routingHints: {},
      evidence: [],
    } as const;

    expect(buildSuggestionSyncKey("turn-1", [])).toBe("turn-1:empty");
    expect(buildSuggestionSyncKey("turn-1", [capability])).toContain(
      "turn-1:cap~~skill_import~local~browser~install_skill_enable~~Browser research",
    );
    expect(buildSuggestionSyncKey("turn-1", [specialist])).toBe(
      "turn-1:spec~candidate-1~runtime_gap~suggested~manual_only~0.8~QA reviewer~qa",
    );
    expect(buildSuggestionSyncKey("turn-2", [capability])).not.toBe(buildSuggestionSyncKey("turn-1", [capability]));
  });

  it("derives refresh plans from realtime signal categories", () => {
    expect(resolveChatRefreshPlan({ eventType: "fallback_poll", reason: "poll", source: "timer" })).toEqual({
      refreshSidebar: true,
      refreshSession: "light",
    });
    expect(resolveChatRefreshPlan({ eventType: "chat_thread_updated", reason: "assistant", source: "sse" })).toEqual({
      refreshSidebar: false,
      refreshSession: "full",
    });
    expect(
      resolveChatRefreshPlan({ eventType: "chat_session_title_updated", reason: "rename", source: "sse" }),
    ).toEqual({
      refreshSidebar: true,
      refreshSession: "none",
    });
    expect(
      resolveChatRefreshPlan({ eventType: "memory_qmd_generated", reason: "learned_memory", source: "qmd" }),
    ).toEqual({
      refreshSidebar: false,
      refreshSession: "light",
    });
    expect(resolveChatRefreshPlan({ eventType: "tool_invoked", reason: "tool", source: "runtime" })).toEqual({
      refreshSidebar: false,
      refreshSession: "none",
    });
    expect(resolveChatRefreshPlan({ eventType: "session_event", reason: "quiet", source: "runtime" })).toEqual({
      refreshSidebar: false,
      refreshSession: "none",
    });
    expect(resolveChatRefreshPlan({ eventType: "custom", reason: "project renamed", source: "workspace" })).toEqual({
      refreshSidebar: true,
      refreshSession: "none",
    });
    expect(resolveChatRefreshPlan({ eventType: "custom", reason: "assistant message", source: "thread" })).toEqual({
      refreshSidebar: false,
      refreshSession: "full",
    });
    expect(resolveChatRefreshPlan({ eventType: "custom", reason: "retrieval policy", source: "prefs" })).toEqual({
      refreshSidebar: false,
      refreshSession: "light",
    });
    expect(resolveChatRefreshPlan({} as never, true)).toEqual({
      refreshSidebar: false,
      refreshSession: "none",
    });
    expect(
      resolveChatRefreshPlan({ eventType: "chat_thread_updated", reason: "mode echo", source: "prefs" }, true),
    ).toEqual({
      refreshSidebar: false,
      refreshSession: "none",
    });
  });

  it("describes confirmable capability actions and destructive session deletion", () => {
    expect(isConfirmableCapabilityAction("enable_skill")).toBe(true);
    expect(isConfirmableCapabilityAction("build_code_mode_skill_candidate")).toBe(true);
    expect(isConfirmableCapabilityAction("ignore" as never)).toBe(false);
    expect(
      getCapabilitySuggestionConfirmationCopy({
        recommendedAction: "enable_skill",
        title: "Review Skill",
      } as never),
    ).toEqual({
      title: "Enable skill",
      message: "Enable Review Skill? GoatCitadel will turn it on and then resume the original request.",
      confirmLabel: "Enable and resume",
      danger: false,
    });
    expect(
      getCapabilitySuggestionConfirmationCopy({
        recommendedAction: "install_skill_disabled",
        title: "Review Skill",
      } as never)?.confirmLabel,
    ).toBe("Install disabled");
    expect(
      getCapabilitySuggestionConfirmationCopy({
        recommendedAction: "install_skill_enable",
        title: "Hosted Skill",
        riskLevel: "high",
      } as never),
    ).toMatchObject({ title: "Install and enable hosted skill", danger: true });
    expect(
      getCapabilitySuggestionConfirmationCopy({
        recommendedAction: "add_mcp_template",
        title: "Docs MCP",
      } as never)?.message,
    ).toContain("Docs MCP");
    expect(
      getCapabilitySuggestionConfirmationCopy({
        recommendedAction: "build_code_mode_skill_candidate",
        title: "Report helper",
      } as never),
    ).toMatchObject({ title: "Build reusable capability", confirmLabel: "Stage candidate" });
    expect(getCapabilitySuggestionConfirmationCopy({ recommendedAction: "unsupported_action" } as never)).toBeNull();
    expect(getDeleteSessionConfirmationMessage("Launch chat")).toContain('Delete "Launch chat" permanently?');
  });

  it("groups delegated sessions and applies stable ordering fallbacks", () => {
    const groups = groupDelegatedSessionsForRail([
      { sessionId: "root", updatedAt: "2026-05-04T12:00:00.000Z" },
      {
        sessionId: "child-b",
        updatedAt: "2026-05-04T12:03:00.000Z",
        delegationParent: { parentSessionId: "root", index: 2 },
      },
      {
        sessionId: "child-a",
        updatedAt: "2026-05-04T12:02:00.000Z",
        delegationParent: { parentSessionId: "root", index: 1 },
      },
      {
        sessionId: "orphan-new",
        updatedAt: "2026-05-04T12:10:00.000Z",
        delegationParent: { parentSessionId: "missing" },
      },
      {
        sessionId: "orphan-old",
        updatedAt: "2026-05-04T12:05:00.000Z",
        delegationParent: { parentSessionId: "missing" },
      },
      {
        sessionId: "child-c",
        updatedAt: "not-a-date",
        delegationParent: { parentSessionId: "root" },
      },
      {
        sessionId: "child-d",
        updatedAt: "not-a-date",
        delegationParent: { parentSessionId: "root" },
      },
    ]);

    expect(groups.topLevelSessions.map((session) => session.sessionId)).toEqual(["root"]);
    expect(groups.delegatedChildrenByParentId.root?.map((session) => session.sessionId)).toEqual([
      "child-a",
      "child-b",
      "child-c",
      "child-d",
    ]);
    expect(groups.orphanDelegatedSessions.map((session) => session.sessionId)).toEqual(["orphan-new", "orphan-old"]);
    expect(groups.delegatedChildSessionIds).toEqual([
      "child-b",
      "child-a",
      "orphan-new",
      "orphan-old",
      "child-c",
      "child-d",
    ]);
  });

  it("parses /btw as a side chat command without requiring inline text", () => {
    expect(parseBtwCommand("/btw")).toEqual({ text: "" });
    expect(parseBtwCommand("   /BTW   note this outside the transcript  ")).toEqual({
      text: "note this outside the transcript",
    });
    expect(parseBtwCommand("/btw\ncarry the newline")).toEqual({ text: "carry the newline" });
    expect(parseBtwCommand("/btween this is not the command")).toBeNull();
    expect(parseBtwCommand("hello /btw")).toBeNull();
  });

  it("resolves optimistic prefs, selected turns, and post-stream reconciliation", () => {
    const currentPrefs = {
      sessionId: "session-1",
      mode: "chat",
      planningMode: "off",
      providerId: "openai",
      model: "gpt-5.5",
      imageProviderId: "google",
      imageModel: "imagen",
      visionFallbackModel: "gpt-vision",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
      toolAutonomy: "safe_auto",
      orchestrationEnabled: false,
      orchestrationIntensity: "minimal",
      orchestrationVisibility: "summarized",
      orchestrationProviderPreference: "speed",
      orchestrationReviewDepth: "off",
      orchestrationParallelism: "auto",
      codeAutoApply: "manual",
      proactiveMode: "off",
      retrievalMode: "auto",
      reflectionMode: "auto",
      createdAt: "2026-05-04T12:00:00.000Z",
      updatedAt: "2026-05-04T12:00:00.000Z",
    } as never;

    expect(
      resolveOptimisticChatPrefs(currentPrefs, {
        providerId: " anthropic ",
        imageProviderId: " ",
        visionFallbackModel: " ",
        autonomyBudget: { maxToolCalls: 4 },
      } as never),
    ).toMatchObject({
      providerId: "anthropic",
      model: undefined,
      imageProviderId: undefined,
      imageModel: undefined,
      visionFallbackModel: undefined,
      autonomyBudget: expect.objectContaining({ maxToolCalls: 4 }),
    });

    expect(resolveSelectedTurnId(null, "turn-1")).toBeNull();
    expect(resolveSelectedTurnId({ turns: [{ turnId: "turn-1" }, { turnId: "turn-2" }] }, null, "turn-2")).toBe(
      "turn-2",
    );
    expect(resolveSelectedTurnId({ turns: [{ turnId: "turn-1" }, { turnId: "turn-2" }] }, "turn-1")).toBe("turn-1");
    expect(resolveSelectedTurnId({ turns: [{ turnId: "turn-1" }] }, "missing", "also-missing")).toBe("turn-1");
    expect(
      resolveSelectedTurnId(
        { selectedTurnId: "missing", activeLeafTurnId: "turn-1", turns: [{ turnId: "turn-1" }] },
        null,
      ),
    ).toBe("missing");

    const currentMessages = [{ messageId: "placeholder-1", role: "assistant", content: "Draft answer" }] as never;
    expect(shouldApplyFetchedMessagesAfterStream([], [], null)).toBe(true);
    expect(
      shouldApplyFetchedMessagesAfterStream(currentMessages, [], {
        sessionId: "session-1",
        placeholderId: "placeholder-1",
        content: "",
      }),
    ).toBe(true);
    expect(
      shouldApplyFetchedMessagesAfterStream(
        currentMessages,
        [{ messageId: "message-1", role: "assistant", content: "Done" }] as never,
        {
          sessionId: "session-1",
          placeholderId: "placeholder-1",
          messageId: "message-1",
          content: "Done",
        },
      ),
    ).toBe(true);
    expect(
      shouldApplyFetchedMessagesAfterStream(
        currentMessages,
        [{ messageId: "other", role: "assistant", content: "Draft   answer" }] as never,
        {
          sessionId: "session-1",
          placeholderId: "placeholder-1",
          content: "Draft answer",
        },
      ),
    ).toBe(true);
    expect(
      shouldApplyFetchedMessagesAfterStream(
        [{ messageId: "other-placeholder", role: "assistant", content: "Draft answer" }] as never,
        [{ messageId: "message-1", role: "assistant", content: "Done" }] as never,
        {
          sessionId: "session-1",
          placeholderId: "missing-placeholder",
          content: "Done",
        },
      ),
    ).toBe(true);
    expect(
      shouldApplyFetchedMessagesAfterStream(
        currentMessages,
        [{ messageId: "other", role: "assistant", content: "Different" }] as never,
        {
          sessionId: "session-1",
          placeholderId: "placeholder-1",
          content: "Draft answer",
        },
      ),
    ).toBe(false);
    expect(shouldExecuteLocalChatCommand("send" as never, " /memory rebuild")).toBe(true);
    expect(shouldExecuteLocalChatCommand("retry" as never, "/memory rebuild")).toBe(false);
  });

  it("reveals generated artifacts and keeps recent artifacts first", async () => {
    const loadSessionCoreState = vi.fn(async () => undefined);
    const setSessionRailOpen = vi.fn();
    const setDockOpen = vi.fn();
    const setActiveGeneratedArtifact = vi.fn();
    const setSelectedTurnId = vi.fn();
    const handleNavigateSurface = vi.fn();
    let generatedArtifacts = {
      items: [
        { artifactId: "artifact-2", sessionId: "session-1", turnId: "turn-2" },
        { artifactId: "artifact-1", sessionId: "session-1", turnId: "turn-1" },
      ],
    };
    const setGeneratedArtifacts = vi.fn((updater) => {
      generatedArtifacts = updater(generatedArtifacts);
    });
    const artifact = {
      artifactId: "artifact-1",
      sessionId: "session-1",
      turnId: "turn-1",
      kind: "text",
      title: "Draft",
      createdAt: "2026-05-04T12:00:00.000Z",
      updatedAt: "2026-05-04T12:00:00.000Z",
    };

    await revealGeneratedArtifactInSurface({
      artifact: artifact as never,
      compactSurfaceLayout: true,
      messageMode: "code",
      loadSessionCoreState,
      setSessionRailOpen,
      setDockOpen,
      setActiveGeneratedArtifact,
      setSelectedTurnId,
      setGeneratedArtifacts,
      handleNavigateSurface,
    });

    expect(setSessionRailOpen).toHaveBeenCalledWith(false);
    expect(setDockOpen).toHaveBeenCalledWith(false);
    expect(setActiveGeneratedArtifact).toHaveBeenCalledWith(artifact);
    expect(setSelectedTurnId).toHaveBeenCalledWith("turn-1");
    expect(loadSessionCoreState).toHaveBeenCalledWith("session-1", { background: true, includeThread: true });
    expect(generatedArtifacts.items.map((item) => item.artifactId)).toEqual(["artifact-1", "artifact-2"]);
    expect(handleNavigateSurface).toHaveBeenCalledWith("code", {
      sessionId: "session-1",
      turnId: "turn-1",
      artifactId: "artifact-1",
    });

    await revealGeneratedArtifactInSurface({
      artifact: { ...artifact, artifactId: "artifact-3" } as never,
      compactSurfaceLayout: false,
      messageMode: "chat",
      loadSessionCoreState,
      setSessionRailOpen,
      setDockOpen,
      setActiveGeneratedArtifact,
      setSelectedTurnId,
      setGeneratedArtifacts: vi.fn((updater) => {
        expect(updater(null)).toBeNull();
      }),
      handleNavigateSurface,
    });
    expect(setSessionRailOpen).toHaveBeenCalledTimes(1);
    expect(setDockOpen).toHaveBeenCalledTimes(1);
  });
});
