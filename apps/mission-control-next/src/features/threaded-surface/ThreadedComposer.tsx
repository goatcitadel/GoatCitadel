import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { buildGatewayUrl, readGatewayAuthHeaders } from "@goatcitadel/mission-control-shared/api/client-core";
import { ChatAttachmentActions } from "@goatcitadel/mission-control-shared/components/chat/ChatAttachmentActions";
import { ChatComposerPlusMenu } from "@goatcitadel/mission-control-shared/components/ChatComposerPlusMenu";
import { ChatQueueBar } from "@goatcitadel/mission-control-shared/components/chat/ChatQueueBar";
import {
  ChatPendingApprovalPanel,
  type ChatPendingApprovalState,
} from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import { ChatPendingUserInputPanel } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingUserInputPanel";
import { useEffect, useId, useRef, useState } from "react";
import { ContextStrip, type ContextStripMode, StatusChip } from "../native-routes/primitives";
import { describeThreadedUiError } from "./threaded-error-copy";
import { useAutoGrowTextarea } from "./useAutoGrowTextarea";
import { ThreadedModeChip } from "./ThreadedModeChip";

type PendingAttachment = MissionThreadedActiveSessionSurfaceProps["pendingAttachments"][number];

/* C7: soft character ceiling for the draft. Not enforced (sending isn't
   blocked); the counter only surfaces once a message gets long. */
const COMPOSER_SOFT_LIMIT = 8000;
const COMPOSER_COUNT_VISIBLE_AT = Math.round(COMPOSER_SOFT_LIMIT * 0.7);

function getPlaceholder(mode: MissionThreadedActiveSessionSurfaceProps["mode"]): string {
  if (mode === "code") {
    return "Describe the implementation task, constraints, or review goal…";
  }
  if (mode === "cowork") {
    return "Describe the work to coordinate, research, or move forward…";
  }
  return "Ask GoatCitadel anything…";
}

function getSendLabel(props: MissionThreadedActiveSessionSurfaceProps): string {
  if (props.mode === "cowork") {
    if (
      props.selectedTurn?.trace.status === "waiting_for_approval" ||
      props.selectedTurn?.trace.status === "waiting_for_user_input"
    ) {
      return "Resolve blocker";
    }
    if (props.editingTurnId) {
      return "Delegate branch";
    }
    return props.sending ? "Delegating..." : "Delegate";
  }

  if (props.mode === "code") {
    if (props.editingTurnId) {
      return "Implement branch";
    }
    return props.sending ? "Implementing..." : "Implement";
  }

  if (props.editingTurnId) {
    return "Send branch";
  }
  return props.sending ? "Sending..." : "Send";
}

function computeUsageTotals(thread: MissionThreadedActiveSessionSurfaceProps["thread"]) {
  return (thread?.turns ?? []).reduce(
    (next, turn) => {
      const messages = [turn.userMessage, turn.assistantMessage].filter(Boolean);
      for (const message of messages) {
        next.tokens += (message?.tokenInput ?? 0) + (message?.tokenOutput ?? 0);
        next.costUsd += message?.costUsd ?? 0;
      }
      return next;
    },
    { tokens: 0, costUsd: 0 },
  );
}

function formatTokenLabel(tokens: number): string {
  return `${new Intl.NumberFormat("en-US").format(tokens)} tokens`;
}

function formatCostLabel(costUsd: number): string {
  if (costUsd <= 0) {
    return "$0.00";
  }
  if (costUsd >= 10) {
    return `$${costUsd.toFixed(1)}`;
  }
  if (costUsd >= 0.01) {
    return `$${costUsd.toFixed(2)}`;
  }
  // Sub-cent costs are kept truthful: report three significant figures so a
  // long delegation that has crossed $0.005 reads as $0.005 rather than the
  // misleading flat "<$0.01" placeholder it used to show.
  return `$${costUsd.toFixed(3)}`;
}

function formatUsageLabel(thread: MissionThreadedActiveSessionSurfaceProps["thread"]): string {
  const totals = computeUsageTotals(thread);
  return `${formatTokenLabel(totals.tokens)} / ${formatCostLabel(totals.costUsd)}`;
}

