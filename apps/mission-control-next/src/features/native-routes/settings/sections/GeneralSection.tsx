// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback } from "react";
import { Bell, Volume2 } from "lucide-react";
import {
  fetchInstalledAddons,
  fetchIntegrationConnections,
  fetchMcpServers,
  fetchMeshReadiness,
  fetchSettings,
  fetchToolCatalog,
  fetchWorkspaces,
} from "@goatcitadel/mission-control-shared/api/client";
import { type UiDensity, useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import {
  nativeLoad,
  nativeLoadIssues,
  SettingsActionList,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsPosturePanel,
  type SettingsSectionProps,
  SettingsSectionShell,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";

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

export function GeneralSection({ activeCitadelId, activeWorkspaceName, route, navigate }: SettingsSectionProps) {
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
              <SettingsField label="In-app notifications" group>
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
              <SettingsField label="Desktop notifications" group>
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
              <SettingsField label="Attention scope" group>
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
