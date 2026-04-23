import { useMemo, useState } from "react";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import type { ChatMode } from "@goatcitadel/contracts";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";

type DrawerTab = "context" | "trace" | "assist" | "session";

function formatSelectionSource(value?: string | null): string {
  return value ? `Selection: ${value}` : "Selection pending";
}

function formatRouteSummary(props: MissionThreadedContextDockProps): string {
  const parts = [props.selectedProviderId, props.selectedModel].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "Route pending";
}

export function ThreadedContextDrawer({
  surface,
  props,
}: {
  surface: ChatMode;
  props: MissionThreadedContextDockProps;
}) {
  const [activeTab, setActiveTab] = useState<DrawerTab>("context");
  const projectOptions = useMemo(() => props.projectOptions ?? [], [props.projectOptions]);

  return (
    <div className="mc-next-context-drawer" data-mode={surface}>
      <div className="mc-next-panel-tab-row">
        {(["context", "trace", "assist", "session"] as DrawerTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`mc-next-panel-tab${activeTab === tab ? " active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "context" ? "Context" : tab === "trace" ? "Trace" : tab === "assist" ? "Assist" : "Session"}
          </button>
        ))}
      </div>

      {activeTab === "context" ? (
        <div className="mc-next-context-section-stack">
          <section className="mc-next-context-card">
            <p className="mc-next-panel-kicker">Route</p>
            <h4>{formatRouteSummary(props)}</h4>
            <div className="mc-next-context-chip-row">
              <StatusChip tone={props.streamEnabled ? "success" : "muted"}>
                {props.streamEnabled ? "Streaming on" : "Streaming off"}
              </StatusChip>
              <StatusChip tone="muted">{props.planningMode}</StatusChip>
              <StatusChip tone="muted">{formatSelectionSource(props.routePreflight?.selectionSource)}</StatusChip>
            </div>
            <div className="mc-next-context-actions">
              <button
                type="button"
                className="mc-next-panel-button"
                onClick={() => props.onStreamEnabledChange(!props.streamEnabled)}
              >
                {props.streamEnabled ? "Disable streaming" : "Enable streaming"}
              </button>
              {props.selectedProviderId ? (
                <button
                  type="button"
                  className="mc-next-panel-button"
                  onClick={() =>
                    void props.onPrefPatch({
                      providerId: props.selectedProviderId,
                      model: props.selectedModel,
                    })
                  }
                >
                  Reapply route
                </button>
              ) : null}
            </div>
            {props.routePreflight?.degradedReason ? <p>{props.routePreflight.degradedReason}</p> : null}
            {props.routePreflight?.blockedReason ? <p>{props.routePreflight.blockedReason}</p> : null}
          </section>

          {props.activeGeneratedArtifact ? (
            <section className="mc-next-context-card">
              <div className="mc-next-panel-list-head">
                <strong>{props.activeGeneratedArtifact.title}</strong>
                {props.onCloseGeneratedArtifact ? (
                  <button type="button" className="mc-next-panel-button" onClick={props.onCloseGeneratedArtifact}>
                    Close
                  </button>
                ) : null}
              </div>
              <GeneratedArtifactViewer artifact={props.activeGeneratedArtifact} compact />
            </section>
          ) : null}
        </div>
      ) : null}

      {activeTab === "trace" ? (
        <div className="mc-next-context-section-stack">
          {props.selectedTurn ? (
            <>
              <section className="mc-next-context-card">
                <p className="mc-next-panel-kicker">Turn trace</p>
                <h4>{props.selectedTurn.turnId}</h4>
                <div className="mc-next-context-chip-row">
                  <StatusChip
                    tone={
                      props.selectedTurn.trace.status === "failed"
                        ? "critical"
                        : props.selectedTurn.trace.status === "completed"
                          ? "success"
                          : "warning"
                    }
                  >
                    {props.selectedTurn.trace.status}
                  </StatusChip>
                  {props.selectedTurn.trace.routing.fallbackUsed ? (
                    <StatusChip tone="warning">Fallback used</StatusChip>
                  ) : null}
                </div>
                <p>{props.selectedTurn.trace.failure?.message ?? "No failure recorded for this turn."}</p>
                {props.onExportRunBundle ? (
                  <div className="mc-next-context-actions">
                    <button type="button" className="mc-next-panel-button" onClick={props.onExportRunBundle}>
                      Export run bundle
                    </button>
                  </div>
                ) : null}
              </section>
              <section className="mc-next-context-card">
                <p className="mc-next-panel-kicker">Routing</p>
                <p>
                  Primary:{" "}
                  {[props.selectedTurn.trace.routing.primaryProviderId, props.selectedTurn.trace.routing.primaryModel]
                    .filter(Boolean)
                    .join(" / ") || "n/a"}
                </p>
                <p>
                  Effective:{" "}
                  {[
                    props.selectedTurn.trace.routing.effectiveProviderId,
                    props.selectedTurn.trace.routing.effectiveModel,
                  ]
                    .filter(Boolean)
                    .join(" / ") || "n/a"}
                </p>
                <p>{props.selectedTurn.trace.routing.fallbackReason ?? "No fallback reason recorded."}</p>
              </section>
            </>
          ) : (
            <section className="mc-next-context-card">
              <p>No turn is selected yet. Select a turn in the timeline to inspect execution details.</p>
            </section>
          )}
        </div>
      ) : null}

      {activeTab === "assist" ? (
        <div className="mc-next-context-section-stack">
          <section className="mc-next-context-card">
            <p className="mc-next-panel-kicker">Assist posture</p>
            <div className="mc-next-context-chip-row">
              <StatusChip tone="muted">{props.capabilitySuggestions.length} capability suggestions</StatusChip>
              <StatusChip tone="muted">{props.specialistSuggestions.length} specialist suggestions</StatusChip>
              <StatusChip tone="muted">{props.learnedMemory.length} learned memory</StatusChip>
            </div>
          </section>

          {props.capabilitySuggestions.length > 0 ? (
            <section className="mc-next-context-card">
              <p className="mc-next-panel-kicker">Capability suggestions</p>
              <ul className="mc-next-context-list">
                {props.capabilitySuggestions.map((suggestion) => (
                  <li key={`${suggestion.kind}-${suggestion.title}`}>
                    <strong>{suggestion.title}</strong>
                    <p>{suggestion.summary}</p>
                    <button
                      type="button"
                      className="mc-next-panel-button"
                      onClick={() => props.onCapabilitySuggestionAction(suggestion)}
                    >
                      Review suggestion
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {props.specialistSuggestions.length > 0 ? (
            <section className="mc-next-context-card">
              <p className="mc-next-panel-kicker">Specialists</p>
              <ul className="mc-next-context-list">
                {props.specialistSuggestions.map((suggestion) => (
                  <li key={suggestion.candidateId}>
                    <strong>{suggestion.title}</strong>
                    <p>{suggestion.summary}</p>
                    <div className="mc-next-context-actions">
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        onClick={() => void props.onCreateSpecialistDraft(suggestion)}
                      >
                        Draft
                      </button>
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        onClick={() => void props.onActivateCatalogSpecialist(suggestion)}
                      >
                        Activate
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {props.learnedMemory.length > 0 ? (
            <section className="mc-next-context-card">
              <p className="mc-next-panel-kicker">Learned memory</p>
              <ul className="mc-next-context-list">
                {props.learnedMemory.slice(0, 8).map((item) => (
                  <li key={item.itemId}>
                    <strong>{item.content}</strong>
                    <p>{item.status}</p>
                    <div className="mc-next-context-actions">
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        onClick={() => void props.onUpdateMemoryStatus(item.itemId, "active")}
                      >
                        Keep active
                      </button>
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        onClick={() => void props.onUpdateMemoryStatus(item.itemId, "superseded")}
                      >
                        Mark stale
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mc-next-panel-button"
                onClick={() => void props.onRebuildLearnedMemory()}
              >
                Rebuild learned memory
              </button>
            </section>
          ) : null}
        </div>
      ) : null}

      {activeTab === "session" ? (
        <div className="mc-next-context-section-stack">
          <section className="mc-next-context-card">
            <p className="mc-next-panel-kicker">Session</p>
            <label className="mc-next-context-field">
              <span>Rename</span>
              <input
                value={props.renameTitle}
                onChange={(event) => props.onRenameTitleChange(event.target.value)}
                placeholder={props.selectedSession.title ?? "Session title"}
              />
            </label>
            <label className="mc-next-context-field">
              <span>Folder</span>
              <input
                value={props.folderName}
                onChange={(event) => props.onFolderNameChange(event.target.value)}
                placeholder="Folder"
              />
            </label>
            <label className="mc-next-context-field">
              <span>Tags</span>
              <input
                value={props.tagsValue}
                onChange={(event) => props.onTagsValueChange(event.target.value)}
                placeholder="tag-one, tag-two"
              />
            </label>
            <label className="mc-next-context-field">
              <span>Project</span>
              <select
                value={props.selectedSessionProjectValue}
                onChange={(event) => void props.onAssignProject(event.target.value)}
              >
                {projectOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="mc-next-context-actions">
              <button
                type="button"
                className="mc-next-panel-button primary"
                onClick={() => void props.onRenameSession()}
              >
                Save title
              </button>
              <button type="button" className="mc-next-panel-button" onClick={() => void props.onSaveOrganization()}>
                Save organization
              </button>
              <button type="button" className="mc-next-panel-button" onClick={() => void props.onTogglePinSession()}>
                {props.selectedSession.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                className="mc-next-panel-button"
                onClick={() => void props.onToggleArchiveSession()}
              >
                {props.selectedSession.lifecycleStatus === "archived" ? "Restore" : "Archive"}
              </button>
            </div>
            <div className="mc-next-context-actions">
              <button type="button" className="mc-next-panel-button" onClick={props.onExportSnapshot}>
                Export snapshot
              </button>
              <button type="button" className="mc-next-panel-button danger" onClick={props.onDeleteSession}>
                Delete session
              </button>
            </div>
          </section>

          <section className="mc-next-context-card">
            <p className="mc-next-panel-kicker">External binding</p>
            <label className="mc-next-context-field">
              <span>Connection</span>
              <input
                value={props.integrationConnectionId}
                onChange={(event) => props.onIntegrationConnectionIdChange(event.target.value)}
                placeholder="Connection id"
              />
            </label>
            <label className="mc-next-context-field">
              <span>Target</span>
              <input
                value={props.integrationTarget}
                onChange={(event) => props.onIntegrationTargetChange(event.target.value)}
                placeholder="Target thread / channel"
              />
            </label>
            <button type="button" className="mc-next-panel-button" onClick={() => void props.onSaveExternalBinding()}>
              Save binding
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
