import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ChatSessionPrefsRecord, ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import {
  formatSessionLabel,
  looksMachineSessionLabel,
  resolveMissionControlDockSectionOrder,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
  useMissionControlSurfaceState,
} from "./useMissionControlSurfaceState";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SurfaceState = ReturnType<typeof useMissionControlSurfaceState>;

let latestSurfaceState: SurfaceState | null = null;

function makeSession(
  patch: Partial<Omit<ChatSessionRecord, "projectId" | "channel" | "account">> & {
    projectId?: string | null;
    channel?: string | null;
    account?: string | null;
  } = {},
): ChatSessionRecord {
  return {
    sessionId: "session-123456",
    sessionKey: "mission:operator:chat_session-123456",
    title: "Operator plan",
    scope: "mission",
    includeInHistory: true,
    lifecycleStatus: "active",
    pinned: false,
    channel: "mission",
    account: "operator",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    lastActivityAt: "2026-05-01T00:00:00.000Z",
    tokenTotal: 0,
    costUsdTotal: 0,
    ...patch,
  } as ChatSessionRecord;
}

function makePrefs(patch: Partial<ChatSessionPrefsRecord> = {}): ChatSessionPrefsRecord {
  return {
    sessionId: "session-123456",
    mode: "chat",
    planningMode: "off",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    orchestrationEnabled: true,
    orchestrationIntensity: "minimal",
    orchestrationVisibility: "summarized",
    orchestrationProviderPreference: "speed",
    orchestrationReviewDepth: "off",
    orchestrationParallelism: "auto",
    codeAutoApply: "manual",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...patch,
  };
}

function makeTurn(patch: Partial<ChatThreadResponse["turns"][number]> = {}): ChatThreadResponse["turns"][number] {
  return {
    turnId: "turn-1",
    userMessage: {
      messageId: "message-user",
      sessionId: "session-123456",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "Review this workflow.",
      timestamp: "2026-05-01T00:00:00.000Z",
    },
    trace: {
      status: "completed",
      routing: {},
      toolRuns: [],
      capabilityUpgradeSuggestions: [],
      specialistCandidateSuggestions: [],
    },
    ...patch,
  } as ChatThreadResponse["turns"][number];
}

function makeThread(turns: ChatThreadResponse["turns"]): ChatThreadResponse {
  return {
    sessionId: "session-123456",
    selectedTurnId: turns.at(-1)?.turnId ?? null,
    activeLeafTurnId: turns.at(-1)?.turnId ?? null,
    turns,
  } as ChatThreadResponse;
}

function Harness(props: {
  lockSurface?: boolean;
  surface?: "chat" | "cowork" | "code";
  prefs?: ChatSessionPrefsRecord | null;
  selectedTurnId?: string | null;
  thread?: ChatThreadResponse | null;
  selectedSession?:
    | (ChatSessionRecord & {
        projectId?: string | null;
        projectName?: string | null;
        channel?: string | null;
        account?: string | null;
      })
    | null;
  selectedProjectId?: string;
  projects?: Array<{ projectId: string; name: string }>;
  planningMode?: "off" | "advisory";
  capabilitySuggestionCount?: number;
  specialistSuggestionCount?: number;
  specialistCandidateCount?: number;
  proactiveSuggestionCount?: number;
  hasDelegationSuggestion?: boolean;
  learnedMemoryCount?: number;
  hasGeneratedArtifact?: boolean;
}) {
  latestSurfaceState = useMissionControlSurfaceState({
    lockSurface: props.lockSurface ?? false,
    surface: props.surface,
    prefs: props.prefs ?? makePrefs(),
    selectedTurnId: props.selectedTurnId ?? null,
    thread: props.thread ?? null,
    selectedSession: props.selectedSession ?? makeSession(),
    selectedProjectId: props.selectedProjectId ?? "all",
    projects: props.projects ?? [{ projectId: "project-1", name: "Project Alpha" }],
    projectsCount: 3,
    missionSessionCount: 4,
    externalSessionCount: 2,
    boundMissionSessionCount: 1,
    planningMode: props.planningMode ?? "off",
    chatSubtitle: "Fast chat",
    capabilitySuggestionCount: props.capabilitySuggestionCount ?? 0,
    specialistSuggestionCount: props.specialistSuggestionCount ?? 0,
    specialistCandidateCount: props.specialistCandidateCount ?? 0,
    proactiveSuggestionCount: props.proactiveSuggestionCount ?? 0,
    hasDelegationSuggestion: props.hasDelegationSuggestion ?? false,
    learnedMemoryCount: props.learnedMemoryCount ?? 0,
    hasGeneratedArtifact: props.hasGeneratedArtifact,
  });
  return null;
}

