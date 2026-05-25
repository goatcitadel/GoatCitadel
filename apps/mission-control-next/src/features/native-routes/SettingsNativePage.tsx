/* eslint-disable max-lines -- SettingsNativePage intentionally keeps the new settings routes in one editable module while the product surface is still settling. */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  providerTemplates,
  type CapabilityPackPreview,
  type DemoBootstrapStateResponse,
  type LlmProviderAdviceResponse,
  type LlmProviderRequestConfig,
} from "@goatcitadel/contracts";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Code2,
  Gauge,
  KeyRound,
  ExternalLink,
  Play,
  Plug2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import type {
  ChannelSetupDefinition,
  ConnectorDiagnosticReport,
  GoogleMeetPrerequisiteStatusResponse,
  GoogleMeetSessionRecord,
  IntegrationPluginRecord,
  IntegrationFormSchema,
  McpServerRecord,
  OnboardingState,
  FilesystemReadAccessMode,
  LocalOperatorOverrideScope,
  LocalOperatorOverrideRecord,
  PersonalityPreset,
  PersonalityPresetCategory,
  PermissionProfileRecord,
  PermissionSurface,
  ToolApprovalMode,
  ToolProfile,
  ToolGrantRecord,
} from "@goatcitadel/contracts";
import {
  archiveWorkspace,
  activatePermissionProfile,
  archivePermissionProfile,
  bootstrapOnboarding,
  completeOnboarding,
  connectMcpServer,
  createChannelSetupDraft,
  createIntegrationConnection,
  createMcpServer,
  createPersonality,
  createLocalOperatorOverride,
  createPermissionProfile,
  createToolGrant,
  createWorkspace,
  deleteOpenAICodexOAuthCredential,
  deleteIntegrationConnection,
  deleteMcpServer,
  deletePersonality,
  deleteProviderSecret,
  disableAddon,
  disconnectMcpServer,
  enableAddon,
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
  fetchLlmProviderAdvice,
  fetchSlackOAuthStatus,
  fetchLlamaCppModels,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchMcpTools,
  fetchNpuModels,
  fetchOpenAICodexOAuthStatus,
  fetchOnboardingState,
  fetchActiveLocalOperatorOverrides,
  fetchEffectivePermissionProfile,
  fetchPersonalities,
  fetchPermissionProfiles,
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
  revokeLocalOperatorOverride,
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
  updatePermissionProfile,
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
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { AppRoute } from "@next/app/route-model";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { StatusChip } from "./primitives";
import {
  describeDirtySections,
  useAnySectionDirty,
  useBeforeUnloadGuard,
  useFormDirty,
  useNavigateGuard,
} from "./library/use-form-dirty";
import "./native-routes.css";
import { BudgetSection } from "./settings/sections/BudgetSection";
import { UnknownSettingsSection } from "./settings/sections/UnknownSettingsSection";
import {
  SettingsActionList,
  SettingsButtonRow,
  SettingsCodeBlock,
  SettingsConfigSourceLegend,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsFilterBar,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsMetricGrid,
  SettingsNotice,
  SettingsPageFrame,
  SettingsPanel,
  SettingsPosturePanel,
  SettingsSectionShell,
  SettingsSelectableList,
  SettingsStack,
  SettingsWizardSteps,
  descriptionForSettingsSection,
  formatEffectiveConfigSourceLabel,
  getErrorMessage,
  iconForSettingsSection,
  labelForSettingsSection,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
  type LoadState,
  type NativeLoadIssue,
  type NativeLoadResult,
  type Notice,
  type SettingsNativePageProps,
  type SettingsSectionProps,
  type SettingsWizardStepState,
} from "./settings/SettingsShared";

const TOOL_APPROVAL_MODE_OPTIONS: ToolApprovalMode[] = ["approve_all", "approve_risky", "bypass"];
const TOOL_PROFILE_OPTIONS: ToolProfile[] = [
  "minimal",
  "standard",
  "coding",
  "ops",
  "research",
  "chat-agent",
  "danger",
];
export const BUDGET_MODE_OPTIONS: Array<OnboardingState["settings"]["budgetMode"]> = ["saver", "balanced", "power"];
const PROVIDER_API_STYLE_OPTIONS: ProviderEditorDraft["apiStyle"][] = [
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "openai-chat-completions",
  "bedrock-messages",
];
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

type OnboardingPageState = OnboardingState & {
  runtimeSettings: Awaited<ReturnType<typeof fetchSettings>> | null;
  demoState: DemoBootstrapStateResponse | null;
};

export function SettingsNativePage(props: SettingsNativePageProps) {
  const section = props.route.section ? String(props.route.section) : "general";

  // Ship punchlist H-9 (data integrity) — wire unsaved-state plumbing for the
  // settings surface. The hook registry and beforeunload listener are tracked
  // in ./library/use-form-dirty.ts; sections opt in by calling `useFormDirty`.
  useBeforeUnloadGuard();
  const isSameRoute = useCallback(
    (target: AppRoute) =>
      target.area === props.route.area && (target.section ?? "general") === (props.route.section ?? "general"),
    [props.route.area, props.route.section],
  );
  const {
    navigate: guardedNavigate,
    pending,
    confirmDiscard,
    cancelDiscard,
  } = useNavigateGuard<AppRoute>(props.navigate, isSameRoute);
  const dirtyKeys = useAnySectionDirty();
  const guardedProps: SettingsNativePageProps = { ...props, navigate: guardedNavigate };

  return (
    <SettingsPageFrame
      icon={iconForSettingsSection(section)}
      kicker={`Settings · ${labelForSettingsSection(section)}`}
      title={labelForSettingsSection(section)}
      description={descriptionForSettingsSection(section)}
    >
      {renderSettingsSection({ ...guardedProps, section })}
      <ConfirmModal
        open={pending !== null}
        title="Discard unsaved changes?"
        message={
          dirtyKeys.length > 0
            ? `You have unsaved changes in ${describeDirtySections(dirtyKeys)}.`
            : "You have unsaved changes."
        }
        confirmLabel="Discard changes"
        cancelLabel="Stay on this page"
        danger
        onConfirm={confirmDiscard}
        onCancel={cancelDiscard}
      />
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
    case "permissions":
      return <PermissionsSection {...props} />;
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
  const {
    notifications,
    setNotificationDesktopEnabled,
    setNotificationOnlyWhenUnfocused,
    setNotificationSoundMode,
    setNotificationToastsEnabled,
  } = useUiPreferences();
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
          <SettingsPosturePanel
            settings={data.settings}
            mcpServers={data.mcpServers}
            integrations={data.integrations}
            workspaces={data.workspaces}
            onNavigate={(section) => navigate({ area: "settings", section, theme: route.theme })}
          />
          <SettingsPanel
            title="Setup path"
            subtitle="Begin with the configuration that unlocks useful work; keep deep controls available after that."
          >
            <SettingsActionList
              compact={false}
              maxHeight=""
              items={[
                {
                  label: "Beginner path",
                  description: "Provider, model smoke, first Chat/Cowork/Code outcome, and one proof artifact.",
                  actionLabel: "Start Here",
                  onClick: () => navigate({ area: "settings", section: "onboarding", theme: route.theme }),
                },
                {
                  label: "Advanced controls",
                  description: "Permission profiles, tool grants, MCP servers, channels, add-ons, and runtime tuning.",
                  actionLabel: "Open permissions",
                  onClick: () => navigate({ area: "settings", section: "permissions", theme: route.theme }),
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
                  label: "Start Here",
                  description: "Review onboarding status, setup defaults, and first-run posture.",
                  onClick: () => navigate({ area: "settings", section: "onboarding", theme: route.theme }),
                },
                {
                  label: "Budget",
                  description: "Set budget mode and review cost evidence.",
                  onClick: () => navigate({ area: "settings", section: "budget", theme: route.theme }),
                },
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
                  description: "Run guided channel setup drafts, send trial messages, and finalize.",
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
                  label: "Permissions",
                  description: "Choose operator profiles, defaults, and Local Operator Override state.",
                  onClick: () => navigate({ area: "settings", section: "permissions", theme: route.theme }),
                },
                {
                  label: "Add-ons",
                  description: "Install and control optional add-on runtimes.",
                  onClick: () => navigate({ area: "settings", section: "addons", theme: route.theme }),
                },
              ]}
            />
          </SettingsPanel>
          <SettingsPanel
            title="Notifications and sounds"
            subtitle="Choose how GoatCitadel asks for attention when work completes, blocks, or waits on approval."
            stats={[
              { label: "Toasts", value: notifications.toastsEnabled ? "On" : "Off" },
              { label: "Sound", value: labelForNotificationSoundMode(notifications.soundMode) },
              { label: "Desktop", value: notifications.desktopEnabled ? "On" : "Off" },
            ]}
          >
            <SettingsFieldGrid>
              <SettingsField label="In-app notifications">
                <label className="mc-next-settings-check">
                  <input
                    type="checkbox"
                    checked={notifications.toastsEnabled}
                    onChange={(event) => setNotificationToastsEnabled(event.target.checked)}
                  />
                  <span>Show operator attention toasts</span>
                </label>
                <p className="mc-next-settings-field-note">
                  Toasts stay tied to realtime events and Ops notification history.
                </p>
              </SettingsField>
              <SettingsField label="Sound cue">
                <select
                  className="mc-next-settings-input"
                  value={notifications.soundMode}
                  onChange={(event) => setNotificationSoundMode(normalizeNotificationSoundMode(event.target.value))}
                >
                  <option value="off">Off</option>
                  <option value="subtle">Subtle</option>
                  <option value="normal">Normal</option>
                </select>
                <p className="mc-next-settings-field-note">
                  Sounds use short synthesized cues for done, waiting, and problem states.
                </p>
              </SettingsField>
              <SettingsField label="Desktop notifications">
                <label className="mc-next-settings-check">
                  <input
                    type="checkbox"
                    checked={notifications.desktopEnabled}
                    onChange={(event) => {
                      if (event.target.checked) {
                        void requestBrowserNotificationPermission();
                      }
                      setNotificationDesktopEnabled(event.target.checked);
                    }}
                  />
                  <span>Use system notifications when permission is granted</span>
                </label>
                <p className="mc-next-settings-field-note">
                  Desktop notifications stay permission-aware in browser and native hosts.
                </p>
              </SettingsField>
              <SettingsField label="Attention scope">
                <label className="mc-next-settings-check">
                  <input
                    type="checkbox"
                    checked={notifications.onlyWhenUnfocused}
                    onChange={(event) => setNotificationOnlyWhenUnfocused(event.target.checked)}
                  />
                  <span>Only notify when Mission Control is unfocused</span>
                </label>
                <p className="mc-next-settings-field-note">
                  Keep the active workspace quieter while preserving background completion alerts.
                </p>
              </SettingsField>
            </SettingsFieldGrid>
            <SettingsButtonRow>
              <button
                type="button"
                className="mc-next-button-secondary"
                onClick={() => void requestBrowserNotificationPermission()}
              >
                <Bell size={16} />
                Check permission
              </button>
              <button
                type="button"
                className="mc-next-button-secondary"
                onClick={() => setNotificationSoundMode(notifications.soundMode === "off" ? "subtle" : "off")}
              >
                <Volume2 size={16} />
                {notifications.soundMode === "off" ? "Enable subtle sound" : "Mute sound"}
              </button>
            </SettingsButtonRow>
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function OnboardingSection({ route, navigate, setActiveWorkspaceId }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [onboarding, runtimeSettings, demoState] = await Promise.all([
      fetchOnboardingState(),
      fetchSettings().catch(() => null),
      fetchDemoState().catch(() => null),
    ]);
    return { ...onboarding, runtimeSettings, demoState } satisfies OnboardingPageState;
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [defaultsDraft, setDefaultsDraft] = useState<{
    defaultToolProfile: ToolProfile;
    toolApprovalMode: ToolApprovalMode;
    budgetMode: OnboardingState["settings"]["budgetMode"];
    networkAllowlist: string;
  }>({
    defaultToolProfile: "standard",
    toolApprovalMode: "approve_risky",
    budgetMode: "balanced",
    networkAllowlist: "",
  });

  useEffect(() => {
    if (!data) {
      return;
    }
    setDefaultsDraft({
      defaultToolProfile: normalizeToolProfile(data.settings.defaultToolProfile),
      toolApprovalMode: normalizeToolApprovalMode(data.settings.toolApprovalMode),
      budgetMode: normalizeBudgetMode(data.settings.budgetMode),
      networkAllowlist: data.settings.networkAllowlist.join(", "),
    });
  }, [data]);

  const onboardingPromptSkippingRestriction = !data?.runtimeSettings
    ? "Settings could not be loaded, so first-run defaults that skip normal prompts stay unavailable."
    : data.runtimeSettings.deploymentProfile === "remote_hardened"
      ? "Remote Hardened keeps first-run defaults that skip normal prompts unavailable."
      : null;

  const applyDefaults = async () => {
    if (
      onboardingPromptSkippingRestriction &&
      (defaultsDraft.defaultToolProfile === "danger" || defaultsDraft.toolApprovalMode === "bypass")
    ) {
      setNotice({ tone: "warning", message: onboardingPromptSkippingRestriction });
      return;
    }
    try {
      await bootstrapOnboarding({
        defaultToolProfile: defaultsDraft.defaultToolProfile,
        toolApprovalMode: defaultsDraft.toolApprovalMode,
        budgetMode: defaultsDraft.budgetMode,
        networkAllowlist: splitCommaList(defaultsDraft.networkAllowlist),
        auth: {
          allowLoopbackBypass: false,
        },
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
          <FirstOutcomePathPanel route={route} navigate={navigate} onboarding={data} demoState={data.demoState} />
          <ProviderSmokeEvidencePanel route={route} navigate={navigate} onboarding={data} />
          <SetupCenterPanel route={route} navigate={navigate} onboarding={data} />
          <EcosystemProofLanePanel route={route} navigate={navigate} />
          <SettingsPanel
            title="First-run setup"
            subtitle="Configured readiness for the first trustworthy send."
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
              <SettingsField label="Tool profile">
                <select
                  className="mc-next-settings-input"
                  value={defaultsDraft.defaultToolProfile}
                  onChange={(event) => {
                    const nextProfile = normalizeToolProfile(event.target.value);
                    if (onboardingPromptSkippingRestriction && nextProfile === "danger") {
                      return;
                    }
                    setDefaultsDraft((current) => ({
                      ...current,
                      defaultToolProfile: nextProfile,
                    }));
                  }}
                >
                  {TOOL_PROFILE_OPTIONS.map((profile) => (
                    <option
                      key={profile}
                      value={profile}
                      disabled={Boolean(onboardingPromptSkippingRestriction && profile === "danger")}
                    >
                      {describeToolProfileLabel(profile)}
                    </option>
                  ))}
                </select>
                <p className="mc-next-settings-field-note">{describeToolProfile(defaultsDraft.defaultToolProfile)}</p>
              </SettingsField>
              <SettingsField label="Tool approvals">
                <select
                  className="mc-next-settings-input"
                  value={defaultsDraft.toolApprovalMode}
                  onChange={(event) => {
                    const nextMode = normalizeToolApprovalMode(event.target.value);
                    if (onboardingPromptSkippingRestriction && nextMode === "bypass") {
                      return;
                    }
                    setDefaultsDraft((current) => ({
                      ...current,
                      toolApprovalMode: nextMode,
                    }));
                  }}
                >
                  {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
                    <option
                      key={mode}
                      value={mode}
                      disabled={Boolean(onboardingPromptSkippingRestriction && mode === "bypass")}
                    >
                      {describeToolApprovalMode(mode)}
                    </option>
                  ))}
                </select>
                <p className="mc-next-settings-field-note">
                  {describeToolApprovalModeHelp(defaultsDraft.toolApprovalMode)}
                </p>
                {onboardingPromptSkippingRestriction ? (
                  <p className="mc-next-settings-field-note">{onboardingPromptSkippingRestriction}</p>
                ) : null}
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
                      {labelForBudgetMode(mode)}
                    </option>
                  ))}
                </select>
                <p className="mc-next-settings-field-note">{describeBudgetMode(defaultsDraft.budgetMode)}</p>
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
            label: "Guided context",
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

function FirstOutcomePathPanel({
  route,
  navigate,
  onboarding,
  demoState,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
  onboarding: OnboardingState;
  demoState: DemoBootstrapStateResponse | null;
}) {
  const items = deriveFirstOutcomePathItems(onboarding, demoState);
  const completeCount = items.filter((item) => item.state === "complete").length;
  const nextItem = items.find((item) => item.state !== "complete") ?? items[items.length - 1];

  return (
    <SettingsPanel
      title="First trusted outcome"
      subtitle="Follow one path from provider readiness to a proof-backed Chat, Cowork, or Code result."
      stats={[
        { label: "Progress", value: `${completeCount}/${items.length}` },
        { label: "Next", value: nextItem?.label ?? "Ready" },
        { label: "Evidence", value: items.at(-1)?.state === "complete" ? "Produced" : "Needed" },
      ]}
    >
      <SettingsWizardSteps
        steps={items.map((item) => ({
          label: item.label,
          description: item.description,
          state: item.state,
        }))}
      />
      <SettingsActionList
        items={items.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.actionDescription,
          meta: item.meta,
          actionLabel: item.actionLabel,
          onClick: () => navigate({ ...item.route, theme: route.theme }),
        }))}
        maxHeight=""
      />
    </SettingsPanel>
  );
}