function formatDelegationMode(mode: string): string {
  return mode
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDelegationConfidence(confidence?: number): string | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return null;
  }
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}% confidence`;
}

const COMPOSER_KILL_SWITCH_KEY = "mc-next:composer-v2";
const COMPOSER_KILL_SWITCH_FALSE_VALUES = new Set(["off", "false", "0", "no", "disabled"]);
const IN_PROGRESS_MEMORY_TRACE_STATUSES = new Set([
  "pending",
  "queued",
  "running",
  "streaming",
  "in_progress",
  "waiting_for_approval",
  "waiting_for_user_input",
]);

function readComposerV2(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    const value = window.localStorage.getItem(COMPOSER_KILL_SWITCH_KEY)?.trim().toLowerCase();
    return !value || !COMPOSER_KILL_SWITCH_FALSE_VALUES.has(value);
  } catch {
    return true;
  }
}

function useComposerV2Enabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => readComposerV2());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    const handle = () => setEnabled(readComposerV2());
    window.addEventListener("storage", handle);
    return () => window.removeEventListener("storage", handle);
  }, []);
  return enabled;
}

function toContextStripMode(mode: MissionThreadedActiveSessionSurfaceProps["mode"]): ContextStripMode {
  return mode === "code" || mode === "cowork" ? mode : "chat";
}

function isImageAttachment(attachment: PendingAttachment): boolean {
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim().toLowerCase() : "";
  const fileName = attachment.fileName.trim().toLowerCase();
  return (
    mimeType.startsWith("image/") ||
    mimeType.includes("image") ||
    /\.(png|apng|jpe?g|gif|webp|avif|bmp|svg)$/i.test(fileName)
  );
}

function formatHistoricalMemoryLabel(thread: MissionThreadedActiveSessionSurfaceProps["thread"]): string | undefined {
  const lastTurn = thread?.turns?.at(-1);
  const memoryMode = lastTurn?.trace?.memoryMode?.trim();
  if (!memoryMode || memoryMode === "off") {
    return undefined;
  }
  const status = lastTurn?.trace?.status;
  if (status && IN_PROGRESS_MEMORY_TRACE_STATUSES.has(status)) {
    return undefined;
  }
  return `Last turn: ${memoryMode}`;
}

function readStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatCompactList(values: Set<string>, fallbackLabel: string): string {
  const items = Array.from(values).filter(Boolean);
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return `${fallbackLabel}: ${items[0]}`;
  }
  return `${fallbackLabel}: ${items.length}`;
}

function getComposerCapabilityUseChips(props: MissionThreadedActiveSessionSurfaceProps) {
  const selectedIds = new Set(props.selectedContextTurnIds ?? []);
  const turns = props.thread?.turns.filter((turn) => selectedIds.size > 0 && selectedIds.has(turn.turnId)) ?? [];
  const scopedTurns =
    turns.length > 0
      ? turns
      : props.selectedTurn
        ? [props.selectedTurn]
        : props.thread?.turns.at(-1)
          ? [props.thread.turns.at(-1)!]
          : [];
  const skills = new Set<string>();
  const connectors = new Set<string>();
  const mcpServers = new Set<string>();

  for (const turn of scopedTurns) {
    for (const toolRun of turn.toolRuns ?? []) {
      const args = toolRun.args ?? {};
      const skillId = readStringField(args.skillId) ?? readStringField(args.skill);
      if (skillId || /^skills?\./i.test(toolRun.toolName)) {
        skills.add(skillId ?? toolRun.toolName);
      }

      const connectorId =
        readStringField(args.connectorId) ??
        readStringField(args.connectionId) ??
        readStringField(args.integrationConnectionId);
      if (connectorId || /\b(connector|integration)\b/i.test(toolRun.toolName)) {
        connectors.add(connectorId ?? toolRun.toolName);
      }

      const serverId =
        readStringField(args.serverId) ?? readStringField(args.mcpServerId) ?? readStringField(args.server);
      if (serverId || /\bmcp\b/i.test(toolRun.toolName)) {
        mcpServers.add(serverId ?? toolRun.toolName);
      }
    }
  }

  return [
    formatCompactList(skills, "Skills"),
    formatCompactList(connectors, "Connectors"),
    formatCompactList(mcpServers, "MCP"),
  ].filter(Boolean);
}

function PendingImagePreview({ attachment }: { attachment: PendingAttachment }) {
  const contentPath = `/api/v1/chat/attachments/${encodeURIComponent(attachment.attachmentId)}/content?disposition=inline`;
  const directPreviewUrl = buildGatewayUrl(contentPath);
  const [blobPreviewUrl, setBlobPreviewUrl] = useState<string | null>(null);
  const [loadWithAuthHeaders, setLoadWithAuthHeaders] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeBlobPreviewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeBlobPreviewUrlRef.current) {
      URL.revokeObjectURL(activeBlobPreviewUrlRef.current);
      activeBlobPreviewUrlRef.current = null;
    }
    setBlobPreviewUrl(null);
    setLoadWithAuthHeaders(false);
    setError(null);
  }, [attachment.attachmentId]);

  useEffect(
    () => () => {
      if (activeBlobPreviewUrlRef.current) {
        URL.revokeObjectURL(activeBlobPreviewUrlRef.current);
        activeBlobPreviewUrlRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!loadWithAuthHeaders || activeBlobPreviewUrlRef.current) {
      return;
    }
    let active = true;

    async function loadPreview(): Promise<void> {
      try {
        setError(null);
        const response = await fetch(directPreviewUrl, {
          headers: readGatewayAuthHeaders(contentPath),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`API error ${response.status}: ${text}`);
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        if (activeBlobPreviewUrlRef.current) {
          URL.revokeObjectURL(activeBlobPreviewUrlRef.current);
        }
        activeBlobPreviewUrlRef.current = objectUrl;
        setBlobPreviewUrl(objectUrl);
      } catch (nextError) {
        if (active) {
          setError((nextError as Error).message);
          setBlobPreviewUrl(null);
        }
      }
    }

    void loadPreview();
    return () => {
      active = false;
    };
  }, [contentPath, directPreviewUrl, loadWithAuthHeaders]);

  const previewUrl = blobPreviewUrl ?? directPreviewUrl;
  const fallbackLoading = loadWithAuthHeaders && !blobPreviewUrl && !error;
  const showImage = !error && !fallbackLoading;

  if (showImage) {
    return (
      <div className="mc-next-composer-image-shell">
        <img
          src={previewUrl}
          alt={attachment.fileName}
          className="mc-next-composer-image-preview"
          onError={() => {
            if (blobPreviewUrl) {
              setError("Preview unavailable.");
              return;
            }
            setLoadWithAuthHeaders(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="mc-next-composer-image-shell loading">
      <p>{fallbackLoading ? "Loading image preview..." : `Preview unavailable: ${error}`}</p>
    </div>
  );
}

function ComposerDelegationApproval({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const suggestion = props.delegationSuggestion;
  if (!suggestion) {
    return null;
  }

  const roleCount = suggestion.roles.length;
  const roleSummary = roleCount === 1 ? "1 subagent" : `${roleCount} subagents`;
  const confidenceLabel = formatDelegationConfidence(suggestion.confidence);
  const reason = suggestion.reason?.trim();

  return (
    <section className="mc-next-composer-delegation-approval" role="alert" aria-live="assertive">
      <div className="mc-next-composer-delegation-head">
        <StatusChip tone="warning">Subagent approval</StatusChip>
        <strong>Approve subagents for this run?</strong>
        {confidenceLabel ? <span>{confidenceLabel}</span> : null}
      </div>
      <p>
        Cowork can split this into {roleSummary} with {formatDelegationMode(suggestion.mode)} execution.
      </p>
      <p className="mc-next-composer-delegation-objective">{suggestion.objective}</p>
      {reason ? <p className="mc-next-composer-delegation-reason">{reason}</p> : null}
      {suggestion.roles.length > 0 ? (
        <div className="mc-next-composer-delegation-roles" aria-label="Suggested subagent roles">
          {suggestion.roles.map((role) => (
            <StatusChip key={role} tone="muted">
              {role}
            </StatusChip>
          ))}
        </div>
      ) : null}
      <div className="mc-next-composer-delegation-actions">
        <button
          type="button"
          className="mc-next-composer-inline-button primary"
          disabled={props.sending}
          onClick={() => void props.onAcceptDelegation()}
        >
          Approve subagents
        </button>
        <button
          type="button"
          className="mc-next-composer-inline-button"
          disabled={props.sending}
          onClick={props.onDismissDelegationSuggestion}
        >
          Keep single run
        </button>
      </div>
    </section>
  );
}

function ComposerBlockingPrompt({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const pendingApproval = props.pendingApproval as ChatPendingApprovalState | null;
  if (pendingApproval) {
    return (
      <div className="mc-next-composer-blocking-prompt" data-blocker-kind="approval">
        <ChatPendingApprovalPanel
          pendingApproval={pendingApproval}
          workspaceId={props.workspaceId}
          approvalsHref={`/ops/approvals?approvalId=${encodeURIComponent(pendingApproval.approvalId)}`}
          pending={props.approvalPending}
          variant="compact"
          onApprove={props.onApprovePending}
          onDeny={props.onDenyPending}
        />
      </div>
    );
  }

  if (props.pendingUserInput) {
    return (
      <div className="mc-next-composer-blocking-prompt" data-blocker-kind="user-input">
        <ChatPendingUserInputPanel
          pendingUserInput={props.pendingUserInput}
          pending={props.userInputPending}
          variant="compact"
          onSubmit={props.onSubmitUserInput}
        />
      </div>
    );
  }

  return null;
}

export function ThreadedComposer({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const threadKnowledgeAttachments = props.threadKnowledgeAttachments ?? [];
  const presetOptions = props.presetOptions ?? [];
  const knowledgeUrlDraft = props.knowledgeUrlDraft ?? "";
  const knowledgeUrlMode = props.knowledgeUrlMode ?? "retrieval";
  const mappedError = describeThreadedUiError(props.streamError, props.streamErrorSource ?? "other");
  const currentRouteLabel = props.routePreflight
    ? [props.routePreflight.effectiveProviderId, props.routePreflight.effectiveModel].filter(Boolean).join(" / ")
    : null;
  const sessionStateLabel = props.selectedSessionId ? "Thread ready" : "New thread";
  const webModeLabel =
    props.currentWebMode === "off"
      ? null
      : props.currentWebMode === "deep"
        ? "Deep web"
        : props.currentWebMode === "quick"
          ? "Quick web"
          : "Web auto";
  const thinkingLabel = `Think ${props.currentThinkingLevel}`;
  const speedLabel = props.currentSpeedMode === "fast" ? "Fast" : "Standard";
  const composerStatus =
    props.hasActiveStream && props.midTurnDisposition === "steer"
      ? "Steering active"
      : props.hasActiveStream && props.midTurnDisposition === "queue"
        ? "Queue active"
        : null;
  const routeLabel =
    props.routePreflightLoading && !currentRouteLabel
      ? "Route checking"
      : currentRouteLabel
        ? currentRouteLabel
        : (props.trust?.providerModelSummary ?? "Provider routing pending");
  const sendLabel = getSendLabel(props);
  const usageLabel = formatUsageLabel(props.thread);
  const usageTotals = computeUsageTotals(props.thread);
  const composerV2Enabled = useComposerV2Enabled();
  useAutoGrowTextarea(props.composerRef, props.draft, { minLines: 2, maxLines: 8 });
  const composerInstanceId = useId();
  const commandSuggestionsListboxId = `${composerInstanceId}-command-suggestions`;
  const commandSuggestionsOpen = props.commandSuggestions.length > 0;
  const commandSuggestionOptionId = (key: string) => `${commandSuggestionsListboxId}-${key}`;
  const activeCommandSuggestion =
    commandSuggestionsOpen && props.commandIndex >= 0 && props.commandIndex < props.commandSuggestions.length
      ? props.commandSuggestions[props.commandIndex]
      : null;
  const commandSuggestionsActiveDescendant = activeCommandSuggestion
    ? commandSuggestionOptionId(activeCommandSuggestion.key)
    : undefined;
  const contextStripMode = toContextStripMode(props.mode);
  // planningEnabled was used by the inline Plan toggle, which moved to the
  // Context Drawer's Assist tab. The composer keeps the "Planning mode is on"
  // banner above the textarea via props.planningMode directly.
  const contextStripModel = currentRouteLabel ?? props.trust?.providerModelSummary ?? "Routing pending";
  const memoryLabel = formatHistoricalMemoryLabel(props.thread);
  const capabilityUseChips = getComposerCapabilityUseChips(props);
  const runtimeBlockerActive = Boolean(props.pendingApproval || props.pendingUserInput);
  const composerActionDisabled = props.sending || runtimeBlockerActive;
  const plusActions = [
    {
      label: props.planningMode === "advisory" ? "Plan mode on" : "Plan mode",
      disabled: composerActionDisabled,
      active: props.planningMode === "advisory",
      onSelect: props.onTogglePlanningMode,
    },
    {
      label: props.pinnedGoal ? "Goal status" : "Pursue goal",
      disabled: composerActionDisabled || (!props.pinnedGoal && (!props.onSetGoal || !props.draft.trim())),
      active: Boolean(props.pinnedGoal),
      onSelect: () => {
        if (props.pinnedGoal) {
          void props.onGoalStatus?.();
          return;
        }
        const draftGoal = props.draft.trim();
        if (draftGoal) {
          void props.onSetGoal?.(draftGoal);
        }
      },
    },
    ...(props.pinnedGoal
      ? [
          {
            label: "Clear goal",
            disabled: composerActionDisabled,
            onSelect: () => void props.onClearGoal?.(),
          },
        ]
      : []),
    {
      label: props.fullWebAccess ? "Full web access" : "Web access limited",
      disabled: composerActionDisabled,
      active: props.fullWebAccess,
      tone: props.fullWebAccess ? ("warning" as const) : undefined,
      onSelect: () => props.onFullWebAccessChange(!props.fullWebAccess),
    },
    {
      label: props.currentWebMode === "deep" ? "Deep web on" : "Deep web research",
      disabled: composerActionDisabled,
      active: props.currentWebMode === "deep",
      onSelect: props.onSetDeepMode,
    },
    {
      label: props.voiceBusy ? "Voice listening..." : props.voiceTalkActive ? "Stop voice talk" : "Start voice talk",
      disabled: !props.voiceInputAvailable || props.voiceBusy || composerActionDisabled,
      active: Boolean(props.voiceTalkActive),
      onSelect: () => props.onToggleVoiceTalk?.(),
    },
    {
      label: "Transcribe audio",
      disabled: !props.voiceInputAvailable || props.voiceBusy || composerActionDisabled,
      onSelect: () => props.onOpenAudioTranscribe?.(),
    },
    ...(props.voiceOutputAvailable
      ? [
          {
            label: props.speakResponsesEnabled ? "Stop speaking replies" : "Speak replies",
            active: Boolean(props.speakResponsesEnabled),
            onSelect: () => props.onToggleSpeakResponses?.(),
          },
        ]
      : []),
    {
      label: props.imageBusy ? "Creating image..." : "Create image",
      disabled:
        !props.imageGenerationAvailable || props.imageBusy || composerActionDisabled || props.draft.trim().length === 0,
      onSelect: () => props.onGenerateImage?.(),
    },
    ...(props.imageEditAvailable
      ? [
          {
            label: props.imageBusy ? "Editing image..." : "Edit image",
            disabled: props.imageBusy || composerActionDisabled || props.draft.trim().length === 0,
            onSelect: () => props.onEditImage?.(),
          },
        ]
      : []),
    {
      label: "Quick web research",
      disabled: composerActionDisabled,
      onSelect: props.onRunQuickResearch,
    },
    {
      label: "Review run details",
      disabled: composerActionDisabled,
      onSelect: props.onReviewRunDetails,
    },
  ];

  return (
    <div className="mc-next-composer">
      <ChatQueueBar
        items={props.queueItems}
        title={props.mode === "cowork" ? "Queued messages" : "Queue"}
        onResumeAll={props.onResumeAll}
        onRemove={props.onRemoveQueuedItem}
      />

      {props.editingTurnId ? (
        <div className="mc-next-composer-banner">
          Branching from turn {props.editingTurnId.slice(-6)}.
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onCancelEdit}>
            Cancel branch
          </button>
        </div>
      ) : null}

      {props.planningMode === "advisory" ? (
        <div className="mc-next-composer-banner planning">
          Planning mode is on. GoatCitadel will respond with a plan/spec instead of executing tool work automatically.
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onTogglePlanningMode}>
            Turn planning off
          </button>
        </div>
      ) : null}

      {props.streamError ? (
        <div className="mc-next-composer-banner error" role="alert">
          <div>
            <strong>{mappedError?.summary ?? props.streamError}</strong>
            {mappedError?.raw ? <p>{mappedError.raw}</p> : null}
          </div>
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onDismissError}>
            Dismiss
          </button>
        </div>
      ) : null}

      {props.presetApplyWarning ? (
        <div className="mc-next-composer-banner warning">
          <StatusChip tone="warning">Preset</StatusChip>
          <p>{props.presetApplyWarning}</p>
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onDismissPresetWarning}>
            Dismiss
          </button>
        </div>
      ) : null}

      {props.routePreflightLoading && !props.routePreflight ? (
        <div className="mc-next-composer-banner info mc-next-technical-detail">
          <StatusChip tone="muted">Route</StatusChip>
          <p>Checking the selected provider/model route before send.</p>
        </div>
      ) : null}

      {props.routePreflight?.blockedReason || props.routePreflightError ? (
        <div className="mc-next-composer-banner error" role="alert">
          <StatusChip tone="critical">Route blocked</StatusChip>
          <p>{props.routePreflight?.blockedReason ?? props.routePreflightError}</p>
        </div>
      ) : null}

      {props.routeBoundaryAckRequired && !props.routeBoundaryAcknowledged ? (
        <div className="mc-next-composer-banner warning">
          <StatusChip tone="warning">Confirm</StatusChip>
          <p>If the primary route fails, this run may continue on another runtime boundary.</p>
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onAcknowledgeRouteBoundary}>
            Acknowledge fallback
          </button>
        </div>
      ) : null}

      <ComposerBlockingPrompt props={props} />

      {composerV2Enabled ? (
        <div className="mc-next-composer-context-strip mc-next-technical-detail">
          <ContextStrip
            model={contextStripModel}
            mode={contextStripMode}
            memory={memoryLabel}
            tokens={formatTokenLabel(usageTotals.tokens)}
            cost={formatCostLabel(usageTotals.costUsd)}
          />
        </div>
      ) : null}

      <div className="mc-next-composer-head">
        <div className="mc-next-composer-title">
          {/*
           * The kicker carries the visible surface label. The legacy h3
           * ("Send the next instruction" / recovery label) was hidden by the
           * unified-shell CSS and the recovery state surfaces via its dedicated
           * banner below, so the heading was dead text.
           */}
          <ThreadedModeChip
            mode={props.modeOverridePending ?? props.mode}
            onOverride={(m) => props.onModeOverride?.(m)}
            disabled={props.sending}
          />
        </div>
        <div className="mc-next-composer-chip-row mc-next-technical-detail">
          {props.contextSelection ? (
            <button
              type="button"
              className="mc-next-composer-chip action"
              onClick={props.onClearContextSelection}
              title={
                props.contextSelection.sourceLabel ? `Context from ${props.contextSelection.sourceLabel}` : undefined
              }
            >
              Context: {props.contextSelection.label} ×
            </button>
          ) : null}
          {capabilityUseChips.map((chip) => (
            <span key={chip} className="mc-next-composer-chip subtle">
              {chip}
            </span>
          ))}
          <span className="mc-next-composer-chip">{sessionStateLabel}</span>
          {webModeLabel ? <span className="mc-next-composer-chip subtle">{webModeLabel}</span> : null}
          {props.fullWebAccess ? <span className="mc-next-composer-chip emphasis">Full web</span> : null}
          <span className="mc-next-composer-chip subtle">{thinkingLabel}</span>
          <span className="mc-next-composer-chip subtle">{speedLabel}</span>
          <span className="mc-next-composer-chip subtle">{routeLabel}</span>
          <span className="mc-next-composer-chip subtle">{usageLabel}</span>
          {props.pinnedGoal ? <span className="mc-next-composer-chip emphasis">Goal: {props.pinnedGoal}</span> : null}
          {props.hasActiveStream && props.midTurnDisposition === "steer" ? (
            <span className="mc-next-composer-chip emphasis">Steering</span>
          ) : null}
          {props.hasActiveStream && props.midTurnDisposition === "queue" ? (
            <span className="mc-next-composer-chip subtle">Queued</span>
          ) : null}
        </div>
      </div>

      {props.selectedTurnRecovery ? (
        <div className="mc-next-composer-banner warning">
          <StatusChip tone={props.selectedTurn?.trace.status === "failed" ? "critical" : "warning"}>
            {props.selectedTurn?.trace.status ?? "recovery"}
          </StatusChip>
          <p>{props.selectedTurnRecovery.summary}</p>
          <div className="mc-next-composer-action-row">
            {props.selectedTurn &&
            (props.selectedTurnRecovery.action === "retry" ||
              props.selectedTurnRecovery.action === "retry_narrower") ? (
              <button
                type="button"
                className="mc-next-composer-inline-button"
                onClick={() => props.onRetryTurn(props.selectedTurn!.turnId)}
              >
                {props.mode === "cowork" ? "Retry run step" : "Retry turn"}
              </button>
            ) : null}
            {props.selectedTurnRecovery.action === "switch_to_deep_mode" && props.currentWebMode !== "deep" ? (
              <button type="button" className="mc-next-composer-inline-button" onClick={props.onSetDeepMode}>
                Set Deep mode
              </button>
            ) : null}
            {props.onReviewRunDetails ? (
              <button type="button" className="mc-next-composer-inline-button" onClick={props.onReviewRunDetails}>
                Review run details
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ComposerDelegationApproval props={props} />

      <div className="mc-next-composer-input-shell">
        <textarea
          ref={props.composerRef}
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={props.onComposerKeyDown}
          onPaste={props.onComposerPaste}
          placeholder={getPlaceholder(props.mode)}
          rows={2}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={commandSuggestionsOpen}
          aria-controls={commandSuggestionsOpen ? commandSuggestionsListboxId : undefined}
          aria-activedescendant={commandSuggestionsActiveDescendant}
        />
      </div>

      {commandSuggestionsOpen ? (
        <div
          className="mc-next-command-popover"
          role="listbox"
          id={commandSuggestionsListboxId}
          aria-label="Composer suggestions"
        >
          {props.commandSuggestions.map((item, index) => {
            const isHighlighted = index === props.commandIndex;
            return (
              <button
                key={item.key}
                id={commandSuggestionOptionId(item.key)}
                type="button"
                role="option"
                aria-selected={isHighlighted}
                className={`mc-next-command-item${isHighlighted ? " active" : ""}`}
                onClick={() => props.onApplyDraftCommand(item.applyValue)}
              >
                <strong>{item.command}</strong>
                <span>{item.description}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {props.pendingAttachments.length > 0 ? (
        <div className="mc-next-composer-attachments">
          {props.pendingAttachments.map((item) => (
            <div key={item.attachmentId} className="mc-next-composer-attachment">
              <div className="mc-next-composer-attachment-body">
                <div>
                  <strong>{item.fileName}</strong>
                  <p>
                    {item.mimeType} · {Math.max(1, Math.round(item.sizeBytes / 1024))} KB
                  </p>
                </div>
                {isImageAttachment(item) ? <PendingImagePreview attachment={item} /> : null}
              </div>
              <ChatAttachmentActions
                attachmentId={item.attachmentId}
                fileName={item.fileName}
                className="mc-next-composer-attachment-actions"
                buttonClassName="mc-next-composer-inline-button"
                statusClassName="mc-next-composer-attachment-action-status"
              >
                <button
                  type="button"
                  className="mc-next-composer-inline-button"
                  onClick={() => props.onRemoveAttachment(item.attachmentId)}
                >
                  Remove
                </button>
              </ChatAttachmentActions>
            </div>
          ))}
        </div>
      ) : null}

      {threadKnowledgeAttachments.length > 0 ? (
        <div className="mc-next-composer-knowledge-strip">
          {threadKnowledgeAttachments.map((attachment) => (
            <div key={attachment.attachmentId} className="mc-next-composer-knowledge-chip">
              <div>
                <strong>{attachment.title}</strong>
                <p>
                  {attachment.retrievalMode === "full_text" ? "Read in full" : "Retrieval"} · {attachment.ingestStatus}
                </p>
              </div>
              <button
                type="button"
                className="mc-next-composer-inline-button"
                onClick={() => props.onRemoveThreadKnowledgeAttachment?.(attachment.attachmentId)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mc-next-composer-controls">
        <div className="mc-next-composer-controls-start">
          <ChatComposerPlusMenu
            disabled={composerActionDisabled}
            onAttachFiles={props.onAttachFiles}
            actions={plusActions}
          >
            {presetOptions.length > 0 ? (
              <div className="mc-next-composer-plus-section">
                <label htmlFor="threaded-composer-preset">Preset</label>
                <div className="mc-next-composer-preset-row">
                  <select
                    id="threaded-composer-preset"
                    value={props.selectedPresetId}
                    disabled={composerActionDisabled}
                    onChange={(event) => {
                      if (!composerActionDisabled) {
                        props.onPresetChange?.(event.target.value);
                      }
                    }}
                  >
                    <option value="">Choose preset</option>
                    {presetOptions.map((preset) => (
                      <option key={preset.value} value={preset.value}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="mc-next-composer-inline-button"
                    disabled={composerActionDisabled || !props.selectedPresetId}
                    onClick={() => {
                      if (!composerActionDisabled) {
                        props.onApplyPreset?.();
                      }
                    }}
                  >
                    Apply
                  </button>
                </div>
              </div>
            ) : null}
            <div className="mc-next-composer-plus-section">
              <label htmlFor="threaded-composer-knowledge-url">Knowledge URL</label>
              <div className="mc-next-composer-knowledge-url-row">
                <input
                  id="threaded-composer-knowledge-url"
                  value={knowledgeUrlDraft}
                  disabled={composerActionDisabled}
                  onChange={(event) => {
                    if (!composerActionDisabled) {
                      props.onKnowledgeUrlDraftChange?.(event.target.value);
                    }
                  }}
                  placeholder="Attach a URL"
                />
                <select
                  value={knowledgeUrlMode}
                  disabled={composerActionDisabled}
                  onChange={(event) => {
                    if (!composerActionDisabled) {
                      props.onKnowledgeUrlModeChange?.(event.target.value as typeof knowledgeUrlMode);
                    }
                  }}
                >
                  <option value="retrieval">Use retrieval</option>
                  <option value="full_text">Read in full</option>
                </select>
                <button
                  type="button"
                  className="mc-next-composer-inline-button"
                  disabled={composerActionDisabled || !knowledgeUrlDraft.trim()}
                  onClick={() => {
                    if (!composerActionDisabled) {
                      props.onAttachKnowledgeUrl?.();
                    }
                  }}
                >
                  Attach source
                </button>
              </div>
            </div>
          </ChatComposerPlusMenu>
          <input
            ref={props.audioInputRef}
            type="file"
            accept="audio/*"
            aria-label="Attach audio"
            className="mc-next-hidden-file"
            disabled={composerActionDisabled}
            onChange={(event) => {
              if (!composerActionDisabled) {
                props.onAudioFileSelected?.(event.target.files);
              }
            }}
          />
        </div>
        {composerStatus ? <p className="mc-next-composer-helper">{composerStatus}</p> : null}
        <div className="mc-next-composer-controls-end">
          {props.draft.length >= COMPOSER_COUNT_VISIBLE_AT ? (
            <span
              className="mc-next-composer-count"
              data-near-limit={props.draft.length >= COMPOSER_SOFT_LIMIT ? "true" : undefined}
              aria-hidden="true"
            >
              {props.draft.length.toLocaleString()} / {COMPOSER_SOFT_LIMIT.toLocaleString()}
            </span>
          ) : null}
          {props.sending && props.hasActiveStream ? (
            <button type="button" className="mc-next-composer-primary" onClick={props.onStopActiveTurn}>
              {props.activeStreamTurnAssigned ? "Stop turn" : "Stop stream"}
            </button>
          ) : (
            <button type="button" className="mc-next-composer-primary" disabled={!props.canSend} onClick={props.onSend}>
              {sendLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
