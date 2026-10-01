import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatAttachmentActions } from "@goatcitadel/mission-control-shared/components/chat/ChatAttachmentActions";
import { ChatComposerPlusMenu } from "@goatcitadel/mission-control-shared/components/ChatComposerPlusMenu";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ChatQueueBar } from "@goatcitadel/mission-control-shared/components/chat/ChatQueueBar";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ContextStrip } from "../native-routes/primitives";
import { useAutoGrowTextarea } from "./useAutoGrowTextarea";
import { OPEN_CHAT_COMPOSER_PALETTE_EVENT } from "../../app/composer-palette-events";
import { ChatOptionsPopover } from "./ChatOptionsPopover";
import { buildActiveChatOptionSettings } from "./chat-option-settings";
import { resolveChatRouteReadiness } from "./chat-route-readiness";
import { ThreadedModeControl } from "./ThreadedModeControl";
import { isImageAttachment, PendingImagePreview } from "./ThreadedComposerAttachmentPreview";
import { getComposerPersonality, PersonalityPresenceChip } from "./ThreadedComposerPersonality";
import { getWorkflowSkillCaptureDisplay } from "@goatcitadel/mission-control-shared/components/chat/workflow-skill-capture-display";
import { WorkflowSkillCaptureEvidence } from "@goatcitadel/mission-control-shared/components/chat/WorkflowSkillCaptureEvidence";
import { ExternalSourceStrip } from "./ThreadedExternalSourceStrip";
import { computeUsageTotals, formatCostLabel, formatTokenLabel, formatUsageLabel } from "./threaded-composer-usage";

import {
  formatPaletteItemMeta,
  getPlaceholder,
  getSendLabel,
  toContextStripMode,
  formatHistoricalMemoryLabel,
  getComposerCapabilityUseChips,
} from "./threaded-composer-labels";
import { useComposerV2Enabled } from "./useComposerV2Enabled";
import { ThreadedComposerBanners } from "./ThreadedComposerBanners";
import { ThreadedComposerSendOptions } from "./ThreadedComposerSendOptions";
import { ThreadedComposerContextInputs } from "./ThreadedComposerContextInputs";

export { computeUsageTotals, formatCostLabel, formatTokenLabel, formatUsageLabel } from "./threaded-composer-usage";

/* C7: soft character ceiling for the draft. Not enforced (sending isn't
   blocked); the counter only surfaces once a message gets long. */
const COMPOSER_SOFT_LIMIT = 8000;
const COMPOSER_COUNT_VISIBLE_AT = Math.round(COMPOSER_SOFT_LIMIT * 0.7);

