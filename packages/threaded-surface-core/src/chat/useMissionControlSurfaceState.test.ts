import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import {
  formatSessionLabel,
  looksMachineSessionLabel,
  resolveMissionControlDockSectionOrder,
  resolveMissionControlMessageMode,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
  useMissionControlSurfaceState,
} from "./useMissionControlSurfaceState";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSession(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: "session-abcdef",
    sessionKey: "mission:workspace:operator:chat_123",
    workspaceId: "workspace-1",
    title: "Launch plan",
    scope: "mission",
    mode: "chat",
    lifecycleStatus: "active",
    includeInHistory: true,
    pinned: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    lastActivityAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  } as ChatSessionRecord;
}

function makeThread(status = "completed", overrides: Record<string, unknown> = {}): ChatThreadResponse {
  return {
    sessionId: "session-abcdef",
    selectedTurnId: "turn-1",
    activeLeafTurnId: "turn-1",
    turns: [
      {
        turnId: "turn-1",
        userMessage: {
          messageId: "user-1",
          sessionId: "session-abcdef",
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "Plan launch",
          timestamp: "2026-05-01T00:00:00.000Z",
        },
        trace: {
          status,
          routing: {},
          toolRuns: [],
          capabilityUpgradeSuggestions: [],
          specialistCandidateSuggestions: [],
          ...overrides,
        },
      },
    ],
  } as ChatThreadResponse;
}

describe("mission control surface pure state helpers", () => {
  it("formats session labels without exposing machine labels", () => {
    expect(looksMachineSessionLabel(undefined)).toBe(true);
    expect(
      looksMachineSessionLabel(" mission:workspace:operator:chat_123 ", "mission:workspace:operator:chat_123"),
    ).toBe(true);
    expect(looksMachineSessionLabel("external:slack")).toBe(true);
    expect(looksMachineSessionLabel("Readable launch plan")).toBe(false);
    expect(formatSessionLabel(makeSession())).toBe("Launch plan");
    expect(formatSessionLabel(makeSession({ title: "mission:workspace:operator:chat_123" }))).toBe(
      "Mission chat - abcdef",
    );
    expect(
      formatSessionLabel(
        makeSession({ scope: "external", title: "", channel: "slack", account: "ops@example.test" } as any),
      ),
    ).toBe("External chat - slack / ops@example.test");
    expect(formatSessionLabel(makeSession({ scope: "external", title: "" } as any))).toBe("External chat - abcdef");
  });

  it("derives panel visibility and dock section order by surface risk", () => {
    const completed = makeThread().turns[0];
    expect(shouldShowTracePanel("chat", null)).toBe(false);
    expect(shouldShowTracePanel("chat", completed)).toBe(false);
    expect(shouldShowTracePanel("cowork", completed)).toBe(true);
    expect(
      shouldShowTracePanel("chat", makeThread("failed", { failure: { recommendedAction: "retry" } }).turns[0]),
    ).toBe(true);
    expect(shouldShowTracePanel("chat", makeThread("completed", { toolRuns: [{ toolName: "x" }] }).turns[0])).toBe(
      true,
    );
    expect(
      shouldShowTracePanel(
        "chat",
        makeThread("completed", { routing: { fallbackUsed: true }, orchestration: {} }).turns[0],
      ),
    ).toBe(true);

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
        hasDelegationSuggestion: true,
      }),
    ).toBe(false);
    expect(
      shouldShowSuggestionsPanel("code", {
        capabilitySuggestionCount: 1,
        specialistSuggestionCount: 0,
        specialistCandidateCount: 0,
        proactiveSuggestionCount: 0,
        hasDelegationSuggestion: false,
      }),
    ).toBe(true);
    expect(
      shouldShowSuggestionsPanel("cowork", {
        capabilitySuggestionCount: 0,
        specialistSuggestionCount: 0,
        specialistCandidateCount: 0,
        proactiveSuggestionCount: 0,
        hasDelegationSuggestion: false,
      }),
    ).toBe(true);
    expect(shouldShowLearnedMemoryPanel("chat", 0)).toBe(false);
    expect(shouldShowLearnedMemoryPanel("chat", 2)).toBe(true);
    expect(shouldShowLearnedMemoryPanel("code", 0)).toBe(true);

    expect(
      resolveMissionControlDockSectionOrder({
        mode: "cowork",
        showTracePanel: true,
        showSuggestionsPanel: true,
        showLearnedMemoryPanel: true,
        hasExternalBindingSection: true,
        hasGeneratedArtifact: true,
        hasBlockingContext: false,
        hasDelegationSuggestion: true,
        codeModeNeedsProjectBinding: false,
      })[0],
    ).toBe("suggestions");
    expect(
      resolveMissionControlDockSectionOrder({
        mode: "code",
        showTracePanel: true,
        showSuggestionsPanel: false,
        showLearnedMemoryPanel: false,
        hasExternalBindingSection: false,
        hasGeneratedArtifact: false,
        hasBlockingContext: false,
        hasDelegationSuggestion: false,
        codeModeNeedsProjectBinding: true,
      }).slice(0, 2),
    ).toEqual(["surface", "workflow"]);
    expect(
      resolveMissionControlDockSectionOrder({
        mode: "chat",
        showTracePanel: true,
        showSuggestionsPanel: false,
        showLearnedMemoryPanel: false,
        hasExternalBindingSection: false,
        hasGeneratedArtifact: false,
        hasBlockingContext: true,
        hasDelegationSuggestion: false,
        codeModeNeedsProjectBinding: false,
      })[0],
    ).toBe("trace");
  });

  it("resolves message mode precedence", () => {
    expect(resolveMissionControlMessageMode({ lockSurface: true, surface: "code", prefsMode: "chat" })).toBe("code");
    expect(
      resolveMissionControlMessageMode({ lockSurface: false, selectedSessionMode: "cowork", prefsMode: "chat" }),
    ).toBe("cowork");
    expect(resolveMissionControlMessageMode({ lockSurface: false, prefsMode: "code" })).toBe("code");
    expect(resolveMissionControlMessageMode({ lockSurface: false })).toBe("chat");
  });
});

