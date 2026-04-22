/* eslint-disable max-lines -- SettingsNativePage intentionally keeps the new settings routes in one editable module while the product surface is still settling. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  Gauge,
  HardDrive,
  KeyRound,
  Package2,
  Play,
  Plug2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Wrench,
} from "lucide-react";
import { BlocksShuffleLoader } from "../../components/BlocksShuffleLoader";
import type {
  ChannelSetupDefinition,
  ConnectorDiagnosticReport,
  McpServerRecord,
  ToolGrantRecord,
} from "@goatcitadel/contracts";
import {
  archiveWorkspace,
  connectMcpServer,
  createChannelSetupDraft,
  createIntegrationConnection,
  createMcpServer,
  createToolGrant,
  createWorkspace,
  deleteIntegrationConnection,
  deleteMcpServer,
  deleteProviderSecret,
  disconnectMcpServer,
  fetchAddonStatus,
  fetchAddonsCatalog,
  fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts,
  fetchDaemonStatus,
  fetchDeviceAccessGrants,
  fetchInstalledAddons,
  fetchIntegrationCatalog,
  fetchIntegrationConnectionDiagnostics,
  fetchIntegrationConnections,
  fetchLlamaCppModels,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchMcpTools,
  fetchNpuModels,
  fetchProviderSecretStatus,
  fetchSettings,
  fetchToolCatalog,
  fetchToolGrants,
  fetchVoiceRuntimeStatus,
  fetchWorkspaces,
  finalizeChannelSetupDraft,
  installAddon,
  installVoiceRuntime,
  invokeIntegrationConnectionAction,
  launchAddon,
  patchSettings,
  refreshLlamaCppRuntime,
  refreshNpuRuntime,
  restartDaemon,
  resolveGatewayInstallToken,
  restoreWorkspace,
  revokeDeviceAccessGrant,
  revokeToolGrant,
  runMcpServerHealthCheck,
  saveProviderSecret,
  selectVoiceRuntimeModel,
  startDaemon,
  startLlamaCppRuntime,
  startNpuRuntime,
  stopAddon,
  stopDaemon,
  stopLlamaCppRuntime,
  stopNpuRuntime,
  testChannelSetupDraft,
  uninstallAddon,
  updateAddon,
  updateChannelSetupDraft,
  updateIntegrationConnection,
  updateMcpServer,
  updateWorkspace,
  validateChannelSetupDraft,
  type IntegrationConnection,
} from "@goatcitadel/mission-control-shared/api/client";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import type { AppRoute, SettingsSection } from "@next/app/route-model";
import "./native-routes.css";

interface SettingsNativePageProps {
  route: AppRoute;
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  setActiveWorkspaceId: (workspaceId: string) => void;
}

type LoadState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type Notice = {
  tone: "success" | "warning" | "error" | "info";
  message: string;
};

type SettingsSectionProps = SettingsNativePageProps & {
  section: SettingsSection;
};

export function SettingsNativePage(props: SettingsNativePageProps) {
  const section = (props.route.section as SettingsSection | undefined) ?? "general";

  return (
    <SettingsPageFrame
      icon={iconForSettingsSection(section)}
      kicker="Settings"
      title={labelForSettingsSection(section)}
      description={descriptionForSettingsSection(section)}
    >
      {renderSettingsSection({ ...props, section })}
    </SettingsPageFrame>
  );
}

function renderSettingsSection(props: SettingsSectionProps) {
  switch (props.section) {
    case "providers":
      return <ProvidersSection {...props} />;
    case "access":
      return <AccessSection {...props} />;
    case "runtime":
      return <RuntimeSection {...props} />;
    case "workspaces":
      return <WorkspacesSection {...props} />;
    case "integrations":
      return <IntegrationsSection {...props} />;
    case "channels":
      return <ChannelsSection {...props} />;
    case "mcp":
      return <McpSection {...props} />;
    case "tools":
      return <ToolsSection {...props} />;
    case "addons":
      return <AddonsSection {...props} />;
    default:
      return <GeneralSection {...props} />;
  }
}

function GeneralSection({ activeWorkspaceName, route, navigate }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [settings, workspaces, integrations, mcpServers, tools, addons] = await Promise.all([
      fetchSettings().catch(() => null),
      fetchWorkspaces("all", 400).catch(() => ({ items: [] })),
      fetchIntegrationConnections().catch(() => ({ items: [] })),
      fetchMcpServers().catch(() => ({ items: [] })),
      fetchToolCatalog().catch(() => ({ items: [] })),
      fetchInstalledAddons().catch(() => ({ items: [] })),
    ]);
    return {
      settings,
      workspaces: workspaces.items,
      integrations: integrations.items,
      mcpServers: mcpServers.items,
      tools: tools.items,
      addons: addons.items,
    };
  }, []);
  const { loading, error, data } = useAsyncLoad(load);

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {data ? (
        <SettingsGrid>
          <SettingsPanel
            title="Mission Control posture"
            subtitle="Core defaults and system posture at a glance."
            stats={[
              { label: "Workspace", value: activeWorkspaceName },
              { label: "Providers", value: String(data.settings?.llm.providers.length ?? 0) },
              { label: "Auth", value: data.settings?.auth.mode ?? "unknown" },
            ]}
          >
            <SettingsMetricGrid
              items={[
                {
                  label: "Workspaces",
                  value: String(data.workspaces.length),
                  meta: "Contexts available to switch or edit",
                },
                {
                  label: "Integrations",
                  value: String(data.integrations.length),
                  meta: "Configured external connections",
                },
                { label: "MCP", value: String(data.mcpServers.length), meta: "External tool servers" },
                { label: "Tools", value: String(data.tools.length), meta: "Catalog entries with policy posture" },
                { label: "Add-ons", value: String(data.addons.length), meta: "Installed extensions" },
                {
                  label: "Active model",
                  value: data.settings?.llm.activeModel ?? "n/a",
                  meta: data.settings?.llm.activeProviderId ?? "No active provider",
                },
              ]}
            />
          </SettingsPanel>
          <SettingsPanel
            title="Quick routes"
            subtitle="Jump straight into the settings surfaces that actually change behavior."
          >
            <SettingsActionList
              items={[
                {
                  label: "Providers",
                  description: "Choose active model routing and manage provider secrets.",
                  onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
                },
                {
                  label: "Runtime",
                  description: "Configure daemon, llama.cpp, NPU, and voice runtime posture.",
                  onClick: () => navigate({ area: "settings", section: "runtime", theme: route.theme }),
                },
                {
                  label: "Workspaces",
                  description: "Create, edit, archive, restore, and switch workspaces.",
                  onClick: () => navigate({ area: "settings", section: "workspaces", theme: route.theme }),
                },
                {
                  label: "Integrations",
                  description: "Create and manage app connections and diagnostics.",
                  onClick: () => navigate({ area: "settings", section: "integrations", theme: route.theme }),
                },
                {
                  label: "Channels",
                  description: "Run guided channel setup drafts, test them, and finalize.",
                  onClick: () => navigate({ area: "settings", section: "channels", theme: route.theme }),
                },
                {
                  label: "MCP",
                  description: "Create and connect MCP servers with transport-specific config.",
                  onClick: () => navigate({ area: "settings", section: "mcp", theme: route.theme }),
                },
                {
                  label: "Tools",
                  description: "Review tool catalog coverage and manage grants.",
                  onClick: () => navigate({ area: "settings", section: "tools", theme: route.theme }),
                },
                {
                  label: "Add-ons",
                  description: "Install and control optional add-on runtimes.",
                  onClick: () => navigate({ area: "settings", section: "addons", theme: route.theme }),
                },
              ]}
            />
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function ProvidersSection({ activeWorkspaceId }: SettingsSectionProps) {
  const { config, providers, loading, error, reload, loadModelsForProvider } = useProviderModelCatalog("system");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [routingProviderId, setRoutingProviderId] = useState("");
  const [routingModel, setRoutingModel] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [secretState, setSecretState] = useState<LoadState<Awaited<ReturnType<typeof fetchProviderSecretStatus>>>>({
    loading: false,
    error: null,
    data: null,
  });
  const selectedProvider = providers.find((item) => item.providerId === selectedProviderId) ?? providers[0] ?? null;
  const availableModels = selectedProvider?.models ?? [];

  useEffect(() => {
    if (!providers.length) {
      setSelectedProviderId("");
      return;
    }
    setSelectedProviderId((current) => current || config?.activeProviderId || providers[0]?.providerId || "");
  }, [config?.activeProviderId, providers]);

  useEffect(() => {
    if (!config) {
      return;
    }
    setRoutingProviderId(config.activeProviderId);
    setRoutingModel(config.activeModel);
  }, [config]);

  useEffect(() => {
    if (!selectedProviderId) {
      setSecretState({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setSecretState({ loading: true, error: null, data: null });
    void fetchProviderSecretStatus(selectedProviderId)
      .then((data) => {
        if (!cancelled) {
          setSecretState({ loading: false, error: null, data });
        }
      })
      .catch((loadError: Error) => {
        if (!cancelled) {
          setSecretState({ loading: false, error: loadError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProviderId]);

  useEffect(() => {
    if (selectedProviderId) {
      void loadModelsForProvider(selectedProviderId);
    }
  }, [loadModelsForProvider, selectedProviderId]);

  const handleSaveRouting = async () => {
    if (!routingProviderId.trim() || !routingModel.trim()) {
      setNotice({ tone: "warning", message: "Choose both a provider and a model before saving routing." });
      return;
    }
    try {
      await patchSettings({
        llm: {
          activeProviderId: routingProviderId,
          activeModel: routingModel,
        },
      });
      setNotice({ tone: "success", message: "Provider routing updated." });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleSaveSecret = async () => {
    if (!selectedProviderId.trim() || !secretValue.trim()) {
      setNotice({ tone: "warning", message: "Enter a provider secret before saving." });
      return;
    }
    try {
      const next = await saveProviderSecret(selectedProviderId, secretValue.trim());
      setSecretState({ loading: false, error: null, data: next });
      setSecretValue("");
      setNotice({ tone: "success", message: "Provider secret saved." });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleDeleteSecret = async () => {
    if (!selectedProviderId.trim()) {
      return;
    }
    if (!window.confirm("Delete the saved secret for this provider?")) {
      return;
    }
    try {
      const next = await deleteProviderSecret(selectedProviderId);
      setSecretState({ loading: false, error: null, data: next });
      setNotice({ tone: "success", message: "Provider secret removed." });
      await reload();
    } catch (deleteError) {
      setNotice({ tone: "error", message: getErrorMessage(deleteError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsGrid>
        <SettingsPanel
          title="Providers"
          subtitle="Available providers and their current model catalog posture."
          stats={[
            { label: "Configured", value: String(providers.length) },
            { label: "Active workspace", value: activeWorkspaceId },
          ]}
        >
          <SettingsSelectableList
            items={providers.map((item) => ({
              id: item.providerId,
              title: item.label,
              meta: item.providerId,
              body: `${item.models.length} models · ${item.hasApiKey ? "secret ready" : "secret missing"}`,
            }))}
            selectedId={selectedProviderId}
            onSelect={setSelectedProviderId}
            emptyLabel="No providers returned from runtime settings."
          />
        </SettingsPanel>
        <SettingsStack>
          <SettingsPanel
            title="Active routing"
            subtitle="Change the provider/model pair Mission Control uses by default."
          >
            <SettingsFieldGrid>
              <SettingsField label="Provider">
                <select
                  className="mc-next-settings-input"
                  value={routingProviderId}
                  onChange={(event) => {
                    const nextProviderId = event.target.value;
                    const provider = providers.find((item) => item.providerId === nextProviderId);
                    setRoutingProviderId(nextProviderId);
                    setRoutingModel(provider?.defaultModel ?? provider?.models[0] ?? "");
                  }}
                >
                  {providers.map((item) => (
                    <option key={item.providerId} value={item.providerId}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </SettingsField>
              <SettingsField label="Model">
                <select
                  className="mc-next-settings-input"
                  value={routingModel}
                  onChange={(event) => setRoutingModel(event.target.value)}
                >
                  {(providers.find((item) => item.providerId === routingProviderId)?.models ?? []).map((modelId) => (
                    <option key={modelId} value={modelId}>
                      {modelId}
                    </option>
                  ))}
                </select>
              </SettingsField>
            </SettingsFieldGrid>
            <SettingsButtonRow>
              <button type="button" className="mc-next-button" onClick={() => void handleSaveRouting()}>
                <Save size={16} />
                Save routing
              </button>
            </SettingsButtonRow>
          </SettingsPanel>
          <SettingsPanel
            title={selectedProvider?.label ?? "Provider detail"}
            subtitle="Credential posture and provider metadata."
          >
            {selectedProvider ? (
              <>
                <SettingsMetricGrid
                  items={[
                    { label: "Default model", value: selectedProvider.defaultModel, meta: selectedProvider.apiStyle },
                    {
                      label: "API key",
                      value: secretState.data?.hasSecret || selectedProvider.hasApiKey ? "Configured" : "Missing",
                      meta: secretState.data?.source ?? selectedProvider.apiKeySource ?? "unknown",
                    },
                    { label: "Models", value: String(availableModels.length), meta: "Known to the runtime" },
                  ]}
                />
                <SettingsFieldGrid>
                  <SettingsField label="Base URL">
                    <input className="mc-next-settings-input" value={selectedProvider.baseUrl} readOnly />
                  </SettingsField>
                  <SettingsField label="Capabilities">
                    <input
                      className="mc-next-settings-input"
                      value={formatCapabilities(selectedProvider.capabilities)}
                      readOnly
                    />
                  </SettingsField>
                </SettingsFieldGrid>
                <SettingsField label="Provider secret">
                  <input
                    className="mc-next-settings-input"
                    type="password"
                    value={secretValue}
                    placeholder="Paste a new API key to save"
                    onChange={(event) => setSecretValue(event.target.value)}
                  />
                </SettingsField>
                {secretState.error ? <SettingsNotice notice={{ tone: "error", message: secretState.error }} /> : null}
                <SettingsButtonRow>
                  <button type="button" className="mc-next-button" onClick={() => void handleSaveSecret()}>
                    <KeyRound size={16} />
                    Save secret
                  </button>
                  <button type="button" className="mc-next-button-secondary" onClick={() => void handleDeleteSecret()}>
                    <Trash2 size={16} />
                    Delete secret
                  </button>
                </SettingsButtonRow>
              </>
            ) : (
              <SettingsEmptyState label="Choose a provider to inspect routing and secret posture." />
            )}
          </SettingsPanel>
        </SettingsStack>
      </SettingsGrid>
    </SettingsSectionShell>
  );
}

function AccessSection({ activeWorkspaceName }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [settings, grants] = await Promise.all([
      fetchSettings(),
      fetchDeviceAccessGrants("all").catch(() => ({ items: [] })),
    ]);
    return {
      settings,
      grants: grants.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [form, setForm] = useState({
    mode: "none",
    allowLoopbackBypass: true,
    token: "",
    basicUsername: "",
    basicPassword: "",
  });
  const [installToken, setInstallToken] = useState<string>("");

  useEffect(() => {
    if (!data) {
      return;
    }
    setForm({
      mode: data.settings.auth.mode,
      allowLoopbackBypass: data.settings.auth.allowLoopbackBypass,
      token: "",
      basicUsername: "",
      basicPassword: "",
    });
  }, [data]);

  const handleSave = async () => {
    try {
      await patchSettings({
        auth: {
          mode: form.mode as "none" | "token" | "basic",
          allowLoopbackBypass: form.allowLoopbackBypass,
          token: form.token.trim() || undefined,
          basicUsername: form.basicUsername.trim() || undefined,
          basicPassword: form.basicPassword.trim() || undefined,
        },
      });
      setNotice({ tone: "success", message: "Access posture updated." });
      setForm((current) => ({
        ...current,
        token: "",
        basicUsername: "",
        basicPassword: "",
      }));
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleGenerateInstallToken = async () => {
    try {
      const result = await resolveGatewayInstallToken({
        generateWhenMissing: true,
        persistToEnv: false,
      });
      setInstallToken(result.token ?? "");
      setNotice({ tone: "success", message: `Install token resolved from ${result.source}.` });
    } catch (tokenError) {
      setNotice({ tone: "error", message: getErrorMessage(tokenError) });
    }
  };

  const handleRevokeGrant = async (grantId: string) => {
    if (!window.confirm("Revoke this device access grant?")) {
      return;
    }
    try {
      await revokeDeviceAccessGrant(grantId);
      setNotice({ tone: "success", message: "Device access revoked." });
      await reload();
    } catch (revokeError) {
      setNotice({ tone: "error", message: getErrorMessage(revokeError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid>
          <SettingsStack>
            <SettingsPanel
              title="Gateway access"
              subtitle="Change auth mode, loopback behavior, and optional credentials."
              stats={[
                { label: "Current mode", value: data.settings.auth.mode },
                { label: "Workspace", value: activeWorkspaceName },
              ]}
            >
              <SettingsFieldGrid>
                <SettingsField label="Auth mode">
                  <select
                    className="mc-next-settings-input"
                    value={form.mode}
                    onChange={(event) => setForm((current) => ({ ...current, mode: event.target.value }))}
                  >
                    <option value="none">None</option>
                    <option value="token">Token</option>
                    <option value="basic">Basic</option>
                  </select>
                </SettingsField>
                <SettingsField label="Loopback bypass">
                  <label className="mc-next-settings-toggle">
                    <input
                      type="checkbox"
                      checked={form.allowLoopbackBypass}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, allowLoopbackBypass: event.target.checked }))
                      }
                    />
                    <span>Allow local loopback sessions without full auth.</span>
                  </label>
                </SettingsField>
                <SettingsField label="Token">
                  <input
                    className="mc-next-settings-input"
                    type="password"
                    value={form.token}
                    placeholder="Only enter a new token when rotating credentials"
                    onChange={(event) => setForm((current) => ({ ...current, token: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Basic username">
                  <input
                    className="mc-next-settings-input"
                    value={form.basicUsername}
                    placeholder="Optional"
                    onChange={(event) => setForm((current) => ({ ...current, basicUsername: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Basic password">
                  <input
                    className="mc-next-settings-input"
                    type="password"
                    value={form.basicPassword}
                    placeholder="Optional"
                    onChange={(event) => setForm((current) => ({ ...current, basicPassword: event.target.value }))}
                  />
                </SettingsField>
              </SettingsFieldGrid>
              <SettingsButtonRow>
                <button type="button" className="mc-next-button" onClick={() => void handleSave()}>
                  <Save size={16} />
                  Save access settings
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void handleGenerateInstallToken()}
                >
                  <RefreshCw size={16} />
                  Generate install token
                </button>
              </SettingsButtonRow>
              {installToken ? (
                <SettingsCodeBlock label="Install token preview">{installToken}</SettingsCodeBlock>
              ) : null}
            </SettingsPanel>
            <SettingsPanel title="Current posture" subtitle="Readable auth state instead of a recycled general page.">
              <SettingsMetricGrid
                items={[
                  {
                    label: "Loopback bypass",
                    value: data.settings.auth.allowLoopbackBypass ? "Enabled" : "Disabled",
                    meta:
                      data.settings.auth.tokenConfigured || data.settings.auth.basicConfigured
                        ? "Protected mode configured"
                        : "No persisted credentials",
                  },
                  {
                    label: "Token auth",
                    value: data.settings.auth.tokenConfigured ? "Configured" : "Missing",
                    meta: "Operator token presence",
                  },
                  {
                    label: "Basic auth",
                    value: data.settings.auth.basicConfigured ? "Configured" : "Missing",
                    meta: "Username/password presence",
                  },
                ]}
              />
            </SettingsPanel>
          </SettingsStack>
          <SettingsPanel
            title="Approved devices"
            subtitle="View and revoke device grants that can access the gateway."
            stats={[{ label: "Grants", value: String(data.grants.length) }]}
          >
            <SettingsActionList
              items={data.grants.map((grant) => ({
                label: grant.deviceLabel || grant.grantId,
                description: `${grant.deviceType || "device"} · ${grant.revokedAt ? "revoked" : "active"} · ${formatDateTime(grant.createdAt)}`,
                meta:
                  (typeof grant.metadata.origin === "string" ? grant.metadata.origin : undefined) ||
                  grant.platform ||
                  "Unknown origin",
                onClick: grant.revokedAt ? undefined : () => void handleRevokeGrant(grant.grantId),
                actionLabel: grant.revokedAt ? "Revoked" : "Revoke",
              }))}
              emptyLabel="No device grants found."
            />
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function RuntimeSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const settings = await fetchSettings();
    const shouldLoadNpuModels =
      settings.npu.enabled && (settings.npu.status.healthy || settings.npu.status.processState === "running");
    const [daemon, voiceRuntime, llamaModels, npuModels] = await Promise.all([
      fetchDaemonStatus().catch(() => null),
      fetchVoiceRuntimeStatus().catch(() => null),
      fetchLlamaCppModels().catch(() => ({ items: [] })),
      shouldLoadNpuModels ? fetchNpuModels().catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    ]);
    return {
      settings,
      daemon,
      voiceRuntime,
      llamaModels: llamaModels.items,
      npuModels: npuModels.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [llamaForm, setLlamaForm] = useState({
    enabled: false,
    autoStart: false,
    baseUrl: "",
    command: "",
    modelsRootPath: "",
    modelPath: "",
    alias: "",
  });
  const [npuForm, setNpuForm] = useState({
    enabled: false,
    autoStart: false,
    sidecarUrl: "",
  });
  const discoveredLlamaModels = useMemo(
    () => (data?.llamaModels ?? []).filter((item) => typeof item.filePath === "string" && item.filePath.length > 0),
    [data],
  );
  const selectedDiscoveredModelPath = useMemo(
    () => (discoveredLlamaModels.some((item) => item.filePath === llamaForm.modelPath) ? llamaForm.modelPath : ""),
    [discoveredLlamaModels, llamaForm.modelPath],
  );
  const selectedDiscoveredModel = useMemo(
    () => discoveredLlamaModels.find((item) => item.filePath === selectedDiscoveredModelPath),
    [discoveredLlamaModels, selectedDiscoveredModelPath],
  );

  const buildLlamaSettingsPatch = useCallback(
    () => ({
      enabled: llamaForm.enabled,
      autoStart: llamaForm.autoStart,
      baseUrl: llamaForm.baseUrl,
      command: llamaForm.command,
      modelsRootPath: llamaForm.modelsRootPath || undefined,
      modelPath: llamaForm.modelPath || undefined,
      alias: llamaForm.alias,
    }),
    [llamaForm],
  );

  const saveLlamaSettings = useCallback(
    () =>
      patchSettings({
        llamaCpp: buildLlamaSettingsPatch(),
      }),
    [buildLlamaSettingsPatch],
  );

  const handleDiscoveredModelChange = useCallback(
    (nextModelPath: string) => {
      const nextModel = discoveredLlamaModels.find((item) => item.filePath === nextModelPath);
      setLlamaForm((current) => ({
        ...current,
        modelPath: nextModelPath,
        alias: nextModel ? deriveLlamaCppAlias(nextModel.relativePath ?? nextModel.modelId) : current.alias,
      }));
    },
    [discoveredLlamaModels],
  );

  useEffect(() => {
    if (!data) {
      return;
    }
    setLlamaForm({
      enabled: data.settings.llamaCpp.enabled,
      autoStart: data.settings.llamaCpp.autoStart,
      baseUrl: data.settings.llamaCpp.baseUrl,
      command: data.settings.llamaCpp.command,
      modelsRootPath: data.settings.llamaCpp.modelsRootPath ?? "",
      modelPath: data.settings.llamaCpp.modelPath ?? "",
      alias: data.settings.llamaCpp.alias,
    });
    setNpuForm({
      enabled: data.settings.npu.enabled,
      autoStart: data.settings.npu.autoStart,
      sidecarUrl: data.settings.npu.sidecarUrl,
    });
  }, [data]);

  const runAndReload = async (operation: () => Promise<unknown>, successMessage: string) => {
    try {
      await operation();
      setNotice({ tone: "success", message: successMessage });
      await reload();
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsStack>
          <SettingsPanel title="Runtime posture" subtitle="Providers, local runtimes, and attached systems.">
            <SettingsMetricGrid
              items={[
                {
                  label: "Daemon",
                  value: data.daemon?.state ?? "unknown",
                  meta: data.daemon?.host ?? "Gateway daemon status",
                },
                {
                  label: "llama.cpp",
                  value: data.settings.llamaCpp.status.processState,
                  meta: `${data.llamaModels.length} models discovered`,
                },
                {
                  label: "NPU",
                  value: data.settings.npu.status.processState,
                  meta: `${data.npuModels.length} models discovered`,
                },
                {
                  label: "Voice",
                  value: data.voiceRuntime?.readiness ?? "unknown",
                  meta: data.voiceRuntime?.selectedModelId ?? "No active voice model",
                },
              ]}
            />
          </SettingsPanel>
          <SettingsGrid>
            <SettingsPanel title="Gateway daemon" subtitle="Control the background runtime serving Mission Control.">
              <SettingsMetricGrid
                items={[
                  {
                    label: "State",
                    value: data.daemon?.state ?? "unknown",
                    meta: data.daemon?.running ? "Running" : "Stopped",
                  },
                  {
                    label: "Host",
                    value: data.daemon?.host ?? "n/a",
                    meta: data.daemon?.controllable ? "Controllable" : "Read-only",
                  },
                ]}
              />
              <SettingsButtonRow>
                <button
                  type="button"
                  className="mc-next-button"
                  onClick={() => void runAndReload(startDaemon, "Gateway daemon start requested.")}
                >
                  <Play size={16} />
                  Start
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void runAndReload(stopDaemon, "Gateway daemon stop requested.")}
                >
                  <Square size={16} />
                  Stop
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void runAndReload(restartDaemon, "Gateway daemon restart requested.")}
                >
                  <RotateCcw size={16} />
                  Restart
                </button>
              </SettingsButtonRow>
            </SettingsPanel>
            <SettingsPanel title="llama.cpp runtime" subtitle="Configure and control the local llama.cpp runtime.">
              <SettingsFieldGrid>
                <SettingsField label="Base URL">
                  <input
                    className="mc-next-settings-input"
                    value={llamaForm.baseUrl}
                    onChange={(event) => setLlamaForm((current) => ({ ...current, baseUrl: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Command">
                  <input
                    className="mc-next-settings-input"
                    value={llamaForm.command}
                    onChange={(event) => setLlamaForm((current) => ({ ...current, command: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Models root">
                  <input
                    className="mc-next-settings-input"
                    value={llamaForm.modelsRootPath}
                    onChange={(event) =>
                      setLlamaForm((current) => ({ ...current, modelsRootPath: event.target.value }))
                    }
                  />
                </SettingsField>
                <SettingsField label="Model path">
                  <input
                    className="mc-next-settings-input"
                    value={llamaForm.modelPath}
                    onChange={(event) => setLlamaForm((current) => ({ ...current, modelPath: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Discovered models" span={2}>
                  <>
                    <select
                      className="mc-next-settings-input"
                      value={selectedDiscoveredModelPath}
                      onChange={(event) => handleDiscoveredModelChange(event.target.value)}
                      disabled={!discoveredLlamaModels.length}
                    >
                      <option value="">
                        {discoveredLlamaModels.length
                          ? `Choose from ${discoveredLlamaModels.length} models under ${llamaForm.modelsRootPath || "the default models root"}`
                          : "No local .gguf models discovered under Models root yet"}
                      </option>
                      {discoveredLlamaModels.map((model) => (
                        <option key={model.filePath} value={model.filePath}>
                          {model.relativePath ?? model.modelId}
                        </option>
                      ))}
                    </select>
                    {selectedDiscoveredModel ? (
                      <p className="mc-next-settings-field-note">
                        {selectedDiscoveredModel.relativePath ?? selectedDiscoveredModel.modelId}
                      </p>
                    ) : null}
                  </>
                </SettingsField>
                <SettingsField label="Alias">
                  <input
                    className="mc-next-settings-input"
                    value={llamaForm.alias}
                    onChange={(event) => setLlamaForm((current) => ({ ...current, alias: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Enabled">
                  <label className="mc-next-settings-toggle">
                    <input
                      type="checkbox"
                      checked={llamaForm.enabled}
                      onChange={(event) => setLlamaForm((current) => ({ ...current, enabled: event.target.checked }))}
                    />
                    <span>Enable llama.cpp runtime</span>
                  </label>
                </SettingsField>
                <SettingsField label="Auto start">
                  <label className="mc-next-settings-toggle">
                    <input
                      type="checkbox"
                      checked={llamaForm.autoStart}
                      onChange={(event) => setLlamaForm((current) => ({ ...current, autoStart: event.target.checked }))}
                    />
                    <span>Auto-start with the gateway</span>
                  </label>
                </SettingsField>
              </SettingsFieldGrid>
              <SettingsButtonRow>
                <button
                  type="button"
                  className="mc-next-button"
                  onClick={() => void runAndReload(saveLlamaSettings, "llama.cpp settings saved.")}
                >
                  <Save size={16} />
                  Save
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() =>
                    void runAndReload(async () => {
                      await saveLlamaSettings();
                      await startLlamaCppRuntime();
                    }, "llama.cpp start requested.")
                  }
                >
                  <Play size={16} />
                  Start
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void runAndReload(stopLlamaCppRuntime, "llama.cpp stop requested.")}
                >
                  <Square size={16} />
                  Stop
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void runAndReload(refreshLlamaCppRuntime, "llama.cpp refresh requested.")}
                >
                  <RefreshCw size={16} />
                  Refresh
                </button>
              </SettingsButtonRow>
              <SettingsMetricGrid
                items={[
                  {
                    label: "Process",
                    value: data.settings.llamaCpp.status.processState,
                    meta: data.settings.llamaCpp.status.healthy ? "Healthy" : "Needs attention",
                  },
                  {
                    label: "Active model",
                    value: data.settings.llamaCpp.status.activeModelId ?? "n/a",
                    meta: data.settings.llamaCpp.status.commandSource ?? "source unknown",
                  },
                ]}
              />
            </SettingsPanel>
            <SettingsPanel title="NPU runtime" subtitle="Manage the Windows NPU sidecar and its serving posture.">
              <SettingsFieldGrid>
                <SettingsField label="Sidecar URL">
                  <input
                    className="mc-next-settings-input"
                    value={npuForm.sidecarUrl}
                    onChange={(event) => setNpuForm((current) => ({ ...current, sidecarUrl: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Enabled">
                  <label className="mc-next-settings-toggle">
                    <input
                      type="checkbox"
                      checked={npuForm.enabled}
                      onChange={(event) => setNpuForm((current) => ({ ...current, enabled: event.target.checked }))}
                    />
                    <span>Enable NPU runtime</span>
                  </label>
                </SettingsField>
                <SettingsField label="Auto start">
                  <label className="mc-next-settings-toggle">
                    <input
                      type="checkbox"
                      checked={npuForm.autoStart}
                      onChange={(event) => setNpuForm((current) => ({ ...current, autoStart: event.target.checked }))}
                    />
                    <span>Auto-start with the gateway</span>
                  </label>
                </SettingsField>
              </SettingsFieldGrid>
              <SettingsButtonRow>
                <button
                  type="button"
                  className="mc-next-button"
                  onClick={() =>
                    void runAndReload(
                      () =>
                        patchSettings({
                          npu: {
                            enabled: npuForm.enabled,
                            autoStart: npuForm.autoStart,
                            sidecarUrl: npuForm.sidecarUrl,
                          },
                        }),
                      "NPU settings saved.",
                    )
                  }
                >
                  <Save size={16} />
                  Save
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void runAndReload(startNpuRuntime, "NPU start requested.")}
                >
                  <Play size={16} />
                  Start
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void runAndReload(stopNpuRuntime, "NPU stop requested.")}
                >
                  <Square size={16} />
                  Stop
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void runAndReload(refreshNpuRuntime, "NPU refresh requested.")}
                >
                  <RefreshCw size={16} />
                  Refresh
                </button>
              </SettingsButtonRow>
              <SettingsMetricGrid
                items={[
                  {
                    label: "Process",
                    value: data.settings.npu.status.processState,
                    meta: data.settings.npu.status.healthy ? "Healthy" : "Needs attention",
                  },
                  {
                    label: "Backend",
                    value: data.settings.npu.status.backend,
                    meta: data.settings.npu.status.activeModelId ?? "No active model",
                  },
                ]}
              />
            </SettingsPanel>
            <SettingsPanel title="Voice runtime" subtitle="Install or activate the local voice transcription runtime.">
              <SettingsMetricGrid
                items={[
                  {
                    label: "Readiness",
                    value: data.voiceRuntime?.readiness ?? "unknown",
                    meta: data.voiceRuntime?.provider ?? "whisper.cpp",
                  },
                  {
                    label: "Active model",
                    value: data.voiceRuntime?.selectedModelId ?? "none",
                    meta: `${data.voiceRuntime?.installedModels.length ?? 0} installed`,
                  },
                ]}
              />
              <SettingsButtonRow>
                <button
                  type="button"
                  className="mc-next-button"
                  onClick={() => {
                    const recommended =
                      data.voiceRuntime?.catalog.find((item) => item.defaultInstall)?.id ??
                      data.voiceRuntime?.catalog[0]?.id;
                    void runAndReload(
                      () => installVoiceRuntime(recommended ? { modelId: recommended, activate: true } : {}),
                      "Voice runtime install requested.",
                    );
                  }}
                >
                  <Plus size={16} />
                  Install starter model
                </button>
                {data.voiceRuntime?.installedModels[0] ? (
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    onClick={() =>
                      void runAndReload(
                        () => selectVoiceRuntimeModel(data.voiceRuntime?.installedModels[0]?.modelId ?? ""),
                        "Voice model activated.",
                      )
                    }
                  >
                    <CheckCircle2 size={16} />
                    Activate first installed
                  </button>
                ) : null}
              </SettingsButtonRow>
              <SettingsActionList
                items={(data.voiceRuntime?.catalog ?? []).slice(0, 8).map((item) => ({
                  label: item.label,
                  description: `${item.languageScope} · ${item.approxSizeLabel}`,
                  meta: item.id,
                  onClick: () =>
                    void runAndReload(() => selectVoiceRuntimeModel(item.id), `Voice model ${item.id} selected.`),
                  actionLabel: data.voiceRuntime?.selectedModelId === item.id ? "Active" : "Use",
                }))}
                emptyLabel="No voice model catalog available."
              />
            </SettingsPanel>
          </SettingsGrid>
        </SettingsStack>
      ) : null}
    </SettingsSectionShell>
  );
}

function WorkspacesSection({ activeWorkspaceId, setActiveWorkspaceId }: SettingsSectionProps) {
  const [view, setView] = useState<"active" | "archived" | "all">("all");
  const load = useCallback(async () => fetchWorkspaces("all", 500), []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createForm, setCreateForm] = useState({
    name: "",
    description: "",
    slug: "",
  });
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    slug: "",
  });

  const filtered = useMemo(() => {
    const items = data?.items ?? [];
    if (view === "all") {
      return items;
    }
    return items.filter((item) => item.lifecycleStatus === view);
  }, [data?.items, view]);
  const selectedWorkspace = (data?.items ?? []).find((item) => item.workspaceId === selectedWorkspaceId) ?? null;

  useEffect(() => {
    if (!filtered.length) {
      setSelectedWorkspaceId("");
      return;
    }
    setSelectedWorkspaceId((current) =>
      current && filtered.some((item) => item.workspaceId === current) ? current : filtered[0]?.workspaceId || "",
    );
  }, [filtered]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setEditForm({ name: "", description: "", slug: "" });
      return;
    }
    setEditForm({
      name: selectedWorkspace.name,
      description: selectedWorkspace.description ?? "",
      slug: selectedWorkspace.slug,
    });
  }, [selectedWorkspace]);

  const handleCreate = async () => {
    if (!createForm.name.trim()) {
      setNotice({ tone: "warning", message: "Workspace name is required." });
      return;
    }
    try {
      const created = await createWorkspace({
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        slug: createForm.slug.trim() || undefined,
      });
      setNotice({ tone: "success", message: `Workspace ${created.name} created.` });
      setCreateForm({ name: "", description: "", slug: "" });
      await reload();
      setSelectedWorkspaceId(created.workspaceId);
      setActiveWorkspaceId(created.workspaceId);
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleSave = async () => {
    if (!selectedWorkspace) {
      return;
    }
    try {
      const updated = await updateWorkspace(selectedWorkspace.workspaceId, {
        name: editForm.name.trim() || undefined,
        description: editForm.description.trim() || undefined,
        slug: editForm.slug.trim() || undefined,
      });
      setNotice({ tone: "success", message: `Workspace ${updated.name} updated.` });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleArchive = async () => {
    if (!selectedWorkspace) {
      return;
    }
    if (!window.confirm(`Archive workspace ${selectedWorkspace.name}?`)) {
      return;
    }
    try {
      await archiveWorkspace(selectedWorkspace.workspaceId);
      setNotice({ tone: "success", message: `Workspace ${selectedWorkspace.name} archived.` });
      await reload();
    } catch (archiveError) {
      setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    }
  };

  const handleRestore = async () => {
    if (!selectedWorkspace) {
      return;
    }
    try {
      await restoreWorkspace(selectedWorkspace.workspaceId);
      setNotice({ tone: "success", message: `Workspace ${selectedWorkspace.name} restored.` });
      await reload();
    } catch (restoreError) {
      setNotice({ tone: "error", message: getErrorMessage(restoreError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsNotice
        notice={{
          tone: "info",
          message:
            "Workspace lifecycle is archive-based right now. The gateway supports create, edit, archive, and restore; permanent delete is not exposed yet.",
        }}
      />
      <SettingsGrid>
        <SettingsStack>
          <SettingsPanel
            title="Workspace directory"
            subtitle="Switch between active and archived workspaces, then edit the selected one."
            stats={[
              { label: "Total", value: String(data?.items.length ?? 0) },
              { label: "Active workspace", value: activeWorkspaceId },
            ]}
          >
            <SettingsFilterBar
              options={[
                { id: "all", label: "All" },
                { id: "active", label: "Active" },
                { id: "archived", label: "Archived" },
              ]}
              value={view}
              onChange={(next) => setView(next as "active" | "archived" | "all")}
            />
            <SettingsSelectableList
              items={filtered.map((item) => ({
                id: item.workspaceId,
                title: item.name,
                meta: item.lifecycleStatus,
                body: item.description || item.slug,
              }))}
              selectedId={selectedWorkspaceId}
              onSelect={setSelectedWorkspaceId}
              emptyLabel="No workspaces in this view."
            />
          </SettingsPanel>
          <SettingsPanel title="Create workspace" subtitle="Add a new workspace without leaving Settings.">
            <SettingsFieldGrid>
              <SettingsField label="Name">
                <input
                  className="mc-next-settings-input"
                  value={createForm.name}
                  onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                />
              </SettingsField>
              <SettingsField label="Slug">
                <input
                  className="mc-next-settings-input"
                  value={createForm.slug}
                  onChange={(event) => setCreateForm((current) => ({ ...current, slug: event.target.value }))}
                />
              </SettingsField>
              <SettingsField label="Description" span={2}>
                <textarea
                  className="mc-next-settings-textarea"
                  value={createForm.description}
                  onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))}
                />
              </SettingsField>
            </SettingsFieldGrid>
            <SettingsButtonRow>
              <button type="button" className="mc-next-button" onClick={() => void handleCreate()}>
                <Plus size={16} />
                Create workspace
              </button>
            </SettingsButtonRow>
          </SettingsPanel>
        </SettingsStack>
        <SettingsPanel
          title={selectedWorkspace?.name ?? "Workspace editor"}
          subtitle="Rename, describe, archive, restore, or make the selected workspace active."
        >
          {selectedWorkspace ? (
            <>
              <SettingsFieldGrid>
                <SettingsField label="Name">
                  <input
                    className="mc-next-settings-input"
                    value={editForm.name}
                    onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Slug">
                  <input
                    className="mc-next-settings-input"
                    value={editForm.slug}
                    onChange={(event) => setEditForm((current) => ({ ...current, slug: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Description" span={2}>
                  <textarea
                    className="mc-next-settings-textarea"
                    value={editForm.description}
                    onChange={(event) => setEditForm((current) => ({ ...current, description: event.target.value }))}
                  />
                </SettingsField>
              </SettingsFieldGrid>
              <SettingsMetricGrid
                items={[
                  {
                    label: "Workspace ID",
                    value: selectedWorkspace.workspaceId,
                    meta: selectedWorkspace.lifecycleStatus,
                  },
                  {
                    label: "Created",
                    value: formatDateTime(selectedWorkspace.createdAt),
                    meta: `Updated ${formatDateTime(selectedWorkspace.updatedAt)}`,
                  },
                ]}
              />
              <SettingsButtonRow>
                <button type="button" className="mc-next-button" onClick={() => void handleSave()}>
                  <Save size={16} />
                  Save changes
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => setActiveWorkspaceId(selectedWorkspace.workspaceId)}
                >
                  <CheckCircle2 size={16} />
                  Make active
                </button>
                {selectedWorkspace.lifecycleStatus === "archived" ? (
                  <button type="button" className="mc-next-button-secondary" onClick={() => void handleRestore()}>
                    <RotateCcw size={16} />
                    Restore
                  </button>
                ) : (
                  <button type="button" className="mc-next-button-danger" onClick={() => void handleArchive()}>
                    <Trash2 size={16} />
                    Archive
                  </button>
                )}
              </SettingsButtonRow>
            </>
          ) : (
            <SettingsEmptyState label="Choose a workspace to edit or create a new one." />
          )}
        </SettingsPanel>
      </SettingsGrid>
    </SettingsSectionShell>
  );
}

function IntegrationsSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [catalog, connections] = await Promise.all([
      fetchIntegrationCatalog().catch(() => ({ items: [] })),
      fetchIntegrationConnections().catch(() => ({ items: [] })),
    ]);
    return {
      catalog: catalog.items.filter((item) => item.kind !== "channel"),
      connections: connections.items.filter((item) => item.kind !== "channel"),
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [createCatalogId, setCreateCatalogId] = useState("");
  const [createLabel, setCreateLabel] = useState("");
  const [createConfig, setCreateConfig] = useState("{}");
  const [detailForm, setDetailForm] = useState({
    label: "",
    enabled: true,
    status: "connected",
    configText: "{}",
  });
  const [diagnostics, setDiagnostics] = useState<ConnectorDiagnosticReport | null>(null);
  const selectedConnection =
    data?.connections.find((item) => item.connectionId === selectedConnectionId) ?? data?.connections[0] ?? null;
  const selectedCatalog =
    data?.catalog.find((item) => item.catalogId === selectedConnection?.catalogId) ??
    data?.catalog.find((item) => item.catalogId === createCatalogId) ??
    null;

  useEffect(() => {
    if (!data?.catalog.length) {
      setCreateCatalogId("");
      return;
    }
    setCreateCatalogId((current) => current || data.catalog[0]?.catalogId || "");
  }, [data?.catalog]);

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
  }, [selectedConnection]);

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
        config: parseJsonObject(createConfig),
      });
      setNotice({ tone: "success", message: `Connection ${created.label} created.` });
      await reload();
      setSelectedConnectionId(created.connectionId);
      setCreateLabel("");
      setCreateConfig("{}");
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
        config: parseJsonObject(detailForm.configText, selectedConnection.config),
      });
      setNotice({ tone: "success", message: "Connection updated." });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleDelete = async () => {
    if (!selectedConnection) {
      return;
    }
    if (!window.confirm(`Delete connection ${selectedConnection.label}?`)) {
      return;
    }
    try {
      await deleteIntegrationConnection(selectedConnection.connectionId);
      setNotice({ tone: "success", message: "Connection deleted." });
      setDiagnostics(null);
      await reload();
    } catch (deleteError) {
      setNotice({ tone: "error", message: getErrorMessage(deleteError) });
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

  const handleOperatorAction = async (actionId: string) => {
    if (!selectedConnection) {
      return;
    }
    try {
      const result = await invokeIntegrationConnectionAction(selectedConnection.connectionId, actionId, {});
      setNotice({
        tone: result.status === "failed" ? "error" : result.status === "blocked" ? "warning" : "success",
        message: result.message,
      });
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid>
          <SettingsStack>
            <SettingsPanel
              title="Connected integrations"
              subtitle="Review live connections and jump into the selected one."
              stats={[
                { label: "Connections", value: String(data.connections.length) },
                { label: "Catalog", value: String(data.catalog.length) },
              ]}
            >
              <SettingsSelectableList
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
                }}
                emptyLabel="No integration connections yet."
              />
            </SettingsPanel>
            <SettingsPanel title="Create connection" subtitle="Create a new integration connection from the catalog.">
              <SettingsFieldGrid>
                <SettingsField label="Catalog">
                  <select
                    className="mc-next-settings-input"
                    value={createCatalogId}
                    onChange={(event) => setCreateCatalogId(event.target.value)}
                  >
                    {data.catalog.map((item) => (
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
                <SettingsField label="Config JSON" span={2}>
                  <textarea
                    className="mc-next-settings-textarea mc-next-settings-code"
                    value={createConfig}
                    onChange={(event) => setCreateConfig(event.target.value)}
                  />
                </SettingsField>
              </SettingsFieldGrid>
              {selectedCatalog ? (
                <SettingsMetricGrid
                  items={[
                    { label: "Kind", value: selectedCatalog.kind, meta: selectedCatalog.key },
                    {
                      label: "Capabilities",
                      value: String(selectedCatalog.capabilities.length),
                      meta: selectedCatalog.authMethods.join(", ") || "No auth methods listed",
                    },
                  ]}
                />
              ) : null}
              <SettingsButtonRow>
                <button type="button" className="mc-next-button" onClick={() => void handleCreate()}>
                  <Plus size={16} />
                  Create connection
                </button>
              </SettingsButtonRow>
            </SettingsPanel>
          </SettingsStack>
          <SettingsPanel
            title={selectedConnection?.label ?? "Connection detail"}
            subtitle="Update, diagnose, or remove the selected integration connection."
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
                  <SettingsField label="Enabled">
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
                  <SettingsField label="Config JSON" span={2}>
                    <textarea
                      className="mc-next-settings-textarea mc-next-settings-code"
                      value={detailForm.configText}
                      onChange={(event) => setDetailForm((current) => ({ ...current, configText: event.target.value }))}
                    />
                  </SettingsField>
                </SettingsFieldGrid>
                <SettingsMetricGrid
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
                  <button type="button" className="mc-next-button" onClick={() => void handleSave()}>
                    <Save size={16} />
                    Save changes
                  </button>
                  <button type="button" className="mc-next-button-secondary" onClick={() => void handleDiagnostics()}>
                    <RefreshCw size={16} />
                    Run diagnostics
                  </button>
                  <button type="button" className="mc-next-button-danger" onClick={() => void handleDelete()}>
                    <Trash2 size={16} />
                    Delete
                  </button>
                </SettingsButtonRow>
                {selectedCatalog?.operatorActions?.length ? (
                  <SettingsActionList
                    items={selectedCatalog.operatorActions.map((action) => ({
                      label: action.label,
                      description: action.description,
                      meta: action.capability,
                      onClick: () => void handleOperatorAction(action.actionId),
                      actionLabel: "Run",
                    }))}
                  />
                ) : null}
                {diagnostics ? <DiagnosticsPanel report={diagnostics} /> : null}
              </>
            ) : (
              <SettingsEmptyState label="Select a connection or create a new one." />
            )}
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function ChannelsSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [definitions, drafts, connections] = await Promise.all([
      fetchChannelSetupDefinitions().catch(() => ({ items: [] })),
      fetchChannelSetupDrafts({ limit: 100 }).catch(() => ({ items: [] })),
      fetchIntegrationConnections("channel").catch(() => ({ items: [] })),
    ]);
    return {
      definitions: definitions.items,
      drafts: drafts.items,
      connections: connections.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [createCatalogId, setCreateCatalogId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [draftJson, setDraftJson] = useState("{}");
  const [validationResult, setValidationResult] = useState<{ kind: "validate" | "test"; items: string[] } | null>(null);
  const selectedDraft = data?.drafts.find((item) => item.draftId === selectedDraftId) ?? data?.drafts[0] ?? null;
  const selectedDefinition =
    data?.definitions.find((item) => item.catalog.catalogId === (selectedDraft?.catalogId || createCatalogId)) ?? null;

  useEffect(() => {
    if (!data?.definitions.length) {
      setCreateCatalogId("");
      return;
    }
    setCreateCatalogId((current) => current || data.definitions[0]?.catalog.catalogId || "");
  }, [data?.definitions]);

  useEffect(() => {
    if (!data?.drafts.length) {
      setSelectedDraftId("");
      return;
    }
    setSelectedDraftId((current) =>
      current && data.drafts.some((item) => item.draftId === current) ? current : data.drafts[0]?.draftId || "",
    );
  }, [data?.drafts]);

  useEffect(() => {
    if (!selectedDraft) {
      setDraftLabel("");
      setDraftEnabled(true);
      setDraftJson("{}");
      return;
    }
    setDraftLabel(selectedDraft.label ?? "");
    setDraftEnabled(selectedDraft.enabled);
    setDraftJson(formatJson(selectedDraft.draft));
  }, [selectedDraft]);

  const handleCreate = async () => {
    if (!createCatalogId) {
      setNotice({ tone: "warning", message: "Choose a channel definition first." });
      return;
    }
    try {
      const created = await createChannelSetupDraft({ catalogId: createCatalogId });
      setNotice({ tone: "success", message: "Channel setup draft created." });
      await reload();
      setSelectedDraftId(created.draftId);
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleSave = async () => {
    if (!selectedDraft) {
      return;
    }
    try {
      await updateChannelSetupDraft(selectedDraft.draftId, {
        label: draftLabel.trim() || undefined,
        enabled: draftEnabled,
        draft: parseJsonObject(draftJson, selectedDraft.draft),
      });
      setNotice({ tone: "success", message: "Channel draft saved." });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleValidate = async () => {
    if (!selectedDraft) {
      return;
    }
    try {
      const result = await validateChannelSetupDraft(selectedDraft.draftId);
      setValidationResult({
        kind: "validate",
        items: result.issues.map((item) => `${item.level.toUpperCase()}: ${item.message}`),
      });
      setNotice({
        tone: result.status === "error" ? "error" : result.status === "warn" ? "warning" : "success",
        message: "Channel draft validated.",
      });
      await reload();
    } catch (validateError) {
      setNotice({ tone: "error", message: getErrorMessage(validateError) });
    }
  };

  const handleTest = async () => {
    if (!selectedDraft) {
      return;
    }
    try {
      const result = await testChannelSetupDraft(selectedDraft.draftId);
      setValidationResult({
        kind: "test",
        items: result.issues.map((item) => `${item.level.toUpperCase()}: ${item.message}`),
      });
      setNotice({
        tone: result.status === "error" ? "error" : result.status === "warn" ? "warning" : "success",
        message: result.recommendedNextAction || "Channel draft tested.",
      });
      await reload();
    } catch (testError) {
      setNotice({ tone: "error", message: getErrorMessage(testError) });
    }
  };

  const handleFinalize = async () => {
    if (!selectedDraft) {
      return;
    }
    try {
      const result = await finalizeChannelSetupDraft(selectedDraft.draftId);
      setNotice({ tone: "success", message: `Channel connection ${result.connection.label} finalized.` });
      await reload();
    } catch (finalizeError) {
      setNotice({ tone: "error", message: getErrorMessage(finalizeError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid>
          <SettingsStack>
            <SettingsPanel
              title="Channel definitions"
              subtitle="Available guided setup definitions for supported channel integrations."
              stats={[
                { label: "Definitions", value: String(data.definitions.length) },
                { label: "Existing channels", value: String(data.connections.length) },
              ]}
            >
              <SettingsField label="Create draft from">
                <select
                  className="mc-next-settings-input"
                  value={createCatalogId}
                  onChange={(event) => setCreateCatalogId(event.target.value)}
                >
                  {data.definitions.map((item) => (
                    <option key={item.catalog.catalogId} value={item.catalog.catalogId}>
                      {item.catalog.label}
                    </option>
                  ))}
                </select>
              </SettingsField>
              <SettingsButtonRow>
                <button type="button" className="mc-next-button" onClick={() => void handleCreate()}>
                  <Plus size={16} />
                  Create setup draft
                </button>
              </SettingsButtonRow>
              <SettingsActionList
                items={data.definitions.map((item) => ({
                  label: item.catalog.label,
                  description: item.catalog.description,
                  meta: `${item.wizard.difficulty} · ${item.wizard.estimatedMinutes} min`,
                  onClick: () => setCreateCatalogId(item.catalog.catalogId),
                  actionLabel: createCatalogId === item.catalog.catalogId ? "Selected" : "Use",
                }))}
                emptyLabel="No channel setup definitions returned."
              />
            </SettingsPanel>
            <SettingsPanel title="Drafts" subtitle="Saved setup drafts, validation, testing, and finalization.">
              <SettingsSelectableList
                items={data.drafts.map((item) => ({
                  id: item.draftId,
                  title: item.label || item.catalogId,
                  meta: item.lifecycleMode,
                  body: `${item.enabled ? "enabled" : "disabled"} · ${formatDateTime(item.updatedAt)}`,
                }))}
                selectedId={selectedDraftId}
                onSelect={(draftId) => {
                  setSelectedDraftId(draftId);
                  setValidationResult(null);
                }}
                emptyLabel="No channel drafts yet."
              />
            </SettingsPanel>
          </SettingsStack>
          <SettingsPanel
            title={selectedDraft?.label || selectedDefinition?.catalog.label || "Channel draft"}
            subtitle="Edit the draft payload, then validate, test, and finalize it."
          >
            {selectedDraft ? (
              <>
                <SettingsFieldGrid>
                  <SettingsField label="Label">
                    <input
                      className="mc-next-settings-input"
                      value={draftLabel}
                      onChange={(event) => setDraftLabel(event.target.value)}
                    />
                  </SettingsField>
                  <SettingsField label="Enabled">
                    <label className="mc-next-settings-toggle">
                      <input
                        type="checkbox"
                        checked={draftEnabled}
                        onChange={(event) => setDraftEnabled(event.target.checked)}
                      />
                      <span>Enable the connection after finalize</span>
                    </label>
                  </SettingsField>
                  <SettingsField label="Draft JSON" span={2}>
                    <textarea
                      className="mc-next-settings-textarea mc-next-settings-code"
                      value={draftJson}
                      onChange={(event) => setDraftJson(event.target.value)}
                    />
                  </SettingsField>
                </SettingsFieldGrid>
                {selectedDefinition ? (
                  <SettingsMetricGrid
                    items={[
                      {
                        label: "Difficulty",
                        value: selectedDefinition.wizard.difficulty,
                        meta: selectedDefinition.catalog.key,
                      },
                      {
                        label: "Validation levels",
                        value: String(selectedDefinition.validation.levels.length),
                        meta: selectedDefinition.testing.levels.join(", "),
                      },
                    ]}
                  />
                ) : null}
                <SettingsButtonRow>
                  <button type="button" className="mc-next-button" onClick={() => void handleSave()}>
                    <Save size={16} />
                    Save draft
                  </button>
                  <button type="button" className="mc-next-button-secondary" onClick={() => void handleValidate()}>
                    <ShieldCheck size={16} />
                    Validate
                  </button>
                  <button type="button" className="mc-next-button-secondary" onClick={() => void handleTest()}>
                    <Play size={16} />
                    Test
                  </button>
                  <button type="button" className="mc-next-button" onClick={() => void handleFinalize()}>
                    <CheckCircle2 size={16} />
                    Finalize
                  </button>
                </SettingsButtonRow>
                {selectedDefinition ? (
                  <SettingsActionList
                    items={collectDefinitionFieldHints(selectedDefinition).map((item) => ({
                      label: item.label,
                      description: item.explanation,
                      meta: item.type,
                    }))}
                    emptyLabel="No wizard field hints available."
                  />
                ) : null}
                {validationResult ? (
                  <SettingsCodeBlock
                    label={validationResult.kind === "validate" ? "Validation results" : "Test results"}
                  >
                    {validationResult.items.join("\n") || "No issues returned."}
                  </SettingsCodeBlock>
                ) : null}
              </>
            ) : (
              <SettingsEmptyState label="Create or select a channel setup draft to continue." />
            )}
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function McpSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [servers, templates] = await Promise.all([
      fetchMcpServers().catch(() => ({ items: [] })),
      fetchMcpTemplates().catch(() => ({ items: [] })),
    ]);
    return {
      servers: servers.items,
      templates: templates.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [createForm, setCreateForm] = useState({
    label: "",
    transport: "stdio",
    command: "",
    url: "",
    enabled: true,
  });
  const [editForm, setEditForm] = useState({
    label: "",
    command: "",
    url: "",
    enabled: true,
    category: "development",
  });
  const [tools, setTools] = useState<Array<{ toolName: string; description?: string }>>([]);
  const [healthReport, setHealthReport] = useState<ConnectorDiagnosticReport | null>(null);
  const selectedServer = data?.servers.find((item) => item.serverId === selectedServerId) ?? data?.servers[0] ?? null;

  useEffect(() => {
    if (!data?.servers.length) {
      setSelectedServerId("");
      return;
    }
    setSelectedServerId((current) =>
      current && data.servers.some((item) => item.serverId === current) ? current : data.servers[0]?.serverId || "",
    );
  }, [data?.servers]);

  useEffect(() => {
    if (!selectedServer) {
      setEditForm({ label: "", command: "", url: "", enabled: true, category: "development" });
      setTools([]);
      return;
    }
    setEditForm({
      label: selectedServer.label,
      command: selectedServer.command ?? "",
      url: selectedServer.url ?? "",
      enabled: selectedServer.enabled,
      category: selectedServer.category,
    });
    void fetchMcpTools(selectedServer.serverId)
      .then((result) =>
        setTools(result.items.map((item) => ({ toolName: item.toolName, description: item.description }))),
      )
      .catch(() => setTools([]));
  }, [selectedServer]);

  const handleCreate = async () => {
    if (!createForm.label.trim()) {
      setNotice({ tone: "warning", message: "Server label is required." });
      return;
    }
    try {
      const created = await createMcpServer({
        label: createForm.label.trim(),
        transport: createForm.transport as McpServerRecord["transport"],
        command: createForm.transport === "stdio" ? createForm.command.trim() || undefined : undefined,
        url: createForm.transport !== "stdio" ? createForm.url.trim() || undefined : undefined,
        enabled: createForm.enabled,
      });
      setNotice({ tone: "success", message: `MCP server ${created.label} created.` });
      setCreateForm({ label: "", transport: "stdio", command: "", url: "", enabled: true });
      await reload();
      setSelectedServerId(created.serverId);
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleSave = async () => {
    if (!selectedServer) {
      return;
    }
    try {
      await updateMcpServer(selectedServer.serverId, {
        label: editForm.label.trim() || undefined,
        command: selectedServer.transport === "stdio" ? editForm.command.trim() || undefined : undefined,
        url: selectedServer.transport !== "stdio" ? editForm.url.trim() || undefined : undefined,
        enabled: editForm.enabled,
        category: editForm.category as McpServerRecord["category"],
      });
      setNotice({ tone: "success", message: "MCP server updated." });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const runServerAction = async (action: () => Promise<unknown>, successMessage: string) => {
    try {
      await action();
      setNotice({ tone: "success", message: successMessage });
      await reload();
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid>
          <SettingsStack>
            <SettingsPanel
              title="MCP servers"
              subtitle="Connected and disconnected MCP servers available to the operator."
              stats={[
                { label: "Servers", value: String(data.servers.length) },
                { label: "Templates", value: String(data.templates.length) },
              ]}
            >
              <SettingsSelectableList
                items={data.servers.map((item) => ({
                  id: item.serverId,
                  title: item.label,
                  meta: item.status,
                  body: `${item.transport} · ${item.enabled ? "enabled" : "disabled"}`,
                }))}
                selectedId={selectedServerId}
                onSelect={(serverId) => {
                  setSelectedServerId(serverId);
                  setHealthReport(null);
                }}
                emptyLabel="No MCP servers configured."
              />
            </SettingsPanel>
            <SettingsPanel title="Create MCP server" subtitle="Set up a new stdio or URL-based MCP server.">
              <SettingsFieldGrid>
                <SettingsField label="Label">
                  <input
                    className="mc-next-settings-input"
                    value={createForm.label}
                    onChange={(event) => setCreateForm((current) => ({ ...current, label: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Transport">
                  <select
                    className="mc-next-settings-input"
                    value={createForm.transport}
                    onChange={(event) => setCreateForm((current) => ({ ...current, transport: event.target.value }))}
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">http</option>
                    <option value="sse">sse</option>
                  </select>
                </SettingsField>
                {createForm.transport === "stdio" ? (
                  <SettingsField label="Command" span={2}>
                    <input
                      className="mc-next-settings-input"
                      value={createForm.command}
                      onChange={(event) => setCreateForm((current) => ({ ...current, command: event.target.value }))}
                    />
                  </SettingsField>
                ) : (
                  <SettingsField label="URL" span={2}>
                    <input
                      className="mc-next-settings-input"
                      value={createForm.url}
                      onChange={(event) => setCreateForm((current) => ({ ...current, url: event.target.value }))}
                    />
                  </SettingsField>
                )}
                <SettingsField label="Enabled">
                  <label className="mc-next-settings-toggle">
                    <input
                      type="checkbox"
                      checked={createForm.enabled}
                      onChange={(event) => setCreateForm((current) => ({ ...current, enabled: event.target.checked }))}
                    />
                    <span>Enable immediately after create</span>
                  </label>
                </SettingsField>
              </SettingsFieldGrid>
              <SettingsButtonRow>
                <button type="button" className="mc-next-button" onClick={() => void handleCreate()}>
                  <Plus size={16} />
                  Create MCP server
                </button>
              </SettingsButtonRow>
              {data.templates.length ? (
                <SettingsActionList
                  items={data.templates.slice(0, 6).map((item) => ({
                    label: item.label,
                    description: item.description,
                    meta: item.installed ? "installed" : item.transport,
                    onClick: () =>
                      setCreateForm({
                        label: item.label,
                        transport: item.transport,
                        command: item.command ?? "",
                        url: item.url ?? "",
                        enabled: item.enabledByDefault,
                      }),
                    actionLabel: "Use",
                  }))}
                />
              ) : null}
            </SettingsPanel>
          </SettingsStack>
          <SettingsPanel
            title={selectedServer?.label ?? "Server detail"}
            subtitle="Edit, connect, diagnose, or delete the selected MCP server."
          >
            {selectedServer ? (
              <>
                <SettingsFieldGrid>
                  <SettingsField label="Label">
                    <input
                      className="mc-next-settings-input"
                      value={editForm.label}
                      onChange={(event) => setEditForm((current) => ({ ...current, label: event.target.value }))}
                    />
                  </SettingsField>
                  <SettingsField label="Category">
                    <select
                      className="mc-next-settings-input"
                      value={editForm.category}
                      onChange={(event) => setEditForm((current) => ({ ...current, category: event.target.value }))}
                    >
                      <option value="development">development</option>
                      <option value="browser">browser</option>
                      <option value="automation">automation</option>
                      <option value="research">research</option>
                      <option value="data">data</option>
                      <option value="creative">creative</option>
                      <option value="orchestration">orchestration</option>
                      <option value="other">other</option>
                    </select>
                  </SettingsField>
                  {selectedServer.transport === "stdio" ? (
                    <SettingsField label="Command" span={2}>
                      <input
                        className="mc-next-settings-input"
                        value={editForm.command}
                        onChange={(event) => setEditForm((current) => ({ ...current, command: event.target.value }))}
                      />
                    </SettingsField>
                  ) : (
                    <SettingsField label="URL" span={2}>
                      <input
                        className="mc-next-settings-input"
                        value={editForm.url}
                        onChange={(event) => setEditForm((current) => ({ ...current, url: event.target.value }))}
                      />
                    </SettingsField>
                  )}
                  <SettingsField label="Enabled">
                    <label className="mc-next-settings-toggle">
                      <input
                        type="checkbox"
                        checked={editForm.enabled}
                        onChange={(event) => setEditForm((current) => ({ ...current, enabled: event.target.checked }))}
                      />
                      <span>Server can be used by the operator.</span>
                    </label>
                  </SettingsField>
                </SettingsFieldGrid>
                <SettingsMetricGrid
                  items={[
                    { label: "Transport", value: selectedServer.transport, meta: selectedServer.authType },
                    {
                      label: "Status",
                      value: selectedServer.status,
                      meta: selectedServer.lastError || "No recent error",
                    },
                  ]}
                />
                <SettingsButtonRow>
                  <button type="button" className="mc-next-button" onClick={() => void handleSave()}>
                    <Save size={16} />
                    Save changes
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    onClick={() =>
                      void runServerAction(
                        () => connectMcpServer(selectedServer.serverId),
                        "MCP server connect requested.",
                      )
                    }
                  >
                    <Plug2 size={16} />
                    Connect
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    onClick={() =>
                      void runServerAction(
                        () => disconnectMcpServer(selectedServer.serverId),
                        "MCP server disconnect requested.",
                      )
                    }
                  >
                    <Square size={16} />
                    Disconnect
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    onClick={() =>
                      void runServerAction(
                        async () => setHealthReport(await runMcpServerHealthCheck(selectedServer.serverId)),
                        "MCP health check complete.",
                      )
                    }
                  >
                    <RefreshCw size={16} />
                    Health check
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-danger"
                    onClick={() =>
                      void runServerAction(async () => {
                        if (!window.confirm(`Delete MCP server ${selectedServer.label}?`)) {
                          return;
                        }
                        await deleteMcpServer(selectedServer.serverId);
                      }, "MCP server deleted.")
                    }
                  >
                    <Trash2 size={16} />
                    Delete
                  </button>
                </SettingsButtonRow>
                <SettingsActionList
                  items={tools.map((item) => ({
                    label: item.toolName,
                    description: item.description || "Registered MCP tool",
                  }))}
                  emptyLabel="No tools reported for this server."
                />
                {healthReport ? <DiagnosticsPanel report={healthReport} /> : null}
              </>
            ) : (
              <SettingsEmptyState label="Select a server or create a new one." />
            )}
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function ToolsSection({ activeWorkspaceId }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [tools, grants] = await Promise.all([
      fetchToolCatalog().catch(() => ({ items: [] })),
      fetchToolGrants({ limit: 400 }).catch(() => ({ items: [] })),
    ]);
    return {
      tools: tools.items,
      grants: grants.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState("");
  const [selectedToolName, setSelectedToolName] = useState("");
  const [grantForm, setGrantForm] = useState({
    toolPattern: "",
    decision: "allow",
    scope: "workspace",
    grantType: "persistent",
    scopeRef: activeWorkspaceId,
  });

  const filteredTools = useMemo(() => {
    const items = data?.tools ?? [];
    const normalized = search.trim().toLowerCase();
    if (!normalized) {
      return items;
    }
    return items.filter((item) => {
      const haystack = `${item.toolName} ${item.category ?? ""} ${item.description ?? ""}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [data?.tools, search]);
  const selectedTool = filteredTools.find((item) => item.toolName === selectedToolName) ?? filteredTools[0] ?? null;

  useEffect(() => {
    if (!filteredTools.length) {
      setSelectedToolName("");
      return;
    }
    setSelectedToolName((current) =>
      current && filteredTools.some((item) => item.toolName === current) ? current : filteredTools[0]?.toolName || "",
    );
  }, [filteredTools]);

  useEffect(() => {
    if (!selectedTool) {
      return;
    }
    setGrantForm((current) => ({
      ...current,
      toolPattern: selectedTool.toolName,
      scopeRef: current.scope === "workspace" ? activeWorkspaceId : current.scopeRef,
    }));
  }, [activeWorkspaceId, selectedTool]);

  const handleCreateGrant = async () => {
    if (!grantForm.toolPattern.trim()) {
      setNotice({ tone: "warning", message: "Tool pattern is required." });
      return;
    }
    try {
      await createToolGrant({
        toolPattern: grantForm.toolPattern.trim(),
        decision: grantForm.decision as "allow" | "deny",
        scope: grantForm.scope as "global" | "session" | "workspace" | "agent" | "task",
        scopeRef: grantForm.scope === "global" ? undefined : grantForm.scopeRef.trim() || undefined,
        grantType: grantForm.grantType as "persistent" | "ttl" | "one_time",
        createdBy: "operator",
      });
      setNotice({ tone: "success", message: "Tool grant created." });
      await reload();
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleRevokeGrant = async (grantId: string) => {
    try {
      await revokeToolGrant(grantId);
      setNotice({ tone: "success", message: "Tool grant revoked." });
      await reload();
    } catch (revokeError) {
      setNotice({ tone: "error", message: getErrorMessage(revokeError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid>
          <SettingsStack>
            <SettingsPanel
              title="Tool catalog"
              subtitle="Review the full catalog instead of a tiny first-page slice."
              stats={[
                { label: "Tools", value: String(data.tools.length) },
                { label: "Grants", value: String(data.grants.length) },
              ]}
            >
              <SettingsField label="Search">
                <input
                  className="mc-next-settings-input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search tool name, category, or description"
                />
              </SettingsField>
              <SettingsSelectableList
                items={filteredTools.map((item) => ({
                  id: item.toolName,
                  title: item.toolName,
                  meta: item.category || "tool",
                  body: item.description || "Tool catalog entry",
                }))}
                selectedId={selectedToolName}
                onSelect={setSelectedToolName}
                emptyLabel="No tools match the current search."
              />
            </SettingsPanel>
            <SettingsPanel
              title="Create tool grant"
              subtitle="Create a workspace or global policy grant for the selected tool."
            >
              <SettingsFieldGrid>
                <SettingsField label="Tool pattern">
                  <input
                    className="mc-next-settings-input"
                    value={grantForm.toolPattern}
                    onChange={(event) => setGrantForm((current) => ({ ...current, toolPattern: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Decision">
                  <select
                    className="mc-next-settings-input"
                    value={grantForm.decision}
                    onChange={(event) => setGrantForm((current) => ({ ...current, decision: event.target.value }))}
                  >
                    <option value="allow">Allow</option>
                    <option value="deny">Deny</option>
                  </select>
                </SettingsField>
                <SettingsField label="Scope">
                  <select
                    className="mc-next-settings-input"
                    value={grantForm.scope}
                    onChange={(event) =>
                      setGrantForm((current) => ({
                        ...current,
                        scope: event.target.value,
                        scopeRef: event.target.value === "workspace" ? activeWorkspaceId : current.scopeRef,
                      }))
                    }
                  >
                    <option value="global">Global</option>
                    <option value="workspace">Workspace</option>
                    <option value="session">Session</option>
                    <option value="agent">Agent</option>
                    <option value="task">Task</option>
                  </select>
                </SettingsField>
                <SettingsField label="Scope ref">
                  <input
                    className="mc-next-settings-input"
                    value={grantForm.scopeRef}
                    onChange={(event) => setGrantForm((current) => ({ ...current, scopeRef: event.target.value }))}
                    disabled={grantForm.scope === "global"}
                  />
                </SettingsField>
                <SettingsField label="Grant type">
                  <select
                    className="mc-next-settings-input"
                    value={grantForm.grantType}
                    onChange={(event) => setGrantForm((current) => ({ ...current, grantType: event.target.value }))}
                  >
                    <option value="persistent">Persistent</option>
                    <option value="ttl">TTL</option>
                    <option value="one_time">One time</option>
                  </select>
                </SettingsField>
              </SettingsFieldGrid>
              <SettingsButtonRow>
                <button type="button" className="mc-next-button" onClick={() => void handleCreateGrant()}>
                  <Plus size={16} />
                  Create grant
                </button>
              </SettingsButtonRow>
            </SettingsPanel>
          </SettingsStack>
          <SettingsPanel
            title={selectedTool?.toolName ?? "Tool detail"}
            subtitle="Selected catalog entry and active grants."
          >
            {selectedTool ? (
              <>
                <SettingsMetricGrid
                  items={[
                    {
                      label: "Category",
                      value: selectedTool.category || "tool",
                      meta: `${selectedTool.pack} pack · ${selectedTool.riskLevel} risk`,
                    },
                    {
                      label: "Available grants",
                      value: String(data.grants.filter((item) => matchesToolGrant(item, selectedTool.toolName)).length),
                      meta: "Matched by tool pattern",
                    },
                  ]}
                />
                <SettingsCodeBlock label="Tool description">
                  {selectedTool.description || "No tool description provided."}
                </SettingsCodeBlock>
              </>
            ) : (
              <SettingsEmptyState label="Choose a tool from the catalog to inspect it." />
            )}
            <SettingsActionList
              items={data.grants.map((item) => ({
                id: item.grantId,
                label: item.toolPattern,
                description: `${item.scope}${item.scopeRef ? `:${item.scopeRef}` : ""} · ${item.decision} · ${item.grantType}`,
                meta: item.revokedAt ? "revoked" : "active",
                onClick: item.revokedAt ? undefined : () => void handleRevokeGrant(item.grantId),
                actionLabel: item.revokedAt ? "Revoked" : "Revoke",
              }))}
              emptyLabel="No tool grants created yet."
            />
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function AddonsSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [catalog, installed] = await Promise.all([
      fetchAddonsCatalog().catch(() => ({ items: [] })),
      fetchInstalledAddons().catch(() => ({ items: [] })),
    ]);
    return {
      catalog: catalog.items,
      installed: installed.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedAddonId, setSelectedAddonId] = useState("");
  const [status, setStatus] = useState<LoadState<Awaited<ReturnType<typeof fetchAddonStatus>>>>({
    loading: false,
    error: null,
    data: null,
  });

  const installedById = useMemo(
    () => new Map((data?.installed ?? []).map((item) => [item.addonId, item])),
    [data?.installed],
  );
  const selectedAddon = data?.catalog.find((item) => item.addonId === selectedAddonId) ?? data?.catalog[0] ?? null;

  useEffect(() => {
    if (!data?.catalog.length) {
      setSelectedAddonId("");
      return;
    }
    setSelectedAddonId((current) =>
      current && data.catalog.some((item) => item.addonId === current) ? current : data.catalog[0]?.addonId || "",
    );
  }, [data?.catalog]);

  useEffect(() => {
    if (!selectedAddon) {
      setStatus({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setStatus({ loading: true, error: null, data: null });
    void fetchAddonStatus(selectedAddon.addonId)
      .then((result) => {
        if (!cancelled) {
          setStatus({ loading: false, error: null, data: result });
        }
      })
      .catch((loadError: Error) => {
        if (!cancelled) {
          setStatus({ loading: false, error: loadError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAddon]);

  const runAddonAction = async (operation: () => Promise<unknown>, successMessage: string) => {
    try {
      await operation();
      setNotice({ tone: "success", message: successMessage });
      await reload();
      if (selectedAddon) {
        const nextStatus = await fetchAddonStatus(selectedAddon.addonId);
        setStatus({ loading: false, error: null, data: nextStatus });
      }
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid>
          <SettingsPanel
            title="Add-on catalog"
            subtitle="Optional add-on runtimes and their current install posture."
            stats={[
              { label: "Catalog", value: String(data.catalog.length) },
              { label: "Installed", value: String(data.installed.length) },
            ]}
          >
            <SettingsSelectableList
              items={data.catalog.map((item) => ({
                id: item.addonId,
                title: item.label,
                meta: item.trustTier,
                body: `${item.category} · ${installedById.has(item.addonId) ? "installed" : "not installed"}`,
              }))}
              selectedId={selectedAddonId}
              onSelect={setSelectedAddonId}
              emptyLabel="No add-ons returned from the catalog."
            />
          </SettingsPanel>
          <SettingsPanel
            title={selectedAddon?.label ?? "Add-on detail"}
            subtitle="Install, update, launch, stop, or remove the selected add-on."
          >
            {selectedAddon ? (
              <>
                <SettingsCodeBlock label="Description">{selectedAddon.description}</SettingsCodeBlock>
                <SettingsMetricGrid
                  items={[
                    { label: "Trust tier", value: selectedAddon.trustTier, meta: selectedAddon.owner },
                    {
                      label: "Runtime",
                      value:
                        status.data?.status ??
                        installedById.get(selectedAddon.addonId)?.runtimeStatus ??
                        "not_installed",
                      meta: selectedAddon.runtimeType,
                    },
                    {
                      label: "Web entry",
                      value: selectedAddon.webEntryMode,
                      meta: selectedAddon.launchUrl ?? "No launch URL",
                    },
                  ]}
                />
                <SettingsButtonRow>
                  <button
                    type="button"
                    className="mc-next-button"
                    onClick={() =>
                      void runAddonAction(
                        () => installAddon(selectedAddon.addonId, { confirmRepoDownload: true, actorId: "operator" }),
                        `${selectedAddon.label} install requested.`,
                      )
                    }
                  >
                    <Plus size={16} />
                    Install
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    onClick={() =>
                      void runAddonAction(
                        () => updateAddon(selectedAddon.addonId),
                        `${selectedAddon.label} update requested.`,
                      )
                    }
                  >
                    <RefreshCw size={16} />
                    Update
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    onClick={() =>
                      void runAddonAction(
                        () => launchAddon(selectedAddon.addonId),
                        `${selectedAddon.label} launch requested.`,
                      )
                    }
                  >
                    <Play size={16} />
                    Launch
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    onClick={() =>
                      void runAddonAction(
                        () => stopAddon(selectedAddon.addonId),
                        `${selectedAddon.label} stop requested.`,
                      )
                    }
                  >
                    <Square size={16} />
                    Stop
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-danger"
                    onClick={() => {
                      if (!window.confirm(`Uninstall ${selectedAddon.label}?`)) {
                        return;
                      }
                      void runAddonAction(
                        () => uninstallAddon(selectedAddon.addonId),
                        `${selectedAddon.label} uninstalled.`,
                      );
                    }}
                  >
                    <Trash2 size={16} />
                    Uninstall
                  </button>
                </SettingsButtonRow>
                <SettingsActionList
                  items={selectedAddon.installCommands.map((item) => ({
                    label: item.command,
                    description: item.note || "Install command",
                    meta: item.args?.join(" ") || "No args",
                  }))}
                />
                {status.data?.healthChecks.length ? (
                  <SettingsActionList
                    items={status.data.healthChecks.map((item) => ({
                      label: item.key,
                      description: item.message,
                      meta: item.status,
                    }))}
                  />
                ) : null}
              </>
            ) : (
              <SettingsEmptyState label="Choose an add-on from the catalog." />
            )}
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function useAsyncLoad<T>(loader: () => Promise<T>) {
  const [state, setState] = useState<LoadState<T>>({
    loading: true,
    error: null,
    data: null,
  });

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await loader();
      setState({
        loading: false,
        error: null,
        data,
      });
    } catch (error) {
      setState({
        loading: false,
        error: getErrorMessage(error),
        data: null,
      });
    }
  }, [loader]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    ...state,
    reload,
  };
}

function SettingsPageFrame({
  icon: Icon,
  kicker,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  kicker: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="mc-next-directory-page">
      <header className="mc-next-directory-header">
        <div className="mc-next-directory-icon">
          <Icon className="h-5 w-5" />
        </div>
        <div className="mc-next-directory-copy">
          <p>{kicker}</p>
          <h1>{title}</h1>
          <span>{description}</span>
        </div>
      </header>
      {children}
    </section>
  );
}

function SettingsSectionShell({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: string | null;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="mc-next-settings-loading">
        <BlocksShuffleLoader label="Loading current route data…" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="mc-next-directory-alert">
        <AlertTriangle className="h-4 w-4" />
        <span>{error}</span>
      </div>
    );
  }
  return <>{children}</>;
}

function SettingsGrid({ children }: { children: ReactNode }) {
  return <div className="mc-next-settings-grid">{children}</div>;
}

function SettingsStack({ children }: { children: ReactNode }) {
  return <div className="mc-next-settings-stack">{children}</div>;
}

function SettingsPanel({
  title,
  subtitle,
  stats,
  children,
}: {
  title: string;
  subtitle: string;
  stats?: Array<{ label: string; value: string }>;
  children: ReactNode;
}) {
  return (
    <article className="mc-next-directory-card mc-next-settings-panel">
      <div className="mc-next-directory-card-head">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        {stats?.length ? (
          <div className="mc-next-directory-stats">
            {stats.map((item) => (
              <div key={`${item.label}-${item.value}`}>
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="mc-next-settings-panel-body">{children}</div>
    </article>
  );
}

function SettingsFieldGrid({ children }: { children: ReactNode }) {
  return <div className="mc-next-settings-field-grid">{children}</div>;
}

function SettingsField({ label, children, span = 1 }: { label: string; children: ReactNode; span?: 1 | 2 }) {
  return (
    <label className={`mc-next-settings-field${span === 2 ? " span-2" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function SettingsButtonRow({ children }: { children: ReactNode }) {
  return <div className="mc-next-settings-button-row">{children}</div>;
}

function SettingsMetricGrid({ items }: { items: Array<{ label: string; value: string; meta?: string }> }) {
  return (
    <div className="mc-next-settings-metric-grid">
      {items.map((item) => (
        <div key={`${item.label}-${item.value}`} className="mc-next-settings-metric">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          {item.meta ? <p>{item.meta}</p> : null}
        </div>
      ))}
    </div>
  );
}

function SettingsSelectableList({
  items,
  selectedId,
  onSelect,
  emptyLabel,
}: {
  items: Array<{ id: string; title: string; meta?: string; body?: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
  emptyLabel: string;
}) {
  if (!items.length) {
    return <SettingsEmptyState label={emptyLabel} />;
  }
  return (
    <div className="mc-next-settings-selectable-list">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`mc-next-settings-selectable${selectedId === item.id ? " active" : ""}`}
          onClick={() => onSelect(item.id)}
        >
          <div className="mc-next-settings-selectable-head">
            <strong>{item.title}</strong>
            {item.meta ? <span>{item.meta}</span> : null}
          </div>
          {item.body ? <p>{item.body}</p> : null}
        </button>
      ))}
    </div>
  );
}

function SettingsActionList({
  items,
  emptyLabel = "Nothing here yet.",
}: {
  items: Array<{
    id?: string;
    label: string;
    description: string;
    meta?: string;
    actionLabel?: string;
    onClick?: () => void;
  }>;
  emptyLabel?: string;
}) {
  if (!items.length) {
    return <SettingsEmptyState label={emptyLabel} />;
  }
  return (
    <div className="mc-next-settings-action-list">
      {items.map((item) => (
        <div key={item.id ?? `${item.label}-${item.meta ?? ""}`} className="mc-next-settings-action-row">
          <div className="mc-next-settings-action-copy">
            <strong>{item.label}</strong>
            <p>{item.description}</p>
            {item.meta ? <span>{item.meta}</span> : null}
          </div>
          {item.onClick ? (
            <button type="button" className="mc-next-button-secondary" onClick={item.onClick}>
              {item.actionLabel ?? "Open"}
            </button>
          ) : item.actionLabel ? (
            <span className="mc-next-settings-chip">{item.actionLabel}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SettingsFilterBar({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="mc-next-settings-filter-bar">
      {options.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`mc-next-settings-filter${value === item.id ? " active" : ""}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function SettingsCodeBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mc-next-settings-code-block">
      <span>{label}</span>
      <pre>{children}</pre>
    </div>
  );
}

function SettingsEmptyState({ label }: { label: string }) {
  return <p className="mc-next-directory-empty">{label}</p>;
}

function SettingsNotice({ notice }: { notice: Notice }) {
  return <div className={`mc-next-settings-notice ${notice.tone}`}>{notice.message}</div>;
}

function DiagnosticsPanel({ report }: { report: ConnectorDiagnosticReport }) {
  return (
    <SettingsPanel title="Diagnostics" subtitle={`Status: ${report.status}`}>
      <SettingsActionList
        items={report.checks.map((check) => ({
          label: check.key,
          description: check.message,
          meta: check.status,
        }))}
      />
      {report.recommendedNextAction ? (
        <SettingsCodeBlock label="Recommended next action">{report.recommendedNextAction}</SettingsCodeBlock>
      ) : null}
    </SettingsPanel>
  );
}

function collectDefinitionFieldHints(definition: ChannelSetupDefinition) {
  const fields = definition.wizard.steps.flatMap((step) => step.fields ?? []);
  return fields.slice(0, 10).map((field) => ({
    label: field.label,
    explanation: field.explanation,
    type: field.type,
  }));
}

function matchesToolGrant(grant: ToolGrantRecord, toolName: string) {
  if (grant.toolPattern === toolName) {
    return true;
  }
  if (grant.toolPattern.endsWith("*")) {
    return toolName.startsWith(grant.toolPattern.slice(0, -1));
  }
  return false;
}

function parseJsonObject(value: string, fallback: Record<string, unknown> = {}) {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Value must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function formatJson(value: Record<string, unknown>) {
  return JSON.stringify(value, null, 2);
}

function formatCapabilities(
  capabilities:
    | {
        vision?: boolean;
        audio?: boolean;
        video?: boolean;
        toolCalling?: boolean;
        jsonMode?: boolean;
        webSearch?: boolean;
        reasoning?: boolean;
        voiceInput?: boolean;
        voiceOutput?: boolean;
        imageGenerate?: boolean;
        imageEdit?: boolean;
        artifacts?: boolean;
      }
    | undefined,
) {
  if (!capabilities) {
    return "No capability metadata";
  }
  const enabled = Object.entries(capabilities)
    .filter((entry) => entry[1])
    .map((entry) => entry[0]);
  return enabled.length ? enabled.join(", ") : "No advertised capabilities";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function deriveLlamaCppAlias(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  const filename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return filename.replace(/\.(gguf|bin)$/i, "") || trimmed;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "Unknown";
  }
  return new Date(parsed).toLocaleString();
}

function iconForSettingsSection(section: SettingsSection) {
  switch (section) {
    case "providers":
      return SlidersHorizontal;
    case "access":
      return ShieldCheck;
    case "runtime":
      return Gauge;
    case "workspaces":
      return HardDrive;
    case "integrations":
      return Cable;
    case "channels":
      return Plug2;
    case "mcp":
      return Server;
    case "tools":
      return Wrench;
    case "addons":
      return Package2;
    default:
      return SlidersHorizontal;
  }
}

function labelForSettingsSection(section: SettingsSection) {
  switch (section) {
    case "providers":
      return "Providers";
    case "access":
      return "Access";
    case "runtime":
      return "Runtime";
    case "workspaces":
      return "Workspaces";
    case "integrations":
      return "Integrations";
    case "channels":
      return "Channels";
    case "mcp":
      return "MCP";
    case "tools":
      return "Tools";
    case "addons":
      return "Add-ons";
    default:
      return "General";
  }
}

function descriptionForSettingsSection(section: SettingsSection) {
  switch (section) {
    case "providers":
      return "Choose active routing, inspect provider posture, and manage secrets.";
    case "access":
      return "Manage gateway auth posture, install tokens, and device access.";
    case "runtime":
      return "Configure local runtimes and control the processes behind them.";
    case "workspaces":
      return "Create, edit, archive, restore, and switch workspace context.";
    case "integrations":
      return "Create and maintain external product and automation connections.";
    case "channels":
      return "Run setup drafts for channel connections, validate them, and finalize.";
    case "mcp":
      return "Manage MCP servers, templates, transport config, and tool visibility.";
    case "tools":
      return "Review the tool catalog and manage grants from one place.";
    case "addons":
      return "Install and control optional add-on runtimes and their health.";
    default:
      return "Focused next-native settings instead of placeholder summaries.";
  }
}
