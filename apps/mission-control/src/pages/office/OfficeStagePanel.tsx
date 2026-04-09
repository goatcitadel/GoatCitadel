import type { ComponentProps, ReactNode } from "react";
import { FieldHelp } from "../../components/FieldHelp";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";
import type { OfficeZoneId } from "../../data/office-zones";
import { attentionLabel, attentionPillClass } from "./office-page-helpers";
import type { OfficeAgentModel, OfficeZoneActivityLane, OfficeZoneTelemetry } from "./office-agent-model";
import {
  OfficeStageControlBar,
  type OfficeOperatorPrefsLike,
  type OfficeStageControlBarProps,
} from "./OfficeStageControlBar";

interface FocusSummary {
  title: string;
  summary: string;
  detail: string;
}

interface GoatAssetStatus {
  tone: ComponentProps<typeof StatusChip>["tone"];
  chipLabel: string;
  helpLabel: string;
  helpCopy: string;
}

interface OfficeStagePanelProps<P extends OfficeOperatorPrefsLike> {
  sceneReady: boolean;
  blockedAgents: number;
  priorityAgents: number;
  watchAgents: number;
  playbackMode: "live" | "replay";
  goatAssetStatus: GoatAssetStatus;
  focusSummary: FocusSummary | null;
  stageControlProps: OfficeStageControlBarProps<P>;
  zoneActivityLanes: OfficeZoneActivityLane[];
  stageZoneTelemetry: OfficeZoneTelemetry[];
  selectedEntityId: string;
  selectedAgentZoneId: OfficeZoneId | null;
  officeAgents: OfficeAgentModel[];
  operatorName: string;
  onSelectEntity: (entityId: string) => void;
  renderScene: () => ReactNode;
}

export function OfficeStagePanel<P extends OfficeOperatorPrefsLike>({
  sceneReady,
  blockedAgents,
  priorityAgents,
  watchAgents,
  playbackMode,
  goatAssetStatus,
  focusSummary,
  stageControlProps,
  zoneActivityLanes,
  stageZoneTelemetry,
  selectedEntityId,
  selectedAgentZoneId,
  officeAgents,
  operatorName,
  onSelectEntity,
  renderScene,
}: OfficeStagePanelProps<P>) {
  const { focusMode, showCollabOverlay } = stageControlProps.operatorPrefs;
  return (
    <Panel
      className={`office-stage-panel${focusMode ? " office-stage-panel-focus" : ""}`}
      padding="spacious"
      title="Immersive Command Stage"
      subtitle="Drag to orbit, click the Goatherder or any desk, and watch live collaboration flow."
      actions={
        <div className="office-stage-statuses">
          <StatusChip tone={sceneReady ? "success" : "muted"}>
            {sceneReady ? "Scene ready" : "Scene warming up"}
          </StatusChip>
          <StatusChip tone={showCollabOverlay ? "live" : "muted"}>
            {showCollabOverlay ? "Flow visible" : "Flow hidden"}
          </StatusChip>
          <StatusChip tone={blockedAgents > 0 ? "critical" : "success"}>{blockedAgents} alerts</StatusChip>
          <StatusChip tone={priorityAgents > 0 ? "critical" : watchAgents > 0 ? "warning" : "muted"}>
            {priorityAgents > 0
              ? "Priority desks active"
              : watchAgents > 0
                ? "Watch desks active"
                : "Desk pressure stable"}
          </StatusChip>
          <StatusChip tone={playbackMode === "replay" ? "warning" : "muted"}>
            {playbackMode === "replay" ? "Replay window" : "Live window"}
          </StatusChip>
          <StatusChip tone={goatAssetStatus.tone}>{goatAssetStatus.chipLabel}</StatusChip>
        </div>
      }
    >
      {focusSummary ? (
        <div className="office-focus-banner">
          <p className="office-focus-label">Focus mode</p>
          <p className="office-focus-title">{focusSummary.title}</p>
          <p className="office-focus-summary">{focusSummary.summary}</p>
          <p className="office-focus-detail">{focusSummary.detail}</p>
          <p className="office-focus-hotkeys">Hotkeys: 1-5 jump zones, [ and ] cycle decks.</p>
        </div>
      ) : null}

      <OfficeStageControlBar {...stageControlProps} />

      <div className="office-lane-grid">
        {zoneActivityLanes.length === 0 ? (
          <article className="office-lane-card office-lane-card-empty">
            <p className="office-lane-label">Activity lanes</p>
            <p className="office-lane-copy">No cross-zone traffic has surfaced yet in the current window.</p>
          </article>
        ) : (
          zoneActivityLanes.map((lane) => (
            <article
              key={`${lane.fromZoneId}-${lane.toZoneId}`}
              className={`office-lane-card${lane.risk ? " office-lane-card-risk" : ""}`}
            >
              <p className="office-lane-label">{`${lane.fromLabel} -> ${lane.toLabel}`}</p>
              <p className="office-lane-value">{lane.count} linked handoffs</p>
              <p className="office-lane-copy">{lane.label}</p>
            </article>
          ))
        )}
      </div>

      <div className={`office-zone-grid${focusMode ? " office-zone-grid-focus" : ""}`}>
        {stageZoneTelemetry.map((zone) => {
          const isSelectedZone =
            selectedEntityId === "operator" ? zone.zoneId === "command" : selectedAgentZoneId === zone.zoneId;
          return (
            <article
              key={zone.zoneId}
              className={`office-zone-card office-zone-card-${zone.attentionLevel} office-zone-card-theme-${zone.zoneId}${isSelectedZone ? " active" : ""}`}
            >
              <div className="office-zone-card-head">
                <p className="office-zone-card-label">{zone.label}</p>
                <span className={`office-pill ${attentionPillClass(zone.attentionLevel)}`}>
                  {attentionLabel(zone.attentionLevel)}
                </span>
              </div>
              <p className="office-zone-card-metrics">
                {zone.totalAgents} goats · {zone.activeAgents} active · {zone.linkedAgents} linked · load{" "}
                {Math.round(zone.workloadScore * 100)}%
              </p>
              <p className="office-zone-card-focus">{zone.focus}</p>
              <p className="office-zone-card-architecture">
                {zone.landmark} · {zone.architectureNote}
              </p>
            </article>
          );
        })}
      </div>

      {renderScene()}
      <FieldHelp className="office-stage-help">
        Click the Goatherder or any desk to inspect the operator, desk zone, recent signals, collaboration edges, and
        alert state without leaving the scene.
      </FieldHelp>
      <FieldHelp className="office-stage-help">
        Goat asset pipeline: {goatAssetStatus.helpLabel}.{goatAssetStatus.helpCopy}
      </FieldHelp>
      {officeAgents.length === 0 ? (
        <div className="gc-empty-state office-empty-state">
          <p className="gc-empty-title">No agent roles are available yet.</p>
          <p className="gc-empty-subtitle">
            The Goatherder and office shell stay visible so you can inspect the room even before the herd is configured.
          </p>
        </div>
      ) : null}
      <div className="office-desk-list">
        <button
          type="button"
          className={selectedEntityId === "operator" ? "active" : ""}
          onClick={() => onSelectEntity("operator")}
        >
          {operatorName}
        </button>
        {officeAgents.map((agent) => (
          <button
            type="button"
            key={agent.roleId}
            className={selectedEntityId === agent.roleId ? "active" : ""}
            onClick={() => onSelectEntity(agent.roleId)}
          >
            {agent.name}
          </button>
        ))}
      </div>
    </Panel>
  );
}
