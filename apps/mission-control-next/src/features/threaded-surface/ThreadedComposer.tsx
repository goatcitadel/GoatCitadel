/* eslint-disable max-lines -- The C3 closure-packet owner list pins the composer to this single file; the HX-407 external-source strip pushes it past the soft cap and the packet forbids splitting it. */
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatAttachmentActions } from "@goatcitadel/mission-control-shared/components/chat/ChatAttachmentActions";
import { ChatComposerPlusMenu } from "@goatcitadel/mission-control-shared/components/ChatComposerPlusMenu";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ChatQueueBar } from "@goatcitadel/mission-control-shared/components/chat/ChatQueueBar";
import {
  ChatPendingApprovalPanel,
  type ChatPendingApprovalState,
} from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import { ChatPendingUserInputPanel } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingUserInputPanel";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ContextStrip, type ContextStripMode, StatusChip } from "../native-routes/primitives";
import { describeThreadedUiError } from "./threaded-error-copy";
import { useAutoGrowTextarea } from "./useAutoGrowTextarea";
import { OPEN_CHAT_COMPOSER_PALETTE_EVENT } from "../../app/composer-palette-events";
import { ThreadedModeControl } from "./ThreadedModeControl";
import { isImageAttachment, PendingImagePreview } from "./ThreadedComposerAttachmentPreview";
import { getComposerPersonality, PersonalityPresenceChip } from "./ThreadedComposerPersonality";
import { ChatCapabilityProfilePreflight } from "./ChatCapabilityProfilePanel";

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

