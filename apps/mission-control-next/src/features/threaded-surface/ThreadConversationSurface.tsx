import { useId, useState } from "react";
import { Info, Menu, PanelRight } from "lucide-react";
import type { ChatMode } from "@goatcitadel/contracts";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedDropTargetProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { buildThreadedSessionStatusSummary } from "@goatcitadel/threaded-surface-core/work-trust";
import { ChatModelPicker } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import { ChatExecutionPlanSummary } from "@goatcitadel/mission-control-shared/components/chat/ChatExecutionPlanSummary";
import { ChatChangePlanCard } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard";
import { StatusChip, type StatusChipTone } from "../native-routes/primitives";
import { ThreadedComposer } from "./ThreadedComposer";
import { ThreadedTimeline } from "./ThreadedTimeline";
import { ThreadedModeControl } from "./ThreadedModeControl";
import { resolveChatRouteReadiness } from "./chat-route-readiness";
import { ChatTimerPanel } from "./ChatTimerPanel";
import { RunVariablePanel } from "./RunVariablePanel";
import { SessionControlBanner } from "./SessionControlBanner";
import { HistoricalConversationView } from "./ThreadHistoricalConversation";
import { formatThreadedPermissionSummary, type ThreadedPermissionState } from "./threaded-surface-model";

