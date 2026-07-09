import type {
  ChatAttachmentRecord,
  ChatMode,
  ChatSessionPrefsPatch,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatThreadResponse,
  RoutingPreflightResult,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
import { isChatTurnActiveStatus } from "@goatcitadel/contracts";
import type { AgenticRunTreeResponse } from "@goatcitadel/mission-control-shared/api/agentic";
import type {
  MissionControlActiveSessionSurfaceProps,
  ThreadedContextSelectionState,
} from "./MissionControlActiveSessionSurface";
import type { ChatVisualStreamMode } from "./chat-streaming-preview";
import type { OutboundContextBlock } from "./useChatSurfaceOrchestration";
import { formatWorkProviderModelSummary, type WorkTrustDescriptor } from "./work-trust";

export const VISUAL_STREAM_MODE_PREF_KEY = "goatcitadel.chat.visual_stream_mode.v1";
const SELECTED_CONTEXT_MAX_CHARS = 12_000;

export function readVisualStreamModeFromStorage(): ChatVisualStreamMode {
  if (typeof window === "undefined") {
    return "smooth";
  }
  try {
    return window.localStorage.getItem(VISUAL_STREAM_MODE_PREF_KEY) === "instant" ? "instant" : "smooth";
  } catch {
    return "smooth";
  }
}

export function formatSelectionSourceSummary(source?: RoutingPreflightResult["selectionSource"]): string {
  switch (source) {
    case "session":
      return "Selection: session";
    case "global":
      return "Selection: global";
    case "manual":
      return "Selection: manual";
    default:
      return "Selection: pending";
  }
}

function truncateContextBlock(value: string): string {
  if (value.length <= SELECTED_CONTEXT_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, SELECTED_CONTEXT_MAX_CHARS).trimEnd()}\n\n[Context truncated for length]`;
}

function summarizeContextCount(count: number): string {
  return count === 1 ? "1 selected turn" : `${count} selected turns`;
}

export function trimForkTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 54) {
    return trimmed || "chat";
  }
  return `${trimmed.slice(0, 51).trimEnd()}...`;
}

export function getThreadSourceLabel(input: {
  selectedSession?: ChatSessionRecord | null;
  selectedSessionId?: string | null;
  visibleSessionLabelById?: Map<string, string>;
}): string {
  const title = input.selectedSession?.title?.trim();
  if (title) {
    return title;
  }
  if (input.selectedSessionId) {
    return input.visibleSessionLabelById?.get(input.selectedSessionId) ?? `Chat ${input.selectedSessionId.slice(-6)}`;
  }
  return "current chat";
}

export function buildContextSelectionState(context: OutboundContextBlock | null): ThreadedContextSelectionState | null {
  if (!context) {
    return null;
  }
  return {
    label: context.label,
    turnCount: context.turnIds?.length ?? 0,
    sourceLabel: context.sourceLabel,
  };
}

export function buildSelectedConversationContext(input: {
  thread: ChatThreadResponse | null;
  turnIds: string[];
  sourceLabel: string;
  sourceSessionId?: string;
  targetSessionId?: string;
}): OutboundContextBlock | null {
  if (!input.thread || input.turnIds.length === 0) {
    return null;
  }
  const selectedIds = new Set(input.turnIds);
  const selectedTurns = input.thread.turns.filter((turn) => selectedIds.has(turn.turnId));
  if (selectedTurns.length === 0) {
    return null;
  }
  const sections = selectedTurns.map((turn, index) => {
    const userContent = turn.userMessage.content.trim() || "(empty user message)";
    const assistantContent = turn.assistantMessage?.content.trim();
    return [
      `Turn ${index + 1} (${turn.turnId})`,
      `You: ${userContent}`,
      assistantContent ? `GoatCitadel: ${assistantContent}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const content = truncateContextBlock([`Source thread: ${input.sourceLabel}`, ...sections].join("\n\n"));
  return {
    label: summarizeContextCount(selectedTurns.length),
    sourceLabel: input.sourceLabel,
    sourceSessionId: input.sourceSessionId ?? input.thread.sessionId,
    sessionId: input.targetSessionId,
    turnIds: selectedTurns.map((turn) => turn.turnId),
    content,
    createdAt: new Date().toISOString(),
  };
}

export function buildPrefsPatchFromRecord(prefs: ChatSessionPrefsRecord | null): ChatSessionPrefsPatch | null {
  if (!prefs) {
    return null;
  }
  const { sessionId: _sessionId, createdAt: _createdAt, updatedAt: _updatedAt, ...patch } = prefs;
  return patch;
}

export function formatRoutingTargetSummary(labels: Map<string, string>, providerId?: string, model?: string): string {
  return formatWorkProviderModelSummary(providerId ? (labels.get(providerId) ?? providerId) : undefined, model);
}

