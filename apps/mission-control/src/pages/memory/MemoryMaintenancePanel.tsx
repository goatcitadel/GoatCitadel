import {
  fetchDurableRun,
  fetchDurableRunTimeline,
  fetchMemoryMaintenanceRecommendations,
  fetchMemoryMaintenanceRunProvenance,
  fetchMemoryMaintenanceRuns,
  fetchMemoryMaintenanceStatus,
} from "../../api/client";
import { ActionButton } from "../../components/ActionButton";
import { FieldHelp } from "../../components/FieldHelp";
import { Panel } from "../../components/Panel";
import { SelectOrCustom } from "../../components/SelectOrCustom";
import { GCSelect } from "../../components/ui";
import {
  clampNumber,
  describeMaintenanceProviderLocality,
  describeMaintenanceUnavailablePolicy,
  formatJson,
  formatMaybeDateTime,
  formatShortDateTime,
  shortId,
  type MemoryMaintenancePolicyDraft,
} from "../memory/memory-page-helpers";
import { describeDurableTimelineEvent } from "../../lib/durable-timeline";

type MemoryMaintenanceStatusState = Awaited<ReturnType<typeof fetchMemoryMaintenanceStatus>>;
type MemoryMaintenanceRunState = Awaited<ReturnType<typeof fetchMemoryMaintenanceRuns>>["items"][number];
type MemoryMaintenanceRecommendationState = Awaited<
  ReturnType<typeof fetchMemoryMaintenanceRecommendations>
>["items"][number];
type MemoryMaintenanceProvenanceState = Awaited<ReturnType<typeof fetchMemoryMaintenanceRunProvenance>>;
type DurableRunState = Awaited<ReturnType<typeof fetchDurableRun>>;
type DurableTimelineEventState = Awaited<ReturnType<typeof fetchDurableRunTimeline>>["items"][number];

interface MemoryMaintenancePanelProps {
  memoryMaintenanceDurableReady: boolean;
  memoryMaintenanceStatus: MemoryMaintenanceStatusState | null;
  memoryMaintenanceError: string | null;
  memoryMaintenanceDraft: MemoryMaintenancePolicyDraft | null;
  memoryMaintenanceDraftDirty: boolean;
  memoryMaintenanceBusy: string | null;
  selectedMaintenanceProvider?: { providerId: string; baseUrl: string } | null;
  memoryMaintenanceProviderOptions: Array<{ value: string; label: string }>;
  memoryMaintenanceModelOptions: Array<{ value: string; label: string }>;
  memoryMaintenanceModelsRefreshing: boolean;
  memoryMaintenanceEffectiveProviderId: string;
  updateMemoryMaintenanceDraft: (patch: Partial<MemoryMaintenancePolicyDraft>) => void;
  updateMemoryMaintenanceProviderDraft: (providerId: string) => void;
  applyMemoryMaintenanceLocalOvernightPreset: () => void;
  refreshMemoryMaintenanceModels: () => Promise<void>;
  saveMemoryMaintenancePolicy: () => Promise<void>;
  resetMemoryMaintenancePolicyDraft: () => void;
  runMemoryMaintenance: () => Promise<void>;
  workspaceId: string;
  memoryMaintenanceRuns: MemoryMaintenanceRunState[];
  selectedMaintenanceRunId: string | null;
  setSelectedMaintenanceRunId: (runId: string) => void;
  memoryMaintenanceRecommendations: MemoryMaintenanceRecommendationState[];
  acceptMaintenanceRecommendation: (recommendationId: string) => Promise<void>;
  rejectMaintenanceRecommendation: (recommendationId: string) => Promise<void>;
  selectedMaintenanceRun: MemoryMaintenanceRunState | null;
  selectedMaintenanceProvenance: MemoryMaintenanceProvenanceState | null;
  selectedMaintenanceDurableRun: DurableRunState | null;
  selectedMaintenanceTimeline: DurableTimelineEventState[];
  cancelSelectedMaintenanceRun: () => Promise<void>;
  retrySelectedMaintenanceRun: () => Promise<void>;
}

