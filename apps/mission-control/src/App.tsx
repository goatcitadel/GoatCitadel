import { memo, Suspense, lazy, useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  consumeGatewayAccessBootstrapFromLocation,
  connectEventStream,
  fetchWorkspaces,
  getGatewayApiBaseUrl,
  preflightGatewayAccess,
  resolveApproval,
  resolveApprovalWithRemoteToken,
  type GatewayAccessPreflightResult,
  type RealtimeEvent,
  type EventStreamConnectionState,
} from "./api/shell-client";
import { DeviceAccessApprovalModal, type DeviceAccessApprovalPrompt } from "./components/DeviceAccessApprovalModal";
import { GatewayAccessGate } from "./components/GatewayAccessGate";
import { GlobalFreshnessPill } from "./components/GlobalFreshnessPill";
import { HelpHint } from "./components/HelpHint";
import { NotificationStack, type NotificationItem, upsertNotificationItem } from "./components/NotificationStack";
import { RemoteApprovalActionModal, type RemoteApprovalActionPrompt } from "./components/RemoteApprovalActionModal";
import { ClockBadge } from "./components/ClockBadge";
import { ShellActionGroup } from "./components/ShellActionGroup";
import { StatusChip } from "./components/StatusChip";
import { appCopy } from "./content/copy";
import { emitRefresh, type RefreshTopic } from "./state/refresh-bus";
import { useUiPreferences } from "./state/ui-preferences";
import { resolveEffectiveEffectsMode } from "./state/effects-mode";
import { publishEventStreamStatus, resetEventStreamStatus } from "./state/event-stream-status-store";
import { deriveShellGatewayAccessState } from "./state/gateway-shell-state";
import { useEventStreamStatus } from "./hooks/useEventStreamStatus";
import {
  isDevDiagnosticsEnabled,
  recordClientDiagnostic,
  setDevDiagnosticsCurrentEffectsMode,
  setDevDiagnosticsCurrentRoute,
  setDevDiagnosticsGatewayReachable,
  setDevDiagnosticsSseState,
} from "./state/dev-diagnostics-store";
import { GCSelect, GCSwitch } from "./components/ui";

function lazyPage(loader: () => Promise<Record<string, unknown>>, exportName: string) {
  return lazy(async () => {
    const module = await loader();
    return { default: module[exportName] as ComponentType<any> };
  });
}

const AddonsPage = lazyPage(() => import("./pages/AddonsPage"), "AddonsPage");
const CommandPalette = lazyPage(() => import("./components/CommandPalette"), "CommandPalette");
const OnboardingPage = lazyPage(() => import("./pages/OnboardingPage"), "OnboardingPage");
const DashboardPage = lazyPage(() => import("./pages/DashboardPage"), "DashboardPage");
const DevDiagnosticsPanel = lazyPage(() => import("./components/DevDiagnosticsPanel"), "DevDiagnosticsPanel");
const SystemPage = lazyPage(() => import("./pages/SystemPage"), "SystemPage");
const FilesPage = lazyPage(() => import("./pages/FilesPage"), "FilesPage");
const MemoryPage = lazyPage(() => import("./pages/MemoryPage"), "MemoryPage");
const AgentsPage = lazyPage(() => import("./pages/AgentsPage"), "AgentsPage");
const OfficePage = lazyPage(() => import("./pages/OfficePage"), "OfficePage");
const OfficeLabPage = lazyPage(() => import("./pages/OfficeLabPage"), "OfficeLabPage");
const ActivityPage = lazyPage(() => import("./pages/ActivityPage"), "ActivityPage");
const CronPage = lazyPage(() => import("./pages/CronPage"), "CronPage");
const SessionsPage = lazyPage(() => import("./pages/SessionsPage"), "SessionsPage");
const ChatPage = lazyPage(() => import("./pages/ChatPage"), "ChatPage");
const AssemblyPage = lazyPage(() => import("./pages/AssemblyPage"), "AssemblyPage");
const PromptLabPage = lazyPage(() => import("./pages/PromptLabPage"), "PromptLabPage");
const ImprovementPage = lazyPage(() => import("./pages/ImprovementPage"), "ImprovementPage");
const SkillsPage = lazyPage(() => import("./pages/SkillsPage"), "SkillsPage");
const CostConsolePage = lazyPage(() => import("./pages/CostConsolePage"), "CostConsolePage");
const SettingsPage = lazyPage(() => import("./pages/SettingsPage"), "SettingsPage");
const ToolsPage = lazyPage(() => import("./pages/ToolsPage"), "ToolsPage");
const ApprovalsPage = lazyPage(() => import("./pages/ApprovalsPage"), "ApprovalsPage");
const TasksPage = lazyPage(() => import("./pages/TasksPage"), "TasksPage");
const IntegrationsPage = lazyPage(() => import("./pages/IntegrationsPage"), "IntegrationsPage");
const McpPage = lazyPage(() => import("./pages/McpPage"), "McpPage");
const MeshPage = lazyPage(() => import("./pages/MeshPage"), "MeshPage");
const NpuPage = lazyPage(() => import("./pages/NpuPage"), "NpuPage");
const WorkspacesPage = lazyPage(() => import("./pages/WorkspacesPage"), "WorkspacesPage");

