import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type {
  ConnectorDiagnosticReport,
  IntegrationActionInvokeResult,
  IntegrationFormSchema,
} from "@goatcitadel/contracts";
import { fetchIntegrationFormSchema, type IntegrationConnection } from "@goatcitadel/mission-control-shared/api/client";
import { readIntegrationSettingsSnapshot } from "./integration-settings-snapshot";
import { getErrorMessage, useAsyncLoad, type Notice } from "../SettingsShared";
import { applyIntegrationDefaults } from "../helpers/channel-helpers";
import { formatJson, parseJsonObject } from "../helpers/input-format";
import { useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { useIntegrationConnectionReview } from "./useIntegrationConnectionReview";
import { useIntegrationConnectionMutation } from "../integration-connection-mutation";
export type IntegrationDetailDraft = {
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

export function useIntegrationSettingsState(activeWorkspaceId: string) {
  const saveActions = useRef({
    create: async (): Promise<boolean> => false,
    save: async (): Promise<boolean> => false,
  });
  const [panel, setPanel] = useState<
    "create" | "edit" | "details" | "plugins" | "connectors" | "history" | "routing" | "meet" | null
  >(null);
  const [requested, setRequested] = useState({ plugins: false, connectors: false, history: false, meet: false });
  const leave = useDraftLeave();
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const mutationBusy = useRef(false);
  const [saving, setSaving] = useState(false);
  const load = useCallback(
    () => readIntegrationSettingsSnapshot(activeWorkspaceId, requested),
    [activeWorkspaceId, requested],
  );
  const { loading, error, data, reload, updateData } = useAsyncLoad(load, [load]);
  const applyConnection = useCallback(
    (connectionId: string, connection: IntegrationConnection | null) => {
      updateData((current) => ({
        ...current,
        connections: connection
          ? current.connections.some((item) => item.connectionId === connectionId)
            ? current.connections.map((item) => (item.connectionId === connectionId ? connection : item))
            : [...current.connections, connection]
          : current.connections.filter((item) => item.connectionId !== connectionId),
      }));
    },
    [updateData],
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useSessionViewState(
    "integrations:" + activeWorkspaceId + ":selection",
    "",
  );
  const selectionRef = useRef(selectedConnectionId);
  selectionRef.current = selectedConnectionId;
  const review = useIntegrationConnectionReview(activeWorkspaceId, selectedConnectionId, applyConnection);
  const connectionMutation = useIntegrationConnectionMutation(selectedConnectionId);
  const [createCatalogId, setCreateCatalogId] = useSessionViewState(
    "integrations:" + activeWorkspaceId + ":catalog",
    "",
  );
  const [createSchema, setCreateSchema] = useState<IntegrationFormSchema | undefined>();
  const [detailSchema, setDetailSchema] = useState<IntegrationFormSchema | undefined>();
  const [showCreateJson, setShowCreateJson] = useSessionViewState(
    "integration:" + activeWorkspaceId + ":" + createCatalogId + ":new-json",
    false,
  );
  const [showDetailJson, setShowDetailJson] = useSessionViewState(
    "integration:" + activeWorkspaceId + ":" + selectedConnectionId + ":edit-json",
    false,
  );
  const [diagnostics, setDiagnostics] = useState<ConnectorDiagnosticReport | null>(null);
  const [pendingDeleteConnection, setPendingDeleteConnection] = useState<{
    connectionId: string;
    label: string;
    revision: string;
  } | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [replayAuditBusy, setReplayAuditBusy] = useState(false);
  const operatorBusy = useRef(new Set<string>());
  const [operatorBusyId, setOperatorBusyId] = useState<string | null>(null);
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
  const selectedConnection = data?.connections.find((item) => item.connectionId === selectedConnectionId) ?? null;
  const selectedCatalog =
    data?.catalog.find(
      (item) => item.catalogId === (panel === "create" ? createCatalogId : selectedConnection?.catalogId),
    ) ?? null;
  const view = useRef({ activeWorkspaceId, panel, selectedConnectionId, createCatalogId });
  if (
    view.current.activeWorkspaceId !== activeWorkspaceId ||
    view.current.panel !== panel ||
    view.current.selectedConnectionId !== selectedConnectionId ||
    view.current.createCatalogId !== createCatalogId
  )
    view.current = { activeWorkspaceId, panel, selectedConnectionId, createCatalogId };
  const currentView = view.current;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = () => mounted.current && view.current === currentView;
  const createMutation = useIntegrationConnectionMutation(`integration-create:${createCatalogId}`);
  const createCanonical = {
    label: "",
    configText: "{}",
    guidedConfig: createSchema ? applyIntegrationDefaults(createSchema, {}) : ({} as Record<string, unknown>),
  };
  const createDraft = useSessionDraft(
    "integration:" + activeWorkspaceId + ":" + createCatalogId + ":new",
    createCanonical,
    undefined,
    { label: "New integration", active: panel === "create", onSave: () => saveActions.current.create() },
  );
  const createKeyRef = useRef(createDraft.key);
  createKeyRef.current = createDraft.key;
  const detailCanonical = {
    form: selectedConnection
      ? {
          label: selectedConnection.label,
          enabled: selectedConnection.enabled,
          status: selectedConnection.status,
          configText: formatJson(selectedConnection.config),
        }
      : EMPTY_INTEGRATION_DETAIL_DRAFT,
    guidedConfig: selectedConnection?.config ?? {},
  };
  const detailDraft = useSessionDraft(
    "integration:" + activeWorkspaceId + ":" + selectedConnectionId + ":edit",
    detailCanonical,
    selectedConnection?.revision,
    {
      label: selectedConnection?.label ?? "Integration",
      active: panel === "edit",
      available: Boolean(selectedConnection),
      onSave: () => saveActions.current.save(),
    },
  );
  const { label: createLabel, configText: createConfig, guidedConfig: createGuidedConfig } = createDraft.value;
  const { form: detailForm, guidedConfig: detailGuidedConfig } = detailDraft.value;
  const setCreateLabel = (label: string) => createDraft.setValue((current) => ({ ...current, label }));
  const setCreateConfig = (configText: string) => createDraft.setValue((current) => ({ ...current, configText }));
  const setCreateGuidedConfig = (guidedConfig: Record<string, unknown>) =>
    createDraft.setValue((current) => ({ ...current, guidedConfig }));
  const setDetailForm = (update: SetStateAction<IntegrationDetailDraft>) =>
    detailDraft.setValue((current) => ({
      ...current,
      form: typeof update === "function" ? update(current.form) : update,
    }));
  const setDetailGuidedConfig = (guidedConfig: Record<string, unknown>) =>
    detailDraft.setValue((current) => ({ ...current, guidedConfig }));
  const actionDraft = useSessionDraft(
    "integration:" + activeWorkspaceId + ":" + selectedConnectionId + ":actions",
    { inputs: {} as Record<string, Record<string, unknown>>, keys: {} as Record<string, string> },
    undefined,
    { label: "Integration action inputs", active: panel === "details" },
  );
  const { inputs: operatorActionInputs, keys: operatorActionIdempotencyKeys } = actionDraft.value;
  const setOperatorActionInputs = (update: SetStateAction<Record<string, Record<string, unknown>>>) =>
    actionDraft.setValue((current) => ({
      ...current,
      inputs: typeof update === "function" ? update(current.inputs) : update,
    }));
  const setOperatorActionIdempotencyKeys = (update: SetStateAction<Record<string, string>>) =>
    actionDraft.setValue((current) => ({
      ...current,
      keys: typeof update === "function" ? update(current.keys) : update,
    }));
  const meetDraft = useSessionDraft(
    "integration:" + activeWorkspaceId + ":google-meet:new",
    { meetingUrl: "", displayName: "", accountRef: "" },
    undefined,
    { label: "Google Meet setup", active: panel === "meet" },
  );
  const { value: meetForm, setValue: setMeetForm } = meetDraft;
  const openPanel = (next: typeof panel) =>
    leave.request(() => {
      setPanel(next);
      if (next === "plugins" || next === "connectors" || next === "history" || next === "meet")
        setRequested((current) => ({ ...current, [next]: true }));
    });
  const closePanel = () => openPanel(null);
  const connectionSelectionGuard = {
    requestTransition: (id: string) =>
      leave.request(() => {
        setSelectedConnectionId(id);
        setDiagnostics(null);
        setLastOperatorActionResult(null);
        setPanel("details");
      }),
  };
  const createCatalogGuard = {
    requestTransition: (id: string) =>
      leave.request(() => {
        setCreateCatalogId(id);
        setCreateSchema(undefined);
        setPanel("create");
      }, [createDraft.key]),
  };
  const toggleCreateJson = () => {
    try {
      if (showCreateJson) setCreateGuidedConfig(parseJsonObject(createConfig));
      else setCreateConfig(formatJson(createGuidedConfig));
      setShowCreateJson(!showCreateJson);
    } catch (cause) {
      setNotice({ tone: "error", message: getErrorMessage(cause) });
    }
  };
  const toggleDetailJson = () => {
    try {
      if (showDetailJson) setDetailGuidedConfig(parseJsonObject(detailForm.configText));
      else setDetailForm((current) => ({ ...current, configText: formatJson(detailGuidedConfig) }));
      setShowDetailJson(!showDetailJson);
    } catch (cause) {
      setNotice({ tone: "error", message: getErrorMessage(cause) });
    }
  };
  useEffect(() => {
    setPanel(null);
    setDiagnostics(null);
    setLastOperatorActionResult(null);
    setPendingDeleteConnection(null);
    setNotice(null);
  }, [activeWorkspaceId]);
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

  return {
    isCurrent,
    createMutation,
    activeWorkspaceId,
    panel,
    setPanel,
    requested,
    setRequested,
    leave,
    panelRef,
    mutationBusy,
    saving,
    setSaving,
    loading,
    error,
    data,
    reload,
    updateData,
    applyConnection,
    notice,
    setNotice,
    selectedConnectionId,
    setSelectedConnectionId,
    selectionRef,
    review,
    connectionMutation,
    createCatalogId,
    setCreateCatalogId,
    createSchema,
    detailSchema,
    showCreateJson,
    showDetailJson,
    diagnostics,
    setDiagnostics,
    pendingDeleteConnection,
    setPendingDeleteConnection,
    deletePending,
    setDeletePending,
    replayAuditBusy,
    setReplayAuditBusy,
    operatorBusy,
    operatorBusyId,
    setOperatorBusyId,
    lastReplayAuditRunId,
    setLastReplayAuditRunId,
    externalConnectorBusyId,
    setExternalConnectorBusyId,
    meetBusySessionId,
    setMeetBusySessionId,
    lastOperatorActionResult,
    setLastOperatorActionResult,
    createableCatalog,
    selectedConnection,
    selectedCatalog,
    createCanonical,
    createDraft,
    createKeyRef,
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
    actionDraft,
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
    saveActions,
  };
}
export type IntegrationSettingsState = ReturnType<typeof useIntegrationSettingsState>;
