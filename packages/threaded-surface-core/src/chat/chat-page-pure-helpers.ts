import type { Dispatch, SetStateAction } from "react";
/**
 * Pure helpers and types extracted from ChatPage.tsx as part of Step 10
 * (page decomposition). No React/DOM/state dependencies — safely
 * unit-testable in isolation. Re-exported from ChatPage for backward
 * compatibility with existing tests.
 */

import {
  applyChatModePresetToPatch,
  CHAT_MODE_PRESETS,
  type ChatCapabilityUpgradeSuggestion,
  type ChatGeneratedArtifactRecord,
  type ChatMode,
  type ChatSessionRecord,
  type ChatSessionPrefsPatch,
  type ChatSessionPrefsRecord,
  type ChatSpecialistCandidateSuggestionRecord,
} from "@goatcitadel/contracts";
import type { ChatMessagesResponse } from "@goatcitadel/mission-control-shared/api/client";
import type { CoworkAgenticControlItem } from "@goatcitadel/mission-control-shared/components/cowork-view-model";
import type { RefreshSignal } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import { normalizeComparableAssistantContent } from "./chat-page-normalizers";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";

export type ChatRefreshPlan = {
  refreshSidebar: boolean;
  refreshSession: "none" | "light" | "full";
};

/**
 * Resolve the cancel control to surface as a Stop affordance in the chat
 * composer for an active cowork delegation run.
 *
 * The button is only meaningful while a delegation run is actively `running`
 * on the cowork surface. A disabled cancel control is still returned so the
 * caller can render it disabled (with its `note` as the reason) rather than
 * hiding it. Returns `null` when there is nothing actionable to show.
 */
export function resolveCoworkComposerStopControl(input: {
  mode: ChatMode;
  delegationRunStatus: string | undefined;
  controls: readonly CoworkAgenticControlItem[] | undefined;
}): CoworkAgenticControlItem | null {
  if (input.mode !== "cowork") {
    return null;
  }
  if (input.delegationRunStatus !== "running") {
    return null;
  }
  return input.controls?.find((control) => control.action === "cancel") ?? null;
}

export interface DelegatedSessionRailGroups<TSession> {
  topLevelSessions: TSession[];
  delegatedChildrenByParentId: Record<string, TSession[]>;
  orphanDelegatedSessions: TSession[];
  delegatedChildSessionIds: string[];
}

type DelegatedSessionRailItem = Pick<ChatSessionRecord, "sessionId" | "updatedAt" | "delegationParent">;

export type ConfirmableCapabilityAction =
  | "enable_skill"
  | "install_skill_disabled"
  | "install_skill_enable"
  | "add_mcp_template";

export interface CapabilitySuggestionConfirmationCopy {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
}

export interface FinalizedStreamMessageState {
  sessionId: string;
  placeholderId: string;
  messageId?: string;
  content: string;
}

type SuggestionSyncItem = ChatCapabilityUpgradeSuggestion | ChatSpecialistCandidateSuggestionRecord;

export interface RevealGeneratedArtifactInput {
  artifact: ChatGeneratedArtifactRecord;
  compactSurfaceLayout: boolean;
  messageMode: ChatMode;
  loadSessionCoreState: (
    sessionId: string,
    options?: { background?: boolean; includeThread?: boolean },
  ) => Promise<void>;
  setSessionRailOpen: (open: boolean) => void;
  setDockOpen: (open: boolean) => void;
  setActiveGeneratedArtifact: (artifact: ChatGeneratedArtifactRecord | null) => void;
  setSelectedTurnId: (turnId: string | null) => void;
  setGeneratedArtifacts: Dispatch<
    SetStateAction<{
      items: ChatGeneratedArtifactRecord[];
    } | null>
  >;
  handleNavigateSurface: (
    surface: ChatMode,
    options?: { sessionId?: string | null; turnId?: string | null; artifactId?: string | null },
  ) => void;
}

