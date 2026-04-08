/* eslint-disable @typescript-eslint/no-unused-vars, max-lines, react-hooks/exhaustive-deps */
import { useEffect, useMemo, useRef, useState } from "react";
import "../styles/integrations.css";
import {
  approveDiscordPairing,
  commsReact,
  commsSend,
  commsUnsend,
  createIntegrationConnection,
  disableIntegrationPlugin,
  deleteIntegrationConnection,
  enableIntegrationPlugin,
  evaluateUiChangeRisk,
  fetchChannelRuntimeStatus,
  fetchChannelSetupDefinitions,
  fetchIntegrationCatalog,
  fetchIntegrationConnections,
  fetchDiscordPairings,
  fetchConnectorRecords,
  fetchSettings,
  fetchIntegrationFormSchema,
  fetchIntegrationPlugins,
  fetchObsidianIntegrationStatus,
  installIntegrationPlugin,
  patchObsidianIntegrationConfig,
  fetchIntegrationConnectionDiagnostics,
  reconnectDiscordRuntime,
  revokeDiscordPairing,
  searchObsidianNotes,
  testObsidianIntegration,
  uploadChatAttachment,
  captureObsidianInboxEntry,
  updateIntegrationConnection,
  type IntegrationCatalogEntry,
  type IntegrationConnection,
  type ObsidianIntegrationStatus,
} from "../api/client";
import type {
  ChannelAttachmentInput,
  ChatAttachmentRecord,
  ChannelRuntimeStatus,
  ConnectorRecord,
  DiscordPairingRecord,
  DiscordRuntimeStatus,
} from "@goatcitadel/contracts";
import { ChangeReviewPanel } from "../components/ChangeReviewPanel";
import { DataToolbar } from "../components/DataToolbar";
import { FieldHelp } from "../components/FieldHelp";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { SelectOrCustom } from "../components/SelectOrCustom";
import { ConfigFormBuilder } from "../components/ConfigFormBuilder";
import { ConfirmModal } from "../components/ConfirmModal";
import { CardSkeleton } from "../components/CardSkeleton";
import { HelpHint } from "../components/HelpHint";
import { StatusChip } from "../components/StatusChip";
import { GCSelect, GCSwitch } from "../components/ui";
import { useAction } from "../hooks/useAction";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { pageCopy } from "../content/copy";
import {
  type ChannelSetupPath,
  type UiRiskItem,
  type UiRiskLevel,
  connectorSetupReady,
  connectorSupportsDeliveryAction,
  dedupeUploadedAttachments,
  deriveOverallRisk,
  describeChannelSetupPath,
  describeMaturity,
  evaluateLocalRisk,
  extractUrlCandidates,
  formatChannelSetupPath,
  formatConnectorList,
  formatKind,
  formatMaturity,
  formatRuntimeAvailability,
  formatStatus,
  getChannelSetupPathTone,
  getConnectorMetadataStringList,
  getConnectorRuntimePostureSummary,
  getConnectorSetupDiagnostics,
  getConnectorSupportNotes,
  getConnectorSupportedAttachmentSources,
  getConnectorSupportedDeliveryActions,
  guessDefaultChannelTarget,
  isDiscordGatewayConnection,
  maxRisk,
  mergeRiskItems,
  parseAttachmentIdInputs,
  parseAttachmentUrlInputs,
  renderConnectorApprovalDeliverySummary,
  requiresExplicitChannelTarget,
  resolveChannelSetupPath,
  sanitizeGuidedConfig,
} from "./integrations-page-utils";
import { IntegrationsCatalogPicker } from "./integrations/IntegrationsCatalogPicker";
import { IntegrationsChannelTestBench } from "./integrations/IntegrationsChannelTestBench";
import { IntegrationsConnectionsTable } from "./integrations/IntegrationsConnectionsTable";
import { IntegrationsCreateConnectionPanel } from "./integrations/IntegrationsCreateConnectionPanel";
import { IntegrationsObsidianPanel } from "./integrations/IntegrationsObsidianPanel";
import { IntegrationsPluginsPanel } from "./integrations/IntegrationsPluginsPanel";

import {
  INTEGRATIONS_UPLOAD_SESSION_ID,
  isAbortError,
  KIND_DESCRIPTIONS,
  KIND_OPTIONS,
  STATUS_OPTIONS,
  type IntegrationKind,
} from "./integrations/integrations-page-constants";

interface IntegrationsPageProps {
  view?: "overview" | "channels";
}