export function computeUsageTotals(thread: MissionThreadedActiveSessionSurfaceProps["thread"]) {
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

export function formatTokenLabel(tokens: number): string {
  return `${new Intl.NumberFormat("en-US").format(tokens)} tokens`;
}

export function formatCostLabel(costUsd: number): string {
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

export function formatUsageLabel(thread: MissionThreadedActiveSessionSurfaceProps["thread"]): string {
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
        Chat can split this into {roleSummary} with {formatDelegationMode(suggestion.mode)} execution.
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

function ComposerBlockedActionState({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const kind = props.pendingApproval ? "Approval needed" : "Input needed";
  const detail = props.pendingApproval
    ? "Resolve the approval before sending another instruction. The Work Record keeps the proof trail available."
    : "Answer the requested follow-up before this thread can continue.";

  return (
    <div className="mc-next-composer-blocked-actions" role="status" aria-live="polite">
      <StatusChip tone="warning">{kind}</StatusChip>
      <p>{detail}</p>
    </div>
  );
}

const COWORK_STOP_STATE_ONLY_NOTE =
  "State-only: records operator stop intent in GoatCitadel state. It does not terminate the worker by itself — a live executor must honor the recorded stop before the run is treated as stopped.";

function ComposerCoworkStop({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const control = props.coworkStopRunControl;
  if (props.mode !== "cowork" || !control) {
    return null;
  }
  const pending = Boolean(props.coworkStopRunPending);
  const stateOnly = control.runtimeEffect === "state_only";
  const reason = control.note?.trim() || undefined;
  const disabled = !control.enabled || pending;
  const confirmMessage = stateOnly
    ? "This records operator stop intent for the active run. For a cowork run with no attached durable run, it only records intent and does not terminate the worker — the run keeps going until a live executor honors the recorded stop."
    : "This cancels the active delegation run. Completed evidence stays available, and any live executor must honor the cancel before the run is treated as stopped.";

  return (
    <section className="mc-next-composer-banner mc-next-composer-cowork-stop" role="status">
      <StatusChip tone="warning">Delegation running</StatusChip>
      <div className="mc-next-composer-cowork-stop-body">
        <p>{reason ?? "Stop the active delegation run."}</p>
        {stateOnly ? <p className="mc-next-composer-cowork-stop-note">{COWORK_STOP_STATE_ONLY_NOTE}</p> : null}
      </div>
      <button
        type="button"
        className="mc-next-panel-button danger"
        disabled={disabled}
        title={reason}
        onClick={() => {
          if (!disabled) {
            setConfirmOpen(true);
          }
        }}
      >
        {pending ? "Stopping..." : "Stop run"}
      </button>
      <ConfirmModal
        open={confirmOpen}
        title="Stop this delegation run?"
        message={confirmMessage}
        confirmLabel="Stop run"
        danger
        pending={pending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          props.onCoworkStopRun?.(control);
        }}
      />
    </section>
  );
}

type ThreadedExternalSourceControls = NonNullable<MissionThreadedActiveSessionSurfaceProps["externalSourceControls"]>;

/**
 * HX-407 C3/C4b read-only external-source strip: content-free chips, explicit
 * per-turn selection, exact-CAS detach, and the governed knowledge-copy
 * request. Rendered only when the runtime composes the capability (the host
 * passes `null` while the Chat attachment routes are absent). Mutations are
 * live exactly when the durable reload carried the session incarnation
 * (`canMutate`); without it they stay disabled with an honest hint. Chips
 * never render transcript content or raw JSON, and no affordance edits the
 * immutable imported evidence.
 */
function ExternalSourceStrip({
  controls,
  disabled,
  openAttachFormToken = 0,
}: {
  controls: ThreadedExternalSourceControls;
  disabled: boolean;
  openAttachFormToken?: number;
}) {
  const stripInstanceId = useId();
  const stripRef = useRef<HTMLElement | null>(null);
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const [attachFormOpen, setAttachFormOpen] = useState(false);
  const [attachSourceId, setAttachSourceId] = useState("");
  const [attachImportId, setAttachImportId] = useState("");
  const [attachItemId, setAttachItemId] = useState("");
  const selectedCount = controls.selectedAttachmentIds.length;
  const attachReady =
    controls.canMutate && attachSourceId.trim() !== "" && attachImportId.trim() !== "" && attachItemId.trim() !== "";
  const mutationHint = controls.canMutate
    ? null
    : "Attach, detach, and knowledge-copy actions stay disabled until the server provides the live session incarnation.";

  useEffect(() => {
    if (openAttachFormToken <= 0) return;
    setAttachFormOpen(true);
    stripRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    globalThis.setTimeout(() => sourceInputRef.current?.focus(), 0);
  }, [openAttachFormToken]);

  return (
    <section
      ref={stripRef}
      className="mc-next-composer-external-strip"
      aria-label="Read-only external source attachments"
    >
      <div className="mc-next-composer-external-head">
        <strong>External sources</strong>
        <span aria-live="polite">
          {selectedCount > 0
            ? `${selectedCount} selected for the next turn`
            : "Select attachments to include in the next turn."}
        </span>
        {selectedCount > 0 ? (
          <button
            type="button"
            className="mc-next-composer-inline-button"
            onClick={controls.onClearSelection}
            aria-label="Clear the external source selection"
          >
            Clear selection
          </button>
        ) : null}
        <button
          type="button"
          className="mc-next-composer-inline-button"
          aria-expanded={attachFormOpen}
          onClick={() => setAttachFormOpen((current) => !current)}
        >
          {attachFormOpen ? "Close attach form" : "Attach imported item"}
        </button>
      </div>
      {controls.error ? (
        <p className="mc-next-composer-external-error" role="alert">
          {controls.error}
        </p>
      ) : null}
      {mutationHint ? <p className="mc-next-composer-external-hint">{mutationHint}</p> : null}
      {attachFormOpen ? (
        <div className="mc-next-composer-external-attach-form">
          <label htmlFor={`${stripInstanceId}-source`}>
            <span>Source id</span>
            <input
              ref={sourceInputRef}
              id={`${stripInstanceId}-source`}
              value={attachSourceId}
              disabled={disabled || !controls.canMutate}
              onChange={(event) => setAttachSourceId(event.target.value)}
            />
          </label>
          <label htmlFor={`${stripInstanceId}-import`}>
            <span>Import id</span>
            <input
              id={`${stripInstanceId}-import`}
              value={attachImportId}
              disabled={disabled || !controls.canMutate}
              onChange={(event) => setAttachImportId(event.target.value)}
            />
          </label>
          <label htmlFor={`${stripInstanceId}-item`}>
            <span>Item id</span>
            <input
              id={`${stripInstanceId}-item`}
              value={attachItemId}
              disabled={disabled || !controls.canMutate}
              onChange={(event) => setAttachItemId(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="mc-next-composer-inline-button"
            disabled={disabled || !attachReady}
            onClick={() => {
              controls.onAttach({
                sourceId: attachSourceId.trim(),
                importId: attachImportId.trim(),
                itemId: attachItemId.trim(),
              });
              setAttachFormOpen(false);
              setAttachSourceId("");
              setAttachImportId("");
              setAttachItemId("");
            }}
          >
            Attach read-only
          </button>
        </div>
      ) : null}
      {controls.attachments.length === 0 ? (
        <p className="mc-next-composer-external-hint">
          No external sources are attached to this session. Import them in the Library first.
        </p>
      ) : (
        <ul role="list" className="mc-next-composer-external-list">
          {controls.attachments.map((attachment) => {
            const busy = controls.busyAttachmentId !== null;
            const selected = controls.selectedAttachmentIds.includes(attachment.attachmentId);
            const checkboxId = `${stripInstanceId}-select-${attachment.attachmentId}`;
            return (
              <li key={attachment.attachmentId} className="mc-next-composer-external-chip">
                <div className="mc-next-composer-external-chip-body">
                  <label className="mc-next-composer-external-select" htmlFor={checkboxId}>
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={selected}
                      disabled={disabled}
                      onChange={() => controls.onToggleSelect(attachment.attachmentId)}
                      aria-label={`Include external source ${attachment.itemId} in the next turn`}
                    />
                    <strong>{attachment.itemId}</strong>
                  </label>
                  <p
                    className="mc-next-composer-external-meta"
                    title={`Source ${attachment.sourceId} · Import ${attachment.importId} · Item ${attachment.itemId}`}
                  >
                    Read-only external · rev {attachment.revision} · sha{" "}
                    {attachment.normalizedArtifactSha256.slice(0, 12)}…
                  </p>
                </div>
                <div className="mc-next-composer-external-chip-actions">
                  <StatusChip tone="muted">Read-only</StatusChip>
                  <button
                    type="button"
                    className="mc-next-composer-inline-button"
                    disabled={disabled || busy || !controls.canMutate}
                    onClick={() => controls.onRequestKnowledgeSnapshot(attachment.attachmentId)}
                    aria-label={`Request a governed knowledge copy of ${attachment.itemId}`}
                  >
                    Request knowledge copy
                  </button>
                  <button
                    type="button"
                    className="mc-next-composer-inline-button"
                    disabled={disabled || busy || !controls.canMutate}
                    onClick={() => controls.onDetach(attachment.attachmentId)}
                    aria-label={`Detach external source ${attachment.itemId}`}
                  >
                    Detach
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
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
  const capabilityProfile = props.routePreflight?.capabilityProfile;
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
  const composerPaletteVisible = commandSuggestionsOpen || Boolean(props.composerPalette?.globalOpen);
  const paletteSearchRef = useRef<HTMLInputElement | null>(null);
  const [externalSourceOpenToken, setExternalSourceOpenToken] = useState(0);
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
    const handlePaletteRequest = (event: Event) => {
      event.preventDefault();
      palette.onOpen();
    };
    window.addEventListener(OPEN_CHAT_COMPOSER_PALETTE_EVENT, handlePaletteRequest);
    return () => window.removeEventListener(OPEN_CHAT_COMPOSER_PALETTE_EVENT, handlePaletteRequest);
  }, [props.composerPalette]);
  useEffect(() => {
    if (props.composerPalette?.globalOpen) paletteSearchRef.current?.focus();
  }, [props.composerPalette?.globalOpen]);
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
    if (event.key === "Escape") {
      event.preventDefault();
      palette.onClose();
      props.composerRef.current?.focus();
      return;
    }
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
  const contextStripMode = toContextStripMode(props.mode);
  // planningEnabled was used by the inline Plan toggle, which moved to the
  // Context Drawer's Assist tab. The composer keeps the "Planning mode is on"
  // banner above the textarea via props.planningMode directly.
  const contextStripModel = currentRouteLabel ?? props.trust?.providerModelSummary ?? "Routing pending";
  const memoryLabel = formatHistoricalMemoryLabel(props.thread);
  const capabilityUseChips = getComposerCapabilityUseChips(props);
  const runtimeBlockerActive = Boolean(props.pendingApproval || props.pendingUserInput);
  const composerActionDisabled = props.sending || runtimeBlockerActive || props.historicalReadOnly;
  const researchArmed = props.currentWebMode === "quick" || props.currentWebMode === "deep";
  const reviewArmed = props.currentReviewDepth !== "off";
  const contextArmed = Boolean(
    props.contextSelection ||
    props.outboundContext ||
    props.pendingAttachments.length > 0 ||
    threadKnowledgeAttachments.length > 0 ||
    (props.externalSourceControls?.selectedAttachmentIds.length ?? 0) > 0,
  );
  const personality = getComposerPersonality(props);
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

      {capabilityProfile ? <ChatCapabilityProfilePreflight profile={capabilityProfile} /> : null}

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
          <ThreadedModeControl
            mode={props.modeOverridePending ?? (props.autoRouteActive ? undefined : props.mode)}
            preview={props.surfaceRoutePreview}
            variant="compact"
            interactive={false}
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

      {runtimeBlockerActive ? (
        <ComposerBlockedActionState props={props} />
      ) : (
        <div className="mc-next-composer-suggestion-row" aria-label="Composer send options">
          <button
            type="button"
            className="mc-next-composer-suggestion"
            aria-pressed={props.planningMode === "advisory"}
            disabled={composerActionDisabled}
            onClick={props.onTogglePlanningMode}
            title={props.planningMode === "advisory" ? "Planning is armed for Send" : "Plan before sending"}
          >
            Plan
          </button>
          <button
            type="button"
            className="mc-next-composer-suggestion"
            aria-pressed={researchArmed}
            disabled={composerActionDisabled}
            onClick={props.onToggleResearchMode}
            title={researchArmed ? "Research is armed for Send" : "Use research with the next send"}
          >
            Research
          </button>
          <button
            type="button"
            className="mc-next-composer-suggestion"
            aria-pressed={reviewArmed}
            disabled={composerActionDisabled}
            onClick={props.onToggleReviewMode}
            title={reviewArmed ? "Review is armed for Send" : "Request review posture with the next send"}
          >
            Review
          </button>
          <button
            type="button"
            className="mc-next-composer-suggestion"
            aria-pressed={Boolean(props.modelCouncilEnabled)}
            disabled={composerActionDisabled || !props.onToggleModelCouncil}
            onClick={props.onToggleModelCouncil}
            title={
              props.modelCouncilEnabled
                ? "Read-only model council is armed for Send"
                : "Ask a governed read-only model council, then return one Chat answer"
            }
          >
            Council
          </button>
          <button
            type="button"
            className="mc-next-composer-suggestion"
            aria-pressed={contextArmed}
            disabled={composerActionDisabled}
            onClick={props.onAttachFiles}
            title={contextArmed ? "Context is attached for Send" : "Attach files or context before sending"}
          >
            Attach context
          </button>
        </div>
      )}

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

      <ComposerCoworkStop props={props} />

      {props.liveVoiceActive || props.liveVoiceState === "error" ? (
        <section
          className="mc-next-composer-live-voice"
          data-state={props.liveVoiceState ?? "idle"}
          role="status"
          aria-live="polite"
        >
          <StatusChip tone={props.liveVoiceState === "error" ? "critical" : "success"}>OpenAI Realtime</StatusChip>
          <p>{props.liveVoiceStatusLabel ?? "OpenAI Realtime voice"}</p>
          <div className="mc-next-composer-action-row">
            {props.liveVoiceActive ? (
              <button
                type="button"
                className="mc-next-composer-inline-button"
                disabled={props.historicalReadOnly}
                onClick={props.onToggleLiveVoiceMute}
              >
                {props.liveVoiceMuted ? "Unmute mic" : "Mute mic"}
              </button>
            ) : null}
            <button
              type="button"
              className="mc-next-composer-inline-button primary"
              disabled={props.historicalReadOnly || (!props.liveVoiceActive && !props.liveVoiceAvailable)}
              title={!props.liveVoiceActive ? (props.liveVoiceUnavailableReason ?? undefined) : undefined}
              onClick={props.onToggleLiveVoice}
            >
              {props.liveVoiceActive ? "Stop live voice" : "Start live voice"}
            </button>
          </div>
        </section>
      ) : null}

      <div className="mc-next-composer-input-shell">
        <textarea
          ref={props.composerRef}
          disabled={props.historicalReadOnly}
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={props.onComposerKeyDown}
          onPaste={props.onComposerPaste}
          placeholder={getPlaceholder(props.mode)}
          rows={2}
          role="combobox"
          aria-label="Message composer"
          aria-autocomplete="list"
          aria-expanded={composerPaletteVisible}
          aria-controls={composerPaletteVisible ? commandSuggestionsListboxId : undefined}
          aria-activedescendant={commandSuggestionsActiveDescendant}
        />
      </div>

      {composerPaletteVisible ? (
        <div className={`mc-next-command-popover${props.composerPalette?.globalOpen ? " palette-sheet" : ""}`}>
          {props.composerPalette?.globalOpen ? (
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
                  {item.sourceLabel || item.availabilityLabel ? (
                    <small>
                      {item.sourceLabel ?? "Command"} · {item.availabilityLabel ?? "Available"}
                    </small>
                  ) : null}
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
                  aria-label="Knowledge URL mode"
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
