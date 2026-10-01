import { Play, Plus, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { ConfigFormBuilder } from "@goatcitadel/mission-control-shared/components/ConfigFormBuilder";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  humanizeEnumToken,
  SettingsActionList,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
} from "../SettingsShared";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { NotificationRoutingPanel } from "./NotificationRoutingPanel";
import {
  DormantExternalConnectorsPanel,
  ExternalSideEffectLedgerPanel,
  GoogleMeetStatusPanel,
  OperatorActionResultPanel,
  PluginTrustPanel,
} from "./IntegrationsSectionPanels";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import { applyIntegrationDefaults } from "../helpers/channel-helpers";
import { formatDateTime } from "../helpers/input-format";
import { hasSessionDraft } from "../../library/session-drafts";
import { DetailInspector } from "../../../../components/DetailInspector";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { IntegrationConnectionReview } from "./IntegrationConnectionReview";
import { useIntegrationSettings } from "./use-integration-settings";
import "./integration-confirmation.css";
export function IntegrationsSection({ activeWorkspaceId, navigate }: SettingsSectionProps) {
  const {
    panel,
    requested,
    leave,
    saving,
    loading,
    error,
    data,
    reload,
    notice,
    selectedConnectionId,
    review,
    connectionMutation,
    createMutation,
    createCatalogId,
    createSchema,
    detailSchema,
    showCreateJson,
    showDetailJson,
    diagnostics,
    pendingDeleteConnection,
    setPendingDeleteConnection,
    deletePending,
    replayAuditBusy,
    operatorBusyId,
    lastReplayAuditRunId,
    externalConnectorBusyId,
    meetBusySessionId,
    lastOperatorActionResult,
    createableCatalog,
    selectedConnection,
    selectedCatalog,
    detailDraft,
    createLabel,
    createConfig,
    createGuidedConfig,
    detailForm,
    detailGuidedConfig,
    setCreateLabel,
    setCreateConfig,
    setCreateGuidedConfig,
    setDetailForm,
    setDetailGuidedConfig,
    operatorActionInputs,
    operatorActionIdempotencyKeys,
    setOperatorActionInputs,
    setOperatorActionIdempotencyKeys,
    meetDraft,
    meetForm,
    setMeetForm,
    openPanel,
    closePanel,
    connectionSelectionGuard,
    createCatalogGuard,
    toggleCreateJson,
    toggleDetailJson,
    handleCreate,
    handleSave,
    handleDelete,
    handleDiagnostics,
    handleOperatorAction,
    operatorReview,
    operatorReviewCurrent,
    confirmOperatorAction,
    cancelOperatorAction,
    diagnosticsPending,
    handleStartReplayAudit,
    replayReview, replayMutation, confirmReplayAudit, cancelReplayAudit,
    externalReview, externalMutation, confirmExternalReview, cancelExternalReview,
    handleReviewExternalConnectorService,
    handleReviewExternalConnectorAction,
    handleStageExternalConnectorAction,
    handleStartGoogleMeetRealtime,
    handleStopGoogleMeetSession,
    handleConsultGoogleMeetSession,
    meetReview, meetMutation, confirmMeetReview, cancelMeetReview,
  } = useIntegrationSettings(activeWorkspaceId);
  return (
    <SettingsSectionShell loading={loading && !data} error={data ? null : error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {[externalMutation, replayMutation, meetMutation].filter((item) => item.phase === "uncertain").map((item, index) =>
        <SettingsNotice key={index} notice={{ tone: "warning", message: item.message! }} />)}
      {createMutation.phase === "uncertain" ? <SettingsNotice notice={{ tone: "warning", message: createMutation.message! }} /> : null}
      {connectionMutation.phase === "uncertain" ? (
        <SettingsNotice notice={{ tone: "warning", message: connectionMutation.message! }} />
      ) : null}
      {data ? (
        <SettingsStack>
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          {panel === "create" ? (
            <FocusedDetail title="Add integration" onClose={closePanel}>
              <SettingsStack>
                <SettingsFieldGrid>
                  <SettingsField label="Catalog">
                    <select
                      className="mc-next-settings-input"
                      value={createCatalogId}
                      onChange={(event) => {
                        const catalogId = event.target.value;
                        if (catalogId !== createCatalogId) {
                          createCatalogGuard.requestTransition(catalogId);
                        }
                      }}
                      disabled={createableCatalog.length === 0}
                    >
                      <option value="" disabled>
                        {createableCatalog.length > 0 ? "Choose an integration" : "No integrations available"}
                      </option>
                      {createableCatalog.map((item) => (
                        <option key={item.catalogId} value={item.catalogId}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </SettingsField>
                  <SettingsField label="Label">
                    <input
                      className="mc-next-settings-input"
                      value={createLabel}
                      onChange={(event) => setCreateLabel(event.target.value)}
                      placeholder="Optional connection label"
                    />
                  </SettingsField>
                </SettingsFieldGrid>
                {showCreateJson ? (
                  <SettingsField label="Advanced Config JSON" span={2}>
                    <textarea
                      className="mc-next-settings-textarea mc-next-settings-code"
                      value={createConfig}
                      onChange={(event) => setCreateConfig(event.target.value)}
                    />
                  </SettingsField>
                ) : (
                  <ConfigFormBuilder
                    schema={createSchema}
                    value={createGuidedConfig}
                    onChange={setCreateGuidedConfig}
                  />
                )}
                {selectedCatalog ? (
                  <NativeMetricGrid
                    items={[
                      { label: "Kind", value: humanizeEnumToken(selectedCatalog.kind), meta: selectedCatalog.key },
                      {
                        label: "Capabilities",
                        value: String(selectedCatalog.capabilities.length),
                        meta: selectedCatalog.authMethods.join(", ") || "No auth methods listed",
                      },
                    ]}
                  />
                ) : null}
                <SettingsNotice
                  notice={{
                    tone: "info",
                    message: selectedCatalog?.operatorActions?.length
                      ? `${selectedCatalog.operatorActions.length} operator action${selectedCatalog.operatorActions.length === 1 ? "" : "s"} are advertised by this catalog entry. Run actions only from a saved connection.`
                      : "Catalog entries without operator actions are setup and diagnostics surfaces only; no hidden runtime action is implied.",
                  }}
                />
                <SettingsButtonRow>
                  <NativeButton
                    variant="default"
                    disabled={saving || createMutation.locked || !createCatalogId}
                    onClick={() => void handleCreate()}
                  >
                    <Plus size={16} />
                    Create connection
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={toggleCreateJson}>
                    <SlidersHorizontal size={16} />
                    {showCreateJson ? "Use guided fields" : "Advanced JSON"}
                  </NativeButton>
                </SettingsButtonRow>
                <NativeDisclosureCard id="integration-catalog" title="Catalog details">
                  <SettingsActionList
                    ariaLabel="Integration catalog entries"
                    items={data.catalog.map((item) => {
                      const reviewOnly = item.kind === "external_connector";
                      return {
                        id: item.catalogId,
                        label: item.label,
                        description: item.description,
                        meta: `${item.kind} · ${item.maturity} · ${item.capabilities.length} capabilities`,
                        actionLabel: reviewOnly
                          ? "Review-only"
                          : createCatalogId === item.catalogId
                            ? "Selected"
                            : "Use",
                        onClick: reviewOnly ? undefined : () => createCatalogGuard.requestTransition(item.catalogId),
                      };
                    })}
                    emptyLabel="No integration catalog entries are available."
                    maxHeight="min(58vh, 34rem)"
                  />
                </NativeDisclosureCard>
              </SettingsStack>
            </FocusedDetail>
          ) : panel === "edit" ? (
            <FocusedDetail title={"Edit " + (selectedConnection?.label ?? "connection")} onClose={closePanel}>
              <SettingsStack>
                {detailDraft.hasRemoteChanges || review.required ? (
                  <IntegrationConnectionReview
                    connection={selectedConnection}
                    loading={review.loading}
                    error={review.error}
                    missing={review.missing}
                    onReload={() => void review.refresh()}
                    onAccept={() => {
                      detailDraft.rebaseToCurrent();
                      review.accept();
                    }}
                  />
                ) : null}
                <SettingsFieldGrid>
                  <SettingsField label="Label">
                    <input
                      className="mc-next-settings-input"
                      value={detailForm.label}
                      onChange={(event) => setDetailForm((current) => ({ ...current, label: event.target.value }))}
                    />
                  </SettingsField>
                  <SettingsField label="Status">
                    <select
                      className="mc-next-settings-input"
                      value={detailForm.status}
                      onChange={(event) => setDetailForm((current) => ({ ...current, status: event.target.value }))}
                    >
                      <option value="connected">Connected</option>
                      <option value="disconnected">Disconnected</option>
                      <option value="paused">Paused</option>
                      <option value="error">Error</option>
                    </select>
                  </SettingsField>
                  <SettingsField label="Enabled" group>
                    <label className="mc-next-settings-toggle">
                      <input
                        type="checkbox"
                        aria-label="Integration connection enabled"
                        checked={detailForm.enabled}
                        onChange={(event) =>
                          setDetailForm((current) => ({ ...current, enabled: event.target.checked }))
                        }
                      />
                      <span>Connection can be used by the operator.</span>
                    </label>
                  </SettingsField>
                </SettingsFieldGrid>
                {showDetailJson ? (
                  <SettingsField label="Advanced Config JSON" span={2}>
                    <textarea
                      className="mc-next-settings-textarea mc-next-settings-code"
                      value={detailForm.configText}
                      onChange={(event) => setDetailForm((current) => ({ ...current, configText: event.target.value }))}
                    />
                  </SettingsField>
                ) : (
                  <ConfigFormBuilder
                    schema={detailSchema}
                    value={detailGuidedConfig}
                    onChange={setDetailGuidedConfig}
                  />
                )}
                <SettingsButtonRow>
                  <NativeButton
                    disabled={
                      saving ||
                      connectionMutation.locked ||
                      detailDraft.hasRemoteChanges ||
                      review.required ||
                      !selectedConnection ||
                      !detailDraft.baseRevision
                    }
                    onClick={() => void handleSave()}
                  >
                    Save changes
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={toggleDetailJson}>
                    {showDetailJson ? "Use guided fields" : "Advanced JSON"}
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={closePanel}>
                    Close editor
                  </NativeButton>
                </SettingsButtonRow>
              </SettingsStack>
            </FocusedDetail>
          ) : (
            <>
              <SettingsButtonRow>
                <NativeButton onClick={() => openPanel("create")}>
                  <Plus size={16} />
                  Add integration
                  {hasSessionDraft("integration:" + activeWorkspaceId + ":" + createCatalogId + ":new")
                    ? " · Unsaved"
                    : ""}
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => void reload()}>
                  Refresh
                </NativeButton>
              </SettingsButtonRow>
              <NativeCard
                title="Connected integrations"
                subtitle=""
                stats={[
                  {
                    label: "Connections",
                    value: data.issues.some((issue) => issue.label === "Integration connections")
                      ? "Unavailable"
                      : String(data.connections.length),
                  },
                  {
                    label: "Catalog",
                    value: data.issues.some((issue) => issue.label === "Integration catalog")
                      ? "Unavailable"
                      : String(data.catalog.length),
                  },
                  {
                    label: "Plugins",
                    value: !requested.plugins
                      ? "Not loaded"
                      : data.issues.some((issue) => issue.label === "Integration plugins")
                        ? "Unavailable"
                        : Array.isArray(data.plugins)
                          ? String(data.plugins.length)
                          : "Unavailable",
                  },
                ]}
              >
                <NativeSelectableList
                  items={data.connections.map((item) => ({
                    id: item.connectionId,
                    title: item.label,
                    meta:
                      item.status +
                      (hasSessionDraft("integration:" + activeWorkspaceId + ":" + item.connectionId + ":edit")
                        ? " · Unsaved"
                        : ""),
                    body: `${item.key} · ${item.enabled ? "enabled" : "disabled"}`,
                  }))}
                  selectedId={selectedConnectionId}
                  onSelect={(connectionId) => {
                    connectionSelectionGuard.requestTransition(connectionId);
                  }}
                  emptyLabel="No integration connections yet."
                  maxHeight="min(65vh, 42rem)"
                />
              </NativeCard>
              <NativeDisclosureCard id="integration-support" title="More integration tools">
                <SettingsButtonRow>
                  <NativeButton variant="secondary" onClick={() => openPanel("meet")}>
                    Google Meet{meetDraft.isDirty ? " · Unsaved" : ""}
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => openPanel("history")}>
                    Delivery history
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => openPanel("routing")}>
                    Notification routing
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => openPanel("connectors")}>
                    Review external connectors
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => openPanel("plugins")}>
                    Plugin trust
                  </NativeButton>
                </SettingsButtonRow>
              </NativeDisclosureCard>
            </>
          )}
          <DetailInspector
            open={panel === "details"}
            title={selectedConnection?.label ?? "Connection unavailable"}
            onClose={closePanel}
          >
            <SettingsStack>
              {review.required ? (
                <IntegrationConnectionReview
                  connection={selectedConnection}
                  loading={review.loading}
                  error={review.error}
                  missing={review.missing}
                  onReload={() => void review.refresh()}
                  onAccept={() => {
                    detailDraft.rebaseToCurrent();
                    review.accept();
                  }}
                />
              ) : null}
              {selectedConnection ? (
                <>
                  <p>
                    {selectedConnection.status} · {selectedConnection.enabled ? "Enabled" : "Disabled"}
                  </p>
                  <dl>
                    <dt>Scope</dt>
                    <dd>
                      {(selectedConnection as IntegrationConnection & { workspaceId?: string }).workspaceId ??
                        "Unbound · Personal Citadel policy"}
                    </dd>
                    <dt>Connection ID</dt>
                    <dd>{selectedConnection.connectionId}</dd>
                    <dt>Updated</dt>
                    <dd>{formatDateTime(selectedConnection.updatedAt)}</dd>
                  </dl>

                  <NativeMetricGrid
                    items={[
                      { label: "Catalog key", value: selectedConnection.key, meta: selectedConnection.kind },
                      {
                        label: "Last sync",
                        value: formatDateTime(selectedConnection.lastSyncAt),
                        meta: selectedConnection.lastError || "No recent error",
                      },
                    ]}
                  />
                  <SettingsButtonRow>
                    <NativeButton onClick={() => openPanel("edit")}>
                      Edit connection{detailDraft.isDirty ? " · Unsaved" : ""}
                    </NativeButton>
                    <NativeButton
                      variant="secondary"
                      disabled={!data.connectorDiagnosticsEnabled || diagnosticsPending}
                      onClick={() => void handleDiagnostics()}
                    >
                      <RefreshCw size={16} />
                      Run diagnostics
                    </NativeButton>

                    <NativeButton
                      variant="destructive"
                      disabled={review.required || connectionMutation.locked || saving || deletePending || !selectedConnection.revision}
                      onClick={() =>
                        setPendingDeleteConnection({
                          connectionId: selectedConnection.connectionId,
                          label: selectedConnection.label,
                          revision: selectedConnection.revision,
                        })
                      }
                    >
                      <Trash2 size={16} />
                      Delete
                    </NativeButton>
                  </SettingsButtonRow>
                  {!data.connectorDiagnosticsEnabled ? (
                    <p className="mc-next-settings-field-note">
                      Connector diagnostics are not enabled in Runtime settings.
                    </p>
                  ) : null}
                  <NativeDisclosureCard id="integration-actions" title="Actions">
                    {selectedCatalog?.operatorActions?.length ? (
                      <div className="mc-next-settings-stack">
                        {selectedCatalog.operatorActions.map((action) => {
                          const actionInput = action.formSchema
                            ? applyIntegrationDefaults(action.formSchema, operatorActionInputs[action.actionId] ?? {})
                            : {};
                          return (
                            <div key={action.actionId} className="mc-next-settings-panel-body">
                              <NativeMetricGrid
                                items={[
                                  { label: "Action", value: action.label, meta: action.description },
                                  { label: "Capability", value: action.capability, meta: action.actionId },
                                ]}
                              />
                              {action.formSchema ? (
                                <ConfigFormBuilder
                                  schema={action.formSchema}
                                  value={actionInput}
                                  onChange={(next) =>
                                    setOperatorActionInputs((current) => ({
                                      ...current,
                                      [action.actionId]: next,
                                    }))
                                  }
                                />
                              ) : null}
                              {action.capability === "write" ? (
                                <SettingsField label="Idempotency key">
                                  <input
                                    className="mc-next-settings-input"
                                    value={operatorActionIdempotencyKeys[action.actionId] ?? ""}
                                    onChange={(event) =>
                                      setOperatorActionIdempotencyKeys((current) => ({
                                        ...current,
                                        [action.actionId]: event.target.value,
                                      }))
                                    }
                                    placeholder="Optional explicit key for a replay-safe write"
                                  />
                                </SettingsField>
                              ) : null}
                              <SettingsButtonRow>
                                <NativeButton
                                  variant="default"
                                  disabled={connectionMutation.locked || review.required || operatorBusyId === selectedConnection.connectionId + ":" + action.actionId}
                                  onClick={() => void handleOperatorAction(action)}
                                >
                                  <Play size={16} />
                                  Run
                                </NativeButton>
                              </SettingsButtonRow>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <SettingsNotice
                        notice={{
                          tone: "info",
                          message: data.connectorDiagnosticsEnabled
                            ? "This integration has no advertised operator action. Save changes and run diagnostics here; runtime use stays blocked until a catalog action exists."
                            : "This integration has no advertised operator action. Save changes here; runtime use stays blocked until a catalog action exists, and diagnostics remain unavailable until enabled in Runtime settings.",
                        }}
                      />
                    )}
                  </NativeDisclosureCard>
                  {lastOperatorActionResult ? <OperatorActionResultPanel result={lastOperatorActionResult} /> : null}
                  {diagnostics ? (
                    <DiagnosticsPanel report={diagnostics} ariaLabel="Integration connection diagnostic checks" />
                  ) : null}
                </>
              ) : (
                <p>Choose a connection or add an integration.</p>
              )}
            </SettingsStack>
          </DetailInspector>
          <DetailInspector
            open={
              panel === "plugins" ||
              panel === "connectors" ||
              panel === "history" ||
              panel === "routing" ||
              panel === "meet"
            }
            title={
              panel === "plugins"
                ? "Plugin trust"
                : panel === "connectors"
                  ? "External connectors"
                  : panel === "history"
                    ? "Delivery history"
                    : panel === "routing"
                      ? "Notification routing"
                      : "Google Meet"
            }
            onClose={closePanel}
          >
            {panel === "plugins" ? (
              <PluginTrustPanel plugins={data.plugins ?? []} />
            ) : panel === "connectors" ? (
              <DormantExternalConnectorsPanel
                services={data.externalConnectorServices ?? []}
                busyId={externalConnectorBusyId}
                onReviewService={(service, status) => void handleReviewExternalConnectorService(service, status)}
                onReviewAction={(action, status) => void handleReviewExternalConnectorAction(action, status)}
                onStageAction={(action) => void handleStageExternalConnectorAction(action)}
              />
            ) : panel === "history" ? (
              <ExternalSideEffectLedgerPanel
                runs={data.sideEffectRuns ?? []}
                summary={data.sideEffectSummary}
                selectedConnectionId={selectedConnection?.connectionId}
                busy={replayAuditBusy}
                onStartReplayAudit={(run) => void handleStartReplayAudit(run)}
                lastReplayAuditRunId={lastReplayAuditRunId}
                onOpenReplayAudit={(runId) => navigate({ area: "ops", section: "sessions", view: "run-detail", runId })}
              />
            ) : panel === "routing" ? (
              <NotificationRoutingPanel workspaceId={activeWorkspaceId} channels={data.channelConnections} />
            ) : panel === "meet" ? (
              <GoogleMeetStatusPanel
                status={data.meetStatus}
                sessions={data.meetSessions}
                form={meetForm}
                busySessionId={meetMutation.locked ? (meetBusySessionId ?? "locked") : null}
                onFormChange={setMeetForm}
                onStartOpenAIRealtime={() => void handleStartGoogleMeetRealtime()}
                onStopSession={(session) => void handleStopGoogleMeetSession(session)}
                onConsultSession={(session) => void handleConsultGoogleMeetSession(session)}
              />
            ) : null}
          </DetailInspector>
        </SettingsStack>
      ) : null}
      {leave.dialog}
      <ConfirmModal open={Boolean(meetReview)} title={meetReview?.title ?? "Review meeting action"}
        message={meetReview?.description ?? ""} danger confirmLabel="Apply reviewed meeting action"
        pending={meetMutation.pending} confirmDisabled={meetMutation.phase === "uncertain"}
        onCancel={cancelMeetReview} onConfirm={() => void confirmMeetReview()} />
      <ConfirmModal open={Boolean(externalReview)} title="Confirm external connector review"
        message={`${externalReview?.action?.label ?? externalReview?.service.label ?? "Connector"}: mark ${externalReview?.status ?? "reviewed"} in workspace ${activeWorkspaceId}. This changes review metadata or creates a non-callable capability proposal. It never activates the connector. This owner has no atomic revision precondition; current catalog evidence is re-read before dispatch.`}
        confirmLabel="Confirm catalog review" pending={externalMutation.pending} confirmDisabled={externalMutation.phase === "uncertain"}
        onCancel={cancelExternalReview} onConfirm={() => void confirmExternalReview()} />
      <ConfirmModal open={Boolean(replayReview)} title="Create replay eligibility audit?"
        message={`Inspect side-effect run ${replayReview?.run.runId ?? ""} in workspace ${activeWorkspaceId}. This creates a durable eligibility audit only. Unknown external outcomes still require manual reconciliation. The side-effect snapshot is re-read, but this creation API has no atomic revision precondition.`}
        confirmLabel="Create reviewed replay audit" pending={replayMutation.pending} confirmDisabled={replayMutation.phase === "uncertain"}
        onCancel={cancelReplayAudit} onConfirm={() => void confirmReplayAudit()} />
      <ConfirmModal
        open={operatorReview !== null}
        title="Run reviewed integration action?"
        message={`${operatorReview?.action.label ?? "Action"} on ${operatorReview?.connection.label ?? "connection"}. This may contact its external service. The Gateway rechecks policy and approvals. The action API has no atomic revision precondition; this UI rechecks the saved connection and advertised action before dispatch.`}
        confirmLabel="Run reviewed action"
        pending={Boolean(operatorBusyId)}
        confirmDisabled={!operatorReviewCurrent || connectionMutation.phase === "uncertain"}
        onCancel={cancelOperatorAction}
        onConfirm={() => void confirmOperatorAction()}
      />
      <ConfirmModal
        className="mc-next-integration-confirmation"
        open={pendingDeleteConnection !== null}
        danger
        pending={deletePending}
        title="Delete integration connection?"
        message={`Delete ${pendingDeleteConnection?.label ?? "this connection"}? Saved configuration and retained drafts for this connection will be permanently removed.`}
        confirmLabel="Delete connection"
        onCancel={() => setPendingDeleteConnection(null)}
        onConfirm={() => void handleDelete()}
      />
    </SettingsSectionShell>
  );
}