function ProviderSmokeEvidencePanel({
  route,
  navigate,
  onboarding,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
  onboarding: OnboardingState;
}) {
  const items = deriveOnboardingProviderSmokeEvidenceItems(onboarding);
  const completeCount = items.filter((item) => item.state === "complete").length;
  const nextItem = items.find((item) => item.state !== "complete") ?? items.at(-1);

  return (
    <SettingsPanel
      title="Provider smoke evidence"
      subtitle="Configured providers are not release proof until a live smoke lane records pass/fail evidence."
      stats={[
        { label: "State", value: nextItem?.label ?? "Ready" },
        { label: "Complete", value: `${completeCount}/${items.length}` },
        { label: "Live proof", value: items.at(-1)?.state === "complete" ? "Recorded" : "Needed" },
      ]}
    >
      <SettingsWizardSteps
        steps={items.map((item) => ({
          label: item.label,
          description: item.description,
          state: item.state,
        }))}
      />
      <SettingsActionList
        items={[
          {
            id: "provider-smoke-settings",
            label: "Provider diagnostics",
            description: "Review the active provider, model, credential source, and diagnostics before a live smoke.",
            meta: "Configured state",
            actionLabel: "Open providers",
            onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
          },
          {
            id: "provider-smoke-live-proof",
            label: "Live provider proof lane",
            description:
              "Run pnpm verify:install with GOATCITADEL_VERIFY_INSTALL_LIVE_PROVIDER=1 and real credentials to produce release pass/fail evidence.",
            meta: "Fresh credentials required",
            actionLabel: "Manual lane",
          },
        ]}
        maxHeight=""
      />
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
            label: "Provider connection checks",
            description: "Check configured model providers and exact key/source status.",
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

function EcosystemProofLanePanel({
  route,
  navigate,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
}) {
  const items = deriveEcosystemProofLaneItems();

  return (
    <SettingsPanel
      title="Ecosystem proof lanes"
      subtitle="Follow-on setup order for ecosystem claims; blocked lanes stay explicit until a named proof lane passes."
      stats={[
        { label: "First", value: items[0]?.label ?? "None" },
        { label: "Lanes", value: String(items.length) },
        { label: "Claims", value: "Proof-gated" },
      ]}
    >
      <SettingsActionList
        items={items.map((item) => ({
          ...item,
          onClick: () => navigate({ ...item.route, theme: route.theme }),
        }))}
        maxHeight=""
      />
    </SettingsPanel>
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

  // Ship punchlist H-9 (data integrity) — report this section's dirty state to
  // the shared registry so the page-level beforeunload + route-change guards
  // can warn the operator before edits are lost. The baseline is rebuilt from
  // the server snapshot, so a successful save (which triggers `reload()`)
  // naturally collapses dirty back to clean.
  const baselineDraft = useMemo(
    () =>
      editorMode === "new" ? createEmptyPersonalityEditorDraft() : createPersonalityEditorDraft(selectedPersonality),
    [editorMode, selectedPersonality],
  );
  const isDirty = !editorLocked && !arePersonalityDraftsEqual(draft, baselineDraft);
  useFormDirty("settings:personalities", isDirty, { label: "Personalities" });

  const confirmDiscardPersonalityChanges = useCallback(() => {
    if (!isDirty) {
      return true;
    }
    return (
      typeof window === "undefined" ||
      window.confirm("Discard unsaved personality changes before switching editor context?")
    );
  }, [isDirty]);

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
    if (!confirmDiscardPersonalityChanges()) {
      return;
    }
    setEditorMode("new");
    setDraft(createEmptyPersonalityEditorDraft());
    setNotice(null);
  };

  const refreshPersonalities = () => {
    if (!confirmDiscardPersonalityChanges()) {
      return;
    }
    setEditorMode("selected");
    void reload();
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
              <button type="button" className="mc-next-button-secondary" onClick={refreshPersonalities}>
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
                if (!confirmDiscardPersonalityChanges()) {
                  return;
                }
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
            headerAccessory={
              isDirty ? (
                <StatusChip tone="warning" size="sm">
                  Unsaved
                </StatusChip>
              ) : null
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
  apiStyle:
    | "openai-chat-completions"
    | "openai-responses"
    | "openai-codex-responses"
    | "anthropic-messages"
    | "bedrock-messages";
  defaultModel: string;
  apiKeyEnv: string;
};

const OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY = "goatcitadel:openai-codex:oauth-flow";
const OPENAI_CODEX_AUTH_HOST = "auth.openai.com";
const OPENAI_CODEX_MIN_POLL_MS = 1_000;
const OPENAI_CODEX_DEFAULT_POLL_MS = 5_000;

export function createEmptyProviderEditorDraft(): ProviderEditorDraft {
  return {
    providerId: "",
    label: "",
    baseUrl: "",
    apiStyle: "openai-responses",
    defaultModel: "",
    apiKeyEnv: "",
  };
}

export function buildProviderEditorDraft(
  provider?: {
    providerId: string;
    label: string;
    baseUrl: string;
    apiStyle?:
      | "openai-chat-completions"
      | "openai-responses"
      | "openai-codex-responses"
      | "anthropic-messages"
      | "bedrock-messages";
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

export function buildChatGptOAuthProviderDraft(): ProviderEditorDraft {
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

export function isTrustedOpenAICodexVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === OPENAI_CODEX_AUTH_HOST;
  } catch {
    return false;
  }
}

export function normalizeOpenAICodexPollDelayMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(value, OPENAI_CODEX_MIN_POLL_MS)
    : OPENAI_CODEX_DEFAULT_POLL_MS;
}

export function isStoredOpenAICodexOAuthFlow(value: unknown): value is OpenAICodexDeviceStartResponse {
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

export function removeStoredOpenAICodexOAuthFlow(storage: Storage | undefined): void {
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

export function readStoredOpenAICodexOAuthFlowFrom(
  storage: Storage | undefined,
): OpenAICodexDeviceStartResponse | null {
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

export function readStoredOpenAICodexOAuthFlow(): OpenAICodexDeviceStartResponse | null {
  const sessionFlow = readStoredOpenAICodexOAuthFlowFrom(getBrowserStorage("sessionStorage"));
  const localFlow = readStoredOpenAICodexOAuthFlowFrom(getBrowserStorage("localStorage"));
  return sessionFlow ?? localFlow;
}

export function writeStoredOpenAICodexOAuthFlow(flow: OpenAICodexDeviceStartResponse): void {
  try {
    getBrowserStorage("localStorage")?.setItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY, JSON.stringify(flow));
    getBrowserStorage("sessionStorage")?.setItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY, JSON.stringify(flow));
  } catch {
    // Browser storage is a convenience for refresh recovery; pairing still works without it.
  }
}

export function clearStoredOpenAICodexOAuthFlow(): void {
  removeStoredOpenAICodexOAuthFlow(getBrowserStorage("localStorage"));
  removeStoredOpenAICodexOAuthFlow(getBrowserStorage("sessionStorage"));
}

export function formatOpenAICodexOAuthExpiry(flow: OpenAICodexDeviceStartResponse | null): string | null {
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

export function isLikelyLocalProviderBaseUrl(baseUrl: string | undefined): boolean {
  const normalized = (baseUrl ?? "").trim().toLowerCase();
  return /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(normalized);
}

export function formatProviderProbeStateLabel(
  value?: "not_checked" | "ready" | "fallback" | "empty" | "error",
): string {
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

export function formatProviderProbeSourceMeta(provider?: {
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
  if (provider.modelProbeState === "error") {
    return provider.modelProbeWarning
      ? `Live discovery failed: ${provider.modelProbeWarning}`
      : "Live discovery failed";
  }
  if (provider.modelProbeSource === "template_fallback" || provider.modelProbeState === "fallback") {
    return "Template suggestions; not account-verified";
  }
  return formatCheckedAtLabel(provider.modelProbeCheckedAt);
}

export function formatProviderModelsMeta(
  provider:
    | {
        modelProbeState?: "not_checked" | "ready" | "fallback" | "empty" | "error";
        modelProbeSource?: "live" | "template_fallback" | "error_fallback";
      }
    | undefined,
  modelCount: number,
): string {
  if (!provider || !provider.modelProbeState || provider.modelProbeState === "not_checked") {
    return "Not probed";
  }
  if (provider.modelProbeSource === "template_fallback" || provider.modelProbeState === "fallback") {
    return "Suggested, not account-verified";
  }
  if (provider.modelProbeSource === "error_fallback" || provider.modelProbeState === "error") {
    return "Probe failed";
  }
  if (provider.modelProbeState === "empty") {
    return "No verified model list";
  }
  if (provider.modelProbeState === "ready" && provider.modelProbeSource === "live") {
    return modelCount > 0 ? "Live verified" : "No verified model list";
  }
  return modelCount > 0 ? "Suggested, not account-verified" : "No verified model list";
}

export function formatCheckedAtLabel(value?: string): string {
  if (!value) {
    return "Not checked yet";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Last check unavailable";
  }
  return `Checked ${parsed.toLocaleString()}`;
}

export function formatProviderCredentialLabel(
  providerId: string,
  hasApiKey: boolean | undefined,
  codexOAuthStatus: OpenAICodexOAuthStatus | null,
): string {
  if (providerId === "claude-code") {
    return hasApiKey ? "OAuth token ready" : "OAuth token missing";
  }
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

type ProviderSmokeEvidenceInput = {
  providerId: string;
  providerLabel: string;
  credentialReady: boolean;
  credentialMeta: string;
  localEndpoint: boolean;
  modelCount: number;
  modelProbeState?: "not_checked" | "ready" | "fallback" | "empty" | "error";
  modelProbeSource?: "live" | "template_fallback" | "error_fallback";
  modelProbeCheckedAt?: string;
  modelProbeWarning?: string;
  request?: LlmProviderRequestConfig;
};

export function describeProviderRequestOverrides(request?: LlmProviderRequestConfig): string {
  if (!request) {
    return "Default gateway transport";
  }
  const parts: string[] = [];
  if (request.auth) {
    parts.push(`${request.auth.type} auth`);
  }
  const headerCount = Object.keys(request.headers ?? {}).length;
  if (headerCount > 0) {
    parts.push(`${headerCount} header${headerCount === 1 ? "" : "s"}`);
  }
  if (request.proxy?.url) {
    parts.push("proxy");
  }
  if (request.tls) {
    const tlsParts = [
      request.tls.caCertPath ? "CA cert" : "",
      request.tls.clientCertPath ? "client cert" : "",
      request.tls.serverName ? "server name" : "",
      request.tls.insecureSkipVerify ? "skip verify" : "",
    ].filter(Boolean);
    parts.push(tlsParts.length ? `TLS ${tlsParts.join("/")}` : "TLS override");
  }
  return parts.length ? parts.join(", ") : "Default gateway transport";
}

export function deriveProviderSmokeEvidenceItems(input: ProviderSmokeEvidenceInput): Array<{
  id: string;
  label: string;
  description: string;
  meta: string;
  actionLabel: string;
}> {
  const providerLabel = input.providerLabel || input.providerId;
  const probeDescriptor = formatProviderProbeSourceMeta(input);
  const modelMeta = formatProviderModelsMeta(input, input.modelCount);
  const discoveryFailed = input.modelProbeState === "error" || input.modelProbeSource === "error_fallback";
  const liveDiscoveryReady = input.modelProbeState === "ready" && input.modelProbeSource === "live";
  const transportDescription = describeProviderRequestOverrides(input.request);

  return [
    {
      id: "credential",
      label: "Credential or local endpoint",
      description: input.credentialReady
        ? `${providerLabel} has a configured provider key, OAuth credential, or reachable local endpoint.`
        : `${providerLabel} is not configured for sends yet; add a key, finish OAuth, or point it at a local endpoint.`,
      meta: input.credentialMeta,
      actionLabel: input.credentialReady ? "Ready" : "Needed",
    },
    {
      id: "model-discovery",
      label: "Model discovery",
      description: liveDiscoveryReady
        ? `Live discovery returned ${input.modelCount} account-visible model${input.modelCount === 1 ? "" : "s"}.`
        : discoveryFailed
          ? probeDescriptor
          : "Refresh models after provider keys, proxy, and TLS settings are saved.",
      meta: modelMeta,
      actionLabel: liveDiscoveryReady ? "Refresh" : "Check",
    },
    {
      id: "provider-smoke",
      label: "Provider smoke evidence",
      description: !input.credentialReady
        ? "Blocked until the provider has a credential or local endpoint."
        : discoveryFailed
          ? "Blocked by model discovery failure; fix auth, proxy, TLS, or provider URL before making setup claims."
          : liveDiscoveryReady
            ? "Ready for the first configured-provider smoke send; keep pass/fail evidence with the setup record."
            : "Needs a live model discovery or smoke check before public readiness claims.",
      meta: input.credentialReady && liveDiscoveryReady ? "Smoke next" : "Proof required",
      actionLabel: input.credentialReady ? "Probe" : "Blocked",
    },
    {
      id: "transport",
      label: "Auth/proxy/TLS path",
      description:
        transportDescription === "Default gateway transport"
          ? "Using the default gateway transport; model errors will appear in the probe notice and cached evidence."
          : `Custom request path: ${transportDescription}. Save errors and model probe errors are shown as readable operator notices.`,
      meta: transportDescription,
      actionLabel: "Inspect",
    },
  ];
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
  const [providerAdvice, setProviderAdvice] = useState<LoadState<LlmProviderAdviceResponse>>({
    loading: false,
    error: null,
    data: null,
  });
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
  const selectedProviderIsClaudeCodeOAuth = selectedProvider?.providerId === "claude-code";
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
  const selectedProviderExecutionApiStyle = selectedProvider?.resolvedApiStyle ?? selectedProvider?.apiStyle;
  const selectedProviderApiMeta =
    selectedProvider &&
    selectedProviderExecutionApiStyle &&
    selectedProviderExecutionApiStyle !== selectedProvider.apiStyle
      ? `Gateway executes ${selectedProviderExecutionApiStyle}`
      : "Matches configured API";
  const providerApiStyleWarning = getProviderApiStyleWarning(providerDraft);
  const editorHint =
    editorMode === "new"
      ? "Create a new provider definition without expanding the gateway."
      : "Edit the selected provider through runtime settings. Secrets stay on the secure secret endpoints.";
  const selectedProviderCredentialReady = selectedProvider
    ? selectedProviderIsCodexOAuth
      ? codexOAuthConnected
      : selectedProviderIsClaudeCodeOAuth
        ? Boolean(secretState.data?.hasSecret || selectedProvider.hasApiKey)
        : Boolean(secretState.data?.hasSecret || selectedProvider.hasApiKey || selectedProviderIsLocal)
    : false;
  const selectedProviderCredentialMeta = selectedProvider
    ? selectedProviderIsCodexOAuth
      ? codexOAuthConnected
        ? (codexOAuthStatus?.accountLabel ?? "OAuth connected")
        : codexOAuthStatus?.requiresReauth
          ? "OAuth requires reauth"
          : "OAuth not connected"
      : selectedProviderIsLocal && !(secretState.data?.hasSecret || selectedProvider.hasApiKey)
        ? "Local endpoint, no key required"
        : formatSecretStatusMeta(
            secretState.data?.source ?? selectedProvider.apiKeySource,
            secretState.data?.hasSecret ?? selectedProvider.hasApiKey ?? false,
          )
    : "No provider selected";
  const selectedProviderSmokeEvidenceItems = selectedProvider
    ? deriveProviderSmokeEvidenceItems({
        providerId: selectedProvider.providerId,
        providerLabel: selectedProvider.label,
        credentialReady: selectedProviderCredentialReady,
        credentialMeta: selectedProviderCredentialMeta,
        localEndpoint: selectedProviderIsLocal,
        modelCount: availableModels.length,
        modelProbeState: selectedProvider.modelProbeState,
        modelProbeSource: selectedProvider.modelProbeSource,
        modelProbeCheckedAt: selectedProvider.modelProbeCheckedAt,
        modelProbeWarning: selectedProvider.modelProbeWarning,
        request: selectedProviderConfig?.request,
      })
    : [];

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

  const handleLoadProviderAdvice = async () => {
    setProviderAdvice({ loading: true, error: null, data: null });
    try {
      const advice = await fetchLlmProviderAdvice({
        preference: "balanced",
        taskHint: "general GoatCitadel chat, code, and orchestration routing",
        maxCandidates: 5,
      });
      setProviderAdvice({ loading: false, error: null, data: advice });
    } catch (adviceError) {
      setProviderAdvice({ loading: false, error: getErrorMessage(adviceError), data: null });
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
      setNotice({
        tone: "success",
        message: `Provider secret saved. ${formatSecretStorageNotice(next.source, next.hasSecret)}`,
      });
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
      setNotice({
        tone: "success",
        message: `Provider secret removed. ${formatSecretStorageNotice(next.source, next.hasSecret)}`,
      });
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
      const failedProbe = probe?.state === "error";
      setNotice({
        tone: items.length > 0 && !fallbackOnly && !failedProbe ? "success" : "warning",
        message: failedProbe
          ? `Model discovery failed for ${normalized}${probe?.warning ? `: ${probe.warning}` : "."}`
          : fallbackOnly
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
          title="Providers & Models"
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
            <SettingsConfigSourceLegend />
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
            title="Provider advice"
            subtitle="Advisory routing guidance only; no provider configuration is mutated."
            stats={[
              { label: "Candidates", value: String(providerAdvice.data?.candidates.length ?? 0) },
              {
                label: "Mutation",
                value: providerAdvice.data?.mutationPerformed === false ? "none" : "none",
              },
            ]}
          >
            {providerAdvice.error ? <SettingsNotice notice={{ tone: "error", message: providerAdvice.error }} /> : null}
            {providerAdvice.data ? (
              <>
                <SettingsNotice
                  notice={{
                    tone: "info",
                    message: providerAdvice.data.warnings[0] ?? "Provider advice is advisory only.",
                  }}
                />
                <ul className="mc-next-approvals-compact-list">
                  {providerAdvice.data.candidates.map((candidate) => (
                    <li key={`${candidate.providerId}:${candidate.model}`}>
                      <strong>
                        {candidate.providerLabel} · {candidate.model}
                      </strong>
                      <span>
                        Fit {candidate.fitScore} · Cost{" "}
                        {candidate.estimatedCostUsd === undefined
                          ? "unknown"
                          : `$${candidate.estimatedCostUsd.toFixed(4)}`}
                      </span>
                      <p>{candidate.riskNotes.join(" ")}</p>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <SettingsNotice
                notice={{
                  tone: "info",
                  message:
                    "Load advisory provider recommendations to compare configured keys, estimated cost, and routing risk without changing settings.",
                }}
              />
            )}
            <SettingsButtonRow>
              <button
                type="button"
                className="mc-next-button-secondary"
                onClick={() => void handleLoadProviderAdvice()}
                disabled={providerAdvice.loading}
              >
                <Gauge size={16} />
                {providerAdvice.loading ? "Loading advice..." : "Load advice"}
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
                    { label: "Default model", value: selectedProvider.defaultModel, meta: "Configured fallback" },
                    {
                      label: "Configured API",
                      value: selectedProvider.apiStyle,
                      meta: "Saved provider setting",
                    },
                    {
                      label: "Execution API",
                      value: selectedProviderExecutionApiStyle ?? selectedProvider.apiStyle,
                      meta: selectedProviderApiMeta,
                    },
                    {
                      label: selectedProviderIsCodexOAuth || selectedProviderIsClaudeCodeOAuth ? "OAuth" : "API key",
                      value: selectedProviderIsCodexOAuth
                        ? codexOAuthStatus?.connected
                          ? "Connected"
                          : codexOAuthStatus?.requiresReauth
                            ? "Reauth"
                            : "Missing"
                        : selectedProviderIsClaudeCodeOAuth
                          ? secretState.data?.hasSecret || selectedProvider.hasApiKey
                            ? "Configured"
                            : "Missing"
                          : secretState.data?.hasSecret || selectedProvider.hasApiKey
                            ? "Configured"
                            : "Missing",
                      meta: selectedProviderIsCodexOAuth
                        ? (codexOAuthStatus?.accountLabel ?? "ChatGPT/Codex plan")
                        : selectedProviderIsClaudeCodeOAuth
                          ? "Claude subscription token"
                          : formatSecretStatusMeta(
                              secretState.data?.source ?? selectedProvider.apiKeySource,
                              secretState.data?.hasSecret ?? selectedProvider.hasApiKey ?? false,
                            ),
                    },
                    {
                      label: "Secret source",
                      value: formatEffectiveConfigSourceLabel(
                        secretState.data?.source ?? selectedProvider.apiKeySource,
                      ),
                      meta: "Effective source label",
                    },
                    {
                      label: "Probe",
                      value: formatProviderProbeStateLabel(selectedProvider.modelProbeState),
                      meta: formatProviderProbeSourceMeta(selectedProvider),
                    },
                    {
                      label: "Provider models",
                      value: String(availableModels.length),
                      meta: formatProviderModelsMeta(selectedProvider, availableModels.length),
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
                <SettingsActionList
                  items={selectedProviderSmokeEvidenceItems.map((item) => ({
                    ...item,
                    onClick:
                      item.id === "model-discovery" || item.id === "provider-smoke"
                        ? () => void handleRefreshModels(selectedProvider.providerId)
                        : item.id === "transport"
                          ? () => setEditorMode("selected")
                          : undefined,
                  }))}
                  maxHeight=""
                />
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
                          "Key on file status comes from the gateway only. Saved key values do not roundtrip back to the browser; status only reports whether a key exists and whether it is stored in OS keychain, local .env fallback, inline config, or none. This field only accepts a replacement key.",
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
                      <button type="button" className="mc-next-button-danger" onClick={() => void handleDeleteSecret()}>
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
              <SettingsField label="Provider API style">
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
                  {PROVIDER_API_STYLE_OPTIONS.map((style) => (
                    <option key={style} value={style}>
                      {formatProviderApiStyleLabel(style)}
                    </option>
                  ))}
                </select>
                <p className="mc-next-settings-field-note">{describeProviderApiStyle(providerDraft.apiStyle)}</p>
                {providerApiStyleWarning ? (
                  <p className="mc-next-settings-field-note">{providerApiStyleWarning}</p>
                ) : null}
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
              {data.settings.auth.plan?.warnings?.length ? (
                <SettingsActionList
                  items={data.settings.auth.plan.warnings.map((warning) => ({
                    label: "Auth warning",
                    description: warning,
                    tone: "warning",
                  }))}
                />
              ) : null}
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
          host: "Local daemon preview",
          state: "running" as const,
          supported: true,
          controllable: false,
          controlMessage: "Daemon controls are unavailable for this preview run.",
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
                  disabled={!data.daemon?.controllable}
                >
                  <Play size={16} />
                  Start
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void runAndReload(stopDaemon, "Gateway daemon stop requested.")}
                  disabled={!data.daemon?.controllable}
                >
                  <Square size={16} />
                  Stop
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void runAndReload(restartDaemon, "Gateway daemon restart requested.")}
                  disabled={!data.daemon?.controllable}
                >
                  <RotateCcw size={16} />
                  Restart
                </button>
              </SettingsButtonRow>
              {!data.daemon?.controllable && data.daemon?.controlMessage ? (
                <p className="mc-next-settings-help">{data.daemon.controlMessage}</p>
              ) : null}
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
              <SettingsNotice
                notice={{
                  tone: "info",
                  message: selectedCatalog?.operatorActions?.length
                    ? `${selectedCatalog.operatorActions.length} operator action${selectedCatalog.operatorActions.length === 1 ? "" : "s"} are advertised by this catalog entry. Run actions only from a saved connection.`
                    : "Catalog entries without operator actions are setup and diagnostics surfaces only; no hidden runtime action is implied.",
                }}
              />
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
                ) : (
                  <SettingsNotice
                    notice={{
                      tone: "info",
                      message:
                        "This integration has no advertised operator action. Save changes and run diagnostics here; runtime use stays blocked until a catalog action exists.",
                    }}
                  />
                )}
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
              <SettingsNotice
                notice={{
                  tone: "info",
                  message:
                    "Every listed channel starts as a setup draft. Slack uses OAuth, Telegram can discover targets, and all drafts must save, validate, test, and finalize before runtime use.",
                }}
              />
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
            <SettingsPanel
              title="Drafts"
              subtitle="Saved setup drafts, readiness checks, trial sends, and finalization."
            >
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
            subtitle="Edit the draft payload, then check readiness, send a trial message, and finalize it."
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
              <SettingsNotice
                notice={{
                  tone: "info",
                  message:
                    "Runtime invocation is limited to local stdio servers and the built-in Approval Inbox. Generic remote http/sse transports stay configured-only and experimental until a named runtime proof exists.",
                }}
              />
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

// The "all" API surface is exposed through its own explicit action, not the per-surface action row.
const PERMISSION_SURFACE_OPTIONS = [
  "chat",
  "cowork",
  "code",
  "tools",
  "mcp",
] as const satisfies readonly PermissionSurface[];
const PERMISSION_PROFILE_DEFAULT_SURFACE_OPTIONS = [
  "chat",
  "cowork",
  "code",
  "tools",
  "mcp",
  "all",
] as const satisfies readonly PermissionSurface[];
const LOCAL_OPERATOR_OVERRIDE_SCOPE_OPTIONS = [
  "workspace",
  "session",
  "run",
  "operator",
] as const satisfies readonly LocalOperatorOverrideScope[];
const READ_ACCESS_MODE_OPTIONS = ["", "roots_only", "approval_required", "full_disk"] as const satisfies readonly (
  | FilesystemReadAccessMode
  | ""
)[];

interface EffectivePermissionSurfaceState {
  surface: (typeof PERMISSION_SURFACE_OPTIONS)[number];
  profileId?: string;
  profileLabel?: string;
  approvalMode?: string;
  localOperatorOverrideId?: string;
  localOperatorOverride?: LocalOperatorOverrideRecord;
}

type PermissionProfileEditorDraft = {
  label: string;
  description: string;
  approvalMode: ToolApprovalMode;
  toolPatterns: string;
  allow: string;
  deny: string;
  readAccessMode: FilesystemReadAccessMode | "";
  defaultForSurfaces: PermissionSurface[];
};

function PermissionsSection({ activeWorkspaceId }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const effectiveLoadsPromise = Promise.all(
      PERMISSION_SURFACE_OPTIONS.map(async (surface) => ({
        surface,
        load: await nativeLoad(
          `Effective ${surface} permission profile`,
          fetchEffectivePermissionProfile({ workspaceId: activeWorkspaceId, surface }),
          {},
        ),
      })),
    );
    const [profiles, effectiveLoads, activeOverrides, settings] = await Promise.all([
      nativeLoad("Permission profiles", fetchPermissionProfiles({ workspaceId: activeWorkspaceId }), { items: [] }),
      effectiveLoadsPromise,
      nativeLoad("Active Local Operator Overrides", fetchActiveLocalOperatorOverrides(), { items: [] }),
      fetchSettings().catch(() => null),
    ]);
    return {
      issues: nativeLoadIssues([profiles, ...effectiveLoads.map((item) => item.load), activeOverrides]),
      profiles: profiles.data.items,
      effective: effectiveLoads.map(({ surface, load }) => readEffectivePermissionSurfaceState(surface, load.data)),
      activeOverrides: activeOverrides.data.items,
      settings,
    };
  }, [activeWorkspaceId]);
  const { loading, error, data, reload } = useAsyncLoad(load);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("safe");
  const [profileDraft, setProfileDraft] = useState<PermissionProfileEditorDraft>(createEmptyPermissionProfileDraft);
  const [profileEditDraft, setProfileEditDraft] = useState<PermissionProfileEditorDraft>(
    createEmptyPermissionProfileDraft,
  );
  const [overrideDraft, setOverrideDraft] = useState({
    scope: "workspace" as LocalOperatorOverrideScope,
    scopeRef: activeWorkspaceId,
    reason: "",
    ttlSeconds: 600,
  });
  const [overrideAcknowledged, setOverrideAcknowledged] = useState(false);
  const [recentLocalOverride, setRecentLocalOverride] = useState<LocalOperatorOverrideRecord | null>(null);
  const selectedProfile =
    data?.profiles.find((profile) => profile.profileId === selectedProfileId) ?? data?.profiles[0];
  const effectiveOverride = data?.effective.find((item) => item.localOperatorOverride)?.localOperatorOverride;
  const activeOverrides = collectActiveLocalOperatorOverrides([
    effectiveOverride,
    ...(data?.activeOverrides ?? []),
    recentLocalOverride,
  ]);
  const primaryActiveOverride = activeOverrides[0];
  const chatEffectiveProfileLabel =
    data?.effective.find((item) => item.surface === "chat")?.profileLabel ?? "Unavailable";
  const settingsUnavailable = !data?.settings;
  const isRemoteHardened = data?.settings?.deploymentProfile === "remote_hardened";
  const promptSkippingProfileRestriction = settingsUnavailable
    ? "Settings could not be loaded, so profiles that skip normal prompts stay unavailable."
    : isRemoteHardened
      ? "Remote Hardened keeps profiles that skip normal prompts unavailable."
      : null;
  const localOperatorOverrideRestriction = settingsUnavailable
    ? "Settings could not be loaded, so Local Operator Override stays unavailable."
    : isRemoteHardened
      ? "Remote Hardened mode keeps Local Operator Override unavailable."
      : null;
  const selectedProfileBypassesPrompts = selectedProfile?.approvalMode === "bypass";
  const activationBlockedByRemoteHardened = Boolean(promptSkippingProfileRestriction && selectedProfileBypassesPrompts);

  useEffect(() => {
    setOverrideDraft((current) =>
      current.scope === "workspace"
        ? {
            ...current,
            scopeRef: activeWorkspaceId,
          }
        : current,
    );
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!data?.profiles.length) return;
    setSelectedProfileId((current) =>
      data.profiles.some((profile) => profile.profileId === current) ? current : data.profiles[0]!.profileId,
    );
  }, [data?.profiles]);

  useEffect(() => {
    if (effectiveOverride) {
      setRecentLocalOverride(effectiveOverride);
    }
  }, [effectiveOverride]);

  useEffect(() => {
    if (!selectedProfile || selectedProfile.builtin) {
      setProfileEditDraft(createEmptyPermissionProfileDraft());
      return;
    }
    setProfileEditDraft(createPermissionProfileDraftFromRecord(selectedProfile));
  }, [selectedProfile]);

  const handleActivateProfile = async (profileId: string, surface: PermissionSurface) => {
    const profile = data?.profiles.find((item) => item.profileId === profileId);
    if (promptSkippingProfileRestriction && profile?.approvalMode === "bypass") {
      setNotice({ tone: "warning", message: promptSkippingProfileRestriction });
      return;
    }
    try {
      await activatePermissionProfile({ profileId, workspaceId: activeWorkspaceId, surface });
      setNotice({ tone: "success", message: `${labelForPermissionProfile(profileId, data?.profiles)} activated.` });
      await reload();
    } catch (activateError) {
      setNotice({ tone: "error", message: getErrorMessage(activateError) });
    }
  };

  const handleCreateProfile = async () => {
    if (!profileDraft.label.trim()) {
      setNotice({ tone: "warning", message: "Profile name is required." });
      return;
    }
    if (promptSkippingProfileRestriction && profileDraft.approvalMode === "bypass") {
      setNotice({ tone: "warning", message: promptSkippingProfileRestriction });
      return;
    }
    try {
      const created = await createPermissionProfile({
        scope: "workspace",
        scopeRef: activeWorkspaceId,
        ...permissionProfileDraftToMutation(profileDraft),
      });
      setSelectedProfileId(created.profileId);
      setProfileDraft(createEmptyPermissionProfileDraft());
      setNotice({ tone: "success", message: "Permission profile created." });
      await reload();
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleUpdateSelectedProfile = async () => {
    if (!selectedProfile || selectedProfile.builtin) {
      setNotice({ tone: "warning", message: "Select a custom permission profile to edit." });
      return;
    }
    if (!profileEditDraft.label.trim()) {
      setNotice({ tone: "warning", message: "Profile name is required." });
      return;
    }
    if (promptSkippingProfileRestriction && profileEditDraft.approvalMode === "bypass") {
      setNotice({ tone: "warning", message: promptSkippingProfileRestriction });
      return;
    }
    try {
      const updated = await updatePermissionProfile(selectedProfile.profileId, {
        ...permissionProfileDraftToMutation(profileEditDraft),
      });
      setSelectedProfileId(updated.profileId);
      setNotice({ tone: "success", message: "Permission profile updated." });
      await reload();
    } catch (updateError) {
      setNotice({ tone: "error", message: getErrorMessage(updateError) });
    }
  };

  const handleArchiveSelectedProfile = async () => {
    if (!selectedProfile || selectedProfile.builtin) {
      setNotice({ tone: "warning", message: "Select a custom permission profile to archive." });
      return;
    }
    if (!window.confirm(`Archive permission profile ${selectedProfile.label}?`)) {
      return;
    }
    try {
      await archivePermissionProfile(selectedProfile.profileId);
      setSelectedProfileId("safe");
      setNotice({ tone: "success", message: "Permission profile archived." });
      await reload();
    } catch (archiveError) {
      setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    }
  };

  const handleStartOverride = async () => {
    if (localOperatorOverrideRestriction) {
      setNotice({ tone: "warning", message: localOperatorOverrideRestriction });
      return;
    }
    if (!overrideDraft.reason.trim()) {
      setNotice({ tone: "warning", message: "Add a reason before starting Local Operator Override." });
      return;
    }
    const scopeRef = resolveLocalOperatorOverrideScopeRef(
      overrideDraft.scope,
      overrideDraft.scopeRef,
      activeWorkspaceId,
    );
    if (overrideDraft.scope !== "operator" && !scopeRef) {
      setNotice({ tone: "warning", message: "Add a target for this Local Operator Override scope." });
      return;
    }
    if (!overrideAcknowledged) {
      setNotice({
        tone: "warning",
        message:
          "Confirm that this grants broad local tool access, skips normal prompts, and keeps hard safety boundaries in force.",
      });
      return;
    }
    try {
      const override = await createLocalOperatorOverride({
        scope: overrideDraft.scope,
        scopeRef,
        reason: overrideDraft.reason.trim(),
        ttlSeconds: overrideDraft.ttlSeconds,
      });
      setRecentLocalOverride(override);
      setOverrideDraft((current) => ({
        ...current,
        reason: "",
        ttlSeconds: 600,
        scopeRef: current.scope === "workspace" ? activeWorkspaceId : current.scopeRef,
      }));
      setOverrideAcknowledged(false);
      setNotice({
        tone: "warning",
        message: `Local Operator Override ${override.overrideId} is active until ${formatDateTime(override.expiresAt)}.`,
      });
      await reload();
    } catch (overrideError) {
      setNotice({ tone: "error", message: getErrorMessage(overrideError) });
    }
  };

  const handleRevokeOverride = async (overrideId?: string) => {
    if (!overrideId) {
      setNotice({ tone: "warning", message: "No active Local Operator Override to end." });
      return;
    }
    try {
      const revoked = await revokeLocalOperatorOverride(overrideId);
      const revokedAt = revoked.revokedAt ? ` at ${formatDateTime(revoked.revokedAt)}` : "";
      const revokedBy = revoked.revokedBy ? ` by ${revoked.revokedBy}` : "";
      const revokedStatus = revoked.status ? ` (${revoked.status})` : "";
      setRecentLocalOverride((current) => (current?.overrideId === overrideId ? null : current));
      setNotice({
        tone: "success",
        message: `Local Operator Override ${revoked.overrideId} ended${revokedBy}${revokedAt}${revokedStatus}.`,
      });
      await reload();
    } catch (revokeError) {
      setNotice({ tone: "error", message: getErrorMessage(revokeError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="three-column">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsPanel
            title="Permission profiles"
            subtitle="Profiles define normal defaults; hard denies, scoped grants, auth, path jails, and disabled capabilities still win."
            stats={[
              { label: "Profiles", value: String(data.profiles.length) },
              { label: "Chat effective", value: chatEffectiveProfileLabel },
            ]}
          >
            <SettingsSelectableList
              items={data.profiles.map((profile) => ({
                id: profile.profileId,
                title: profile.label,
                meta: profile.builtin ? "Built-in" : profile.scope,
                body: profile.description ?? describePermissionProfile(profile),
              }))}
              selectedId={selectedProfile?.profileId ?? ""}
              onSelect={setSelectedProfileId}
              emptyLabel="No permission profiles returned by the gateway."
              maxHeight="22rem"
            />
          </SettingsPanel>
          <SettingsStack>
            <SettingsPanel
              title={selectedProfile?.label ?? "Profile"}
              subtitle={selectedProfile ? describePermissionProfile(selectedProfile) : "Select a profile to activate."}
              stats={[
                {
                  label: "Approval mode",
                  value: selectedProfile ? describeToolApprovalMode(selectedProfile.approvalMode) : "-",
                },
                { label: "Tool patterns", value: String(selectedProfile?.toolPatterns.length ?? 0) },
                { label: "Read access", value: selectedProfile?.readAccessMode ?? "Global default" },
              ]}
            >
              {selectedProfile ? (
                <>
                  <SettingsActionList
                    items={selectedProfile.toolPatterns.map((pattern) => ({
                      label: pattern,
                      description: "Profile tool pattern",
                    }))}
                    emptyLabel="This profile does not add tool patterns."
                  />
                  <SettingsActionList
                    items={[
                      {
                        label: "Allow",
                        description: (selectedProfile.allow ?? []).length
                          ? (selectedProfile.allow ?? []).join(", ")
                          : "No extra allow patterns",
                      },
                      {
                        label: "Deny",
                        description: (selectedProfile.deny ?? []).length
                          ? (selectedProfile.deny ?? []).join(", ")
                          : "No profile deny patterns",
                      },
                      {
                        label: "Default surfaces",
                        description: selectedProfile.defaultForSurfaces?.length
                          ? selectedProfile.defaultForSurfaces.join(", ")
                          : "No automatic surface default",
                      },
                    ]}
                    emptyLabel="No profile policy details."
                  />
                  {activationBlockedByRemoteHardened ? (
                    <p className="mc-next-settings-field-note">{promptSkippingProfileRestriction}</p>
                  ) : null}
                  <SettingsButtonRow>
                    <button
                      type="button"
                      className="mc-next-button"
                      disabled={activationBlockedByRemoteHardened}
                      onClick={() => void handleActivateProfile(selectedProfile.profileId, "all")}
                    >
                      <ShieldCheck size={16} />
                      Use for all surfaces
                    </button>
                    <button
                      type="button"
                      className="mc-next-button-secondary"
                      disabled={activationBlockedByRemoteHardened}
                      onClick={() => void handleActivateProfile(selectedProfile.profileId, "code")}
                    >
                      <Code2 size={16} />
                      Use for Code
                    </button>
                  </SettingsButtonRow>
                  <SettingsButtonRow>
                    {PERMISSION_SURFACE_OPTIONS.filter((surface) => surface !== "code").map((surface) => (
                      <button
                        key={surface}
                        type="button"
                        className="mc-next-button-secondary"
                        disabled={activationBlockedByRemoteHardened}
                        onClick={() => void handleActivateProfile(selectedProfile.profileId, surface)}
                      >
                        <ShieldCheck size={16} />
                        Use for {surface.toUpperCase()}
                      </button>
                    ))}
                  </SettingsButtonRow>
                </>
              ) : (
                <SettingsEmptyState label="Select a profile." />
              )}
            </SettingsPanel>
            {selectedProfile && !selectedProfile.builtin ? (
              <SettingsPanel title="Edit custom profile" subtitle="Update or archive the selected profile.">
                <PermissionProfileDraftFields
                  draft={profileEditDraft}
                  bypassUnavailableReason={promptSkippingProfileRestriction ?? undefined}
                  setDraft={setProfileEditDraft}
                />
                <SettingsButtonRow>
                  <button type="button" className="mc-next-button" onClick={() => void handleUpdateSelectedProfile()}>
                    <Save size={16} />
                    Save profile
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-danger"
                    onClick={() => void handleArchiveSelectedProfile()}
                  >
                    <Trash2 size={16} />
                    Archive profile
                  </button>
                </SettingsButtonRow>
              </SettingsPanel>
            ) : null}
            <SettingsPanel title="Custom profile" subtitle="Create a workspace-scoped profile for your own workflow.">
              <PermissionProfileDraftFields
                draft={profileDraft}
                bypassUnavailableReason={promptSkippingProfileRestriction ?? undefined}
                setDraft={setProfileDraft}
              />
              <SettingsButtonRow>
                <button type="button" className="mc-next-button" onClick={() => void handleCreateProfile()}>
                  <Plus size={16} />
                  Create profile
                </button>
              </SettingsButtonRow>
            </SettingsPanel>
          </SettingsStack>
          <SettingsPanel
            title="Active defaults"
            subtitle="Effective profile and temporary local override state by surface."
          >
            <SettingsActionList
              items={(data.effective ?? []).map((item) => ({
                label: item.surface.toUpperCase(),
                description: `${item.profileLabel ?? item.profileId ?? "Safe"}${
                  item.approvalMode ? `, ${describeToolApprovalMode(normalizeToolApprovalMode(item.approvalMode))}` : ""
                }${
                  item.localOperatorOverrideId
                    ? `, override ${item.localOperatorOverrideId} until ${formatDateTime(item.localOperatorOverride?.expiresAt)}`
                    : ""
                }`,
              }))}
              emptyLabel="No effective profile state returned."
            />
          </SettingsPanel>
          <SettingsPanel
            title="Local Operator Override"
            subtitle={
              isRemoteHardened
                ? "Remote Hardened mode keeps Local Operator Override unavailable."
                : settingsUnavailable
                  ? "Settings could not be loaded, so Local Operator Override stays unavailable."
                  : "A time-boxed local action that skips normal prompts and grants broad local tool access for the selected scope. Deny rules, auth, path jails, network blocks, disabled capabilities, and Code Mode policy and artifact checks remain enforced."
            }
            stats={[
              { label: "Status", value: activeOverrides.length ? `${activeOverrides.length} active` : "Inactive" },
              {
                label: "Next expiry",
                value: primaryActiveOverride ? formatDateTime(primaryActiveOverride.expiresAt) : "-",
              },
            ]}
          >
            {activeOverrides.length ? (
              <SettingsActionList
                items={activeOverrides.map((override) => ({
                  label: override.overrideId,
                  description: `${override.reason} · started by ${override.createdBy} · operator ${override.operatorId}`,
                  meta: `${override.scope}${override.scopeRef ? ` · ${override.scopeRef}` : ""} · expires ${formatDateTime(override.expiresAt)}`,
                  onClick: () => void handleRevokeOverride(override.overrideId),
                  actionLabel: "End",
                }))}
                emptyLabel="No active override evidence."
              />
            ) : null}
            <SettingsField label="Reason">
              <textarea
                className="mc-next-settings-input"
                value={overrideDraft.reason}
                onChange={(event) => setOverrideDraft((current) => ({ ...current, reason: event.target.value }))}
                rows={4}
                placeholder="Why this local run needs temporary fast-path execution"
              />
            </SettingsField>
            <SettingsField label="Scope">
              <select
                className="mc-next-settings-input"
                value={overrideDraft.scope}
                onChange={(event) =>
                  setOverrideDraft((current) => {
                    const scope = event.target.value as LocalOperatorOverrideScope;
                    return {
                      ...current,
                      scope,
                      scopeRef: resetLocalOperatorOverrideScopeRefForScope(scope, activeWorkspaceId),
                    };
                  })
                }
              >
                {LOCAL_OPERATOR_OVERRIDE_SCOPE_OPTIONS.map((scope) => (
                  <option key={scope} value={scope}>
                    {labelForLocalOperatorOverrideScope(scope)}
                  </option>
                ))}
              </select>
            </SettingsField>
            {overrideDraft.scope !== "operator" ? (
              <SettingsField label={overrideDraft.scope === "workspace" ? "Workspace" : "Target id"}>
                <input
                  className="mc-next-settings-input"
                  value={overrideDraft.scope === "workspace" ? activeWorkspaceId : (overrideDraft.scopeRef ?? "")}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, scopeRef: event.target.value }))}
                  disabled={overrideDraft.scope === "workspace"}
                  placeholder={overrideDraft.scope === "session" ? "session id" : "run id"}
                />
              </SettingsField>
            ) : null}
            <SettingsField label="Duration">
              <select
                className="mc-next-settings-input"
                value={overrideDraft.ttlSeconds}
                onChange={(event) =>
                  setOverrideDraft((current) => ({ ...current, ttlSeconds: Number(event.target.value) }))
                }
              >
                <option value={300}>5 minutes</option>
                <option value={600}>10 minutes</option>
                <option value={1800}>30 minutes</option>
                <option value={3600}>60 minutes</option>
              </select>
            </SettingsField>
            <label className="mc-next-settings-check">
              <input
                type="checkbox"
                checked={overrideAcknowledged}
                onChange={(event) => setOverrideAcknowledged(event.target.checked)}
                disabled={Boolean(localOperatorOverrideRestriction)}
              />
              <span>
                I understand this grants broad local tool access and skips normal prompts for the selected scope. Deny
                rules, auth, path, network, disabled-capability, Code Mode policy, and artifact checks still apply.
              </span>
            </label>
            <SettingsButtonRow>
              <button
                type="button"
                className="mc-next-button-danger"
                disabled={Boolean(localOperatorOverrideRestriction) || !overrideAcknowledged}
                onClick={() => void handleStartOverride()}
              >
                <AlertTriangle size={16} />
                Start temporary override
              </button>
            </SettingsButtonRow>
          </SettingsPanel>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function PermissionProfileDraftFields({
  draft,
  bypassUnavailableReason,
  setDraft,
}: {
  draft: PermissionProfileEditorDraft;
  bypassUnavailableReason?: string;
  setDraft: Dispatch<SetStateAction<PermissionProfileEditorDraft>>;
}) {
  const bypassUnavailable = Boolean(bypassUnavailableReason);
  return (
    <SettingsFieldGrid>
      <SettingsField label="Name">
        <input
          className="mc-next-settings-input"
          value={draft.label}
          onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          placeholder="Review mode, research mode, release captain"
        />
      </SettingsField>
      <SettingsField label="Approval behavior">
        <select
          className="mc-next-settings-input"
          value={draft.approvalMode}
          onChange={(event) => {
            const nextMode = normalizeToolApprovalMode(event.target.value);
            if (bypassUnavailable && nextMode === "bypass") {
              return;
            }
            setDraft((current) => ({
              ...current,
              approvalMode: nextMode,
            }));
          }}
        >
          {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
            <option key={mode} value={mode} disabled={bypassUnavailable && mode === "bypass"}>
              {bypassUnavailable && mode === "bypass"
                ? `${describeToolApprovalMode(mode)} (unavailable)`
                : describeToolApprovalMode(mode)}
            </option>
          ))}
        </select>
        {bypassUnavailableReason ? <p className="mc-next-settings-field-note">{bypassUnavailableReason}</p> : null}
      </SettingsField>
      <SettingsField label="Description" span={2}>
        <textarea
          className="mc-next-settings-input"
          value={draft.description}
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
          rows={3}
          placeholder="Why this profile exists and when to use it"
        />
      </SettingsField>
      <SettingsField label="Read access">
        <select
          className="mc-next-settings-input"
          value={draft.readAccessMode}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              readAccessMode: event.target.value as FilesystemReadAccessMode | "",
            }))
          }
        >
          {READ_ACCESS_MODE_OPTIONS.map((mode) => (
            <option key={mode || "default"} value={mode}>
              {describeReadAccessMode(mode)}
            </option>
          ))}
        </select>
      </SettingsField>
      <SettingsField label="Default surfaces">
        {PERMISSION_PROFILE_DEFAULT_SURFACE_OPTIONS.map((surface) => (
          <label key={surface} className="mc-next-settings-toggle">
            <input
              type="checkbox"
              checked={draft.defaultForSurfaces.includes(surface)}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  defaultForSurfaces: togglePermissionProfileSurface(
                    current.defaultForSurfaces,
                    surface,
                    event.target.checked,
                  ),
                }))
              }
            />
            <span>{surface.toUpperCase()}</span>
          </label>
        ))}
      </SettingsField>
      <SettingsField label="Tool patterns" span={2}>
        <textarea
          className="mc-next-settings-input"
          value={draft.toolPatterns}
          onChange={(event) => setDraft((current) => ({ ...current, toolPatterns: event.target.value }))}
          rows={5}
          placeholder={"session.status\nmemory.read"}
        />
      </SettingsField>
      <SettingsField label="Allow patterns">
        <textarea
          className="mc-next-settings-input"
          value={draft.allow}
          onChange={(event) => setDraft((current) => ({ ...current, allow: event.target.value }))}
          rows={4}
          placeholder="Optional allow patterns"
        />
      </SettingsField>
      <SettingsField label="Deny patterns">
        <textarea
          className="mc-next-settings-input"
          value={draft.deny}
          onChange={(event) => setDraft((current) => ({ ...current, deny: event.target.value }))}
          rows={4}
          placeholder="Optional deny patterns"
        />
      </SettingsField>
    </SettingsFieldGrid>
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
    expiresAt: defaultToolGrantExpiry(),
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
  const approvalBypassRestriction = !data?.settings
    ? "Settings could not be loaded, so routine prompt skipping stays unavailable."
    : data.settings.deploymentProfile === "remote_hardened"
      ? "Remote Hardened mode keeps routine prompt skipping unavailable."
      : null;

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
    const grantScope = grantForm.scope as "global" | "session" | "workspace" | "agent" | "task";
    const scopeRef = grantScope === "global" ? undefined : grantForm.scopeRef.trim();
    if ((grantScope === "session" || grantScope === "agent" || grantScope === "task") && !scopeRef) {
      setNotice({ tone: "warning", message: `Add a ${grantScope} id before creating this tool grant.` });
      return;
    }
    try {
      const expiresAt = grantForm.grantType === "ttl" ? grantForm.expiresAt.trim() : undefined;
      await createToolGrant({
        toolPattern: grantForm.toolPattern.trim(),
        decision: grantForm.decision as "allow" | "deny",
        scope: grantScope,
        scopeRef,
        grantType: grantForm.grantType as "persistent" | "ttl" | "one_time",
        ...(expiresAt ? { expiresAt } : {}),
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
    if (approvalBypassRestriction && approvalModeDraft === "bypass") {
      setNotice({ tone: "warning", message: approvalBypassRestriction });
      return;
    }
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
            title="Global tool prompt mode"
            subtitle="Base prompt behavior for otherwise-allowed tools when no active permission profile overrides it."
            stats={[
              {
                label: "Current",
                value: data.settings?.toolApprovalMode
                  ? describeToolApprovalMode(data.settings.toolApprovalMode)
                  : "Unavailable",
              },
              { label: "Hard blocks", value: "Always enforced" },
            ]}
          >
            <SettingsField label="Tool approvals">
              <select
                className="mc-next-settings-input"
                value={approvalModeDraft}
                onChange={(event) => {
                  const nextMode = normalizeToolApprovalMode(event.target.value);
                  if (approvalBypassRestriction && nextMode === "bypass") {
                    return;
                  }
                  setApprovalModeDraft(nextMode);
                }}
              >
                {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
                  <option key={mode} value={mode} disabled={Boolean(approvalBypassRestriction && mode === "bypass")}>
                    {describeToolApprovalMode(mode)}
                    {approvalBypassRestriction && mode === "bypass" ? " (Unavailable)" : ""}
                  </option>
                ))}
              </select>
              {approvalBypassRestriction ? (
                <p className="mc-next-settings-field-note">
                  {approvalBypassRestriction} Hard blocks and explicit auth stay enforced.
                </p>
              ) : null}
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
            <SettingsPanel title="Create tool grant" subtitle="Create a scoped policy grant for the selected tool.">
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
                        scopeRef: event.target.value === "workspace" ? activeWorkspaceId : "",
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
                    onChange={(event) =>
                      setGrantForm((current) => ({
                        ...current,
                        grantType: event.target.value,
                        expiresAt:
                          event.target.value === "ttl" && !current.expiresAt
                            ? defaultToolGrantExpiry()
                            : current.expiresAt,
                      }))
                    }
                  >
                    <option value="persistent">Persistent</option>
                    <option value="ttl">TTL</option>
                    <option value="one_time">One time</option>
                  </select>
                </SettingsField>
                {grantForm.grantType === "ttl" ? (
                  <SettingsField label="Expires at">
                    <input
                      className="mc-next-settings-input"
                      value={grantForm.expiresAt}
                      onChange={(event) => setGrantForm((current) => ({ ...current, expiresAt: event.target.value }))}
                      placeholder="2099-01-01T00:00:00.000Z"
                    />
                  </SettingsField>
                ) : null}
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
            subtitle="Selected catalog entry and tool grants."
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
                      value: String(
                        data.grants.filter(
                          (item) => matchesToolGrant(item, selectedTool.toolName) && isToolGrantAvailable(item),
                        ).length,
                      ),
                      meta: "Active, unexpired matches",
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
              items={data.grants
                .filter((item) => (selectedTool ? matchesToolGrant(item, selectedTool.toolName) : true))
                .map((item) => ({
                  id: item.grantId,
                  label: item.toolPattern,
                  description: `${item.scope}${item.scopeRef ? `:${item.scopeRef}` : ""} · ${item.decision} · ${item.grantType}${
                    item.revokedBy ? ` · revoked by ${item.revokedBy}` : ""
                  }`,
                  meta: describeToolGrantAvailability(item),
                  onClick: item.revokedAt ? undefined : () => void handleRevokeGrant(item.grantId),
                  actionLabel: item.revokedAt ? "Revoked" : "Revoke",
                }))}
              emptyLabel={selectedTool ? "No tool grants match this catalog entry." : "No tool grants created yet."}
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
  const selectedInstalledRecord = selectedAddon
    ? (status.data?.installed ?? installedById.get(selectedAddon.addonId))
    : undefined;
  const selectedAddonInstalled = Boolean(selectedInstalledRecord);
  const selectedAddonEnabled = selectedInstalledRecord
    ? selectedInstalledRecord.enabled !== false && selectedInstalledRecord.runtimeStatus !== "disabled"
    : false;
  const selectedAddonRuntimeStatus = status.data?.status ?? selectedInstalledRecord?.runtimeStatus ?? "not_installed";
  const selectedAddonCanStop =
    selectedAddonInstalled && selectedAddonEnabled && ["running", "error"].includes(selectedAddonRuntimeStatus);

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
              items={data.catalog.map((item) => {
                const installed = installedById.get(item.addonId);
                const lifecycle = installed
                  ? installed.enabled === false || installed.runtimeStatus === "disabled"
                    ? "disabled"
                    : "enabled"
                  : "not installed";
                return {
                  id: item.addonId,
                  title: item.label,
                  meta: item.trustTier,
                  body: `${item.category} · ${lifecycle}`,
                };
              })}
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
                      value: selectedAddonRuntimeStatus,
                      meta: selectedAddon.runtimeType,
                    },
                    {
                      label: "Lifecycle",
                      value: selectedAddonInstalled ? (selectedAddonEnabled ? "enabled" : "disabled") : "not installed",
                      meta: selectedInstalledRecord?.updatedAt ?? "No installed record",
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
                    disabled={!selectedAddonInstalled || selectedAddonEnabled}
                    onClick={() =>
                      void runAddonAction(
                        () => enableAddon(selectedAddon.addonId),
                        `${selectedAddon.label} enabled for operator launch.`,
                      )
                    }
                  >
                    <ShieldCheck size={16} />
                    Enable
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    disabled={!selectedAddonInstalled || !selectedAddonEnabled}
                    onClick={() =>
                      void runAddonAction(
                        () => disableAddon(selectedAddon.addonId),
                        `${selectedAddon.label} disabled and slots removed.`,
                      )
                    }
                  >
                    <Plug2 size={16} />
                    Disable
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    disabled={!selectedAddonInstalled || !selectedAddonEnabled}
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
                    disabled={!selectedAddonCanStop}
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
                        Install pack
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

export function collectDefinitionFieldHints(definition: ChannelSetupDefinition) {
  const fields = definition.wizard.steps.flatMap((step) => step.fields ?? []);
  return fields.slice(0, 10).map((field) => ({
    label: field.label,
    explanation: field.explanation,
    type: field.type,
  }));
}

export function matchesToolGrant(grant: ToolGrantRecord, toolName: string) {
  const pattern = grant.toolPattern.trim();
  if (!pattern) {
    return false;
  }
  if (pattern === "*") {
    return true;
  }
  if (!pattern.includes("*")) {
    return pattern === toolName;
  }
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

export function isToolGrantAvailable(grant: ToolGrantRecord, nowMs = Date.now()) {
  if (grant.revokedAt) {
    return false;
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= nowMs) {
      return false;
    }
  }
  if (grant.grantType === "one_time") {
    return (grant.usesRemaining ?? 0) > 0;
  }
  return true;
}

export function describeToolGrantAvailability(grant: ToolGrantRecord, nowMs = Date.now()) {
  if (grant.revokedAt) {
    return `revoked ${formatDateTime(grant.revokedAt)}`;
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= nowMs) {
      return `expired ${formatDateTime(grant.expiresAt)}`;
    }
  }
  if (grant.grantType === "one_time" && (grant.usesRemaining ?? 0) <= 0) {
    return "exhausted";
  }
  return "available";
}

export function defaultToolGrantExpiry(nowMs = Date.now()) {
  return new Date(nowMs + 60 * 60 * 1000).toISOString();
}

export function parseJsonObject(value: string, fallback: Record<string, unknown> = {}) {
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

export function splitCommaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitLineList(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitLineOrCommaList(value: string) {
  return value
    .split(/\r?\n|,/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createEmptyPermissionProfileDraft(): PermissionProfileEditorDraft {
  return {
    label: "",
    description: "",
    approvalMode: "approve_all",
    toolPatterns: "session.status\nmemory.read",
    allow: "",
    deny: "",
    readAccessMode: "",
    defaultForSurfaces: [],
  };
}

export function createPermissionProfileDraftFromRecord(profile: PermissionProfileRecord): PermissionProfileEditorDraft {
  return {
    label: profile.label,
    description: profile.description ?? "",
    approvalMode: profile.approvalMode,
    toolPatterns: profile.toolPatterns.join("\n"),
    allow: (profile.allow ?? []).join("\n"),
    deny: (profile.deny ?? []).join("\n"),
    readAccessMode: profile.readAccessMode ?? "",
    defaultForSurfaces: profile.defaultForSurfaces ?? [],
  };
}

export function permissionProfileDraftToMutation(draft: PermissionProfileEditorDraft) {
  const description = draft.description.trim();
  return {
    label: draft.label.trim(),
    description: description || undefined,
    approvalMode: draft.approvalMode,
    toolPatterns: splitLineOrCommaList(draft.toolPatterns),
    allow: splitLineOrCommaList(draft.allow),
    deny: splitLineOrCommaList(draft.deny),
    readAccessMode: draft.readAccessMode || undefined,
    defaultForSurfaces: draft.defaultForSurfaces,
  };
}

export function togglePermissionProfileSurface(
  current: PermissionSurface[],
  surface: PermissionSurface,
  checked: boolean,
): PermissionSurface[] {
  if (checked) {
    return current.includes(surface) ? current : [...current, surface];
  }
  return current.filter((item) => item !== surface);
}

function describeReadAccessMode(mode: FilesystemReadAccessMode | "") {
  switch (mode) {
    case "roots_only":
      return "Workspace roots only";
    case "approval_required":
      return "Ask before broader reads";
    case "full_disk":
      return "Full local disk reads";
    default:
      return "Global default";
  }
}

export function deriveSetupCenterItems(onboarding: OnboardingState): Array<{
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
      description: "Optional connectors stay off until explicitly configured and checked.",
      state: "pending",
    },
    {
      label: "Share readiness",
      description: "Unsigned builds need checksums, install checks, screenshots, and notes before sharing.",
      state: "pending",
    },
  ];
}

type FirstOutcomePathItem = {
  id: string;
  label: string;
  description: string;
  actionDescription: string;
  state: SettingsWizardStepState;
  meta: string;
  actionLabel: string;
  route: AppRoute;
};

type OnboardingProviderSmokeEvidenceItem = {
  id: string;
  label: string;
  description: string;
  state: SettingsWizardStepState;
  meta: string;
};

type EcosystemProofLaneItem = {
  id: string;
  label: string;
  description: string;
  meta: string;
  actionLabel: string;
  route: AppRoute;
};

export function deriveEcosystemProofLaneItems(): EcosystemProofLaneItem[] {
  return [
    {
      id: "voice",
      label: "Voice Wake / Talk Mode",
      description:
        "Select/install a local voice runtime and keep wake/talk proof before claiming voice parity beyond local runtime support.",
      meta: "First follow-on lane",
      actionLabel: "Runtime",
      route: { area: "settings", section: "runtime" },
    },
    {
      id: "browser-control",
      label: "Browser control",
      description:
        "Use governed tools/MCP visibility for browser control. Remote browser automation claims need fresh proof.",
      meta: "Tool-governed",
      actionLabel: "MCP",
      route: { area: "settings", section: "mcp" },
    },
    {
      id: "extension-sdk",
      label: "Extension / plugin SDK breadth",
      description:
        "Keep extension claims aligned with installed plugin trust metadata, diagnostics, and @goatcitadel/extensions-sdk evidence.",
      meta: "Catalog-gated",
      actionLabel: "Integrations",
      route: { area: "settings", section: "integrations" },
    },
    {
      id: "packaging-remote",
      label: "Packaging and remote deployment parity",
      description:
        "Windows packaging is the shipped lane; remote, macOS, and Linux claims stay blocked until their named packaging proof passes.",
      meta: "Proof-lane required",
      actionLabel: "Ops",
      route: { area: "ops", section: "diagnostics" },
    },
    {
      id: "mobile-companion",
      label: "Mobile companion/device surfaces",
      description:
        "Use signed device grants and companion-session auth; mobile companion surfaces are not an ungoverned backend shortcut.",
      meta: "Access-gated",
      actionLabel: "Access",
      route: { area: "settings", section: "access" },
    },
    {
      id: "canvas-a2ui",
      label: "Canvas / A2UI parity",
      description:
        "Canvas/A2UI parity needs Mission Control proof and companion runtime evidence before platform-level claims are visible.",
      meta: "Last follow-on lane",
      actionLabel: "Capabilities",
      route: { area: "library", section: "capabilities" },
    },
  ];
}

export function deriveFirstOutcomePathItems(
  onboarding: OnboardingState,
  demoState: DemoBootstrapStateResponse | null,
): FirstOutcomePathItem[] {
  const activeProvider = onboarding.settings.llm.providers.find(
    (provider) => provider.providerId === onboarding.settings.llm.activeProviderId,
  );
  const activeModel = onboarding.settings.llm.activeModel.trim();
  const providerCredentialReady = Boolean(
    activeProvider && (activeProvider.hasApiKey || isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)),
  );
  const providerConnected = Boolean(activeProvider && activeModel && providerCredentialReady);
  const demoSessions = demoState?.sessions ?? [];
  const demoTasks = demoState?.tasks ?? [];
  const hasChatStart = demoSessions.some((session) => session.mode === "chat");
  const hasCoworkStart = Boolean(
    demoSessions.some((session) => session.mode === "cowork") ||
    demoTasks.some((task) => task.title.toLowerCase().includes("cowork")),
  );
  const hasProjectCreation = Boolean(demoState?.project?.projectId || demoState?.project?.workspacePath);
  const providerFailure = describeProviderReadinessFailure(onboarding);

  return [
    {
      id: "provider-key",
      label: "Provider key ready",
      description: providerCredentialReady
        ? `${activeProvider?.label ?? onboarding.settings.llm.activeProviderId} has a provider key or local endpoint.`
        : providerFailure,
      actionDescription: "Open Providers & Models to choose a provider, model, and secret source.",
      state: providerCredentialReady ? "complete" : "active",
      meta: providerCredentialReady ? "Credential ready" : "Needs provider setup",
      actionLabel: "Configure",
      route: { area: "settings", section: "providers" },
    },
    {
      id: "model-discovery",
      label: "Model discovery checked",
      description: providerConnected
        ? `Refresh model discovery for ${activeProvider?.label ?? onboarding.settings.llm.activeProviderId}; ${activeModel} is the selected model.`
        : "Connect a provider and choose a model before checking live account-visible models.",
      actionDescription: "Open Providers & Models, then use Refresh models for the configured provider.",
      state: providerConnected ? "active" : "pending",
      meta: providerConnected ? "Refresh required" : "Blocked by provider",
      actionLabel: "Refresh models",
      route: { area: "settings", section: "providers" },
    },
    {
      id: "provider-smoke",
      label: "Provider smoke evidence",
      description: providerConnected
        ? "Run a configured-provider smoke check and keep the pass/fail evidence before release claims."
        : "Connect a provider first; smoke cannot run without a provider, model, and credential or local endpoint.",
      actionDescription: "Open provider diagnostics and run the configured model check when credentials are ready.",
      state: providerConnected ? "active" : "pending",
      meta: providerConnected ? "Evidence required" : "Blocked by provider",
      actionLabel: "Open checks",
      route: { area: "settings", section: "providers" },
    },
    {
      id: "first-chat",
      label: "First Chat sent",
      description: hasChatStart
        ? "A starter Chat thread is available; send or inspect the first user outcome there."
        : "Open Chat and send the first low-risk prompt after provider smoke evidence is ready.",
      actionDescription: "Open Chat for the first normal response and runtime-context inspection.",
      state: hasChatStart ? "complete" : providerConnected ? "active" : "pending",
      meta: hasChatStart ? "Starter thread ready" : "Needs first send",
      actionLabel: "Open Chat",
      route: { area: "chat" },
    },
    {
      id: "first-cowork",
      label: "First Cowork run",
      description: hasCoworkStart
        ? "A starter Cowork run or task exists for supervised multi-step work."
        : "Start a Cowork run so blockers, approvals, checkpoints, and evidence become inspectable.",
      actionDescription: "Open Cowork to start or resume the first supervised run.",
      state: hasCoworkStart ? "complete" : hasChatStart ? "active" : "pending",
      meta: hasCoworkStart ? "Starter run ready" : "Needs run",
      actionLabel: "Open Cowork",
      route: { area: "cowork" },
    },
    {
      id: "project-created",
      label: "Project created",
      description: hasProjectCreation
        ? "A project exists for the first outcome and can group Chat, Cowork, Code, and artifacts."
        : "Create or bind a project so the first outcome has a durable workspace container.",
      actionDescription: "Open Projects to create or inspect the workspace container for the first outcome.",
      state: hasProjectCreation ? "complete" : hasCoworkStart ? "active" : "pending",
      meta: hasProjectCreation ? "Project ready" : "Needs project",
      actionLabel: "Open Projects",
      route: { area: "projects" },
    },
    {
      id: "proof-artifact",
      label: "Proof artifact produced",
      description:
        "Run validation or inspect generated artifacts after the first outcome; this is the evidence that makes setup trustworthy.",
      actionDescription: "Open generated artifacts or Code validation history to inspect proof.",
      state: hasProjectCreation ? "active" : "pending",
      meta: "Proof required",
      actionLabel: "Inspect proof",
      route: { area: "library", section: "artifacts" },
    },
  ];
}

export function deriveOnboardingProviderSmokeEvidenceItems(
  onboarding: OnboardingState,
): OnboardingProviderSmokeEvidenceItem[] {
  const activeProvider = onboarding.settings.llm.providers.find(
    (provider) => provider.providerId === onboarding.settings.llm.activeProviderId,
  );
  const activeProviderLabel =
    activeProvider?.label ?? (onboarding.settings.llm.activeProviderId.trim() || "No provider");
  const activeModel = onboarding.settings.llm.activeModel.trim();
  const providerCredentialReady = Boolean(
    activeProvider && (activeProvider.hasApiKey || isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)),
  );
  const smokeReady = Boolean(activeProvider && activeModel && providerCredentialReady);

  return [
    {
      id: "configured",
      label: "Provider configured",
      description: providerCredentialReady
        ? `${activeProviderLabel} has a credential source or reachable local endpoint configured.`
        : describeProviderReadinessFailure(onboarding),
      state: providerCredentialReady ? "complete" : "active",
      meta: providerCredentialReady ? "Configured" : "Needs setup",
    },
    {
      id: "smoke-ready",
      label: "Smoke ready",
      description: smokeReady
        ? `${activeProviderLabel} can be smoke-checked with selected model ${activeModel}.`
        : "Choose a provider, model, and credential or local endpoint before running provider smoke.",
      state: smokeReady ? "complete" : providerCredentialReady ? "active" : "pending",
      meta: smokeReady ? "Ready to run" : "Blocked",
    },
    {
      id: "passed-evidence",
      label: "Passed with evidence",
      description: smokeReady
        ? "No live provider smoke evidence is implied here; run the live install lane with real credentials to record pass/fail proof."
        : "Live provider proof is blocked until the provider is configured and smoke-ready.",
      state: smokeReady ? "active" : "pending",
      meta: "GOATCITADEL_VERIFY_INSTALL_LIVE_PROVIDER=1",
    },
  ];
}

export function describeProviderReadinessFailure(onboarding: OnboardingState): string {
  const activeProviderId = onboarding.settings.llm.activeProviderId.trim();
  const activeModel = onboarding.settings.llm.activeModel.trim();
  if (!activeProviderId) {
    return "Choose an active provider before sending cloud-backed work.";
  }
  const activeProvider = onboarding.settings.llm.providers.find((provider) => provider.providerId === activeProviderId);
  if (!activeProvider) {
    return `Provider ${activeProviderId} is selected but is not present in the provider catalog.`;
  }
  if (!activeModel) {
    return `Provider ${activeProvider.label} is selected, but no model is active.`;
  }
  if (!activeProvider.hasApiKey && !isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)) {
    return `Provider ${activeProvider.label} needs an API key or a reachable local endpoint before smoke checks can run.`;
  }
  return `Provider ${activeProvider.label} needs a model smoke check before release claims.`;
}

export function wizardStateForChecklist(
  status?: OnboardingState["checklist"][number]["status"],
): SettingsWizardStepState {
  if (status === "complete") {
    return "complete";
  }
  return status === "needs_input" ? "active" : "pending";
}

export function setupMeta(status?: OnboardingState["checklist"][number]["status"]): string {
  if (status === "complete") {
    return "Pass";
  }
  if (status === "needs_input") {
    return "Needs repair";
  }
  return "Optional";
}

export function normalizeToolApprovalMode(value: string | undefined): ToolApprovalMode {
  return TOOL_APPROVAL_MODE_OPTIONS.includes(value as ToolApprovalMode) ? (value as ToolApprovalMode) : "approve_risky";
}

export function normalizeToolProfile(value: string | undefined): ToolProfile {
  return TOOL_PROFILE_OPTIONS.includes(value as ToolProfile) ? (value as ToolProfile) : "standard";
}

function readEffectivePermissionSurfaceState(
  surface: EffectivePermissionSurfaceState["surface"],
  context: Record<string, unknown>,
): EffectivePermissionSurfaceState {
  const profile = isRecord(context.permissionProfile) ? context.permissionProfile : undefined;
  const override = readLocalOperatorOverride(context.localOperatorOverride);
  return {
    surface,
    profileId: readString(context.permissionProfileId) ?? readString(profile?.profileId),
    profileLabel: readString(context.permissionProfileLabel) ?? readString(profile?.label),
    approvalMode: readString(context.permissionProfileApprovalMode) ?? readString(profile?.approvalMode),
    localOperatorOverrideId: readString(context.localOperatorOverrideId) ?? override?.overrideId,
    localOperatorOverride: override,
  };
}

function readLocalOperatorOverride(value: unknown): LocalOperatorOverrideRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const overrideId = readString(record.overrideId);
  const operatorId = readString(record.operatorId);
  const reason = readString(record.reason);
  const createdAt = readString(record.createdAt);
  const expiresAt = readString(record.expiresAt);
  if (!overrideId || !operatorId || !reason || !createdAt || !expiresAt) {
    return undefined;
  }
  return {
    overrideId,
    operatorId,
    scope: (readString(record.scope) as LocalOperatorOverrideRecord["scope"] | undefined) ?? "workspace",
    scopeRef: readString(record.scopeRef),
    reason,
    status: (readString(record.status) as LocalOperatorOverrideRecord["status"] | undefined) ?? "active",
    createdBy: readString(record.createdBy) ?? operatorId,
    createdAt,
    expiresAt,
    revokedAt: readString(record.revokedAt),
    revokedBy: readString(record.revokedBy),
  };
}

function isActiveLocalOperatorOverride(
  override: LocalOperatorOverrideRecord | null | undefined,
): override is LocalOperatorOverrideRecord {
  if (!override || override.status !== "active" || override.revokedAt) {
    return false;
  }
  const expiresAtMs = Date.parse(override.expiresAt);
  return Number.isFinite(expiresAtMs) ? expiresAtMs > Date.now() : true;
}

function collectActiveLocalOperatorOverrides(
  overrides: Array<LocalOperatorOverrideRecord | null | undefined>,
): LocalOperatorOverrideRecord[] {
  const seen = new Set<string>();
  return overrides
    .filter(isActiveLocalOperatorOverride)
    .filter((override) => {
      if (seen.has(override.overrideId)) {
        return false;
      }
      seen.add(override.overrideId);
      return true;
    })
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function describeToolApprovalMode(value: ToolApprovalMode): string {
  if (value === "approve_all") {
    return "Ask every time";
  }
  if (value === "bypass") {
    return "Skip normal prompts";
  }
  return "Ask for risky work";
}

export function describeToolApprovalModeHelp(value: ToolApprovalMode): string {
  if (value === "approve_all") {
    return "Every otherwise-allowed tool call asks first; useful for audits and first-run learning.";
  }
  if (value === "bypass") {
    return "Allowed tools run without normal prompts in local profiles except nuclear-risk, risky-shell, and read work outside the active read posture. Remote Hardened rejects this mode; hard policy blocks still apply.";
  }
  return "Low-risk allowed tools can run, but caution, danger, and nuclear-risk work asks first.";
}

export function describePermissionProfile(profile: PermissionProfileRecord): string {
  if (profile.description?.trim()) {
    return profile.description.trim();
  }
  const posture = describeToolApprovalMode(profile.approvalMode);
  const scope = profile.scope === "global" ? "global" : `${profile.scope} scoped`;
  return `${posture}; ${scope}; ${profile.toolPatterns.length} tool pattern${
    profile.toolPatterns.length === 1 ? "" : "s"
  }.`;
}

export function labelForPermissionProfile(profileId: string, profiles: PermissionProfileRecord[] = []): string {
  return profiles.find((profile) => profile.profileId === profileId)?.label ?? profileId;
}

export function labelForLocalOperatorOverrideScope(scope: LocalOperatorOverrideScope): string {
  switch (scope) {
    case "operator":
      return "This operator";
    case "session":
      return "Specific session";
    case "run":
      return "Specific run";
    default:
      return "Current workspace";
  }
}

export function resolveLocalOperatorOverrideScopeRef(
  scope: LocalOperatorOverrideScope,
  draftScopeRef: string | undefined,
  activeWorkspaceId: string,
): string | undefined {
  if (scope === "operator") {
    return undefined;
  }
  if (scope === "workspace") {
    return activeWorkspaceId;
  }
  const trimmed = draftScopeRef?.trim();
  return trimmed ? trimmed : undefined;
}

export function resetLocalOperatorOverrideScopeRefForScope(
  scope: LocalOperatorOverrideScope,
  activeWorkspaceId: string,
): string {
  return scope === "workspace" ? activeWorkspaceId : "";
}

export function describeToolProfile(value: ToolProfile): string {
  switch (value) {
    case "minimal":
      return "Smallest tool set for basic chat and status checks.";
    case "coding":
      return "Adds repo, filesystem, terminal, and validation tools for implementation work.";
    case "ops":
      return "Prioritizes runtime, diagnostics, deployment, and repair tooling.";
    case "research":
      return "Prioritizes retrieval, browsing, citations, and synthesis tools.";
    case "chat-agent":
      return "Chat-friendly tools without turning the surface into a full coding workstation.";
    case "danger":
      return "Broadest local tool access profile for fully trusted machines; prompt behavior still comes from the approval mode and hard blocks stay enforced.";
    default:
      return "Balanced default for normal local work without opening the broadest tool set.";
  }
}

export function describeToolProfileLabel(value: ToolProfile): string {
  switch (value) {
    case "chat-agent":
      return "Chat Agent";
    case "danger":
      return "Trusted Local Power";
    default:
      return value
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

export function normalizeBudgetMode(value: string | undefined): OnboardingState["settings"]["budgetMode"] {
  return BUDGET_MODE_OPTIONS.includes(value as OnboardingState["settings"]["budgetMode"])
    ? (value as OnboardingState["settings"]["budgetMode"])
    : "balanced";
}

export function describeBudgetMode(value: OnboardingState["settings"]["budgetMode"]): string {
  if (value === "saver") {
    return "Store a lower-cost budget preference for cost evidence and operator review.";
  }
  if (value === "power") {
    return "Store a quality-first budget preference for cost evidence and operator review.";
  }
  return "Store a balanced budget preference for everyday cost evidence.";
}

export function labelForBudgetMode(value: OnboardingState["settings"]["budgetMode"]): string {
  if (value === "saver") {
    return "Saver";
  }
  if (value === "power") {
    return "Power";
  }
  return "Balanced";
}

function labelForNotificationSoundMode(value: "off" | "subtle" | "normal"): string {
  if (value === "normal") {
    return "Normal";
  }
  if (value === "subtle") {
    return "Subtle";
  }
  return "Off";
}

function normalizeNotificationSoundMode(value: string): "off" | "subtle" | "normal" {
  if (value === "normal" || value === "subtle") {
    return value;
  }
  return "off";
}

async function requestBrowserNotificationPermission(): Promise<void> {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "default") {
    return;
  }
  try {
    await Notification.requestPermission();
  } catch (error) {
    void error;
    // Permission prompts are host/browser controlled and may be unavailable in embedded contexts.
  }
}

function formatProviderApiStyleLabel(value: ProviderEditorDraft["apiStyle"]): string {
  if (value === "openai-responses") {
    return "OpenAI Responses";
  }
  if (value === "openai-codex-responses") {
    return "OpenAI Codex Responses";
  }
  if (value === "anthropic-messages") {
    return "Anthropic Messages";
  }
  return "OpenAI Chat Completions";
}

function describeProviderApiStyle(value: ProviderEditorDraft["apiStyle"]): string {
  if (value === "openai-responses") {
    return "Use for modern OpenAI-compatible Responses endpoints with tool and reasoning support.";
  }
  if (value === "openai-codex-responses") {
    return "Use only for the built-in ChatGPT/Codex OAuth provider.";
  }
  if (value === "anthropic-messages") {
    return "Use for Anthropic Claude providers that speak the Messages API.";
  }
  return "Use for older OpenAI-compatible chat-completions endpoints such as many proxy or local servers.";
}

export function getProviderApiStyleWarning(provider: {
  providerId?: string;
  apiStyle?: ProviderEditorDraft["apiStyle"];
}): string | null {
  if (provider.apiStyle === "openai-codex-responses" && provider.providerId !== "openai-codex") {
    return "Codex Responses is only executed for the built-in OpenAI Codex OAuth provider; other providers resolve to their supported execution API.";
  }
  return null;
}

function formatSecretStatusMeta(source: string | undefined, hasSecret: boolean): string {
  if (!hasSecret) {
    return "No key on file";
  }
  if (source === "keychain") {
    return "Key on file in OS keychain";
  }
  if (source === "env") {
    return "Key on file in local .env fallback";
  }
  if (source === "inline") {
    return "Key on file in inline config";
  }
  return "Key on file; value is never returned";
}

function formatSecretStorageNotice(source: string | undefined, hasSecret: boolean): string {
  if (!hasSecret) {
    return "No key remains on file.";
  }
  if (source === "keychain") {
    return "Stored in OS keychain.";
  }
  if (source === "env") {
    return "Stored in local .env fallback.";
  }
  if (source === "inline") {
    return "Stored in inline config.";
  }
  return "Stored by gateway secret backend.";
}

export function applyIntegrationDefaults(
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

export function isRuntimeInvokableMcpServer(server: { transport: string; url?: string }) {
  return server.transport === "stdio" || server.url?.trim().toLowerCase() === INTERNAL_APPROVAL_INBOX_URL;
}

export function readDraftString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readConnectionConfigString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function preferredChannelDefinition(definitions: ChannelSetupDefinition[]): ChannelSetupDefinition | undefined {
  return (
    definitions.find((item) => item.catalog.catalogId === "channel.slack") ??
    definitions.find((item) => item.catalog.catalogId === "channel.telegram") ??
    definitions[0]
  );
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function formatJson(value: Record<string, unknown>) {
  return JSON.stringify(value, null, 2);
}

export function formatCapabilities(
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

export function deriveLlamaCppAlias(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  const filename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return filename.replace(/\.(gguf|bin)$/i, "") || trimmed;
}

export function createEmptyPersonalityEditorDraft(): PersonalityEditorDraft {
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

export function createPersonalityEditorDraft(personality: PersonalityPreset | null): PersonalityEditorDraft {
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

export function personalityDraftToMutationInput(draft: PersonalityEditorDraft) {
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

export function arePersonalityDraftsEqual(a: PersonalityEditorDraft, b: PersonalityEditorDraft): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.category === b.category &&
    a.description === b.description &&
    a.tone === b.tone &&
    a.style === b.style &&
    a.systemOverlay === b.systemOverlay &&
    a.safetyNotes === b.safetyNotes
  );
}

export function formatPersonalityStatus(personality: PersonalityPreset, defaultPersonalityId: string): string {
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

export function formatPersonalityCategoryLabel(category: PersonalityPresetCategory): string {
  return category
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function normalizePersonalityEditorId(input: string | undefined): string {
  return (
    input
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "Unknown";
  }
  return new Date(parsed).toLocaleString();
}

export {
  SettingsActionList,
  SettingsButtonRow,
  SettingsCodeBlock,
  SettingsConfigSourceLegend,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsFilterBar,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsMetricGrid,
  SettingsNotice,
  SettingsPageFrame,
  SettingsPanel,
  SettingsPosturePanel,
  SettingsSectionShell,
  SettingsSelectableList,
  SettingsStack,
  SettingsWizardSteps,
  descriptionForSettingsSection,
  formatEffectiveConfigSourceLabel,
  getErrorMessage,
  iconForSettingsSection,
  labelForSettingsSection,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
};
export type {
  LoadState,
  NativeLoadIssue,
  NativeLoadResult,
  Notice,
  SettingsNativePageProps,
  SettingsSectionProps,
  SettingsWizardStepState,
};
