/* eslint-disable max-lines -- SettingsNativePage intentionally keeps the new settings routes in one editable module while the product surface is still settling. */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  providerTemplates,
  type AgenticRunListItem,
  type CitadelRecord,
  type DemoBootstrapStateResponse,
  type EvidenceEnvelope,
  type DeviceAccessGrantRecord,
  type LlmProviderRequestConfig,
} from "@goatcitadel/contracts";
import {
  Bell,
  CheckCircle2,
  ExternalLink,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import type {
  ChannelSetupDefinition,
  IntegrationFormSchema,
  McpElicitationRequest,
  McpRemotePreviewResponse,
  McpServerModeManifestResponse,
  McpServerRecord,
  OnboardingState,
  FilesystemReadAccessMode,
  LocalOperatorOverrideScope,
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
  archiveCitadel,
  bootstrapOnboarding,
  completeOnboarding,
  createChannelSetupDraft,
  createPersonality,
  createToolGrant,
  createWorkspace,
  createCitadel,
  deletePersonality,
  fetchAgenticRuns,
  bootstrapDemo,
  fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts,
  discoverTelegramTargets,
  fetchDaemonStatus,
  fetchDeviceAccessGrants,
  fetchInstalledAddons,
  fetchIntegrationConnections,
  fetchSlackOAuthStatus,
  fetchLlamaCppModels,
  fetchMcpServers,
  fetchMeshReadiness,
  fetchNpuModels,
  fetchOnboardingState,
  fetchPersonalities,
  fetchDemoState,
  fetchEvidenceEnvelopes,
  fetchSettings,
  fetchToolCatalog,
  fetchToolGrants,
  fetchVoiceRuntimeStatus,
  fetchWorkspaces,
  listCitadels,
  finalizeChannelSetupDraft,
  installVoiceRuntime,
  patchSettings,
  refreshLlamaCppRuntime,
  refreshNpuRuntime,
  restartDaemon,
  resolveGatewayInstallToken,
  restoreWorkspace,
  restoreCitadel,
  revokeDeviceAccessGrant,
  revokeToolGrant,
  selectVoiceRuntimeModel,
  setDefaultPersonality,
  startDaemon,
  startSlackOAuth,
  startLlamaCppRuntime,
  stopDaemon,
  stopLlamaCppRuntime,
  testChannelSetupDraft,
  updateChannelSetupDraft,
  updatePersonality,
  updateWorkspace,
  updateCitadel,
  validateChannelSetupDraft,
  type OpenAICodexDeviceStartResponse,
  type OpenAICodexOAuthStatus,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  fetchLocalAiReadiness,
  startLocalAiDownload,
  startLocalAiServe,
} from "@goatcitadel/mission-control-shared/api/local-ai";
import { useUiPreferences, type UiDensity } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { getRouteReleaseScope, normalizeAppRoute, routeKicker, type AppRoute } from "@next/app/route-model";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ErrorState, NativeButton, NativeMetricGrid, NativeSelectableList, StatusChip } from "./primitives";
import { NativeCard } from "./NativeRoutePageLayout";
import {
  describeDirtySections,
  useAnySectionDirty,
  useBeforeUnloadGuard,
  useFormDirty,
  useNavigateGuard,
} from "./library/use-form-dirty";
import "./native-routes.css";
import { BudgetSection } from "./settings/sections/BudgetSection";
import { TrustPolicySection } from "./settings/sections/TrustPolicySection";
import { WorkspaceCapabilitiesSection } from "./settings/sections/WorkspaceCapabilitiesSection";
import { CitadelCapabilitiesSection } from "./settings/sections/CitadelCapabilitiesSection";
import { UnknownSettingsSection } from "./settings/sections/UnknownSettingsSection";
import { AddonsSection } from "./settings/sections/AddonsSection";
import { PermissionsSection } from "./settings/sections/PermissionsSection";
import { McpSection } from "./settings/sections/McpSection";
import { IntegrationsSection } from "./settings/sections/IntegrationsSection";
import { ProvidersSection } from "./settings/sections/ProvidersSection";
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
  SettingsNotice,
  SettingsPageFrame,
  SettingsPosturePanel,
  SettingsSectionShell,
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

export const TOOL_APPROVAL_MODE_OPTIONS: ToolApprovalMode[] = ["approve_all", "approve_risky", "bypass"];
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
  firstRunEvidence: FirstRunEvidenceSnapshot;
};

export type FirstRunEvidenceSnapshot = {
  recentRuns: AgenticRunListItem[];
  evidenceEnvelopes: EvidenceEnvelope[];
};

export function buildFirstRunEvidenceSnapshot(
  recentRuns: AgenticRunListItem[],
  evidenceEnvelopes: EvidenceEnvelope[],
): FirstRunEvidenceSnapshot {
  const runIds = new Set(recentRuns.map((run) => run.runId).filter((runId): runId is string => Boolean(runId)));
  return {
    recentRuns,
    evidenceEnvelopes: evidenceEnvelopes.filter((envelope) => {
      if (!envelope.runId) {
        return false;
      }
      return runIds.size === 0 || runIds.has(envelope.runId);
    }),
  };
}

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
      kicker={routeKicker(normalizeAppRoute(props.route))}
      title={labelForSettingsSection(section)}
      description={descriptionForSettingsSection(section)}
      releaseStatus={getRouteReleaseScope(props.route).status}
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
    case "local-ai":
      return <LocalAiSection {...props} />;
    case "personalities":
      return <PersonalitiesSection {...props} />;
    case "access":
      return <AccessSection {...props} />;
    case "permissions":
      return <PermissionsSection {...props} />;
    case "trust-policy":
      return <TrustPolicySection {...props} />;
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
    case "workspace-capabilities":
      return <WorkspaceCapabilitiesSection {...props} />;
    case "citadel-capabilities":
      return <CitadelCapabilitiesSection {...props} />;
    default:
      return <UnknownSettingsSection {...props} />;
  }
}

