// Shared settings primitives, types, and navigation helpers extracted from
// `../SettingsNativePage.tsx` as the first slice of the per-section settings
// decomposition. Keep this file focused on layout/utility surface; section-
// specific helpers (providers, personalities, channels, MCP, tools, addons)
// stay in `../SettingsNativePage.tsx` until their dedicated section files land.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
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
import type { AppRoute } from "@next/app/route-model";
import { BlocksShuffleLoader } from "../../../components/BlocksShuffleLoader";
import { ThreePartChip, EmptyState, type ChipTone } from "../primitives";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingsNativePageProps {
  route: AppRoute;
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  setActiveWorkspaceId: (workspaceId: string) => void;
}

export type SettingsSectionProps = SettingsNativePageProps & {
  section: string;
};

export type LoadState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

export type Notice = {
  tone: "success" | "warning" | "error" | "info";
  message: string;
};

export type NativeLoadIssue = {
  label: string;
  message: string;
};

export type NativeLoadResult<T> = {
  data: T;
  issue: NativeLoadIssue | null;
};

export type SettingsWizardStepState = "complete" | "active" | "pending";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readErrorString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isErrorRecord(error: unknown): error is Record<string, unknown> {
  return typeof error === "object" && error !== null;
}

export function getErrorMessage(error: unknown): string {
  const errorMessage = error instanceof Error ? readErrorString(error.message) : null;
  if (errorMessage) {
    return errorMessage;
  }
  const stringMessage = readErrorString(error);
  if (stringMessage) {
    return stringMessage;
  }
  if (isErrorRecord(error)) {
    const message = readErrorString(error.message) ?? readErrorString(error.error) ?? readErrorString(error.detail);
    const code = readErrorString(error.code);
    if (message && code) {
      return `${message} (${code})`;
    }
    if (message) {
      return message;
    }
    if (code) {
      return `Request failed (${code})`;
    }
  }
  return "Something went wrong.";
}

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

export async function nativeLoad<T>(label: string, promise: Promise<T>, fallback: T): Promise<NativeLoadResult<T>> {
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

export function nativeLoadIssues(results: Array<NativeLoadResult<unknown>>): NativeLoadIssue[] {
  return results.map((result) => result.issue).filter((issue): issue is NativeLoadIssue => Boolean(issue));
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useAsyncLoad<T>(loader: () => Promise<T>) {
  const [state, setState] = useState<LoadState<T>>({
    loading: true,
    error: null,
    data: null,
  });
  // Monotonic request id mirrors `useShellStatus.refreshIdRef`: a later reload
  // bumps the id so an earlier (slower) response is dropped, and unmount bumps
  // it so no in-flight response calls setState after teardown. This prevents
  // last-writer-wins races on workspace switch and setState-after-unmount.
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrentRequest = () => requestIdRef.current === requestId;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await loader();
      if (!isCurrentRequest()) {
        return;
      }
      setState({
        loading: false,
        error: null,
        data,
      });
    } catch (error) {
      if (!isCurrentRequest()) {
        return;
      }
      setState({
        loading: false,
        error: getErrorMessage(error),
        data: null,
      });
    }
  }, [loader]);

  useEffect(() => {
    void reload();
    return () => {
      // Supersede any in-flight reload so its resolution is ignored once this
      // effect (and typically the component) tears down.
      requestIdRef.current += 1;
    };
  }, [reload]);

  return {
    ...state,
    reload,
  };
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function SettingsLoadWarnings({ issues, onRetry }: { issues: NativeLoadIssue[]; onRetry: () => void }) {
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

export function SettingsPageFrame({
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
      <header className="mc-next-directory-header" data-area="settings">
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

export function SettingsSectionShell({
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
    name: connection.pluginId ?? connection.connectionId ?? "integration",
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
    <SettingsPanel
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
    </SettingsPanel>
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
        <button type="button" className="mc-next-button-secondary" onClick={onOpen}>
          Open
        </button>
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

export function SettingsPanel({
  title,
  subtitle,
  stats,
  headerAccessory,
  children,
  compact = true,
  scrollBody = false,
  bodyMaxHeight,
}: {
  title: string;
  subtitle: string;
  stats?: Array<{ label: string; value: string }>;
  /**
   * Optional element rendered in the panel head — used to surface the
   * "Unsaved" indicator next to the section title. Sections opt in by
   * combining `useFormDirty` with this slot.
   */
  headerAccessory?: ReactNode;
  children: ReactNode;
  compact?: boolean;
  scrollBody?: boolean;
  bodyMaxHeight?: string;
}) {
  return (
    <article className={`mc-next-directory-card mc-next-settings-panel${compact ? " is-compact" : ""}`}>
      <div className="mc-next-directory-card-head">
        <div>
          <div
            className="mc-next-settings-panel-title-row"
            style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}
          >
            <h2>{title}</h2>
            {headerAccessory}
          </div>
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

export function SettingsMetricGrid({ items }: { items: Array<{ label: string; value: string; meta?: string }> }) {
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

export function SettingsSelectableList({
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
  return <div className={`mc-next-settings-notice ${notice.tone}`}>{notice.message}</div>;
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
    case "personalities":
      return Sparkles;
    case "access":
      return ShieldCheck;
    case "permissions":
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
    case "personalities":
      return "Personalities";
    case "access":
      return "Access";
    case "permissions":
      return "Permissions";
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
    case "personalities":
      return "Manage Chat tone presets and choose the global Chat default.";
    case "access":
      return "Manage gateway auth posture, install tokens, and device access.";
    case "permissions":
      return "Manage permission profiles, active defaults, and time-boxed local override controls with operator evidence.";
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
