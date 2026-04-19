import {
  CHAT_MODE_PRESETS,
  getChatTurnRecoveryActionLabel,
  getChatTurnRecoveryActionSummary,
  type ChatMode,
  type ChatSessionPrefsRecord,
  type ChatSessionRecord,
  type ChatThreadResponse,
} from "@goatcitadel/contracts";
import { useMemo } from "react";

export interface MissionControlWorkspaceSummaryCard {
  label: string;
  value: string;
}

export type MissionControlDockSectionId =
  | "workflow"
  | "surface"
  | "trace"
  | "suggestions"
  | "memory"
  | "session"
  | "external";

export function looksMachineSessionLabel(label: string | undefined, sessionKey?: string): boolean {
  const trimmed = label?.trim();
  if (!trimmed) {
    return true;
  }
  if (sessionKey && trimmed === sessionKey.trim()) {
    return true;
  }
  return /^(mission|external):/i.test(trimmed) || /:operator:chat_/i.test(trimmed);
}

export function formatSessionLabel(session: ChatSessionRecord): string {
  const title = session.title?.trim();
  if (title && !looksMachineSessionLabel(title, session.sessionKey)) {
    return title;
  }
  if (session.scope === "external") {
    const channel = [session.channel, session.account].filter(Boolean).join(" / ");
    return channel ? `External chat - ${channel}` : `External chat - ${session.sessionId.slice(-6)}`;
  }
  return `Mission chat - ${session.sessionId.slice(-6)}`;
}

export function shouldShowTracePanel(
  mode: ChatMode,
  turn: ChatThreadResponse["turns"][number] | null,
): boolean {
  if (!turn) {
    return false;
  }
  if (mode !== "chat") {
    return true;
  }
  return turn.trace.status !== "completed"
    || Boolean(turn.trace.failure)
    || turn.trace.toolRuns.length > 0
    || Boolean(turn.trace.routing.fallbackUsed)
    || Boolean(turn.trace.orchestration);
}

export function shouldShowSuggestionsPanel(
  mode: ChatMode,
  input: {
    capabilitySuggestionCount: number;
    specialistSuggestionCount: number;
    specialistCandidateCount: number;
    proactiveSuggestionCount: number;
    hasDelegationSuggestion: boolean;
  },
): boolean {
  if (mode === "cowork") {
    return true;
  }
  if (mode === "code") {
    return input.capabilitySuggestionCount > 0
      || input.specialistSuggestionCount > 0
      || input.specialistCandidateCount > 0;
  }
  return input.capabilitySuggestionCount > 0
    || input.specialistSuggestionCount > 0
    || input.specialistCandidateCount > 0
    || input.proactiveSuggestionCount > 0
    || input.hasDelegationSuggestion;
}

export function shouldShowLearnedMemoryPanel(mode: ChatMode, learnedMemoryCount: number): boolean {
  if (mode === "chat") {
    return learnedMemoryCount > 0;
  }
  return true;
}

export function resolveMissionControlDockSectionOrder(input: {
  mode: ChatMode;
  showTracePanel: boolean;
  showSuggestionsPanel: boolean;
  showLearnedMemoryPanel: boolean;
  hasExternalBindingSection: boolean;
  hasBlockingContext: boolean;
  hasDelegationSuggestion: boolean;
  codeModeNeedsProjectBinding: boolean;
}): MissionControlDockSectionId[] {
  const baseOrder: MissionControlDockSectionId[] = input.mode === "chat"
    ? ["surface", "trace", "memory", "session", "suggestions"]
    : input.mode === "cowork"
      ? ["workflow", "suggestions", "trace", "surface", "memory", "session"]
      : ["workflow", "surface", "session", "trace"];

  const sections = [...baseOrder];
  if (input.hasExternalBindingSection) {
    sections.push("external");
  }

  const priority = new Map<MissionControlDockSectionId, number>();
  sections.forEach((section, index) => priority.set(section, index));

  if (input.hasBlockingContext) {
    priority.set("trace", -2);
  } else if (input.hasDelegationSuggestion && input.mode === "cowork") {
    priority.set("suggestions", -1);
  } else if (input.codeModeNeedsProjectBinding && input.mode === "code") {
    priority.set("workflow", -1);
    priority.set("surface", -2);
  }

  return sections.filter((section) => {
    if (section === "trace") {
      return input.showTracePanel;
    }
    if (section === "suggestions") {
      return input.showSuggestionsPanel;
    }
    if (section === "memory") {
      return input.showLearnedMemoryPanel;
    }
    if (section === "external") {
      return input.hasExternalBindingSection;
    }
    return true;
  }).sort((left, right) => (priority.get(left) ?? 0) - (priority.get(right) ?? 0));
}

