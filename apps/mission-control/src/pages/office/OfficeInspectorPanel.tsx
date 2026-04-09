import type { OfficeOperatorModel } from "../../components/OfficeCanvas";
import { FieldHelp } from "../../components/FieldHelp";
import { SelectOrCustom } from "../../components/SelectOrCustom";
import { GCSelect } from "../../components/ui";
import {
  OPERATOR_NAME_OPTIONS,
  PRESET_DETAILS,
  PRESET_OPTIONS,
  type OperatorPreferences,
} from "./office-page-constants";
import type { AgentHandoff, OfficeAgentModel, OfficeZoneTelemetry } from "./office-agent-model";
import {
  attentionLabel,
  attentionPillClass,
  classifyAgentHeat,
  formatClock,
  formatRelative,
  initials,
  summarizeEvent,
} from "./office-page-helpers";

export function OfficeInspectorPanel(props: {
  selectedEntityId: "operator" | string;
  operatorPrefs: OperatorPreferences;
  setOperatorPrefs: React.Dispatch<React.SetStateAction<OperatorPreferences>>;
  operatorModel: OfficeOperatorModel;
  activeAgents: number;
  pendingApprovalsCount: number;
  blockedAgents: number;
  eventFlow: number;
  zoneTelemetry: OfficeZoneTelemetry[];
  selectedAgent: OfficeAgentModel | undefined;
  selectedAgentHandoffs: AgentHandoff[];
  officeAgentNamesByRole: Map<string, string>;
}) {
  const {
    selectedEntityId,
    operatorPrefs,
    setOperatorPrefs,
    operatorModel,
    activeAgents,
    pendingApprovalsCount,
    blockedAgents,
    eventFlow,
    zoneTelemetry,
    selectedAgent,
    selectedAgentHandoffs,
    officeAgentNamesByRole,
  } = props;

  if (selectedEntityId === "operator") {
    const presetDetail = PRESET_DETAILS[operatorPrefs.preset];
    return (
      <>
        <header className="office-agent-header">
          <div className="office-avatar office-avatar-hot">GH</div>
          <div>
            <h3>{operatorPrefs.name}</h3>
            <p className="office-agent-id">GoatHerder - Central Herd Operator - Command Hub</p>
          </div>
          <span className="office-pill office-pill-active">{operatorModel.activityState.replace("_", " ")}</span>
        </header>

        <p>Coordinates specialist goats, approvals, and live mission flow from the center desk.</p>
        <p>
          <strong>Thinking:</strong> {operatorModel.currentThought}
        </p>

        <dl className="office-meta-grid">
          <div>
            <dt>Active goats</dt>
            <dd>{activeAgents}</dd>
          </div>
          <div>
            <dt>Pending approvals</dt>
            <dd>{pendingApprovalsCount}</dd>
          </div>
          <div>
            <dt>Risked goats</dt>
            <dd>{blockedAgents}</dd>
          </div>
          <div>
            <dt>Event pace</dt>
            <dd>{eventFlow.toFixed(1)}/min</dd>
          </div>
          <div>
            <dt>Primary zone</dt>
            <dd>Command Hub</dd>
          </div>
        </dl>

        <h4>Zone Pressure</h4>
        <div className="office-zone-grid office-zone-grid-compact">
          {zoneTelemetry.map((zone) => (
            <article key={zone.zoneId} className={`office-zone-card office-zone-card-${zone.attentionLevel}`}>
              <div className="office-zone-card-head">
                <p className="office-zone-card-label">{zone.label}</p>
                <span className={`office-pill ${attentionPillClass(zone.attentionLevel)}`}>
                  {attentionLabel(zone.attentionLevel)}
                </span>
              </div>
              <p className="office-zone-card-metrics">
                {zone.activeAgents} active · {zone.linkedAgents} linked · {zone.alertAgents} alerts
              </p>
              <p className="office-zone-card-focus">{zone.focus}</p>
            </article>
          ))}
        </div>

        <h4>Goatherder Preset</h4>
        <div className="office-preset-active">
          <span className={`office-preset-swatch ${presetDetail.swatchClass}`} aria-hidden="true" />
          <div>
            <p className="office-preset-title">{presetDetail.title}</p>
            <p className="office-preset-copy">{presetDetail.description}</p>
            <p className="office-preset-bestfor">{presetDetail.bestFor}</p>
          </div>
        </div>

        <h4>Operator Customization</h4>
        <div className="controls-row">
          <label htmlFor="goatHerderName">Operator name</label>
          <SelectOrCustom
            id="goatHerderName"
            value={operatorPrefs.name}
            onChange={(name) => setOperatorPrefs((prev) => ({ ...prev, name: name || "GoatHerder" }))}
            options={OPERATOR_NAME_OPTIONS}
            customPlaceholder="Custom operator name"
            customLabel="Operator name"
          />
        </div>
        <FieldHelp>
          Use a preset name or switch to custom if you want the Goatherder identity to match the current mission theme.
        </FieldHelp>
        <div className="controls-row">
          <label htmlFor="goatHerderPreset">Style preset</label>
          <GCSelect
            id="goatHerderPreset"
            value={operatorPrefs.preset}
            onChange={(value) =>
              setOperatorPrefs((prev) => ({
                ...prev,
                preset: value as OperatorPreferences["preset"],
              }))
            }
            options={PRESET_OPTIONS}
          />
        </div>
        <FieldHelp>
          Presets adjust the Goatherder palette and scene mood without changing the underlying operator data.
        </FieldHelp>
        <div className="office-preset-grid">
          {(
            Object.entries(PRESET_DETAILS) as Array<
              [OperatorPreferences["preset"], (typeof PRESET_DETAILS)[keyof typeof PRESET_DETAILS]]
            >
          ).map(([key, detail]) => (
            <article key={key} className={`office-preset-card ${operatorPrefs.preset === key ? "active" : ""}`}>
              <header>
                <span className={`office-preset-swatch ${detail.swatchClass}`} aria-hidden="true" />
                <strong>{detail.title}</strong>
              </header>
              <p>{detail.description}</p>
              <small>{detail.bestFor}</small>
            </article>
          ))}
        </div>
      </>
    );
  }

  if (!selectedAgent) {
    return <p>No goat selected.</p>;
  }

  return (
    <>
      <header className="office-agent-header">
        <div className={`office-avatar office-avatar-${classifyAgentHeat(selectedAgent.lastSeenAt)}`}>
          {initials(selectedAgent.name)}
        </div>
        <div>
          <h3>{selectedAgent.name}</h3>
          <p className="office-agent-id">
            {selectedAgent.title} - {selectedAgent.zoneLabel}
          </p>
        </div>
        <div className="office-agent-pills">
          <span
            className={`office-pill office-pill-${selectedAgent.status === "ready" ? "idle" : selectedAgent.status}`}
          >
            {selectedAgent.status}
          </span>
          <span className={`office-pill ${attentionPillClass(selectedAgent.attentionLevel)}`}>
            {attentionLabel(selectedAgent.attentionLevel)}
          </span>
        </div>
      </header>

      <div className="office-dossier-strip">
        <article className={`office-dossier-card office-dossier-card-${selectedAgent.attentionLevel}`}>
          <p className="office-dossier-label">Current task</p>
          <p className="office-dossier-value">{selectedAgent.currentTaskLabel}</p>
          <p className="office-dossier-note">{selectedAgent.currentAction}</p>
        </article>
        <article
          className={`office-dossier-card office-dossier-card-${selectedAgent.risk === "none" ? "stable" : selectedAgent.risk}`}
        >
          <p className="office-dossier-label">Risk state</p>
          <p className="office-dossier-value">{selectedAgent.risk}</p>
          <p className="office-dossier-note">{selectedAgent.currentThought}</p>
        </article>
        <article className="office-dossier-card office-dossier-card-stable">
          <p className="office-dossier-label">Recent handoffs</p>
          <p className="office-dossier-value">{selectedAgentHandoffs.length}</p>
          <p className="office-dossier-note">{selectedAgentHandoffs[0]?.detail ?? "No handoffs recorded yet."}</p>
        </article>
      </div>

      <div className={`office-behavior-banner office-behavior-banner-${selectedAgent.attentionLevel}`}>
        <p className="office-behavior-label">Behavior directive</p>
        <p>{selectedAgent.behaviorDirective}</p>
      </div>

      <dl className="office-meta-grid">
        <div>
          <dt>Risk</dt>
          <dd>{selectedAgent.risk}</dd>
        </div>
        <div>
          <dt>Task</dt>
          <dd>{selectedAgent.taskId ?? "-"}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{selectedAgent.sessionId ?? selectedAgent.runtimeAgentId ?? "-"}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{selectedAgent.activityState.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Attention</dt>
          <dd>{attentionLabel(selectedAgent.attentionLevel)}</dd>
        </div>
        <div>
          <dt>Zone</dt>
          <dd>{selectedAgent.zoneLabel}</dd>
        </div>
        <div>
          <dt>Collaborators</dt>
          <dd>
            {selectedAgent.collabPeers.length > 0
              ? selectedAgent.collabPeers.map((roleId) => officeAgentNamesByRole.get(roleId) ?? roleId).join(", ")
              : "-"}
          </dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{formatRelative(selectedAgent.lastSeenAt)}</dd>
        </div>
        <div>
          <dt>Signal heat</dt>
          <dd>{classifyAgentHeat(selectedAgent.lastSeenAt)}</dd>
        </div>
      </dl>

      <h4>Specialties</h4>
      <div className="token-row">
        {selectedAgent.specialties.map((specialty) => (
          <span key={specialty} className="token-chip">
            {specialty}
          </span>
        ))}
      </div>

      <h4>Recent handoffs</h4>
      <ul className="compact-list">
        {selectedAgentHandoffs.length === 0 ? (
          <li>No handoffs recorded.</li>
        ) : (
          selectedAgentHandoffs.map((handoff, index) => (
            <li key={`${handoff.label}-${index}`}>
              <strong>{handoff.label}</strong>
              <p>{handoff.detail}</p>
              <small>{handoff.timestamp ? formatClock(handoff.timestamp) : "current window"}</small>
            </li>
          ))
        )}
      </ul>

      <h4>Recent Signals</h4>
      <ul className="compact-list">
        {selectedAgent.eventTrail.length === 0 ? (
          <li>No events yet.</li>
        ) : (
          selectedAgent.eventTrail.slice(0, 8).map((event) => (
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
  );
}
