import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";
import { AgenticRuntimeVisibilityPanel } from "@goatcitadel/mission-control-shared/components/AgenticRuntimeVisibilityPanel";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { StatusChip } from "../../native-routes/primitives";
import { describeAgenticControlCopy } from "./format";
import { PanelList } from "./PanelList";

type CoworkPanelType = Extract<MissionThreadedWorkflowPanel, { kind: "cowork" }>;

type CoworkTabId = "plan" | "run-map" | "timeline" | "actions";

const COWORK_TAB_DEFS: ReadonlyArray<{ id: CoworkTabId; label: string }> = [
  { id: "plan", label: "Plan" },
  { id: "run-map", label: "Run Map" },
  { id: "timeline", label: "Timeline" },
  { id: "actions", label: "Operator actions" },
];

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function NextCoworkPanel({ panel }: { panel: CoworkPanelType }) {
  const {
    viewModel,
    onRetryTurn,
    onStopTurn,
    onOpenTasks,
    onOpenDetails,
    onFocusComposer,
    onRefreshRunState,
    onAgenticControl,
    agenticControlPending,
    agenticControlStatus,
  } = panel.props;
  const [activeTab, setActiveTab] = useState<CoworkTabId>("plan");
  const [stopRunConfirmOpen, setStopRunConfirmOpen] = useState(false);
  const tabIdPrefix = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeTrace = viewModel.raw.selectedTurn?.trace ?? viewModel.raw.activeTurn?.trace ?? null;
  const pendingApproval = activeTrace?.pendingApprovalSummary;
  const activeTabIndex = COWORK_TAB_DEFS.findIndex((tab) => tab.id === activeTab);
  const focusTabAt = useCallback((index: number) => {
    const wrapped = ((index % COWORK_TAB_DEFS.length) + COWORK_TAB_DEFS.length) % COWORK_TAB_DEFS.length;
    const nextTab = COWORK_TAB_DEFS[wrapped];
    if (!nextTab) {
      return;
    }
    setActiveTab(nextTab.id);
    queueMicrotask(() => {
      tabRefs.current[wrapped]?.focus();
    });
  }, []);
  const handleTabKeyDown = useCallback(
    (index: number) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          focusTabAt(index + 1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          focusTabAt(index - 1);
          break;
        case "Home":
          event.preventDefault();
          focusTabAt(0);
          break;
        case "End":
          event.preventDefault();
          focusTabAt(COWORK_TAB_DEFS.length - 1);
          break;
        default:
          break;
      }
    },
    [focusTabAt],
  );
  const buildTabId = (tabId: CoworkTabId) => `${tabIdPrefix}-cowork-tab-${tabId}`;
  const buildPanelId = (tabId: CoworkTabId) => `${tabIdPrefix}-cowork-panel-${tabId}`;
  const requestedModel =
    activeTrace?.routing.primaryModel ?? activeTrace?.routing.fallbackModel ?? activeTrace?.model ?? "not requested";
  const effectiveModel = activeTrace?.routing.effectiveModel ?? activeTrace?.model ?? "not resolved";
  const activeAgentSummary = viewModel.agenticRuntime
    ? `${viewModel.agenticRuntime.nodeCount} runtime nodes`
    : `${viewModel.roleItems.items.length}${viewModel.roleItems.overflow ? "+" : ""} visible roles`;

  return (
    <section className={`mc-next-cowork-panel${viewModel.empty ? " is-empty" : ""}`}>
      <header className="mc-next-cowork-head">
        <div>
          <p className="mc-next-panel-kicker">Cowork</p>
          <h4>{viewModel.headerTitle}</h4>
          <p>{viewModel.headerSummary}</p>
        </div>
        <div className="mc-next-cowork-toolbar">
          {onOpenDetails ? (
            <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>
              Run details
            </button>
          ) : null}
          {onStopTurn ? (
            <button type="button" className="mc-next-panel-button" onClick={() => setStopRunConfirmOpen(true)}>
              Stop at checkpoint
            </button>
          ) : null}
        </div>
      </header>

      <ConfirmModal
        open={stopRunConfirmOpen}
        title="Stop at next checkpoint?"
        message="This records operator stop intent for the active run. Completed evidence stays available, and any live executor must still honor the checkpoint before the run is treated as stopped."
        confirmLabel="Stop at checkpoint"
        danger
        onCancel={() => setStopRunConfirmOpen(false)}
        onConfirm={() => {
          setStopRunConfirmOpen(false);
          onStopTurn?.();
        }}
      />

      <CoworkCommandCenter
        viewModel={viewModel}
        activeAgentSummary={activeAgentSummary}
        requestedModel={requestedModel}
        effectiveModel={effectiveModel}
        pendingApprovalLabel={
          pendingApproval ? (pendingApproval.description ?? pendingApproval.kind ?? "Pending approval") : "None pending"
        }
        onRetryTurn={onRetryTurn}
        onOpenTasks={onOpenTasks}
        onOpenDetails={onOpenDetails}
        onFocusComposer={onFocusComposer}
        onRefreshRunState={onRefreshRunState}
      />

      <CoworkInterventionPanel
        viewModel={viewModel}
        pendingApprovalLabel={
          pendingApproval ? (pendingApproval.description ?? pendingApproval.kind ?? "Pending approval") : "None pending"
        }
        pendingApprovalId={pendingApproval?.approvalId}
        onOpenDetails={onOpenDetails}
        onShowTimeline={() => setActiveTab("timeline")}
      />

      <div className="mc-next-cowork-stage-strip">
        {viewModel.stageCards.map((item) => (
          <div key={`${item.label}-${item.value}`} className="mc-next-cowork-stage-card">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>

      <div className="mc-next-panel-tab-row" role="tablist" aria-label="Cowork workflow views">
        {COWORK_TAB_DEFS.map((tab, index) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={buildTabId(tab.id)}
              aria-selected={selected}
              aria-controls={buildPanelId(tab.id)}
              tabIndex={index === activeTabIndex ? 0 : -1}
              className={`mc-next-panel-tab${selected ? " active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={handleTabKeyDown(index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "plan" ? (
        <div
          className="mc-next-cowork-grid"
          role="tabpanel"
          id={buildPanelId("plan")}
          aria-labelledby={buildTabId("plan")}
        >
          <PanelList
            title="Plan"
            items={viewModel.planItems.items}
            emptyCopy="Cowork has not attached a visible plan yet."
          />
          <PanelList
            title="Roles / steps"
            items={viewModel.roleItems.items}
            emptyCopy="Role activity will land here when the run fans out."
          />
          <PanelList
            title="Outputs / tasks"
            items={viewModel.outputItems.items}
            emptyCopy="Outputs and attached tasks will appear here as the run produces them."
          />
        </div>
      ) : null}

      {activeTab === "run-map" ? (
        <div role="tabpanel" id={buildPanelId("run-map")} aria-labelledby={buildTabId("run-map")}>
          <RunMapPanel viewModel={viewModel} onOpenDetails={onOpenDetails} />
        </div>
      ) : null}

      {activeTab === "timeline" ? (
        <div role="tabpanel" id={buildPanelId("timeline")} aria-labelledby={buildTabId("timeline")}>
          <CheckpointTimelinePanel viewModel={viewModel} fallbackItems={viewModel.timelineItems.items} />
        </div>
      ) : null}

      {activeTab === "actions" ? (
        <div role="tabpanel" id={buildPanelId("actions")} aria-labelledby={buildTabId("actions")}>
          <PanelList
            title="Operator actions"
            items={viewModel.operatorActionItems.items}
            emptyCopy="Operator actions will collect here when Cowork needs follow-up work."
          />
        </div>
      ) : null}

      {viewModel.blockers.length > 0 ? (
        <section className="mc-next-cowork-blockers">
          <p className="mc-next-panel-kicker">Blockers</p>
          {viewModel.blockers.map((blocker) => (
            <article key={blocker.id} className="mc-next-cowork-blocker">
              <div className="mc-next-cowork-blocker-head">
                <strong>{blocker.title}</strong>
                {onOpenDetails ? (
                  <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>
                    Details
                  </button>
                ) : null}
              </div>
              <p>{blocker.summary}</p>
            </article>
          ))}
        </section>
      ) : null}

      {viewModel.agenticRuntime ? (
        <AgenticRuntimePanel
          viewModel={viewModel}
          onAgenticControl={onAgenticControl}
          agenticControlPending={agenticControlPending}
          agenticControlStatus={agenticControlStatus}
        />
      ) : null}
    </section>
  );
}

function CoworkCommandCenter({
  viewModel,
  activeAgentSummary,
  requestedModel,
  effectiveModel,
  pendingApprovalLabel,
  onRetryTurn,
  onOpenTasks,
  onOpenDetails,
  onFocusComposer,
  onRefreshRunState,
}: {
  viewModel: CoworkPanelType["props"]["viewModel"];
  activeAgentSummary: string;
  requestedModel: string;
  effectiveModel: string;
  pendingApprovalLabel: string;
  onRetryTurn?: () => void;
  onOpenTasks?: () => void;
  onOpenDetails?: () => void;
  onFocusComposer?: () => void;
  onRefreshRunState?: () => void;
}) {
  return (
    <section className="mc-next-cowork-command-center" aria-label="Cowork current objective and action">
      <div className="mc-next-cowork-command-primary">
        <p className="mc-next-panel-kicker">Current objective</p>
        <h5>{viewModel.runMap.objective || viewModel.headerTitle}</h5>
        <p>{viewModel.now.summary}</p>
        {viewModel.now.facts.length > 0 ? (
          <dl className="mc-next-cowork-facts">
            {viewModel.now.facts.map((fact) => (
              <div key={`${fact.label}-${fact.value}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      <div className="mc-next-cowork-command-state">
        <p className="mc-next-panel-kicker">{viewModel.now.label}</p>
        <h5>{viewModel.now.title}</h5>
        <dl>
          <div>
            <dt>Agents</dt>
            <dd>{activeAgentSummary}</dd>
          </div>
          <div>
            <dt>Approval</dt>
            <dd>{pendingApprovalLabel}</dd>
          </div>
          <div>
            <dt>Evidence</dt>
            <dd>{viewModel.evidenceSummary.detail}</dd>
          </div>
          <div>
            <dt>Model route</dt>
            <dd>
              {requestedModel}
              {" -> "}
              {effectiveModel}
            </dd>
          </div>
        </dl>
      </div>
      <div className="mc-next-cowork-command-action">
        <p className="mc-next-panel-kicker">Next operator action</p>
        <h5>{viewModel.nextAction?.label ?? viewModel.runMap.nextAction}</h5>
        <p>{viewModel.nextAction?.note ?? "Inspect run evidence before changing course."}</p>
        <CoworkNextActionButton
          viewModel={viewModel}
          onRetryTurn={onRetryTurn}
          onOpenTasks={onOpenTasks}
          onOpenDetails={onOpenDetails}
          onFocusComposer={onFocusComposer}
          onRefreshRunState={onRefreshRunState}
        />
      </div>
    </section>
  );
}

function CoworkNextActionButton({
  viewModel,
  onRetryTurn,
  onOpenTasks,
  onOpenDetails,
  onFocusComposer,
  onRefreshRunState,
}: {
  viewModel: CoworkPanelType["props"]["viewModel"];
  onRetryTurn?: () => void;
  onOpenTasks?: () => void;
  onOpenDetails?: () => void;
  onFocusComposer?: () => void;
  onRefreshRunState?: () => void;
}) {
  const action = viewModel.nextAction;
  if (!action) {
    return null;
  }
  const handler =
    action.kind === "retry_turn"
      ? onRetryTurn
      : action.kind === "refresh_run_state"
        ? onRefreshRunState
        : action.kind === "open_tasks"
          ? onOpenTasks
          : action.kind === "focus_composer"
            ? onFocusComposer
            : onOpenDetails;
  if (!handler) {
    return null;
  }
  return (
    <button type="button" className="mc-next-panel-button primary" onClick={handler}>
      {action.label}
    </button>
  );
}

function CoworkInterventionPanel({
  viewModel,
  pendingApprovalLabel,
  pendingApprovalId,
  onOpenDetails,
  onShowTimeline,
}: {
  viewModel: CoworkPanelType["props"]["viewModel"];
  pendingApprovalLabel: string;
  pendingApprovalId?: string;
  onOpenDetails?: () => void;
  onShowTimeline: () => void;
}) {
  const checkpointCount = Math.max(
    viewModel.runMap.checkpoints.length,
    viewModel.raw.orchestrationCheckpoints.length,
    viewModel.evidenceSummary.checkpointCount,
  );
  const approvalBlocked =
    pendingApprovalLabel !== "None pending" ||
    viewModel.continuationGate.metrics.approvalWait ||
    viewModel.continuationGate.reasonCodes.includes("approval_wait");

  // H-6: auto-focus and scroll a newly arrived approval into view.
  // - `seenApprovalIdsRef` tracks every approval ID we have rendered so we
  //   only autofocus *true* new arrivals — re-renders for the same approval
  //   do not steal focus repeatedly.
  // - `consumedApprovalIdsRef` records which arrivals we have already auto-
  //   focused so React StrictMode double-invocation cannot trigger focus twice.
  // - On the very first observed snapshot we prime the seen set without
  //   focusing, matching the ApprovalsRoutePage `seenPendingIdsRef` pattern.
  // - `prefers-reduced-motion` callers get `behavior: "auto"` instead of smooth
  //   scrolling.
  const approvalArticleRef = useRef<HTMLElement | null>(null);
  const approvalResolveButtonRef = useRef<HTMLButtonElement | null>(null);
  const seenApprovalIdsRef = useRef<Set<string>>(new Set());
  const consumedApprovalIdsRef = useRef<Set<string>>(new Set());
  const hasPrimedApprovalSeenRef = useRef<boolean>(false);

  useEffect(() => {
    if (!pendingApprovalId) {
      return;
    }
    // Prime the seen set on first observation so the initial paint does not
    // hijack focus when an approval is already pending.
    if (!hasPrimedApprovalSeenRef.current) {
      hasPrimedApprovalSeenRef.current = true;
      seenApprovalIdsRef.current.add(pendingApprovalId);
      return;
    }
    if (seenApprovalIdsRef.current.has(pendingApprovalId)) {
      return;
    }
    seenApprovalIdsRef.current.add(pendingApprovalId);
    if (consumedApprovalIdsRef.current.has(pendingApprovalId)) {
      return;
    }
    consumedApprovalIdsRef.current.add(pendingApprovalId);

    const reduced = prefersReducedMotion();
    const articleNode = approvalArticleRef.current;
    if (articleNode && typeof articleNode.scrollIntoView === "function") {
      articleNode.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
    }
    // Defer focus by one microtask so the scroll commit and any conditional
    // render of the Resolve approval button has settled before we move focus.
    queueMicrotask(() => {
      approvalResolveButtonRef.current?.focus();
    });
  }, [pendingApprovalId]);

  return (
    <section className="mc-next-cowork-intervention" aria-label="Cowork blockers approvals and checkpoints">
      <article className={viewModel.blockers.length > 0 ? "is-attention" : ""}>
        <p className="mc-next-panel-kicker">Blockers</p>
        <h5>{viewModel.blockers.length > 0 ? `${viewModel.blockers.length} need attention` : "None blocking"}</h5>
        {viewModel.blockers.slice(0, 2).map((blocker) => (
          <p key={blocker.id}>{blocker.summary}</p>
        ))}
        {viewModel.blockers.length === 0 ? <p>Current run state has no visible blocker.</p> : null}
      </article>
      <article ref={approvalArticleRef} className={approvalBlocked ? "is-attention" : ""}>
        <p className="mc-next-panel-kicker">Approvals</p>
        <h5>{approvalBlocked ? "Operator decision needed" : "Clear"}</h5>
        <p>{pendingApprovalLabel}</p>
        {approvalBlocked && onOpenDetails ? (
          <button ref={approvalResolveButtonRef} type="button" className="mc-next-panel-button" onClick={onOpenDetails}>
            Resolve approval
          </button>
        ) : null}
      </article>
      <article>
        <p className="mc-next-panel-kicker">Checkpoints</p>
        <h5>{checkpointCount > 0 ? `${checkpointCount} retained` : "None yet"}</h5>
        <p>{viewModel.continuationGate.summary}</p>
        <button type="button" className="mc-next-panel-button" onClick={onShowTimeline}>
          Inspect checkpoints
        </button>
      </article>
    </section>
  );
}

function RunMapPanel({
  viewModel,
  onOpenDetails,
}: {
  viewModel: CoworkPanelType["props"]["viewModel"];
  onOpenDetails?: () => void;
}) {
  const gate = viewModel.continuationGate;
  return (
    <section className="mc-next-cowork-run-map">
      <div className="mc-next-cowork-run-map-head">
        <div>
          <p className="mc-next-panel-kicker">Run map</p>
          <h5>{viewModel.runMap.objective}</h5>
          <p>{viewModel.runMap.currentState}</p>
        </div>
        <StatusChip
          tone={gate.decision === "continue" ? "success" : gate.decision === "checkpoint" ? "warning" : "critical"}
        >
          Gate: {gate.decision}
        </StatusChip>
      </div>

      <div className="mc-next-cowork-run-map-grid">
        <section>
          <p className="mc-next-panel-kicker">Current state</p>
          <strong>{viewModel.runMap.currentState}</strong>
          <span>{gate.summary}</span>
        </section>
        <section>
          <p className="mc-next-panel-kicker">Next action</p>
          <strong>{viewModel.runMap.nextAction}</strong>
          <span>{gate.recommendedAction}</span>
        </section>
        <section>
          <p className="mc-next-panel-kicker">State gaps</p>
          <strong>{viewModel.stateGaps.length ? `${viewModel.stateGaps.length} open` : "None"}</strong>
          <span>{viewModel.stateGaps.join(" · ") || "No state gaps detected in the current view."}</span>
        </section>
      </div>

      <div className="mc-next-cowork-run-map-graph" aria-label="Cowork plan graph">
        {viewModel.runMap.planNodes.map((node, index) => (
          <div key={node.id} className="mc-next-cowork-run-map-node-wrap">
            <article
              className={`mc-next-cowork-run-map-node ${coworkStatusClass(node.status)}`}
              aria-label={`${node.label}: ${node.status}`}
            >
              <span>{node.status}</span>
              <strong>{node.label}</strong>
              {node.meta ? <p>{node.meta}</p> : null}
            </article>
            {index < viewModel.runMap.planNodes.length - 1 ? <span className="mc-next-cowork-run-map-link" /> : null}
          </div>
        ))}
      </div>

      <div className="mc-next-cowork-run-map-footer">
        <section>
          <p className="mc-next-panel-kicker">{viewModel.evidenceSummary.label}</p>
          <strong>{viewModel.evidenceSummary.detail}</strong>
          <span>
            Tool calls {gate.metrics.toolRunCount} · failures {gate.metrics.failedToolRunCount} · gaps{" "}
            {gate.metrics.evidenceGapCount}
          </span>
        </section>
        <section>
          <p className="mc-next-panel-kicker">Checkpoint timeline</p>
          <strong>{viewModel.runMap.checkpoints.length} retained</strong>
          <span>
            {viewModel.runMap.checkpoints.at(0)?.title
              ? `Latest: ${viewModel.runMap.checkpoints.at(0)?.title}`
              : "No checkpoints yet."}
          </span>
        </section>
        {onOpenDetails ? (
          <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>
            Inspect evidence
          </button>
        ) : null}
      </div>
      <CheckpointTimelinePanel viewModel={viewModel} compact />
    </section>
  );
}

function CheckpointTimelinePanel({
  viewModel,
  fallbackItems = [],
  compact = false,
}: {
  viewModel: CoworkPanelType["props"]["viewModel"];
  fallbackItems?: CoworkPanelType["props"]["viewModel"]["timelineItems"]["items"];
  compact?: boolean;
}) {
  const rows = buildCheckpointRows(viewModel, fallbackItems);
  return (
    <section className={`mc-next-cowork-checkpoints${compact ? " compact" : ""}`}>
      <div className="mc-next-cowork-checkpoints-head">
        <div>
          <p className="mc-next-panel-kicker">Timestamped checkpoints</p>
          <h5>{rows.length > 0 ? `${rows.length} retained` : "No checkpoints yet"}</h5>
        </div>
        <StatusChip tone={viewModel.continuationGate.decision === "continue" ? "success" : "warning"}>
          {viewModel.continuationGate.decision}
        </StatusChip>
      </div>
      {rows.length > 0 ? (
        <ol className="mc-next-cowork-checkpoint-list">
          {rows.map((row) => (
            <li key={row.id}>
              <details>
                <summary>
                  <span>{row.timestamp}</span>
                  <strong>{row.title}</strong>
                  {row.meta ? <em>{row.meta}</em> : null}
                </summary>
                <p>{row.summary}</p>
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p>Recent checkpoints will appear here once the run starts moving.</p>
      )}
    </section>
  );
}

type CoworkCheckpointRow = {
  id: string;
  title: string;
  timestamp: string;
  meta?: string;
  summary: string;
};

function buildCheckpointRows(
  viewModel: CoworkPanelType["props"]["viewModel"],
  fallbackItems: CoworkPanelType["props"]["viewModel"]["timelineItems"]["items"],
): CoworkCheckpointRow[] {
  if (viewModel.raw.orchestrationCheckpoints.length > 0) {
    return [...viewModel.raw.orchestrationCheckpoints].reverse().map((checkpoint) => {
      const runMapCheckpoint = viewModel.runMap.checkpoints.find((item) => item.id === checkpoint.checkpointId);
      return {
        id: checkpoint.checkpointId,
        title: runMapCheckpoint?.title ?? humanizeCoworkLabel(checkpoint.checkpointKind) ?? "Checkpoint",
        timestamp: formatCoworkTimestamp(checkpoint.createdAt),
        meta: [humanizeCoworkLabel(checkpoint.phaseId), humanizeCoworkLabel(checkpoint.waveId, "Wave")]
          .filter((value): value is string => Boolean(value))
          .join(" · "),
        summary: describeCheckpointDetails(checkpoint.details),
      };
    });
  }

  const sourceItems = viewModel.runMap.checkpoints.length > 0 ? viewModel.runMap.checkpoints : fallbackItems;
  return sourceItems.map((item) => {
    const itemWithTimestamp = item as typeof item & { createdAt?: unknown };
    const maybeTimestamp =
      typeof item.meta === "string" && looksLikeTimestamp(item.meta)
        ? item.meta
        : typeof itemWithTimestamp.createdAt === "string"
          ? itemWithTimestamp.createdAt
          : undefined;
    return {
      id: item.id,
      title: item.title,
      timestamp: formatCoworkTimestamp(maybeTimestamp),
      meta: maybeTimestamp === item.meta ? undefined : item.meta,
      summary: item.note ?? "Checkpoint retained as durable run evidence.",
    };
  });
}

function describeCheckpointDetails(details: Record<string, unknown>): string {
  const continuationGate = details.continuationGate;
  if (continuationGate && typeof continuationGate === "object" && !Array.isArray(continuationGate)) {
    const gate = continuationGate as { summary?: unknown; recommendedAction?: unknown };
    return [gate.summary, gate.recommendedAction]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
  }
  if (typeof details.error === "string") {
    return details.error;
  }
  if (typeof details.lifecycleState === "string") {
    return `Execution ${humanizeCoworkLabel(details.lifecycleState)}.`;
  }
  if (typeof details.summary === "string") {
    return details.summary;
  }
  if (typeof details.status === "string") {
    return `Status ${humanizeCoworkLabel(details.status)}.`;
  }
  return "Checkpoint retained as durable run evidence.";
}

function humanizeCoworkLabel(value?: string | null, prefix?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replaceAll("_", " ");
  return prefix ? `${prefix} ${normalized}` : normalized;
}

function formatCoworkTimestamp(value?: string | null): string {
  if (!value) {
    return "Time not recorded";
  }
  return value.replace("T", " ").replace(".000Z", "Z");
}

function looksLikeTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) || /^\d{4}-\d{2}-\d{2}\s/.test(value);
}

function coworkStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (/complete|done|passed|ready|success/.test(normalized)) {
    return "is-complete";
  }
  if (/active|running|progress|executing/.test(normalized)) {
    return "is-active";
  }
  if (/failed|blocked|cancel|error|stop/.test(normalized)) {
    return "is-blocked";
  }
  return "is-pending";
}

function AgenticRuntimePanel({
  viewModel,
  onAgenticControl,
  agenticControlPending,
  agenticControlStatus,
}: {
  viewModel: CoworkPanelType["props"]["viewModel"];
  onAgenticControl?: CoworkPanelType["props"]["onAgenticControl"];
  agenticControlPending?: string | null;
  agenticControlStatus?: string | null;
}) {
  const runtime = viewModel.agenticRuntime;
  if (!runtime) {
    return null;
  }
  return (
    <section className="mc-next-cowork-run-map">
      <div className="mc-next-cowork-run-map-head">
        <div>
          <p className="mc-next-panel-kicker">Agentic runtime</p>
          <h5>{runtime.nodeCount} runtime nodes</h5>
          <p>
            Run {runtime.runId} · {runtime.edgeCount} links · generated {runtime.generatedAt}
          </p>
        </div>
      </div>
      <div className="mc-next-cowork-run-map-grid">
        <PanelList
          title="Run tree"
          items={runtime.treeNodes.map((node) => ({
            id: node.id,
            title: node.label,
            status: node.status,
            meta: node.meta,
          }))}
          emptyCopy="No runtime tree nodes are loaded."
        />
        <PanelList title="Diagnostics" items={runtime.diagnostics} emptyCopy="No diagnostics are active." />
        <AgenticRuntimeVisibilityPanel surface="cowork" className="mc-next-panel-list" deliveryLimit={8} />
        <section className="mc-next-panel-list">
          <p className="mc-next-panel-kicker">Controls</p>
          <p>
            State-only controls record durable operator intent. They do not live-pause or terminate an executor unless a
            running executor separately honors that recorded intent.
          </p>
          {agenticControlStatus ? <p>{agenticControlStatus}</p> : null}
          {runtime.controls.length > 0 ? (
            <ul>
              {runtime.controls.map((control) => {
                const controlCopy = describeAgenticControlCopy(control);
                return (
                  <li key={control.id}>
                    <div className="mc-next-panel-list-head">
                      <strong>{control.title}</strong>
                      {control.status ? <span>{control.status}</span> : null}
                    </div>
                    {control.meta ? <p>{control.meta}</p> : null}
                    {control.note ? <p>{control.note}</p> : null}
                    {controlCopy.intentNote ? <p>{controlCopy.intentNote}</p> : null}
                    {onAgenticControl ? (
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        disabled={!control.enabled || agenticControlPending === control.action}
                        onClick={() => onAgenticControl(control)}
                      >
                        {agenticControlPending === control.action ? "Recording..." : controlCopy.buttonLabel}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No runtime controls are available.</p>
          )}
        </section>
      </div>
    </section>
  );
}