describe("useMissionControlSurfaceState", () => {
  it("derives chat state, recovery copy, labels, and project binding candidates", async () => {
    let state: ReturnType<typeof useMissionControlSurfaceState> | null = null;
    function Harness() {
      state = useMissionControlSurfaceState({
        lockSurface: false,
        prefs: { sessionId: "session-abcdef", mode: "chat", toolAutonomy: "safe_auto" } as any,
        selectedTurnId: "turn-1",
        thread: makeThread("failed", {
          effectiveToolAutonomy: "manual",
          failure: { recommendedAction: "approve_pending_step" },
        }),
        selectedSession: makeSession({ projectId: undefined }),
        selectedProjectId: "project-1",
        projects: [{ projectId: "project-1", name: "GoatCitadel" }],
        projectsCount: 2,
        missionSessionCount: 3,
        externalSessionCount: 4,
        boundMissionSessionCount: 1,
        planningMode: "off",
        chatSubtitle: "Fast chat",
        capabilitySuggestionCount: 1,
        specialistSuggestionCount: 0,
        specialistCandidateCount: 0,
        proactiveSuggestionCount: 0,
        hasDelegationSuggestion: false,
        learnedMemoryCount: 1,
        hasGeneratedArtifact: true,
      });
      return null;
    }
    await act(async () => {
      create(React.createElement(Harness));
    });

    expect(state).toMatchObject({
      messageMode: "chat",
      isChatSurface: true,
      surfaceHeaderSubtitle: "Fast chat",
      selectedSessionLabel: "Launch plan",
      effectiveToolAutonomy: "manual",
      selectedProjectBindingCandidateId: "project-1",
      selectedProjectBindingCandidateName: "GoatCitadel",
      showTracePanel: true,
      showSuggestionsPanel: true,
      showLearnedMemoryPanel: true,
    });
    expect(state?.selectedTurnRecovery).toEqual(
      expect.objectContaining({ action: "approve_pending_step", label: "Approve the pending step" }),
    );
    expect(state?.workspaceSummaryCards).toEqual([
      { label: "Projects", value: "2" },
      { label: "Mission", value: "3" },
      { label: "Queue", value: "7" },
    ]);
  });

  it("derives cowork and code surface-specific summaries", async () => {
    const states: Array<ReturnType<typeof useMissionControlSurfaceState>> = [];
    function Harness(props: { mode: "cowork" | "code" }) {
      states.push(
        useMissionControlSurfaceState({
          lockSurface: true,
          surface: props.mode,
          prefs: { sessionId: "session-abcdef", mode: "chat", toolAutonomy: "safe_auto" } as any,
          selectedTurnId: null,
          thread: makeThread("completed"),
          selectedSession: makeSession({
            mode: props.mode,
            projectId: props.mode === "code" ? undefined : "project-1",
          }),
          selectedProjectId: "all",
          projects: [],
          projectsCount: 5,
          missionSessionCount: 6,
          externalSessionCount: 7,
          boundMissionSessionCount: 8,
          planningMode: "advisory",
          chatSubtitle: "Fast chat",
          capabilitySuggestionCount: 0,
          specialistSuggestionCount: 0,
          specialistCandidateCount: 0,
          proactiveSuggestionCount: 9,
          hasDelegationSuggestion: true,
          learnedMemoryCount: 0,
        }),
      );
      return null;
    }
    await act(async () => {
      create(React.createElement(Harness, { mode: "cowork" }));
      create(React.createElement(Harness, { mode: "code" }));
    });

    expect(states[0]).toMatchObject({
      messageMode: "cowork",
      isCoworkSurface: true,
      surfaceHeaderSubtitle:
        "Guided multi-step execution with visible orchestration, checkpoints, and collaboration controls.",
      effectiveToolAutonomy: "manual",
    });
    expect(states[0]?.workspaceSummaryCards).toEqual([
      { label: "Projects", value: "5" },
      { label: "Workflow", value: "6" },
      { label: "Next", value: "9" },
    ]);
    expect(states[1]).toMatchObject({
      messageMode: "code",
      isCodeSurface: true,
      codeModeNeedsProjectBinding: true,
    });
    expect(states[1]?.workspaceSummaryCards).toEqual([
      { label: "Projects", value: "5" },
      { label: "Bound", value: "8" },
      { label: "Sessions", value: "6" },
    ]);

    let emptyState: ReturnType<typeof useMissionControlSurfaceState> | null = null;
    function EmptySessionHarness() {
      emptyState = useMissionControlSurfaceState({
        lockSurface: true,
        surface: "cowork",
        prefs: null,
        selectedTurnId: null,
        thread: null,
        selectedSession: null,
        selectedProjectId: "none",
        projects: [],
        projectsCount: 0,
        missionSessionCount: 0,
        externalSessionCount: 0,
        boundMissionSessionCount: 0,
        planningMode: "off",
        chatSubtitle: "Fast chat",
        capabilitySuggestionCount: 0,
        specialistSuggestionCount: 0,
        specialistCandidateCount: 0,
        proactiveSuggestionCount: 0,
        hasDelegationSuggestion: false,
        learnedMemoryCount: 0,
      });
      return null;
    }
    await act(async () => {
      create(React.createElement(EmptySessionHarness));
    });
    expect(emptyState?.selectedSessionLabel).toBe("Cowork session");
  });
});