export function MemoryMaintenancePanel(props: MemoryMaintenancePanelProps) {
  const {
    memoryMaintenanceDurableReady,
    memoryMaintenanceStatus,
    memoryMaintenanceError,
    memoryMaintenanceDraft,
    memoryMaintenanceDraftDirty,
    memoryMaintenanceBusy,
    selectedMaintenanceProvider,
    memoryMaintenanceProviderOptions,
    memoryMaintenanceModelOptions,
    memoryMaintenanceModelsRefreshing,
    memoryMaintenanceEffectiveProviderId,
    updateMemoryMaintenanceDraft,
    updateMemoryMaintenanceProviderDraft,
    applyMemoryMaintenanceLocalOvernightPreset,
    refreshMemoryMaintenanceModels,
    saveMemoryMaintenancePolicy,
    resetMemoryMaintenancePolicyDraft,
    runMemoryMaintenance,
    workspaceId,
    memoryMaintenanceRuns,
    selectedMaintenanceRunId,
    setSelectedMaintenanceRunId,
    memoryMaintenanceRecommendations,
    acceptMaintenanceRecommendation,
    rejectMaintenanceRecommendation,
    selectedMaintenanceRun,
    selectedMaintenanceProvenance,
    selectedMaintenanceDurableRun,
    selectedMaintenanceTimeline,
    cancelSelectedMaintenanceRun,
    retrySelectedMaintenanceRun,
  } = props;

  return (
    <Panel
      title="Memory Maintenance"
      subtitle="Policy, recommendations, and durable execution state for workspace memory maintenance."
      actions={
        <div className="workflow-summary-strip">
          <span className="token-chip">{memoryMaintenanceStatus?.state.activeRunId ? "active run" : "idle"}</span>
          {memoryMaintenanceStatus?.nextDueAt ? (
            <span className="token-chip">next {new Date(memoryMaintenanceStatus.nextDueAt).toLocaleString()}</span>
          ) : null}
        </div>
      }
    >
      {!memoryMaintenanceDurableReady ? (
        <p className="office-subtitle">
          Dream is waiting for durable execution to become ready. Durable execution is part of the shipped runtime
          baseline, so this usually means startup healing or runtime allocation is still unavailable.
        </p>
      ) : (
        <>
          {memoryMaintenanceError ? <p className="error">{memoryMaintenanceError}</p> : null}
          {memoryMaintenanceDraft ? (
            <>
              <div className="office-kpi-grid">
                <Panel className="stat-card" title="Last run" subtitle="Most recent workspace maintenance pass.">
                  <p className="stat-card-value">{memoryMaintenanceStatus?.lastRun?.status ?? "-"}</p>
                  <p className="stat-card-note">
                    {memoryMaintenanceStatus?.lastRun?.finishedAt
                      ? new Date(memoryMaintenanceStatus.lastRun.finishedAt).toLocaleString()
                      : "No completed runs yet"}
                  </p>
                </Panel>
                <Panel className="stat-card" title="Next due" subtitle="Current schedule and threshold evaluation.">
                  <p className="stat-card-value">
                    {memoryMaintenanceStatus?.nextDueAt ? formatShortDateTime(memoryMaintenanceStatus.nextDueAt) : "-"}
                  </p>
                  <p className="stat-card-note">{memoryMaintenanceDraft.timeZone}</p>
                </Panel>
                <Panel
                  className="stat-card"
                  title="Provider / model"
                  subtitle="Pinned execution override for maintenance runs."
                >
                  <p className="stat-card-value">{memoryMaintenanceDraft.providerId || "(active provider)"}</p>
                  <p className="stat-card-note">
                    {memoryMaintenanceDraft.model || "(active model)"}
                    {selectedMaintenanceProvider
                      ? ` · ${describeMaintenanceProviderLocality(selectedMaintenanceProvider.baseUrl)}`
                      : ""}
                  </p>
                </Panel>
                <Panel className="stat-card" title="Execution target" subtitle="Where Dream is allowed to execute.">
                  <p className="stat-card-value">{memoryMaintenanceDraft.executionTarget}</p>
                  <p className="stat-card-note">
                    {describeMaintenanceUnavailablePolicy(memoryMaintenanceDraft.unavailableModelPolicy)}
                  </p>
                </Panel>
              </div>

              <div className="split-grid">
                <div>
                  <h4>Policy</h4>
                  <div className="controls-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={memoryMaintenanceDraft.enabled}
                        onChange={(event) => updateMemoryMaintenanceDraft({ enabled: event.target.checked })}
                      />{" "}
                      Enable Dream
                    </label>
                    <label>
                      Run mode
                      <GCSelect
                        value={memoryMaintenanceDraft.runMode}
                        onChange={(value) =>
                          updateMemoryMaintenanceDraft({ runMode: value as MemoryMaintenancePolicyDraft["runMode"] })
                        }
                        options={[
                          { value: "manual", label: "manual" },
                          { value: "scheduled", label: "scheduled" },
                          { value: "hybrid", label: "hybrid" },
                        ]}
                      />
                    </label>
                    <label>
                      Timing strategy
                      <GCSelect
                        value={memoryMaintenanceDraft.timingStrategy}
                        onChange={(value) =>
                          updateMemoryMaintenanceDraft({
                            timingStrategy: value as MemoryMaintenancePolicyDraft["timingStrategy"],
                          })
                        }
                        options={[
                          { value: "fixed", label: "fixed" },
                          { value: "recommendation_first", label: "recommendation_first" },
                        ]}
                      />
                    </label>
                  </div>

                  <div className="controls-row">
                    <label>
                      Time zone
                      <input
                        value={memoryMaintenanceDraft.timeZone}
                        onChange={(event) => updateMemoryMaintenanceDraft({ timeZone: event.target.value })}
                        placeholder="America/Los_Angeles"
                      />
                    </label>
                    <label>
                      Provider
                      <SelectOrCustom
                        value={memoryMaintenanceDraft.providerId}
                        onChange={updateMemoryMaintenanceProviderDraft}
                        options={memoryMaintenanceProviderOptions}
                        customPlaceholder="provider id"
                        customLabel="Custom provider"
                      />
                    </label>
                    <label>
                      Model
                      <SelectOrCustom
                        value={memoryMaintenanceDraft.model}
                        onChange={(value) => updateMemoryMaintenanceDraft({ model: value })}
                        options={memoryMaintenanceModelOptions}
                        customPlaceholder="model id"
                        customLabel="Custom model"
                      />
                    </label>
                  </div>
                  <FieldHelp className="office-subtitle">
                    Dream uses this pinned provider/model for maintenance runs only. Leave either blank to follow the
                    active runtime default. For an overnight local run, pin a local provider, keep execution target on
                    `local`, keep unavailable-model policy on `skip`, and use `hybrid` or `scheduled` with a late-night
                    hour in your timezone.
                  </FieldHelp>
                  <div className="controls-row">
                    <ActionButton
                      label="Apply overnight local preset"
                      onClick={applyMemoryMaintenanceLocalOvernightPreset}
                    />
                    <ActionButton
                      label={memoryMaintenanceModelsRefreshing ? "Refreshing models..." : "Refresh models"}
                      disabled={!memoryMaintenanceEffectiveProviderId || memoryMaintenanceModelsRefreshing}
                      onClick={() => void refreshMemoryMaintenanceModels()}
                    />
                  </div>
                  <p className="office-subtitle">
                    {selectedMaintenanceProvider
                      ? `${selectedMaintenanceProvider.providerId} resolves to ${selectedMaintenanceProvider.baseUrl}. ${describeMaintenanceProviderLocality(selectedMaintenanceProvider.baseUrl)}.`
                      : "Choose a provider to pin Dream to a specific runtime instead of the active chat default."}
                  </p>
                </div>

                <div>
                  <h4>Status</h4>
                  <ul className="compact-list">
                    <li>
                      <strong>Workspace:</strong> {workspaceId}
                    </li>
                    <li>
                      <strong>Active run:</strong> {memoryMaintenanceStatus?.state.activeRunId ?? "-"}
                    </li>
                    <li>
                      <strong>Last successful run:</strong>{" "}
                      {formatMaybeDateTime(memoryMaintenanceStatus?.state.lastSuccessfulRunAt)}
                    </li>
                    <li>
                      <strong>Last eligibility check:</strong>{" "}
                      {formatMaybeDateTime(memoryMaintenanceStatus?.state.lastEligibilityAt)}
                    </li>
                    <li>
                      <strong>Last recommendation:</strong>{" "}
                      {formatMaybeDateTime(memoryMaintenanceStatus?.state.lastRecommendationAt)}
                    </li>
                    <li>
                      <strong>Changed sessions:</strong> {memoryMaintenanceStatus?.state.changedSessionCount ?? 0}
                    </li>
                    <li>
                      <strong>Last run summary:</strong> {memoryMaintenanceStatus?.lastRun?.summary ?? "-"}
                    </li>
                  </ul>
                </div>
              </div>

              <div className="controls-row">
                <label>
                  Execution target
                  <GCSelect
                    value={memoryMaintenanceDraft.executionTarget}
                    onChange={(value) =>
                      updateMemoryMaintenanceDraft({
                        executionTarget: value as MemoryMaintenancePolicyDraft["executionTarget"],
                      })
                    }
                    options={[
                      { value: "auto", label: "auto" },
                      { value: "local", label: "local" },
                      { value: "cloud", label: "cloud" },
                    ]}
                  />
                </label>
                <label>
                  Unavailable model policy
                  <GCSelect
                    value={memoryMaintenanceDraft.unavailableModelPolicy}
                    onChange={(value) =>
                      updateMemoryMaintenanceDraft({
                        unavailableModelPolicy: value as MemoryMaintenancePolicyDraft["unavailableModelPolicy"],
                      })
                    }
                    options={[
                      { value: "skip", label: "skip" },
                      { value: "error", label: "error" },
                    ]}
                  />
                </label>
                <label>
                  Min hours since last success
                  <input
                    type="number"
                    min={1}
                    value={memoryMaintenanceDraft.minHoursSinceLastSuccess}
                    onChange={(event) =>
                      updateMemoryMaintenanceDraft({
                        minHoursSinceLastSuccess: clampNumber(
                          event.target.value,
                          1,
                          720,
                          memoryMaintenanceDraft.minHoursSinceLastSuccess,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Min changed sessions
                  <input
                    type="number"
                    min={1}
                    value={memoryMaintenanceDraft.minChangedSessions}
                    onChange={(event) =>
                      updateMemoryMaintenanceDraft({
                        minChangedSessions: clampNumber(
                          event.target.value,
                          1,
                          500,
                          memoryMaintenanceDraft.minChangedSessions,
                        ),
                      })
                    }
                  />
                </label>
              </div>

              <div className="controls-row">
                <label>
                  <input type="checkbox" checked={memoryMaintenanceDraft.runMode !== "manual"} disabled readOnly />{" "}
                  Schedule active
                </label>
                <label>
                  Frequency
                  <GCSelect
                    value={memoryMaintenanceDraft.scheduleFrequency}
                    onChange={(value) =>
                      updateMemoryMaintenanceDraft({
                        scheduleFrequency: value as MemoryMaintenancePolicyDraft["scheduleFrequency"],
                      })
                    }
                    options={[
                      { value: "daily", label: "daily" },
                      { value: "weekly", label: "weekly" },
                    ]}
                    disabled={memoryMaintenanceDraft.runMode === "manual"}
                  />
                </label>
                {memoryMaintenanceDraft.scheduleFrequency === "weekly" ? (
                  <label>
                    Weekday
                    <GCSelect
                      value={String(memoryMaintenanceDraft.scheduleWeekday)}
                      onChange={(value) =>
                        updateMemoryMaintenanceDraft({
                          scheduleWeekday: clampNumber(value, 0, 6, memoryMaintenanceDraft.scheduleWeekday),
                        })
                      }
                      options={[
                        { value: "0", label: "Sunday" },
                        { value: "1", label: "Monday" },
                        { value: "2", label: "Tuesday" },
                        { value: "3", label: "Wednesday" },
                        { value: "4", label: "Thursday" },
                        { value: "5", label: "Friday" },
                        { value: "6", label: "Saturday" },
                      ]}
                      disabled={memoryMaintenanceDraft.runMode === "manual"}
                    />
                  </label>
                ) : null}
                <label>
                  Hour
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={memoryMaintenanceDraft.scheduleHour}
                    disabled={memoryMaintenanceDraft.runMode === "manual"}
                    onChange={(event) =>
                      updateMemoryMaintenanceDraft({
                        scheduleHour: clampNumber(event.target.value, 0, 23, memoryMaintenanceDraft.scheduleHour),
                      })
                    }
                  />
                </label>
                <label>
                  Minute
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={memoryMaintenanceDraft.scheduleMinute}
                    disabled={memoryMaintenanceDraft.runMode === "manual"}
                    onChange={(event) =>
                      updateMemoryMaintenanceDraft({
                        scheduleMinute: clampNumber(event.target.value, 0, 59, memoryMaintenanceDraft.scheduleMinute),
                      })
                    }
                  />
                </label>
              </div>

              <div className="controls-row">
                <ActionButton
                  label={memoryMaintenanceBusy === "save" ? "Saving..." : "Save policy"}
                  disabled={memoryMaintenanceBusy === "save" || !memoryMaintenanceDraftDirty}
                  onClick={() => void saveMemoryMaintenancePolicy()}
                />
                <ActionButton
                  label="Reset"
                  disabled={!memoryMaintenanceDraftDirty}
                  onClick={resetMemoryMaintenancePolicyDraft}
                />
                <ActionButton
                  label={memoryMaintenanceBusy === "run" ? "Running..." : "Run now"}
                  disabled={memoryMaintenanceBusy === "run"}
                  onClick={() => void runMemoryMaintenance()}
                />
              </div>

              <div className="split-grid">
                <div>
                  <h4>Run history</h4>
                  <table className="gc-data-table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Status</th>
                        <th>Trigger</th>
                        <th>Provider / model</th>
                        <th>Created</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {memoryMaintenanceRuns.length === 0 ? (
                        <tr>
                          <td colSpan={6}>No maintenance runs recorded yet.</td>
                        </tr>
                      ) : (
                        memoryMaintenanceRuns.map((run) => (
                          <tr key={run.runId} className={selectedMaintenanceRunId === run.runId ? "row-selected" : ""}>
                            <td>
                              <strong>{shortId(run.runId)}</strong>
                              <div className="office-subtitle">
                                {run.sourceSessionCount} sessions / {run.changedArtifactCount} artifacts
                              </div>
                            </td>
                            <td>{run.status}</td>
                            <td>{run.triggerSource}</td>
                            <td>
                              {run.providerId ?? "(active)"} / {run.model ?? "(active)"}
                            </td>
                            <td>{new Date(run.createdAt).toLocaleString()}</td>
                            <td className="actions">
                              <ActionButton label="Inspect" onClick={() => setSelectedMaintenanceRunId(run.runId)} />
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div>
                  <h4>Recommendations</h4>
                  {memoryMaintenanceRecommendations.length === 0 ? (
                    <p className="office-subtitle">No timing recommendations queued.</p>
                  ) : (
                    <ul className="compact-list">
                      {memoryMaintenanceRecommendations.map((recommendation) => (
                        <li key={recommendation.recommendationId}>
                          <strong>{recommendation.kind}</strong> · {recommendation.status}
                          <div>{recommendation.summary}</div>
                          {recommendation.rationale ? (
                            <div className="office-subtitle">{recommendation.rationale}</div>
                          ) : null}
                          <div className="controls-row">
                            <ActionButton
                              label="Accept"
                              disabled={recommendation.status !== "queued" || memoryMaintenanceBusy === "accept"}
                              onClick={() => void acceptMaintenanceRecommendation(recommendation.recommendationId)}
                            />
                            <ActionButton
                              label="Reject"
                              disabled={recommendation.status !== "queued" || memoryMaintenanceBusy === "reject"}
                              onClick={() => void rejectMaintenanceRecommendation(recommendation.recommendationId)}
                            />
                          </div>
                          <pre>{formatJson(recommendation.proposedPatch)}</pre>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="split-grid">
                <div>
                  <h4>Selected run</h4>
                  {!selectedMaintenanceRun ? (
                    <p className="office-subtitle">Select a run to inspect provenance and durable state.</p>
                  ) : (
                    <>
                      <p>
                        <strong>Run ID:</strong> {selectedMaintenanceRun.runId}
                      </p>
                      <p>
                        <strong>Status:</strong> {selectedMaintenanceRun.status}
                      </p>
                      <p>
                        <strong>Summary:</strong> {selectedMaintenanceRun.summary ?? "-"}
                      </p>
                      <p>
                        <strong>Error:</strong> {selectedMaintenanceRun.error ?? "-"}
                      </p>
                      <h5>Changes</h5>
                      {selectedMaintenanceProvenance?.changes.length ? (
                        <ul className="compact-list">
                          {selectedMaintenanceProvenance.changes.map((change) => (
                            <li key={change.changeId}>
                              <strong>{change.changeKind}</strong> · {change.targetKind} · {change.targetRef}
                              <div>{change.summary}</div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="office-subtitle">No persisted changes recorded for this run yet.</p>
                      )}
                      <h5>Sources</h5>
                      {selectedMaintenanceProvenance?.sources.length ? (
                        <ul className="compact-list">
                          {selectedMaintenanceProvenance.sources.map((source) => (
                            <li key={source.sourceId}>
                              <strong>{source.sourceKind}</strong> · {source.sourceRef}
                              {source.modifiedAt ? ` · ${new Date(source.modifiedAt).toLocaleString()}` : ""}
                              {source.tokenEstimate ? ` · ${source.tokenEstimate} tokens` : ""}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="office-subtitle">No source provenance captured yet.</p>
                      )}
                    </>
                  )}
                </div>

                <div>
                  <h4>Durable inspector</h4>
                  {!selectedMaintenanceRun?.durableRunId ? (
                    <p className="office-subtitle">This run has no durable run id attached.</p>
                  ) : (
                    <>
                      <p>
                        <strong>Durable run:</strong> {selectedMaintenanceRun.durableRunId}
                      </p>
                      <p>
                        <strong>Status:</strong> {selectedMaintenanceDurableRun?.status ?? "-"}
                      </p>
                      <div className="controls-row">
                        <ActionButton
                          label={memoryMaintenanceBusy === "cancel" ? "Cancelling..." : "Cancel"}
                          disabled={memoryMaintenanceBusy === "cancel"}
                          onClick={() => void cancelSelectedMaintenanceRun()}
                        />
                        <ActionButton
                          label={memoryMaintenanceBusy === "retry" ? "Retrying..." : "Retry"}
                          disabled={memoryMaintenanceBusy === "retry"}
                          onClick={() => void retrySelectedMaintenanceRun()}
                        />
                      </div>
                      {selectedMaintenanceTimeline.length === 0 ? (
                        <p className="office-subtitle">No durable timeline events loaded.</p>
                      ) : (
                        <details open>
                          <summary>Timeline ({selectedMaintenanceTimeline.length})</summary>
                          <ul className="compact-list">
                            {selectedMaintenanceTimeline
                              .slice(-16)
                              .reverse()
                              .map((event) => {
                                const summary = describeDurableTimelineEvent(event);
                                return (
                                  <li key={event.eventId}>
                                    <strong>{summary.label}</strong>
                                    {summary.detail ? ` · ${summary.detail}` : ""}
                                    {event.stepKey ? ` · ${event.stepKey}` : ""}
                                    {" · "}
                                    {new Date(event.createdAt).toLocaleString()}
                                  </li>
                                );
                              })}
                          </ul>
                        </details>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p className="office-subtitle">Loading memory-maintenance policy...</p>
          )}
        </>
      )}
    </Panel>
  );
}