describe("resolveMissionControlDockSectionOrder", () => {
  it("prioritizes trace context first on chat when the selected turn needs intervention", () => {
    expect(
      resolveMissionControlDockSectionOrder({
        mode: "chat",
        showTracePanel: true,
        showSuggestionsPanel: true,
        showLearnedMemoryPanel: true,
        hasExternalBindingSection: false,
        hasGeneratedArtifact: false,
        hasBlockingContext: true,
        hasDelegationSuggestion: false,
        codeModeNeedsProjectBinding: false,
      }),
    ).toEqual(["trace", "surface", "memory", "session", "suggestions"]);
  });

  it("keeps cowork workflow context ahead of supporting sections", () => {
    expect(
      resolveMissionControlDockSectionOrder({
        mode: "cowork",
        showTracePanel: true,
        showSuggestionsPanel: true,
        showLearnedMemoryPanel: true,
        hasExternalBindingSection: false,
        hasGeneratedArtifact: false,
        hasBlockingContext: false,
        hasDelegationSuggestion: true,
        codeModeNeedsProjectBinding: false,
      }).slice(0, 3),
    ).toEqual(["suggestions", "workflow", "trace"]);
  });

  it("pushes code posture and workbench ahead of the rest when project binding is missing", () => {
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
      }),
    ).toEqual(["surface", "workflow", "session", "trace"]);
  });
});

describe("mission control surface state helpers", () => {
  it("treats empty, matching, and machine-generated session titles as unsafe display labels", () => {
    expect(looksMachineSessionLabel(undefined)).toBe(true);
    expect(looksMachineSessionLabel("  ", "session-1")).toBe(true);
    expect(looksMachineSessionLabel("session-1", "session-1")).toBe(true);
    expect(looksMachineSessionLabel("mission:operator:chat_session-1")).toBe(true);
    expect(looksMachineSessionLabel("external:slack:workspace")).toBe(true);
    expect(looksMachineSessionLabel("Release planning")).toBe(false);
  });

  it("formats human, external, and mission fallback session labels", () => {
    expect(formatSessionLabel(makeSession({ title: "Launch review" }))).toBe("Launch review");
    expect(
      formatSessionLabel(
        makeSession({
          sessionId: "external-session",
          title: "external:slack",
          scope: "external",
          channel: "slack",
          account: "ops",
        } as Partial<ChatSessionRecord>),
      ),
    ).toBe("External chat - slack / ops");
    expect(
      formatSessionLabel(
        makeSession({
          sessionId: "session-abcdef",
          title: "mission:operator:chat_session-abcdef",
        }),
      ),
    ).toBe("Mission chat - abcdef");
  });

  it("shows trace, suggestion, and memory panels only when the surface policy needs them", () => {
    expect(shouldShowTracePanel("chat", null)).toBe(false);
    expect(shouldShowTracePanel("chat", makeTurn())).toBe(false);
    expect(
      shouldShowTracePanel(
        "chat",
        makeTurn({
          trace: {
            status: "completed",
            failure: { message: "no route", recommendedAction: "retry" },
            routing: {},
            toolRuns: [],
          } as any,
        }),
      ),
    ).toBe(true);
    expect(
      shouldShowTracePanel(
        "chat",
        makeTurn({ trace: { status: "completed", routing: { fallbackUsed: true }, toolRuns: [] } as any }),
      ),
    ).toBe(true);
    expect(shouldShowTracePanel("cowork", makeTurn())).toBe(true);

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
  });
});