export function resolveChatRefreshPlan(
  signal: Pick<RefreshSignal, "eventType" | "reason" | "source">,
  recentLocalPrefMutation = false,
): ChatRefreshPlan {
  const eventType = (signal.eventType ?? "").toLowerCase();
  const haystack = `${signal.reason} ${signal.eventType ?? ""} ${signal.source ?? ""}`.toLowerCase();
  const isPrefEcho =
    recentLocalPrefMutation && /\b(pref|policy|session|proactive|retrieval|reflection|mode)\b/.test(haystack);
  if (eventType === "fallback_poll") {
    return {
      refreshSidebar: true,
      refreshSession: "light",
    };
  }
  if (isPrefEcho) {
    return {
      refreshSidebar: false,
      refreshSession: "none",
    };
  }
  if (eventType === "chat_thread_updated") {
    return {
      refreshSidebar: false,
      refreshSession: "full",
    };
  }
  if (eventType === "chat_session_title_updated") {
    return {
      refreshSidebar: true,
      refreshSession: "none",
    };
  }
  if (eventType === "memory_qmd_generated") {
    return {
      refreshSidebar: false,
      refreshSession: "light",
    };
  }
  if (eventType === "tool_invoked" || eventType === "session_event") {
    return {
      refreshSidebar: false,
      refreshSession: "none",
    };
  }
  const refreshSidebar =
    /\b(project|archive|restore|pin|unpin|binding|workspace|external|session_created|session_deleted|title|rename|chat_session_title_updated|chat_session_updated)\b/.test(
      haystack,
    );
  const refreshSession = /\b(chat_thread_updated|message|thread|turn|assistant|user)\b/.test(haystack)
    ? "full"
    : /\b(pref|policy|proactive|retrieval|reflection|mode|learned_memory)\b/.test(haystack)
      ? "light"
      : "none";
  return {
    refreshSidebar,
    refreshSession,
  };
}

export function buildSuggestionSyncKey(
  turnId: string | null | undefined,
  suggestions: readonly SuggestionSyncItem[],
): string {
  const normalizedTurnId = turnId?.trim() || "none";
  if (suggestions.length === 0) {
    return `${normalizedTurnId}:empty`;
  }
  return `${normalizedTurnId}:${suggestions.map(describeSuggestionForSync).join("|")}`;
}

function describeSuggestionForSync(suggestion: SuggestionSyncItem): string {
  if ("recommendedAction" in suggestion) {
    return [
      "cap",
      suggestion.candidateId ?? "",
      suggestion.kind,
      suggestion.sourceProvider ?? "",
      suggestion.sourceRef ?? "",
      suggestion.recommendedAction,
      suggestion.riskLevel ?? "",
      suggestion.title,
    ].join("~");
  }
  return [
    "spec",
    suggestion.candidateId,
    suggestion.source,
    suggestion.suggestedStatus,
    suggestion.suggestedRoutingMode,
    String(suggestion.confidence),
    suggestion.title,
    suggestion.role,
  ].join("~");
}

export function groupDelegatedSessionsForRail<TSession extends DelegatedSessionRailItem>(
  sessions: readonly TSession[],
): DelegatedSessionRailGroups<TSession> {
  const sessionIds = new Set(sessions.map((session) => session.sessionId));
  const topLevelSessions: TSession[] = [];
  const delegatedChildrenByParentId: Record<string, TSession[]> = {};
  const orphanDelegatedSessions: TSession[] = [];
  const delegatedChildSessionIds: string[] = [];

  for (const session of sessions) {
    const parent = session.delegationParent;
    if (!parent?.parentSessionId) {
      topLevelSessions.push(session);
      continue;
    }
    delegatedChildSessionIds.push(session.sessionId);
    if (sessionIds.has(parent.parentSessionId)) {
      const children = delegatedChildrenByParentId[parent.parentSessionId] ?? [];
      children.push(session);
      delegatedChildrenByParentId[parent.parentSessionId] = children;
    } else {
      orphanDelegatedSessions.push(session);
    }
  }

  for (const children of Object.values(delegatedChildrenByParentId)) {
    children.sort(compareDelegatedSessionOrder);
  }
  orphanDelegatedSessions.sort(compareDelegatedSessionOrder);

  return {
    topLevelSessions,
    delegatedChildrenByParentId,
    orphanDelegatedSessions,
    delegatedChildSessionIds,
  };
}

function compareDelegatedSessionOrder<TSession extends DelegatedSessionRailItem>(
  left: TSession,
  right: TSession,
): number {
  const leftIndex = left.delegationParent?.index ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = right.delegationParent?.index ?? Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (byUpdated !== 0 && Number.isFinite(byUpdated)) {
    return byUpdated;
  }
  return left.sessionId.localeCompare(right.sessionId);
}

export function isConfirmableCapabilityAction(
  action: ChatCapabilityUpgradeSuggestion["recommendedAction"],
): action is ConfirmableCapabilityAction {
  return (
    action === "enable_skill" ||
    action === "install_skill_disabled" ||
    action === "install_skill_enable" ||
    action === "add_mcp_template"
  );
}