export function ThreadConversationSurface({
  // `surface` is part of the typed prop contract but not consumed here; don't destructure it.
  props,
  dropTarget,
  dockOpen,
  railOpen,
  changePlanReceipt,
  onReviewChangePlan,
  onToggleSessionRail,
  onToggleActivity,
  onOpenActivity,
  permissionState,
  onOpenUniversalRunDetail,
}: {
  surface: ChatMode;
  props: MissionThreadedActiveSessionSurfaceProps;
  dropTarget: MissionThreadedDropTargetProps;
  dockOpen: boolean;
  railOpen: boolean;
  changePlanReceipt?: MissionThreadedRenderSurfaceInput["changePlanReceipt"];
  onReviewChangePlan?: MissionThreadedRenderSurfaceInput["onReviewChangePlan"];
  onToggleSessionRail: () => void;
  onToggleActivity: () => void;
  onOpenActivity: (turnId?: string) => void;
  permissionState?: ThreadedPermissionState;
  onOpenUniversalRunDetail?: (runId: string) => void;
}) {
  const approvalSignalText = `${props.trust.approvalsSummary} ${props.trust.runStateSummary ?? ""}`.toLowerCase();
  const approvalsAreBlocking =
    props.approvalsCount > 0 &&
    (approvalSignalText.includes("approval") ||
      approvalSignalText.includes("pending") ||
      approvalSignalText.includes("waiting"));
  const permissionSummary = formatThreadedPermissionSummary(permissionState);
  const headerStatus = buildThreadedSessionStatusSummary({
    trust: props.trust,
    policySummary: permissionSummary,
    policyOverrideActive: Boolean(permissionState?.localOperatorOverrideId),
  });
  // Nothing is "pending" when no provider exists; match the start canvas.
  const headerModelSummary =
    resolveChatRouteReadiness(props).state === "no_provider" ? "Not connected" : headerStatus.providerModelSummary;
  const routeSelectionSummary = props.routePreflight?.selectionSource
    ? `Selection: ${props.routePreflight.selectionSource}`
    : (props.trust.selectionSourceSummary ?? "Route pending");
  // A pending approval is explained once, by the composer's approval panel.
  const composerGateHint =
    !props.pendingApproval && props.pendingUserInput
      ? "This chat needs one answer to continue. You can reply below."
      : null;

  return (
    <div
      className={`mc-next-threaded-dropzone${dropTarget.isDragActive ? " drop-active" : ""}`}
      onDragEnter={dropTarget.onDragEnter}
      onDragOver={dropTarget.onDragOver}
      onDragLeave={dropTarget.onDragLeave}
      onDrop={dropTarget.onDrop}
    >
      {dropTarget.isDragActive ? (
        <div className="mc-next-threaded-drop-overlay">Drop files to attach to this thread</div>
      ) : null}
      <header className="mc-next-threaded-header">
        <div className="mc-next-threaded-header-copy">
          <ThreadedModeControl
            mode={props.modeOverridePending ?? (props.autoRouteActive ? undefined : props.mode)}
            preview={props.surfaceRoutePreview}
            onOverride={props.onModeOverride}
            variant="compact"
          />
          <div className="mc-next-threaded-title-block">
            <h1>{props.sessionTitle}</h1>
          </div>
          <span>{props.summary}</span>
        </div>

        <div className="mc-next-threaded-header-actions">
          <CompactModelControl
            providerModelSummary={headerModelSummary}
            providers={props.providerOptions}
            providerId={props.selectedProviderId}
            model={props.selectedModel}
            disabled={props.modelSwitchDisabled}
            onChangeProvider={props.onRequestProviderChange}
            onChangeModel={props.onRequestModelChange}
          />
          <details className="mc-next-chat-details">
            <summary aria-label="Chat details">
              <Info size={14} aria-hidden="true" />
              <span className="mc-next-header-button-label">Details</span>
            </summary>
            <p>{props.summary}</p>
            <div className="mc-next-threaded-header-meta">
              <div className="mc-next-threaded-chip-row">
                <StatusChip
                  tone="muted"
                  title="Active provider and model for this session"
                  ariaLabel={`Model: ${headerStatus.providerModelSummary}`}
                >
                  {headerStatus.providerModelSummary}
                </StatusChip>
                <StatusChip tone="muted" title="Route selection source" ariaLabel={`Route: ${routeSelectionSummary}`}>
                  {routeSelectionSummary}
                </StatusChip>
                <StatusChip
                  tone={props.trust.runtimeTone ?? "muted"}
                  title="Session runtime and active run state"
                  ariaLabel={`Runtime: ${headerStatus.runtimeRunSummary}`}
                >
                  {headerStatus.runtimeRunSummary}
                </StatusChip>
                <StatusChip
                  tone="muted"
                  title="Pending tool and risk approvals waiting on you"
                  ariaLabel={`Approvals: ${headerStatus.approvalsSummary}`}
                >
                  {headerStatus.approvalsSummary}
                </StatusChip>
                <StatusChip
                  tone={permissionState?.localOperatorOverrideId ? "warning" : "muted"}
                  title="Session policy posture"
                  ariaLabel={`Policy: ${headerStatus.compactPolicySummary}`}
                >
                  {headerStatus.compactPolicySummary}
                </StatusChip>
              </div>
            </div>
          </details>

          <div className={`mc-next-threaded-action-row${approvalsAreBlocking ? " has-priority-approval" : ""}`}>
            <button
              type="button"
              className="mc-next-threaded-secondary mc-next-threaded-threads"
              aria-controls="mc-next-threaded-session-rail"
              aria-expanded={railOpen}
              onClick={onToggleSessionRail}
            >
              <Menu size={14} />
              <span className="mc-next-header-button-label">Threads</span>
            </button>
            <button
              type="button"
              className="mc-next-threaded-secondary mc-next-threaded-work-record"
              aria-controls="mc-next-threaded-context-panel"
              aria-expanded={dockOpen}
              onClick={onToggleActivity}
            >
              <PanelRight size={14} />
              <span className="mc-next-header-button-label">Activity</span>
            </button>
            {props.approvalsCount > 0 ? (
              <button
                type="button"
                className={`mc-next-threaded-approval-review ${
                  approvalsAreBlocking ? "mc-next-threaded-primary" : "mc-next-threaded-secondary"
                }`}
                onClick={() => props.onOpenApprovals()}
              >
                Approvals ({props.approvalsCount})
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <section className="mc-next-threaded-conversation">
        <div className="mc-next-threaded-timeline-region">
          {props.selectedTurn?.trace.executionPlan ? (
            <ExecutionPlanDisclosure
              plan={props.selectedTurn.trace.executionPlan}
              status={approvalsAreBlocking ? "Waiting for approval" : headerStatus.runtimeRunSummary}
              tone={approvalsAreBlocking ? "warning" : (props.trust.runtimeTone ?? "muted")}
            />
          ) : null}
          {props.historicalWindow || props.historicalWindowLoading || props.historicalWindowError ? (
            <section className="mc-next-threaded-history-banner" aria-live="polite">
              <div>
                <strong>Viewing history around search result</strong>
                <span>Sending is paused until you return to the latest conversation.</span>
              </div>
              <button type="button" className="mc-next-threaded-secondary" onClick={props.onReturnToLatest}>
                Return to latest
              </button>
            </section>
          ) : null}
          {props.sessionControlBanner ? <SessionControlBanner {...props.sessionControlBanner} /> : null}
          {props.chatTimerPanel ? <ChatTimerPanel panel={props.chatTimerPanel} /> : null}
          {props.runVariablePanel ? <RunVariablePanel panel={props.runVariablePanel} /> : null}
          <div className="mc-next-threaded-thread-card">
            {changePlanReceipt ? <ChatChangePlanCard {...changePlanReceipt} /> : null}
            {props.historicalWindow || props.historicalWindowLoading || props.historicalWindowError ? (
              <HistoricalConversationView props={props} />
            ) : (
              <ThreadedTimeline
                props={props}
                onReviewChangePlan={onReviewChangePlan}
                onOpenActivity={onOpenActivity}
                onOpenUniversalRunDetail={onOpenUniversalRunDetail}
              />
            )}
          </div>
        </div>
        <div className="mc-next-threaded-composer-card">
          {props.historicalWindow || props.historicalWindowLoading || props.historicalWindowError ? (
            <p className="mc-next-threaded-history-send-lock">
              Return to latest before sending or editing this conversation.
            </p>
          ) : null}
          {composerGateHint ? (
            <p className="mc-next-threaded-composer-gate-hint" role="status">
              {composerGateHint}
            </p>
          ) : null}
          <ThreadedComposer props={props} />
        </div>
      </section>
    </div>
  );
}

export function CompactModelControl({
  providerModelSummary,
  providers,
  providerId,
  model,
  disabled,
  onChangeProvider,
  onChangeModel,
}: {
  providerModelSummary: string;
  providers: MissionThreadedActiveSessionSurfaceProps["providerOptions"];
  providerId: MissionThreadedActiveSessionSurfaceProps["selectedProviderId"];
  model: MissionThreadedActiveSessionSurfaceProps["selectedModel"];
  disabled: MissionThreadedActiveSessionSurfaceProps["modelSwitchDisabled"];
  onChangeProvider: MissionThreadedActiveSessionSurfaceProps["onRequestProviderChange"];
  onChangeModel: MissionThreadedActiveSessionSurfaceProps["onRequestModelChange"];
}) {
  const [open, setOpen] = useState(false);
  const controlsId = useId();

  return (
    <details
      className="mc-next-threaded-model-control"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-expanded={open} aria-controls={controlsId} title="View or change the model for this chat">
        <span>Model</span>
        <strong>{providerModelSummary}</strong>
      </summary>
      <div id={controlsId} className="mc-next-threaded-model-control-body">
        <ChatModelPicker
          providers={providers}
          providerId={providerId}
          model={model}
          disabled={disabled}
          onChangeProvider={onChangeProvider}
          onChangeModel={onChangeModel}
        />
      </div>
    </details>
  );
}

export function ExecutionPlanDisclosure({
  plan,
  status,
  tone,
}: {
  plan: NonNullable<NonNullable<MissionThreadedActiveSessionSurfaceProps["selectedTurn"]>["trace"]["executionPlan"]>;
  status: string;
  tone: StatusChipTone;
}) {
  const [open, setOpen] = useState(false);
  const controlsId = useId();
  return (
    <details
      className="mc-next-threaded-execution-overview"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-expanded={open} aria-controls={controlsId}>
        <span>Current plan</span>
        <StatusChip tone={tone}>{status}</StatusChip>
      </summary>
      <div id={controlsId}>
        <ChatExecutionPlanSummary plan={plan} />
      </div>
    </details>
  );
}