function LocalAiSection(_props: SettingsSectionProps) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const readiness = await nativeLoad("Local AI readiness", fetchLocalAiReadiness(), null);
    return {
      issues: nativeLoadIssues([readiness]),
      readiness: readiness.data,
    };
  }, []);
  const topRecommendation = data?.readiness?.recommendations?.[0] ?? null;

  const handleQueueDownload = async () => {
    if (!topRecommendation) {
      setNotice({ tone: "warning", message: "No local model recommendation is available yet." });
      return;
    }
    try {
      const job = await startLocalAiDownload({
        modelId: topRecommendation.modelId,
        backend: topRecommendation.backend,
      });
      setNotice({ tone: "success", message: `${job.status}: approval ${job.approvalId ?? job.jobId}` });
      await reload();
    } catch (downloadError) {
      setNotice({ tone: "error", message: getErrorMessage(downloadError) });
    }
  };

  const handleQueueServe = async () => {
    if (!topRecommendation) {
      setNotice({ tone: "warning", message: "No local model recommendation is available yet." });
      return;
    }
    try {
      const job = await startLocalAiServe({
        modelId: topRecommendation.modelId,
        backend: topRecommendation.backend,
      });
      setNotice({ tone: "success", message: `${job.status}: approval ${job.approvalId ?? job.jobId}` });
      await reload();
    } catch (serveError) {
      setNotice({ tone: "error", message: getErrorMessage(serveError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <SettingsGrid>
        <NativeCard
          density="compact"
          className="mc-next-settings-panel"
          title="Hardware readiness"
          subtitle="Read-only local scan and runtime detection."
        >
          <NativeMetricGrid
            items={[
              {
                label: "Platform",
                value: data?.readiness?.hardware?.os?.platform ?? "Unknown",
                meta: data?.readiness?.hardware?.os?.arch,
              },
              {
                label: "CPU cores",
                value: String(data?.readiness?.hardware?.cpu?.logicalCores ?? 0),
                meta: data?.readiness?.hardware?.cpu?.model,
              },
              {
                label: "Memory",
                value: formatLocalAiBytes(data?.readiness?.hardware?.memory?.totalBytes),
                meta: data?.readiness?.hardware?.disk?.modelsRootPath,
              },
            ]}
          />
          <SettingsActionList
            items={(data?.readiness?.hardware?.runtimes ?? []).map((runtime) => ({
              id: runtime.backend,
              label: runtime.backend,
              description: runtime.notes?.join(" ") ?? "Runtime detection has no notes.",
              meta: runtime.detected ? (runtime.command ?? runtime.baseUrl) : runtime.platformSupport,
              actionLabel: runtime.detected ? "Detected" : "Not found",
            }))}
            emptyLabel="No local runtimes were detected."
          />
        </NativeCard>
        <SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Model fit"
            subtitle="Conservative recommendations; no download starts without approval."
          >
            <SettingsActionList
              items={(data?.readiness?.recommendations ?? []).slice(0, 6).map((item) => ({
                id: `${item.modelId}-${item.backend}`,
                label: item.modelId,
                description: [...item.reasons, ...item.limitations].join(" "),
                meta: `${item.backend} · ${item.fit} · ${item.confidence}`,
                actionLabel: item.fit === "not_recommended" ? "Advisory" : "Candidate",
              }))}
              emptyLabel="No recommendations returned yet."
            />
            <SettingsButtonRow>
              <button type="button" className="mc-next-settings-filter" onClick={() => void handleQueueDownload()}>
                Queue download approval
              </button>
              <button type="button" className="mc-next-settings-filter" onClick={() => void handleQueueServe()}>
                Queue serve approval
              </button>
            </SettingsButtonRow>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Jobs and endpoints"
            subtitle="Side-effectful work remains approval-gated."
          >
            <NativeMetricGrid
              items={[
                { label: "Downloads", value: String(data?.readiness?.downloads?.length ?? 0) },
                { label: "Serve jobs", value: String(data?.readiness?.serveJobs?.length ?? 0) },
                { label: "Endpoints", value: String(data?.readiness?.endpoints?.length ?? 0) },
              ]}
            />
          </NativeCard>
        </SettingsStack>
      </SettingsGrid>
    </SettingsSectionShell>
  );
}

function formatLocalAiBytes(value: number | undefined): string {
  if (!value || value <= 0) {
    return "Unknown";
  }
  const gib = value / (1024 * 1024 * 1024);
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
}

function normalizeDensity(value: string): UiDensity {
  return value === "comfortable" || value === "compact" ? value : "default";
}

function labelForDensity(value: UiDensity): string {
  if (value === "comfortable") {
    return "Comfortable";
  }
  if (value === "compact") {
    return "Compact";
  }
  return "Default";
}

function GeneralSection({ activeCitadelId, activeWorkspaceName, route, navigate }: SettingsSectionProps) {
  const {
    density,
    setDensity,
    notifications,
    setNotificationDesktopEnabled,
    setNotificationOnlyWhenUnfocused,
    setNotificationSoundMode,
    setNotificationToastsEnabled,
  } = useUiPreferences();
  const load = useCallback(async () => {
    const [settings, workspaces, integrations, mcpServers, tools, addons, meshReadiness] = await Promise.all([
      nativeLoad("Settings", fetchSettings(), null),
      nativeLoad(
        "Workspaces",
        activeCitadelId ? fetchWorkspaces("all", 400, activeCitadelId) : fetchWorkspaces("all", 400),
        { items: [] },
      ),
      nativeLoad("Integrations", fetchIntegrationConnections(), { items: [] }),
      nativeLoad("MCP servers", fetchMcpServers(), { items: [] }),
      nativeLoad("Tools", fetchToolCatalog(), { items: [] }),
      nativeLoad("Add-ons", fetchInstalledAddons(), { items: [] }),
      nativeLoad("Mesh readiness", fetchMeshReadiness(), null),
    ]);
    return {
      issues: nativeLoadIssues([settings, workspaces, integrations, mcpServers, tools, addons, meshReadiness]),
      settings: settings.data,
      workspaces: workspaces.data.items,
      integrations: integrations.data.items,
      mcpServers: mcpServers.data.items,
      tools: tools.data.items,
      addons: addons.data.items,
      meshReadiness: meshReadiness.data,
    };
  }, [activeCitadelId]);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {data ? (
        <SettingsGrid variant="three-column">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Mission Control posture"
            subtitle="Core defaults and system posture at a glance."
            stats={[
              { label: "Workspace", value: activeWorkspaceName },
              { label: "Providers", value: String(data.settings?.llm?.providers?.length ?? 0) },
              { label: "Auth", value: data.settings?.auth?.mode ?? "unknown" },
            ]}
          >
            <NativeMetricGrid
              items={[
                {
                  label: "Workspaces",
                  value: String(data.workspaces?.length ?? 0),
                  meta: "Contexts available to switch or edit",
                },
                {
                  label: "Integrations",
                  value: String(data.integrations?.length ?? 0),
                  meta: "Configured external connections",
                },
                { label: "MCP", value: String(data.mcpServers?.length ?? 0), meta: "External tool servers" },
                {
                  label: "Mesh readiness",
                  value: data.meshReadiness?.status ?? "unknown",
                  meta: data.meshReadiness
                    ? `${data.meshReadiness.blockers.length} blocker${data.meshReadiness.blockers.length === 1 ? "" : "s"}`
                    : "diagnostics unavailable",
                },
                { label: "Tools", value: String(data.tools?.length ?? 0), meta: "Catalog entries with policy posture" },
                { label: "Add-ons", value: String(data.addons?.length ?? 0), meta: "Installed extensions" },
                {
                  label: "Active model",
                  value: data.settings?.llm?.activeModel ?? "n/a",
                  meta: data.settings?.llm?.activeProviderId ?? "No active provider",
                },
              ]}
            />
          </NativeCard>
          <SettingsPosturePanel
            settings={data.settings}
            mcpServers={data.mcpServers ?? []}
            integrations={data.integrations ?? []}
            workspaces={data.workspaces ?? []}
            onNavigate={(section) => navigate({ area: "settings", section, theme: route.theme })}
          />
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Setup path"
            subtitle="Begin with the configuration that unlocks useful work; keep deep controls available after that."
          >
            <SettingsActionList
              compact={false}
              maxHeight=""
              items={[
                {
                  label: "Beginner path",
                  description: "Provider/local path, first Work task, retained evidence, and Run Detail inspection.",
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
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
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
                  description: "Edit conversation tone presets and choose the global Work default.",
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
                  label: "Trust & Policy",
                  description: "Review capability, tool, and source posture before opening editor surfaces.",
                  onClick: () => navigate({ area: "settings", section: "trust-policy", theme: route.theme }),
                },
                {
                  label: "Add-ons",
                  description: "Install and control optional add-on runtimes.",
                  onClick: () => navigate({ area: "settings", section: "addons", theme: route.theme }),
                },
              ]}
            />
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Interface"
            subtitle="Tune how dense the operator surfaces feel. The choice persists on this device."
            stats={[{ label: "Density", value: labelForDensity(density) }]}
          >
            <SettingsFieldGrid>
              <SettingsField label="Display density">
                <select
                  className="mc-next-settings-input"
                  value={density}
                  onChange={(event) => setDensity(normalizeDensity(event.target.value))}
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="default">Default</option>
                  <option value="compact">Compact</option>
                </select>
                <p className="mc-next-settings-field-note">
                  Comfortable enlarges type and controls; Compact tightens them for dense, evidence-heavy work.
                </p>
              </SettingsField>
            </SettingsFieldGrid>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
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
              <NativeButton variant="secondary" onClick={() => void requestBrowserNotificationPermission()}>
                <Bell size={16} />
                Check permission
              </NativeButton>
              <NativeButton
                variant="secondary"
                onClick={() => setNotificationSoundMode(notifications.soundMode === "off" ? "subtle" : "off")}
              >
                <Volume2 size={16} />
                {notifications.soundMode === "off" ? "Enable subtle sound" : "Mute sound"}
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

function OnboardingSection({ route, navigate, setActiveWorkspaceId }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [onboarding, runtimeSettings, demoState, agenticRuns, evidenceEnvelopes] = await Promise.all([
      fetchOnboardingState(),
      fetchSettings().catch(() => null),
      fetchDemoState().catch(() => null),
      fetchAgenticRuns({ limit: 10 }).catch(() => ({ items: [] })),
      fetchEvidenceEnvelopes({ limit: 10 }).catch(() => ({ items: [] })),
    ]);
    return {
      ...onboarding,
      runtimeSettings,
      demoState,
      firstRunEvidence: buildFirstRunEvidenceSnapshot(agenticRuns.items ?? [], evidenceEnvelopes.items ?? []),
    } satisfies OnboardingPageState;
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
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
      defaultToolProfile: normalizeToolProfile(data.settings?.defaultToolProfile),
      toolApprovalMode: normalizeToolApprovalMode(data.settings?.toolApprovalMode),
      budgetMode: normalizeBudgetMode(data.settings?.budgetMode),
      networkAllowlist: data.settings?.networkAllowlist?.join(", ") ?? "",
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
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="detail-wide">
          <DemoStartPanel route={route} navigate={navigate} setActiveWorkspaceId={setActiveWorkspaceId} />
          <FirstOutcomePathPanel
            route={route}
            navigate={navigate}
            onboarding={data}
            demoState={data.demoState}
            firstRunEvidence={data.firstRunEvidence}
          />
          <ProviderSmokeEvidencePanel route={route} navigate={navigate} onboarding={data} />
          <SetupCenterPanel route={route} navigate={navigate} onboarding={data} />
          {data.setupReadiness ? (
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Remote profile readiness"
              subtitle="Gateway-owned setup profile for local, LAN, tailnet, and remote-hardened use."
              scrollBody
              bodyMaxHeight="min(58vh, 34rem)"
              stats={[
                { label: "Gateway", value: data.setupReadiness.profile?.gatewayUrl ?? "unknown" },
                { label: "Auth", value: data.setupReadiness.profile?.authMode ?? "unknown" },
                {
                  label: "Posture",
                  value: (data.setupReadiness.profile?.deploymentPosture ?? "unknown").replaceAll("_", " "),
                },
                {
                  label: "Blocked",
                  value: `${data.setupReadiness.summary?.blocked ?? 0} / ${data.setupReadiness.summary?.needsInput ?? 0} input`,
                },
              ]}
            >
              <SettingsWizardSteps
                steps={(data.setupReadiness.items ?? []).slice(0, 6).map((item) => ({
                  label: item.label,
                  description: `${item.value}: ${item.detail}`,
                  state:
                    item.status === "ready"
                      ? "complete"
                      : item.status === "blocked"
                        ? "active"
                        : item.status === "needs_input"
                          ? "active"
                          : "pending",
                }))}
              />
              <SettingsActionList
                items={(data.setupReadiness.items ?? []).map((item) => ({
                  id: item.id,
                  label: item.label,
                  description: item.detail,
                  meta: `${item.status.replaceAll("_", " ")} · ${item.value}`,
                  actionLabel:
                    item.status === "ready"
                      ? "Ready"
                      : item.status === "blocked"
                        ? "Blocked"
                        : item.status === "needs_input"
                          ? "Needs input"
                          : "Needs proof",
                }))}
                maxHeight="min(42vh, 24rem)"
              />
            </NativeCard>
          ) : null}
          <EcosystemProofLanePanel route={route} navigate={navigate} />
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="First-run setup"
            subtitle="Configured readiness for the first trustworthy send."
            stats={[
              { label: "Status", value: data.completed ? "Complete" : "Open" },
              { label: "Provider", value: data.settings?.llm?.activeProviderId || "Unset" },
              { label: "Model", value: data.settings?.llm?.activeModel || "Unset" },
            ]}
          >
            <SettingsWizardSteps
              steps={(data.checklist ?? []).map((item) => ({
                label: item.label,
                description: item.detail ?? item.status,
                state: item.status === "complete" ? "complete" : item.status === "optional" ? "pending" : "active",
              }))}
            />
            {data.firstRunChecklist?.length ? (
              <SettingsActionList
                items={data.firstRunChecklist.map((item) => ({
                  id: item.id,
                  label: item.label,
                  description: item.detail,
                  meta: item.proofRefs.map((ref) => ref.label).join(" · "),
                  actionLabel:
                    item.status === "complete" ? "Ready" : item.status === "optional" ? "Optional" : "Do next",
                }))}
                maxHeight=""
              />
            ) : null}
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
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
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
            <NativeMetricGrid
              items={[
                {
                  label: "Auth",
                  value: data.settings?.auth?.mode ?? "unknown",
                  meta: data.settings?.auth?.tokenConfigured ? "token configured" : "no token configured",
                },
                {
                  label: "Mesh",
                  value: data.settings?.mesh?.enabled ? (data.settings?.mesh?.mode ?? "unknown") : "off",
                  meta: data.settings?.mesh?.nodeId || "no node id",
                },
              ]}
            />
            <SettingsButtonRow>
              <NativeButton variant="default" onClick={() => void applyDefaults()}>
                <Save size={16} />
                Apply defaults
              </NativeButton>
              <NativeButton variant="secondary" onClick={() => void markComplete()}>
                <CheckCircle2 size={16} />
                Mark complete
              </NativeButton>
              <NativeButton variant="secondary" onClick={() => void reload()}>
                <RefreshCw size={16} />
                Refresh
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
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
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
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

  const promptPreview = data?.starterPrompts?.slice(0, 3) ?? [];
  const workspaceLabel = data?.workspace?.name ?? "Not created";

  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Start Here"
      subtitle="Create a safe local demo workspace with sample Work and memory data."
      stats={[
        { label: "Demo", value: loading ? "Checking" : (data?.status ?? "Unknown") },
        { label: "Workspace", value: workspaceLabel },
        { label: "Credentials", value: "Not required" },
      ]}
    >
      {notice ? <SettingsNotice notice={notice} /> : null}
      {error ? <ErrorState size="inline" description={error} /> : null}
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
            description: "Seeds a planning run and build review scenario you can inspect without sending messages.",
            state: data?.sessions?.length ? "complete" : "active",
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
        <NativeButton variant="default" onClick={() => void startDemo()} disabled={busy}>
          <Play size={16} />
          {data?.status === "ready" ? "Open demo" : "Start safe demo"}
        </NativeButton>
        <NativeButton variant="secondary" onClick={() => void reload()} disabled={busy}>
          <RefreshCw size={16} />
          Refresh
        </NativeButton>
      </SettingsButtonRow>
    </NativeCard>
  );
}

function FirstOutcomePathPanel({
  route,
  navigate,
  onboarding,
  demoState,
  firstRunEvidence,
}: {
  route: AppRoute;
  navigate: SettingsNativePageProps["navigate"];
  onboarding: OnboardingState;
  demoState: DemoBootstrapStateResponse | null;
  firstRunEvidence: FirstRunEvidenceSnapshot;
}) {
  const items = deriveFirstOutcomePathItems(onboarding, demoState, firstRunEvidence);
  const completeCount = items.filter((item) => item.state === "complete").length;
  const nextItem = items.find((item) => item.state !== "complete") ?? items[items.length - 1];
  const pathState = deriveFirstRunGovernedJobState(onboarding, demoState, firstRunEvidence);

  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="First trusted outcome"
      subtitle="Follow one path from provider readiness to a proof-backed Work result."
      stats={[
        { label: "Path state", value: pathState },
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
    </NativeCard>
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
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
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
    </NativeCard>
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
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
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
            meta: setupMeta(onboarding.checklist?.find((item) => item.id === "llm")?.status),
            onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
          },
          {
            label: "Runtime health",
            description: "Check daemon, database, llama.cpp, NPU, voice, and local runtime readiness.",
            meta: setupMeta(onboarding.checklist?.find((item) => item.id === "runtime")?.status),
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
    </NativeCard>
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
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
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
    </NativeCard>
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
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedPersonalityId, setSelectedPersonalityId] = useState("");
  const [editorMode, setEditorMode] = useState<"selected" | "new">("selected");
  const [draft, setDraft] = useState<PersonalityEditorDraft>(() => createEmptyPersonalityEditorDraft());
  const selectedPersonality =
    data?.items?.find((item) => item.id === selectedPersonalityId) ?? data?.items?.[0] ?? null;
  const defaultPersonalityId = data?.defaultPersonalityId ?? "default";
  const customCount = data?.items?.filter((item) => !item.builtin).length ?? 0;
  const modifiedBuiltinCount = data?.items?.filter((item) => item.builtin && item.modified).length ?? 0;
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
    if (!data?.items?.length) {
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
            ? "Work personality cleared."
            : `${selectedPersonality.label} is now the global Work default.`,
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
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {/* F-M11: personalities is an experimental surface. Beyond the page-frame
          badge, state it inline since this section's labeling was the weakest. */}
      <p className="mc-next-settings-experimental-note" role="note">
        <strong>Experimental.</strong> Work personalities are an experimental surface and may change before 1.0.
      </p>
      {data ? (
        <SettingsGrid variant="detail-wide">
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Personality catalog"
            subtitle="Built-in presets, custom overlays, and the global Work default."
            scrollBody
            bodyMaxHeight="min(64vh, 38rem)"
            stats={[
              { label: "Presets", value: String(data.items?.length ?? 0) },
              { label: "Custom", value: String(customCount) },
              { label: "Modified", value: String(modifiedBuiltinCount) },
            ]}
          >
            <SettingsButtonRow>
              <NativeButton variant="default" onClick={beginCustomPersonality}>
                <Plus size={16} />
                Add custom personality
              </NativeButton>
              <NativeButton variant="secondary" onClick={refreshPersonalities}>
                <RefreshCw size={16} />
                Refresh
              </NativeButton>
            </SettingsButtonRow>
            <NativeSelectableList
              items={(data.items ?? []).map((item) => ({
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
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title={
              editorMode === "new" ? "New custom personality" : (selectedPersonality?.label ?? "Personality editor")
            }
            subtitle={
              editorMode === "new"
                ? "Create a persisted custom Work overlay."
                : "Edit tone fields, reset built-ins, or set the global Work default."
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
                      "Personality overlays affect Work tone and framing only; safety, privacy, memory, tools, approvals, and policy stay authoritative.",
                  }}
                />
                <SettingsButtonRow>
                  <NativeButton variant="default" onClick={() => void savePersonality()} disabled={!canSave}>
                    <Save size={16} />
                    {editorMode === "new" ? "Create personality" : "Save edits"}
                  </NativeButton>
                  {editorMode === "selected" ? (
                    <NativeButton
                      variant="secondary"
                      onClick={() => void makeDefault()}
                      disabled={!selectedPersonality}
                    >
                      <CheckCircle2 size={16} />
                      {selectedPersonality?.id === "default" ? "Clear Work default" : "Set as Work default"}
                    </NativeButton>
                  ) : null}
                  {editorMode === "selected" && selectedPersonality?.id !== "default" ? (
                    <NativeButton
                      variant={selectedPersonality?.builtin ? "secondary" : "destructive"}
                      onClick={() => void removeOrResetPersonality()}
                      disabled={selectedPersonality?.builtin === true && !selectedPersonality.modified}
                    >
                      {selectedPersonality?.builtin ? <RotateCcw size={16} /> : <Trash2 size={16} />}
                      {selectedPersonality?.builtin ? "Reset built-in" : "Remove custom"}
                    </NativeButton>
                  ) : null}
                  {editorMode === "new" ? (
                    <NativeButton
                      variant="secondary"
                      onClick={() => {
                        setEditorMode("selected");
                        setDraft(createPersonalityEditorDraft(selectedPersonality));
                      }}
                    >
                      <RotateCcw size={16} />
                      Cancel
                    </NativeButton>
                  ) : null}
                </SettingsButtonRow>
              </>
            ) : (
              <SettingsEmptyState label="Choose a personality or create a custom one." />
            )}
          </NativeCard>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

export type ProviderEditorDraft = {
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
export const OPENAI_CODEX_MIN_POLL_MS = 1_000;
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

type AccessSettingsSnapshot = Awaited<ReturnType<typeof fetchSettings>>;
type DaemonStatusSnapshot = Awaited<ReturnType<typeof fetchDaemonStatus>>;

type DesktopMobileContinuityItem = {
  id: string;
  label: string;
  description: string;
  meta: string;
  actionLabel: string;
};

export function deriveDesktopMobileContinuityItems(input: {
  settings: AccessSettingsSnapshot;
  grants: DeviceAccessGrantRecord[];
  daemon: DaemonStatusSnapshot | null;
}): DesktopMobileContinuityItem[] {
  const activeGrants = input.grants.filter((grant) => !grant.revokedAt);
  const mobileGrants = activeGrants.filter((grant) => ["mobile", "tablet"].includes(grant.deviceType));
  const desktopGrants = activeGrants.filter((grant) => grant.deviceType === "desktop");
  const authConfigured =
    (input.settings.auth?.mode === "token" && input.settings.auth?.tokenConfigured) ||
    (input.settings.auth?.mode === "basic" && input.settings.auth?.basicConfigured);
  return [
    {
      id: "desktop-runtime",
      label: "Desktop runtime anchor",
      description: input.daemon
        ? `Gateway daemon is ${input.daemon.state}; host ${input.daemon.host || "unknown"} owns the local runtime boundary.`
        : "Gateway daemon status could not be loaded, so companion devices cannot inspect desktop runtime truth here.",
      meta: input.daemon?.running ? "Desktop ready" : "Needs desktop proof",
      actionLabel: input.daemon?.running ? "Ready" : "Check runtime",
    },
    {
      id: "mobile-trust",
      label: "Mobile approval path",
      description: mobileGrants.length
        ? `${mobileGrants.length} active mobile/tablet device grant(s) can reach the gateway under this auth posture.`
        : "No active mobile/tablet grants are visible; approve a companion device before claiming mobile approvals.",
      meta: mobileGrants.length ? "Access-gated" : "No mobile grant",
      actionLabel: mobileGrants.length ? "Ready" : "Needs grant",
    },
    {
      id: "desktop-device-trust",
      label: "Desktop handoff trust",
      description: desktopGrants.length
        ? `${desktopGrants.length} active desktop device grant(s) are visible for browser or shell handoff.`
        : "Desktop continuity currently relies on the local session and daemon, not an additional device grant.",
      meta: desktopGrants.length ? "Device trust" : "Local session",
      actionLabel: desktopGrants.length ? "Granted" : "Local only",
    },
    {
      id: "install-token",
      label: "Install token lane",
      description: authConfigured
        ? "Auth posture is configured enough to pair companion clients through the install-token/device-request flow."
        : "Auth is open; generate and protect an install token before exposing companion access.",
      meta: input.settings.auth?.mode ?? "unknown",
      actionLabel: authConfigured ? "Pairable" : "Open local",
    },
    {
      id: "share-session-handoff",
      label: "Share/session handoff",
      description:
        "Mobile share intake and Work result handoff must land through gateway-owned sessions, projects, artifacts, and approvals.",
      meta: "Gateway-owned",
      actionLabel: "Boundary",
    },
  ];
}

function AccessSection({ activeWorkspaceName }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [settings, grants, daemon] = await Promise.all([
      fetchSettings(),
      nativeLoad("Device grants", fetchDeviceAccessGrants("all"), { items: [] }),
      nativeLoad("Daemon status", fetchDaemonStatus(), null),
    ]);
    return {
      settings,
      issues: nativeLoadIssues([grants, daemon]),
      grants: grants.data.items,
      daemon: daemon.data,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingRevokeGrantId, setPendingRevokeGrantId] = useState<string | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [form, setForm] = useState({
    mode: "none",
    allowLoopbackBypass: false,
    token: "",
    basicUsername: "",
    basicPassword: "",
  });
  const [installToken, setInstallToken] = useState<string>("");
  const continuityItems = useMemo(
    () =>
      data
        ? deriveDesktopMobileContinuityItems({
            settings: data.settings,
            grants: data.grants ?? [],
            daemon: data.daemon,
          })
        : [],
    [data],
  );

  useEffect(() => {
    if (!data) {
      return;
    }
    setForm({
      mode: data.settings.auth?.mode ?? "none",
      allowLoopbackBypass: data.settings.auth?.allowLoopbackBypass ?? false,
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
    setRevokePending(true);
    try {
      await revokeDeviceAccessGrant(grantId);
      setNotice({ tone: "success", message: "Device access revoked." });
      await reload();
    } catch (revokeError) {
      setNotice({ tone: "error", message: getErrorMessage(revokeError) });
    } finally {
      setRevokePending(false);
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="detail-wide">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsStack>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Gateway access"
              subtitle="Change auth mode, loopback behavior, and optional credentials."
              stats={[
                { label: "Current mode", value: data.settings.auth?.mode ?? "unknown" },
                { label: "Workspace", value: activeWorkspaceName },
              ]}
            >
              {data.settings.auth?.plan?.warnings?.length ? (
                <SettingsActionList
                  items={(data.settings.auth?.plan?.warnings ?? []).map((warning) => ({
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
                <NativeButton variant="default" onClick={() => void handleSave()}>
                  <Save size={16} />
                  Save access settings
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => void handleGenerateInstallToken()}>
                  <RefreshCw size={16} />
                  Generate install token
                </NativeButton>
              </SettingsButtonRow>
              {installToken ? (
                <SettingsCodeBlock label="Install token preview">{installToken}</SettingsCodeBlock>
              ) : null}
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Current posture"
              subtitle="Readable auth state instead of a recycled general page."
            >
              <NativeMetricGrid
                items={[
                  {
                    label: "Loopback bypass",
                    value: data.settings.auth?.allowLoopbackBypass ? "Enabled" : "Disabled",
                    meta:
                      data.settings.auth?.tokenConfigured || data.settings.auth?.basicConfigured
                        ? "Protected mode configured"
                        : "No persisted credentials",
                  },
                  {
                    label: "Token auth",
                    value: data.settings.auth?.tokenConfigured ? "Configured" : "Missing",
                    meta: "Operator token presence",
                  },
                  {
                    label: "Basic auth",
                    value: data.settings.auth?.basicConfigured ? "Configured" : "Missing",
                    meta: "Username/password presence",
                  },
                ]}
              />
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Desktop/mobile continuity"
              subtitle="Trusted devices, desktop runtime state, and companion handoff boundaries."
              stats={[
                { label: "Desktop", value: data.daemon?.state ?? "unknown" },
                {
                  label: "Active devices",
                  value: String((data.grants ?? []).filter((grant) => !grant.revokedAt).length),
                },
              ]}
            >
              <SettingsActionList
                items={continuityItems.map((item) => ({
                  id: item.id,
                  label: item.label,
                  description: item.description,
                  meta: item.meta,
                  actionLabel: item.actionLabel,
                }))}
                maxHeight="min(36vh, 22rem)"
              />
            </NativeCard>
          </SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Approved devices"
            subtitle="View and revoke device grants that can access the gateway."
            stats={[{ label: "Grants", value: String(data.grants?.length ?? 0) }]}
          >
            <SettingsActionList
              items={(data.grants ?? []).map((grant) => ({
                id: grant.grantId,
                label: grant.deviceLabel || grant.grantId,
                description: `${grant.deviceType || "device"} · ${grant.revokedAt ? "revoked" : "active"} · ${formatDateTime(grant.createdAt)}`,
                meta:
                  (typeof grant.metadata.origin === "string" ? grant.metadata.origin : undefined) ||
                  grant.platform ||
                  "Unknown origin",
                onClick: grant.revokedAt ? undefined : () => setPendingRevokeGrantId(grant.grantId),
                actionLabel: grant.revokedAt ? "Revoked" : "Revoke",
              }))}
              emptyLabel="No device grants found."
            />
          </NativeCard>
        </SettingsGrid>
      ) : null}
      <ConfirmModal
        open={pendingRevokeGrantId !== null}
        danger
        title="Revoke device access?"
        message="This device will lose gateway access. This cannot be undone."
        confirmLabel="Revoke"
        pending={revokePending}
        onCancel={() => setPendingRevokeGrantId(null)}
        onConfirm={() => {
          if (pendingRevokeGrantId !== null) {
            void handleRevokeGrant(pendingRevokeGrantId);
          }
          setPendingRevokeGrantId(null);
        }}
      />
    </SettingsSectionShell>
  );
}

function RuntimeSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const settings = await fetchSettings();
    const shouldLoadNpuModels =
      (settings.npu?.enabled ?? false) &&
      ((settings.npu?.status?.healthy ?? false) || settings.npu?.status?.processState === "running");
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
              ...settings.llamaCpp?.status,
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
              ...settings.npu?.status,
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
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
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
      enabled: data.settings.llamaCpp?.enabled ?? false,
      autoStart: data.settings.llamaCpp?.autoStart ?? false,
      baseUrl: data.settings.llamaCpp?.baseUrl ?? "",
      command: data.settings.llamaCpp?.command ?? "",
      modelsRootPath: data.settings.llamaCpp?.modelsRootPath ?? "",
      modelPath: data.settings.llamaCpp?.modelPath ?? "",
      alias: data.settings.llamaCpp?.alias ?? "",
    });
    setNpuForm({
      enabled: false,
      autoStart: false,
      sidecarUrl: data.settings.npu?.sidecarUrl ?? "",
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
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsStack>
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          {data.llamaModelsWarning ? (
            <SettingsNotice notice={{ tone: "info", message: data.llamaModelsWarning }} />
          ) : null}
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Runtime posture"
            subtitle="Providers, local runtimes, and attached systems."
          >
            <NativeMetricGrid
              items={[
                {
                  label: "Daemon",
                  value: data.daemon?.state ?? "unknown",
                  meta: data.daemon?.host ?? "Gateway daemon status",
                },
                {
                  label: "llama.cpp",
                  value: data.settings.llamaCpp?.status?.processState ?? "unknown",
                  meta: `${data.llamaModels?.length ?? 0} models discovered`,
                },
                {
                  label: "NPU",
                  value: data.settings.npu?.status?.processState ?? "unknown",
                  meta: `${data.npuModels?.length ?? 0} models discovered`,
                },
                {
                  label: "Voice",
                  value: data.voiceRuntime?.readiness ?? "unknown",
                  meta: data.voiceRuntime?.selectedModelId ?? "No active voice model",
                },
              ]}
            />
          </NativeCard>
          <SettingsGrid variant="balanced">
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Gateway daemon"
              subtitle="Control the background runtime serving Mission Control."
            >
              <NativeMetricGrid
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
                <NativeButton
                  variant="default"
                  onClick={() => void runAndReload(startDaemon, "Gateway daemon start requested.")}
                  disabled={!data.daemon?.controllable}
                >
                  <Play size={16} />
                  Start
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() => void runAndReload(stopDaemon, "Gateway daemon stop requested.")}
                  disabled={!data.daemon?.controllable}
                >
                  <Square size={16} />
                  Stop
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() => void runAndReload(restartDaemon, "Gateway daemon restart requested.")}
                  disabled={!data.daemon?.controllable}
                >
                  <RotateCcw size={16} />
                  Restart
                </NativeButton>
              </SettingsButtonRow>
              {!data.daemon?.controllable && data.daemon?.controlMessage ? (
                <p className="mc-next-settings-help">{data.daemon.controlMessage}</p>
              ) : null}
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="llama.cpp runtime"
              subtitle="Configure and control the local llama.cpp runtime."
            >
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
                <NativeButton
                  variant="default"
                  onClick={() => void runAndReload(saveLlamaSettings, "llama.cpp settings saved.")}
                >
                  <Save size={16} />
                  Save
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() =>
                    void runAndReload(async () => {
                      await saveLlamaSettings();
                      await startLlamaCppRuntime();
                    }, "llama.cpp start requested.")
                  }
                >
                  <Play size={16} />
                  Start
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() => void runAndReload(stopLlamaCppRuntime, "llama.cpp stop requested.")}
                >
                  <Square size={16} />
                  Stop
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() => void runAndReload(refreshLlamaCppRuntime, "llama.cpp refresh requested.")}
                >
                  <RefreshCw size={16} />
                  Refresh
                </NativeButton>
              </SettingsButtonRow>
              <NativeMetricGrid
                items={[
                  {
                    label: "Process",
                    value: data.settings.llamaCpp?.status?.processState ?? "unknown",
                    meta: data.settings.llamaCpp?.status?.healthy ? "Healthy" : "Needs attention",
                  },
                  {
                    label: "Active model",
                    value: data.settings.llamaCpp?.status?.activeModelId ?? "n/a",
                    meta: data.settings.llamaCpp?.status?.commandSource ?? "source unknown",
                  },
                ]}
              />
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Local acceleration"
              subtitle="NPU sidecar support is retired from the shipped 1.0 runtime."
            >
              <SettingsButtonRow>
                <NativeButton
                  variant="default"
                  onClick={() =>
                    void runAndReload(
                      () =>
                        patchSettings({
                          npu: {
                            enabled: false,
                            autoStart: false,
                            sidecarUrl: npuForm.sidecarUrl,
                          },
                        }),
                      "Retired NPU settings normalized.",
                    )
                  }
                >
                  <Save size={16} />
                  Normalize
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() => void runAndReload(refreshNpuRuntime, "NPU refresh requested.")}
                >
                  <RefreshCw size={16} />
                  Refresh
                </NativeButton>
              </SettingsButtonRow>
              <NativeMetricGrid
                items={[
                  {
                    label: "Process",
                    value: data.settings.npu?.status?.processState ?? "unknown",
                    meta: data.settings.npu?.status?.healthy ? "Healthy" : "Needs attention",
                  },
                  {
                    label: "Backend",
                    value: data.settings.npu?.status?.backend ?? "unknown",
                    meta: data.settings.npu?.status?.lastError ?? data.settings.npu?.sidecarUrl,
                  },
                ]}
              />
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Voice runtime"
              subtitle="Install or activate the local voice transcription runtime."
            >
              <NativeMetricGrid
                items={[
                  {
                    label: "Readiness",
                    value: data.voiceRuntime?.readiness ?? "unknown",
                    meta: data.voiceRuntime?.provider ?? "whisper.cpp",
                  },
                  {
                    label: "Active model",
                    value: data.voiceRuntime?.selectedModelId ?? "none",
                    meta: `${data.voiceRuntime?.installedModels?.length ?? 0} installed`,
                  },
                ]}
              />
              <SettingsButtonRow>
                <NativeButton
                  variant="default"
                  onClick={() => {
                    const recommended =
                      data.voiceRuntime?.catalog?.find((item) => item.defaultInstall)?.id ??
                      data.voiceRuntime?.catalog?.[0]?.id;
                    void runAndReload(
                      () => installVoiceRuntime(recommended ? { modelId: recommended, activate: true } : {}),
                      "Voice runtime install requested.",
                    );
                  }}
                >
                  <Plus size={16} />
                  Install starter model
                </NativeButton>
                {data.voiceRuntime?.installedModels?.[0] ? (
                  <NativeButton
                    variant="secondary"
                    onClick={() =>
                      void runAndReload(
                        () => selectVoiceRuntimeModel(data.voiceRuntime?.installedModels?.[0]?.modelId ?? ""),
                        "Voice model activated.",
                      )
                    }
                  >
                    <CheckCircle2 size={16} />
                    Activate first installed
                  </NativeButton>
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
            </NativeCard>
          </SettingsGrid>
        </SettingsStack>
      ) : null}
    </SettingsSectionShell>
  );
}

const CITADEL_KIND_OPTIONS: Array<CitadelRecord["kind"]> = [
  "personal",
  "company",
  "team",
  "client",
  "household",
  "creator",
  "learning",
  "project",
  "custom",
];

function WorkspacesSection({
  activeCitadelId,
  activeCitadelName,
  activeWorkspaceId,
  setActiveCitadelId,
  setActiveWorkspaceId,
}: SettingsSectionProps) {
  const [view, setView] = useState<"active" | "archived" | "all">("all");
  const [citadelView, setCitadelView] = useState<"active" | "archived" | "all">("all");
  const load = useCallback(
    async () => (activeCitadelId ? fetchWorkspaces("all", 500, activeCitadelId) : fetchWorkspaces("all", 500)),
    [activeCitadelId],
  );
  const loadCitadels = useCallback(() => listCitadels("all", 500), []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const {
    loading: citadelsLoading,
    error: citadelsError,
    data: citadelsData,
    reload: reloadCitadels,
  } = useAsyncLoad(loadCitadels, [loadCitadels]);
  const [selectedCitadelId, setSelectedCitadelId] = useState(activeCitadelId ?? "");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [citadelCreateForm, setCitadelCreateForm] = useState({
    name: "",
    description: "",
    slug: "",
    kind: "custom",
  });
  const [citadelEditForm, setCitadelEditForm] = useState({
    name: "",
    description: "",
    slug: "",
    kind: "custom",
  });
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
  const filteredCitadels = useMemo(() => {
    const items = citadelsData?.items ?? [];
    if (citadelView === "all") {
      return items;
    }
    return items.filter((item) => item.lifecycleStatus === citadelView);
  }, [citadelView, citadelsData?.items]);
  const selectedCitadel = (citadelsData?.items ?? []).find((item) => item.citadelId === selectedCitadelId) ?? null;
  const selectedWorkspace = (data?.items ?? []).find((item) => item.workspaceId === selectedWorkspaceId) ?? null;

  useEffect(() => {
    setSelectedCitadelId((current) => activeCitadelId || current);
  }, [activeCitadelId]);

  useEffect(() => {
    if (!filteredCitadels.length) {
      setSelectedCitadelId("");
      return;
    }
    setSelectedCitadelId((current) =>
      current && filteredCitadels.some((item) => item.citadelId === current)
        ? current
        : filteredCitadels[0]?.citadelId || "",
    );
  }, [filteredCitadels]);

  useEffect(() => {
    if (!selectedCitadel) {
      setCitadelEditForm({ name: "", description: "", slug: "", kind: "custom" });
      return;
    }
    setCitadelEditForm({
      name: selectedCitadel.name,
      description: selectedCitadel.description ?? "",
      slug: selectedCitadel.slug,
      kind: selectedCitadel.kind,
    });
  }, [selectedCitadel]);

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

  const handleCreateCitadel = async () => {
    if (!citadelCreateForm.name.trim()) {
      setNotice({ tone: "warning", message: "Citadel name is required." });
      return;
    }
    try {
      const created = await createCitadel({
        name: citadelCreateForm.name.trim(),
        description: citadelCreateForm.description.trim() || undefined,
        slug: citadelCreateForm.slug.trim() || undefined,
        kind: citadelCreateForm.kind as CitadelRecord["kind"],
      });
      setNotice({ tone: "success", message: `Citadel ${created.name} created.` });
      setCitadelCreateForm({ name: "", description: "", slug: "", kind: "custom" });
      await reloadCitadels();
      setSelectedCitadelId(created.citadelId);
      setActiveCitadelId?.(created.citadelId);
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleSaveCitadel = async () => {
    if (!selectedCitadel) {
      return;
    }
    try {
      const updated = await updateCitadel(selectedCitadel.citadelId, {
        name: citadelEditForm.name.trim() || undefined,
        description: citadelEditForm.description.trim() || undefined,
        slug: citadelEditForm.slug.trim() || undefined,
        kind: citadelEditForm.kind as CitadelRecord["kind"],
      });
      setNotice({ tone: "success", message: `Citadel ${updated.name} updated.` });
      await reloadCitadels();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleArchiveCitadel = async () => {
    if (!selectedCitadel) {
      return;
    }
    if (!window.confirm(`Archive Citadel ${selectedCitadel.name}?`)) {
      return;
    }
    try {
      await archiveCitadel(selectedCitadel.citadelId);
      setNotice({ tone: "success", message: `Citadel ${selectedCitadel.name} archived.` });
      await reloadCitadels();
    } catch (archiveError) {
      setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    }
  };

  const handleRestoreCitadel = async () => {
    if (!selectedCitadel) {
      return;
    }
    try {
      await restoreCitadel(selectedCitadel.citadelId);
      setNotice({ tone: "success", message: `Citadel ${selectedCitadel.name} restored.` });
      await reloadCitadels();
    } catch (restoreError) {
      setNotice({ tone: "error", message: getErrorMessage(restoreError) });
    }
  };

  const handleCreate = async () => {
    if (!createForm.name.trim()) {
      setNotice({ tone: "warning", message: "Workspace name is required." });
      return;
    }
    try {
      const created = await createWorkspace({
        ...(activeCitadelId ? { citadelId: activeCitadelId } : {}),
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
    <SettingsSectionShell
      loading={loading || citadelsLoading}
      error={error || citadelsError}
      onRetry={() => {
        void reload();
        void reloadCitadels();
      }}
    >
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
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Citadel manager"
            subtitle="Create, select, archive, and restore the top-level operating worlds that contain workspaces."
            stats={[
              { label: "Citadels", value: String(citadelsData?.items?.length ?? 0) },
              { label: "Active", value: activeCitadelId ?? "legacy" },
            ]}
          >
            <SettingsFilterBar
              options={[
                { id: "all", label: "All" },
                { id: "active", label: "Active" },
                { id: "archived", label: "Archived" },
              ]}
              value={citadelView}
              onChange={(next) => setCitadelView(next as "active" | "archived" | "all")}
            />
            <NativeSelectableList
              items={filteredCitadels.map((item) => ({
                id: item.citadelId,
                title: item.name,
                meta: item.lifecycleStatus,
                body: item.description || item.slug,
              }))}
              selectedId={selectedCitadelId}
              onSelect={setSelectedCitadelId}
              emptyLabel="No Citadels in this view."
              maxHeight="14rem"
            />
            <SettingsFieldGrid>
              <SettingsField label="New Citadel">
                <input
                  className="mc-next-settings-input"
                  value={citadelCreateForm.name}
                  onChange={(event) => setCitadelCreateForm((current) => ({ ...current, name: event.target.value }))}
                />
              </SettingsField>
              <SettingsField label="Kind">
                <select
                  className="mc-next-settings-input"
                  value={citadelCreateForm.kind}
                  onChange={(event) => setCitadelCreateForm((current) => ({ ...current, kind: event.target.value }))}
                >
                  {CITADEL_KIND_OPTIONS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </SettingsField>
              <SettingsField label="Slug">
                <input
                  className="mc-next-settings-input"
                  value={citadelCreateForm.slug}
                  onChange={(event) => setCitadelCreateForm((current) => ({ ...current, slug: event.target.value }))}
                />
              </SettingsField>
              <SettingsField label="Description">
                <input
                  className="mc-next-settings-input"
                  value={citadelCreateForm.description}
                  onChange={(event) =>
                    setCitadelCreateForm((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </SettingsField>
            </SettingsFieldGrid>
            {selectedCitadel ? (
              <>
                <SettingsFieldGrid>
                  <SettingsField label="Selected name">
                    <input
                      className="mc-next-settings-input"
                      value={citadelEditForm.name}
                      onChange={(event) => setCitadelEditForm((current) => ({ ...current, name: event.target.value }))}
                    />
                  </SettingsField>
                  <SettingsField label="Selected kind">
                    <select
                      className="mc-next-settings-input"
                      value={citadelEditForm.kind}
                      onChange={(event) => setCitadelEditForm((current) => ({ ...current, kind: event.target.value }))}
                    >
                      {CITADEL_KIND_OPTIONS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </SettingsField>
                  <SettingsField label="Selected slug">
                    <input
                      className="mc-next-settings-input"
                      value={citadelEditForm.slug}
                      onChange={(event) => setCitadelEditForm((current) => ({ ...current, slug: event.target.value }))}
                    />
                  </SettingsField>
                  <SettingsField label="Selected description">
                    <input
                      className="mc-next-settings-input"
                      value={citadelEditForm.description}
                      onChange={(event) =>
                        setCitadelEditForm((current) => ({ ...current, description: event.target.value }))
                      }
                    />
                  </SettingsField>
                </SettingsFieldGrid>
                <SettingsButtonRow>
                  <NativeButton variant="default" onClick={() => setActiveCitadelId?.(selectedCitadel.citadelId)}>
                    <CheckCircle2 size={16} />
                    Make active
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => void handleSaveCitadel()}>
                    <Save size={16} />
                    Save Citadel
                  </NativeButton>
                  {selectedCitadel.lifecycleStatus === "archived" ? (
                    <NativeButton variant="secondary" onClick={() => void handleRestoreCitadel()}>
                      <RotateCcw size={16} />
                      Restore
                    </NativeButton>
                  ) : (
                    <NativeButton variant="destructive" onClick={() => void handleArchiveCitadel()}>
                      <Trash2 size={16} />
                      Archive
                    </NativeButton>
                  )}
                </SettingsButtonRow>
              </>
            ) : null}
            <SettingsButtonRow>
              <NativeButton variant="default" onClick={() => void handleCreateCitadel()}>
                <Plus size={16} />
                Create Citadel
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Create workspace"
            subtitle={
              activeCitadelName
                ? `Add a functional workspace inside ${activeCitadelName}.`
                : "Add a new workspace before digging through the directory."
            }
          >
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
              <NativeButton variant="default" onClick={() => void handleCreate()}>
                <Plus size={16} />
                Create workspace
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Workspace directory"
            subtitle="Switch between active and archived workspaces, then edit the selected one."
            scrollBody
            bodyMaxHeight="min(54vh, 30rem)"
            stats={[
              { label: "Total", value: String(data?.items?.length ?? 0) },
              ...(activeCitadelId ? [{ label: "Citadel", value: activeCitadelId }] : []),
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
            <NativeSelectableList
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
          </NativeCard>
        </SettingsStack>
        <NativeCard
          density="compact"
          className="mc-next-settings-panel"
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
              <NativeMetricGrid
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
                <NativeButton variant="default" onClick={() => void handleSave()}>
                  <Save size={16} />
                  Save changes
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => setActiveWorkspaceId(selectedWorkspace.workspaceId)}>
                  <CheckCircle2 size={16} />
                  Make active
                </NativeButton>
                {selectedWorkspace.lifecycleStatus === "archived" ? (
                  <NativeButton variant="secondary" onClick={() => void handleRestore()}>
                    <RotateCcw size={16} />
                    Restore
                  </NativeButton>
                ) : (
                  <NativeButton variant="destructive" onClick={() => void handleArchive()}>
                    <Trash2 size={16} />
                    Archive
                  </NativeButton>
                )}
              </SettingsButtonRow>
            </>
          ) : (
            <SettingsEmptyState label="Choose a workspace to edit or create a new one." />
          )}
        </NativeCard>
      </SettingsGrid>
    </SettingsSectionShell>
  );
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
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [createCatalogId, setCreateCatalogId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [draftJson, setDraftJson] = useState("{}");
  const [validationResult, setValidationResult] = useState<{ kind: "validate" | "test"; items: string[] } | null>(null);
  const selectedDraft = data?.drafts?.find((item) => item.draftId === selectedDraftId) ?? data?.drafts?.[0] ?? null;
  const selectedDefinition =
    data?.definitions?.find((item) => item.catalog.catalogId === (selectedDraft?.catalogId || createCatalogId)) ?? null;

  useEffect(() => {
    if (!data?.definitions?.length) {
      setCreateCatalogId("");
      return;
    }
    setCreateCatalogId((current) => {
      if (current && data.definitions.some((item) => item.catalog.catalogId === current)) {
        return current;
      }
      return preferredChannelDefinition(data.definitions)?.catalog?.catalogId || "";
    });
  }, [data?.definitions]);

  useEffect(() => {
    if (!data?.drafts?.length) {
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
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="detail-wide">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsStack>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Channel definitions"
              subtitle="Available guided setup definitions for supported channel integrations."
              scrollBody
              bodyMaxHeight="min(54vh, 30rem)"
              stats={[
                { label: "Definitions", value: String(data.definitions?.length ?? 0) },
                { label: "Existing channels", value: String(data.connections?.length ?? 0) },
              ]}
            >
              <SettingsField label="Create draft from">
                <select
                  className="mc-next-settings-input"
                  value={createCatalogId}
                  onChange={(event) => setCreateCatalogId(event.target.value)}
                >
                  {(data.definitions ?? []).map((item) => (
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
                  <NativeButton variant="default" onClick={() => void handleStartSlackOAuth()}>
                    <ExternalLink size={16} />
                    Connect Slack
                  </NativeButton>
                ) : null}
                <NativeButton variant="default" onClick={() => void handleCreate()}>
                  <Plus size={16} />
                  Create setup draft
                </NativeButton>
              </SettingsButtonRow>
              <SettingsActionList
                items={(data.definitions ?? []).map((item) => ({
                  label: item.catalog.label,
                  description: item.catalog.description,
                  meta: `${item.wizard.difficulty} · ${item.wizard.estimatedMinutes} min`,
                  onClick: () => setCreateCatalogId(item.catalog.catalogId),
                  actionLabel: createCatalogId === item.catalog.catalogId ? "Selected" : "Use",
                }))}
                emptyLabel="No channel setup definitions returned."
                maxHeight="min(34vh, 18rem)"
              />
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Drafts"
              subtitle="Saved setup drafts, readiness checks, trial sends, and finalization."
            >
              <NativeSelectableList
                items={(data.drafts ?? []).map((item) => ({
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
            </NativeCard>
          </SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title={selectedDraft?.label || selectedDefinition?.catalog?.label || "Channel draft"}
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
                  <NativeMetricGrid
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
                    <NativeButton variant="default" onClick={() => void handleStartSlackOAuth()}>
                      <ExternalLink size={16} />
                      Connect Slack
                    </NativeButton>
                  ) : null}
                  {selectedDraft.catalogId === "channel.telegram" ? (
                    <NativeButton variant="secondary" onClick={() => void handleDiscoverTelegramTargets()}>
                      <RefreshCw size={16} />
                      Detect Telegram Chats
                    </NativeButton>
                  ) : null}
                  <NativeButton variant="default" onClick={() => void handleSave()}>
                    <Save size={16} />
                    Save draft
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => void handleValidate()}>
                    <ShieldCheck size={16} />
                    Validate
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => void handleTest()}>
                    <Play size={16} />
                    Test
                  </NativeButton>
                  <NativeButton variant="default" onClick={() => void handleFinalize()}>
                    <CheckCircle2 size={16} />
                    Finalize
                  </NativeButton>
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
          </NativeCard>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}

export type PermissionProfileEditorDraft = {
  label: string;
  description: string;
  approvalMode: ToolApprovalMode;
  toolPatterns: string;
  allow: string;
  deny: string;
  readAccessMode: FilesystemReadAccessMode | "";
  defaultForSurfaces: PermissionSurface[];
};

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
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingRevokeGrantId, setPendingRevokeGrantId] = useState<string | null>(null);
  const [revokePending, setRevokePending] = useState(false);
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
    setRevokePending(true);
    try {
      await revokeToolGrant(grantId);
      setNotice({ tone: "success", message: "Tool grant revoked." });
      await reload();
    } catch (revokeError) {
      setNotice({ tone: "error", message: getErrorMessage(revokeError) });
    } finally {
      setRevokePending(false);
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
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="three-column">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
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
              <NativeButton variant="default" onClick={() => void handleSaveApprovalMode()}>
                <Save size={16} />
                Save mode
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
          <SettingsStack>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Tool catalog"
              subtitle="Review the full catalog instead of a tiny first-page slice."
              scrollBody
              bodyMaxHeight="min(64vh, 38rem)"
              stats={[
                { label: "Tools", value: String(data.tools?.length ?? 0) },
                { label: "Grants", value: String(data.grants?.length ?? 0) },
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
              <NativeSelectableList
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
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Create tool grant"
              subtitle="Create a scoped policy grant for the selected tool."
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
                <NativeButton variant="default" onClick={() => void handleCreateGrant()}>
                  <Plus size={16} />
                  Create grant
                </NativeButton>
              </SettingsButtonRow>
            </NativeCard>
          </SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title={selectedTool?.toolName ?? "Tool detail"}
            subtitle="Selected catalog entry and tool grants."
            scrollBody
            bodyMaxHeight="min(72vh, 42rem)"
          >
            {selectedTool ? (
              <>
                <NativeMetricGrid
                  items={[
                    {
                      label: "Category",
                      value: selectedTool.category || "tool",
                      meta: `${selectedTool.pack} pack · ${selectedTool.riskLevel} risk`,
                    },
                    {
                      label: "Available grants",
                      value: String(
                        (data.grants ?? []).filter(
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
              items={(data.grants ?? [])
                .filter((item) => (selectedTool ? matchesToolGrant(item, selectedTool.toolName) : true))
                .map((item) => ({
                  id: item.grantId,
                  label: item.toolPattern,
                  description: `${item.scope}${item.scopeRef ? `:${item.scopeRef}` : ""} · ${item.decision} · ${item.grantType}${
                    item.revokedBy ? ` · revoked by ${item.revokedBy}` : ""
                  }`,
                  meta: describeToolGrantAvailability(item),
                  onClick: item.revokedAt ? undefined : () => setPendingRevokeGrantId(item.grantId),
                  actionLabel: item.revokedAt ? "Revoked" : "Revoke",
                }))}
              emptyLabel={selectedTool ? "No tool grants match this catalog entry." : "No tool grants created yet."}
              maxHeight="min(42vh, 24rem)"
            />
          </NativeCard>
        </SettingsGrid>
      ) : null}
      <ConfirmModal
        open={pendingRevokeGrantId !== null}
        danger
        title="Revoke tool grant?"
        message="This tool grant will be revoked. This cannot be undone."
        confirmLabel="Revoke"
        pending={revokePending}
        onCancel={() => setPendingRevokeGrantId(null)}
        onConfirm={() => {
          if (pendingRevokeGrantId !== null) {
            void handleRevokeGrant(pendingRevokeGrantId);
          }
          setPendingRevokeGrantId(null);
        }}
      />
    </SettingsSectionShell>
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

export function deriveSetupCenterItems(onboarding: OnboardingState): Array<{
  label: string;
  description: string;
  state: SettingsWizardStepState;
}> {
  const checklistById = new Map((onboarding.checklist ?? []).map((item) => [item.id, item]));
  const providersWithKeys = (onboarding.settings?.llm?.providers ?? []).filter((provider) => provider.hasApiKey).length;
  const authMode = onboarding.settings?.auth?.mode ?? "none";
  return [
    {
      label: "Provider smoke",
      description:
        providersWithKeys > 0
          ? `${providersWithKeys} provider credential source available. Active model: ${
              onboarding.settings?.llm?.activeModel || "unset"
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
        authMode === "none"
          ? "Local access is open; add gateway auth before exposing the app."
          : `${authMode} gateway auth configured.`,
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

export type FirstRunGovernedJobState =
  | "provider-ready"
  | "provider-missing"
  | "demo/local"
  | "first-task-pending"
  | "proof-complete";

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
  firstRunEvidence: FirstRunEvidenceSnapshot = EMPTY_FIRST_RUN_EVIDENCE,
): FirstOutcomePathItem[] {
  const llmSettings = onboarding.settings?.llm;
  const activeProvider = (llmSettings?.providers ?? []).find(
    (provider) => provider.providerId === llmSettings?.activeProviderId,
  );
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  const localEndpointReady = Boolean(activeProvider && isLikelyLocalProviderBaseUrl(activeProvider.baseUrl));
  const cloudProviderReady = Boolean(activeProvider?.hasApiKey);
  const providerCredentialReady = Boolean(activeProvider && (cloudProviderReady || localEndpointReady));
  const providerConnected = Boolean(activeProvider && activeModel && providerCredentialReady);
  const demoSessions = demoState?.sessions ?? [];
  const demoTasks = demoState?.tasks ?? [];
  const demoReady = demoState?.status === "ready";
  const hasChatStart = demoSessions.some((session) => session.mode === "chat");
  const hasCoworkStart = demoSessions.some((session) => session.mode === "cowork");
  const hasCodeStart = demoSessions.some((session) => session.mode === "code");
  const hasSeededStartContext = Boolean(demoTasks.length > 0 || hasChatStart || hasCoworkStart || hasCodeStart);
  const hasProjectCreation = Boolean(demoState?.project?.projectId || demoState?.project?.workspacePath);
  const providerFailure = describeProviderReadinessFailure(onboarding);
  const latestProof = firstRunEvidence.evidenceEnvelopes[0];
  const proofRun = findRunForEvidence(firstRunEvidence.recentRuns, latestProof);
  const proofRoute = routeForFirstRunEvidence(proofRun, latestProof);
  const firstTaskRun = findFirstRunTaskCandidate(firstRunEvidence.recentRuns, demoSessions, demoTasks);
  const firstTaskSession = pickFirstRunDemoSession(demoSessions);
  const firstTaskRoute = routeForFirstTask(firstTaskRun, firstTaskSession);
  const firstTaskActionLabel = firstTaskRun?.runId
    ? "Open Run Detail"
    : firstTaskSession
      ? `Open ${surfaceLabel(firstTaskSession.mode)}`
      : "Open Plan";

  return [
    {
      id: "provider-ready",
      label: "Provider-ready path",
      description: providerConnected
        ? `${activeProvider?.label ?? llmSettings?.activeProviderId} is selected with ${activeModel}; risky actions still stay approval-governed.`
        : providerFailure,
      actionDescription: "Open Providers & Models to choose a provider, model, secret source, or local endpoint.",
      state: providerCredentialReady ? "complete" : "active",
      meta: providerConnected ? "provider-ready" : "provider-missing",
      actionLabel: "Configure",
      route: { area: "settings", section: "providers" },
    },
    {
      id: "provider-missing",
      label: "Provider missing fallback",
      description:
        providerCredentialReady || demoReady
          ? "The fallback remains available for local inspection without provider credentials."
          : "No provider or local endpoint is configured. Use the safe demo/local path before cloud-backed sends.",
      actionDescription:
        "Start or reopen the safe local demo path; it seeds inspectable data and does not send work to a cloud provider.",
      state: providerCredentialReady ? "pending" : demoReady ? "complete" : "active",
      meta: providerCredentialReady ? "provider-ready" : "provider-missing",
      actionLabel: "Start demo/local",
      route: { area: "settings", section: "onboarding" },
    },
    {
      id: "demo-local",
      label: "Demo/local path",
      description:
        demoReady || localEndpointReady
          ? "A demo workspace or local endpoint is available for truthful first-run inspection."
          : "Start the safe demo or configure a local OpenAI-compatible endpoint when no provider key is available.",
      actionDescription: "Open the local-first path for sample Work, memory, and project context.",
      state: demoReady || localEndpointReady ? "complete" : providerCredentialReady ? "pending" : "active",
      meta: "demo/local",
      actionLabel: demoReady ? "Open demo" : "Start demo",
      route: { area: "settings", section: "onboarding" },
    },
    {
      id: "first-task-pending",
      label: "First Work task",
      description: firstTaskRun
        ? `A recent durable ${surfaceLabel(firstTaskRun.surface).toLowerCase()} exists; inspect Run Detail before treating proof as complete.`
        : firstTaskSession
          ? `A safe demo ${surfaceLabel(firstTaskSession.mode)} thread exists; open it and run the first supervised task from seeded context.`
          : hasSeededStartContext
            ? "Starter context exists; run a governed Work task before treating this step as complete."
            : "Create the first low-risk Work task after provider/local readiness is explicit.",
      actionDescription: firstTaskRun
        ? "Open the durable run detail projection for timeline, approvals, tools, artifacts, and remaining proof gaps."
        : firstTaskSession
          ? "Open the seeded demo thread; it is local/sample context and does not count as proof until a run records evidence."
          : "Open Work for the first supervised task, then choose Conversation, Plan, or Build posture.",
      state: firstTaskRun ? "complete" : providerConnected || demoReady || localEndpointReady ? "active" : "pending",
      meta: firstTaskRun ? "recent-run-found" : hasSeededStartContext ? "starter-ready" : "first-task-pending",
      actionLabel: firstTaskActionLabel,
      route: firstTaskRoute,
    },
    {
      id: "proof-complete",
      label: "Proof artifact or trace",
      description: latestProof
        ? `Evidence envelope ${shortEvidenceId(latestProof.envelopeId)} records ${latestProof.eventKind}${
            latestProof.runId ? ` for run ${shortEvidenceId(latestProof.runId)}` : ""
          }.`
        : "No proof artifact or trace is recorded yet. A first-run task is not complete until evidence exists.",
      actionDescription: latestProof
        ? "Open the linked run surface and use Run details or artifacts to inspect retained evidence."
        : "Open generated artifacts or the Work proof panel after a governed task records evidence.",
      state: latestProof ? "complete" : firstTaskRun || hasProjectCreation ? "active" : "pending",
      meta: latestProof ? "proof-complete" : "proof-needed",
      actionLabel: latestProof ? "Open Run Detail" : "Inspect proof",
      route: latestProof ? proofRoute : { area: "library", section: "artifacts" },
    },
  ];
}

const EMPTY_FIRST_RUN_EVIDENCE: FirstRunEvidenceSnapshot = {
  recentRuns: [],
  evidenceEnvelopes: [],
};

export function deriveFirstRunGovernedJobState(
  onboarding: OnboardingState,
  demoState: DemoBootstrapStateResponse | null,
  firstRunEvidence: FirstRunEvidenceSnapshot = EMPTY_FIRST_RUN_EVIDENCE,
): FirstRunGovernedJobState {
  if (firstRunEvidence.evidenceEnvelopes.length > 0) {
    return "proof-complete";
  }
  const llmSettings = onboarding.settings?.llm;
  const activeProvider = (llmSettings?.providers ?? []).find(
    (provider) => provider.providerId === llmSettings?.activeProviderId,
  );
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  const providerReady = Boolean(
    activeProvider && activeModel && (activeProvider.hasApiKey || isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)),
  );
  const demoReady = demoState?.status === "ready";
  const taskStarted = firstRunEvidence.recentRuns.length > 0;
  if (taskStarted && (providerReady || demoReady)) {
    return "first-task-pending";
  }
  if (activeProvider && activeModel && isLikelyLocalProviderBaseUrl(activeProvider.baseUrl)) {
    return "demo/local";
  }
  if (providerReady) {
    return "provider-ready";
  }
  return demoReady ? "demo/local" : "provider-missing";
}

function findRunForEvidence(runs: AgenticRunListItem[], evidence: EvidenceEnvelope | undefined) {
  if (!evidence?.runId) {
    return undefined;
  }
  return runs.find((run) => run.runId === evidence.runId);
}

function findFirstRunTaskCandidate(
  runs: AgenticRunListItem[],
  sessions: DemoBootstrapStateResponse["sessions"][number][],
  tasks: DemoBootstrapStateResponse["tasks"],
) {
  const sessionIds = new Set(sessions.map((session) => session.sessionId).filter(Boolean));
  const taskIds = new Set(tasks.map((task) => task.taskId).filter(Boolean));
  return (
    runs.find((run) => run.parentSessionId && sessionIds.has(run.parentSessionId)) ??
    runs.find((run) => run.taskId && taskIds.has(run.taskId)) ??
    runs[0]
  );
}

function pickFirstRunDemoSession(sessions: DemoBootstrapStateResponse["sessions"][number][]) {
  return (
    sessions.find((session) => session.mode === "cowork") ??
    sessions.find((session) => session.mode === "code") ??
    sessions.find((session) => session.mode === "chat")
  );
}

function routeForFirstTask(
  run: AgenticRunListItem | undefined,
  session: DemoBootstrapStateResponse["sessions"][number] | undefined,
): AppRoute {
  if (run?.runId) {
    const route: AppRoute = { area: "ops", section: "sessions", view: "run-detail", runId: run.runId };
    if (run.parentSessionId) {
      route.sessionId = run.parentSessionId;
    }
    return route;
  }
  if (session) {
    const area =
      session.mode === "chat" || session.mode === "code" || session.mode === "cowork" ? session.mode : "cowork";
    return {
      area,
      sessionId: session.sessionId,
      ...(session.projectId ? { projectId: session.projectId } : {}),
    };
  }
  return { area: "cowork" };
}

function routeForFirstRunEvidence(
  run: AgenticRunListItem | undefined,
  evidence: EvidenceEnvelope | undefined,
): AppRoute {
  const runId = evidence?.runId ?? run?.runId;
  if (runId) {
    const route: AppRoute = { area: "ops", section: "sessions", view: "run-detail", runId };
    if (run?.parentSessionId) {
      route.sessionId = run.parentSessionId;
    }
    return route;
  }
  return { area: "ops", section: "sessions" };
}

function shortEvidenceId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function surfaceLabel(
  surface: AgenticRunListItem["surface"] | DemoBootstrapStateResponse["sessions"][number]["mode"] | undefined,
) {
  switch (surface) {
    case "chat":
      return "Conversation";
    case "code":
      return "Build";
    case "cowork":
      return "Plan";
    default:
      return "run";
  }
}

export function deriveOnboardingProviderSmokeEvidenceItems(
  onboarding: OnboardingState,
): OnboardingProviderSmokeEvidenceItem[] {
  const llmSettings = onboarding.settings?.llm;
  const activeProvider = (llmSettings?.providers ?? []).find(
    (provider) => provider.providerId === llmSettings?.activeProviderId,
  );
  const activeProviderLabel = activeProvider?.label ?? ((llmSettings?.activeProviderId ?? "").trim() || "No provider");
  const activeModel = (llmSettings?.activeModel ?? "").trim();
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
  const llmSettings = onboarding.settings?.llm;
  const activeProviderId = (llmSettings?.activeProviderId ?? "").trim();
  const activeModel = (llmSettings?.activeModel ?? "").trim();
  if (!activeProviderId) {
    return "Choose an active provider before sending cloud-backed work.";
  }
  const activeProvider = (llmSettings?.providers ?? []).find((provider) => provider.providerId === activeProviderId);
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

export function getProviderApiStyleWarning(provider: {
  providerId?: string;
  apiStyle?: ProviderEditorDraft["apiStyle"];
}): string | null {
  if (provider.apiStyle === "openai-codex-responses" && provider.providerId !== "openai-codex") {
    return "Codex Responses is only executed for the built-in OpenAI Codex OAuth provider; other providers resolve to their supported execution API.";
  }
  return null;
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

export function isRuntimeInvokableMcpServer(server: {
  transport: string;
  url?: string;
  trustTier?: string;
  authType?: string;
  oauth?: McpServerRecord["oauth"];
  authState?: McpServerRecord["authState"];
  policy?: { allowedEnvKeys?: string[] };
}) {
  const authSupported =
    !server.authType ||
    server.authType === "none" ||
    (server.authType === "token" && (server.policy?.allowedEnvKeys ?? []).some((item) => item.trim())) ||
    (server.authType === "oauth2" &&
      Boolean(server.oauth?.authorizationUrl?.trim() && server.oauth.tokenUrl?.trim()) &&
      server.authState?.readiness === "ready");
  return (
    server.trustTier !== "quarantined" &&
    (server.transport === "stdio" ||
      server.url?.trim().toLowerCase() === INTERNAL_APPROVAL_INBOX_URL ||
      ((server.transport === "http" || server.transport === "sse") && Boolean(server.url?.trim()) && authSupported))
  );
}

export function createEmptyMcpRemotePreview(): McpRemotePreviewResponse {
  return {
    generatedAt: new Date(0).toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    experimentalRemoteRecordsAllowed: false,
    runtimeSupport: "internal_approval_inbox_only",
    summary: {
      remoteServers: 0,
      remoteTemplates: 0,
      runtimeSupported: 0,
      blocked: 0,
      configuredOnly: 0,
      notCallable: 0,
      experimentalRecords: 0,
      quarantined: 0,
      needsAuth: 0,
    },
    items: [],
  };
}

export function createEmptyMcpServerModeManifest(): McpServerModeManifestResponse {
  return {
    generatedAt: new Date(0).toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    status: "preview",
    protocol: "mcp",
    runtimeSupport: "not_available",
    server: {
      name: "goatcitadel",
      label: "GoatCitadel governed capability export",
      version: "1.0.0",
      transport: "stdio",
    },
    launch: {
      supported: true,
      command: "goatcitadel",
      args: ["mcp-server"],
      reason: "MCP server-mode manifest is unavailable.",
    },
    runtime: {
      callPreview: {
        supported: false,
        endpoint: "/api/v1/mcp/server-mode/call",
        requiresGatewayAuth: true,
        readOnlyOnly: true,
        requiredCallContext: ["agentId", "sessionId"],
        reason: "MCP server-mode manifest is unavailable.",
      },
      stdio: {
        supported: true,
        command: "goatcitadel",
        args: ["mcp-server"],
        requiresGatewayAuth: true,
        gatewayEndpoint: "/api/v1/mcp/server-mode/manifest",
        reason: "The stdio proxy command is available, but the manifest could not be loaded.",
      },
    },
    summary: {
      inspectableCapabilities: 0,
      gatewayCallableCapabilities: 0,
      exportedToolDescriptors: 0,
      blockedDescriptors: 0,
    },
    tools: [],
    governance: [],
    limitations: ["MCP server-mode manifest is unavailable."],
    evidence: {
      catalogScope: "callable",
      catalogSnapshot: [],
    },
  };
}

export function formatMcpRemotePreviewItem(item: McpRemotePreviewResponse["items"][number]): string {
  const blocker = item.blockers[0] ?? "No runtime blocker recorded.";
  const governance = item.governance[0] ?? "No governance note recorded.";
  const authReadiness = item.authReadiness?.replaceAll("_", " ") ?? "unknown";
  return `${item.posture.replaceAll("_", " ")} · auth ${authReadiness} · ${item.operatorNextAction} · ${blocker} · ${governance}`;
}

export function formatMcpElicitationMeta(item: McpElicitationRequest): string {
  const source = [
    item.source.serverId ? `server ${item.source.serverId}` : item.source.sourceType.replaceAll("_", " "),
    item.source.toolName ? `tool ${item.source.toolName}` : undefined,
    item.source.transport ? `transport ${item.source.transport}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const owner = [
    item.owner.workspaceId ? `workspace ${item.owner.workspaceId}` : undefined,
    item.owner.sessionId ? `session ${item.owner.sessionId}` : undefined,
    item.owner.runId ? `run ${item.owner.runId}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const redaction =
    item.prompt.redactedSecretCount + item.requestedSchema.redactedSecretCount > 0
      ? ` · ${item.prompt.redactedSecretCount + item.requestedSchema.redactedSecretCount} redacted`
      : "";
  return `${source || "gateway"} · ${owner || "operator"} · updated ${formatDateTime(item.updatedAt)}${redaction}`;
}

export function parseMcpElicitationDraft(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP elicitation accept response must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
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
    tags.push("Work default");
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
  SettingsNotice,
  SettingsPageFrame,
  SettingsPosturePanel,
  SettingsSectionShell,
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
