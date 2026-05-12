import { describe, expect, it, vi } from "vitest";
import {
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  isConfirmableCapabilityAction,
  resolveChatRefreshPlan,
  revealGeneratedArtifactInSurface,
} from "./chat-page-pure-helpers";

describe("chat-page-pure-helpers coverage", () => {
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
    expect(
      resolveChatRefreshPlan({ eventType: "chat_thread_updated", reason: "mode echo", source: "prefs" }, true),
    ).toEqual({
      refreshSidebar: false,
      refreshSession: "none",
    });
  });

  it("describes confirmable capability actions and destructive session deletion", () => {
    expect(isConfirmableCapabilityAction("enable_skill")).toBe(true);
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
    expect(getCapabilitySuggestionConfirmationCopy({ recommendedAction: "none" } as never)).toBeNull();
    expect(getDeleteSessionConfirmationMessage("Launch chat")).toContain('Delete "Launch chat" permanently?');
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
