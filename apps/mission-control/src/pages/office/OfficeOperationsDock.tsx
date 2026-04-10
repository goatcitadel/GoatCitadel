import type { ReactNode } from "react";
import type { ApprovalsResponse, OperatorsResponse, RealtimeEvent } from "../../api/client";
import { FieldHelp } from "../../components/FieldHelp";
import { Panel } from "../../components/Panel";

export type OfficeDockTab = "inspector" | "operators" | "approvals" | "rail";

export interface OfficeOperationsDockProps {
  showInspectorDock: boolean;
  showRailDock: boolean;
  dockTab: OfficeDockTab;
  onDockTabChange: (tab: OfficeDockTab) => void;
  availableDockTabs: OfficeDockTab[];
  renderInspector: () => ReactNode;
  operators: OperatorsResponse["items"];
  pendingApprovals: ApprovalsResponse["items"];
  sceneEvents: RealtimeEvent[];
  formatRelative: (value?: string) => string;
  formatClock: (value?: string) => string;
  summarizeEvent: (event: RealtimeEvent) => string;
}

export function OfficeOperationsDock(props: OfficeOperationsDockProps) {
  const {
    showInspectorDock,
    showRailDock,
    dockTab,
    onDockTabChange,
    availableDockTabs,
    renderInspector,
    operators,
    pendingApprovals,
    sceneEvents,
    formatRelative,
    formatClock,
    summarizeEvent,
  } = props;

  if (!showInspectorDock && !showRailDock) {
    return (
      <Panel
        className="office-dock-panel"
        tone="soft"
        title="Operations Dock Hidden"
        subtitle="The scene is still live, but the side dock is disabled right now."
      >
        <FieldHelp>
          Enable either Inspector or Rail above to restore the side dock and keep entity detail beside the scene.
        </FieldHelp>
      </Panel>
    );
  }

  return (
    <Panel
      className="office-dock-panel"
      padding="default"
      title="Operations Dock"
      subtitle="Keep inspection, approvals, operators, and live signals beside the command stage."
      actions={
        <div className="office-dock-tabs">
          {availableDockTabs.map((tab) => (
            <button
              type="button"
              key={tab}
              className={["gc-button", (dockTab === tab ? "active" : "")].filter(Boolean).join(" ")}
              onClick={() => onDockTabChange(tab)}
            >
              {tab === "inspector" && "Inspector"}
              {tab === "operators" && "Operators"}
              {tab === "approvals" && "Approvals"}
              {tab === "rail" && "Live Rail"}
            </button>
          ))}
        </div>
      }
    >
      <div className="office-dock-body">
        {dockTab === "inspector" ? renderInspector() : null}

        {dockTab === "operators" ? (
          <>
            <FieldHelp>Operator view summarizes session pressure and who has been active most recently.</FieldHelp>
            <ul className="compact-list">
              {operators.map((operator) => (
                <li key={operator.operatorId}>
                  <strong>{operator.operatorId}</strong>
                  <p>
                    {operator.activeSessions} active / {operator.sessionCount} total sessions
                  </p>
                  <small>Last activity {formatRelative(operator.lastActivityAt)}</small>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {dockTab === "approvals" ? (
          <>
            <FieldHelp>Pending approvals surface the highest-friction work still waiting on human review.</FieldHelp>
            <ul className="compact-list">
              {pendingApprovals.length === 0 ? (
                <li>No pending approvals.</li>
              ) : (
                pendingApprovals.slice(0, 10).map((approval) => (
                  <li key={approval.approvalId}>
                    <strong>{approval.kind}</strong>
                    <p>
                      {approval.riskLevel} - {approval.status}
                    </p>
                    <small>{formatRelative(approval.createdAt)}</small>
                  </li>
                ))
              )}
            </ul>
          </>
        ) : null}

        {dockTab === "rail" ? (
          <>
            <FieldHelp>
              Live rail is the real-time signal feed. Use it to correlate motion in the scene with gateway and tool
              activity.
            </FieldHelp>
            <ul className="compact-list">
              {sceneEvents.length === 0 ? (
                <li>No live events yet.</li>
              ) : (
                sceneEvents.slice(0, 12).map((event) => (
                  <li key={event.eventId}>
                    <strong>{event.eventType}</strong>
                    <p>{summarizeEvent(event)}</p>
                    <small>
                      {formatClock(event.timestamp)} - {event.source}
                    </small>
                  </li>
                ))
              )}
            </ul>
          </>
        ) : null}
      </div>

      <footer className="office-collab-legend">
        <span>
          <b>Beam</b> active collaboration
        </span>
        <span>
          <b>Pulse</b> handoff in progress
        </span>
        <span>
          <b>Red hold</b> blocked or approval risk
        </span>
        <span>
          <b>Zone deck</b> command, build, research, security, or ops lane
        </span>
      </footer>
    </Panel>
  );
}
