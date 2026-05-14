/* eslint-disable max-lines -- SettingsNativePage intentionally keeps the new settings routes in one editable module while the product surface is still settling. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { providerTemplates, type CapabilityPackPreview } from "@goatcitadel/contracts";
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  Gauge,
  HardDrive,
  KeyRound,
  ExternalLink,
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
  Sparkles,
  Square,
  Trash2,
  Wrench,
} from "lucide-react";
import { BlocksShuffleLoader } from "../../components/BlocksShuffleLoader";
import type {
  ChannelSetupDefinition,
  ConnectorDiagnosticReport,
  GoogleMeetPrerequisiteStatusResponse,
  GoogleMeetSessionRecord,
  IntegrationPluginRecord,
  IntegrationFormSchema,
  McpServerRecord,
  OnboardingState,
  PersonalityPreset,
  PersonalityPresetCategory,
  ToolApprovalMode,
  ToolGrantRecord,
} from "@goatcitadel/contracts";
import {
  archiveWorkspace,
  bootstrapOnboarding,
  completeOnboarding,
  connectMcpServer,
  createChannelSetupDraft,
  createIntegrationConnection,
  createMcpServer,
  createPersonality,
  createToolGrant,
  createWorkspace,
  deleteOpenAICodexOAuthCredential,
  deleteIntegrationConnection,
  deleteMcpServer,
  deletePersonality,
  deleteProviderSecret,
  disconnectMcpServer,
  fetchAddonStatus,
  fetchAddonsCatalog,
  bootstrapDemo,
  fetchCapabilityPackPreview,
  fetchCapabilityPacks,
  fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts,
  discoverTelegramTargets,
  fetchDaemonStatus,
  fetchDeviceAccessGrants,
  fetchInstalledAddons,
  fetchIntegrationCatalog,
  fetchIntegrationConnectionDiagnostics,
  fetchIntegrationConnections,
  fetchIntegrationFormSchema,
  fetchIntegrationPlugins,
  fetchGoogleMeetPrerequisiteStatus,
  fetchGoogleMeetSessions,
  fetchSlackOAuthStatus,
  fetchLlamaCppModels,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchMcpTools,
  fetchNpuModels,
  fetchOpenAICodexOAuthStatus,
  fetchOnboardingState,
  fetchPersonalities,
  fetchDemoState,
  fetchProviderSecretStatus,
  fetchSettings,
  fetchToolCatalog,
  fetchToolGrants,
  fetchVoiceRuntimeStatus,
  fetchWorkspaces,
  finalizeChannelSetupDraft,
  installAddon,
  installCapabilityPack,
  installVoiceRuntime,
  invokeIntegrationConnectionAction,
  launchAddon,
  patchSettings,
  pollOpenAICodexOAuthDeviceFlow,
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
  setDefaultPersonality,
  startDaemon,
  startSlackOAuth,
  startOpenAICodexOAuthDeviceFlow,
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
  updatePersonality,
  updateWorkspace,
  validateChannelSetupDraft,
  type IntegrationConnection,
  type OpenAICodexDeviceStartResponse,
  type OpenAICodexDevicePollResponse,
  type OpenAICodexOAuthStatus,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfigFormBuilder } from "@goatcitadel/mission-control-shared/components/ConfigFormBuilder";
import {
  LlmTransportFields,
  createEmptyLlmTransportDraft,
  draftFromRequestConfig,
  requestConfigFromDraft,
} from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import type { AppRoute } from "@next/app/route-model";
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

type NativeLoadIssue = {
  label: string;
  message: string;
};

type NativeLoadResult<T> = {
  data: T;
  issue: NativeLoadIssue | null;
};

const TOOL_APPROVAL_MODE_OPTIONS: ToolApprovalMode[] = ["approve_all", "approve_risky", "bypass"];
const BUDGET_MODE_OPTIONS: Array<OnboardingState["settings"]["budgetMode"]> = ["saver", "balanced", "power"];
const VISUAL_REGRESSION_MODE =
  (import.meta.env.VITE_GOATCITADEL_VISUAL_REGRESSION_MODE as string | undefined)?.trim().toLowerCase() === "true";
const PERSONALITY_CATEGORY_OPTIONS: PersonalityPresetCategory[] = [
  "core",
  "critical",
  "execution",
  "social",
  "thinking",
  "flavor",
  "chaos",
];
const INTERNAL_APPROVAL_INBOX_URL = "goatcitadel://approval-inbox";

type SettingsSectionProps = SettingsNativePageProps & {
  section: string;
};

export function SettingsNativePage(props: SettingsNativePageProps) {
  const section = props.route.section ? String(props.route.section) : "general";

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
    case "general":
      return <GeneralSection {...props} />;
    case "onboarding":
      return <OnboardingSection {...props} />;
    case "budget":
      return <BudgetSection {...props} />;
    case "providers":
      return <ProvidersSection {...props} />;
    case "personalities":
      return <PersonalitiesSection {...props} />;
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
      return <UnknownSettingsSection {...props} />;
  }
}

function GeneralSection({ activeWorkspaceName, route, navigate }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [settings, workspaces, integrations, mcpServers, tools, addons] = await Promise.all([
      nativeLoad("Settings", fetchSettings(), null),
      nativeLoad("Workspaces", fetchWorkspaces("all", 400), { items: [] }),
      nativeLoad("Integrations", fetchIntegrationConnections(), { items: [] }),
      nativeLoad("MCP servers", fetchMcpServers(), { items: [] }),
      nativeLoad("Tools", fetchToolCatalog(), { items: [] }),
      nativeLoad("Add-ons", fetchInstalledAddons(), { items: [] }),
    ]);
    return {
      issues: nativeLoadIssues([settings, workspaces, integrations, mcpServers, tools, addons]),
      settings: settings.data,
      workspaces: workspaces.data.items,
      integrations: integrations.data.items,
      mcpServers: mcpServers.data.items,
      tools: tools.data.items,
      addons: addons.data.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {data ? (
        <SettingsGrid variant="three-column">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
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
                  label: "Personalities",
                  description: "Edit Chat tone presets and choose the global Chat default.",
                  onClick: () => navigate({ area: "settings", section: "personalities", theme: route.theme }),
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

function OnboardingSection({ route, navigate, setActiveWorkspaceId }: SettingsSectionProps) {
  const load = useCallback(async () => fetchOnboardingState(), []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [defaultsDraft, setDefaultsDraft] = useState<{
    toolApprovalMode: ToolApprovalMode;
    budgetMode: OnboardingState["settings"]["budgetMode"];
    networkAllowlist: string;
  }>({
    toolApprovalMode: "approve_risky",
    budgetMode: "balanced",
    networkAllowlist: "",
  });

  useEffect(() => {
    if (!data) {
      return;
    }
    setDefaultsDraft({
      toolApprovalMode: normalizeToolApprovalMode(data.settings.toolApprovalMode),
      budgetMode: normalizeBudgetMode(data.settings.budgetMode),
      networkAllowlist: data.settings.networkAllowlist.join(", "),
    });
  }, [data]);

  const applyDefaults = async () => {
    try {
      await bootstrapOnboarding({
        toolApprovalMode: defaultsDraft.toolApprovalMode,
        budgetMode: defaultsDraft.budgetMode,
        networkAllowlist: splitCommaList(defaultsDraft.networkAllowlist),
      });
      setNotice({ tone: "success", message: "First-run defaults applied." });
      await reload();
    } catch (defaultsError) {
      setNotice({ tone: "error", message: getErrorMessage(defaultsError) });
    }
  };

  const markComplete = async () => {
    try {
      await completeOnboarding("operator");
      setNotice({ tone: "success", message: "Onboarding marked complete." });
      await reload();
    } catch (completeError) {
      setNotice({ tone: "error", message: getErrorMessage(completeError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="detail-wide">
          <DemoStartPanel route={route} navigate={navigate} setActiveWorkspaceId={setActiveWorkspaceId} />
          <SetupCenterPanel route={route} navigate={navigate} onboarding={data} />
          <SettingsPanel
            title="First-run setup"
            subtitle="Live readiness for the first trustworthy send."
            stats={[
              { label: "Status", value: data.completed ? "Complete" : "Open" },
              { label: "Provider", value: data.settings.llm.activeProviderId || "Unset" },
              { label: "Model", value: data.settings.llm.activeModel || "Unset" },
            ]}
          >
            <SettingsWizardSteps
              steps={data.checklist.map((item) => ({
                label: item.label,
                description: item.detail ?? item.status,
                state: item.status === "complete" ? "complete" : item.status === "optional" ? "pending" : "active",
              }))}
            />
            <SettingsActionList
              items={[
                {
                  label: "Configure providers",
                  description: "Select the active provider/model and choose where provider secrets are stored.",
                  onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
                },
                {
                  label: "Check local runtimes",
                  description: "Inspect daemon, llama.cpp, NPU, and voice runtime readiness before sending work.",
                  onClick: () => navigate({ area: "settings", section: "runtime", theme: route.theme }),
                },
                {
                  label: "Review access",
                  description:
                    "Confirm gateway auth posture, install tokens, and device access before exposing the app.",
                  onClick: () => navigate({ area: "settings", section: "access", theme: route.theme }),
                },
              ]}
            />
          </SettingsPanel>
          <SettingsPanel
            title="Apply first-run defaults"
            subtitle="Set the minimum runtime defaults without duplicating advanced setup."
          >
            <SettingsFieldGrid>
              <SettingsField label="Tool approvals">
                <select
                  className="mc-next-settings-input"
                  value={defaultsDraft.toolApprovalMode}
                  onChange={(event) =>
                    setDefaultsDraft((current) => ({
                      ...current,
                      toolApprovalMode: normalizeToolApprovalMode(event.target.value),
                    }))
                  }
                >
                  {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
                    <option key={mode} value={mode}>
                      {describeToolApprovalMode(mode)}
                    </option>
                  ))}
                </select>
              </SettingsField>
              <SettingsField label="Budget mode">
                <select
                  className="mc-next-settings-input"
                  value={defaultsDraft.budgetMode}
                  onChange={(event) =>
                    setDefaultsDraft((current) => ({ ...current, budgetMode: normalizeBudgetMode(event.target.value) }))
                  }
                >
                  {BUDGET_MODE_OPTIONS.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </SettingsField>
              <SettingsField label="Network allowlist" span={2}>
                <input
                  className="mc-next-settings-input"
                  value={defaultsDraft.networkAllowlist}
                  onChange={(event) =>
                    setDefaultsDraft((current) => ({ ...current, networkAllowlist: event.target.value }))
                  }
                  placeholder="example.com, api.example.com"
                />
              </SettingsField>
            </SettingsFieldGrid>
            <SettingsMetricGrid
              items={[
                {
                  label: "Auth",
                  value: data.settings.auth.mode,
                  meta: data.settings.auth.tokenConfigured ? "token configured" : "no token configured",
                },
                {
                  label: "Mesh",
                  value: data.settings.mesh.enabled ? data.settings.mesh.mode : "off",
                  meta: data.settings.mesh.nodeId || "no node id",
                },
              ]}
            />
            <SettingsButtonRow>
              <button type="button" className="mc-next-button" onClick={() => void applyDefaults()}>
                <Save size={16} />
                Apply defaults
              </button>
              <button type="button" className="mc-next-button-secondary" onClick={() => void markComplete()}>
                <CheckCircle2 size={16} />
                Mark complete
              </button>
              <button type="button" className="mc-next-button-secondary" onClick={() => void reload()}>
                <RefreshCw size={16} />
                Refresh
              </button>
            </SettingsButtonRow>
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function DemoStartPanel({
  route,
  navigate,
  setActiveWorkspaceId,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
  setActiveWorkspaceId: (workspaceId: string) => void;
}) {
  const load = useCallback(async () => fetchDemoState(), []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const startDemo = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await bootstrapDemo();
      if (result.workspace?.workspaceId) {
        setActiveWorkspaceId(result.workspace.workspaceId);
      }
      const nextSession =
        result.sessions.find((item) => item.mode === "cowork") ??
        result.sessions.find((item) => item.mode === "chat") ??
        result.sessions[0];
      setNotice({ tone: result.status === "ready" ? "success" : "warning", message: result.notes[0] ?? "Demo ready." });
      await reload();
      navigate({
        area: nextSession?.mode === "code" ? "code" : nextSession?.mode === "chat" ? "chat" : "cowork",
        sessionId: nextSession?.sessionId,
        theme: route.theme,
      });
    } catch (demoError) {
      setNotice({ tone: "error", message: getErrorMessage(demoError) });
    } finally {
      setBusy(false);
    }
  };

  const promptPreview = data?.starterPrompts.slice(0, 3) ?? [];
  const workspaceLabel = data?.workspace?.name ?? "Not created";

  return (
    <SettingsPanel
      title="Start Here"
      subtitle="Create a safe local demo workspace with sample Chat, Cowork, Code, and memory data."
      stats={[
        { label: "Demo", value: loading ? "Checking" : (data?.status ?? "Unknown") },
        { label: "Workspace", value: workspaceLabel },
        { label: "Credentials", value: "Not required" },
      ]}
    >
      {notice ? <SettingsNotice notice={notice} /> : null}
      {error ? (
        <div className="mc-next-directory-alert">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : null}
      <SettingsWizardSteps
        steps={[
          {
            label: "Safe demo workspace",
            description: data?.workspace
              ? "Existing demo workspace will be reused."
              : "Creates a local-only workspace with no provider or channel credentials.",
            state: data?.workspace ? "complete" : "active",
          },
          {
            label: "Sample mission",
            description: "Seeds a Cowork run and Code review scenario you can inspect without sending messages.",
            state: data?.sessions.length ? "complete" : "active",
          },
          {
            label: "Trust proof",
            description: "Adds starter prompts and a memory example so Guided mode has something concrete to explain.",
            state: data?.status === "ready" ? "complete" : "pending",
          },
        ]}
      />
      <SettingsActionList
        items={promptPreview.map((prompt) => ({
          id: `${prompt.surface}-${prompt.title}`,
          label: prompt.title,
          description: prompt.prompt,
          meta: prompt.surface,
          actionLabel: "Sample",
        }))}
        emptyLabel="Starter prompts will appear after the demo state loads."
      />
      <SettingsButtonRow>
        <button type="button" className="mc-next-button" onClick={() => void startDemo()} disabled={busy}>
          <Play size={16} />
          {data?.status === "ready" ? "Open demo" : "Start safe demo"}
        </button>
        <button type="button" className="mc-next-button-secondary" onClick={() => void reload()} disabled={busy}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </SettingsButtonRow>
    </SettingsPanel>
  );
}

function SetupCenterPanel({
  route,
  navigate,
  onboarding,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
  onboarding: OnboardingState;
}) {
  const items = deriveSetupCenterItems(onboarding);
  const readyCount = items.filter((item) => item.state === "complete").length;
  const needsInputCount = items.filter((item) => item.state === "active").length;

  return (
    <SettingsPanel
      title="Setup Center"
      subtitle="One checklist for providers, local runtimes, channels, tools, database posture, and packaging readiness."
      stats={[
        { label: "Ready", value: String(readyCount) },
        { label: "Needs input", value: String(needsInputCount) },
        { label: "Mode", value: onboarding.completed ? "Complete" : "Guided" },
      ]}
    >
      <SettingsWizardSteps steps={items.map(({ label, description, state }) => ({ label, description, state }))} />
      <SettingsActionList
        items={[
          {
            label: "Provider smoke tests",
            description: "Verify configured model providers and exact key/source status.",
            meta: setupMeta(onboarding.checklist.find((item) => item.id === "llm")?.status),
            onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
          },
          {
            label: "Runtime health",
            description: "Check daemon, database, llama.cpp, NPU, voice, and local runtime readiness.",
            meta: setupMeta(onboarding.checklist.find((item) => item.id === "runtime")?.status),
            onClick: () => navigate({ area: "settings", section: "runtime", theme: route.theme }),
          },
          {
            label: "Channels and MCP",
            description: "Configure Slack, Telegram, Discord, MCP servers, and tool access from one path.",
            meta: "Optional until connected",
            onClick: () => navigate({ area: "settings", section: "channels", theme: route.theme }),
          },
          {
            label: "Capabilities",
            description: "Inspect skills, tools, providers, generated candidates, and degraded capabilities.",
            meta: "Catalog view",
            onClick: () => navigate({ area: "library", section: "capabilities", theme: route.theme }),
          },
        ]}
      />
    </SettingsPanel>
  );
}

function BudgetSection({ route, navigate }: SettingsSectionProps) {
  return (
    <SettingsGrid>
      <SettingsPanel
        title="Budget controls"
        subtitle="Cost and usage controls live in Ops for this build; this route is intentionally explicit."
        stats={[
          { label: "Status", value: "Ops" },
          { label: "Routing", value: "Providers" },
        ]}
      >
        <SettingsActionList
          items={[
            {
              label: "Open cost telemetry",
              description: "Review provider usage and budget-facing runtime evidence in Ops.",
              onClick: () => navigate({ area: "ops", section: "costs", theme: route.theme }),
            },
            {
              label: "Tune provider routing",
              description: "Change active model routing where cost, latency, and fallback choices are made.",
              onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
            },
          ]}
        />
      </SettingsPanel>
      <SettingsPanel
        title="Release boundary"
        subtitle="This page exists so deep links do not silently land on General settings."
      >
        <SettingsActionList
          items={[
            {
              label: "No silent fallback",
              description: "Budget deep links must resolve to budget guidance, not unrelated General settings.",
              actionLabel: "Handled",
            },
          ]}
        />
      </SettingsPanel>
    </SettingsGrid>
  );
}

function UnknownSettingsSection({ section, route, navigate }: SettingsSectionProps) {
  return (
    <SettingsGrid>
      <SettingsPanel
        title="Unknown settings section"
        subtitle={`No next-native settings section is registered for "${String(section)}".`}
      >
        <SettingsActionList
          items={[
            {
              label: "Open General",
              description: "Return to the settings overview.",
              onClick: () => navigate({ area: "settings", section: "general", theme: route.theme }),
            },
            {
              label: "Open Providers",
              description: "Jump to the provider/model route used by Chat, Cowork, and Code.",
              onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
            },
          ]}
        />
      </SettingsPanel>
    </SettingsGrid>
  );
}

type PersonalityEditorDraft = {
  id: string;
  label: string;
  category: PersonalityPresetCategory;
  description: string;
  tone: string;
  style: string;
  systemOverlay: string;
  safetyNotes: string;
};

function PersonalitiesSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => fetchPersonalities(), []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedPersonalityId, setSelectedPersonalityId] = useState("");
  const [editorMode, setEditorMode] = useState<"selected" | "new">("selected");
  const [draft, setDraft] = useState<PersonalityEditorDraft>(() => createEmptyPersonalityEditorDraft());
  const selectedPersonality = data?.items.find((item) => item.id === selectedPersonalityId) ?? data?.items[0] ?? null;
  const defaultPersonalityId = data?.defaultPersonalityId ?? "default";
  const customCount = data?.items.filter((item) => !item.builtin).length ?? 0;
  const modifiedBuiltinCount = data?.items.filter((item) => item.builtin && item.modified).length ?? 0;
  const editorLocked = editorMode === "selected" && (!selectedPersonality || selectedPersonality.editable === false);
  const editingBuiltin = editorMode === "selected" && selectedPersonality?.builtin === true;
  const canSave = editorMode === "new" || !editorLocked;

  useEffect(() => {
    if (!data?.items.length) {
      setSelectedPersonalityId("");
      return;
    }
    setSelectedPersonalityId((current) =>
      current && data.items.some((item) => item.id === current) ? current : data.defaultPersonalityId,
    );
  }, [data?.defaultPersonalityId, data?.items]);

  useEffect(() => {
    if (editorMode === "new") {
      return;
    }
    setDraft(createPersonalityEditorDraft(selectedPersonality));
  }, [editorMode, selectedPersonality]);

  const beginCustomPersonality = () => {
    setEditorMode("new");
    setDraft(createEmptyPersonalityEditorDraft());
    setNotice(null);
  };

  const savePersonality = async () => {
    const input = personalityDraftToMutationInput(draft);
    if (!input.label) {
      setNotice({ tone: "warning", message: "Personality label is required." });
      return;
    }
    try {
      if (editorMode === "new") {
        const nextId = normalizePersonalityEditorId(input.id || input.label);
        await createPersonality(input);
        setNotice({ tone: "success", message: "Custom personality created." });
        await reload();
        setEditorMode("selected");
        setSelectedPersonalityId(nextId);
        return;
      }
      if (!selectedPersonality || selectedPersonality.editable === false) {
        setNotice({ tone: "warning", message: "This personality cannot be edited." });
        return;
      }
      const nextId = selectedPersonality.builtin
        ? selectedPersonality.id
        : normalizePersonalityEditorId(input.id || selectedPersonality.id);
      await updatePersonality(selectedPersonality.id, input);
      setNotice({ tone: "success", message: `${selectedPersonality.label} saved.` });
      await reload();
      setSelectedPersonalityId(nextId);
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const makeDefault = async () => {
    if (!selectedPersonality) {
      return;
    }
    try {
      await setDefaultPersonality(selectedPersonality.id);
      setNotice({
        tone: "success",
        message:
          selectedPersonality.id === "default"
            ? "Chat personality cleared."
            : `${selectedPersonality.label} is now the global Chat default.`,
      });
      await reload();
    } catch (defaultError) {
      setNotice({ tone: "error", message: getErrorMessage(defaultError) });
    }
  };

  const removeOrResetPersonality = async () => {
    if (!selectedPersonality || selectedPersonality.id === "default") {
      return;
    }
    if (!selectedPersonality.builtin && !window.confirm(`Remove ${selectedPersonality.label}?`)) {
      return;
    }
    try {
      await deletePersonality(selectedPersonality.id);
      setNotice({
        tone: "success",
        message: selectedPersonality.builtin
          ? `${selectedPersonality.label} reset to the shipped preset.`
          : `${selectedPersonality.label} removed.`,
      });
      await reload();
      setSelectedPersonalityId(selectedPersonality.builtin ? selectedPersonality.id : "default");
      setEditorMode("selected");
    } catch (removeError) {
      setNotice({ tone: "error", message: getErrorMessage(removeError) });
    }
  };

  const updateDraft = <K extends keyof PersonalityEditorDraft>(key: K, value: PersonalityEditorDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="detail-wide">
          <SettingsPanel
            title="Personality catalog"
            subtitle="Built-in presets, custom overlays, and the global Chat default."
            scrollBody
            bodyMaxHeight="min(64vh, 38rem)"
            stats={[
              { label: "Presets", value: String(data.items.length) },
              { label: "Custom", value: String(customCount) },
              { label: "Modified", value: String(modifiedBuiltinCount) },
            ]}
          >
            <SettingsButtonRow>
              <button type="button" className="mc-next-button" onClick={beginCustomPersonality}>
                <Plus size={16} />
                Add custom personality
              </button>
              <button type="button" className="mc-next-button-secondary" onClick={() => void reload()}>
                <RefreshCw size={16} />
                Refresh
              </button>
            </SettingsButtonRow>
            <SettingsSelectableList
              items={data.items.map((item) => ({
                id: item.id,
                title: item.label,
                meta: formatPersonalityStatus(item, defaultPersonalityId),
                body: `${formatPersonalityCategoryLabel(item.category)} · ${item.tone || "No tone"} · ${
                  item.description || "No description"
                }`,
              }))}
              selectedId={editorMode === "new" ? "" : selectedPersonalityId}
              onSelect={(id) => {
                setEditorMode("selected");
                setSelectedPersonalityId(id);
              }}
              emptyLabel="No personalities returned from the gateway."
              maxHeight="min(48vh, 28rem)"
            />
          </SettingsPanel>
          <SettingsPanel
            title={
              editorMode === "new" ? "New custom personality" : (selectedPersonality?.label ?? "Personality editor")
            }
            subtitle={
              editorMode === "new"
                ? "Create a persisted custom Chat overlay."
                : "Edit tone fields, reset built-ins, or set the global Chat default."
            }
          >
            {editorMode === "new" || selectedPersonality ? (
              <>
                <SettingsFieldGrid>
                  <SettingsField label="ID">
                    <input
                      className="mc-next-settings-input"
                      value={draft.id}
                      disabled={editorLocked || editingBuiltin}
                      onChange={(event) => updateDraft("id", event.target.value)}
                      placeholder="direct-operator"
                    />
                  </SettingsField>
                  <SettingsField label="Label">
                    <input
                      className="mc-next-settings-input"
                      value={draft.label}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("label", event.target.value)}
                      placeholder="Direct Operator"
                    />
                  </SettingsField>
                  <SettingsField label="Category">
                    <select
                      className="mc-next-settings-input"
                      value={draft.category}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("category", event.target.value as PersonalityPresetCategory)}
                    >
                      {PERSONALITY_CATEGORY_OPTIONS.map((category) => (
                        <option key={category} value={category}>
                          {formatPersonalityCategoryLabel(category)}
                        </option>
                      ))}
                    </select>
                  </SettingsField>
                  <SettingsField label="Tone">
                    <input
                      className="mc-next-settings-input"
                      value={draft.tone}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("tone", event.target.value)}
                      placeholder="Composed"
                    />
                  </SettingsField>
                  <SettingsField label="Style">
                    <input
                      className="mc-next-settings-input"
                      value={draft.style}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("style", event.target.value)}
                      placeholder="Operational and compact"
                    />
                  </SettingsField>
                  <SettingsField label="Description" span={2}>
                    <textarea
                      className="mc-next-settings-textarea"
                      value={draft.description}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("description", event.target.value)}
                      rows={3}
                    />
                  </SettingsField>
                  <SettingsField label="System overlay" span={2}>
                    <textarea
                      className="mc-next-settings-textarea mc-next-settings-code"
                      value={draft.systemOverlay}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("systemOverlay", event.target.value)}
                      rows={7}
                    />
                  </SettingsField>
                  <SettingsField label="Safety notes" span={2}>
                    <textarea
                      className="mc-next-settings-textarea"
                      value={draft.safetyNotes}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("safetyNotes", event.target.value)}
                      rows={4}
                    />
                  </SettingsField>
                </SettingsFieldGrid>
                <SettingsNotice
                  notice={{
                    tone: "info",
                    message:
                      "Personality overlays affect Chat tone and framing only; safety, privacy, memory, tools, approvals, and policy stay authoritative.",
                  }}
                />
                <SettingsButtonRow>
                  <button
                    type="button"
                    className="mc-next-button"
                    onClick={() => void savePersonality()}
                    disabled={!canSave}
                  >
                    <Save size={16} />
                    {editorMode === "new" ? "Create personality" : "Save edits"}
                  </button>
                  {editorMode === "selected" ? (
                    <button
                      type="button"
                      className="mc-next-button-secondary"
                      onClick={() => void makeDefault()}
                      disabled={!selectedPersonality}
                    >
                      <CheckCircle2 size={16} />
                      {selectedPersonality?.id === "default" ? "Clear Chat default" : "Set as Chat default"}
                    </button>
                  ) : null}
                  {editorMode === "selected" && selectedPersonality?.id !== "default" ? (
                    <button
                      type="button"
                      className={selectedPersonality?.builtin ? "mc-next-button-secondary" : "mc-next-button-danger"}
                      onClick={() => void removeOrResetPersonality()}
                      disabled={selectedPersonality?.builtin === true && !selectedPersonality.modified}
                    >
                      {selectedPersonality?.builtin ? <RotateCcw size={16} /> : <Trash2 size={16} />}
                      {selectedPersonality?.builtin ? "Reset built-in" : "Remove custom"}
                    </button>
                  ) : null}
                  {editorMode === "new" ? (
                    <button
                      type="button"
                      className="mc-next-button-secondary"
                      onClick={() => {
                        setEditorMode("selected");
                        setDraft(createPersonalityEditorDraft(selectedPersonality));
                      }}
                    >
                      <RotateCcw size={16} />
                      Cancel
                    </button>
                  ) : null}
                </SettingsButtonRow>
              </>
            ) : (
              <SettingsEmptyState label="Choose a personality or create a custom one." />
            )}
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

type ProviderEditorDraft = {
  providerId: string;
  label: string;
  baseUrl: string;
  apiStyle: "openai-chat-completions" | "openai-responses" | "openai-codex-responses" | "anthropic-messages";
  defaultModel: string;
  apiKeyEnv: string;
};

type SettingsWizardStepState = "complete" | "active" | "pending";

const OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY = "goatcitadel:openai-codex:oauth-flow";
const OPENAI_CODEX_AUTH_HOST = "auth.openai.com";
const OPENAI_CODEX_MIN_POLL_MS = 1_000;
const OPENAI_CODEX_DEFAULT_POLL_MS = 5_000;

function createEmptyProviderEditorDraft(): ProviderEditorDraft {
  return {
    providerId: "",
    label: "",
    baseUrl: "",
    apiStyle: "openai-responses",
    defaultModel: "",
    apiKeyEnv: "",
  };
}

function buildProviderEditorDraft(
  provider?: {
    providerId: string;
    label: string;
    baseUrl: string;
    apiStyle?: "openai-chat-completions" | "openai-responses" | "openai-codex-responses" | "anthropic-messages";
    defaultModel: string;
    apiKeySource?: string;
    apiKeyRef?: string;
  } | null,
): ProviderEditorDraft {
  return {
    providerId: provider?.providerId ?? "",
    label: provider?.label ?? "",
    baseUrl: provider?.baseUrl ?? "",
    apiStyle: provider?.apiStyle ?? "openai-responses",
    defaultModel: provider?.defaultModel ?? "",
    apiKeyEnv: provider?.apiKeySource === "env" ? (provider.apiKeyRef ?? "") : "",
  };
}

function buildChatGptOAuthProviderDraft(): ProviderEditorDraft {
  const template = providerTemplates.find((item) => item.providerId === "openai-codex");
  return {
    providerId: template?.providerId ?? "openai-codex",
    label: template?.label ?? "OpenAI Codex (ChatGPT OAuth)",
    baseUrl: template?.baseUrl ?? "https://chatgpt.com/backend-api/codex",
    apiStyle: template?.apiStyle === "openai-codex-responses" ? template.apiStyle : "openai-codex-responses",
    defaultModel: template?.defaultModel ?? "gpt-5.5",
    apiKeyEnv: "",
  };
}

function isTrustedOpenAICodexVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === OPENAI_CODEX_AUTH_HOST;
  } catch {
    return false;
  }
}

function normalizeOpenAICodexPollDelayMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(value, OPENAI_CODEX_MIN_POLL_MS)
    : OPENAI_CODEX_DEFAULT_POLL_MS;
}

function isStoredOpenAICodexOAuthFlow(value: unknown): value is OpenAICodexDeviceStartResponse {
  const candidate = value as OpenAICodexDeviceStartResponse;
  const expiresAt = Date.parse(candidate?.expiresAt);
  const userCode = candidate?.userCode;
  return (
    candidate?.providerId === "openai-codex" &&
    typeof candidate.flowId === "string" &&
    candidate.flowId.trim().length > 0 &&
    typeof candidate.verificationUrl === "string" &&
    isTrustedOpenAICodexVerificationUrl(candidate.verificationUrl) &&
    (userCode === undefined || (typeof userCode === "string" && userCode.trim().length > 0)) &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() &&
    typeof candidate.pollAfterMs === "number" &&
    Number.isFinite(candidate.pollAfterMs) &&
    candidate.pollAfterMs > 0
  );
}

function removeStoredOpenAICodexOAuthFlow(storage: Storage | undefined): void {
  try {
    storage?.removeItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
}

function getBrowserStorage(kind: "localStorage" | "sessionStorage"): Storage | undefined {
  try {
    return globalThis[kind];
  } catch {
    return undefined;
  }
}

function readStoredOpenAICodexOAuthFlowFrom(storage: Storage | undefined): OpenAICodexDeviceStartResponse | null {
  try {
    const raw = storage?.getItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredOpenAICodexOAuthFlow(parsed)) {
      removeStoredOpenAICodexOAuthFlow(storage);
      return null;
    }
    return parsed;
  } catch {
    removeStoredOpenAICodexOAuthFlow(storage);
    return null;
  }
}

function readStoredOpenAICodexOAuthFlow(): OpenAICodexDeviceStartResponse | null {
  const sessionFlow = readStoredOpenAICodexOAuthFlowFrom(getBrowserStorage("sessionStorage"));
  const localFlow = readStoredOpenAICodexOAuthFlowFrom(getBrowserStorage("localStorage"));
  return sessionFlow ?? localFlow;
}

function writeStoredOpenAICodexOAuthFlow(flow: OpenAICodexDeviceStartResponse): void {
  try {
    getBrowserStorage("localStorage")?.setItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY, JSON.stringify(flow));
    getBrowserStorage("sessionStorage")?.setItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY, JSON.stringify(flow));
  } catch {
    // Browser storage is a convenience for refresh recovery; pairing still works without it.
  }
}

function clearStoredOpenAICodexOAuthFlow(): void {
  removeStoredOpenAICodexOAuthFlow(getBrowserStorage("localStorage"));
  removeStoredOpenAICodexOAuthFlow(getBrowserStorage("sessionStorage"));
}

function formatOpenAICodexOAuthExpiry(flow: OpenAICodexDeviceStartResponse | null): string | null {
  if (!flow) {
    return null;
  }
  const expiresAt = Date.parse(flow.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return null;
  }
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
  if (minutes > 240) {
    return null;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function isLikelyLocalProviderBaseUrl(baseUrl: string | undefined): boolean {
  const normalized = (baseUrl ?? "").trim().toLowerCase();
  return /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(normalized);
}

function formatProviderProbeStateLabel(value?: "not_checked" | "ready" | "fallback" | "empty" | "error"): string {
  switch (value) {
    case "ready":
      return "Verified";
    case "fallback":
      return "Suggested";
    case "empty":
      return "No models";
    case "error":
      return "Unreachable";
    default:
      return "Not checked";
  }
}

function formatProviderProbeSourceMeta(provider?: {
  modelProbeState?: "not_checked" | "ready" | "fallback" | "empty" | "error";
  modelProbeSource?: "live" | "template_fallback" | "error_fallback";
  modelProbeCheckedAt?: string;
  modelProbeWarning?: string;
}): string {
  if (!provider) {
    return "Not checked yet";
  }
  if (provider.modelProbeSource === "error_fallback") {
    return provider.modelProbeWarning
      ? `Fallback after probe error: ${provider.modelProbeWarning}`
      : "Fallback after probe error";
  }
  if (provider.modelProbeSource === "template_fallback" || provider.modelProbeState === "fallback") {
    return "Template suggestions; not account-verified";
  }
  return formatCheckedAtLabel(provider.modelProbeCheckedAt);
}

function formatCheckedAtLabel(value?: string): string {
  if (!value) {
    return "Not checked yet";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Last check unavailable";
  }
  return `Checked ${parsed.toLocaleString()}`;
}

function formatProviderCredentialLabel(
  providerId: string,
  hasApiKey: boolean | undefined,
  codexOAuthStatus: OpenAICodexOAuthStatus | null,
): string {
  if (providerId === "openai-codex") {
    if (codexOAuthStatus?.connected) {
      return "OAuth connected";
    }
    if (codexOAuthStatus?.requiresReauth) {
      return "OAuth reauth";
    }
    return "OAuth missing";
  }
  return hasApiKey ? "secret ready" : "secret missing";
}

function ProvidersSection({ activeWorkspaceId }: SettingsSectionProps) {
  const { config, providers, loading, error, reload, loadModelsForProvider, getCachedModelProbe } =
    useProviderModelCatalog("system");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [routingProviderId, setRoutingProviderId] = useState("");
  const [routingModel, setRoutingModel] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editorMode, setEditorMode] = useState<"selected" | "new">("selected");
  const [providerDraft, setProviderDraft] = useState<ProviderEditorDraft>(createEmptyProviderEditorDraft);
  const [providerTransportDraft, setProviderTransportDraft] = useState(createEmptyLlmTransportDraft);
  const [providerSaveBusy, setProviderSaveBusy] = useState(false);
  const [providerProbeBusyId, setProviderProbeBusyId] = useState<string | null>(null);
  const [codexOAuthStatus, setCodexOAuthStatus] = useState<OpenAICodexOAuthStatus | null>(null);
  const [codexOAuthFlow, setCodexOAuthFlow] = useState<OpenAICodexDeviceStartResponse | null>(
    readStoredOpenAICodexOAuthFlow,
  );
  const [codexOAuthBusy, setCodexOAuthBusy] = useState(false);
  const codexOAuthPollInFlightRef = useRef<string | null>(null);
  const codexOAuthStatusRequestIdRef = useRef(0);
  const [secretState, setSecretState] = useState<LoadState<Awaited<ReturnType<typeof fetchProviderSecretStatus>>>>({
    loading: false,
    error: null,
    data: null,
  });
  const providerConfigMap = useMemo(
    () => new Map((config?.providerConfigs ?? []).map((provider) => [provider.providerId, provider] as const)),
    [config?.providerConfigs],
  );
  const codexOAuthProvider = providers.find((item) => item.providerId === "openai-codex") ?? null;
  const selectedProvider = providers.find((item) => item.providerId === selectedProviderId) ?? providers[0] ?? null;
  const selectedProviderConfig = selectedProvider ? providerConfigMap.get(selectedProvider.providerId) : undefined;
  const availableModels = selectedProvider?.models ?? [];
  const routingProvider = providers.find((item) => item.providerId === routingProviderId) ?? null;
  const routingUsesFallbackModels = routingProvider?.modelProbeState === "fallback";
  const providerRequestValidation = useMemo(() => {
    try {
      return {
        request: requestConfigFromDraft(providerTransportDraft),
        error: null,
      };
    } catch (draftError) {
      return {
        request: undefined,
        error: getErrorMessage(draftError),
      };
    }
  }, [providerTransportDraft]);
  const selectedProviderIsLocal = isLikelyLocalProviderBaseUrl(selectedProvider?.baseUrl);
  const selectedProviderIsCodexOAuth = selectedProvider?.providerId === "openai-codex";
  const draftIsCodexOAuth = providerDraft.providerId.trim().toLowerCase() === "openai-codex";
  const hasCodexOAuthProvider = Boolean(codexOAuthProvider);
  const codexOAuthConnected = Boolean(codexOAuthStatus?.connected);
  const hasCodexOAuthCredential = Boolean(codexOAuthStatus?.connected || codexOAuthStatus?.requiresReauth);
  const hasOrphanCodexOAuthCredential = !hasCodexOAuthProvider && hasCodexOAuthCredential;
  const codexOAuthFlowUserCode = codexOAuthFlow?.userCode?.trim() ?? "";
  const codexOAuthExpiryLabel = useMemo(() => formatOpenAICodexOAuthExpiry(codexOAuthFlow), [codexOAuthFlow]);
  const refreshCodexOAuthStatus = useCallback(async () => {
    const requestId = codexOAuthStatusRequestIdRef.current + 1;
    codexOAuthStatusRequestIdRef.current = requestId;
    const data = await fetchOpenAICodexOAuthStatus();
    if (codexOAuthStatusRequestIdRef.current === requestId) {
      setCodexOAuthStatus(data);
    }
    return data;
  }, []);
  const setAuthoritativeCodexOAuthStatus = useCallback((status: OpenAICodexOAuthStatus) => {
    codexOAuthStatusRequestIdRef.current += 1;
    setCodexOAuthStatus(status);
  }, []);
  const codexOAuthWizardSteps = useMemo(
    () => [
      {
        label: "Provider",
        description: hasCodexOAuthProvider
          ? "GoatCitadel has the OpenAI Codex provider template ready."
          : "Add the built-in OpenAI Codex provider template.",
        state: hasCodexOAuthProvider ? ("complete" as const) : ("active" as const),
      },
      {
        label: "ChatGPT login",
        description: codexOAuthConnected
          ? "A ChatGPT OAuth credential is stored securely in the OS keychain."
          : codexOAuthFlow
            ? codexOAuthFlowUserCode
              ? "Use the active device code below."
              : "Finish the OpenAI browser approval window."
            : "Start browser login and sign in with OpenAI.",
        state: codexOAuthConnected || codexOAuthFlow ? ("complete" as const) : ("active" as const),
      },
      {
        label: "OpenAI approval",
        description: codexOAuthConnected
          ? "OpenAI approved the login."
          : codexOAuthFlow
            ? codexOAuthFlowUserCode
              ? `Enter exactly ${codexOAuthFlowUserCode} on the OpenAI page.`
              : "Complete the OpenAI approval tab."
            : "The OpenAI page opens after login starts.",
        state: codexOAuthConnected
          ? ("complete" as const)
          : codexOAuthFlow
            ? ("active" as const)
            : ("pending" as const),
      },
      {
        label: "Done",
        description: codexOAuthConnected
          ? "GoatCitadel can use the connected ChatGPT/Codex plan."
          : codexOAuthFlow
            ? "GoatCitadel is checking automatically; this tab can stay open."
            : "After approval, GoatCitadel confirms the connection here.",
        state: codexOAuthConnected
          ? ("complete" as const)
          : codexOAuthFlow
            ? ("active" as const)
            : ("pending" as const),
      },
    ],
    [codexOAuthConnected, codexOAuthFlow, codexOAuthFlowUserCode, hasCodexOAuthProvider],
  );
  const selectedProviderRuntimePosture = selectedProvider
    ? selectedProviderIsLocal
      ? "Local runtime"
      : "Remote provider"
    : "Provider pending";
  const editorHint =
    editorMode === "new"
      ? "Create a new provider definition without expanding the gateway."
      : "Edit the selected provider through runtime settings. Secrets stay on the secure secret endpoints.";

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
    if (selectedProviderId === "openai-codex") {
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
    if (!hasCodexOAuthProvider) {
      setCodexOAuthFlow(null);
    }
    let cancelled = false;
    const requestId = codexOAuthStatusRequestIdRef.current + 1;
    codexOAuthStatusRequestIdRef.current = requestId;
    void fetchOpenAICodexOAuthStatus()
      .then((data) => {
        if (!cancelled && codexOAuthStatusRequestIdRef.current === requestId) {
          setCodexOAuthStatus(data);
        }
      })
      .catch(() => {
        if (!cancelled && codexOAuthStatusRequestIdRef.current === requestId) {
          setCodexOAuthStatus(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasCodexOAuthProvider]);

  useEffect(() => {
    if (selectedProviderId) {
      void loadModelsForProvider(selectedProviderId);
    }
  }, [loadModelsForProvider, selectedProviderId]);

  useEffect(() => {
    if (!selectedProvider) {
      if (editorMode !== "new") {
        setProviderDraft(createEmptyProviderEditorDraft());
        setProviderTransportDraft(createEmptyLlmTransportDraft());
      }
      return;
    }
    if (editorMode === "new") {
      return;
    }
    setProviderDraft(buildProviderEditorDraft(selectedProviderConfig ?? selectedProvider));
    setProviderTransportDraft(draftFromRequestConfig(selectedProviderConfig?.request));
  }, [editorMode, selectedProvider, selectedProviderConfig]);

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
      setNotice({
        tone: routingUsesFallbackModels ? "warning" : "success",
        message: routingUsesFallbackModels
          ? "Provider routing updated with a suggested model that has not been account-verified."
          : "Provider routing updated.",
      });
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

  const handleCodexOAuthPollResult = useCallback(
    async (result: OpenAICodexDevicePollResponse, options: { showPendingNotice?: boolean } = {}) => {
      if (result.status === "connected") {
        setCodexOAuthFlow(null);
        clearStoredOpenAICodexOAuthFlow();
        const nextStatus = await refreshCodexOAuthStatus();
        await reload();
        if (nextStatus.connected) {
          setNotice({ tone: "success", message: "OpenAI Codex OAuth connected." });
        } else {
          setNotice({
            tone: "warning",
            message:
              "OpenAI approved the login, but GoatCitadel could not confirm a saved ChatGPT OAuth credential. Start ChatGPT login again.",
          });
        }
        return false;
      }
      if (result.status === "expired") {
        setCodexOAuthFlow(null);
        clearStoredOpenAICodexOAuthFlow();
        setNotice({ tone: "warning", message: "OpenAI Codex OAuth login expired. Start ChatGPT login again." });
        return false;
      }
      if (result.status === "failed") {
        setCodexOAuthFlow(null);
        clearStoredOpenAICodexOAuthFlow();
        setNotice({ tone: "error", message: result.error ?? "OpenAI Codex OAuth pairing failed." });
        return false;
      }
      if (options.showPendingNotice) {
        setNotice({ tone: "info", message: "Still waiting for OpenAI approval for this login." });
      }
      return true;
    },
    [refreshCodexOAuthStatus, reload],
  );

  const openCodexOAuthVerificationUrl = useCallback((verificationUrl: string) => {
    if (!isTrustedOpenAICodexVerificationUrl(verificationUrl)) {
      setNotice({ tone: "error", message: "OpenAI verification URL was not trusted. Start a new ChatGPT login." });
      return;
    }
    globalThis.open?.(verificationUrl, "_blank", "noopener,noreferrer");
  }, []);

  const handleStartCodexOAuth = async (openVerificationPage = false) => {
    setCodexOAuthBusy(true);
    try {
      const flow = await startOpenAICodexOAuthDeviceFlow();
      if (!isStoredOpenAICodexOAuthFlow(flow)) {
        throw new Error("OpenAI Codex OAuth start returned an invalid login flow.");
      }
      setCodexOAuthFlow(flow);
      writeStoredOpenAICodexOAuthFlow(flow);
      if (openVerificationPage) {
        openCodexOAuthVerificationUrl(flow.verificationUrl);
      }
      setNotice({
        tone: "success",
        message: openVerificationPage
          ? "ChatGPT login started. If the OpenAI page did not open, use the Open OpenAI page button."
          : flow.userCode
            ? "ChatGPT login started. Use the code shown below on the OpenAI page."
            : "ChatGPT login started. Complete the OpenAI browser approval.",
      });
    } catch (oauthError) {
      setNotice({ tone: "error", message: getErrorMessage(oauthError) });
    } finally {
      setCodexOAuthBusy(false);
    }
  };

  const handleRestartCodexOAuth = async () => {
    setCodexOAuthFlow(null);
    clearStoredOpenAICodexOAuthFlow();
    await handleStartCodexOAuth(true);
  };

  const handlePollCodexOAuth = async () => {
    if (!codexOAuthFlow) {
      setNotice({ tone: "warning", message: "Start ChatGPT login first." });
      return;
    }
    if (codexOAuthPollInFlightRef.current === codexOAuthFlow.flowId) {
      setNotice({ tone: "info", message: "GoatCitadel is already checking this OpenAI login." });
      return;
    }
    setCodexOAuthBusy(true);
    codexOAuthPollInFlightRef.current = codexOAuthFlow.flowId;
    try {
      const result = await pollOpenAICodexOAuthDeviceFlow(codexOAuthFlow.flowId);
      await handleCodexOAuthPollResult(result, { showPendingNotice: true });
    } catch (oauthError) {
      setNotice({ tone: "error", message: getErrorMessage(oauthError) });
    } finally {
      codexOAuthPollInFlightRef.current = null;
      setCodexOAuthBusy(false);
    }
  };

  const handleDisconnectCodexOAuth = async () => {
    setCodexOAuthBusy(true);
    try {
      setAuthoritativeCodexOAuthStatus(await deleteOpenAICodexOAuthCredential());
      setCodexOAuthFlow(null);
      clearStoredOpenAICodexOAuthFlow();
      setNotice({ tone: "success", message: "OpenAI Codex OAuth disconnected." });
      await reload();
    } catch (oauthError) {
      setNotice({ tone: "error", message: getErrorMessage(oauthError) });
    } finally {
      setCodexOAuthBusy(false);
    }
  };

  useEffect(() => {
    if (!codexOAuthFlow) {
      return;
    }
    let cancelled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const flowId = codexOAuthFlow.flowId;
    const scheduleNextPoll = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      timeoutId = globalThis.setTimeout(
        pollCurrentFlow,
        Math.max(normalizeOpenAICodexPollDelayMs(delayMs), OPENAI_CODEX_MIN_POLL_MS),
      );
    };
    const pollCurrentFlow = () => {
      if (codexOAuthPollInFlightRef.current === flowId) {
        scheduleNextPoll(codexOAuthFlow.pollAfterMs);
        return;
      }
      codexOAuthPollInFlightRef.current = flowId;
      setCodexOAuthBusy(true);
      void pollOpenAICodexOAuthDeviceFlow(flowId)
        .then(async (result) => {
          if (cancelled) {
            return;
          }
          const shouldContinue = await handleCodexOAuthPollResult(result);
          if (shouldContinue) {
            scheduleNextPoll(result.retryAfterMs ?? codexOAuthFlow.pollAfterMs);
          }
        })
        .catch((pollError) => {
          if (!cancelled) {
            setNotice({ tone: "error", message: getErrorMessage(pollError) });
          }
        })
        .finally(() => {
          if (!cancelled) {
            if (codexOAuthPollInFlightRef.current === flowId) {
              codexOAuthPollInFlightRef.current = null;
            }
            setCodexOAuthBusy(false);
          }
        });
    };
    pollCurrentFlow();
    return () => {
      cancelled = true;
      if (timeoutId) {
        globalThis.clearTimeout(timeoutId);
      }
      if (codexOAuthPollInFlightRef.current === flowId) {
        codexOAuthPollInFlightRef.current = null;
      }
    };
  }, [codexOAuthFlow, handleCodexOAuthPollResult]);

  const handleAddChatGptOAuthProvider = async () => {
    if (hasCodexOAuthProvider) {
      setEditorMode("selected");
      setSelectedProviderId("openai-codex");
      setNotice({ tone: "info", message: "OpenAI Codex is already configured. Connect ChatGPT OAuth below." });
      return;
    }
    const draft = buildChatGptOAuthProviderDraft();
    setProviderSaveBusy(true);
    try {
      await patchSettings({
        llm: {
          upsertProvider: {
            providerId: draft.providerId,
            label: draft.label,
            baseUrl: draft.baseUrl,
            apiStyle: draft.apiStyle,
            authMode: "codex-oauth",
            defaultModel: draft.defaultModel,
          },
        },
      });
      await reload();
      setEditorMode("selected");
      setProviderDraft(draft);
      setProviderTransportDraft(createEmptyLlmTransportDraft());
      setSelectedProviderId(draft.providerId);
      setNotice({ tone: "success", message: "ChatGPT provider added. Start ChatGPT login below." });
      void loadModelsForProvider(draft.providerId, { force: true });
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    } finally {
      setProviderSaveBusy(false);
    }
  };

  const handleSaveProvider = async () => {
    if (!providerDraft.providerId.trim() || !providerDraft.baseUrl.trim()) {
      setNotice({ tone: "warning", message: "Provide both a provider id and base URL before saving." });
      return;
    }
    if (providerRequestValidation.error) {
      setNotice({ tone: "error", message: providerRequestValidation.error });
      return;
    }
    setProviderSaveBusy(true);
    try {
      await patchSettings({
        llm: {
          upsertProvider: {
            providerId: providerDraft.providerId.trim(),
            label: providerDraft.label.trim() || undefined,
            baseUrl: providerDraft.baseUrl.trim(),
            apiStyle: providerDraft.apiStyle,
            authMode: draftIsCodexOAuth ? "codex-oauth" : undefined,
            defaultModel: providerDraft.defaultModel.trim() || undefined,
            apiKeyEnv: draftIsCodexOAuth ? undefined : providerDraft.apiKeyEnv.trim() || undefined,
            request: providerRequestValidation.request,
          },
        },
      });
      await reload();
      setEditorMode("selected");
      setSelectedProviderId(providerDraft.providerId.trim());
      setNotice({ tone: "success", message: `Saved provider ${providerDraft.providerId.trim()}.` });
      void loadModelsForProvider(providerDraft.providerId.trim(), { force: true });
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    } finally {
      setProviderSaveBusy(false);
    }
  };

  const handleStartNewProviderDraft = () => {
    setEditorMode("new");
    setProviderDraft(createEmptyProviderEditorDraft());
    setProviderTransportDraft(createEmptyLlmTransportDraft());
    setNotice({
      tone: "info",
      message: "Started a new provider draft. Save it through Settings when the fields are ready.",
    });
  };

  const handleOpenCodexOAuthVerification = () => {
    if (!codexOAuthFlow?.verificationUrl) {
      return;
    }
    openCodexOAuthVerificationUrl(codexOAuthFlow.verificationUrl);
  };

  const handleShowCodexOAuthProviderDetail = () => {
    setEditorMode("selected");
    setSelectedProviderId("openai-codex");
  };

  const handleRefreshModels = async (providerId: string) => {
    const normalized = providerId.trim();
    if (!normalized) {
      setNotice({ tone: "warning", message: "Choose or save a provider before probing models." });
      return;
    }
    setProviderProbeBusyId(normalized);
    try {
      const items = await loadModelsForProvider(normalized, { force: true });
      const probe = getCachedModelProbe(normalized);
      const fallbackOnly = probe?.state === "fallback";
      const failedFallback = probe?.source === "error_fallback";
      setNotice({
        tone: items.length > 0 && !fallbackOnly ? "success" : "warning",
        message: fallbackOnly
          ? failedFallback
            ? `Loaded ${items.length} fallback models for ${normalized}; live discovery failed${probe?.warning ? `: ${probe.warning}` : "."}`
            : `Loaded ${items.length} suggested models for ${normalized}; this catalog was not verified against your account.`
          : items.length > 0
            ? `Refreshed ${items.length} models for ${normalized}.`
            : `Probe completed for ${normalized}, but no models were returned.`,
      });
      await reload();
    } catch (probeError) {
      setNotice({ tone: "error", message: getErrorMessage(probeError) });
    } finally {
      setProviderProbeBusyId(null);
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsGrid variant="detail-wide">
        <SettingsPanel
          title="Providers"
          subtitle="Available providers, probe posture, and current catalog coverage."
          scrollBody
          bodyMaxHeight="min(62vh, 36rem)"
          stats={[
            { label: "Configured", value: String(providers.length) },
            { label: "Active workspace", value: activeWorkspaceId },
          ]}
        >
          <SettingsButtonRow>
            <button
              type="button"
              className="mc-next-button"
              onClick={() => void handleAddChatGptOAuthProvider()}
              disabled={providerSaveBusy}
            >
              <KeyRound size={16} />
              {hasCodexOAuthProvider ? "ChatGPT setup" : "Add ChatGPT setup"}
            </button>
            <button type="button" className="mc-next-button-secondary" onClick={handleStartNewProviderDraft}>
              <Plus size={16} />
              New provider draft
            </button>
          </SettingsButtonRow>
          <SettingsSelectableList
            items={providers.map((item) => ({
              id: item.providerId,
              title: item.label,
              meta: item.providerId,
              body: [
                `${item.models.length} models`,
                formatProviderCredentialLabel(item.providerId, item.hasApiKey, codexOAuthStatus),
                formatProviderProbeStateLabel(item.modelProbeState),
              ].join(" · "),
            }))}
            selectedId={selectedProviderId}
            onSelect={(providerId) => {
              setEditorMode("selected");
              setSelectedProviderId(providerId);
            }}
            emptyLabel="No providers returned from runtime settings."
            maxHeight="min(44vh, 25rem)"
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
                    setEditorMode("selected");
                    setSelectedProviderId(nextProviderId);
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
            {routingUsesFallbackModels ? (
              <SettingsNotice
                notice={{
                  tone: "warning",
                  message:
                    "These models are suggested from GoatCitadel's provider template, not verified from your account catalog yet.",
                }}
              />
            ) : null}
            <SettingsButtonRow>
              <button type="button" className="mc-next-button" onClick={() => void handleSaveRouting()}>
                <Save size={16} />
                Save routing
              </button>
            </SettingsButtonRow>
          </SettingsPanel>
          <SettingsPanel
            title="OpenAI Codex ChatGPT login"
            subtitle="Connect the OpenAI Codex provider through ChatGPT OAuth. No API key needed."
            stats={[
              {
                label: "Provider",
                value: hasCodexOAuthProvider ? "Ready" : "Missing",
              },
              {
                label: "Login",
                value: codexOAuthConnected
                  ? "Connected"
                  : codexOAuthStatus?.requiresReauth
                    ? "Reauth"
                    : codexOAuthFlow
                      ? "Waiting"
                      : "Not started",
              },
            ]}
          >
            <SettingsWizardSteps steps={codexOAuthWizardSteps} />
            {hasOrphanCodexOAuthCredential ? (
              <SettingsNotice
                notice={{
                  tone: "warning",
                  message:
                    "A ChatGPT OAuth credential exists in secure storage, but the OpenAI Codex provider is missing. Add the provider to use it, or disconnect to remove the stored credential.",
                }}
              />
            ) : !hasCodexOAuthProvider ? (
              <SettingsNotice
                notice={{
                  tone: "info",
                  message:
                    "Start here. GoatCitadel will add the built-in OpenAI Codex provider, then this card will switch to ChatGPT login.",
                }}
              />
            ) : codexOAuthConnected ? (
              <SettingsNotice
                notice={{
                  tone: "success",
                  message: `Done. ChatGPT OAuth is connected${codexOAuthStatus?.accountLabel ? ` as ${codexOAuthStatus.accountLabel}` : ""}.`,
                }}
              />
            ) : codexOAuthFlow ? (
              <div className="mc-next-settings-oauth-code-card">
                <span>{codexOAuthFlowUserCode ? "Use this exact OpenAI code" : "OpenAI browser login"}</span>
                <strong>{codexOAuthFlowUserCode || "Awaiting approval"}</strong>
                {codexOAuthFlowUserCode ? (
                  <p>
                    Open the OpenAI page, enter this code, approve the request, then return here. GoatCitadel checks
                    automatically{codexOAuthExpiryLabel ? ` for about ${codexOAuthExpiryLabel}` : ""}.
                  </p>
                ) : (
                  <p>
                    Complete the OpenAI browser approval, then return here. GoatCitadel checks automatically
                    {codexOAuthExpiryLabel ? ` for about ${codexOAuthExpiryLabel}` : ""}.
                  </p>
                )}
              </div>
            ) : (
              <SettingsNotice
                notice={{
                  tone: "info",
                  message: "Press Start ChatGPT login. GoatCitadel will open the OpenAI approval page.",
                }}
              />
            )}
            {codexOAuthFlow ? (
              <SettingsFieldGrid>
                <SettingsField label="OpenAI page">
                  <input className="mc-next-settings-input" value={codexOAuthFlow.verificationUrl} readOnly />
                </SettingsField>
                {codexOAuthFlowUserCode ? (
                  <SettingsField label="Current code">
                    <input className="mc-next-settings-input" value={codexOAuthFlowUserCode} readOnly />
                  </SettingsField>
                ) : null}
              </SettingsFieldGrid>
            ) : null}
            <SettingsButtonRow>
              {!hasCodexOAuthProvider ? (
                <button
                  type="button"
                  className="mc-next-button"
                  onClick={() => void handleAddChatGptOAuthProvider()}
                  disabled={providerSaveBusy}
                >
                  <KeyRound size={16} />
                  Add provider and continue
                </button>
              ) : codexOAuthFlow ? (
                <button
                  type="button"
                  className="mc-next-button"
                  onClick={handleOpenCodexOAuthVerification}
                  disabled={codexOAuthBusy}
                >
                  <ExternalLink size={16} />
                  Open OpenAI page
                </button>
              ) : (
                <button
                  type="button"
                  className="mc-next-button"
                  onClick={() => void handleStartCodexOAuth(true)}
                  disabled={codexOAuthBusy}
                >
                  <KeyRound size={16} />
                  {codexOAuthConnected ? "Reconnect ChatGPT" : "Start ChatGPT login"}
                </button>
              )}
              {codexOAuthFlow ? (
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void handlePollCodexOAuth()}
                  disabled={codexOAuthBusy}
                >
                  <RefreshCw size={16} />I approved, check now
                </button>
              ) : null}
              {codexOAuthFlow ? (
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void handleRestartCodexOAuth()}
                  disabled={codexOAuthBusy}
                >
                  <RotateCcw size={16} />
                  {codexOAuthFlowUserCode ? "Get a new code" : "Restart login"}
                </button>
              ) : null}
              {hasCodexOAuthProvider && !codexOAuthFlow ? (
                <button type="button" className="mc-next-button-secondary" onClick={handleShowCodexOAuthProviderDetail}>
                  <SlidersHorizontal size={16} />
                  Advanced details
                </button>
              ) : null}
              {hasCodexOAuthCredential ? (
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void handleDisconnectCodexOAuth()}
                  disabled={codexOAuthBusy}
                >
                  <Trash2 size={16} />
                  Disconnect
                </button>
              ) : null}
            </SettingsButtonRow>
          </SettingsPanel>
          <SettingsPanel
            title={selectedProvider?.label ?? "Provider detail"}
            subtitle="Credential posture, probe state, and read-only runtime trust signals."
          >
            {selectedProvider ? (
              <>
                <SettingsMetricGrid
                  items={[
                    { label: "Default model", value: selectedProvider.defaultModel, meta: selectedProvider.apiStyle },
                    {
                      label: selectedProviderIsCodexOAuth ? "OAuth" : "API key",
                      value: selectedProviderIsCodexOAuth
                        ? codexOAuthStatus?.connected
                          ? "Connected"
                          : codexOAuthStatus?.requiresReauth
                            ? "Reauth"
                            : "Missing"
                        : secretState.data?.hasSecret || selectedProvider.hasApiKey
                          ? "Configured"
                          : "Missing",
                      meta: selectedProviderIsCodexOAuth
                        ? (codexOAuthStatus?.accountLabel ?? "ChatGPT/Codex plan")
                        : (secretState.data?.source ?? selectedProvider.apiKeySource ?? "unknown"),
                    },
                    {
                      label: "Probe",
                      value: formatProviderProbeStateLabel(selectedProvider.modelProbeState),
                      meta: formatProviderProbeSourceMeta(selectedProvider),
                    },
                    {
                      label: "Models",
                      value: String(availableModels.length),
                      meta:
                        selectedProvider.modelProbeState === "fallback"
                          ? "Suggested, not verified"
                          : "Known to the runtime",
                    },
                    {
                      label: "Runtime posture",
                      value: selectedProviderRuntimePosture,
                      meta: selectedProviderIsLocal ? "Local endpoint detected" : "Network endpoint detected",
                    },
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
                {selectedProviderIsCodexOAuth ? (
                  <>
                    <SettingsNotice
                      notice={{
                        tone: codexOAuthConnected ? "success" : "info",
                        message: codexOAuthConnected
                          ? `OpenAI Codex OAuth connected${codexOAuthStatus?.accountLabel ? ` as ${codexOAuthStatus.accountLabel}` : ""}.`
                          : codexOAuthFlow
                            ? "ChatGPT login is currently in progress in the setup card above."
                            : "No API key goes here. ChatGPT login is managed by the setup card above.",
                      }}
                    />
                    <SettingsButtonRow>
                      <button
                        type="button"
                        className="mc-next-button-secondary"
                        onClick={() => void handleRefreshModels(selectedProvider.providerId)}
                        disabled={providerProbeBusyId === selectedProvider.providerId}
                      >
                        <RefreshCw size={16} />
                        {providerProbeBusyId === selectedProvider.providerId ? "Probing..." : "Refresh models"}
                      </button>
                    </SettingsButtonRow>
                  </>
                ) : (
                  <>
                    <SettingsField label="Provider secret">
                      <input
                        className="mc-next-settings-input"
                        type="password"
                        value={secretValue}
                        placeholder="Paste a new API key to save"
                        onChange={(event) => setSecretValue(event.target.value)}
                      />
                    </SettingsField>
                    <SettingsNotice
                      notice={{
                        tone: "info",
                        message:
                          "Provider secrets are saved through gateway secret endpoints and are not sent back to the browser after save. This field is only for entering a replacement key.",
                      }}
                    />
                    {secretState.error ? (
                      <SettingsNotice notice={{ tone: "error", message: secretState.error }} />
                    ) : null}
                    <SettingsButtonRow>
                      <button type="button" className="mc-next-button" onClick={() => void handleSaveSecret()}>
                        <KeyRound size={16} />
                        Save secret
                      </button>
                      <button
                        type="button"
                        className="mc-next-button-secondary"
                        onClick={() => void handleRefreshModels(selectedProvider.providerId)}
                        disabled={providerProbeBusyId === selectedProvider.providerId}
                      >
                        <RefreshCw size={16} />
                        {providerProbeBusyId === selectedProvider.providerId ? "Probing..." : "Refresh models"}
                      </button>
                      <button
                        type="button"
                        className="mc-next-button-secondary"
                        onClick={() => void handleDeleteSecret()}
                      >
                        <Trash2 size={16} />
                        Delete secret
                      </button>
                    </SettingsButtonRow>
                  </>
                )}
              </>
            ) : (
              <SettingsEmptyState label="Choose a provider to inspect routing and secret posture." />
            )}
          </SettingsPanel>
          <SettingsPanel title="Provider editor" subtitle={editorHint}>
            <SettingsFieldGrid>
              <SettingsField label="Provider id">
                <input
                  className="mc-next-settings-input"
                  value={providerDraft.providerId}
                  placeholder="openai-compatible"
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      providerId: event.target.value,
                    }))
                  }
                />
              </SettingsField>
              <SettingsField label="Label">
                <input
                  className="mc-next-settings-input"
                  value={providerDraft.label}
                  placeholder="OpenAI-compatible"
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      label: event.target.value,
                    }))
                  }
                />
              </SettingsField>
              <SettingsField label="Base URL">
                <input
                  className="mc-next-settings-input"
                  value={providerDraft.baseUrl}
                  placeholder="https://llm.example.test/v1"
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))
                  }
                />
              </SettingsField>
              <SettingsField label="API style">
                <select
                  className="mc-next-settings-input"
                  value={providerDraft.apiStyle}
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      apiStyle: event.target.value as ProviderEditorDraft["apiStyle"],
                    }))
                  }
                >
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="openai-codex-responses">OpenAI Codex Responses</option>
                  <option value="openai-chat-completions">OpenAI Chat Completions</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                </select>
              </SettingsField>
              <SettingsField label="Default model">
                <input
                  className="mc-next-settings-input"
                  value={providerDraft.defaultModel}
                  placeholder="gpt-5.4-mini"
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      defaultModel: event.target.value,
                    }))
                  }
                />
              </SettingsField>
              {draftIsCodexOAuth ? null : (
                <SettingsField label="API key env">
                  <input
                    className="mc-next-settings-input"
                    value={providerDraft.apiKeyEnv}
                    placeholder="OPENAI_API_KEY"
                    onChange={(event) =>
                      setProviderDraft((current) => ({
                        ...current,
                        apiKeyEnv: event.target.value,
                      }))
                    }
                  />
                </SettingsField>
              )}
            </SettingsFieldGrid>
            {providerRequestValidation.error ? (
              <SettingsNotice notice={{ tone: "error", message: providerRequestValidation.error }} />
            ) : null}
            <LlmTransportFields
              draft={providerTransportDraft}
              idPrefix={`provider-editor-${providerDraft.providerId || "draft"}`}
              onChange={setProviderTransportDraft}
              error={providerRequestValidation.error}
            />
            <SettingsButtonRow>
              <button
                type="button"
                className="mc-next-button"
                disabled={providerSaveBusy}
                onClick={() => void handleSaveProvider()}
              >
                <Save size={16} />
                {providerSaveBusy ? "Saving..." : "Save provider"}
              </button>
              <button
                type="button"
                className="mc-next-button-secondary"
                onClick={() =>
                  selectedProvider
                    ? handleRefreshModels(selectedProvider.providerId)
                    : handleRefreshModels(providerDraft.providerId)
                }
                disabled={
                  providerProbeBusyId === selectedProvider?.providerId ||
                  providerProbeBusyId === providerDraft.providerId
                }
              >
                <RefreshCw size={16} />
                {providerProbeBusyId === selectedProvider?.providerId ||
                providerProbeBusyId === providerDraft.providerId
                  ? "Probing..."
                  : "Probe from editor"}
              </button>
              <button
                type="button"
                className="mc-next-button-secondary"
                onClick={() => {
                  setEditorMode("selected");
                  setProviderDraft(buildProviderEditorDraft(selectedProviderConfig ?? selectedProvider));
                  setProviderTransportDraft(draftFromRequestConfig(selectedProviderConfig?.request));
                }}
                disabled={!selectedProvider}
              >
                <RotateCcw size={16} />
                Reload selected
              </button>
            </SettingsButtonRow>
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
      nativeLoad("Device grants", fetchDeviceAccessGrants("all"), { items: [] }),
    ]);
    return {
      settings,
      issues: nativeLoadIssues([grants]),
      grants: grants.data.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [form, setForm] = useState({
    mode: "none",
    allowLoopbackBypass: false,
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
        <SettingsGrid variant="detail-wide">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
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
                  <SettingsNotice
                    notice={{
                      tone: "warning",
                      message:
                        "Leave this off unless this is trusted single-machine development and every local process may reach the gateway without normal auth.",
                    }}
                  />
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
                id: grant.grantId,
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
      nativeLoad("Daemon status", fetchDaemonStatus(), null),
      nativeLoad("Voice runtime", fetchVoiceRuntimeStatus(), null),
      nativeLoad("llama.cpp models", fetchLlamaCppModels(), { items: [] }),
      shouldLoadNpuModels
        ? nativeLoad("NPU models", fetchNpuModels(), { items: [] })
        : Promise.resolve({ data: { items: [] }, issue: null }),
    ]);
    if (VISUAL_REGRESSION_MODE) {
      return {
        settings: {
          ...settings,
          llamaCpp: {
            ...settings.llamaCpp,
            baseUrl: "http://127.0.0.1:8080/v1",
            command: "llama-server",
            modelsRootPath: "",
            modelPath: "",
            status: {
              ...settings.llamaCpp.status,
              desiredState: "stopped" as const,
              processState: "stopped" as const,
              healthy: false,
              activeModelId: undefined,
              command: "llama-server",
              modelPath: undefined,
              lastError: undefined,
            },
          },
          npu: {
            ...settings.npu,
            status: {
              ...settings.npu.status,
              desiredState: "stopped" as const,
              processState: "stopped" as const,
              healthy: false,
              activeModelId: undefined,
              lastError: undefined,
            },
          },
        },
        issues: [],
        daemon: {
          running: true,
          pid: 0,
          uptimeSeconds: 0,
          host: "verification-host",
          state: "running" as const,
          supported: true,
          controllable: false,
          controlMessage: "Visual regression fixture",
        },
        voiceRuntime: {
          provider: "whisper.cpp" as const,
          source: "managed" as const,
          readiness: "missing" as const,
          binaryReady: false,
          ffmpegReady: false,
          selectedModelId: undefined,
          selectedModelPath: undefined,
          installedModels: [],
          catalog: [],
          lastError: undefined,
        },
        llamaModels: [],
        llamaModelsWarning: undefined,
        npuModels: [],
      };
    }
    return {
      settings,
      issues: nativeLoadIssues([daemon, voiceRuntime, llamaModels, npuModels]),
      daemon: daemon.data,
      voiceRuntime: voiceRuntime.data,
      llamaModels: llamaModels.data.items,
      llamaModelsWarning: llamaModels.data.degraded ? llamaModels.data.warning : undefined,
      npuModels: npuModels.data.items,
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
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          {data.llamaModelsWarning ? (
            <SettingsNotice notice={{ tone: "info", message: data.llamaModelsWarning }} />
          ) : null}
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
          <SettingsGrid variant="balanced">
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
      <SettingsGrid variant="detail-wide">
        <SettingsStack>
          <SettingsPanel title="Create workspace" subtitle="Add a new workspace before digging through the directory.">
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
          <SettingsPanel
            title="Workspace directory"
            subtitle="Switch between active and archived workspaces, then edit the selected one."
            scrollBody
            bodyMaxHeight="min(54vh, 30rem)"
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
              maxHeight="min(42vh, 23rem)"
            />
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
    const [catalog, connections, plugins, meetStatus, meetSessions] = await Promise.all([
      nativeLoad("Integration catalog", fetchIntegrationCatalog(), { items: [] }),
      nativeLoad("Integration connections", fetchIntegrationConnections(), { items: [] }),
      nativeLoad("Integration plugins", fetchIntegrationPlugins(), { items: [] }),
      nativeLoad("Google Meet prerequisites", fetchGoogleMeetPrerequisiteStatus(), null),
      nativeLoad("Google Meet sessions", fetchGoogleMeetSessions(6), []),
    ]);
    return {
      issues: nativeLoadIssues([catalog, connections, plugins, meetStatus, meetSessions]),
      catalog: catalog.data.items.filter((item) => item.kind !== "channel"),
      connections: connections.data.items.filter((item) => item.kind !== "channel"),
      plugins: plugins.data.items,
      meetStatus: meetStatus.data,
      meetSessions: meetSessions.data,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
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
        <SettingsGrid variant="three-column">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsStack>
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
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => setShowCreateJson((current) => !current)}
                >
                  <SlidersHorizontal size={16} />
                  {showCreateJson ? "Use guided fields" : "Advanced JSON"}
                </button>
              </SettingsButtonRow>
            </SettingsPanel>
            <SettingsPanel
              title="Connected integrations"
              subtitle="Review live connections and jump into the selected one."
              scrollBody
              bodyMaxHeight="min(48vh, 28rem)"
              stats={[
                { label: "Connections", value: String(data.connections.length) },
                { label: "Catalog", value: String(data.catalog.length) },
                { label: "Plugins", value: String(data.plugins.length) },
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
                maxHeight="min(36vh, 21rem)"
              />
            </SettingsPanel>
          </SettingsStack>
          <SettingsStack>
            <PluginTrustPanel plugins={data.plugins} />
            <GoogleMeetStatusPanel status={data.meetStatus} sessions={data.meetSessions} />
          </SettingsStack>
          <SettingsPanel
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
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    onClick={() => setShowDetailJson((current) => !current)}
                  >
                    <SlidersHorizontal size={16} />
                    {showDetailJson ? "Use guided fields" : "Advanced JSON"}
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
              <SettingsActionList
                items={data.catalog.map((item) => ({
                  id: item.catalogId,
                  label: item.label,
                  description: item.description,
                  meta: `${item.kind} · ${item.maturity} · ${item.capabilities.length} capabilities`,
                  actionLabel: createCatalogId === item.catalogId ? "Selected" : "Use",
                  onClick: () => setCreateCatalogId(item.catalogId),
                }))}
                emptyLabel="No integration catalog entries are available."
                maxHeight="min(58vh, 34rem)"
              />
            )}
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function PluginTrustPanel({ plugins }: { plugins: IntegrationPluginRecord[] }) {
  const warningCount = plugins.reduce((count, plugin) => count + (plugin.trustWarnings?.length ?? 0), 0);
  return (
    <SettingsPanel
      title="Plugin trust"
      subtitle="Installed plugin source, integrity, readiness, and dashboard theme truth."
      stats={[
        { label: "Installed", value: String(plugins.length) },
        { label: "Warnings", value: String(warningCount) },
      ]}
    >
      <SettingsActionList
        items={plugins.map((plugin) => {
          const source = plugin.sourceMetadata;
          const warnings = plugin.trustWarnings ?? [];
          return {
            id: plugin.pluginId,
            label: plugin.label,
            description: [
              `${source?.display ?? plugin.source ?? "Unknown source"} · ${source?.type ?? "unknown"}`,
              `Integrity: ${plugin.integrityStatus ?? source?.integrityStatus ?? "unknown"}`,
              `State: ${plugin.enabled ? "enabled" : "disabled"}`,
              plugin.theme
                ? `Theme: ${plugin.theme.dashboardVariant ?? "default"}${plugin.theme.accentColor ? `, ${plugin.theme.accentColor}` : ""}`
                : "Theme: default",
            ].join(" | "),
            meta: warnings.length
              ? warnings.map((warning) => `${warning.severity}: ${warning.message}`).join(" | ")
              : "Setup readiness: no trust warnings",
            actionLabel: plugin.enabled ? "Enabled" : "Disabled",
          };
        })}
        emptyLabel="No integration plugins installed."
      />
    </SettingsPanel>
  );
}

function GoogleMeetStatusPanel({
  status,
  sessions,
}: {
  status: GoogleMeetPrerequisiteStatusResponse | null;
  sessions: GoogleMeetSessionRecord[];
}) {
  return (
    <SettingsPanel
      title="Google Meet voice"
      subtitle="Realtime meeting voice remains blocked until OAuth, provider, browser, audio, and user-start prerequisites pass."
      stats={[
        { label: "State", value: status?.state ?? "unknown" },
        { label: "Sessions", value: String(sessions.length) },
      ]}
    >
      {status ? (
        <>
          <SettingsMetricGrid
            items={[
              {
                label: "Provider",
                value: status.provider,
                meta: status.failureReason ?? `Checked ${formatDateTime(status.checkedAt)}`,
              },
              {
                label: "Auth profile",
                value: status.authProfile.available ? "available" : "missing",
                meta: status.authProfile.accountRef ?? "OAuth handoff has not provided an account reference",
              },
            ]}
          />
          <SettingsActionList
            items={status.prerequisites.map((item) => ({
              id: item.id,
              label: labelForMeetPrerequisite(item.id),
              description: item.message,
              meta: item.ready ? "ready" : "blocked",
              actionLabel: item.ready ? "Ready" : "Blocked",
            }))}
          />
          <SettingsActionList
            items={sessions.map((session) => ({
              id: session.sessionId,
              label: session.displayName ?? session.meetingUrl,
              description:
                session.failureReason ?? `${session.provider} · ${session.transcript.length} transcript chunks`,
              meta: `${session.state} · updated ${formatDateTime(session.updatedAt)}`,
              actionLabel: session.state,
            }))}
            emptyLabel="No Google Meet sessions recorded."
          />
        </>
      ) : (
        <SettingsEmptyState label="Google Meet prerequisite status is unavailable from the gateway." />
      )}
    </SettingsPanel>
  );
}

function labelForMeetPrerequisite(id: string): string {
  switch (id) {
    case "oauth_profile":
      return "OAuth profile";
    case "provider_key":
      return "Provider key";
    case "browser_transport":
      return "Browser transport";
    case "audio_transport":
      return "Audio transport";
    case "user_start":
      return "User start";
    default:
      return id;
  }
}

function ChannelsSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [definitions, drafts, connections] = await Promise.all([
      nativeLoad("Channel definitions", fetchChannelSetupDefinitions(), { items: [] }),
      nativeLoad("Channel drafts", fetchChannelSetupDrafts({ limit: 100 }), { items: [] }),
      nativeLoad("Channel connections", fetchIntegrationConnections("channel"), { items: [] }),
    ]);
    return {
      issues: nativeLoadIssues([definitions, drafts, connections]),
      definitions: definitions.data.items,
      drafts: drafts.data.items,
      connections: connections.data.items,
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
    setCreateCatalogId((current) => {
      if (current && data.definitions.some((item) => item.catalog.catalogId === current)) {
        return current;
      }
      return preferredChannelDefinition(data.definitions)?.catalog.catalogId || "";
    });
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

  const handleStartSlackOAuth = async () => {
    try {
      const status = await fetchSlackOAuthStatus();
      if (!status.configured) {
        setNotice({
          tone: "warning",
          message: `Slack OAuth needs configuration first: ${status.missing.join(", ") || "missing OAuth settings"}.`,
        });
        return;
      }
      const previousConnections = new Map(
        status.connections.map((item) => [
          item.connection.connectionId,
          readConnectionConfigString(item.connection.config, "oauthConnectedAt") ?? "",
        ]),
      );
      const result = await startSlackOAuth();
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      setNotice({
        tone: "success",
        message: "Slack authorization opened. Approve the workspace, then target setup will open here.",
      });
      void waitForSlackOAuthInstall(previousConnections);
    } catch (oauthError) {
      setNotice({ tone: "error", message: getErrorMessage(oauthError) });
    }
  };

  const waitForSlackOAuthInstall = async (previousConnections: Map<string, string>) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(2000);
      try {
        const status = await fetchSlackOAuthStatus();
        const installed = status.connections.find((item) => {
          const previousConnectedAt = previousConnections.get(item.connection.connectionId);
          const nextConnectedAt = readConnectionConfigString(item.connection.config, "oauthConnectedAt") ?? "";
          return previousConnectedAt === undefined || previousConnectedAt !== nextConnectedAt;
        });
        if (!installed) {
          continue;
        }
        const created = await createChannelSetupDraft({
          catalogId: "channel.slack",
          connectionId: installed.connection.connectionId,
          lifecycleMode: "edit",
        });
        setCreateCatalogId("channel.slack");
        setNotice({
          tone: "success",
          message: "Slack workspace connected. Add channel targets, then validate and test.",
        });
        await reload();
        setSelectedDraftId(created.draftId);
        return;
      } catch {
        // Keep polling so callback timing or a short gateway blip does not interrupt setup.
      }
    }
    setNotice({
      tone: "warning",
      message: "Slack authorization may still be finishing. Refresh channel connections if the workspace was approved.",
    });
  };

  const handleDiscoverTelegramTargets = async () => {
    if (!selectedDraft) {
      return;
    }
    try {
      const draftObject = parseJsonObject(draftJson, selectedDraft.draft);
      const result = await discoverTelegramTargets({
        botToken: readDraftString(draftObject, "botToken"),
        botTokenEnv: readDraftString(draftObject, "botTokenEnv") ?? readDraftString(draftObject, "tokenEnv"),
        setupCode: readDraftString(draftObject, "setupCode"),
      });
      if (result.items.length === 0) {
        setNotice({
          tone: "warning",
          message:
            "Telegram did not return recent chats yet. Send /start or the setup code in the target chat and try again.",
        });
        return;
      }
      const targets = result.items.map((item, index) => ({
        id: item.id,
        label: item.label,
        chatId: item.chatId,
        kind: item.kind,
        default: index === 0,
      }));
      setDraftJson(
        formatJson({
          ...draftObject,
          targets,
          defaultChatId: targets[0]?.chatId ?? readDraftString(draftObject, "defaultChatId"),
        }),
      );
      setNotice({
        tone: "success",
        message: `Detected ${targets.length} Telegram target${targets.length === 1 ? "" : "s"}.`,
      });
    } catch (discoverError) {
      setNotice({ tone: "error", message: getErrorMessage(discoverError) });
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
        <SettingsGrid variant="detail-wide">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsStack>
            <SettingsPanel
              title="Channel definitions"
              subtitle="Available guided setup definitions for supported channel integrations."
              scrollBody
              bodyMaxHeight="min(54vh, 30rem)"
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
                {createCatalogId === "channel.slack" ? (
                  <button type="button" className="mc-next-button" onClick={() => void handleStartSlackOAuth()}>
                    <ExternalLink size={16} />
                    Connect Slack
                  </button>
                ) : null}
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
                maxHeight="min(34vh, 18rem)"
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
                  {selectedDraft.catalogId === "channel.slack" ? (
                    <button type="button" className="mc-next-button" onClick={() => void handleStartSlackOAuth()}>
                      <ExternalLink size={16} />
                      Connect Slack
                    </button>
                  ) : null}
                  {selectedDraft.catalogId === "channel.telegram" ? (
                    <button
                      type="button"
                      className="mc-next-button-secondary"
                      onClick={() => void handleDiscoverTelegramTargets()}
                    >
                      <RefreshCw size={16} />
                      Detect Telegram Chats
                    </button>
                  ) : null}
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
      nativeLoad("MCP servers", fetchMcpServers(), { items: [] }),
      nativeLoad("MCP templates", fetchMcpTemplates(), { items: [] }),
    ]);
    return {
      issues: nativeLoadIssues([servers, templates]),
      servers: servers.data.items,
      templates: templates.data.items,
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
  const selectedServerRuntimeReady = selectedServer ? isRuntimeInvokableMcpServer(selectedServer) : false;

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
        enabled: isRuntimeInvokableMcpServer(createForm) ? createForm.enabled : false,
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
        enabled: selectedServerRuntimeReady ? editForm.enabled : false,
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
        <SettingsGrid variant="detail-wide">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsStack>
            <SettingsPanel
              title="MCP servers"
              subtitle="Connected and disconnected MCP servers available to the operator."
              scrollBody
              bodyMaxHeight="min(48vh, 28rem)"
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
                maxHeight="min(38vh, 22rem)"
              />
            </SettingsPanel>
            <SettingsPanel
              title="Create MCP server"
              subtitle="Set up a local stdio MCP server or use a runtime-supported template."
            >
              <SettingsFieldGrid>
                <SettingsField label="Label">
                  <input
                    className="mc-next-settings-input"
                    value={createForm.label}
                    onChange={(event) => setCreateForm((current) => ({ ...current, label: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Transport">
                  <input className="mc-next-settings-input" value={createForm.transport} readOnly />
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
                      disabled={!isRuntimeInvokableMcpServer(createForm)}
                      onChange={(event) => setCreateForm((current) => ({ ...current, enabled: event.target.checked }))}
                    />
                    <span>
                      {isRuntimeInvokableMcpServer(createForm)
                        ? "Enable immediately after create"
                        : "Configured only; runtime invocation is not supported"}
                    </span>
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
                    meta: item.installed
                      ? "installed"
                      : isRuntimeInvokableMcpServer(item)
                        ? item.transport
                        : "configured only",
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
            scrollBody
            bodyMaxHeight="min(72vh, 42rem)"
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
                        disabled={!selectedServerRuntimeReady}
                        onChange={(event) => setEditForm((current) => ({ ...current, enabled: event.target.checked }))}
                      />
                      <span>
                        {selectedServerRuntimeReady
                          ? "Server can be used by the operator."
                          : "Configured only; runtime actions are disabled."}
                      </span>
                    </label>
                  </SettingsField>
                </SettingsFieldGrid>
                {!selectedServerRuntimeReady ? (
                  <SettingsNotice
                    notice={{
                      tone: "warning",
                      message:
                        "This MCP server is configured for visibility only. Generic http/sse runtime invocation is not supported in this shell.",
                    }}
                  />
                ) : null}
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
                    disabled={!selectedServerRuntimeReady}
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
                    disabled={!selectedServerRuntimeReady}
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
    const [tools, grants, settings] = await Promise.all([
      nativeLoad("Tool catalog", fetchToolCatalog(), { items: [] }),
      nativeLoad("Tool grants", fetchToolGrants({ limit: 400 }), { items: [] }),
      fetchSettings().catch(() => null),
    ]);
    return {
      issues: nativeLoadIssues([tools, grants]),
      tools: tools.data.items,
      grants: grants.data.items,
      settings,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState("");
  const [selectedToolName, setSelectedToolName] = useState("");
  const [approvalModeDraft, setApprovalModeDraft] = useState<ToolApprovalMode>("approve_risky");
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
    if (data?.settings?.toolApprovalMode) {
      setApprovalModeDraft(normalizeToolApprovalMode(data.settings.toolApprovalMode));
    }
  }, [data?.settings?.toolApprovalMode]);

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

  const handleSaveApprovalMode = async () => {
    try {
      await patchSettings({ toolApprovalMode: approvalModeDraft });
      setNotice({ tone: "success", message: "Tool approval mode saved." });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="three-column">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsPanel
            title="Approval mode"
            subtitle="Choose when GoatCitadel asks before running otherwise-allowed tools."
            stats={[
              {
                label: "Current",
                value: describeToolApprovalMode(data.settings?.toolApprovalMode ?? "approve_risky"),
              },
              { label: "Hard blocks", value: "Always enforced" },
            ]}
          >
            <SettingsField label="Tool approvals">
              <select
                className="mc-next-settings-input"
                value={approvalModeDraft}
                onChange={(event) => setApprovalModeDraft(normalizeToolApprovalMode(event.target.value))}
              >
                {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
                  <option key={mode} value={mode}>
                    {describeToolApprovalMode(mode)}
                  </option>
                ))}
              </select>
            </SettingsField>
            <SettingsButtonRow>
              <button type="button" className="mc-next-button" onClick={() => void handleSaveApprovalMode()}>
                <Save size={16} />
                Save mode
              </button>
            </SettingsButtonRow>
          </SettingsPanel>
          <SettingsStack>
            <SettingsPanel
              title="Tool catalog"
              subtitle="Review the full catalog instead of a tiny first-page slice."
              scrollBody
              bodyMaxHeight="min(64vh, 38rem)"
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
                maxHeight="min(48vh, 28rem)"
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
            scrollBody
            bodyMaxHeight="min(72vh, 42rem)"
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
              maxHeight="min(42vh, 24rem)"
            />
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function AddonsSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [catalog, installed, capabilityPacks] = await Promise.all([
      nativeLoad("Add-on catalog", fetchAddonsCatalog(), { items: [] }),
      nativeLoad("Installed add-ons", fetchInstalledAddons(), { items: [] }),
      nativeLoad("Capability packs", fetchCapabilityPacks(), { items: [] }),
    ]);
    return {
      issues: nativeLoadIssues([catalog, installed, capabilityPacks]),
      catalog: catalog.data.items,
      installed: installed.data.items,
      capabilityPacks: capabilityPacks.data.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedAddonId, setSelectedAddonId] = useState("");
  const [selectedPackId, setSelectedPackId] = useState("");
  const [status, setStatus] = useState<LoadState<Awaited<ReturnType<typeof fetchAddonStatus>>>>({
    loading: false,
    error: null,
    data: null,
  });
  const [packPreview, setPackPreview] = useState<LoadState<CapabilityPackPreview>>({
    loading: false,
    error: null,
    data: null,
  });

  const installedById = useMemo(
    () => new Map((data?.installed ?? []).map((item) => [item.addonId, item])),
    [data?.installed],
  );
  const selectedAddon = data?.catalog.find((item) => item.addonId === selectedAddonId) ?? data?.catalog[0] ?? null;
  const selectedPack =
    data?.capabilityPacks.find((item) => item.packId === selectedPackId) ?? data?.capabilityPacks[0] ?? null;

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

  useEffect(() => {
    if (!data?.capabilityPacks.length) {
      setSelectedPackId("");
      return;
    }
    setSelectedPackId((current) =>
      current && data.capabilityPacks.some((item) => item.packId === current)
        ? current
        : data.capabilityPacks[0]?.packId || "",
    );
  }, [data?.capabilityPacks]);

  useEffect(() => {
    if (!selectedPack) {
      setPackPreview({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setPackPreview({ loading: true, error: null, data: null });
    void fetchCapabilityPackPreview(selectedPack.packId)
      .then((result) => {
        if (!cancelled) {
          setPackPreview({ loading: false, error: null, data: result });
        }
      })
      .catch((loadError: Error) => {
        if (!cancelled) {
          setPackPreview({ loading: false, error: loadError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPack]);

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
        <SettingsGrid variant="three-column">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsPanel
            title="Add-on catalog"
            subtitle="Optional add-on runtimes and their current install posture."
            scrollBody
            bodyMaxHeight="min(58vh, 34rem)"
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
              maxHeight="min(42vh, 24rem)"
            />
          </SettingsPanel>
          <SettingsPanel
            title={selectedAddon?.label ?? "Add-on detail"}
            subtitle="Install, update, launch, stop, or remove the selected add-on."
            scrollBody
            bodyMaxHeight="min(72vh, 42rem)"
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
          <SettingsPanel
            title="Capability packs"
            subtitle="Bundled review-first packs over skills, add-ons, MCP templates, plugins, and runtime presets."
            scrollBody
            bodyMaxHeight="min(72vh, 42rem)"
            stats={[
              { label: "Packs", value: String(data.capabilityPacks.length) },
              { label: "Selected", value: selectedPack?.trustTier ?? "none" },
            ]}
          >
            <SettingsSelectableList
              items={data.capabilityPacks.map((item) => ({
                id: item.packId,
                title: item.name,
                meta: item.trustTier,
                body: `${item.version} · ${item.assets.length} assets · ${item.tags.join(", ")}`,
              }))}
              selectedId={selectedPackId}
              onSelect={setSelectedPackId}
              emptyLabel="No bundled capability packs are available."
              maxHeight="min(30vh, 17rem)"
            />
            {selectedPack ? (
              <>
                <SettingsCodeBlock label="Pack preview">{selectedPack.description}</SettingsCodeBlock>
                {packPreview.error ? (
                  <SettingsEmptyState label={`Preview failed: ${packPreview.error}`} />
                ) : packPreview.data ? (
                  <>
                    <SettingsMetricGrid
                      items={[
                        { label: "Trust", value: packPreview.data.manifest.trustTier, meta: "local bundled manifest" },
                        {
                          label: "Review",
                          value: packPreview.data.reviewRequired ? "required" : "not required",
                          meta: packPreview.data.policyChanges.redactionMode,
                        },
                        {
                          label: "Unsupported",
                          value: String(packPreview.data.unsupportedAssets.length),
                          meta: "runtime support check",
                        },
                      ]}
                    />
                    <SettingsActionList
                      items={packPreview.data.installPlan.map((item) => ({
                        label: `${item.kind}: ${item.assetId}`,
                        description: item.reason,
                        meta: item.outcome,
                      }))}
                      emptyLabel="No installable assets in this pack."
                    />
                    <SettingsActionList
                      items={packPreview.data.manifest.installWarnings.map((warning, index) => ({
                        id: `${packPreview.data?.manifest.packId}-warning-${index}`,
                        label: "Warning",
                        description: warning,
                        meta: "review",
                      }))}
                      emptyLabel="No warnings for this pack."
                    />
                    <SettingsButtonRow>
                      <button
                        type="button"
                        className="mc-next-button"
                        disabled={packPreview.loading}
                        onClick={() =>
                          void runAddonAction(
                            () => installCapabilityPack(selectedPack.packId, { actorId: "operator" }),
                            `${selectedPack.name} staged for review.`,
                          )
                        }
                      >
                        <ShieldCheck size={16} />
                        Install disabled
                      </button>
                    </SettingsButtonRow>
                  </>
                ) : (
                  <SettingsEmptyState
                    label={packPreview.loading ? "Loading pack preview..." : "Preview unavailable."}
                  />
                )}
              </>
            ) : (
              <SettingsEmptyState label="Choose a capability pack to preview." />
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

async function nativeLoad<T>(label: string, promise: Promise<T>, fallback: T): Promise<NativeLoadResult<T>> {
  try {
    return {
      data: await promise,
      issue: null,
    };
  } catch (error) {
    return {
      data: fallback,
      issue: {
        label,
        message: getErrorMessage(error),
      },
    };
  }
}

function nativeLoadIssues(results: Array<NativeLoadResult<unknown>>): NativeLoadIssue[] {
  return results.map((result) => result.issue).filter((issue): issue is NativeLoadIssue => Boolean(issue));
}

function SettingsLoadWarnings({ issues, onRetry }: { issues: NativeLoadIssue[]; onRetry: () => void }) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <SettingsPanel title="Some data could not load" subtitle="The rest of this settings page is still usable.">
      <SettingsActionList
        items={issues.map((issue) => ({
          label: issue.label,
          description: issue.message,
          tone: "warning",
        }))}
      />
      <div className="mc-next-settings-actions">
        <button type="button" className="mc-next-secondary-button" onClick={() => void onRetry()}>
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    </SettingsPanel>
  );
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

function SettingsGrid({
  children,
  variant,
}: {
  children: ReactNode;
  variant?: "default" | "balanced" | "detail-wide" | "three-column";
}) {
  const variantClass =
    variant === "balanced"
      ? "is-balanced"
      : variant === "detail-wide"
        ? "is-detail-wide"
        : variant === "three-column"
          ? "is-three-column"
          : "";
  return <div className={["mc-next-settings-grid", variantClass].filter(Boolean).join(" ")}>{children}</div>;
}

function SettingsStack({ children }: { children: ReactNode }) {
  return <div className="mc-next-settings-stack">{children}</div>;
}

function SettingsPanel({
  title,
  subtitle,
  stats,
  children,
  compact = true,
  scrollBody = false,
  bodyMaxHeight,
}: {
  title: string;
  subtitle: string;
  stats?: Array<{ label: string; value: string }>;
  children: ReactNode;
  compact?: boolean;
  scrollBody?: boolean;
  bodyMaxHeight?: string;
}) {
  return (
    <article className={`mc-next-directory-card mc-next-settings-panel${compact ? " is-compact" : ""}`}>
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
      <div
        className={`mc-next-settings-panel-body${scrollBody ? " is-scrollable" : ""}`}
        data-native-scroll={scrollBody ? "true" : undefined}
        style={bodyMaxHeight ? { maxHeight: bodyMaxHeight } : undefined}
      >
        {children}
      </div>
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

function SettingsWizardSteps({
  steps,
}: {
  steps: Array<{ label: string; description: string; state: SettingsWizardStepState }>;
}) {
  return (
    <ol className="mc-next-settings-wizard">
      {steps.map((step, index) => (
        <li key={step.label} className={`mc-next-settings-wizard-step ${step.state}`}>
          <span className="mc-next-settings-wizard-index">
            {step.state === "complete" ? <CheckCircle2 size={15} /> : index + 1}
          </span>
          <div>
            <strong>{step.label}</strong>
            <p>{step.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function SettingsSelectableList({
  items,
  selectedId,
  onSelect,
  emptyLabel,
  maxHeight = "min(56vh, 34rem)",
  compact = true,
}: {
  items: Array<{ id: string; title: string; meta?: string; body?: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
  emptyLabel: string;
  maxHeight?: string;
  compact?: boolean;
}) {
  if (!items.length) {
    return <SettingsEmptyState label={emptyLabel} />;
  }
  return (
    <div
      className={["mc-next-settings-selectable-list", compact ? "is-compact" : "", maxHeight ? "is-scrollable" : ""]
        .filter(Boolean)
        .join(" ")}
      data-native-scroll={maxHeight ? "true" : undefined}
      style={maxHeight ? { maxHeight } : undefined}
    >
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
  maxHeight = "min(50vh, 30rem)",
  compact = true,
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
  maxHeight?: string;
  compact?: boolean;
}) {
  if (!items.length) {
    return <SettingsEmptyState label={emptyLabel} />;
  }
  return (
    <div
      className={["mc-next-settings-action-list", compact ? "is-compact" : "", maxHeight ? "is-scrollable" : ""]
        .filter(Boolean)
        .join(" ")}
      data-native-scroll={maxHeight ? "true" : undefined}
      style={maxHeight ? { maxHeight } : undefined}
    >
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

function splitCommaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLineList(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function deriveSetupCenterItems(onboarding: OnboardingState): Array<{
  label: string;
  description: string;
  state: SettingsWizardStepState;
}> {
  const checklistById = new Map(onboarding.checklist.map((item) => [item.id, item]));
  const providersWithKeys = onboarding.settings.llm.providers.filter((provider) => provider.hasApiKey).length;
  return [
    {
      label: "Provider smoke",
      description:
        providersWithKeys > 0
          ? `${providersWithKeys} provider credential source available. Active model: ${
              onboarding.settings.llm.activeModel || "unset"
            }.`
          : "No provider credentials required for demo/local paths; add one before cloud sends.",
      state: wizardStateForChecklist(checklistById.get("llm")?.status),
    },
    {
      label: "Local runtime",
      description: checklistById.get("runtime")?.detail ?? "Gateway and bundled runtime health are checked locally.",
      state: wizardStateForChecklist(checklistById.get("runtime")?.status),
    },
    {
      label: "Access and auth",
      description:
        onboarding.settings.auth.mode === "none"
          ? "Local access is open; add gateway auth before exposing the app."
          : `${onboarding.settings.auth.mode} gateway auth configured.`,
      state: wizardStateForChecklist(checklistById.get("auth")?.status),
    },
    {
      label: "Channels and MCP",
      description: "Optional connectors stay off until explicitly configured and smoke-tested.",
      state: "pending",
    },
    {
      label: "Installer proof",
      description: "Unsigned builds need checksums, install smoke, screenshots, and release notes before sharing.",
      state: "pending",
    },
  ];
}

function wizardStateForChecklist(status?: OnboardingState["checklist"][number]["status"]): SettingsWizardStepState {
  if (status === "complete") {
    return "complete";
  }
  return status === "needs_input" ? "active" : "pending";
}

function setupMeta(status?: OnboardingState["checklist"][number]["status"]): string {
  if (status === "complete") {
    return "Pass";
  }
  if (status === "needs_input") {
    return "Needs repair";
  }
  return "Optional";
}

function normalizeToolApprovalMode(value: string | undefined): ToolApprovalMode {
  return TOOL_APPROVAL_MODE_OPTIONS.includes(value as ToolApprovalMode) ? (value as ToolApprovalMode) : "approve_risky";
}

function describeToolApprovalMode(value: ToolApprovalMode): string {
  if (value === "approve_all") {
    return "Ask every time";
  }
  if (value === "bypass") {
    return "Bypass prompts";
  }
  return "Ask for risky work";
}

function normalizeBudgetMode(value: string | undefined): OnboardingState["settings"]["budgetMode"] {
  return BUDGET_MODE_OPTIONS.includes(value as OnboardingState["settings"]["budgetMode"])
    ? (value as OnboardingState["settings"]["budgetMode"])
    : "balanced";
}

function applyIntegrationDefaults(
  schema: IntegrationFormSchema,
  current: Record<string, unknown>,
): Record<string, unknown> {
  return schema.fields.reduce<Record<string, unknown>>(
    (next, field) => {
      if (next[field.key] === undefined && field.defaultValue !== undefined) {
        next[field.key] = field.defaultValue;
      }
      return next;
    },
    { ...current },
  );
}

function isRuntimeInvokableMcpServer(server: { transport: string; url?: string }) {
  return server.transport === "stdio" || server.url?.trim().toLowerCase() === INTERNAL_APPROVAL_INBOX_URL;
}

function readDraftString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readConnectionConfigString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function preferredChannelDefinition(definitions: ChannelSetupDefinition[]): ChannelSetupDefinition | undefined {
  return (
    definitions.find((item) => item.catalog.catalogId === "channel.slack") ??
    definitions.find((item) => item.catalog.catalogId === "channel.telegram") ??
    definitions[0]
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

function createEmptyPersonalityEditorDraft(): PersonalityEditorDraft {
  return {
    id: "",
    label: "",
    category: "core",
    description: "",
    tone: "",
    style: "",
    systemOverlay: "",
    safetyNotes: "Personality overlays never override safety, privacy, approval, tool, memory, or skill policies.",
  };
}

function createPersonalityEditorDraft(personality: PersonalityPreset | null): PersonalityEditorDraft {
  if (!personality) {
    return createEmptyPersonalityEditorDraft();
  }
  return {
    id: personality.id,
    label: personality.label,
    category: personality.category,
    description: personality.description,
    tone: personality.tone,
    style: personality.style,
    systemOverlay: personality.systemOverlay,
    safetyNotes: personality.safetyNotes.join("\n"),
  };
}

function personalityDraftToMutationInput(draft: PersonalityEditorDraft) {
  return {
    id: draft.id.trim() || undefined,
    label: draft.label.trim(),
    category: draft.category,
    description: draft.description.trim(),
    tone: draft.tone.trim(),
    style: draft.style.trim(),
    systemOverlay: draft.systemOverlay.trim(),
    safetyNotes: splitLineList(draft.safetyNotes),
  };
}

function formatPersonalityStatus(personality: PersonalityPreset, defaultPersonalityId: string): string {
  const tags = [personality.builtin ? "Built-in" : "Custom"];
  if (personality.modified) {
    tags.push("Modified");
  }
  if (personality.id === defaultPersonalityId) {
    tags.push("Chat default");
  }
  if (personality.editable === false) {
    tags.push("Locked");
  }
  return tags.join(" · ");
}

function formatPersonalityCategoryLabel(category: PersonalityPresetCategory): string {
  return category
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizePersonalityEditorId(input: string | undefined): string {
  return (
    input
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
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

function iconForSettingsSection(section: string) {
  switch (section) {
    case "general":
      return SlidersHorizontal;
    case "onboarding":
      return Play;
    case "budget":
      return Gauge;
    case "providers":
      return SlidersHorizontal;
    case "personalities":
      return Sparkles;
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

function labelForSettingsSection(section: string) {
  switch (section) {
    case "general":
      return "General";
    case "onboarding":
      return "Start Here";
    case "budget":
      return "Budget";
    case "providers":
      return "Providers";
    case "personalities":
      return "Personalities";
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
      return "Unknown";
  }
}

function descriptionForSettingsSection(section: string) {
  switch (section) {
    case "general":
      return "Focused next-native settings instead of placeholder summaries.";
    case "onboarding":
      return "Safe demo launch, setup center, provider, runtime, channel, and release-readiness checkpoints.";
    case "budget":
      return "Cost-control deep links route to explicit budget guidance instead of silent fallback.";
    case "providers":
      return "Choose active routing, inspect provider posture, and manage secrets.";
    case "personalities":
      return "Manage Chat tone presets and choose the global Chat default.";
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
      return "This settings deep link is not registered in the current shell.";
  }
}