function PageLoadingFallback({ label }: { label: string }) {
  return (
    <section className="shell-page-loading" aria-live="polite">
      <div className="shell-page-loading-card">
        <p className="shell-page-loading-kicker">Loading module</p>
        <h3>{label}</h3>
      </div>
    </section>
  );
}

type Tab =
  | "addons"
  | "onboarding"
  | "dashboard"
  | "system"
  | "files"
  | "memory"
  | "agents"
  | "office"
  | "officeLab"
  | "activity"
  | "cron"
  | "sessions"
  | "chat"
  | "assembly"
  | "promptLab"
  | "improvement"
  | "skills"
  | "costs"
  | "settings"
  | "workspaces"
  | "tools"
  | "approvals"
  | "tasks"
  | "integrations"
  | "mcp"
  | "mesh"
  | "npu";

const allTabs: Tab[] = [
  "addons",
  "onboarding",
  "dashboard",
  "system",
  "files",
  "memory",
  "agents",
  "office",
  "officeLab",
  "activity",
  "cron",
  "sessions",
  "chat",
  "assembly",
  "promptLab",
  "improvement",
  "skills",
  "costs",
  "settings",
  "workspaces",
  "tools",
  "approvals",
  "tasks",
  "integrations",
  "mcp",
  "mesh",
  "npu",
];

const navItems: Array<{ id: Tab; label: string; code: string }> = appCopy.navItems;

const navSections: Array<{ label: string; items: Tab[] }> = appCopy.navSections;

const nextStepByTab: Record<Tab, string> = appCopy.nextStepByTab;

const refreshTopicRules: Array<{ topic: RefreshTopic; keywords: string[] }> = [
  { topic: "dashboard", keywords: ["dashboard", "operator", "summit", "cron", "memory", "settings", "system", "onboarding", "llm"] },
  { topic: "promptLab", keywords: ["prompt_pack", "promptlab", "prompt_lab", "prompt-pack"] },
  { topic: "chat", keywords: ["chat", "message", "session", "delegate", "proactive", "learned_memory", "llm", "provider", "model", "onboarding", "settings"] },
  { topic: "approvals", keywords: ["approval", "gatehouse"] },
  { topic: "tools", keywords: ["tool", "grant", "policy"] },
  { topic: "files", keywords: ["file", "artifact", "workspace"] },
  { topic: "memory", keywords: ["memory", "qmd", "context"] },
  { topic: "agents", keywords: ["agent", "goat", "herd"] },
  { topic: "skills", keywords: ["skill", "bankr"] },
  { topic: "mcp", keywords: ["mcp"] },
  { topic: "tasks", keywords: ["task", "trailboard"] },
  { topic: "improvement", keywords: ["improvement", "replay", "autotune", "self_improvement"] },
  { topic: "integrations", keywords: ["integration", "plugin", "connection"] },
  { topic: "npu", keywords: ["npu", "runtime", "sidecar", "model", "voice", "llm", "provider"] },
];

type GatewayAccessViewState =
  | GatewayAccessPreflightResult
  | {
    status: "checking";
    message: string;
    healthDetail?: string;
  };

function deriveRefreshTopics(event: RealtimeEvent): RefreshTopic[] {
  if (event.payload.kind === "replay_gap") {
    return [...new Set(refreshTopicRules.map((rule) => rule.topic))];
  }
  const haystack = `${event.eventType} ${event.source}`.toLowerCase();
  const topics = new Set<RefreshTopic>();

  for (const rule of refreshTopicRules) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      topics.add(rule.topic);
    }
  }

  return [...topics];
}

function isTab(value: string | null): value is Tab {
  if (!value) {
    return false;
  }
  return allTabs.some((tab) => tab === value);
}

function readTabFromLocation(): Tab {
  if (typeof window === "undefined") {
    return "dashboard";
  }

  const url = new URL(window.location.href);
  const queryTab = url.searchParams.get("tab");
  if (isTab(queryTab)) {
    return queryTab;
  }

  const hashTab = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (isTab(hashTab)) {
    return hashTab;
  }

  return "dashboard";
}

