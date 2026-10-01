import { Suspense, useEffect, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import type { ChangePlanRecord, ChatMode } from "@goatcitadel/contracts";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { ChatSessionStatusPanel } from "./ChatSessionStatusPanel";
import { ThreadedContextDrawer } from "./ThreadedContextDrawer";
import { LazyThreadedWorkflowPanel } from "./ThreadedWorkflowPanelLoader";
import { UtilityPreviewPanel } from "./ThreadedActivityPreview";
import { UtilityApprovalState, UtilityPlanPanel, UtilityBackgroundTasksPanel } from "./ThreadedWorkActivity";
import { UtilityDiffPanel, UtilityFilesPanel, UtilityTerminalPanel } from "./ThreadedWorkbenchEvidence";
import { getUtilityTab, UTILITY_TAB_ITEMS, type ThreadedUtilityPanelId } from "./threaded-utility-navigation";

export function ThreadedUtilityPanel({
  pinned,
  onTogglePinned,
  activePanel,
  activeProps,
  changePlans,
  contextDockProps,
  onClose,
  onOpenBuildEditor,
  onOpenUniversalRunDetail,
  onOpenTasks,
  onSelectPanel,
  onSelectSession,
  surface,
  workflowPanel,
}: {
  pinned: boolean;
  onTogglePinned: () => void;
  activePanel: ThreadedUtilityPanelId;
  activeProps: MissionThreadedActiveSessionSurfaceProps;
  changePlans?: readonly ChangePlanRecord[];
  contextDockProps: MissionThreadedRenderSurfaceInput["contextDockProps"];
  onClose: () => void;
  onOpenBuildEditor?: () => void;
  onOpenUniversalRunDetail?: (runId: string) => void;
  onOpenTasks?: () => void;
  onSelectPanel: (panel: ThreadedUtilityPanelId) => void;
  onSelectSession: (sessionId: string, options?: { turnId?: string | null }) => void;
  surface: ChatMode;
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"];
}) {
  const activeTab = getUtilityTab(activePanel);
  const meta = UTILITY_TAB_ITEMS.find((item) => item.id === activeTab)!;
  const [executionDetailsOpen, setExecutionDetailsOpen] = useState(
    activePanel === "trace" || activePanel === "terminal",
  );
  useEffect(() => {
    if (activePanel === "trace" || activePanel === "terminal") setExecutionDetailsOpen(true);
    else setExecutionDetailsOpen(false);
  }, [activePanel]);

  return (
    <div className="mc-next-utility-panel" data-mode={surface} data-panel={activePanel}>
      <div className="mc-next-utility-panel-head">
        <div>
          <h3>{meta.label}</h3>
        </div>
        <button
          type="button"
          className="mc-next-panel-button"
          onClick={onTogglePinned}
          aria-label={pinned ? "Unpin Chat details" : "Pin Chat details"}
          aria-pressed={pinned}
        >
          {pinned ? <PinOff size={16} /> : <Pin size={16} />}
        </button>
        <button type="button" className="mc-next-panel-button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="mc-next-utility-panel-tabs" role="group" aria-label="Chat details tabs">
        {UTILITY_TAB_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={activeTab === item.id}
              className={`mc-next-utility-panel-tab${activeTab === item.id ? " active" : ""}`}
              onClick={() => onSelectPanel(item.panel)}
            >
              <Icon size={14} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      {activeTab === "activity" ? (
        <div className="mc-next-utility-panel-content" aria-label="Chat activity">
          <UtilityPreviewPanel
            activeProps={activeProps}
            changePlans={changePlans}
            onOpenBuildEditor={onOpenBuildEditor}
            onSelectPanel={(panel) => {
              if (panel === "trace") setExecutionDetailsOpen(true);
              onSelectPanel(panel);
            }}
          />
          <UtilityApprovalState activeProps={activeProps} />
          {activeProps.sessionStatusPanel ? (
            <details className="mc-next-chat-evidence mc-next-utility-session-status">
              <summary>Gateway session status</summary>
              <ChatSessionStatusPanel panel={{ ...activeProps.sessionStatusPanel, open: true }} showClose={false} />
            </details>
          ) : (
            <section className="mc-next-utility-card">
              <h4>Session status</h4>
              <p>Canonical session status is unavailable in this runtime.</p>
            </section>
          )}
          {workflowPanel?.kind === "cowork" ? (
            <Suspense fallback={<p>Loading planning controls…</p>}>
              <LazyThreadedWorkflowPanel panel={workflowPanel} />
            </Suspense>
          ) : (
            <UtilityPlanPanel activeProps={activeProps} contextDockProps={contextDockProps} />
          )}
          <UtilityBackgroundTasksPanel
            activeProps={activeProps}
            onOpenUniversalRunDetail={onOpenUniversalRunDetail}
            onOpenTasks={onOpenTasks}
            onSelectSession={onSelectSession}
          />
          <details
            className="mc-next-chat-evidence mc-next-utility-execution-details"
            open={executionDetailsOpen}
            onToggle={(event) => setExecutionDetailsOpen(event.currentTarget.open)}
          >
            <summary>Execution details</summary>
            {contextDockProps ? (
              <ThreadedContextDrawer
                key={`${activeProps.selectedSessionId}:trace`}
                surface={surface}
                props={contextDockProps}
                focusedTab="trace"
              />
            ) : (
              <p>Trace details are unavailable.</p>
            )}
            <UtilityTerminalPanel workflowPanel={workflowPanel} />
          </details>
        </div>
      ) : activeTab === "context" ? (
        contextDockProps ? (
          <ThreadedContextDrawer
            key={`${activeProps.selectedSessionId}:context`}
            surface={surface}
            props={contextDockProps}
            focusedTab="context"
          />
        ) : (
          <p>Context evidence is unavailable.</p>
        )
      ) : activeTab === "outputs" ? (
        <div className="mc-next-utility-panel-content" aria-label="Chat outputs">
          {activeProps.activeGeneratedArtifact ? (
            <section className="mc-next-utility-card">
              <h4>{activeProps.activeGeneratedArtifact.title}</h4>
              <GeneratedArtifactViewer artifact={activeProps.activeGeneratedArtifact} />
              {activeProps.onCloseGeneratedArtifact ? (
                <button type="button" className="mc-next-panel-button" onClick={activeProps.onCloseGeneratedArtifact}>
                  Close artifact preview
                </button>
              ) : null}
            </section>
          ) : null}
          {contextDockProps ? (
            <ThreadedContextDrawer
              key={`${activeProps.selectedSessionId}:documents`}
              surface={surface}
              props={contextDockProps}
              focusedTab="documents"
            />
          ) : (
            <p>Documents and artifacts are unavailable.</p>
          )}
          <UtilityDiffPanel workflowPanel={workflowPanel} />
          <UtilityFilesPanel workflowPanel={workflowPanel} />
        </div>
      ) : (
        <div className="mc-next-utility-panel-content" aria-label="Chat settings">
          {contextDockProps ? (
            <>
              <section>
                <h4>Session settings</h4>
                <ThreadedContextDrawer
                  key={`${activeProps.selectedSessionId}:session`}
                  surface={surface}
                  props={contextDockProps}
                  focusedTab="session"
                />
              </section>
              <section>
                <h4>Assist settings</h4>
                <ThreadedContextDrawer
                  key={`${activeProps.selectedSessionId}:assist`}
                  surface={surface}
                  props={contextDockProps}
                  focusedTab="assist"
                />
              </section>
            </>
          ) : (
            <p>Chat settings are unavailable.</p>
          )}
        </div>
      )}
    </div>
  );
}
