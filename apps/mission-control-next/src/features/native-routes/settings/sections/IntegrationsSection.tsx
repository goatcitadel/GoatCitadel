// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Play, Plus, RefreshCw, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import type {
  ConnectorDiagnosticReport,
  ExternalConnectorActionSummary,
  ExternalConnectorServiceSummary,
  ExternalSideEffectRunRecord,
  GoogleMeetSessionRecord,
  IntegrationActionInvokeResult,
  IntegrationFormSchema,
  IntegrationOperatorAction,
} from "@goatcitadel/contracts";
import {
  createExternalSideEffectReplayAuditRun,
  createGoogleMeetConsultHandoff,
  createRealtimeVoiceClientSecret,
  createIntegrationConnection,
  deleteIntegrationConnection,
  fetchExternalConnectorServices,
  fetchExternalSideEffectRuns,
  fetchGoogleMeetPrerequisiteStatus,
  fetchGoogleMeetSessions,
  fetchIntegrationCatalog,
  fetchIntegrationConnectionDiagnostics,
  fetchIntegrationConnections,
  fetchIntegrationFormSchema,
  fetchIntegrationPlugins,
  type IntegrationConnection,
  invokeIntegrationConnectionAction,
  stageExternalConnectorAction,
  startGoogleMeetSession,
  stopGoogleMeetSession,
  updateExternalConnectorActionReviewState,
  updateExternalConnectorServiceReviewState,
  updateIntegrationConnection,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfigFormBuilder } from "@goatcitadel/mission-control-shared/components/ConfigFormBuilder";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  getErrorMessage,
  humanizeEnumToken,
  nativeLoad,
  nativeLoadIssues,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import {
  DormantExternalConnectorsPanel,
  ExternalSideEffectLedgerPanel,
  GoogleMeetStatusPanel,
  OperatorActionResultPanel,
  PluginTrustPanel,
} from "./IntegrationsSectionPanels";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import { applyIntegrationDefaults, formatDateTime, formatJson, parseJsonObject } from "../../SettingsNativePage";