describe("useMissionControlSurfaceState", () => {
  it("derives chat state from prefs and prioritizes blocking turn context", async () => {
    await act(async () => {
      create(
        React.createElement(Harness, {
          prefs: makePrefs(),
          selectedTurnId: "turn-failed",
          thread: makeThread([
            makeTurn({ turnId: "turn-completed" }),
            makeTurn({
              turnId: "turn-failed",
              trace: {
                status: "failed",
                failure: { message: "approval expired", recommendedAction: "request_approval" },
                effectiveToolAutonomy: "manual",
                routing: {},
                toolRuns: [],
              } as any,
            }),
          ]),
          proactiveSuggestionCount: 2,
          learnedMemoryCount: 1,
          hasGeneratedArtifact: true,
        }),
      );
    });

    expect(latestSurfaceState?.messageMode).toBe("chat");
    expect(latestSurfaceState?.surfaceHeaderSubtitle).toBe("Fast chat");
    expect(latestSurfaceState?.selectedTurn?.turnId).toBe("turn-failed");
    expect(latestSurfaceState?.selectedTurnRecovery).toMatchObject({
      action: "request_approval",
    });
    expect(latestSurfaceState?.effectiveToolAutonomy).toBe("manual");
    expect(latestSurfaceState?.workspaceSummaryCards).toEqual([
      { label: "Projects", value: "3" },
      { label: "Mission", value: "4" },
      { label: "Queue", value: "6" },
    ]);
    expect(latestSurfaceState?.dockSectionOrder.slice(0, 3)).toEqual(["trace", "surface", "artifact"]);
  });

  it("locks code mode, falls back to the latest turn, and exposes project binding candidates", async () => {
    await act(async () => {
      create(
        React.createElement(Harness, {
          lockSurface: true,
          surface: "code",
          prefs: makePrefs(),
          selectedTurnId: "missing-turn",
          thread: makeThread([makeTurn({ turnId: "turn-old" }), makeTurn({ turnId: "turn-latest" })]),
          selectedSession: makeSession({ projectId: null }),
          selectedProjectId: "project-1",
          planningMode: "advisory",
          capabilitySuggestionCount: 1,
        }),
      );
    });

    expect(latestSurfaceState?.messageMode).toBe("code");
    expect(latestSurfaceState?.isCodeSurface).toBe(true);
    expect(latestSurfaceState?.selectedTurn?.turnId).toBe("turn-latest");
    expect(latestSurfaceState?.effectiveToolAutonomy).toBe("manual");
    expect(latestSurfaceState?.codeModeNeedsProjectBinding).toBe(true);
    expect(latestSurfaceState?.selectedProjectBindingCandidateId).toBe("project-1");
    expect(latestSurfaceState?.selectedProjectBindingCandidateName).toBe("Project Alpha");
    expect(latestSurfaceState?.workspaceSummaryCards).toEqual([
      { label: "Projects", value: "3" },
      { label: "Bound", value: "1" },
      { label: "Sessions", value: "4" },
    ]);
    expect(latestSurfaceState?.dockSectionOrder.slice(0, 2)).toEqual(["surface", "workflow"]);
  });

  it("derives cowork sections for external sessions and generated artifacts", async () => {
    await act(async () => {
      create(
        React.createElement(Harness, {
          lockSurface: true,
          surface: "cowork",
          selectedSession: makeSession({
            title: "external:discord",
            scope: "external",
            channel: "discord",
            account: null,
            projectId: "project-1",
          }),
          selectedProjectId: "none",
          thread: null,
          proactiveSuggestionCount: 5,
          hasDelegationSuggestion: true,
          hasGeneratedArtifact: true,
        }),
      );
    });

    expect(latestSurfaceState?.messageMode).toBe("cowork");
    expect(latestSurfaceState?.isCoworkSurface).toBe(true);
    expect(latestSurfaceState?.selectedTurn).toBeNull();
    expect(latestSurfaceState?.selectedTurnRecovery).toBeNull();
    expect(latestSurfaceState?.selectedSessionLabel).toBe("External chat - discord");
    expect(latestSurfaceState?.selectedProjectBindingCandidateId).toBeUndefined();
    expect(latestSurfaceState?.workspaceSummaryCards).toEqual([
      { label: "Projects", value: "3" },
      { label: "Workflow", value: "4" },
      { label: "Next", value: "5" },
    ]);
    expect(latestSurfaceState?.dockSectionOrder).toContain("external");
    expect(latestSurfaceState?.dockSectionOrder).toContain("artifact");
    expect(latestSurfaceState?.dockSectionOrder[0]).toBe("suggestions");
  });
});