const SidebarStatusFooter = memo(function SidebarStatusFooter({
  streamState,
  onboardingComplete,
  uiMode,
  setUiMode,
  showTechnicalDetails,
  setShowTechnicalDetails,
}: {
  streamState: EventStreamConnectionState;
  onboardingComplete: boolean | null;
  uiMode: "simple" | "advanced";
  setUiMode: (mode: "simple" | "advanced") => void;
  showTechnicalDetails: boolean;
  setShowTechnicalDetails: (enabled: boolean) => void;
}) {
  const streamStatus = useEventStreamStatus();

  return (
    <footer className="sidebar-footer">
      <div className="sidebar-footer-grid">
        <div className="sidebar-footer-item">
          <span className="sidebar-footer-label">{appCopy.sidebar.stream}</span>
          <StatusChip tone={streamStatus.state === "open" ? "live" : streamStatus.state === "error" ? "critical" : "warning"}>
            {streamState}
          </StatusChip>
        </div>
        <div className="sidebar-footer-item">
          <span className="sidebar-footer-label">{appCopy.sidebar.onboarding}</span>
          <span className="sidebar-footer-value">
            {onboardingComplete === null
              ? appCopy.sidebar.unknown
              : onboardingComplete
                ? appCopy.sidebar.complete
                : appCopy.sidebar.required}
          </span>
        </div>
        <div className="sidebar-footer-item">
          <span className="sidebar-footer-label">{appCopy.sidebar.reconnects}</span>
          <span className="sidebar-footer-value">{streamStatus.reconnectAttempts}</span>
        </div>
        <div className="sidebar-footer-item">
          <span className="sidebar-footer-label">{appCopy.sidebar.lastEvent}</span>
          <span className="sidebar-footer-value">
            {streamStatus.lastEventAt
              ? new Date(streamStatus.lastEventAt).toLocaleTimeString()
              : appCopy.sidebar.notAvailable}
          </span>
        </div>
      </div>
      <div className="sidebar-systems">
        <div className="sidebar-system-block">
          <span className="sidebar-footer-label">Experience</span>
          <div className="ui-experience-switch sidebar-experience-switch">
            <button
              type="button"
              className={uiMode === "simple" ? "active" : ""}
              onClick={() => setUiMode("simple")}
            >
              Beginner
            </button>
            <button
              type="button"
              className={uiMode === "advanced" ? "active" : ""}
              onClick={() => setUiMode("advanced")}
            >
              Advanced
            </button>
          </div>
          <span className="sidebar-footer-value sidebar-system-note">
            {uiMode === "simple" ? "Guided defaults" : "Full controls"}
          </span>
        </div>
        <div className="sidebar-system-block">
          <span className="sidebar-footer-label">Citadel systems</span>
          <label className="ui-technical-toggle sidebar-technical-toggle">
            <GCSwitch
              checked={showTechnicalDetails}
              onCheckedChange={setShowTechnicalDetails}
              label="Technical details"
            />
          </label>
        </div>
      </div>
      <div className="sidebar-footer-meta">
        <span>{appCopy.sidebar.mode}: {appCopy.sidebar.localMode}</span>
        <ClockBadge />
      </div>
    </footer>
  );
});