export function IntegrationsSection({ activeWorkspaceId, navigate }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [catalog, connections, plugins, meetStatus, meetSessions, sideEffectRuns, externalConnectors] =
      await Promise.all([
        nativeLoad("Integration catalog", fetchIntegrationCatalog(), { items: [] }),
        nativeLoad("Integration connections", fetchIntegrationConnections(), { items: [] }),
        nativeLoad("Integration plugins", fetchIntegrationPlugins(), { items: [] }),
        nativeLoad("Google Meet prerequisites", fetchGoogleMeetPrerequisiteStatus(), null),
        nativeLoad("Google Meet sessions", fetchGoogleMeetSessions(6), []),
        nativeLoad(
          "External side-effect runs",
          fetchExternalSideEffectRuns({ workspaceId: activeWorkspaceId, limit: 25 }),
          {
            items: [],
          },
        ),
        nativeLoad(
          "Dormant external connector catalog",
          fetchExternalConnectorServices({ workspaceId: activeWorkspaceId, includeActions: true, limit: 50 }),
          { items: [] },
        ),
      ]);
    return {
      issues: nativeLoadIssues([
        catalog,
        connections,
        plugins,
        meetStatus,
        meetSessions,
        sideEffectRuns,
        externalConnectors,
      ]),
      catalog: (catalog.data.items ?? []).filter((item) => item.kind !== "channel"),
      connections: (connections.data.items ?? []).filter((item) => item.kind !== "channel"),
      plugins: plugins.data.items,
      meetStatus: meetStatus.data,
      meetSessions: Array.isArray(meetSessions.data) ? meetSessions.data : [],
      sideEffectRuns: sideEffectRuns.data.items,
      sideEffectSummary: sideEffectRuns.data.summary,
      externalConnectorServices: externalConnectors.data.items,
    };
  }, [activeWorkspaceId]);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [createCatalogId, setCreateCatalogId] = useState("");
  const [createLabel, setCreateLabel] = useState("");
  const [createConfig, setCreateConfig] = useState("{}");
  const [createGuidedConfig, setCreateGuidedConfig] = useState<Record<string, unknown>>({});
  const [createSchema, setCreateSchema] = useState<IntegrationFormSchema | undefined>();
  const [showCreateJson, setShowCreateJson] = useState(false);
  const [detailForm, setDetailForm] = useState({
    label: "",
    enabled: true,
    status: "connected",
    configText: "{}",
  });
  const [detailGuidedConfig, setDetailGuidedConfig] = useState<Record<string, unknown>>({});
  const [detailSchema, setDetailSchema] = useState<IntegrationFormSchema | undefined>();
  const [showDetailJson, setShowDetailJson] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ConnectorDiagnosticReport | null>(null);
  const [pendingDeleteConnection, setPendingDeleteConnection] = useState<{
    connectionId: string;
    label: string;
  } | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [operatorActionInputs, setOperatorActionInputs] = useState<Record<string, Record<string, unknown>>>({});
  const [operatorActionIdempotencyKeys, setOperatorActionIdempotencyKeys] = useState<Record<string, string>>({});
  const [replayAuditBusy, setReplayAuditBusy] = useState(false);
  const [lastReplayAuditRunId, setLastReplayAuditRunId] = useState<string | null>(null);
  const [externalConnectorBusyId, setExternalConnectorBusyId] = useState<string | null>(null);
  const [meetBusySessionId, setMeetBusySessionId] = useState<string | null>(null);
  const [meetForm, setMeetForm] = useState({
    meetingUrl: "",
    displayName: "",
    accountRef: "",
  });
  const [lastOperatorActionResult, setLastOperatorActionResult] = useState<
    (IntegrationActionInvokeResult & { actionLabel: string }) | null
  >(null);
  const createableCatalog = useMemo(
    () => data?.catalog.filter((item) => item.kind !== "external_connector") ?? [],
    [data?.catalog],
  );
  const selectedConnection =
    data?.connections.find((item) => item.connectionId === selectedConnectionId) ?? data?.connections[0] ?? null;
  const selectedCatalog =
    data?.catalog.find((item) => item.catalogId === selectedConnection?.catalogId) ??
    data?.catalog.find((item) => item.catalogId === createCatalogId) ??
    null;

  useEffect(() => {
    if (!createableCatalog.length) {
      setCreateCatalogId("");
      return;
    }
    setCreateCatalogId((current) =>
      current && createableCatalog.some((item) => item.catalogId === current)
        ? current
        : createableCatalog[0]?.catalogId || "",
    );
  }, [createableCatalog]);

  useEffect(() => {
    if (!data?.connections.length) {
      setSelectedConnectionId("");
      return;
    }
    setSelectedConnectionId((current) =>
      current && data.connections.some((item) => item.connectionId === current)
        ? current
        : data.connections[0]?.connectionId || "",
    );
  }, [data?.connections]);

  useEffect(() => {
    if (!selectedConnection) {
      return;
    }
    setDetailForm({
      label: selectedConnection.label,
      enabled: selectedConnection.enabled,
      status: selectedConnection.status,
      configText: formatJson(selectedConnection.config),
    });
    setDetailGuidedConfig(selectedConnection.config);
  }, [selectedConnection]);

  useEffect(() => {
    if (!createCatalogId) {
      setCreateSchema(undefined);
      setCreateGuidedConfig({});
      return;
    }
    let cancelled = false;
    void fetchIntegrationFormSchema(createCatalogId)
      .then((schema) => {
        if (!cancelled) {
          setCreateSchema(schema);
          setCreateGuidedConfig(applyIntegrationDefaults(schema, {}));
          setCreateConfig("{}");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCreateSchema(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [createCatalogId]);

  useEffect(() => {
    if (!selectedConnection?.catalogId) {
      setDetailSchema(undefined);
      return;
    }
    let cancelled = false;
    void fetchIntegrationFormSchema(selectedConnection.catalogId)
      .then((schema) => {
        if (!cancelled) {
          setDetailSchema(schema);
          setDetailGuidedConfig((current) => applyIntegrationDefaults(schema, current));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetailSchema(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedConnection?.catalogId]);

  const handleCreate = async () => {
    if (!createCatalogId) {
      setNotice({ tone: "warning", message: "Choose an integration catalog entry first." });
      return;
    }
    try {
      const created = await createIntegrationConnection({
        catalogId: createCatalogId,
        label: createLabel.trim() || undefined,
        enabled: true,
        config: showCreateJson ? parseJsonObject(createConfig) : createGuidedConfig,
      });
      setNotice({ tone: "success", message: `Connection ${created.label} created.` });
      await reload();
      setSelectedConnectionId(created.connectionId);
      setCreateLabel("");
      setCreateConfig("{}");
      setCreateGuidedConfig(createSchema ? applyIntegrationDefaults(createSchema, {}) : {});
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleSave = async () => {
    if (!selectedConnection) {
      return;
    }
    try {
      await updateIntegrationConnection(selectedConnection.connectionId, {
        label: detailForm.label.trim() || undefined,
        enabled: detailForm.enabled,
        status: detailForm.status as IntegrationConnection["status"],
        config: showDetailJson ? parseJsonObject(detailForm.configText, selectedConnection.config) : detailGuidedConfig,
      });
      setNotice({ tone: "success", message: "Connection updated." });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleDelete = async () => {
    if (!pendingDeleteConnection) {
      return;
    }
    setDeletePending(true);
    try {
      await deleteIntegrationConnection(pendingDeleteConnection.connectionId);
      setNotice({ tone: "success", message: "Connection deleted." });
      setDiagnostics(null);
      setPendingDeleteConnection(null);
      await reload();
    } catch (deleteError) {
      setNotice({ tone: "error", message: getErrorMessage(deleteError) });
    } finally {
      setDeletePending(false);
    }
  };

  const handleDiagnostics = async () => {
    if (!selectedConnection) {
      return;
    }
    try {
      const result = await fetchIntegrationConnectionDiagnostics(selectedConnection.connectionId);
      setDiagnostics(result);
      setNotice({ tone: "success", message: "Diagnostics refreshed." });
    } catch (diagnosticsError) {
      setNotice({ tone: "error", message: getErrorMessage(diagnosticsError) });
    }
  };

  const handleOperatorAction = async (action: IntegrationOperatorAction) => {
    if (!selectedConnection) {
      return;
    }
    const input = action.formSchema
      ? applyIntegrationDefaults(action.formSchema, operatorActionInputs[action.actionId] ?? {})
      : undefined;
    const idempotencyKey = operatorActionIdempotencyKeys[action.actionId]?.trim();
    try {
      const result = await invokeIntegrationConnectionAction(selectedConnection.connectionId, action.actionId, {
        ...(input ? { input } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      setLastOperatorActionResult({ ...result, actionLabel: action.label });
      setNotice({
        tone: result.status === "failed" ? "error" : result.status === "blocked" ? "warning" : "success",
        message: result.message,
      });
      await reload();
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    }
  };

  const handleStartReplayAudit = async (run?: ExternalSideEffectRunRecord) => {
    if (!run) {
      setNotice({ tone: "warning", message: "Choose a pre-boundary or stale claimed side-effect run first." });
      return;
    }
    setReplayAuditBusy(true);
    try {
      const durableRun = await createExternalSideEffectReplayAuditRun({
        workspaceId: activeWorkspaceId,
        requestedBy: "operator",
        runIds: [run.runId],
        ...(run.connectionId ? { connectionId: run.connectionId } : {}),
        limit: 1,
      });
      setLastReplayAuditRunId(durableRun.runId);
      setNotice({
        tone: "success",
        message: `Replay audit durable run ${durableRun.runId} created. It checks eligibility only; unknown post-boundary outcomes stay manual.`,
      });
      await reload();
    } catch (replayError) {
      setNotice({ tone: "error", message: getErrorMessage(replayError) });
    } finally {
      setReplayAuditBusy(false);
    }
  };

  const handleReviewExternalConnectorService = async (
    service: ExternalConnectorServiceSummary,
    status: "reviewed" | "hidden",
  ) => {
    const busyId = `service:${service.sourceId}:${service.serviceId}`;
    setExternalConnectorBusyId(busyId);
    try {
      await updateExternalConnectorServiceReviewState(service.sourceId, service.serviceId, {
        workspaceId: activeWorkspaceId,
        status,
      });
      setNotice({
        tone: status === "hidden" ? "warning" : "success",
        message: `${service.label} marked ${status}.`,
      });
      await reload();
    } catch (reviewError) {
      setNotice({ tone: "error", message: getErrorMessage(reviewError) });
    } finally {
      setExternalConnectorBusyId(null);
    }
  };

  const handleReviewExternalConnectorAction = async (
    action: ExternalConnectorActionSummary,
    status: "reviewed" | "hidden",
  ) => {
    const busyId = `action:${action.sourceId}:${action.serviceId}:${action.actionId}`;
    setExternalConnectorBusyId(busyId);
    try {
      await updateExternalConnectorActionReviewState(action.sourceId, action.serviceId, action.actionId, {
        workspaceId: activeWorkspaceId,
        status,
      });
      setNotice({
        tone: status === "hidden" ? "warning" : "success",
        message: `${action.label} marked ${status}.`,
      });
      await reload();
    } catch (reviewError) {
      setNotice({ tone: "error", message: getErrorMessage(reviewError) });
    } finally {
      setExternalConnectorBusyId(null);
    }
  };

  const handleStageExternalConnectorAction = async (action: ExternalConnectorActionSummary) => {
    const busyId = `action:${action.sourceId}:${action.serviceId}:${action.actionId}`;
    setExternalConnectorBusyId(busyId);
    try {
      const result = await stageExternalConnectorAction(action.sourceId, action.serviceId, action.actionId, {
        workspaceId: activeWorkspaceId,
      });
      setNotice({
        tone: "success",
        message: `${action.label} staged as ${result.proposal.proposalId}. It remains non-callable.`,
      });
      await reload();
    } catch (stageError) {
      setNotice({ tone: "error", message: getErrorMessage(stageError) });
    } finally {
      setExternalConnectorBusyId(null);
    }
  };

  const handleStartGoogleMeetRealtime = async () => {
    const meetingUrl = meetForm.meetingUrl.trim();
    if (!meetingUrl) {
      setNotice({ tone: "warning", message: "Enter a Google Meet URL before starting OpenAI Realtime voice." });
      return;
    }
    setMeetBusySessionId("new");
    let audioProbe: MediaStream | null = null;
    try {
      const browserTransportReady = isGoogleMeetBrowserTransportReady();
      if (!browserTransportReady) {
        throw new Error("Browser WebRTC and microphone APIs are required before meeting voice can start.");
      }
      audioProbe = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioTransportReady = audioProbe.getAudioTracks().length > 0;
      const session = await startGoogleMeetSession({
        meetingUrl,
        displayName: meetForm.displayName.trim() || undefined,
        accountRef: meetForm.accountRef.trim() || undefined,
        provider: "openai-realtime",
        userStartConfirmed: true,
        browserTransportReady,
        audioTransportReady,
      });
      if (session.state === "blocked") {
        setNotice({
          tone: "warning",
          message: session.failureReason ?? "Google Meet voice prerequisites are still blocked.",
        });
        await reload();
        return;
      }
      const token = await createRealtimeVoiceClientSecret({
        surface: "google-meet",
        meetingSessionId: session.sessionId,
        instructionsProfile: "google-meet",
      });
      setNotice({
        tone: "success",
        message: `OpenAI Realtime voice prepared for ${session.displayName ?? session.meetingUrl} with ${token.model} / ${token.voice}.`,
      });
      await reload();
    } catch (meetError) {
      setNotice({ tone: "error", message: getErrorMessage(meetError) });
    } finally {
      audioProbe?.getTracks().forEach((track) => track.stop());
      setMeetBusySessionId(null);
    }
  };

  const handleStopGoogleMeetSession = async (session: GoogleMeetSessionRecord) => {
    setMeetBusySessionId(session.sessionId);
    try {
      const stopped = await stopGoogleMeetSession(session.sessionId);
      setNotice({ tone: "success", message: `Google Meet voice session ${stopped.sessionId} stopped.` });
      await reload();
    } catch (stopError) {
      setNotice({ tone: "error", message: getErrorMessage(stopError) });
    } finally {
      setMeetBusySessionId(null);
    }
  };

  const handleConsultGoogleMeetSession = async (session: GoogleMeetSessionRecord) => {
    setMeetBusySessionId(session.sessionId);
    try {
      const updated = await createGoogleMeetConsultHandoff(session.sessionId, { target: "chat" });
      setNotice({
        tone: "success",
        message: `Consult handoff ${updated.consultHandoff?.handoffId ?? "created"} is ready for Chat.`,
      });
      await reload();
    } catch (consultError) {
      setNotice({ tone: "error", message: getErrorMessage(consultError) });
    } finally {
      setMeetBusySessionId(null);
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="three-column">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsStack>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Create connection"
              subtitle="Create a new integration connection from the catalog."
            >
              <SettingsFieldGrid>
                <SettingsField label="Catalog">
                  <select
                    className="mc-next-settings-input"
                    value={createCatalogId}
                    onChange={(event) => setCreateCatalogId(event.target.value)}
                  >
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
                <ConfigFormBuilder schema={createSchema} value={createGuidedConfig} onChange={setCreateGuidedConfig} />
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
                <NativeButton variant="default" onClick={() => void handleCreate()}>
                  <Plus size={16} />
                  Create connection
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => setShowCreateJson((current) => !current)}>
                  <SlidersHorizontal size={16} />
                  {showCreateJson ? "Use guided fields" : "Advanced JSON"}
                </NativeButton>
              </SettingsButtonRow>
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Connected integrations"
              subtitle="Review live connections and jump into the selected one."
              scrollBody
              bodyMaxHeight="min(48vh, 28rem)"
              stats={[
                { label: "Connections", value: String(data.connections.length) },
                { label: "Catalog", value: String(data.catalog.length) },
                { label: "Plugins", value: String(data.plugins?.length ?? 0) },
              ]}
            >
              <NativeSelectableList
                items={data.connections.map((item) => ({
                  id: item.connectionId,
                  title: item.label,
                  meta: item.status,
                  body: `${item.key} · ${item.enabled ? "enabled" : "disabled"}`,
                }))}
                selectedId={selectedConnectionId}
                onSelect={(connectionId) => {
                  setSelectedConnectionId(connectionId);
                  setDiagnostics(null);
                  setLastOperatorActionResult(null);
                }}
                emptyLabel="No integration connections yet."
                maxHeight="min(36vh, 21rem)"
              />
            </NativeCard>
          </SettingsStack>
          <SettingsStack>
            <PluginTrustPanel plugins={data.plugins ?? []} />
            <DormantExternalConnectorsPanel
              services={data.externalConnectorServices ?? []}
              busyId={externalConnectorBusyId}
              onReviewService={(service, status) => void handleReviewExternalConnectorService(service, status)}
              onReviewAction={(action, status) => void handleReviewExternalConnectorAction(action, status)}
              onStageAction={(action) => void handleStageExternalConnectorAction(action)}
            />
            <ExternalSideEffectLedgerPanel
              runs={data.sideEffectRuns ?? []}
              summary={data.sideEffectSummary}
              selectedConnectionId={selectedConnection?.connectionId}
              busy={replayAuditBusy}
              onStartReplayAudit={(run) => void handleStartReplayAudit(run)}
              lastReplayAuditRunId={lastReplayAuditRunId}
              onOpenReplayAudit={(runId) => navigate({ area: "ops", section: "sessions", view: "run-detail", runId })}
            />
            <GoogleMeetStatusPanel
              status={data.meetStatus}
              sessions={data.meetSessions}
              form={meetForm}
              busySessionId={meetBusySessionId}
              onFormChange={setMeetForm}
              onStartOpenAIRealtime={() => void handleStartGoogleMeetRealtime()}
              onStopSession={(session) => void handleStopGoogleMeetSession(session)}
              onConsultSession={(session) => void handleConsultGoogleMeetSession(session)}
            />
          </SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title={selectedConnection?.label ?? "Integration catalog"}
            subtitle={
              selectedConnection
                ? "Update, diagnose, or remove the selected integration connection."
                : "Available connection definitions stay visible while you decide what to create next."
            }
            scrollBody
            bodyMaxHeight="min(72vh, 42rem)"
          >
            {selectedConnection ? (
              <>
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
                  <NativeButton variant="default" onClick={() => void handleSave()}>
                    <Save size={16} />
                    Save changes
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => void handleDiagnostics()}>
                    <RefreshCw size={16} />
                    Run diagnostics
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => setShowDetailJson((current) => !current)}>
                    <SlidersHorizontal size={16} />
                    {showDetailJson ? "Use guided fields" : "Advanced JSON"}
                  </NativeButton>
                  <NativeButton
                    variant="destructive"
                    onClick={() =>
                      setPendingDeleteConnection({
                        connectionId: selectedConnection.connectionId,
                        label: selectedConnection.label,
                      })
                    }
                  >
                    <Trash2 size={16} />
                    Delete
                  </NativeButton>
                </SettingsButtonRow>
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
                            <NativeButton variant="default" onClick={() => void handleOperatorAction(action)}>
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
                      message:
                        "This integration has no advertised operator action. Save changes and run diagnostics here; runtime use stays blocked until a catalog action exists.",
                    }}
                  />
                )}
                {lastOperatorActionResult ? <OperatorActionResultPanel result={lastOperatorActionResult} /> : null}
                {diagnostics ? <DiagnosticsPanel report={diagnostics} /> : null}
              </>
            ) : (
              <SettingsActionList
                items={data.catalog.map((item) => {
                  const reviewOnly = item.kind === "external_connector";
                  return {
                    id: item.catalogId,
                    label: item.label,
                    description: item.description,
                    meta: `${item.kind} · ${item.maturity} · ${item.capabilities.length} capabilities`,
                    actionLabel: reviewOnly ? "Review-only" : createCatalogId === item.catalogId ? "Selected" : "Use",
                    onClick: reviewOnly ? undefined : () => setCreateCatalogId(item.catalogId),
                  };
                })}
                emptyLabel="No integration catalog entries are available."
                maxHeight="min(58vh, 34rem)"
              />
            )}
          </NativeCard>
        </SettingsGrid>
      ) : null}
      <ConfirmModal
        open={pendingDeleteConnection !== null}
        danger
        pending={deletePending}
        title="Delete integration connection?"
        message={`Delete ${pendingDeleteConnection?.label ?? "this connection"}? Saved configuration will be permanently removed.`}
        confirmLabel="Delete connection"
        onCancel={() => setPendingDeleteConnection(null)}
        onConfirm={() => void handleDelete()}
      />
    </SettingsSectionShell>
  );
}

function isGoogleMeetBrowserTransportReady(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.RTCPeerConnection === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}
