import React from "react";
import { getChatModePreset } from "@goatcitadel/contracts";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatContextDockPanels } from "./ChatContextDockPanels";

function buildProps(overrides: Partial<Parameters<typeof ChatContextDockPanels>[0]> = {}) {
  return {
    mode: "chat" as const,
    dockOpen: true,
    dockSectionStyle: () => ({ order: 0 }),
    isChatSurface: true,
    isCoworkSurface: false,
    isCodeSurface: false,
    activeModePreset: getChatModePreset("chat"),
    planningMode: "off" as const,
    effectiveToolAutonomy: "safe_auto" as const,
    codeModeNeedsProjectBinding: false,
    selectedSession: {
      sessionId: "session-1",
      pinned: false,
      lifecycleStatus: "active",
      scope: "mission",
    } as any,
    selectedProject: null,
    sending: false,
    sessionControlPending: null,
    providerOptions: [],
    selectedProviderId: undefined,
    selectedModel: undefined,
    streamEnabled: true,
    onStreamEnabledChange: vi.fn(),
    prefs: { webMode: "auto", thinkingLevel: "standard", orchestrationEnabled: true } as any,
    selectedSessionId: "session-1",
    showTracePanel: true,
    selectedTurn: {
      trace: {
        status: "completed",
        mode: "chat",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: "2026-04-08T00:00:00.000Z",
        finishedAt: "2026-04-08T00:00:01.000Z",
        toolRuns: [],
        citations: [],
        routing: {},
        capabilityUpgradeSuggestions: [],
        specialistCandidateSuggestions: [],
      },
    } as any,
    showSuggestionsPanel: true,
    showLearnedMemoryPanel: true,
    latestOrchestration: null,
    coworkItems: [],
    proactiveStatus: null,
    proactiveRuns: [],
    proactiveSuggestionCount: 0,
    capabilitySuggestions: [],
    specialistSuggestions: [],
    specialistCandidates: [],
    delegationSuggestion: null,
    learnedMemory: [],
    secondaryLoading: false,
    binding: null,
    integrationConnectionId: "",
    integrationTarget: "",
    selectedSessionProjectValue: "none",
    projectOptions: [{ value: "none", label: "Unassigned" }],
    loadModelsForProvider: vi.fn(async () => []),
    getCachedModels: vi.fn(() => []),
    resolveProviderModelSelection: vi.fn(() => ({ model: undefined })),
    onPrefPatch: vi.fn(async () => undefined),
    onSuggestDelegation: vi.fn(async () => undefined),
    onTriggerProactive: vi.fn(async () => undefined),
    onProactivePolicyPatch: vi.fn(async () => undefined),
    onRunCodeDelegation: vi.fn(async () => undefined),
    onCapabilitySuggestionAction: vi.fn(),
    onCreateSpecialistDraft: vi.fn(async () => undefined),
    onActivateCatalogSpecialist: vi.fn(async () => undefined),
    onSpecialistCandidatePatch: vi.fn(async () => undefined),
    onAcceptDelegation: vi.fn(async () => undefined),
    onRebuildLearnedMemory: vi.fn(async () => undefined),
    onUpdateMemoryStatus: vi.fn(async () => undefined),
    onRenameTitleChange: vi.fn(),
    renameTitle: "Release checklist",
    onRenameSession: vi.fn(async () => undefined),
    onTogglePinSession: vi.fn(async () => undefined),
    onToggleArchiveSession: vi.fn(async () => undefined),
    onDeleteSession: vi.fn(),
    onAssignProject: vi.fn(async () => undefined),
    onIntegrationConnectionIdChange: vi.fn(),
    onIntegrationTargetChange: vi.fn(),
    onSaveExternalBinding: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("ChatContextDockPanels", () => {
  it("renders mission trace and session controls without the external binding panel for mission sessions", () => {
    const renderer = create(<ChatContextDockPanels {...buildProps()} />);

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Run status");
    expect(text).toContain("Session management");
    expect(text).not.toContain("External connection binding");
    expect(text).not.toContain("Cowork Canvas");
    expect(text).not.toContain("Code Workbench");
  });

  it("routes suggestion actions through the composed dock sections", async () => {
    const onCapabilitySuggestionAction = vi.fn();
    const onCreateSpecialistDraft = vi.fn(async () => undefined);
    const onActivateCatalogSpecialist = vi.fn(async () => undefined);
    const onAcceptDelegation = vi.fn(async () => undefined);
    const renderer = create(
      <ChatContextDockPanels
        {...buildProps({
          mode: "cowork",
          isChatSurface: false,
          isCoworkSurface: true,
          proactiveSuggestionCount: 2,
          capabilitySuggestions: [
            {
              kind: "existing_but_disabled",
              title: "Filesystem skill",
              summary: "Enable file access",
              reason: "Needed for this task",
              recommendedAction: "enable_skill",
              requiresUserApproval: true,
              candidateId: "skill-1",
            } as any,
          ],
          specialistSuggestions: [
            {
              title: "Research specialist",
              role: "Researcher",
              summary: "Handles web research",
            } as any,
            {
              candidateId: "catalog-frontend",
              title: "Frontend Developer",
              role: "frontend-developer",
              summary: "Imported Agency specialist",
              reason: "Imported Agency specialist from engineering.",
              source: "catalog",
            } as any,
          ],
          delegationSuggestion: {
            suggestionId: "suggestion-1",
            sessionId: "session-1",
            objective: "Split the work across research and implementation roles.",
            mode: "sequential",
            confidence: 0.8,
            reason: "Split the work across research and implementation roles.",
            roles: ["Researcher", "Coder"],
            source: "manual",
            createdAt: "2026-04-08T00:00:00.000Z",
          },
          onCapabilitySuggestionAction,
          onCreateSpecialistDraft,
          onActivateCatalogSpecialist,
          onAcceptDelegation,
        })}
      />,
    );

    const buttons = renderer.root.findAllByType("button");
    const clickButton = async (label: string) => {
      const button = buttons.find((candidate) => {
        const children = candidate.props.children;
        return Array.isArray(children) ? children.join("") === label : children === label;
      });
      expect(button).toBeDefined();
      await act(async () => {
        await button?.props.onClick?.();
      });
    };

    await clickButton("Enable skill");
    await clickButton("Draft dormant specialist");
    await clickButton("Activate for session");
    await clickButton("Accept plan");

    expect(onCapabilitySuggestionAction).toHaveBeenCalledTimes(1);
    expect(onCreateSpecialistDraft).toHaveBeenCalledTimes(1);
    expect(onActivateCatalogSpecialist).toHaveBeenCalledTimes(1);
    expect(onAcceptDelegation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Cowork Canvas");
  });

  it("renders the external binding panel for external sessions inside the session grouping", () => {
    const renderer = create(
      <ChatContextDockPanels
        {...buildProps({
          selectedSession: {
            sessionId: "session-1",
            pinned: false,
            lifecycleStatus: "active",
            scope: "external",
          } as any,
        })}
      />,
    );

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("External connection binding");
  });

  it("keeps the run trace visible for code surface detail requests", () => {
    const renderer = create(
      <ChatContextDockPanels
        {...buildProps({
          mode: "code",
          isChatSurface: false,
          isCodeSurface: true,
        })}
      />,
    );

    expect(JSON.stringify(renderer.toJSON())).toContain("Run trace");
  });
});