export function getCapabilitySuggestionConfirmationCopy(
  suggestion: ChatCapabilityUpgradeSuggestion,
): CapabilitySuggestionConfirmationCopy | null {
  if (!isConfirmableCapabilityAction(suggestion.recommendedAction)) {
    return null;
  }

  switch (suggestion.recommendedAction) {
    case "enable_skill":
      return {
        title: "Enable skill",
        message: `Enable ${suggestion.title}? GoatCitadel will turn it on and then resume the original request.`,
        confirmLabel: "Enable and resume",
        danger: false,
      };
    case "install_skill_disabled":
      return {
        title: "Install skill for review",
        message: `Install ${suggestion.title} in a disabled state first? You can review it in Skills before enabling live use.`,
        confirmLabel: "Install disabled",
        danger: false,
      };
    case "install_skill_enable":
      return {
        title: "Install and enable hosted skill",
        message: `Approve GoatCitadel to install and enable ${suggestion.title} now? The original request will resume automatically afterward.`,
        confirmLabel: "Install and enable",
        danger: suggestion.riskLevel === "high",
      };
    case "add_mcp_template":
      return {
        title: "Add MCP template",
        message: `Add MCP template "${suggestion.title}" now? Review trust and auth details in MCP Servers before first live use.`,
        confirmLabel: "Add template",
        danger: false,
      };
  }
}

export function getDeleteSessionConfirmationMessage(label: string): string {
  return `Delete "${label}" permanently? This removes its messages, traces, session history, and attached files.`;
}

export function resolveOptimisticChatPrefs(
  current: ChatSessionPrefsRecord,
  patch: ChatSessionPrefsPatch,
): ChatSessionPrefsRecord {
  const normalizedPatch = applyChatModePresetToPatch(patch);
  const presetAutonomyBudget = CHAT_MODE_PRESETS[current.mode].defaultPrefs.autonomyBudget;
  const baseAutonomyBudget = current.autonomyBudget ?? presetAutonomyBudget;
  const nextProviderId = normalizeOptionalPatchString(normalizedPatch.providerId);
  const nextModel = normalizeOptionalPatchString(normalizedPatch.model);
  const nextImageProviderId = normalizeOptionalPatchString(normalizedPatch.imageProviderId);
  const nextImageModel = normalizeOptionalPatchString(normalizedPatch.imageModel);
  const nextVisionFallbackModel = normalizeOptionalPatchString(normalizedPatch.visionFallbackModel);
  const providerChanged = normalizedPatch.providerId !== undefined && nextProviderId !== current.providerId;
  const imageProviderChanged =
    normalizedPatch.imageProviderId !== undefined && nextImageProviderId !== current.imageProviderId;
  return {
    ...current,
    mode: normalizedPatch.mode ?? current.mode,
    planningMode: normalizedPatch.planningMode ?? current.planningMode,
    providerId: normalizedPatch.providerId !== undefined ? nextProviderId : current.providerId,
    model: normalizedPatch.model !== undefined ? nextModel : providerChanged ? undefined : current.model,
    imageProviderId: normalizedPatch.imageProviderId !== undefined ? nextImageProviderId : current.imageProviderId,
    imageModel:
      normalizedPatch.imageModel !== undefined ? nextImageModel : imageProviderChanged ? undefined : current.imageModel,
    webMode: normalizedPatch.webMode ?? current.webMode,
    memoryMode: normalizedPatch.memoryMode ?? current.memoryMode,
    thinkingLevel: normalizedPatch.thinkingLevel ?? current.thinkingLevel,
    speedMode: normalizedPatch.speedMode ?? current.speedMode,
    subagentPolicy: normalizedPatch.subagentPolicy ?? current.subagentPolicy,
    toolAutonomy: normalizedPatch.toolAutonomy ?? current.toolAutonomy,
    visionFallbackModel:
      normalizedPatch.visionFallbackModel !== undefined ? nextVisionFallbackModel : current.visionFallbackModel,
    orchestrationEnabled: normalizedPatch.orchestrationEnabled ?? current.orchestrationEnabled,
    orchestrationIntensity: normalizedPatch.orchestrationIntensity ?? current.orchestrationIntensity,
    orchestrationVisibility: normalizedPatch.orchestrationVisibility ?? current.orchestrationVisibility,
    orchestrationProviderPreference:
      normalizedPatch.orchestrationProviderPreference ?? current.orchestrationProviderPreference,
    orchestrationReviewDepth: normalizedPatch.orchestrationReviewDepth ?? current.orchestrationReviewDepth,
    orchestrationParallelism: normalizedPatch.orchestrationParallelism ?? current.orchestrationParallelism,
    codeAutoApply: normalizedPatch.codeAutoApply ?? current.codeAutoApply,
    proactiveMode: normalizedPatch.proactiveMode ?? current.proactiveMode,
    autonomyBudget: normalizedPatch.autonomyBudget
      ? {
          ...baseAutonomyBudget,
          ...normalizedPatch.autonomyBudget,
        }
      : (current.autonomyBudget ?? presetAutonomyBudget),
    retrievalMode: normalizedPatch.retrievalMode ?? current.retrievalMode,
    reflectionMode: normalizedPatch.reflectionMode ?? current.reflectionMode,
  };
}