export function formatFallbackSummary(preflight: RoutingPreflightResult | null): {
  summary: string;
  tone: WorkTrustDescriptor["fallbackTone"];
} {
  if (!preflight || preflight.fallbackPolicy === "off") {
    return {
      summary: "Fallback off",
      tone: "muted",
    };
  }
  if (preflight.fallbackResult === "local_to_cloud") {
    return {
      summary: "Fallback armed · local to cloud",
      tone: "warning",
    };
  }
  if (preflight.fallbackResult === "cloud_to_local") {
    return {
      summary: "Fallback armed · cloud to local",
      tone: "warning",
    };
  }
  return {
    summary: "Fallback armed",
    tone: "warning",
  };
}

export function formatRuntimeSummary(preflight: RoutingPreflightResult | null): {
  summary: string;
  tone: WorkTrustDescriptor["runtimeTone"];
} {
  switch (preflight?.runtimeReachability) {
    case "reachable":
      return {
        summary: preflight.runtimeClass === "local" ? "Runtime reachable" : "Provider reachable",
        tone: "success",
      };
    case "unreachable":
      return {
        summary: preflight.runtimeClass === "local" ? "Runtime unreachable" : "Provider unreachable",
        tone: "critical",
      };
    case "models_unavailable":
      return {
        summary: preflight.runtimeClass === "local" ? "Models unavailable" : "Provider degraded",
        tone: "warning",
      };
    case "not_checked":
    default:
      return {
        summary: "Runtime not checked",
        tone: "muted",
      };
  }
}

function formatDelegationRunState(
  status: NonNullable<MissionControlActiveSessionSurfaceProps["delegationRun"]>["status"],
) {
  switch (status) {
    case "completed":
      return "delegation complete";
    case "partial":
      return "delegation partial";
    case "failed":
      return "delegation failed";
    case "running":
      return "delegation running";
    default:
      return `delegation ${String(status).replaceAll("_", " ")}`;
  }
}

function isTerminalDelegationRunStatus(
  status: NonNullable<MissionControlActiveSessionSurfaceProps["delegationRun"]>["status"],
): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

function coerceTerminalDelegationRunStatus(
  status?: string | null,
): NonNullable<MissionControlActiveSessionSurfaceProps["delegationRun"]>["status"] | undefined {
  return status === "completed" || status === "partial" || status === "failed" ? status : undefined;
}

function resolveEffectiveDelegationRunStatus(
  activeWorkflowTurn: ChatThreadResponse["turns"][number] | null | undefined,
  delegationRun: MissionControlActiveSessionSurfaceProps["delegationRun"] | null | undefined,
): NonNullable<MissionControlActiveSessionSurfaceProps["delegationRun"]>["status"] | undefined {
  if (!delegationRun) {
    return undefined;
  }
  const linkedOrchestration = activeWorkflowTurn?.trace.orchestration;
  const linkedTraceStatus =
    linkedOrchestration?.runId && linkedOrchestration.runId === delegationRun.runId
      ? coerceTerminalDelegationRunStatus(linkedOrchestration.status)
      : undefined;
  return linkedTraceStatus ?? delegationRun.status;
}

function shouldPreferActiveWorkflowStatus(status: ChatThreadResponse["turns"][number]["trace"]["status"]): boolean {
  return status === "waiting_for_approval" || status === "waiting_for_user_input";
}

export function formatThreadedRunStateLabel(
  activeWorkflowTurn: ChatThreadResponse["turns"][number] | null | undefined,
  delegationRun: MissionControlActiveSessionSurfaceProps["delegationRun"] | null | undefined,
): string | undefined {
  const effectiveDelegationStatus = resolveEffectiveDelegationRunStatus(activeWorkflowTurn, delegationRun);
  if (
    delegationRun &&
    (!activeWorkflowTurn ||
      (effectiveDelegationStatus ? isTerminalDelegationRunStatus(effectiveDelegationStatus) : false) ||
      !isChatTurnActiveStatus(activeWorkflowTurn.trace.status))
  ) {
    if (activeWorkflowTurn && shouldPreferActiveWorkflowStatus(activeWorkflowTurn.trace.status)) {
      return activeWorkflowTurn.trace.status;
    }
    return effectiveDelegationStatus ? formatDelegationRunState(effectiveDelegationStatus) : undefined;
  }
  if (activeWorkflowTurn) {
    return activeWorkflowTurn.trace.status;
  }
  return effectiveDelegationStatus ? formatDelegationRunState(effectiveDelegationStatus) : undefined;
}

export function formatThreadedRunStateSummary(
  activeWorkflowTurn: ChatThreadResponse["turns"][number] | null | undefined,
  delegationRun: MissionControlActiveSessionSurfaceProps["delegationRun"] | null | undefined,
): string | undefined {
  const label = formatThreadedRunStateLabel(activeWorkflowTurn, delegationRun);
  return label ? `Run: ${label}` : undefined;
}