export function IntegrationsPage({ view = "overview" }: IntegrationsPageProps) {
  const isChannelsView = view === "channels";
  const [catalog, setCatalog] = useState<IntegrationCatalogEntry[]>([]);
  const [guidedChannelCatalogIdList, setGuidedChannelCatalogIdList] = useState<string[]>([]);
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [connectorRecords, setConnectorRecords] = useState<ConnectorRecord[]>([]);
  const [plugins, setPlugins] = useState<Awaited<ReturnType<typeof fetchIntegrationPlugins>>["items"]>([]);
  const [pluginSource, setPluginSource] = useState("");
  const [pluginBusyId, setPluginBusyId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<IntegrationKind>(() => (isChannelsView ? "channel" : "all"));
  const [connectionSearch, setConnectionSearch] = useState("");
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const [label, setLabel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<IntegrationConnection["status"]>("connected");
  const [showAdvancedJson, setShowAdvancedJson] = useState(false);
  const [configJson, setConfigJson] = useState("{}");
  const [guidedConfig, setGuidedConfig] = useState<Record<string, unknown>>({});
  const [formSchema, setFormSchema] = useState<IntegrationCatalogEntry["formSchema"]>();
  const [isFormSchemaLoading, setIsFormSchemaLoading] = useState(false);
  const [obsidianStatus, setObsidianStatus] = useState<ObsidianIntegrationStatus | null>(null);
  const [obsidianEnabled, setObsidianEnabled] = useState(false);
  const [obsidianVaultPath, setObsidianVaultPath] = useState("");
  const [obsidianMode, setObsidianMode] = useState<"read_append" | "read_only">("read_append");
  const [obsidianAllowedSubpaths, setObsidianAllowedSubpaths] = useState("");
  const [obsidianQuery, setObsidianQuery] = useState("");
  const [obsidianSearchResults, setObsidianSearchResults] = useState<
    Array<{
      relativePath: string;
      title: string;
      snippet: string;
      score: number;
    }>
  >([]);
  const [obsidianInboxRequest, setObsidianInboxRequest] = useState("");
  const [obsidianBusy, setObsidianBusy] = useState<null | "save" | "test" | "search" | "capture">(null);
  const [criticalConfirmed, setCriticalConfirmed] = useState(false);
  const [changeReview, setChangeReview] = useState<{ overall: UiRiskLevel; items: UiRiskItem[] }>({
    overall: "safe",
    items: [],
  });
  const [deleteTarget, setDeleteTarget] = useState<IntegrationConnection | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectorDiagnosticsEnabled, setConnectorDiagnosticsEnabled] = useState(false);
  const [diagnosticsByConnectionId, setDiagnosticsByConnectionId] = useState<
    Record<string, Awaited<ReturnType<typeof fetchIntegrationConnectionDiagnostics>>>
  >({});
  const [selectedDiagnosticConnectionId, setSelectedDiagnosticConnectionId] = useState<string | null>(null);
  const [discordPairingsByConnectionId, setDiscordPairingsByConnectionId] = useState<
    Record<
      string,
      {
        runtime?: DiscordRuntimeStatus;
        items: DiscordPairingRecord[];
      }
    >
  >({});
  const [channelRuntimeStatusByConnectionId, setChannelRuntimeStatusByConnectionId] = useState<
    Record<string, ChannelRuntimeStatus>
  >({});
  const [discordPairingBusyId, setDiscordPairingBusyId] = useState<string | null>(null);
  const [selectedChannelConnectionId, setSelectedChannelConnectionId] = useState("");
  const [channelTestTarget, setChannelTestTarget] = useState("");
  const [channelTestMessage, setChannelTestMessage] = useState(
    "Operator test message from GoatCitadel Mission Control.",
  );
  const [channelAttachmentUrls, setChannelAttachmentUrls] = useState("");
  const [channelAttachmentIdsText, setChannelAttachmentIdsText] = useState("");
  const [uploadedChannelAttachments, setUploadedChannelAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [channelReplyToMessageId, setChannelReplyToMessageId] = useState("");
  const [channelReplyToPartIndex, setChannelReplyToPartIndex] = useState("");
  const [channelEffectId, setChannelEffectId] = useState("");
  const [channelSubject, setChannelSubject] = useState("");
  const [channelTestResult, setChannelTestResult] = useState<string | null>(null);
  const [channelTestBusy, setChannelTestBusy] = useState(false);
  const [channelUploadBusy, setChannelUploadBusy] = useState(false);
  const [channelActionBusy, setChannelActionBusy] = useState<"react" | "unsend" | null>(null);
  const [channelActionResult, setChannelActionResult] = useState<string | null>(null);
  const [channelReactionMessageId, setChannelReactionMessageId] = useState("");
  const [channelReactionEmoji, setChannelReactionEmoji] = useState("\ud83d\udc4d");
  const [channelUnsendMessageId, setChannelUnsendMessageId] = useState("");
  const requestSeq = useRef(0);
  const riskDebounceRef = useRef<number | null>(null);
  const riskAbortRef = useRef<AbortController | null>(null);
  const createAction = useAction();
  const deleteAction = useAction();

  const load = (options?: { background?: boolean }): Promise<void> => {
    const background = options?.background ?? false;
    const requestedKind = isChannelsView ? "channel" : kindFilter;
    const kind: Exclude<IntegrationKind, "all"> | undefined = requestedKind === "all" ? undefined : requestedKind;
    const requestId = ++requestSeq.current;
    const pluginsPromise = isChannelsView
      ? Promise.resolve<{ items: Awaited<ReturnType<typeof fetchIntegrationPlugins>>["items"] } | null>(null)
      : fetchIntegrationPlugins();
    const obsidianPromise = isChannelsView
      ? Promise.resolve<ObsidianIntegrationStatus | null>(null)
      : fetchObsidianIntegrationStatus();
    const channelSetupDefinitionsPromise = fetchChannelSetupDefinitions().catch(() => null);
    const settingsPromise = background
      ? Promise.resolve<Awaited<ReturnType<typeof fetchSettings>> | null>(null)
      : fetchSettings();
    if (background) {
      setIsRefreshing(true);
    } else {
      setIsInitialLoading(true);
    }
    return Promise.all([
      fetchIntegrationCatalog(kind),
      fetchIntegrationConnections(kind),
      fetchConnectorRecords("integration_connection"),
      settingsPromise,
      pluginsPromise,
      obsidianPromise,
      channelSetupDefinitionsPromise,
    ])
      .then(
        ([catalogRes, connectionRes, connectorRes, settings, pluginRes, obsidianRes, channelSetupDefinitionsRes]) => {
          if (requestId !== requestSeq.current) {
            return;
          }
          const nextCatalog = catalogRes.items;
          setCatalog(nextCatalog);
          setGuidedChannelCatalogIdList(channelSetupDefinitionsRes?.items.map((item) => item.catalog.catalogId) ?? []);
          setConnections(connectionRes.items);
          setConnectorRecords(connectorRes.items);
          if (settings) {
            setConnectorDiagnosticsEnabled(settings.features.connectorDiagnosticsV1Enabled);
          }
          if (isChannelsView) {
            setPlugins([]);
            setObsidianStatus(null);
          } else {
            setPlugins(pluginRes?.items ?? []);
            if (obsidianRes) {
              setObsidianStatus(obsidianRes);
              setObsidianEnabled(obsidianRes.enabled);
              setObsidianVaultPath(obsidianRes.vaultPath);
              setObsidianMode(obsidianRes.mode);
              setObsidianAllowedSubpaths(obsidianRes.allowedSubpaths.join(", "));
            }
          }

          const hasCurrentSelection = selectedCatalogId
            ? nextCatalog.some((entry) => entry.catalogId === selectedCatalogId)
            : false;
          const nextSelection = hasCurrentSelection ? selectedCatalogId : (nextCatalog[0]?.catalogId ?? "");

          setSelectedCatalogId(nextSelection);
          setError(null);
        },
      )
      .catch((err: Error) => {
        if (requestId === requestSeq.current) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (requestId === requestSeq.current) {
          if (background) {
            setIsRefreshing(false);
          } else {
            setIsInitialLoading(false);
          }
        }
      });
  };

  useEffect(() => {
    if (isChannelsView && kindFilter !== "channel") {
      setKindFilter("channel");
    }
  }, [isChannelsView, kindFilter]);

  useEffect(() => {
    load({ background: false });
  }, [kindFilter, isChannelsView]);

  useRefreshSubscription(
    "integrations",
    async () => {
      await load({ background: true });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1100,
      staleMs: 20000,
      pollIntervalMs: 15000,
    },
  );

  useEffect(() => {
    if (!selectedCatalogId) {
      setFormSchema(undefined);
      setIsFormSchemaLoading(false);
      setGuidedConfig({});
      return;
    }
    let cancelled = false;
    setFormSchema(undefined);
    setIsFormSchemaLoading(true);
    void fetchIntegrationFormSchema(selectedCatalogId)
      .then((schema) => {
        if (cancelled) {
          return;
        }
        setFormSchema(schema);
        const defaults = Object.fromEntries(
          schema.fields
            .filter((field) => field.defaultValue !== undefined)
            .map((field) => [field.key, field.defaultValue]),
        );
        setGuidedConfig(defaults);
      })
      .catch(() => {
        if (!cancelled) {
          setFormSchema(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsFormSchemaLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedCatalogId]);

  const selectedCatalog = useMemo(
    () => catalog.find((entry) => entry.catalogId === selectedCatalogId),
    [catalog, selectedCatalogId],
  );
  const guidedChannelCatalogIds = useMemo(() => new Set(guidedChannelCatalogIdList), [guidedChannelCatalogIdList]);
  const selectedCatalogIsRunnable = selectedCatalog
    ? selectedCatalog.runtimeAvailability
      ? selectedCatalog.runtimeAvailability === "runnable"
      : selectedCatalog.maturity !== "planned"
    : false;
  const selectedCatalogSetupPath = selectedCatalog
    ? resolveChannelSetupPath(selectedCatalog, guidedChannelCatalogIds)
    : "not_channel";

  const catalogOptions = useMemo(
    () =>
      catalog.map((entry) => ({
        value: entry.catalogId,
        label: `${entry.label} (${entry.kind})`,
      })),
    [catalog],
  );

  const catalogLabelById = useMemo(() => new Map(catalog.map((entry) => [entry.catalogId, entry.label])), [catalog]);

  const connectionSummary = useMemo(() => {
    const total = connections.length;
    const connected = connections.filter((item) => item.enabled && item.status === "connected").length;
    const paused = connections.filter((item) => item.status === "paused").length;
    const error = connections.filter((item) => item.status === "error").length;
    const disabled = connections.filter((item) => !item.enabled).length;
    return { total, connected, paused, error, disabled };
  }, [connections]);
  const channelCatalogTruthSummary = useMemo(() => {
    const summary = { guided: 0, manual: 0, blocked: 0 };
    for (const entry of catalog) {
      const setupPath = resolveChannelSetupPath(entry, guidedChannelCatalogIds);
      if (setupPath === "guided") {
        summary.guided += 1;
      } else if (setupPath === "manual") {
        summary.manual += 1;
      } else if (setupPath === "blocked") {
        summary.blocked += 1;
      }
    }
    return summary;
  }, [catalog, guidedChannelCatalogIds]);

  const filteredConnections = useMemo(() => {
    const query = connectionSearch.trim().toLowerCase();
    if (!query) {
      return connections;
    }
    return connections.filter((connection) => {
      const catalogLabel = (catalogLabelById.get(connection.catalogId) ?? "").toLowerCase();
      const lastError = (connection.lastError ?? "").toLowerCase();
      return (
        connection.label.toLowerCase().includes(query) ||
        connection.catalogId.toLowerCase().includes(query) ||
        catalogLabel.includes(query) ||
        connection.kind.toLowerCase().includes(query) ||
        connection.status.toLowerCase().includes(query) ||
        lastError.includes(query)
      );
    });
  }, [catalogLabelById, connectionSearch, connections]);

  const channelConnections = useMemo(
    () => connections.filter((connection) => connection.kind === "channel"),
    [connections],
  );
  const connectorBySourceId = useMemo(
    () => new Map(connectorRecords.map((record) => [record.sourceId, record])),
    [connectorRecords],
  );

  const selectedChannelConnection = useMemo(
    () => channelConnections.find((connection) => connection.connectionId === selectedChannelConnectionId) ?? null,
    [channelConnections, selectedChannelConnectionId],
  );
  const selectedChannelConnector = useMemo(
    () => (selectedChannelConnection ? connectorBySourceId.get(selectedChannelConnection.connectionId) : undefined),
    [connectorBySourceId, selectedChannelConnection],
  );
  const selectedDiscordRuntime = selectedChannelConnection
    ? discordPairingsByConnectionId[selectedChannelConnection.connectionId]?.runtime
    : undefined;
  const selectedDiscordPairings = selectedChannelConnection
    ? (discordPairingsByConnectionId[selectedChannelConnection.connectionId]?.items ?? [])
    : [];
  const selectedChannelRuntimeStatus = selectedChannelConnection
    ? channelRuntimeStatusByConnectionId[selectedChannelConnection.connectionId]
    : undefined;

  const effectiveConfig = useMemo(() => {
    if (showAdvancedJson) {
      try {
        return JSON.parse(configJson) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return guidedConfig;
  }, [configJson, guidedConfig, showAdvancedJson]);

  useEffect(() => {
    const localReview = evaluateLocalRisk({
      selectedCatalog,
      selectedCatalogId,
      configJson: JSON.stringify(effectiveConfig),
      status,
      enabled,
    });
    if (riskDebounceRef.current) {
      window.clearTimeout(riskDebounceRef.current);
      riskDebounceRef.current = null;
    }
    riskDebounceRef.current = window.setTimeout(() => {
      riskAbortRef.current?.abort();
      const controller = new AbortController();
      riskAbortRef.current = controller;
      void evaluateUiChangeRisk(
        {
          pageId: "integrations",
          changes: [
            { field: "integration.kindFilter", from: "all", to: kindFilter },
            { field: "integration.catalogId", from: "", to: selectedCatalogId },
            { field: "integration.status", from: "connected", to: status },
            { field: "integration.enabled", from: true, to: enabled },
            { field: "integration.configJson", from: "{}", to: JSON.stringify(effectiveConfig) },
          ],
        },
        { signal: controller.signal },
      )
        .then((remoteReview) => {
          const merged = mergeRiskItems(
            localReview.items,
            remoteReview.items.map((item) => ({
              field: item.field,
              level: item.level,
              hint: item.hint,
            })),
          );
          setChangeReview({
            overall: deriveOverallRisk(merged),
            items: merged,
          });
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) {
            return;
          }
          setChangeReview({
            overall: deriveOverallRisk(localReview.items),
            items: localReview.items,
          });
        });
    }, 400);
    return () => {
      if (riskDebounceRef.current) {
        window.clearTimeout(riskDebounceRef.current);
        riskDebounceRef.current = null;
      }
      riskAbortRef.current?.abort();
    };
  }, [kindFilter, selectedCatalogId, selectedCatalog, status, enabled, effectiveConfig]);

  useEffect(() => {
    if (channelConnections.length === 0) {
      setSelectedChannelConnectionId("");
      return;
    }
    if (!channelConnections.some((connection) => connection.connectionId === selectedChannelConnectionId)) {
      setSelectedChannelConnectionId(channelConnections[0]?.connectionId ?? "");
    }
  }, [channelConnections, selectedChannelConnectionId]);

  useEffect(() => {
    if (!selectedChannelConnection) {
      setChannelTestTarget("");
      return;
    }
    setChannelTestTarget(guessDefaultChannelTarget(selectedChannelConnection));
    setChannelTestResult(null);
    setChannelActionResult(null);
  }, [selectedChannelConnection]);

  useEffect(() => {
    if (!selectedChannelConnection) {
      return;
    }
    let cancelled = false;
    void fetchChannelRuntimeStatus(selectedChannelConnection.connectionId)
      .then((runtimeStatus) => {
        if (cancelled) {
          return;
        }
        setChannelRuntimeStatusByConnectionId((current) => ({
          ...current,
          [selectedChannelConnection.connectionId]: runtimeStatus,
        }));
      })
      .catch(() => {
        // preserve the last known runtime snapshot when refresh fails
      });
    return () => {
      cancelled = true;
    };
  }, [selectedChannelConnection]);

  useEffect(() => {
    if (!selectedChannelConnection || !isDiscordGatewayConnection(selectedChannelConnection)) {
      return;
    }
    void fetchDiscordPairings(selectedChannelConnection.connectionId)
      .then((result) => {
        setDiscordPairingsByConnectionId((current) => ({
          ...current,
          [selectedChannelConnection.connectionId]: result,
        }));
      })
      .catch(() => {
        // leave previous snapshot in place if the refresh fails
      });
  }, [selectedChannelConnection]);

  const onCreate = async () => {
    if (changeReview.overall === "critical" && !criticalConfirmed) {
      setError("Confirm critical integration changes before creating.");
      return;
    }
    if (!selectedCatalogId) {
      setError("Select a catalog entry first.");
      return;
    }
    if (!selectedCatalogIsRunnable) {
      setError(
        "This catalog entry is not runnable in the current runtime. Pick a runnable integration before creating a connection.",
      );
      return;
    }
    let parsedConfig: Record<string, unknown>;
    if (showAdvancedJson) {
      try {
        parsedConfig = JSON.parse(configJson) as Record<string, unknown>;
      } catch {
        setError("Connection config JSON is invalid.");
        return;
      }
    } else {
      parsedConfig = sanitizeGuidedConfig(guidedConfig);
      setConfigJson(JSON.stringify(parsedConfig, null, 2));
    }

    const derivedLabel = label.trim() || (typeof parsedConfig.label === "string" ? parsedConfig.label : "");
    const derivedEnabled = typeof parsedConfig.enabled === "boolean" ? parsedConfig.enabled : enabled;
    const { label: _omitLabel, enabled: _omitEnabled, ...normalizedConfig } = parsedConfig;

    try {
      await createAction.run(async () => {
        await createIntegrationConnection({
          catalogId: selectedCatalogId,
          label: derivedLabel || undefined,
          enabled: derivedEnabled,
          status,
          config: normalizedConfig,
        });
      });
      setLabel("");
      setGuidedConfig({});
      setConfigJson("{}");
      setCriticalConfirmed(false);
      setError(null);
      load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onToggle = async (connection: IntegrationConnection) => {
    try {
      await updateIntegrationConnection(connection.connectionId, {
        enabled: !connection.enabled,
        status: !connection.enabled ? "connected" : "paused",
      });
      load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onRunDiagnostics = async (connectionId: string) => {
    if (!connectorDiagnosticsEnabled) {
      setError("Connector diagnostics are disabled in this runtime.");
      return;
    }
    setPluginBusyId(`diag:${connectionId}`);
    try {
      const report = await fetchIntegrationConnectionDiagnostics(connectionId);
      setDiagnosticsByConnectionId((current) => ({
        ...current,
        [connectionId]: report,
      }));
      setSelectedDiagnosticConnectionId(connectionId);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPluginBusyId(null);
    }
  };

  const refreshDiscordPairings = async (connectionId: string) => {
    const result = await fetchDiscordPairings(connectionId);
    setDiscordPairingsByConnectionId((current) => ({
      ...current,
      [connectionId]: result,
    }));
  };

  const onApproveDiscordPairing = async (connectionId: string, pairingId: string) => {
    setDiscordPairingBusyId(`approve:${pairingId}`);
    try {
      await approveDiscordPairing(connectionId, pairingId);
      await refreshDiscordPairings(connectionId);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDiscordPairingBusyId(null);
    }
  };

  const onRevokeDiscordPairing = async (connectionId: string, pairingId: string) => {
    setDiscordPairingBusyId(`revoke:${pairingId}`);
    try {
      await revokeDiscordPairing(connectionId, pairingId);
      await refreshDiscordPairings(connectionId);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDiscordPairingBusyId(null);
    }
  };

  const onReconnectDiscordRuntime = async (connectionId: string) => {
    setDiscordPairingBusyId(`reconnect:${connectionId}`);
    try {
      const runtime = await reconnectDiscordRuntime(connectionId);
      setDiscordPairingsByConnectionId((current) => ({
        ...current,
        [connectionId]: {
          runtime,
          items: current[connectionId]?.items ?? [],
        },
      }));
      await refreshDiscordPairings(connectionId);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDiscordPairingBusyId(null);
    }
  };

  const onInstallPlugin = async () => {
    const source = pluginSource.trim();
    if (!source) {
      setError("Enter a plugin source first.");
      return;
    }
    setPluginBusyId("install");
    try {
      await installIntegrationPlugin({ source });
      setPluginSource("");
      setError(null);
      load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPluginBusyId(null);
    }
  };

  const onTogglePlugin = async (pluginId: string, enabled: boolean) => {
    setPluginBusyId(pluginId);
    try {
      if (enabled) {
        await disableIntegrationPlugin(pluginId);
      } else {
        await enableIntegrationPlugin(pluginId);
      }
      setError(null);
      load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPluginBusyId(null);
    }
  };

  const onDeleteConfirmed = async () => {
    if (!deleteTarget) {
      return;
    }
    try {
      await deleteAction.run(async () => {
        await deleteIntegrationConnection(deleteTarget.connectionId);
      });
      setDeleteTarget(null);
      load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onSendChannelTest = async () => {
    if (!selectedChannelConnection) {
      setError("Choose a channel connection first.");
      return;
    }
    const message = channelTestMessage.trim();
    const target = channelTestTarget.trim();
    if (!message) {
      setError("Enter a test message.");
      return;
    }
    if (!target && requiresExplicitChannelTarget(selectedChannelConnection)) {
      setError("Enter a destination target or configure a default one.");
      return;
    }
    setChannelTestBusy(true);
    setChannelTestResult(null);
    try {
      const attachments = parseAttachmentUrlInputs(channelAttachmentUrls);
      const uploadedAttachmentIds = parseAttachmentIdInputs(channelAttachmentIdsText);
      for (const attachment of uploadedChannelAttachments) {
        if (!uploadedAttachmentIds.includes(attachment.attachmentId)) {
          uploadedAttachmentIds.push(attachment.attachmentId);
        }
      }
      const replyToPartIndex = channelReplyToPartIndex.trim()
        ? Number.parseInt(channelReplyToPartIndex.trim(), 10)
        : undefined;
      const result = await commsSend({
        connectionId: selectedChannelConnection.connectionId,
        target,
        message,
        attachments,
        attachmentIds: uploadedAttachmentIds.length > 0 ? uploadedAttachmentIds : undefined,
        replyToMessageId: channelReplyToMessageId.trim() || undefined,
        replyToPartIndex: Number.isFinite(replyToPartIndex) ? replyToPartIndex : undefined,
        effectId: channelEffectId.trim() || undefined,
        subject: channelSubject.trim() || undefined,
      });
      const statusText =
        typeof result === "object" && result && "status" in result
          ? String((result as { status?: unknown }).status ?? "sent")
          : "sent";
      const providerMessageId =
        typeof result === "object" && result && "providerMessageId" in result
          ? String((result as { providerMessageId?: unknown }).providerMessageId ?? "")
          : "";
      setChannelTestResult(
        providerMessageId
          ? `Delivered with status ${statusText}. Provider message id: ${providerMessageId}.`
          : `Delivered with status ${statusText}.`,
      );
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChannelTestBusy(false);
    }
  };

  const onReactChannelTest = async () => {
    if (!selectedChannelConnection || !selectedChannelConnector) {
      setError("Choose a channel connection first.");
      return;
    }
    if (!connectorSupportsDeliveryAction(selectedChannelConnector, "channel.react")) {
      setError("This channel connection does not support reactions.");
      return;
    }
    const messageId = channelReactionMessageId.trim();
    const emoji = channelReactionEmoji.trim();
    const target = channelTestTarget.trim();
    if (!messageId) {
      setError("Enter a provider message id to react to.");
      return;
    }
    if (!emoji) {
      setError("Enter a reaction emoji.");
      return;
    }
    if (!target && requiresExplicitChannelTarget(selectedChannelConnection)) {
      setError("Enter a destination target or configure a default one.");
      return;
    }
    setChannelActionBusy("react");
    setChannelActionResult(null);
    try {
      const result = await commsReact({
        connectionId: selectedChannelConnection.connectionId,
        target,
        messageId,
        reaction: emoji,
      });
      const statusText =
        typeof result === "object" && result && "status" in result
          ? String((result as { status?: unknown }).status ?? "reacted")
          : "reacted";
      setChannelActionResult(`Reaction request completed with status ${statusText}.`);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChannelActionBusy(null);
    }
  };

  const onUploadChannelAttachments = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) {
      return;
    }
    setChannelUploadBusy(true);
    try {
      const uploaded: ChatAttachmentRecord[] = [];
      for (const file of Array.from(fileList)) {
        uploaded.push(
          await uploadChatAttachment({
            sessionId: INTEGRATIONS_UPLOAD_SESSION_ID,
            file,
          }),
        );
      }
      setUploadedChannelAttachments((current) => dedupeUploadedAttachments([...current, ...uploaded]));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChannelUploadBusy(false);
    }
  };

  const onRemoveUploadedChannelAttachment = (attachmentId: string) => {
    setUploadedChannelAttachments((current) => current.filter((item) => item.attachmentId !== attachmentId));
  };

  const onUnsendChannelTest = async () => {
    if (!selectedChannelConnection || !selectedChannelConnector) {
      setError("Choose a channel connection first.");
      return;
    }
    if (!connectorSupportsDeliveryAction(selectedChannelConnector, "channel.unsend")) {
      setError("This channel connection does not support unsend.");
      return;
    }
    const messageId = channelUnsendMessageId.trim();
    const target = channelTestTarget.trim();
    if (!messageId) {
      setError("Enter a provider message id to unsend.");
      return;
    }
    if (!target && requiresExplicitChannelTarget(selectedChannelConnection)) {
      setError("Enter a destination target or configure a default one.");
      return;
    }
    setChannelActionBusy("unsend");
    setChannelActionResult(null);
    try {
      const result = await commsUnsend({
        connectionId: selectedChannelConnection.connectionId,
        target,
        messageId,
      });
      const statusText =
        typeof result === "object" && result && "status" in result
          ? String((result as { status?: unknown }).status ?? "unsent")
          : "unsent";
      setChannelActionResult(`Unsend request completed with status ${statusText}.`);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChannelActionBusy(null);
    }
  };

  const onSaveObsidianConfig = async () => {
    setObsidianBusy("save");
    try {
      const allowedSubpaths = obsidianAllowedSubpaths
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const updated = await patchObsidianIntegrationConfig({
        enabled: obsidianEnabled,
        vaultPath: obsidianVaultPath.trim(),
        mode: obsidianMode,
        allowedSubpaths,
      });
      setObsidianEnabled(updated.enabled);
      setObsidianVaultPath(updated.vaultPath);
      setObsidianMode(updated.mode);
      setObsidianAllowedSubpaths(updated.allowedSubpaths.join(", "));
      setError(null);
      await load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setObsidianBusy(null);
    }
  };

  const onTestObsidian = async () => {
    setObsidianBusy("test");
    try {
      const tested = await testObsidianIntegration();
      setObsidianStatus(tested);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setObsidianBusy(null);
    }
  };

  const onSearchObsidian = async () => {
    const query = obsidianQuery.trim();
    if (!query) {
      setError("Enter a search query for Obsidian notes.");
      return;
    }
    setObsidianBusy("search");
    try {
      const response = await searchObsidianNotes({ query, limit: 8 });
      setObsidianSearchResults(response.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setObsidianBusy(null);
    }
  };

  const onCaptureObsidianInbox = async () => {
    const requestText = obsidianInboxRequest.trim();
    if (!requestText) {
      setError("Enter a short request to capture in Obsidian inbox.");
      return;
    }
    setObsidianBusy("capture");
    try {
      await captureObsidianInboxEntry({
        id: `GC-IN-${Math.floor(Date.now() / 1000)}`,
        request: requestText,
        type: "feature",
        priority: "medium",
        owner: "Personal Assistant Goat",
        state: "new",
        taskLink: "[[GoatCitadel Tasks]]",
      });
      setObsidianInboxRequest("");
      setError(null);
      await load({ background: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setObsidianBusy(null);
    }
  };

  const blockCreate = changeReview.overall === "critical" && !criticalConfirmed;
  const selectedDiagnostics = selectedDiagnosticConnectionId
    ? diagnosticsByConnectionId[selectedDiagnosticConnectionId]
    : undefined;
  const integrationsHeaderActions = (
    <div className="workflow-summary-strip">
      <StatusChip tone="live">{connectionSummary.connected} ready</StatusChip>
      <StatusChip>{connectionSummary.total} configured</StatusChip>
      <StatusChip>{plugins.length} plugins</StatusChip>
      {connectionSummary.error > 0 ? <StatusChip tone="critical">{connectionSummary.error} errors</StatusChip> : null}
      {isRefreshing ? <StatusChip tone="warning">Refreshing</StatusChip> : null}
    </div>
  );
  const headerTitle = isChannelsView ? "Channels" : pageCopy.integrations.title;
  const headerSubtitle = isChannelsView
    ? "Standalone channel setup, delivery wiring, and operator message validation."
    : pageCopy.integrations.subtitle;
  const headerHint = isChannelsView
    ? "Set up channel delivery here without mixing in non-channel integrations."
    : "Connect only what you want live, validate risk before saving, and keep the catalog secondary.";
  const createConnectionTitle = isChannelsView ? "Create Channel Connection" : "Create Connection";
  const createConnectionSubtitle = isChannelsView
    ? "Use the simple connection form by default. Check each channel's setup path below to see whether it already has a guided wizard or still needs the manual path."
    : "Start in guided mode. Switch to advanced JSON only if you need unsupported fields.";
  const connectionsTitle = isChannelsView ? "Configured Channel Connections" : "Configured Connections";
  const connectionsSubtitle = isChannelsView
    ? "Search channel adapters by name, delivery state, or last error."
    : "Search by name, catalog, status, or error text.";
  const guidedModeSummary = isChannelsView
    ? "Best for straightforward connection records. GoatCitadel shows labeled fields instead of raw JSON while you save the connection itself."
    : "Best for beginners. GoatCitadel shows normal labeled fields and safer defaults instead of raw config text.";
  const advancedModeSummary = isChannelsView
    ? "Best for experts or support-led setup. You edit the raw connection config directly when the simple form does not expose a field you need."
    : "Best for experts. You edit the raw connection config directly when guided setup does not expose a field you need.";
  const selectedModeCallout = !showAdvancedJson
    ? `${guidedModeSummary} Use this unless you already know you need custom JSON.`
    : `${advancedModeSummary} This gives you more control, but it is easier to make mistakes.`;
  const simpleFormLabel = isChannelsView ? "Simple form" : "Guided";
  const simpleFormSelectionLabel = isChannelsView ? "Simple form mode is selected." : "Guided mode is selected.";

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Integrate"
        title={headerTitle}
        subtitle={headerSubtitle}
        hint={headerHint}
        actions={integrationsHeaderActions}
      />
      {!isChannelsView ? (
        <PageGuideCard
          pageId="integrations"
          what={pageCopy.integrations.guide?.what ?? ""}
          when={pageCopy.integrations.guide?.when ?? ""}
          mostCommonAction={pageCopy.integrations.guide?.mostCommonAction}
          actions={pageCopy.integrations.guide?.actions ?? []}
          terms={pageCopy.integrations.guide?.terms}
        />
      ) : null}

      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing integrations...</p> : null}
      </div>

      <Panel
        title="How Connections Work"
        subtitle="Catalog entries define the shape. Connections hold config and activate only when a page or workflow needs them."
      >
        <ol>
          <li>
            {isChannelsView
              ? "Pick a channel adapter from the catalog."
              : "Pick a catalog entry to define what you are connecting."}
          </li>
          <li>
            {isChannelsView
              ? "Use guided fields first so default targets and auth expectations stay visible."
              : "Fill guided fields (recommended), then save the connection."}
          </li>
          <li>
            {isChannelsView
              ? "Validate delivery in Channel Test Bench before you trust the adapter live."
              : "Leave it connected for live use, or pause it until needed."}
          </li>
        </ol>
        <div className="token-row">
          <span className="token-chip">Configured: {connectionSummary.total}</span>
          <span className="token-chip token-chip-active">Ready: {connectionSummary.connected}</span>
          <span className="token-chip">Paused: {connectionSummary.paused}</span>
          <span className="token-chip">Errors: {connectionSummary.error}</span>
          <span className="token-chip">Disabled: {connectionSummary.disabled}</span>
        </div>
      </Panel>

      {!isChannelsView ? (
        <IntegrationsObsidianPanel
          obsidianEnabled={obsidianEnabled}
          onObsidianEnabledChange={setObsidianEnabled}
          obsidianVaultPath={obsidianVaultPath}
          onObsidianVaultPathChange={setObsidianVaultPath}
          obsidianMode={obsidianMode}
          onObsidianModeChange={setObsidianMode}
          obsidianAllowedSubpaths={obsidianAllowedSubpaths}
          onObsidianAllowedSubpathsChange={setObsidianAllowedSubpaths}
          obsidianBusy={obsidianBusy}
          onSaveObsidianConfig={() => void onSaveObsidianConfig()}
          onTestObsidian={() => void onTestObsidian()}
          obsidianStatus={obsidianStatus}
          obsidianQuery={obsidianQuery}
          onObsidianQueryChange={setObsidianQuery}
          onSearchObsidian={() => void onSearchObsidian()}
          obsidianSearchResults={obsidianSearchResults}
          obsidianInboxRequest={obsidianInboxRequest}
          onObsidianInboxRequestChange={setObsidianInboxRequest}
          onCaptureObsidianInbox={() => void onCaptureObsidianInbox()}
        />
      ) : null}

      <IntegrationsCatalogPicker<IntegrationKind>
        isChannelsView={isChannelsView}
        catalog={catalog}
        selectedCatalogId={selectedCatalogId}
        onSelectCatalogId={setSelectedCatalogId}
        guidedChannelCatalogIds={guidedChannelCatalogIds}
        channelCatalogTruthSummary={channelCatalogTruthSummary}
        isInitialLoading={isInitialLoading}
        kindFilter={kindFilter}
        onKindFilterChange={(value) => {
          setKindFilter(value);
          setSelectedCatalogId("");
          setFormSchema(undefined);
        }}
        kindOptions={KIND_OPTIONS}
        scopeSubtitle={kindFilter === "all" ? "Showing all available catalog entries." : KIND_DESCRIPTIONS[kindFilter]}
      />

      <ChangeReviewPanel
        title="Pre-Save Safety Check"
        overall={changeReview.overall}
        items={changeReview.items}
        requireCriticalConfirm
        criticalConfirmed={criticalConfirmed}
        onCriticalConfirmChange={setCriticalConfirmed}
      />

      <IntegrationsCreateConnectionPanel
        createConnectionTitle={createConnectionTitle}
        createConnectionSubtitle={createConnectionSubtitle}
        isInitialLoading={isInitialLoading}
        selectedCatalogId={selectedCatalogId}
        onSelectedCatalogIdChange={setSelectedCatalogId}
        catalogOptions={catalogOptions}
        label={label}
        onLabelChange={setLabel}
        selectedCatalog={selectedCatalog}
        selectedCatalogSetupPath={selectedCatalogSetupPath}
        selectedCatalogIsRunnable={selectedCatalogIsRunnable}
        status={status}
        onStatusChange={setStatus}
        statusOptions={STATUS_OPTIONS}
        enabled={enabled}
        onEnabledChange={setEnabled}
        showAdvancedJson={showAdvancedJson}
        onShowAdvancedJsonChange={setShowAdvancedJson}
        simpleFormLabel={simpleFormLabel}
        simpleFormSelectionLabel={simpleFormSelectionLabel}
        guidedModeSummary={guidedModeSummary}
        advancedModeSummary={advancedModeSummary}
        selectedModeCallout={selectedModeCallout}
        isFormSchemaLoading={isFormSchemaLoading}
        formSchema={formSchema}
        guidedConfig={guidedConfig}
        onGuidedConfigChange={setGuidedConfig}
        configJson={configJson}
        onConfigJsonChange={setConfigJson}
        blockCreate={blockCreate}
        createPending={createAction.pending}
        onCreate={() => void onCreate()}
      />

      <IntegrationsConnectionsTable
        connectionsTitle={connectionsTitle}
        connectionsSubtitle={connectionsSubtitle}
        connectionSearch={connectionSearch}
        onConnectionSearchChange={setConnectionSearch}
        connections={connections}
        filteredConnections={filteredConnections}
        catalogLabelById={catalogLabelById}
        connectorBySourceId={connectorBySourceId}
        connectorDiagnosticsEnabled={connectorDiagnosticsEnabled}
        pluginBusyId={pluginBusyId}
        deleteActionPending={deleteAction.pending}
        onToggle={(connection) => void onToggle(connection)}
        onRunDiagnostics={(connectionId) => void onRunDiagnostics(connectionId)}
        onSetDeleteTarget={setDeleteTarget}
        selectedDiagnosticConnectionId={selectedDiagnosticConnectionId}
        selectedDiagnostics={selectedDiagnostics}
      />

      <IntegrationsChannelTestBench
        channelConnections={channelConnections}
        selectedChannelConnectionId={selectedChannelConnectionId}
        onSelectedChannelConnectionIdChange={setSelectedChannelConnectionId}
        selectedChannelConnection={selectedChannelConnection}
        selectedChannelConnector={selectedChannelConnector}
        selectedChannelRuntimeStatus={selectedChannelRuntimeStatus}
        selectedDiscordRuntime={selectedDiscordRuntime}
        selectedDiscordPairings={selectedDiscordPairings}
        channelTestTarget={channelTestTarget}
        onChannelTestTargetChange={setChannelTestTarget}
        channelTestMessage={channelTestMessage}
        onChannelTestMessageChange={setChannelTestMessage}
        channelSubject={channelSubject}
        onChannelSubjectChange={setChannelSubject}
        channelEffectId={channelEffectId}
        onChannelEffectIdChange={setChannelEffectId}
        channelReplyToMessageId={channelReplyToMessageId}
        onChannelReplyToMessageIdChange={setChannelReplyToMessageId}
        channelReplyToPartIndex={channelReplyToPartIndex}
        onChannelReplyToPartIndexChange={setChannelReplyToPartIndex}
        channelAttachmentUrls={channelAttachmentUrls}
        onChannelAttachmentUrlsChange={setChannelAttachmentUrls}
        channelAttachmentIdsText={channelAttachmentIdsText}
        onChannelAttachmentIdsTextChange={setChannelAttachmentIdsText}
        uploadedChannelAttachments={uploadedChannelAttachments}
        onRemoveUploadedChannelAttachment={onRemoveUploadedChannelAttachment}
        onUploadChannelAttachments={(files) => void onUploadChannelAttachments(files)}
        channelUploadBusy={channelUploadBusy}
        channelTestBusy={channelTestBusy}
        channelTestResult={channelTestResult}
        onSendChannelTest={() => void onSendChannelTest()}
        onReconnectDiscordRuntime={(connectionId) => void onReconnectDiscordRuntime(connectionId)}
        onApproveDiscordPairing={(connectionId, pairingId) => void onApproveDiscordPairing(connectionId, pairingId)}
        onRevokeDiscordPairing={(connectionId, pairingId) => void onRevokeDiscordPairing(connectionId, pairingId)}
        discordPairingBusyId={discordPairingBusyId}
        channelReactionMessageId={channelReactionMessageId}
        onChannelReactionMessageIdChange={setChannelReactionMessageId}
        channelReactionEmoji={channelReactionEmoji}
        onChannelReactionEmojiChange={setChannelReactionEmoji}
        channelUnsendMessageId={channelUnsendMessageId}
        onChannelUnsendMessageIdChange={setChannelUnsendMessageId}
        channelActionBusy={channelActionBusy}
        channelActionResult={channelActionResult}
        onReactChannelTest={() => void onReactChannelTest()}
        onUnsendChannelTest={() => void onUnsendChannelTest()}
      />

      {!isChannelsView ? (
        <IntegrationsPluginsPanel
          plugins={plugins}
          pluginSource={pluginSource}
          onPluginSourceChange={setPluginSource}
          onInstallPlugin={() => void onInstallPlugin()}
          onTogglePlugin={(pluginId, currentlyEnabled) => void onTogglePlugin(pluginId, currentlyEnabled)}
          pluginBusyId={pluginBusyId}
        />
      ) : null}

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Remove Integration Connection"
        message={`Remove "${deleteTarget?.label ?? "this connection"}" and its saved configuration?`}
        confirmLabel={deleteAction.pending ? "Removing..." : "Remove"}
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void onDeleteConfirmed()}
      />
    </section>
  );
}