export function App() {
  const {
    mode: uiMode,
    setMode: setUiMode,
    density,
    setDensity,
    effectsMode,
    setEffectsMode,
    showTechnicalDetails,
    setShowTechnicalDetails,
    activeWorkspaceId,
    setActiveWorkspaceId,
  } = useUiPreferences();
  const [tab, setTab] = useState<Tab>(() => readTabFromLocation());
  const [streamState, setStreamState] = useState<EventStreamConnectionState>("closed");
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showBrandMark, setShowBrandMark] = useState(true);
  const [showBrandWordmark, setShowBrandWordmark] = useState(true);
  const [workspaceOptions, setWorkspaceOptions] = useState<Array<{ workspaceId: string; name: string }>>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [deviceAccessPrompts, setDeviceAccessPrompts] = useState<DeviceAccessApprovalPrompt[]>([]);
  const [deviceAccessResolveBusy, setDeviceAccessResolveBusy] = useState(false);
  const [remoteApprovalPrompts, setRemoteApprovalPrompts] = useState<RemoteApprovalActionPrompt[]>([]);
  const [remoteApprovalResolveBusy, setRemoteApprovalResolveBusy] = useState(false);
  const [gatewayAccess, setGatewayAccess] = useState<GatewayAccessViewState>({
    status: "checking",
    message: "Verifying gateway reachability and access policy.",
  });
  const [gatewayAccessBusy, setGatewayAccessBusy] = useState(true);
  const [gatewayAccessRunId, setGatewayAccessRunId] = useState(0);
  const effectiveEffectsMode = useMemo(() => resolveEffectiveEffectsMode(effectsMode), [effectsMode]);
  const shellGatewayState = useMemo(
    () => deriveShellGatewayAccessState(gatewayAccess, streamState),
    [gatewayAccess, streamState],
  );

  const loadWorkspaceOptions = useCallback(async () => {
    try {
      const response = await fetchWorkspaces("all", 400);
      setWorkspaceOptions(response.items.map((item) => ({
        workspaceId: item.workspaceId,
        name: item.name,
      })));
    } catch {
      setWorkspaceOptions([]);
    }
  }, []);

  const pushNotification = useCallback((tone: NotificationItem["tone"], message: string, groupKey?: string) => {
    setNotifications((current) => {
      return upsertNotificationItem(current, {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        tone,
        message,
        timestamp: Date.now(),
        groupKey,
      });
    });
  }, []);

  const activeDeviceAccessPrompt = deviceAccessPrompts[0];
  const activeRemoteApprovalPrompt = remoteApprovalPrompts[0];

  const dismissDeviceAccessPrompt = useCallback((approvalId: string) => {
    setDeviceAccessPrompts((current) => current.filter((item) => item.approvalId !== approvalId));
  }, []);

  const dismissRemoteApprovalPrompt = useCallback((approvalId: string) => {
    setRemoteApprovalPrompts((current) => current.filter((item) => item.approvalId !== approvalId));
  }, []);

  const handleResolveDeviceAccessPrompt = useCallback(async (decision: "approve" | "reject") => {
    if (!activeDeviceAccessPrompt) {
      return;
    }
    setDeviceAccessResolveBusy(true);
    try {
      await resolveApproval(activeDeviceAccessPrompt.approvalId, {
        decision,
        resolvedBy: buildMissionControlResolverId(),
        resolutionNote: decision === "approve"
          ? "Approved from Mission Control."
          : "Rejected from Mission Control.",
      });
      dismissDeviceAccessPrompt(activeDeviceAccessPrompt.approvalId);
      pushNotification(
        decision === "approve" ? "success" : "warning",
        `${activeDeviceAccessPrompt.deviceLabel} ${decision === "approve" ? "was approved" : "was rejected"}.`,
        `device-access:${activeDeviceAccessPrompt.approvalId}`,
      );
    } catch (error) {
      pushNotification(
        "error",
        (error as Error).message,
        `device-access-error:${activeDeviceAccessPrompt.approvalId}`,
      );
    } finally {
      setDeviceAccessResolveBusy(false);
    }
  }, [activeDeviceAccessPrompt, dismissDeviceAccessPrompt, pushNotification]);

  const handleResolveRemoteApprovalPrompt = useCallback(async (decision: "approve" | "reject") => {
    if (!activeRemoteApprovalPrompt) {
      return;
    }
    setRemoteApprovalResolveBusy(true);
    try {
      await resolveApprovalWithRemoteToken(activeRemoteApprovalPrompt.token, decision);
      dismissRemoteApprovalPrompt(activeRemoteApprovalPrompt.approvalId);
      pushNotification(
        decision === "approve" ? "success" : "warning",
        `${activeRemoteApprovalPrompt.kind} ${decision === "approve" ? "was approved" : "was rejected"} from Mission Control.`,
        `remote-approval:${activeRemoteApprovalPrompt.approvalId}`,
      );
    } catch (error) {
      pushNotification(
        "error",
        (error as Error).message,
        `remote-approval-error:${activeRemoteApprovalPrompt.approvalId}`,
      );
    } finally {
      setRemoteApprovalResolveBusy(false);
    }
  }, [activeRemoteApprovalPrompt, dismissRemoteApprovalPrompt, pushNotification]);

  const handleOnboardingCompleted = useCallback(() => {
    setOnboardingComplete(true);
    setTab("dashboard");
    void loadWorkspaceOptions();
  }, [loadWorkspaceOptions]);

  const retryGatewayAccess = useCallback(() => {
    setGatewayAccessRunId((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setGatewayAccessBusy(true);
    setGatewayAccess({
      status: "checking",
      message: "Verifying gateway reachability and access policy.",
    });

    const bootstrap = consumeGatewayAccessBootstrapFromLocation();
    void preflightGatewayAccess({ bootstrap })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setGatewayAccess(result);
        if (result.status !== "ready") {
          setStreamState("closed");
          setOnboardingComplete(null);
          setWorkspaceOptions([]);
          return;
        }
        setOnboardingComplete(result.onboardingState?.completed ?? null);
        if (!result.onboardingState?.completed) {
          setTab((current) => (current === "dashboard" ? "onboarding" : current));
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setGatewayAccess({
          status: "misconfigured",
          message: (error as Error).message,
          healthDetail: "Gateway access preflight crashed before Mission Control could finish startup.",
        });
        setStreamState("closed");
        setOnboardingComplete(null);
        setWorkspaceOptions([]);
      })
      .finally(() => {
        if (!cancelled) {
          setGatewayAccessBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [gatewayAccessRunId]);

  useEffect(() => {
    if (gatewayAccess.status !== "ready") {
      setStreamState("closed");
      setDevDiagnosticsSseState("closed");
      resetEventStreamStatus();
      return;
    }

    const close = connectEventStream(
      (event) => {
        recordClientDiagnostic({
          level: "debug",
          category: "refresh",
          event: "event",
          message: `Realtime event ${event.eventType}`,
          context: {
            source: event.source,
            eventId: event.eventId,
          },
        });
        const topics = deriveRefreshTopics(event);
        for (const topic of topics) {
          emitRefresh(topic, {
            reason: event.payload.kind === "replay_gap" ? "replay_gap" : event.eventType,
            source: event.source,
            eventType: event.payload.kind === "replay_gap" ? "replay_gap" : event.eventType,
            eventId: event.eventId,
            timestamp: Date.now(),
          });
        }
        if (event.eventType === "auth_device_request_created") {
          const prompt = parseDeviceAccessPrompt(event);
          if (prompt) {
            setDeviceAccessPrompts((current) => upsertDeviceAccessPrompt(current, prompt));
            pushNotification(
              "warning",
              `${prompt.deviceLabel} is waiting for approval.`,
              `device-access:${prompt.approvalId}`,
            );
          }
        }
        if (event.eventType === "auth_device_request_resolved") {
          const approvalId = readDeviceAccessPromptField(event.payload, "approvalId");
          if (approvalId) {
            dismissDeviceAccessPrompt(approvalId);
          }
        }
        if (event.eventType === "approval_remote_action_ready") {
          const prompt = parseRemoteApprovalActionPrompt(event);
          if (prompt) {
            setRemoteApprovalPrompts((current) => upsertRemoteApprovalPrompt(current, prompt));
            pushNotification(
              "warning",
              `${prompt.kind} is waiting for a Mission Control decision.`,
              `remote-approval:${prompt.approvalId}`,
            );
          }
        }
        if (event.eventType === "approval_resolved") {
          const approvalId = readDeviceAccessPromptField(event.payload, "approvalId");
          if (approvalId) {
            dismissRemoteApprovalPrompt(approvalId);
          }
        }
        if (event.payload.kind === "replay_gap") {
          pushNotification(
            "warning",
            "Live event history rotated past this browser cursor. Mission Control is refreshing from the latest retained state.",
            "stream-replay-gap",
          );
        }
      },
      (nextState) => {
        setStreamState(nextState);
        setDevDiagnosticsSseState(nextState);
        if (nextState === "open") {
          setDevDiagnosticsGatewayReachable(true);
        }
        recordClientDiagnostic({
          level: nextState === "error" ? "warn" : "info",
          category: "sse",
          event: "state_change",
          message: `Realtime stream is now ${nextState}`,
        });
        if (nextState === "error") {
          pushNotification("warning", "Live updates degraded. GoatCitadel is reconnecting.", "stream-connection");
        }
        if (nextState === "open") {
          pushNotification("success", "Live updates connected.", "stream-connection");
        }
      },
      publishEventStreamStatus,
    );

    return () => {
      close();
      resetEventStreamStatus();
    };
  }, [gatewayAccess.status, pushNotification, dismissDeviceAccessPrompt, dismissRemoteApprovalPrompt]);

  useEffect(() => {
    if (gatewayAccess.status !== "ready") {
      setWorkspaceOptions([]);
      return;
    }
    void loadWorkspaceOptions();
  }, [gatewayAccess.status, loadWorkspaceOptions]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setDevDiagnosticsCurrentRoute(`${url.pathname}${url.search}${url.hash}`);
    recordClientDiagnostic({
      level: "info",
      category: "ui",
      event: "route.change",
      message: `Switched to ${tab}`,
      context: { tab },
    });
  }, [tab]);

  useEffect(() => {
    setDevDiagnosticsCurrentEffectsMode(effectiveEffectsMode);
  }, [effectiveEffectsMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const navById = useMemo(() => new Map(navItems.map((item) => [item.id, item])), []);
  const activeNav = navById.get(tab);
  const commandItems = useMemo(
    () => [
      ...navItems.map((item) => ({
        id: `tab:${item.id}`,
        label: `Go to ${item.label}`,
        keywords: [item.id, item.code],
        run: () => setTab(item.id),
      })),
      {
        id: "mode:simple",
        label: "Switch to Beginner experience",
        keywords: ["beginner", "simple", "guided", "experience"],
        run: () => setUiMode("simple"),
      },
      {
        id: "mode:advanced",
        label: "Switch to Advanced experience",
        keywords: ["advanced", "full controls", "experience"],
        run: () => setUiMode("advanced"),
      },
      {
        id: "density:compact",
        label: "Use Compact density",
        keywords: ["compact", "density", "layout"],
        run: () => setDensity("compact"),
      },
      {
        id: "density:default",
        label: "Use Default density",
        keywords: ["default", "density", "layout"],
        run: () => setDensity("default"),
      },
      {
        id: "density:comfortable",
        label: "Use Comfortable density",
        keywords: ["comfortable", "density", "layout"],
        run: () => setDensity("comfortable"),
      },
      {
        id: "details:toggle",
        label: showTechnicalDetails ? "Hide technical details" : "Show technical details",
        keywords: ["technical", "details", "debug"],
        run: () => setShowTechnicalDetails(!showTechnicalDetails),
      },
      ...(isDevDiagnosticsEnabled()
        ? [{
          id: "dev:diagnostics",
          label: diagnosticsOpen ? "Hide developer diagnostics" : "Show developer diagnostics",
          keywords: ["diagnostics", "dev", "logs", "debug"],
          run: () => setDiagnosticsOpen((current) => !current),
        }]
        : []),
    ],
    [diagnosticsOpen, setDensity, setShowTechnicalDetails, setUiMode, showTechnicalDetails],
  );

  const content = useMemo(() => {
    if (tab === "addons") {
      return <AddonsPage />;
    }
    if (tab === "onboarding") {
      return <OnboardingPage onCompleted={handleOnboardingCompleted} />;
    }
    if (tab === "dashboard") {
      return <DashboardPage onNavigate={(next: string) => setTab(next as Tab)} />;
    }
    if (tab === "system") {
      return <SystemPage />;
    }
    if (tab === "files") {
      return <FilesPage workspaceId={activeWorkspaceId} />;
    }
    if (tab === "memory") {
      return <MemoryPage workspaceId={activeWorkspaceId} />;
    }
    if (tab === "agents") {
      return <AgentsPage />;
    }
    if (tab === "office") {
      return <OfficePage />;
    }
    if (tab === "officeLab") {
      return <OfficeLabPage />;
    }
    if (tab === "activity") {
      return <ActivityPage />;
    }
    if (tab === "cron") {
      return <CronPage />;
    }
    if (tab === "sessions") {
      return <SessionsPage />;
    }
    if (tab === "chat") {
      return <ChatPage workspaceId={activeWorkspaceId} />;
    }
    if (tab === "assembly") {
      return <AssemblyPage workspaceId={activeWorkspaceId} />;
    }
    if (tab === "promptLab") {
      return <PromptLabPage workspaceId={activeWorkspaceId} />;
    }
    if (tab === "improvement") {
      return <ImprovementPage workspaceId={activeWorkspaceId} />;
    }
    if (tab === "skills") {
      return <SkillsPage />;
    }
    if (tab === "costs") {
      return <CostConsolePage />;
    }
    if (tab === "settings") {
      return <SettingsPage />;
    }
    if (tab === "workspaces") {
      return (
        <WorkspacesPage
          activeWorkspaceId={activeWorkspaceId}
          onWorkspaceChange={setActiveWorkspaceId}
        />
      );
    }
    if (tab === "tools") {
      return <ToolsPage />;
    }
    if (tab === "approvals") {
      return <ApprovalsPage />;
    }
    if (tab === "tasks") {
      return <TasksPage workspaceId={activeWorkspaceId} />;
    }
    if (tab === "mesh") {
      return <MeshPage />;
    }
    if (tab === "mcp") {
      return <McpPage />;
    }
    if (tab === "npu") {
      return <NpuPage />;
    }
    return <IntegrationsPage />;
  }, [activeWorkspaceId, tab, handleOnboardingCompleted, setActiveWorkspaceId]);

  if (gatewayAccess.status !== "ready") {
    return (
      <GatewayAccessGate
        gatewayBaseUrl={getGatewayApiBaseUrl()}
        access={gatewayAccess}
        busy={gatewayAccessBusy}
        onRetry={retryGatewayAccess}
      />
    );
  }

  return (
    <div
      data-effects-mode={effectsMode}
      data-effective-effects-mode={effectiveEffectsMode}
      className={`layout-shell theme-signal-noir ui-mode-${uiMode} ui-density-${density} ui-effects-${effectiveEffectsMode}${showTechnicalDetails ? "" : " ui-hide-technical"}`}
      data-density={density}
    >
      <aside className="sidebar">
        <div className="sidebar-brand">
          {showBrandMark ? (
            <img
              src="/brand/goatcitadel-mark.png"
              alt="GoatCitadel mark"
              className="sidebar-brand-mark"
              onError={() => setShowBrandMark(false)}
            />
          ) : null}
          <div className="sidebar-brand-copy">
            {showBrandWordmark ? (
              <img
                src="/brand/goatcitadel-wordmark.png"
                alt="GoatCitadel"
                className="sidebar-brand-wordmark"
                onError={() => setShowBrandWordmark(false)}
              />
            ) : <h1>{appCopy.brandTitle}</h1>}
            <p className="sidebar-subtitle">{appCopy.brandSubtitle}</p>
          </div>
        </div>
        <button type="button" className="sidebar-command-trigger" onClick={() => setPaletteOpen(true)}>
          {appCopy.quickActionsButton}
        </button>
        <nav className="sidebar-nav">
          {navSections.map((section) => (
            <div key={section.label} className="sidebar-section">
              <div className="sidebar-section-head">
                <p>{section.label}</p>
              </div>
              {section.items.map((tabId) => {
                const item = navById.get(tabId);
                if (!item) {
                  return null;
                }
                return (
                  <button type="button"
                    key={item.id}
                    onClick={() => setTab(item.id)}
                    className={tab === item.id ? "active" : ""}
                  >
                    <span className="nav-code">{item.code}</span>
                    <span className="nav-label">{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <SidebarStatusFooter
          streamState={streamState}
          onboardingComplete={onboardingComplete}
          uiMode={uiMode}
          setUiMode={setUiMode}
          showTechnicalDetails={showTechnicalDetails}
          setShowTechnicalDetails={setShowTechnicalDetails}
        />
      </aside>
      <main className="content shell-content">
        <header className="app-topbar shell-topbar">
          <div className="shell-topbar-copy">
            <div className="shell-topbar-title-row">
              <p className="shell-topbar-kicker">Citadel systems</p>
              <h3>Command Deck</h3>
            </div>
            <p className="office-subtitle shell-topbar-subtitle">
              <strong>{activeNav?.label ?? "Mission Control"}</strong>
            </p>
          </div>
          <div className="app-topbar-actions">
            <div className="shell-topbar-actions-left">
              <button type="button" className="shell-quick-action shell-command-trigger-topbar" onClick={() => setPaletteOpen(true)}>
                Command Palette
              </button>
              <GlobalFreshnessPill streamState={streamState} />
            </div>
            <div className="shell-topbar-actions-right">
              <ShellActionGroup className="shell-toggle-group">
                <span className="shell-action-label">Density</span>
                <div className="ui-experience-switch ui-density-switch">
                  <button type="button" className={density === "comfortable" ? "active" : ""} onClick={() => setDensity("comfortable")}>
                    Comfortable
                  </button>
                  <button type="button" className={density === "default" ? "active" : ""} onClick={() => setDensity("default")}>
                    Default
                  </button>
                  <button type="button" className={density === "compact" ? "active" : ""} onClick={() => setDensity("compact")}>
                    Compact
                  </button>
                </div>
              </ShellActionGroup>
              <ShellActionGroup className="shell-toggle-group">
                <span className="shell-action-label">Effects</span>
                <div className="ui-experience-switch ui-density-switch">
                  <button type="button" className={effectsMode === "auto" ? "active" : ""} onClick={() => setEffectsMode("auto")}>
                    Auto
                  </button>
                  <button type="button" className={effectsMode === "full" ? "active" : ""} onClick={() => setEffectsMode("full")}>
                    Full
                  </button>
                  <button type="button" className={effectsMode === "reduced" ? "active" : ""} onClick={() => setEffectsMode("reduced")}>
                    Reduced
                  </button>
                </div>
              </ShellActionGroup>
              <ShellActionGroup>
                <label className="ui-technical-toggle shell-workspace-picker">
                  <span className="shell-action-label">Workspace</span>
                  <GCSelect
                    value={activeWorkspaceId}
                    onChange={setActiveWorkspaceId}
                    options={[...workspaceOptions, { workspaceId: activeWorkspaceId, name: activeWorkspaceId }]
                      .filter((item, index, arr) => arr.findIndex((other) => other.workspaceId === item.workspaceId) === index)
                      .map((item) => ({ value: item.workspaceId, label: item.name }))}
                  />
                </label>
              </ShellActionGroup>
              <HelpHint
                label="Command deck guidance"
                text={nextStepByTab[tab]}
              />
              {isDevDiagnosticsEnabled() ? (
                <button
                  type="button"
                  className="shell-quick-action shell-command-trigger-topbar"
                  onClick={() => setDiagnosticsOpen((current) => !current)}
                >
                  Diagnostics
                </button>
              ) : null}
            </div>
          </div>
        </header>
        {shellGatewayState.status === "degraded-live-updates" ? (
          <div className="status-banner warning">
            {shellGatewayState.summary} {shellGatewayState.nextStep}
          </div>
        ) : null}
        <Suspense fallback={<PageLoadingFallback label={activeNav?.label ?? "Mission Control"} />}>
          {content}
        </Suspense>
      </main>
      {paletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette
            open={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            items={commandItems}
          />
        </Suspense>
      ) : null}
      {diagnosticsOpen && isDevDiagnosticsEnabled() ? (
        <Suspense fallback={null}>
          <DevDiagnosticsPanel
            open={diagnosticsOpen}
            onClose={() => setDiagnosticsOpen(false)}
          />
        </Suspense>
      ) : null}
      <NotificationStack
        items={notifications}
        onDismiss={(id) => setNotifications((current) => current.filter((item) => item.id !== id))}
      />
      <DeviceAccessApprovalModal
        open={Boolean(activeDeviceAccessPrompt)}
        prompt={activeDeviceAccessPrompt}
        busy={deviceAccessResolveBusy}
        onApprove={() => void handleResolveDeviceAccessPrompt("approve")}
        onReject={() => void handleResolveDeviceAccessPrompt("reject")}
        onDismiss={() => {
          if (activeDeviceAccessPrompt) {
            dismissDeviceAccessPrompt(activeDeviceAccessPrompt.approvalId);
          }
        }}
      />
      <RemoteApprovalActionModal
        open={Boolean(activeRemoteApprovalPrompt)}
        prompt={activeRemoteApprovalPrompt}
        busy={remoteApprovalResolveBusy}
        onApprove={() => void handleResolveRemoteApprovalPrompt("approve")}
        onReject={() => void handleResolveRemoteApprovalPrompt("reject")}
        onDismiss={() => {
          if (activeRemoteApprovalPrompt) {
            dismissRemoteApprovalPrompt(activeRemoteApprovalPrompt.approvalId);
          }
        }}
      />
    </div>
  );
}

function parseDeviceAccessPrompt(event: RealtimeEvent): DeviceAccessApprovalPrompt | undefined {
  const approvalId = readDeviceAccessPromptField(event.payload, "approvalId");
  const requestId = readDeviceAccessPromptField(event.payload, "requestId");
  if (!approvalId || !requestId) {
    return undefined;
  }
  return {
    approvalId,
    requestId,
    deviceLabel: readDeviceAccessPromptField(event.payload, "deviceLabel") ?? "New device",
    deviceType: readDeviceAccessPromptField(event.payload, "deviceType"),
    platform: readDeviceAccessPromptField(event.payload, "platform"),
    requestedIp: readDeviceAccessPromptField(event.payload, "requestedIp"),
    requestedOrigin: readDeviceAccessPromptField(event.payload, "requestedOrigin"),
    createdAt: readDeviceAccessPromptField(event.payload, "createdAt"),
  };
}

function upsertDeviceAccessPrompt(
  current: DeviceAccessApprovalPrompt[],
  incoming: DeviceAccessApprovalPrompt,
): DeviceAccessApprovalPrompt[] {
  const withoutMatch = current.filter((item) => item.approvalId !== incoming.approvalId);
  return [incoming, ...withoutMatch];
}

function parseRemoteApprovalActionPrompt(event: RealtimeEvent): RemoteApprovalActionPrompt | undefined {
  const nested = event.payload.payload;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return undefined;
  }
  const payload = nested as Record<string, unknown>;
  const approvalId = readDeviceAccessPromptField(payload, "approvalId");
  const tokenId = readDeviceAccessPromptField(payload, "tokenId");
  const token = readDeviceAccessPromptField(payload, "token");
  if (!approvalId || !tokenId || !token) {
    return undefined;
  }
  const preview = payload.preview;
  return {
    approvalId,
    actionType: "approval.resolve",
    tokenId,
    token,
    kind: readDeviceAccessPromptField(payload, "kind") ?? "approval",
    riskLevel: readDeviceAccessPromptField(payload, "riskLevel") ?? "danger",
    status: readDeviceAccessPromptField(payload, "status") ?? "pending",
    preview: preview && typeof preview === "object" && !Array.isArray(preview)
      ? preview as Record<string, unknown>
      : undefined,
    expiresAt: readDeviceAccessPromptField(payload, "expiresAt"),
  };
}

function upsertRemoteApprovalPrompt(
  current: RemoteApprovalActionPrompt[],
  incoming: RemoteApprovalActionPrompt,
): RemoteApprovalActionPrompt[] {
  const withoutMatch = current.filter((item) => item.approvalId !== incoming.approvalId);
  return [incoming, ...withoutMatch];
}

function readDeviceAccessPromptField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildMissionControlResolverId(): string {
  if (typeof window === "undefined") {
    return "mission-control";
  }
  return `mission-control:${window.location.hostname}`;
}
