// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { Play, Plus, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
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
  fetchSettings,
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
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
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
import { applyIntegrationDefaults, formatDateTime, formatJson, parseJsonObject } from "../../SettingsNativePage";
import { hasSessionDraft, discardSessionDraft, useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { DetailInspector } from "../../../../components/DetailInspector";
import { FocusedDetail } from "../../shared/FocusedDetail";

type IntegrationDetailDraft = {
  label: string;
  enabled: boolean;
  status: string;
  configText: string;
};

const EMPTY_INTEGRATION_DETAIL_DRAFT: IntegrationDetailDraft = {
  label: "",
  enabled: true,
  status: "connected",
  configText: "{}",
};

export function IntegrationsSection({ activeWorkspaceId, navigate }: SettingsSectionProps) {
  const [panel, setPanel] = useState<"create" | "edit" | "details" | "plugins" | "connectors" | "history" | "routing" | "meet" | null>(null);
  const [requested, setRequested] = useState({plugins:false,connectors:false,history:false,meet:false});
  const leave = useDraftLeave();
  const panelRef = useRef(panel); panelRef.current = panel;
  const mutationBusy = useRef(false);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    const [
      catalog,
      connections,
      plugins,
      meetStatus,
      meetSessions,
      sideEffectRuns,
      externalConnectors,
      runtimeSettings,
    ] = await Promise.all([
      nativeLoad("Integration catalog", fetchIntegrationCatalog(), { items: [] }),
      nativeLoad("Integration connections", fetchIntegrationConnections(), { items: [] }),
      nativeLoad("Integration plugins", requested.plugins ? fetchIntegrationPlugins() : Promise.resolve({items:[]}), { items: [] }),
      nativeLoad("Google Meet prerequisites", requested.meet ? fetchGoogleMeetPrerequisiteStatus() : Promise.resolve(null), null),
      nativeLoad("Google Meet sessions", requested.meet ? fetchGoogleMeetSessions(50) : Promise.resolve([]), []),
      nativeLoad(
        "External side-effect runs",
        requested.history ? fetchExternalSideEffectRuns({ workspaceId: activeWorkspaceId, limit: 25 }) : Promise.resolve({items:[], summary: undefined}),
        {
          items: [],
        },
      ),
      nativeLoad(
        "Dormant external connector catalog",
        requested.connectors ? fetchExternalConnectorServices({ workspaceId: activeWorkspaceId, includeActions: true, limit: 50 }) : Promise.resolve({items:[]}),
        { items: [] },
      ),
      nativeLoad("Runtime settings", fetchSettings(), null),
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
        runtimeSettings,
      ]),
      catalog: (catalog.data.items ?? []).filter((item) => item.kind !== "channel"),
      connections: (connections.data.items ?? []).filter((item) => item.kind !== "channel"),
      channelConnections: (connections.data.items ?? []).filter((item) => item.kind === "channel"),
      plugins: plugins.data.items,
      meetStatus: meetStatus.data,
      meetSessions: Array.isArray(meetSessions.data) ? meetSessions.data : [],
      sideEffectRuns: sideEffectRuns.data.items,
      sideEffectSummary: sideEffectRuns.data.summary,
      externalConnectorServices: externalConnectors.data.items,
      connectorDiagnosticsEnabled: runtimeSettings.data?.features?.connectorDiagnosticsV1Enabled === true,
    };
  }, [activeWorkspaceId, requested]);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useSessionViewState("integrations:" + activeWorkspaceId + ":selection", "");
  const selectionRef = useRef(selectedConnectionId); selectionRef.current = selectedConnectionId;
  const [createCatalogId, setCreateCatalogId] = useSessionViewState("integrations:" + activeWorkspaceId + ":catalog", "");
  const [createSchema, setCreateSchema] = useState<IntegrationFormSchema | undefined>();
  const [detailSchema, setDetailSchema] = useState<IntegrationFormSchema | undefined>();
  const [showCreateJson, setShowCreateJson] = useSessionViewState("integration:" + activeWorkspaceId + ":" + createCatalogId + ":new-json", false);
  const [showDetailJson, setShowDetailJson] = useSessionViewState("integration:" + activeWorkspaceId + ":" + selectedConnectionId + ":edit-json", false);
  const [diagnostics, setDiagnostics] = useState<ConnectorDiagnosticReport | null>(null);
  const [pendingDeleteConnection, setPendingDeleteConnection] = useState<{
    connectionId: string;
    label: string;
  } | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [replayAuditBusy, setReplayAuditBusy] = useState(false);
  const operatorBusy = useRef(new Set<string>());
  const [operatorBusyId,setOperatorBusyId] = useState<string | null>(null);
  const [lastReplayAuditRunId, setLastReplayAuditRunId] = useState<string | null>(null);
  const [externalConnectorBusyId, setExternalConnectorBusyId] = useState<string | null>(null);
  const [meetBusySessionId, setMeetBusySessionId] = useState<string | null>(null);
  const [lastOperatorActionResult, setLastOperatorActionResult] = useState<
    (IntegrationActionInvokeResult & { actionLabel: string }) | null
  >(null);
  const createableCatalog = useMemo(
    () => data?.catalog.filter((item) => item.kind !== "external_connector") ?? [],
    [data?.catalog],
  );
  const selectedConnection =
    data?.connections.find((item) => item.connectionId === selectedConnectionId) ?? null;
  const selectedCatalog = data?.catalog.find(item => item.catalogId === (panel === "create" ? createCatalogId : selectedConnection?.catalogId)) ?? null;
  const createCanonical = {label:"",configText:"{}",guidedConfig:createSchema ? applyIntegrationDefaults(createSchema,{}) : {} as Record<string,unknown>};
  const createDraft = useSessionDraft("integration:" + activeWorkspaceId + ":" + createCatalogId + ":new", createCanonical, undefined, { label:"New integration",active:panel === "create",onSave:()=>handleCreate() });
  const detailCanonical = {form:selectedConnection ? {label:selectedConnection.label,enabled:selectedConnection.enabled,status:selectedConnection.status,configText:formatJson(selectedConnection.config)} : EMPTY_INTEGRATION_DETAIL_DRAFT,guidedConfig:selectedConnection?.config ?? {}};
  const detailDraft = useSessionDraft("integration:" + activeWorkspaceId + ":" + selectedConnectionId + ":edit",detailCanonical,selectedConnection?.updatedAt ?? (selectedConnection ? JSON.stringify(selectedConnection) : undefined),{label:selectedConnection?.label ?? "Integration",active:panel === "edit",available:Boolean(selectedConnection),onSave:()=>handleSave()});
  const {label:createLabel,configText:createConfig,guidedConfig:createGuidedConfig} = createDraft.value;
  const {form:detailForm,guidedConfig:detailGuidedConfig} = detailDraft.value;
  const setCreateLabel = (label:string) => createDraft.setValue(current=>({...current,label}));
  const setCreateConfig = (configText:string) => createDraft.setValue(current=>({...current,configText}));
  const setCreateGuidedConfig = (guidedConfig:Record<string,unknown>) => createDraft.setValue(current=>({...current,guidedConfig}));
  const setDetailForm = (update:SetStateAction<IntegrationDetailDraft>) => detailDraft.setValue(current=>({...current,form:typeof update === "function" ? update(current.form) : update}));
  const setDetailGuidedConfig = (guidedConfig:Record<string,unknown>) => detailDraft.setValue(current=>({...current,guidedConfig}));
  const actionDraft = useSessionDraft("integration:" + activeWorkspaceId + ":" + selectedConnectionId + ":actions",{inputs:{} as Record<string,Record<string,unknown>>,keys:{} as Record<string,string>},undefined,{label:"Integration action inputs",active:panel === "details"});
  const {inputs:operatorActionInputs,keys:operatorActionIdempotencyKeys} = actionDraft.value;
  const setOperatorActionInputs = (update:SetStateAction<Record<string,Record<string,unknown>>>) => actionDraft.setValue(current=>({...current,inputs:typeof update === "function" ? update(current.inputs) : update}));
  const setOperatorActionIdempotencyKeys = (update:SetStateAction<Record<string,string>>) => actionDraft.setValue(current=>({...current,keys:typeof update === "function" ? update(current.keys) : update}));
  const meetDraft = useSessionDraft("integration:" + activeWorkspaceId + ":google-meet:new",{meetingUrl:"",displayName:"",accountRef:""},undefined,{label:"Google Meet setup",active:panel === "meet"});
  const {value:meetForm,setValue:setMeetForm} = meetDraft;
  const openPanel = (next: typeof panel) => leave.request(()=>{setPanel(next);if(next === "plugins" || next === "connectors" || next === "history" || next === "meet")setRequested(current=>({...current,[next]:true}));});
  const closePanel = () => openPanel(null);
  const connectionSelectionGuard = {requestTransition:(id:string)=>leave.request(()=>{setSelectedConnectionId(id);setDiagnostics(null);setLastOperatorActionResult(null);setPanel("details");})};
  const createCatalogGuard = {requestTransition:(id:string)=>leave.request(()=>{setCreateCatalogId(id);setCreateSchema(undefined);setPanel("create");},[createDraft.key])};
  const toggleCreateJson = () => { try { if (showCreateJson) setCreateGuidedConfig(parseJsonObject(createConfig)); else setCreateConfig(formatJson(createGuidedConfig)); setShowCreateJson(!showCreateJson); } catch(cause) {setNotice({tone:"error",message:getErrorMessage(cause)});} };
  const toggleDetailJson = () => { try { if (showDetailJson) setDetailGuidedConfig(parseJsonObject(detailForm.configText)); else setDetailForm(current=>({...current,configText:formatJson(detailGuidedConfig)}));setShowDetailJson(!showDetailJson); } catch(cause) {setNotice({tone:"error",message:getErrorMessage(cause)});} };
  useEffect(()=>{setPanel(null);setDiagnostics(null);setLastOperatorActionResult(null);},[activeWorkspaceId]);
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
  }, [createableCatalog, setCreateCatalogId]);

  useEffect(() => {
    if (!createCatalogId || panel !== "create") {
      setCreateSchema(undefined);
      return;
    }
    let cancelled = false;
    void fetchIntegrationFormSchema(createCatalogId)
      .then((schema) => {
        if (!cancelled) {
          setCreateSchema(schema);
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
  }, [createCatalogId, panel]);

  useEffect(() => {
    if (!selectedConnection?.catalogId || panel !== "edit") {
      setDetailSchema(undefined);
      return;
    }
    let cancelled = false;
    void fetchIntegrationFormSchema(selectedConnection.catalogId)
      .then((schema) => {
        if (!cancelled) {
          setDetailSchema(schema);
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
  }, [selectedConnection?.catalogId, panel]);

  const handleCreate = async (): Promise<boolean> => {
    if (mutationBusy.current) return false;
    if (!createCatalogId) {setNotice({tone:"warning",message:"Choose an integration catalog entry first."});return false;}
    const submitted = createDraft.value;
    mutationBusy.current = true; setSaving(true);
    try {
      const created = await createIntegrationConnection({catalogId:createCatalogId,label:submitted.label.trim() || undefined,enabled:true,config:showCreateJson ? parseJsonObject(submitted.configText) : (createSchema ? applyIntegrationDefaults(createSchema,submitted.guidedConfig) : submitted.guidedConfig)});
      const saved = createDraft.acceptSaved(createCanonical,undefined,submitted);
      setNotice({tone:"success",message:"Connection " + created.label + " created."});await reload();
      if(saved && panelRef.current === "create") {setSelectedConnectionId(created.connectionId);setPanel("details");}
      return saved;
    } catch(cause) {setNotice({tone:"error",message:getErrorMessage(cause)});return false;}
    finally {mutationBusy.current=false;setSaving(false);}
  };
  const handleSave = async (): Promise<boolean> => {
    if (mutationBusy.current || !selectedConnection || detailDraft.hasRemoteChanges) return false;
    const submitted=detailDraft.value;
    mutationBusy.current=true;setSaving(true);
    try {
      const updated=await updateIntegrationConnection(selectedConnection.connectionId,{label:submitted.form.label.trim() || undefined,enabled:submitted.form.enabled,status:submitted.form.status as IntegrationConnection["status"],config:showDetailJson ? parseJsonObject(submitted.form.configText,selectedConnection.config) : submitted.guidedConfig});
      const saved=detailDraft.acceptSaved({form:{label:updated.label,enabled:updated.enabled,status:updated.status,configText:formatJson(updated.config)},guidedConfig:updated.config},updated.updatedAt ?? JSON.stringify(updated),submitted);
      setNotice({tone:"success",message:"Connection updated."});await reload();return saved;
    } catch(cause) {setNotice({tone:"error",message:getErrorMessage(cause)});return false;}
    finally {mutationBusy.current=false;setSaving(false);}
  };

  const handleDelete = async () => {
    if (!pendingDeleteConnection) {
      return;
    }
    setDeletePending(true);
    try {
      await deleteIntegrationConnection(pendingDeleteConnection.connectionId);
      discardSessionDraft("integration:" + activeWorkspaceId + ":" + pendingDeleteConnection.connectionId + ":edit");
      discardSessionDraft("integration:" + activeWorkspaceId + ":" + pendingDeleteConnection.connectionId + ":actions");
      setPanel(null);
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
    if (!data?.connectorDiagnosticsEnabled) {
      setNotice({
        tone: "warning",
        message: "Connector diagnostics are not enabled in Runtime settings.",
      });
      return;
    }
    try {
      const result = await fetchIntegrationConnectionDiagnostics(selectedConnection.connectionId);
      if(selectedConnection.connectionId !== selectionRef.current) return;
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
    const actionKey = selectedConnection.connectionId + ":" + action.actionId;
    if (operatorBusy.current.has(actionKey)) return;
    operatorBusy.current.add(actionKey); setOperatorBusyId(actionKey);
    const input = action.formSchema
      ? applyIntegrationDefaults(action.formSchema, operatorActionInputs[action.actionId] ?? {})
      : undefined;
    const idempotencyKey = operatorActionIdempotencyKeys[action.actionId]?.trim();
    try {
      const result = await invokeIntegrationConnectionAction(selectedConnection.connectionId, action.actionId, {
        ...(input ? { input } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      if(selectedConnection.connectionId === selectionRef.current) setLastOperatorActionResult({ ...result, actionLabel: action.label });
      setNotice({
        tone: result.status === "failed" ? "error" : result.status === "blocked" ? "warning" : "success",
        message: result.message,
      });
      await reload();
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    } finally {operatorBusy.current.delete(actionKey);setOperatorBusyId(null);}
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
      meetDraft.acceptSaved(meetForm,undefined,meetForm);
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
      {data ? <SettingsStack>
        <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
        {panel === "create" ? <FocusedDetail title="Add integration" onClose={closePanel}><SettingsStack>
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
                <NativeButton variant="default" disabled={saving || !createCatalogId} onClick={() => void handleCreate()}>
                  <Plus size={16} />
                  Create connection
                </NativeButton>
                <NativeButton variant="secondary" onClick={toggleCreateJson}>
                  <SlidersHorizontal size={16} />
                  {showCreateJson ? "Use guided fields" : "Advanced JSON"}
                </NativeButton>
              </SettingsButtonRow>
            <NativeDisclosureCard id="integration-catalog" title="Catalog details"><SettingsActionList
                ariaLabel="Integration catalog entries"
                items={data.catalog.map((item) => {
                  const reviewOnly = item.kind === "external_connector";
                  return {
                    id: item.catalogId,
                    label: item.label,
                    description: item.description,
                    meta: `${item.kind} · ${item.maturity} · ${item.capabilities.length} capabilities`,
                    actionLabel: reviewOnly ? "Review-only" : createCatalogId === item.catalogId ? "Selected" : "Use",
                    onClick: reviewOnly ? undefined : () => createCatalogGuard.requestTransition(item.catalogId),
                  };
                })}
                emptyLabel="No integration catalog entries are available."
                maxHeight="min(58vh, 34rem)"
              /></NativeDisclosureCard></SettingsStack></FocusedDetail> : panel === "edit" ? <FocusedDetail title={"Edit " + (selectedConnection?.label ?? "connection")} onClose={closePanel}><SettingsStack>
          {detailDraft.hasRemoteChanges ? <NativeCard title="Connection changed" subtitle="Review the current saved values before retrying."><p>{selectedConnection?.label} · {selectedConnection?.status} · Updated {formatDateTime(selectedConnection?.updatedAt)}</p><NativeDisclosureCard id="integration-current-config" title="Current configuration"><fieldset disabled><ConfigFormBuilder schema={detailSchema} value={selectedConnection?.config ?? {}} onChange={() => {}} /></fieldset></NativeDisclosureCard><NativeButton onClick={detailDraft.rebaseToCurrent}>Apply draft to current connection</NativeButton></NativeCard> : null}
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
                </SettingsFieldGrid>{showDetailJson ? (
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
                )}<SettingsButtonRow><NativeButton disabled={saving || detailDraft.hasRemoteChanges || !selectedConnection} onClick={() => void handleSave()}>Save changes</NativeButton><NativeButton variant="secondary" onClick={toggleDetailJson}>{showDetailJson ? "Use guided fields" : "Advanced JSON"}</NativeButton><NativeButton variant="secondary" onClick={closePanel}>Close editor</NativeButton></SettingsButtonRow>
        </SettingsStack></FocusedDetail> : <>
          <SettingsButtonRow><NativeButton onClick={() => openPanel("create")}><Plus size={16} />Add integration{hasSessionDraft("integration:" + activeWorkspaceId + ":" + createCatalogId + ":new") ? " · Unsaved" : ""}</NativeButton><NativeButton variant="secondary" onClick={() => void reload()}>Refresh</NativeButton></SettingsButtonRow>
          <NativeCard title="Connected integrations" subtitle="" stats={[{label:"Connections",value:data.issues.some(issue=>issue.label === "Integration connections") ? "Unavailable" : String(data.connections.length)},{label:"Catalog",value:data.issues.some(issue=>issue.label === "Integration catalog") ? "Unavailable" : String(data.catalog.length)},{label:"Plugins",value:!requested.plugins ? "Not loaded" : data.issues.some(issue=>issue.label === "Integration plugins") ? "Unavailable" : (Array.isArray(data.plugins) ? String(data.plugins.length) : "Unavailable")}]}>
              <NativeSelectableList
                items={data.connections.map((item) => ({
                  id: item.connectionId,
                  title: item.label,
                  meta: item.status + (hasSessionDraft("integration:" + activeWorkspaceId + ":" + item.connectionId + ":edit") ? " · Unsaved" : ""),
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
          <NativeDisclosureCard id="integration-support" title="More integration tools"><SettingsButtonRow><NativeButton variant="secondary" onClick={() => openPanel("meet")}>Google Meet{meetDraft.isDirty ? " · Unsaved" : ""}</NativeButton><NativeButton variant="secondary" onClick={() => openPanel("history")}>Delivery history</NativeButton><NativeButton variant="secondary" onClick={() => openPanel("routing")}>Notification routing</NativeButton><NativeButton variant="secondary" onClick={() => openPanel("connectors")}>Review external connectors</NativeButton><NativeButton variant="secondary" onClick={() => openPanel("plugins")}>Plugin trust</NativeButton></SettingsButtonRow></NativeDisclosureCard>
        </>}
        <DetailInspector open={panel === "details"} title={selectedConnection?.label ?? "Connection unavailable"} onClose={closePanel}>
          <SettingsStack>
            {selectedConnection ? (
              <>
                <p>{selectedConnection.status} · {selectedConnection.enabled ? "Enabled" : "Disabled"}</p>
                <dl><dt>Scope</dt><dd>{(selectedConnection as IntegrationConnection & {workspaceId?:string}).workspaceId ?? "Unbound · Personal Citadel policy"}</dd><dt>Connection ID</dt><dd>{selectedConnection.connectionId}</dd><dt>Updated</dt><dd>{formatDateTime(selectedConnection.updatedAt)}</dd></dl>


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
                  <NativeButton onClick={() => openPanel("edit")}>Edit connection{detailDraft.isDirty ? " · Unsaved" : ""}</NativeButton>
                  <NativeButton
                    variant="secondary"
                    disabled={!data.connectorDiagnosticsEnabled}
                    onClick={() => void handleDiagnostics()}
                  >
                    <RefreshCw size={16} />
                    Run diagnostics
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
                {!data.connectorDiagnosticsEnabled ? (
                  <p className="mc-next-settings-field-note">
                    Connector diagnostics are not enabled in Runtime settings.
                  </p>
                ) : null}
                <NativeDisclosureCard id="integration-actions" title="Actions">{selectedCatalog?.operatorActions?.length ? (
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
                            <NativeButton variant="default" disabled={operatorBusyId === selectedConnection.connectionId + ":" + action.actionId} onClick={() => void handleOperatorAction(action)}>
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
                )}</NativeDisclosureCard>
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
        <DetailInspector open={panel === "plugins" || panel === "connectors" || panel === "history" || panel === "routing" || panel === "meet"} title={panel === "plugins" ? "Plugin trust" : panel === "connectors" ? "External connectors" : panel === "history" ? "Delivery history" : panel === "routing" ? "Notification routing" : "Google Meet"} onClose={closePanel}>
          {panel === "plugins" ? (<PluginTrustPanel plugins={data.plugins ?? []} />) : panel === "connectors" ? (<DormantExternalConnectorsPanel
              services={data.externalConnectorServices ?? []}
              busyId={externalConnectorBusyId}
              onReviewService={(service, status) => void handleReviewExternalConnectorService(service, status)}
              onReviewAction={(action, status) => void handleReviewExternalConnectorAction(action, status)}
              onStageAction={(action) => void handleStageExternalConnectorAction(action)}
            />) : panel === "history" ? (<ExternalSideEffectLedgerPanel
              runs={data.sideEffectRuns ?? []}
              summary={data.sideEffectSummary}
              selectedConnectionId={selectedConnection?.connectionId}
              busy={replayAuditBusy}
              onStartReplayAudit={(run) => void handleStartReplayAudit(run)}
              lastReplayAuditRunId={lastReplayAuditRunId}
              onOpenReplayAudit={(runId) => navigate({ area: "ops", section: "sessions", view: "run-detail", runId })}
            />) : panel === "routing" ? (<NotificationRoutingPanel workspaceId={activeWorkspaceId} channels={data.channelConnections} />) : panel === "meet" ? (<GoogleMeetStatusPanel
              status={data.meetStatus}
              sessions={data.meetSessions}
              form={meetForm}
              busySessionId={meetBusySessionId}
              onFormChange={setMeetForm}
              onStartOpenAIRealtime={() => void handleStartGoogleMeetRealtime()}
              onStopSession={(session) => void handleStopGoogleMeetSession(session)}
              onConsultSession={(session) => void handleConsultGoogleMeetSession(session)}
            />) : null}
        </DetailInspector>
      </SettingsStack> : null}
      {leave.dialog}
      <ConfirmModal
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

function isGoogleMeetBrowserTransportReady(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.RTCPeerConnection === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}