export function formatAgenticBackgroundHandoffSummary(
  agenticRunTree: AgenticRunTreeResponse | null | undefined,
  visibleDelegationRun: MissionControlActiveSessionSurfaceProps["delegationRun"] | null | undefined,
): string | undefined {
  if (!agenticRunTree?.runId || visibleDelegationRun) {
    return undefined;
  }
  const status = getAgenticTreeRootNode(agenticRunTree)?.status;
  return status ? `Run: background handoff ${formatAgenticTreeStatus(status)}` : "Run: background handoff visible";
}

export function formatAgenticBackgroundHandoffNotice(
  agenticRunTree: AgenticRunTreeResponse | null | undefined,
  visibleDelegationRun: MissionControlActiveSessionSurfaceProps["delegationRun"] | null | undefined,
): string | undefined {
  if (!agenticRunTree?.runId || visibleDelegationRun) {
    return undefined;
  }
  const rootNode = getAgenticTreeRootNode(agenticRunTree);
  const label = rootNode?.label?.trim() || agenticRunTree.runId;
  const status = rootNode?.status ? ` is ${formatAgenticTreeStatus(rootNode.status)}` : " is visible";
  const childCount = agenticRunTree.nodes.filter((node) => node.kind === "task" || node.kind === "subagent").length;
  const childCopy = childCount > 0 ? ` with ${childCount} child ${childCount === 1 ? "item" : "items"}` : "";
  return `Background handoff visible from the session run table: ${label} (${agenticRunTree.runId})${status}${childCopy}. Open run details for the full lineage.`;
}

function getAgenticTreeRootNode(agenticRunTree: AgenticRunTreeResponse) {
  return (
    agenticRunTree.nodes.find((node) => node.kind === "run" && node.id === agenticRunTree.runId) ??
    agenticRunTree.nodes.find((node) => node.kind === "run") ??
    agenticRunTree.nodes[0]
  );
}

function formatAgenticTreeStatus(status: string): string {
  return status.replaceAll("_", " ");
}

export function requiresBoundaryAcknowledgment(preflight: RoutingPreflightResult | null): boolean {
  return preflight?.fallbackResult === "local_to_cloud" || preflight?.fallbackResult === "cloud_to_local";
}

export function isDocumentAttachment(attachment: ChatAttachmentRecord): boolean {
  const mimeType = attachment.mimeType.toLowerCase();
  if (attachment.mediaType === "image" || attachment.mediaType === "audio" || attachment.mediaType === "video") {
    return false;
  }
  return (
    attachment.mediaType === "text" ||
    mimeType.startsWith("text/") ||
    mimeType.includes("pdf") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("yaml") ||
    mimeType.includes("csv") ||
    mimeType.includes("markdown") ||
    Boolean(attachment.extractPreview?.trim()) ||
    Boolean(attachment.ocrText?.trim()) ||
    Boolean(attachment.transcriptText?.trim())
  );
}

export function canReadAttachmentInFull(attachment: ChatAttachmentRecord): boolean {
  return (
    attachment.extractStatus === "ready" ||
    Boolean(attachment.extractPreview?.trim()) ||
    Boolean(attachment.ocrText?.trim()) ||
    Boolean(attachment.transcriptText?.trim())
  );
}

export type PendingAttachmentDocumentMode = "message" | ThreadKnowledgeRetrievalMode;

export function reconcilePendingAttachmentModes(
  current: Record<string, PendingAttachmentDocumentMode>,
  pendingAttachments: ChatAttachmentRecord[],
): Record<string, PendingAttachmentDocumentMode> {
  const next: Record<string, PendingAttachmentDocumentMode> = {};
  for (const attachment of pendingAttachments) {
    const currentMode = current[attachment.attachmentId];
    if (!isDocumentAttachment(attachment)) {
      continue;
    }
    if (currentMode === "retrieval") {
      next[attachment.attachmentId] = "retrieval";
      continue;
    }
    if (currentMode === "full_text" && canReadAttachmentInFull(attachment)) {
      next[attachment.attachmentId] = "full_text";
      continue;
    }
    next[attachment.attachmentId] = "message";
  }
  return next;
}

export function resolveExecutionRoutePrefs(
  prefs: ChatSessionPrefsRecord | null,
  executionSurfaceMode: ChatMode,
  selectedProviderId?: string,
  selectedModel?: string,
): ChatSessionPrefsRecord | null {
  if (!prefs) {
    return prefs;
  }
  if (!selectedProviderId && !selectedModel) {
    return { ...prefs, mode: executionSurfaceMode };
  }
  return {
    ...prefs,
    mode: executionSurfaceMode,
    providerId: prefs.providerId ?? selectedProviderId,
    model: prefs.model ?? selectedModel,
  };
}

export function runWithSelectedSessionId<T>(
  selectedSessionId: string | null | undefined,
  run: (sessionId: string) => T,
): T | undefined {
  if (!selectedSessionId) {
    return undefined;
  }
  return run(selectedSessionId);
}

export function runWithSelectedSession<T>(
  selectedSession: ChatSessionRecord | null | undefined,
  run: (session: ChatSessionRecord) => T,
): T | undefined {
  if (!selectedSession) {
    return undefined;
  }
  return run(selectedSession);
}