function buildWorkspaceSummaryCards(input: {
  mode: ChatMode;
  projectsCount: number;
  missionSessionCount: number;
  externalSessionCount: number;
  boundMissionSessionCount: number;
  proactiveSuggestionCount: number;
}): MissionControlWorkspaceSummaryCard[] {
  if (input.mode === "cowork") {
    return [
      { label: "Projects", value: String(input.projectsCount) },
      { label: "Workflow", value: String(input.missionSessionCount) },
      { label: "Next", value: String(input.proactiveSuggestionCount) },
    ];
  }
  if (input.mode === "code") {
    return [
      { label: "Projects", value: String(input.projectsCount) },
      { label: "Bound", value: String(input.boundMissionSessionCount) },
      { label: "Sessions", value: String(input.missionSessionCount) },
    ];
  }
  return [
    { label: "Projects", value: String(input.projectsCount) },
    { label: "Mission", value: String(input.missionSessionCount) },
    { label: "Queue", value: String(input.missionSessionCount + input.externalSessionCount) },
  ];
}

export function useMissionControlSurfaceState(input: {
  lockSurface: boolean;
  surface?: ChatMode;
  prefs: ChatSessionPrefsRecord | null;
  selectedTurnId: string | null;
  thread: ChatThreadResponse | null;
  selectedSession: (ChatSessionRecord & { projectName?: string | null; channel?: string | null; account?: string | null }) | null;
  selectedProjectId: string;
  projects: Array<{ projectId: string; name: string }>;
  projectsCount: number;
  missionSessionCount: number;
  externalSessionCount: number;
  boundMissionSessionCount: number;
  planningMode: "off" | "advisory";
  chatSubtitle: string;
  capabilitySuggestionCount: number;
  specialistSuggestionCount: number;
  specialistCandidateCount: number;
  proactiveSuggestionCount: number;
  hasDelegationSuggestion: boolean;
  learnedMemoryCount: number;
}): {
  messageMode: ChatMode;
  activeModePreset: (typeof CHAT_MODE_PRESETS)[ChatMode];
  isChatSurface: boolean;
  isCoworkSurface: boolean;
  isCodeSurface: boolean;
  surfaceHeaderTitle: string;
  surfaceHeaderSubtitle: string;
  workspaceSummaryCards: MissionControlWorkspaceSummaryCard[];
  selectedTurn: ChatThreadResponse["turns"][number] | null;
  selectedTurnRecovery: {
    action?: string;
    label: string;
    summary: string;
  } | null;
  effectiveToolAutonomy: ChatSessionPrefsRecord["toolAutonomy"] | undefined;
  selectedSessionLabel: string;
  codeModeNeedsProjectBinding: boolean;
  selectedProjectBindingCandidateId: string | undefined;
  selectedProjectBindingCandidateName: string | undefined;
  showTracePanel: boolean;
  showSuggestionsPanel: boolean;
  showLearnedMemoryPanel: boolean;
  dockSectionOrder: MissionControlDockSectionId[];
} {
  const messageMode = input.lockSurface && input.surface ? input.surface : (input.prefs?.mode ?? "chat");
  const activeModePreset = CHAT_MODE_PRESETS[messageMode];
  const isChatSurface = messageMode === "chat";
  const isCoworkSurface = messageMode === "cowork";
  const isCodeSurface = messageMode === "code";

  const selectedTurn = useMemo(
    () => input.thread?.turns.find((turn) => turn.turnId === input.selectedTurnId) ?? input.thread?.turns.at(-1) ?? null,
    [input.selectedTurnId, input.thread],
  );

  const selectedTurnRecovery = useMemo(() => {
    const action = selectedTurn?.trace.failure?.recommendedAction;
    if (!action) {
      return null;
    }
    return {
      action,
      label: getChatTurnRecoveryActionLabel(action),
      summary: getChatTurnRecoveryActionSummary(action),
    };
  }, [selectedTurn]);

  const effectiveToolAutonomy = selectedTurn?.trace.effectiveToolAutonomy
    ?? (input.planningMode === "advisory" ? "manual" : input.prefs?.toolAutonomy);

  const workspaceSummaryCards = useMemo(() => buildWorkspaceSummaryCards({
    mode: messageMode,
    projectsCount: input.projectsCount,
    missionSessionCount: input.missionSessionCount,
    externalSessionCount: input.externalSessionCount,
    boundMissionSessionCount: input.boundMissionSessionCount,
    proactiveSuggestionCount: input.proactiveSuggestionCount,
  }), [
    input.boundMissionSessionCount,
    input.externalSessionCount,
    input.missionSessionCount,
    input.projectsCount,
    input.proactiveSuggestionCount,
    messageMode,
  ]);

  const codeModeNeedsProjectBinding = isCodeSurface && !input.selectedSession?.projectId;
  const selectedProjectBindingCandidateId = input.selectedProjectId !== "all" && input.selectedProjectId !== "none"
    ? input.selectedProjectId
    : undefined;
  const selectedProjectBindingCandidateName = selectedProjectBindingCandidateId
    ? input.projects.find((item) => item.projectId === selectedProjectBindingCandidateId)?.name
    : undefined;

  const selectedSessionLabel = input.selectedSession
    ? formatSessionLabel(input.selectedSession)
    : `${activeModePreset.label} session`;

  const showTracePanel = shouldShowTracePanel(messageMode, selectedTurn);
  const showSuggestionsPanel = shouldShowSuggestionsPanel(messageMode, {
    capabilitySuggestionCount: input.capabilitySuggestionCount,
    specialistSuggestionCount: input.specialistSuggestionCount,
    specialistCandidateCount: input.specialistCandidateCount,
    proactiveSuggestionCount: input.proactiveSuggestionCount,
    hasDelegationSuggestion: input.hasDelegationSuggestion,
  });
  const showLearnedMemoryPanel = shouldShowLearnedMemoryPanel(messageMode, input.learnedMemoryCount);

  const dockSectionOrder = useMemo(() => resolveMissionControlDockSectionOrder({
    mode: messageMode,
    showTracePanel,
    showSuggestionsPanel,
    showLearnedMemoryPanel,
    hasExternalBindingSection: input.selectedSession?.scope === "external",
    hasBlockingContext:
      Boolean(selectedTurnRecovery) ||
      selectedTurn?.trace.status === "waiting_for_approval" ||
      selectedTurn?.trace.status === "waiting_for_user_input",
    hasDelegationSuggestion: input.hasDelegationSuggestion,
    codeModeNeedsProjectBinding,
  }), [
    codeModeNeedsProjectBinding,
    input.hasDelegationSuggestion,
    input.selectedSession?.scope,
    messageMode,
    selectedTurn?.trace.status,
    selectedTurnRecovery,
    showLearnedMemoryPanel,
    showSuggestionsPanel,
    showTracePanel,
  ]);

  return {
    messageMode,
    activeModePreset,
    isChatSurface,
    isCoworkSurface,
    isCodeSurface,
    surfaceHeaderTitle: activeModePreset.label,
    surfaceHeaderSubtitle: isChatSurface ? input.chatSubtitle : activeModePreset.summary,
    workspaceSummaryCards,
    selectedTurn,
    selectedTurnRecovery,
    effectiveToolAutonomy,
    selectedSessionLabel,
    codeModeNeedsProjectBinding,
    selectedProjectBindingCandidateId,
    selectedProjectBindingCandidateName,
    showTracePanel,
    showSuggestionsPanel,
    showLearnedMemoryPanel,
    dockSectionOrder,
  };
}