function normalizeOptionalPatchString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSelectedTurnId(
  thread: {
    selectedTurnId?: string | null;
    activeLeafTurnId?: string | null;
    turns: Array<{ turnId: string }>;
  } | null,
  currentTurnId: string | null,
  pendingRouteTurnId: string | null = null,
): string | null {
  if (!thread?.turns.length) {
    return null;
  }
  if (pendingRouteTurnId && thread.turns.some((turn) => turn.turnId === pendingRouteTurnId)) {
    return pendingRouteTurnId;
  }
  if (currentTurnId && thread.turns.some((turn) => turn.turnId === currentTurnId)) {
    return currentTurnId;
  }
  return thread.selectedTurnId ?? thread.activeLeafTurnId ?? thread.turns.at(-1)?.turnId ?? null;
}

export function shouldApplyFetchedMessagesAfterStream(
  currentMessages: ChatMessagesResponse["items"],
  fetchedMessages: ChatMessagesResponse["items"],
  finalizedStreamMessage: FinalizedStreamMessageState | null,
): boolean {
  if (!finalizedStreamMessage) {
    return true;
  }
  const currentPlaceholder = currentMessages.find(
    (item) =>
      item.messageId === finalizedStreamMessage.messageId || item.messageId === finalizedStreamMessage.placeholderId,
  );
  if (!currentPlaceholder) {
    return true;
  }
  if (finalizedStreamMessage.messageId) {
    return fetchedMessages.some(
      (item) => item.role === "assistant" && item.messageId === finalizedStreamMessage.messageId,
    );
  }
  const finalizedContent = normalizeComparableAssistantContent(finalizedStreamMessage.content);
  if (!finalizedContent) {
    return true;
  }
  const fetchedHasEquivalentAssistant = fetchedMessages.some(
    (item) => item.role === "assistant" && normalizeComparableAssistantContent(item.content) === finalizedContent,
  );
  return fetchedHasEquivalentAssistant;
}

export function shouldExecuteLocalChatCommand(action: OutboundQueueItem["action"], content: string): boolean {
  return action === "send" && content.trim().startsWith("/");
}

export interface BtwCommand {
  text: string;
}

export function parseBtwCommand(draft: string): BtwCommand | null {
  const match = draft.trimStart().match(/^\/btw(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  return { text: (match[1] ?? "").trim() };
}

export type MidTurnDisposition = "idle" | "steer" | "queue";

export function resolveMidTurnDisposition(input: { hasActiveStream: boolean; draft: string }): MidTurnDisposition {
  if (!input.hasActiveStream) {
    return "idle";
  }
  const trimmed = input.draft.trimStart();
  if (/^\/queue\s+followup\b/i.test(trimmed)) {
    return "queue";
  }
  if (/^\/queue\s+collect\b/i.test(trimmed)) {
    return "queue";
  }
  return "steer";
}

export type GoalCommand = { kind: "set"; text: string } | { kind: "status" } | { kind: "clear" };

export function parseGoalCommand(draft: string): GoalCommand | null {
  const match = draft.trimStart().match(/^\/goal(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  const arg = (match[1] ?? "").trim();
  if (!arg) {
    return { kind: "status" };
  }
  if (arg.toLowerCase() === "status") {
    return { kind: "status" };
  }
  if (arg.toLowerCase() === "clear") {
    return { kind: "clear" };
  }
  return { kind: "set", text: arg };
}

export type QueueCommand =
  | { kind: "steer"; text: string }
  | { kind: "followup"; text: string }
  | { kind: "collect"; text: string };

export function parseQueueCommand(draft: string): QueueCommand | null {
  const match = draft.trimStart().match(/^\/queue(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/i);
  if (!match) {
    return null;
  }
  const kind = (match[1] ?? "").toLowerCase();
  const text = (match[2] ?? "").trim();
  if (kind === "steer" || kind === "followup" || kind === "collect") {
    return { kind, text };
  }
  return null;
}

export async function revealGeneratedArtifactInSurface(input: RevealGeneratedArtifactInput): Promise<void> {
  if (input.compactSurfaceLayout) {
    input.setSessionRailOpen(false);
    input.setDockOpen(false);
  }
  input.setActiveGeneratedArtifact(input.artifact);
  input.setSelectedTurnId(input.artifact.turnId);
  await input.loadSessionCoreState(input.artifact.sessionId, {
    background: true,
    includeThread: true,
  });
  input.setGeneratedArtifacts((current) =>
    current
      ? {
          ...current,
          items: [input.artifact, ...current.items.filter((item) => item.artifactId !== input.artifact.artifactId)],
        }
      : current,
  );
  input.handleNavigateSurface(input.messageMode, {
    sessionId: input.artifact.sessionId,
    turnId: input.artifact.turnId,
    artifactId: input.artifact.artifactId,
  });
}
