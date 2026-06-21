// Shared settings primitives, types, and navigation helpers extracted from
// `../SettingsNativePage.tsx` as the first slice of the per-section settings
// decomposition. Keep this file focused on layout/utility surface; section-
// specific helpers (providers, personalities, channels, MCP, tools, addons)
// stay in `../SettingsNativePage.tsx` until their dedicated section files land.
import { type ComponentType, type ReactNode } from "react";
import {
  Cable,
  CheckCircle2,
  Gauge,
  HardDrive,
  Package2,
  Play,
  Plug2,
  RefreshCw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { McpServerRecord } from "@goatcitadel/contracts";
import type { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import type { AppRoute, ReleaseSurfaceStatus } from "@next/app/route-model";
import { BlocksShuffleLoader } from "../../../components/BlocksShuffleLoader";
import { NativeCard, NativePageFrame } from "../NativeRoutePageLayout";
import { ThreePartChip, EmptyState, ErrorState, NativeButton, NoticeBanner, type ChipTone } from "../primitives";
import {
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
  type LoadState,
  type NativeLoadIssue,
  type NativeLoadResult,
  type Notice,
} from "../shared/native-helpers";

export { getErrorMessage, nativeLoad, nativeLoadIssues, useAsyncLoad };
export type { LoadState, NativeLoadIssue, NativeLoadResult, Notice };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingsNativePageProps {
  route: AppRoute;
  activeCitadelId?: string;
  activeCitadelName?: string;
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  setActiveCitadelId?: (citadelId: string) => void;
  setActiveWorkspaceId: (workspaceId: string) => void;
}

export type SettingsSectionProps = SettingsNativePageProps & {
  section: string;
};

export type SettingsWizardStepState = "complete" | "active" | "pending";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function formatEffectiveConfigSourceLabel(source: string | undefined): string {
  if (source === "env") {
    return "env";
  }
  if (source === "keychain") {
    return "secure store";
  }
  if (source === "inline") {
    return "UI";
  }
  if (source === "default" || source === "template") {
    return "default";
  }
  if (source === "managed") {
    return "managed";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function SettingsLoadWarnings({ issues, onRetry }: { issues: NativeLoadIssue[]; onRetry: () => void }) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Some data could not load"
      subtitle="The rest of this settings page is still usable."
    >
      <SettingsActionList
        items={issues.map((issue) => ({
          label: issue.label,
          description: issue.message,
          tone: "warning",
        }))}
      />
      <div className="mc-next-settings-actions">
        <NativeButton variant="secondary" onClick={() => void onRetry()}>
          <RefreshCw className="h-4 w-4" />
          Retry
        </NativeButton>
      </div>
    </NativeCard>
  );
}

export function SettingsPageFrame({
  icon: Icon,
  kicker,
  title,
  description,
  children,
  releaseStatus,
}: {
  icon: ComponentType<{ className?: string }>;
  kicker: string;
  title: string;
  description: string;
  children: ReactNode;
  /** F-M11: renders an on-surface "Experimental" badge for experimental sections. */
  releaseStatus?: ReleaseSurfaceStatus;
}) {
  // Delegates to the canonical NativePageFrame so Settings shares one frame with
  // the rest of the app (loading/error are handled separately by SettingsSectionShell,
  // hence loading={false} error={null} here).
  return (
    <NativePageFrame
      icon={Icon}
      area="settings"
      kicker={kicker}
      title={title}
      description={description}
      loading={false}
      error={null}
      releaseStatus={releaseStatus}
    >
      {children}
    </NativePageFrame>
  );
}

export function SettingsSectionShell({
  loading,
  error,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  /** F-M12: wired to the section's reload() so the error path offers retry. */
  onRetry?: () => void;
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
      <ErrorState
        size="inline"
        description={error}
        primaryAction={
          onRetry ? (
            <NativeButton variant="outline" onClick={() => onRetry()}>
              <RefreshCw className="h-4 w-4" />
              Retry
            </NativeButton>
          ) : undefined
        }
      />
    );
  }
  return <>{children}</>;
}

export function SettingsGrid({
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

export function SettingsStack({ children }: { children: ReactNode }) {
  return <div className="mc-next-settings-stack">{children}</div>;
}

type SettingsPostureCardRow = { name: string; state: string; tone: ChipTone; age?: string };

export function SettingsPosturePanel({
  settings,
  mcpServers,
  integrations,
  workspaces,
  onNavigate,
}: {
  settings: Awaited<ReturnType<typeof fetchSettings>> | null;
  mcpServers: McpServerRecord[];
  integrations: Array<{ connectionId?: string; enabled?: boolean; status?: string; pluginId?: string }>;
  workspaces: Array<{ workspaceId?: string; name?: string }>;
  onNavigate: (section: "providers" | "mcp" | "integrations" | "access") => void;
}) {
  const providers = settings?.llm.providers ?? [];
  const activeProviderId = settings?.llm.activeProviderId ?? null;
  const authMode = settings?.auth.mode ?? "unknown";

  const providerRows: SettingsPostureCardRow[] = providers.slice(0, 4).map((provider) => {
    const isActive = provider.providerId === activeProviderId;
    return {
      name: provider.providerId,
      state: isActive ? "active" : "configured",
      tone: isActive ? "safe" : "muted",
    };
  });

  const mcpRows: SettingsPostureCardRow[] = mcpServers.slice(0, 4).map((server) => ({
    name: server.label,
    state: server.enabled ? "enabled" : "disabled",
    tone: server.enabled ? "safe" : "muted",
  }));

  const integrationRows: SettingsPostureCardRow[] = integrations.slice(0, 4).map((connection) => ({
    name:
      connection.pluginId ??
      (connection.connectionId ? `Integration ${connection.connectionId.slice(0, 8)}` : "Integration"),
    state: connection.enabled === false ? "disabled" : "configured",
    tone: connection.enabled === false ? "muted" : "safe",
  }));

  const identityRows: SettingsPostureCardRow[] = [
    {
      name: "Gateway auth",
      state: authMode,
      tone: authMode === "none" ? "caution" : authMode === "token" || authMode === "basic" ? "safe" : "muted",
    },
    {
      name: "Workspaces",
      state: `${workspaces.length} configured`,
      tone: workspaces.length > 0 ? "safe" : "muted",
    },
  ];

  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Active posture"
      subtitle="Configured and enabled posture for providers, MCP servers, integrations, and identity at a glance."
    >
      <div className="mc-next-settings-posture-grid">
        <SettingsPostureCard
          title="Providers"
          count={providers.length}
          rows={providerRows}
          emptyLabel="No providers configured."
          onOpen={() => onNavigate("providers")}
        />
        <SettingsPostureCard
          title="MCP servers"
          count={mcpServers.length}
          rows={mcpRows}
          emptyLabel="No MCP servers configured."
          onOpen={() => onNavigate("mcp")}
        />
        <SettingsPostureCard
          title="Integrations"
          count={integrations.length}
          rows={integrationRows}
          emptyLabel="No integrations configured."
          onOpen={() => onNavigate("integrations")}
        />
        <SettingsPostureCard
          title="Identity & access"
          count={identityRows.length}
          rows={identityRows}
          emptyLabel="No identity posture available."
          onOpen={() => onNavigate("access")}
        />
      </div>
    </NativeCard>
  );
}

function SettingsPostureCard({
  title,
  count,
  rows,
  emptyLabel,
  onOpen,
}: {
  title: string;
  count: number;
  rows: SettingsPostureCardRow[];
  emptyLabel: string;
  onOpen: () => void;
}) {
  return (
    <article className="mc-next-settings-posture-card">
      <header className="mc-next-settings-posture-card-head">
        <div>
          <h3>{title}</h3>
          <span>{count} total</span>
        </div>
        <NativeButton variant="secondary" onClick={onOpen}>
          Open
        </NativeButton>
      </header>
      {rows.length > 0 ? (
        <ul className="mc-next-settings-posture-card-rows">
          {rows.map((row) => (
            <li key={`${title}-${row.name}`} aria-label={`${title}: ${row.name} is ${row.state}`}>
              <span className="mc-next-settings-posture-card-row-name" title={row.name}>
                {row.name}
              </span>
              <ThreePartChip tone={row.tone} state={row.state} age={row.age} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mc-next-settings-posture-card-empty">{emptyLabel}</p>
      )}
    </article>
  );
}

export function SettingsFieldGrid({ children }: { children: ReactNode }) {
  return <div className="mc-next-settings-field-grid">{children}</div>;
}

export function SettingsField({ label, children, span = 1 }: { label: string; children: ReactNode; span?: 1 | 2 }) {
  return (
    <label className={`mc-next-settings-field${span === 2 ? " span-2" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function SettingsButtonRow({ children }: { children: ReactNode }) {
  return <div className="mc-next-settings-button-row">{children}</div>;
}

export function SettingsConfigSourceLegend() {
  return (
    <div className="mc-next-settings-source-legend" aria-label="Effective config source labels">
      <span>{formatEffectiveConfigSourceLabel("env")}</span>
      <span>{formatEffectiveConfigSourceLabel("inline")}</span>
      <span>{formatEffectiveConfigSourceLabel("default")}</span>
      <span>{formatEffectiveConfigSourceLabel("keychain")}</span>
    </div>
  );
}

export function SettingsWizardSteps({
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

export function SettingsActionList({
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
            <NativeButton variant="secondary" onClick={item.onClick}>
              {item.actionLabel ?? "Open"}
            </NativeButton>
          ) : item.actionLabel ? (
            <span className="mc-next-settings-chip">{item.actionLabel}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function SettingsFilterBar({
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

export function SettingsCodeBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mc-next-settings-code-block">
      <span>{label}</span>
      <pre>{children}</pre>
    </div>
  );
}

export function SettingsEmptyState({ label }: { label: string }) {
  return <EmptyState title={label} size="compact" />;
}

export function SettingsNotice({ notice }: { notice: Notice }) {
  // Routed through the shared NoticeBanner: error/warning -> ErrorState
  // (role=alert), success/info -> the polite runtime-notice channel (role=status).
  return <NoticeBanner tone={notice.tone} message={notice.message} />;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export function iconForSettingsSection(section: string) {
  switch (section) {
    case "general":
      return SlidersHorizontal;
    case "onboarding":
      return Play;
    case "budget":
      return Gauge;
    case "providers":
      return SlidersHorizontal;
    case "local-ai":
      return Gauge;
    case "personalities":
      return Sparkles;
    case "access":
      return ShieldCheck;
    case "permissions":
      return ShieldCheck;
    case "trust-policy":
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

export function labelForSettingsSection(section: string) {
  switch (section) {
    case "general":
      return "General";
    case "onboarding":
      return "Start Here";
    case "budget":
      return "Budget";
    case "providers":
      return "Providers & Models";
    case "local-ai":
      return "Local AI";
    case "personalities":
      return "Personalities";
    case "access":
      return "Access";
    case "permissions":
      return "Permissions";
    case "trust-policy":
      return "Trust & Policy";
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

export function descriptionForSettingsSection(section: string) {
  switch (section) {
    case "general":
      return "Core runtime defaults, provider posture, and high-signal setup routes.";
    case "onboarding":
      return "Safe demo launch, setup center, provider, runtime, channel, and sharing checkpoints.";
    case "budget":
      return "Set the runtime budget mode and inspect cost evidence.";
    case "providers":
      return "Choose active routing, inspect provider and model posture, and manage secrets.";
    case "local-ai":
      return "Inspect local hardware readiness, model fit, downloads, serve jobs, and endpoint registration.";
    case "personalities":
      return "Manage Chat tone presets and choose the global Chat default.";
    case "access":
      return "Manage gateway auth posture, install tokens, and device access.";
    case "permissions":
      return "Manage permission profiles, active defaults, and time-boxed local override controls with operator evidence.";
    case "trust-policy":
      return "Inspect capability, tool, and source trust posture before opening the dedicated editor surfaces.";
    case "runtime":
      return "Configure local runtimes and control the processes behind them.";
    case "workspaces":
      return "Create, edit, archive, restore, and switch workspace context.";
    case "integrations":
      return "Create and maintain external product and automation connections.";
    case "channels":
      return "Run setup drafts for channel connections, check readiness, send trial messages, and finalize.";
    case "mcp":
      return "Manage MCP servers, templates, transport config, and tool visibility.";
    case "tools":
      return "Review the tool catalog and manage grants from one place.";
    case "addons":
      return "Inspect experimental local add-ons, lifecycle truth, trust posture, and the 1.0 graduation bar.";
    default:
      return "This settings deep link is not registered.";
  }
}