export function ThreadedComposer({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const threadKnowledgeAttachments = props.threadKnowledgeAttachments ?? [];
  const currentRouteLabel = props.routePreflight
    ? [props.routePreflight.effectiveProviderId, props.routePreflight.effectiveModel].filter(Boolean).join(" / ")
    : null;
  const sessionStateLabel = props.selectedSessionId ? "Chat ready" : "New chat";
  const webModeLabel =
    props.currentWebMode === "off"
      ? null
      : props.currentWebMode === "deep"
        ? "Deep web"
        : props.currentWebMode === "quick"
          ? "Quick web"
          : "Web auto";
  const thinkingLabel = props.currentThinkingLevel
    ? `Think ${props.currentThinkingLevel}`
    : "Thinking setting unavailable";
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
  // The single composer-level explanation of a blocked route; the start canvas
  // carries the setup actions, so no separate alert banner repeats it.
  const routeSendBlockReason = props.profileDependentAdmissionBlockReason ?? resolveChatRouteReadiness(props).sendHint;
  const sendLabel = getSendLabel(props);
  const usageLabel = formatUsageLabel(props.thread);
  const usageTotals = computeUsageTotals(props.thread);
  const composerV2Enabled = useComposerV2Enabled();
  useAutoGrowTextarea(props.composerRef, props.draft, { minLines: 1, maxLines: 8 });
  const composerInstanceId = useId();
  const sendBlockReasonId = `${composerInstanceId}-send-block-reason`;
  const commandSuggestionsListboxId = `${composerInstanceId}-command-suggestions`;
  const commandSuggestionsOpen = props.commandSuggestions.length > 0;
  const composerPaletteVisible = commandSuggestionsOpen || Boolean(props.composerPalette?.globalOpen);
  const paletteSearchRef = useRef<HTMLInputElement | null>(null);
  const wasComposerPaletteOpenRef = useRef(false);
  const [externalSourceOpenToken, setExternalSourceOpenToken] = useState(0);
  const [scopeCandidateId, setScopeCandidateId] = useState("");
  const [projectSwitchCandidate, setProjectSwitchCandidate] = useState<
    (typeof props.commandSuggestions)[number] | null
  >(null);
  const commandSuggestionOptionId = (key: string) => `${commandSuggestionsListboxId}-${key}`;
  const activeCommandSuggestion =
    commandSuggestionsOpen && props.commandIndex >= 0 && props.commandIndex < props.commandSuggestions.length
      ? props.commandSuggestions[props.commandIndex]
      : null;
  const commandSuggestionsActiveDescendant = activeCommandSuggestion
    ? commandSuggestionOptionId(activeCommandSuggestion.key)
    : undefined;
  useEffect(() => {
    const palette = props.composerPalette;
    if (!palette?.enabled || typeof window === "undefined") return;
    const eventTarget = window;
    const handlePaletteRequest = (event: Event) => {
      event.preventDefault();
      palette.onOpen();
    };
    eventTarget.addEventListener(OPEN_CHAT_COMPOSER_PALETTE_EVENT, handlePaletteRequest);
    return () => eventTarget.removeEventListener(OPEN_CHAT_COMPOSER_PALETTE_EVENT, handlePaletteRequest);
  }, [props.composerPalette]);
  useEffect(() => {
    const isOpen = Boolean(props.composerPalette?.globalOpen);
    if (isOpen) paletteSearchRef.current?.focus();
    else if (wasComposerPaletteOpenRef.current) props.composerRef.current?.focus();
    wasComposerPaletteOpenRef.current = isOpen;
  }, [props.composerPalette?.globalOpen, props.composerRef]);
  useEffect(() => {
    const candidates = props.delegatedScopeControls?.candidates ?? [];
    setScopeCandidateId((current) =>
      current && candidates.some((candidate) => candidate.candidateId === current)
        ? current
        : (candidates[0]?.candidateId ?? ""),
    );
  }, [props.delegatedScopeControls?.candidates, props.delegatedScopeControls?.pendingApprovalId]);
  const applyComposerPaletteItem = (item: (typeof props.commandSuggestions)[number]) => {
    if (item.action?.type === "switch_project") {
      setProjectSwitchCandidate(item);
      return;
    }
    if (item.action?.type === "launch_external_source") {
      props.composerPalette?.onClose();
      setExternalSourceOpenToken((current) => current + 1);
      return;
    }
    if (props.composerPalette?.enabled) {
      props.composerPalette.onSelect(item);
      globalThis.setTimeout(() => props.composerRef.current?.focus(), 0);
    } else props.onApplyDraftCommand(item.applyValue);
  };
  const handlePaletteSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const palette = props.composerPalette;
    if (!palette) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      palette.onIndexChange(Math.min(props.commandIndex + 1, Math.max(0, props.commandSuggestions.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      palette.onIndexChange(Math.max(0, props.commandIndex - 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      palette.onIndexChange(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      palette.onIndexChange(Math.max(0, props.commandSuggestions.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = props.commandSuggestions[props.commandIndex];
      if (selected) applyComposerPaletteItem(selected);
    }
  };
  const handleComposerPaletteKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!props.composerPalette?.globalOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      props.composerPalette.onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !event.currentTarget.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  };
  const contextStripMode = toContextStripMode(props.mode);
  // planningEnabled was used by the inline Plan toggle, which moved to the
  // Context Drawer's Assist tab. The composer keeps the "Planning mode is on"
  // banner above the textarea via props.planningMode directly.
  const contextStripModel = currentRouteLabel ?? props.trust?.providerModelSummary ?? "Routing pending";
  const memoryLabel = formatHistoricalMemoryLabel(props.thread);
  const capabilityUseChips = getComposerCapabilityUseChips(props);
  const runtimeBlockerActive = Boolean(props.pendingApproval || props.pendingUserInput);
  const composerActionDisabled = props.sending || runtimeBlockerActive || props.historicalReadOnly;
  // A delegated child can request more governed scope while its stream is
  // still open. `sending` locks new composer work, but must not lock this
  // server-candidate-only approval request.
  const delegatedScopeActionDisabled =
    runtimeBlockerActive ||
    props.approvalPending ||
    props.userInputPending ||
    props.historicalReadOnly ||
    Boolean(props.delegatedScopeControls?.pendingApprovalId);
  const researchArmed = props.currentWebMode === "quick" || props.currentWebMode === "deep";
  const reviewArmed = props.currentReviewDepth !== "off";
  const activeChatOptionSettings = buildActiveChatOptionSettings({
    planningMode: props.planningMode,
    webMode: props.currentWebMode,
    reviewDepth: props.currentReviewDepth,
    modelCouncilEnabled: Boolean(props.modelCouncilEnabled),
  });
  const workspaceSnapshotArmed = Boolean(props.workspaceSnapshotRequest);
  const contextArmed = Boolean(
    props.contextSelection ||
    props.outboundContext ||
    props.pendingAttachments.length > 0 ||
    threadKnowledgeAttachments.length > 0 ||
    (props.externalSourceControls?.selectedAttachmentIds.length ?? 0) > 0 ||
    workspaceSnapshotArmed,
  );
  const personality = getComposerPersonality(props);
  const plusActions = [
    ...(props.externalSourceControls
      ? [
          {
            label: "Attach imported item",
            disabled: composerActionDisabled,
            onSelect: () => setExternalSourceOpenToken((current) => current + 1),
          },
        ]
      : []),
    {
      label: "Browse personalities",
      disabled: !props.onOpenPersonalitiesSettings,
      onSelect: () => props.onOpenPersonalitiesSettings?.(),
    },
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
      label: props.liveVoiceActive
        ? "Stop live voice"
        : props.voiceBusy && props.liveVoiceState === "connecting"
          ? "Live voice connecting..."
          : "Live voice",
      disabled:
        !props.liveVoiceAvailable || (Boolean(props.voiceBusy) && !props.liveVoiceActive) || composerActionDisabled,
      active: Boolean(props.liveVoiceActive),
      onSelect: () => props.onToggleLiveVoice?.(),
    },
    {
      label: props.voiceBusy
        ? "Push-to-talk listening..."
        : props.voiceTalkActive
          ? "Stop push-to-talk"
          : "Push-to-talk",
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
      label: workspaceSnapshotArmed ? "Remove workspace snapshot" : "Workspace snapshots temporarily unavailable",
      disabled: composerActionDisabled || !workspaceSnapshotArmed,
      active: workspaceSnapshotArmed,
      onSelect: props.onToggleWorkspaceSnapshot,
    },
    ...(props.onReviewRunDetails
      ? [
          {
            label: "Review run details",
            disabled: composerActionDisabled,
            onSelect: props.onReviewRunDetails,
          },
        ]
      : []),
  ];

  return (
    <div className="mc-next-composer">
      <ChatQueueBar
        items={props.queueItems}
        title={props.mode === "cowork" ? "Queued messages" : "Queue"}
        onResumeAll={props.onResumeAll}
        onRemove={props.onRemoveQueuedItem}
      />

      <ThreadedComposerBanners
        props={props}
        composerActionDisabled={composerActionDisabled}
        delegatedScopeActionDisabled={delegatedScopeActionDisabled}
        scopeCandidateId={scopeCandidateId}
        onScopeCandidateChange={setScopeCandidateId}
      />

      <div className="mc-next-composer-input-shell">
        <textarea
          ref={props.composerRef}
          disabled={props.historicalReadOnly}
          value={getWorkflowSkillCaptureDisplay(props.draft)?.summary ?? props.draft}
          readOnly={Boolean(getWorkflowSkillCaptureDisplay(props.draft))}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={props.onComposerKeyDown}
          onPaste={props.onComposerPaste}
          placeholder={getPlaceholder(props.mode)}
          rows={1}
          role="combobox"
          aria-label="Message composer"
          aria-autocomplete="list"
          aria-expanded={composerPaletteVisible}
          aria-controls={composerPaletteVisible ? commandSuggestionsListboxId : undefined}
          aria-activedescendant={commandSuggestionsActiveDescendant}
        />
      </div>

      <WorkflowSkillCaptureEvidence
        content={props.draft}
        onClear={props.historicalReadOnly ? undefined : () => props.onDraftChange("")}
      />

      {composerPaletteVisible ? (
        <div
          className={`mc-next-command-popover${props.composerPalette?.globalOpen ? " palette-sheet" : ""}`}
          role={props.composerPalette?.globalOpen ? "dialog" : undefined}
          aria-label={props.composerPalette?.globalOpen ? "Command Palette" : undefined}
          aria-modal={props.composerPalette?.globalOpen ? "true" : undefined}
          onKeyDown={handleComposerPaletteKeyDown}
        >
          {props.composerPalette?.globalOpen ? (
            <div className="mc-next-composer-palette-header">
              <div className="mc-next-composer-palette-search" role="search">
                <label htmlFor={`${composerInstanceId}-palette-query`}>Search commands and context</label>
                <input
                  ref={paletteSearchRef}
                  id={`${composerInstanceId}-palette-query`}
                  type="search"
                  value={props.composerPalette.query}
                  onChange={(event) => props.composerPalette?.onQueryChange(event.target.value)}
                  onKeyDown={handlePaletteSearchKeyDown}
                  aria-controls={commandSuggestionsListboxId}
                  aria-activedescendant={commandSuggestionsActiveDescendant}
                  placeholder="Commands, models, agents, skills, projects, files, URLs…"
                />
                <span aria-hidden="true">Esc to close</span>
              </div>
              <button
                type="button"
                className="mc-next-composer-palette-close"
                aria-label="Close Chat command palette"
                onClick={() => props.composerPalette?.onClose()}
              >
                Close
              </button>
            </div>
          ) : null}
          {props.composerPalette?.loading ? (
            <p className="mc-next-composer-palette-status" role="status">
              Searching available sources…
            </p>
          ) : null}
          {(props.composerPalette?.failures.length ?? 0) > 0 ? (
            <p className="mc-next-composer-palette-status warning" role="status">
              {props.composerPalette?.failures.map((failure) => failure.sourceLabel).join(", ")} unavailable; other
              sources remain available.
            </p>
          ) : null}
          <div
            className="mc-next-composer-palette-options"
            role="listbox"
            id={commandSuggestionsListboxId}
            aria-label="Composer suggestions"
          >
            {props.commandSuggestions.map((item, index) => {
              const isHighlighted = index === props.commandIndex;
              const meta = formatPaletteItemMeta(item);
              return (
                <button
                  key={item.key}
                  id={commandSuggestionOptionId(item.key)}
                  type="button"
                  role="option"
                  aria-selected={isHighlighted}
                  className={`mc-next-command-item${isHighlighted ? " active" : ""}`}
                  onMouseMove={() => props.composerPalette?.onIndexChange(index)}
                  onClick={() => applyComposerPaletteItem(item)}
                >
                  <strong>{item.command}</strong>
                  <span>{item.description}</span>
                  {meta ? <small>{meta}</small> : null}
                </button>
              );
            })}
            {!props.composerPalette?.loading && props.commandSuggestions.length === 0 ? (
              <p className="mc-next-composer-palette-status">No available matches.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <ConfirmModal
        open={projectSwitchCandidate !== null}
        title="Switch this Chat to another project?"
        message={
          projectSwitchCandidate?.action?.type === "switch_project"
            ? `Switch to ${projectSwitchCandidate.action.projectName}? The current draft and attachments stay in Chat.`
            : "Switch this Chat to the selected project?"
        }
        confirmLabel="Switch project"
        onCancel={() => setProjectSwitchCandidate(null)}
        onConfirm={() => {
          const selected = projectSwitchCandidate;
          setProjectSwitchCandidate(null);
          if (selected) {
            props.composerPalette?.onSelect(selected);
            globalThis.setTimeout(() => props.composerRef.current?.focus(), 0);
          }
        }}
      />

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

      {props.externalSourceControls ? (
        <ExternalSourceStrip
          controls={props.externalSourceControls}
          disabled={composerActionDisabled}
          openAttachFormToken={externalSourceOpenToken}
          onOpenLibrary={props.onOpenLibraryImports}
          onRestoreFocus={() => props.composerRef.current?.focus()}
        />
      ) : null}

      <div className="mc-next-composer-controls">
        <div className="mc-next-composer-controls-start">
          {personality ? (
            <PersonalityPresenceChip personality={personality} onOpenSettings={props.onOpenPersonalitiesSettings} />
          ) : null}
          <ChatComposerPlusMenu
            disabled={composerActionDisabled}
            onAttachFiles={props.onAttachFiles}
            actions={plusActions}
          >
            <ThreadedComposerContextInputs props={props} composerActionDisabled={composerActionDisabled} />
          </ChatComposerPlusMenu>
          <ChatOptionsPopover activeSettings={activeChatOptionSettings}>
            {composerV2Enabled ? (
              <div className="mc-next-composer-context-strip">
                <ContextStrip
                  model={contextStripModel}
                  mode={contextStripMode}
                  memory={memoryLabel}
                  tokens={
                    formatTokenLabel(usageTotals.tokens) +
                    (usageTotals.partialTokens && usageTotals.tokens !== null ? " recorded" : "")
                  }
                  cost={
                    formatCostLabel(usageTotals.costUsd) +
                    (usageTotals.partialCost && usageTotals.costUsd !== null ? " recorded" : "")
                  }
                />
              </div>
            ) : null}

            <div className="mc-next-composer-head">
              <div className="mc-next-composer-title">
                {/* The compact mode label keeps the current surface inspectable. */}
                <ThreadedModeControl
                  mode={props.modeOverridePending ?? (props.autoRouteActive ? undefined : props.mode)}
                  preview={props.surfaceRoutePreview}
                  variant="compact"
                  interactive={false}
                />
              </div>
              <div className="mc-next-composer-chip-row">
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
                {props.pinnedGoal ? (
                  <span className="mc-next-composer-chip emphasis">Goal: {props.pinnedGoal}</span>
                ) : null}
                {props.hasActiveStream && props.midTurnDisposition === "steer" ? (
                  <span className="mc-next-composer-chip emphasis">Steering</span>
                ) : null}
                {props.hasActiveStream && props.midTurnDisposition === "queue" ? (
                  <span className="mc-next-composer-chip subtle">Queued</span>
                ) : null}
              </div>
            </div>

            {!runtimeBlockerActive ? (
              <ThreadedComposerSendOptions
                props={props}
                composerActionDisabled={composerActionDisabled}
                researchArmed={researchArmed}
                reviewArmed={reviewArmed}
                contextArmed={contextArmed}
              />
            ) : null}
          </ChatOptionsPopover>
          {contextArmed || props.fullWebAccess || props.pinnedGoal ? (
            <div className="mc-next-composer-active-context is-inline" aria-label="Active context and overrides">
              {props.contextSelection ? (
                <button type="button" className="mc-next-composer-chip action" onClick={props.onClearContextSelection}>
                  Context: {props.contextSelection.label} ×
                </button>
              ) : null}
              {props.fullWebAccess ? <span className="mc-next-composer-chip emphasis">Full web access</span> : null}
              {props.pinnedGoal ? (
                <span className="mc-next-composer-chip emphasis">Goal: {props.pinnedGoal}</span>
              ) : null}
            </div>
          ) : null}
          {props.selectedTurnRecovery?.action === "switch_to_deep_mode" && props.currentWebMode !== "deep" ? (
            <button type="button" className="mc-next-composer-inline-button" onClick={props.onSetDeepMode}>
              Set Deep mode
            </button>
          ) : null}
          {props.selectedTurn &&
          (props.selectedTurnRecovery?.action === "retry" ||
            props.selectedTurnRecovery?.action === "retry_narrower") ? (
            <button
              type="button"
              className="mc-next-composer-inline-button"
              onClick={() => props.onRetryTurn(props.selectedTurn!.turnId)}
            >
              {props.mode === "cowork" ? "Retry run step" : "Retry turn"}
            </button>
          ) : null}
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
            <button
              type="button"
              className="mc-next-composer-primary"
              disabled={props.isStopPending}
              onClick={props.onStopActiveTurn}
            >
              {props.isStopPending ? "Stopping…" : "Stop turn"}
            </button>
          ) : (
            <button
              type="button"
              className="mc-next-composer-primary"
              disabled={!props.canSend}
              onClick={props.onSend}
              aria-describedby={!props.canSend && routeSendBlockReason ? sendBlockReasonId : undefined}
              title={!props.canSend ? (routeSendBlockReason ?? undefined) : undefined}
            >
              {sendLabel}
            </button>
          )}
        </div>
        {!props.canSend && routeSendBlockReason ? (
          <p id={sendBlockReasonId} className="mc-next-composer-helper mc-next-composer-send-block" role="status">
            {routeSendBlockReason}
          </p>
        ) : null}
      </div>
    </div>
  );
}
