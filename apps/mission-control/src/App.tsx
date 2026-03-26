import { memo, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { CHAT_MODE_PRESETS } from "@goatcitadel/contracts";
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
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { RemoteApprovalActionModal, type RemoteApprovalActionPrompt } from "./components/RemoteApprovalActionModal";
import { ClockBadge } from "./components/ClockBadge";
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

type WorkSurface = "chat" | "cowork" | "code";

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

const nextStepByTab: Record<Tab, string> = appCopy.nextStepByTab;

type PrimaryNavId = "home" | "work" | "observe" | "configure";

interface SecondaryNavSection {
  label: string;
  hint: string;
  items: Tab[];
  simpleItems?: Tab[];
}

interface PrimaryNavMode {
  id: PrimaryNavId;
  label: string;
  code: string;
  description: string;
  defaultTab: Tab;
  sections: SecondaryNavSection[];
}

const primaryNavModes: PrimaryNavMode[] = [
  {
    id: "home",
    label: "Home",
    code: "HM",
    description: "Start here for health, blockers, and where to intervene next.",
    defaultTab: "dashboard",
    sections: [
      {
        label: "Overview",
        hint: "Daily command readouts and onboarding posture.",
        items: ["dashboard", "onboarding"],
        simpleItems: ["dashboard", "onboarding"],
      },
    ],
  },
  {
    id: "work",
    label: "Work",
    code: "WK",
    description: "Daily operator surfaces, queue management, and hands-on execution.",
    defaultTab: "chat",
    sections: [
      {
        label: "Daily loop",
        hint: "The shortest path through chat, queue, and approvals.",
        items: ["chat", "tasks", "approvals", "sessions", "office"],
        simpleItems: ["chat", "tasks", "approvals", "office"],
      },
      {
        label: "Builders",
        hint: "Deeper orchestration and quality work when the task needs it.",
        items: ["agents", "assembly", "promptLab", "improvement", "officeLab"],
        simpleItems: ["agents"],
      },
    ],
  },
  {
    id: "observe",
    label: "Observe",
    code: "OB",
    description: "Operational visibility, traces, files, and runtime posture.",
    defaultTab: "activity",
    sections: [
      {
        label: "Signals",
        hint: "Watch the machine and the workload move in real time.",
        items: ["activity", "system", "costs", "cron"],
        simpleItems: ["activity", "system", "costs"],
      },
      {
        label: "Inspect",
        hint: "Deeper state, storage, and multi-runtime health.",
        items: ["memory", "files", "mesh", "npu"],
        simpleItems: ["memory", "files"],
      },
    ],
  },
  {
    id: "configure",
    label: "Settings",
    code: "CFG",
    description: "Models, integrations, policies, workspace controls, and optional extensions.",
    defaultTab: "settings",
    sections: [
      {
        label: "Core setup",
        hint: "Where provider, integration, and permission decisions should live.",
        items: ["settings", "integrations", "tools", "workspaces"],
        simpleItems: ["settings", "integrations"],
      },
      {
        label: "Advanced",
        hint: "Extend the platform without giving every admin page top-level weight.",
        items: ["skills", "mcp", "addons"],
        simpleItems: [],
      },
    ],
  },
];

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

function isWorkSurface(value: string | null): value is WorkSurface {
  return value === "chat" || value === "cowork" || value === "code";
}

function resolvePrimaryNav(tab: Tab): PrimaryNavId {
  if (tab === "dashboard" || tab === "onboarding") {
    return "home";
  }
  if (["chat", "tasks", "approvals", "sessions", "office", "officeLab", "agents", "assembly", "promptLab", "improvement"].includes(tab)) {
    return "work";
  }
  if (["activity", "system", "files", "memory", "costs", "cron", "mesh", "npu"].includes(tab)) {
    return "observe";
  }
  return "configure";
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

function readWorkSurfaceFromLocation(): WorkSurface {
  if (typeof window === "undefined") {
    return "chat";
  }

  const url = new URL(window.location.href);
  const querySurface = url.searchParams.get("surface");
  if (isWorkSurface(querySurface)) {
    return querySurface;
  }

  return "chat";
}

const SidebarStatusFooter = memo(function SidebarStatusFooter({
  streamState,
  onboardingComplete,
  uiMode,
  setUiMode,
}: {
  streamState: EventStreamConnectionState;
  onboardingComplete: boolean | null;
  uiMode: "simple" | "advanced";
  setUiMode: (mode: "simple" | "advanced") => void;
}) {
  const streamStatus = useEventStreamStatus();

  return (
    <footer className="sidebar-footer">
      <div className="sidebar-health-card">
        <div className="sidebar-health-row">
          <span className="sidebar-footer-label">{appCopy.sidebar.stream}</span>
          <StatusChip tone={streamStatus.state === "open" ? "live" : streamStatus.state === "error" ? "critical" : "warning"}>
            {streamState}
          </StatusChip>
        </div>
        <p className="sidebar-health-note">
          {onboardingComplete === null
            ? "Workspace readiness is still loading."
            : onboardingComplete
              ? "Operator surfaces are ready."
              : "Launch Wizard still needs attention."}
        </p>
      </div>
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
          {uiMode === "simple" ? "Reduced chrome, clearer defaults" : "Expanded controls and deeper views"}
        </span>
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
  const [workSurface, setWorkSurface] = useState<WorkSurface>(() => readWorkSurfaceFromLocation());
  const [streamState, setStreamState] = useState<EventStreamConnectionState>("closed");
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showBrandMark, setShowBrandMark] = useState(true);
  const [showBrandWordmark, setShowBrandWordmark] = useState(true);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [preferencesMenuOpen, setPreferencesMenuOpen] = useState(false);
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
  const moreMenuRef = useRef<HTMLDetailsElement | null>(null);
  const preferencesMenuRef = useRef<HTMLDetailsElement | null>(null);
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
  const closeCommandDeckMenus = useCallback(() => {
    setMoreMenuOpen(false);
    setPreferencesMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!moreMenuOpen && !preferencesMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (moreMenuRef.current?.contains(target) || preferencesMenuRef.current?.contains(target)) {
        return;
      }
      closeCommandDeckMenus();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeCommandDeckMenus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeCommandDeckMenus, moreMenuOpen, preferencesMenuOpen]);

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
    url.searchParams.set("surface", workSurface);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setDevDiagnosticsCurrentRoute(`${url.pathname}${url.search}${url.hash}`);
    recordClientDiagnostic({
      level: "info",
      category: "ui",
      event: "route.change",
      message: `Switched to ${tab}`,
      context: { tab, surface: workSurface },
    });
  }, [tab, workSurface]);

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
  const activePrimaryMode = useMemo<PrimaryNavMode>(() => (
    primaryNavModes.find((mode) => mode.id === resolvePrimaryNav(tab)) ?? primaryNavModes[0]!
  ), [tab]);
  const approvalSurfaceCount = deviceAccessPrompts.length + remoteApprovalPrompts.length;

  const commandDeckSections = useMemo(() => {
    return activePrimaryMode.sections
      .map((section) => {
        const preferredItems = section.simpleItems?.length
          ? section.simpleItems
          : section.items;
        const items = preferredItems.filter((item, index, all) => all.indexOf(item) === index);
        return {
          ...section,
          items,
        };
      })
      .filter((section) => section.items.length > 0);
  }, [activePrimaryMode.sections]);

  const commandDeckNav = useMemo(() => {
    const budget = uiMode === "simple" ? 4 : 5;
    const allPreferredItems = commandDeckSections.flatMap((section) => section.items);
    const uniqueItems = allPreferredItems.filter((item, index, all) => all.indexOf(item) === index);
    const visibleItems = uniqueItems.slice(0, budget);

    if (!visibleItems.includes(tab)) {
      if (visibleItems.length >= budget) {
        visibleItems.pop();
      }
      visibleItems.push(tab);
    }

    const visibleSet = new Set(visibleItems);
    const overflowSections = activePrimaryMode.sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => !visibleSet.has(item)),
      }))
      .filter((section) => section.items.length > 0);

    return {
      visibleItems,
      overflowSections,
    };
  }, [activePrimaryMode.sections, commandDeckSections, tab, uiMode]);

  const commandItems = useMemo(
    () => [
      ...navItems.map((item) => ({
        id: `tab:${item.id}`,
        label: `Go to ${item.label}`,
        keywords: [item.id, item.code],
        run: () => {
          closeCommandDeckMenus();
          setTab(item.id);
        },
      })),
      {
        id: "mode:simple",
        label: "Switch to Beginner experience",
        keywords: ["beginner", "simple", "guided", "experience"],
        run: () => {
          closeCommandDeckMenus();
          setUiMode("simple");
        },
      },
      {
        id: "mode:advanced",
        label: "Switch to Advanced experience",
        keywords: ["advanced", "full controls", "experience"],
        run: () => {
          closeCommandDeckMenus();
          setUiMode("advanced");
        },
      },
      {
        id: "density:compact",
        label: "Use Compact density",
        keywords: ["compact", "density", "layout"],
        run: () => {
          closeCommandDeckMenus();
          setDensity("compact");
        },
      },
      {
        id: "density:default",
        label: "Use Default density",
        keywords: ["default", "density", "layout"],
        run: () => {
          closeCommandDeckMenus();
          setDensity("default");
        },
      },
      {
        id: "density:comfortable",
        label: "Use Comfortable density",
        keywords: ["comfortable", "density", "layout"],
        run: () => {
          closeCommandDeckMenus();
          setDensity("comfortable");
        },
      },
      {
        id: "details:toggle",
        label: showTechnicalDetails ? "Hide technical details" : "Show technical details",
        keywords: ["technical", "details", "debug"],
        run: () => {
          closeCommandDeckMenus();
          setShowTechnicalDetails(!showTechnicalDetails);
        },
      },
      {
        id: "surface:chat",
        label: "Open Chat surface",
        keywords: ["chat", "surface", "workspace"],
        run: () => {
          closeCommandDeckMenus();
          setWorkSurface("chat");
          setTab("chat");
        },
      },
      {
        id: "surface:cowork",
        label: "Open Cowork surface",
        keywords: ["cowork", "surface", "workspace", "delegate"],
        run: () => {
          closeCommandDeckMenus();
          setWorkSurface("cowork");
          setTab("chat");
        },
      },
      {
        id: "surface:code",
        label: "Open Code surface",
        keywords: ["code", "surface", "workspace", "implement"],
        run: () => {
          closeCommandDeckMenus();
          setWorkSurface("code");
          setTab("chat");
        },
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
    [closeCommandDeckMenus, diagnosticsOpen, setDensity, setShowTechnicalDetails, setUiMode, showTechnicalDetails],
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
      return <OfficePage onOpenLab={() => setTab("officeLab")} />;
    }
    if (tab === "officeLab") {
      return <OfficeLabPage onOpenImmersive={() => setTab("office")} />;
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
      return <ChatPage workspaceId={activeWorkspaceId} surface={workSurface} lockSurface />;
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
  }, [activeWorkspaceId, tab, workSurface, handleOnboardingCompleted, setActiveWorkspaceId]);

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

  const currentModeDestinations = commandDeckNav.visibleItems
    .map((tabId) => navById.get(tabId))
    .filter((item): item is NonNullable<typeof activeNav> => Boolean(item));

  return (
    <div
      data-effects-mode={effectsMode}
      data-effective-effects-mode={effectiveEffectsMode}
      className={`layout-shell layout-shell-command-deck theme-citadel-light ui-mode-${uiMode} ui-density-${density} ui-effects-${effectiveEffectsMode}${showTechnicalDetails ? "" : " ui-hide-technical"}`}
      data-density={density}
    >
      <header className="command-deck-shell app-topbar shell-topbar">
        <div className="command-deck-zone command-deck-zone-left">
          <div className="command-deck-brandbar">
            <div className="command-deck-brand">
              {showBrandMark ? (
                <img
                  src="/brand/goatcitadel-mark.png"
                  alt="GoatCitadel mark"
                  className="sidebar-brand-mark command-deck-brand-mark"
                  onError={() => setShowBrandMark(false)}
                />
              ) : null}
              <div className="command-deck-brand-copy">
                {showBrandWordmark ? (
                  <img
                    src="/brand/goatcitadel-wordmark.png"
                    alt="GoatCitadel"
                    className="sidebar-brand-wordmark command-deck-brand-wordmark"
                    onError={() => setShowBrandWordmark(false)}
                  />
                ) : <h1>{appCopy.brandTitle}</h1>}
                <p className="command-deck-brand-kicker">{activePrimaryMode.label} command deck</p>
              </div>
            </div>
          </div>
          <div className="command-deck-navband">
            <nav className="command-deck-nav" aria-label={`${activePrimaryMode.label} destinations`}>
              {currentModeDestinations.map((item) => {
                const isOfficeAlias = item.id === "office" && (tab === "office" || tab === "officeLab");
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`command-deck-pill${tab === item.id || isOfficeAlias ? " active" : ""}`}
                    onClick={() => {
                      closeCommandDeckMenus();
                      setTab(item.id);
                    }}
                  >
                    <span className="nav-code">{item.code}</span>
                    <span className="nav-label">{item.label}</span>
                  </button>
                );
              })}
              <details ref={moreMenuRef} className="command-deck-overflow" open={moreMenuOpen}>
                <summary
                  onClick={(event) => {
                    event.preventDefault();
                    setMoreMenuOpen((current) => {
                      const next = !current;
                      if (next) {
                        setPreferencesMenuOpen(false);
                      }
                      return next;
                    });
                  }}
                >
                  More
                </summary>
                <div className="command-deck-overflow-panel">
                  <div className="command-deck-overflow-block">
                    <p className="command-deck-overflow-kicker">Spaces</p>
                    <div className="command-deck-overflow-list command-deck-overflow-modes">
                      {primaryNavModes.map((mode) => (
                        <button
                          type="button"
                          key={mode.id}
                          className={`command-deck-overflow-item${activePrimaryMode.id === mode.id ? " active" : ""}`}
                          onClick={() => {
                            closeCommandDeckMenus();
                            setTab(mode.defaultTab);
                          }}
                        >
                          <span className="nav-code">{mode.code}</span>
                          <span className="nav-label">{mode.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {commandDeckNav.overflowSections.map((section) => (
                    <div key={section.label} className="command-deck-overflow-block">
                      <p className="command-deck-overflow-kicker">{section.label}</p>
                      <span className="command-deck-overflow-hint">{section.hint}</span>
                      <div className="command-deck-overflow-list">
                        {section.items.map((tabId) => {
                          const item = navById.get(tabId);
                          if (!item) {
                            return null;
                          }
                          const isOfficeAlias = item.id === "office" && (tab === "office" || tab === "officeLab");
                          return (
                            <button
                              type="button"
                              key={item.id}
                              className={`command-deck-overflow-item${tab === item.id || isOfficeAlias ? " active" : ""}`}
                              onClick={() => {
                                closeCommandDeckMenus();
                                setTab(item.id);
                              }}
                            >
                              <span className="nav-code">{item.code}</span>
                              <span className="nav-label">{item.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  <div className="command-deck-overflow-note">
                    <strong>{appCopy.nextStepTitle}:</strong> {nextStepByTab[tab]}
                  </div>
                </div>
              </details>
            </nav>
          </div>
        </div>
        <div className="command-deck-zone command-deck-zone-center">
          <div className="command-deck-surface-band">
            <div className="command-deck-surface-tabs" role="tablist" aria-label="Work surfaces">
              {(["chat", "cowork", "code"] as const).map((surface) => (
                <button
                  type="button"
                  key={surface}
                  role="tab"
                  aria-selected={tab === "chat" && workSurface === surface}
                  className={`command-deck-surface-tab${tab === "chat" && workSurface === surface ? " active" : ""}`}
                  onClick={() => {
                    closeCommandDeckMenus();
                    setWorkSurface(surface);
                    setTab("chat");
                  }}
                >
                  {CHAT_MODE_PRESETS[surface].label}
                </button>
              ))}
            </div>
            <p className="command-deck-surface-note">
              {tab === "chat"
                ? `${CHAT_MODE_PRESETS[workSurface].label} is active. ${CHAT_MODE_PRESETS[workSurface].summary}`
                : "Jump directly into Chat, Cowork, or Code from anywhere in Mission Control."}
            </p>
          </div>
        </div>
        <div className="command-deck-zone command-deck-zone-right">
          <div className="app-topbar-actions command-deck-utilities command-deck-utility-band">
            <div className="command-deck-utility-cluster command-deck-utility-cluster-primary">
              <button
                type="button"
                className="shell-quick-action shell-command-trigger-topbar"
                onClick={() => {
                  closeCommandDeckMenus();
                  setPaletteOpen(true);
                }}
              >
                {appCopy.quickActionsButton}
              </button>
              <GlobalFreshnessPill streamState={streamState} />
            </div>
            <div className="command-deck-utility-cluster command-deck-utility-cluster-context">
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
              <button
                type="button"
                className="shell-status-link"
                onClick={() => {
                  closeCommandDeckMenus();
                  setTab("approvals");
                }}
              >
                <StatusChip tone={approvalSurfaceCount > 0 ? "warning" : "success"}>
                  {approvalSurfaceCount > 0 ? `${approvalSurfaceCount} approvals` : "Approvals clear"}
                </StatusChip>
              </button>
            </div>
            <div className="command-deck-utility-cluster command-deck-utility-cluster-settings">
              <details ref={preferencesMenuRef} className="shell-preferences" open={preferencesMenuOpen}>
                <summary
                  onClick={(event) => {
                    event.preventDefault();
                    setPreferencesMenuOpen((current) => {
                      const next = !current;
                      if (next) {
                        setMoreMenuOpen(false);
                      }
                      return next;
                    });
                  }}
                >
                  Preferences
                </summary>
                <div className="shell-preferences-panel">
                  <div className="shell-preferences-group">
                    <span className="shell-action-label">Density</span>
                    <div className="ui-experience-switch ui-density-switch">
                      <button
                        type="button"
                        className={density === "comfortable" ? "active" : ""}
                        onClick={() => {
                          closeCommandDeckMenus();
                          setDensity("comfortable");
                        }}
                      >
                        Comfortable
                      </button>
                      <button
                        type="button"
                        className={density === "default" ? "active" : ""}
                        onClick={() => {
                          closeCommandDeckMenus();
                          setDensity("default");
                        }}
                      >
                        Default
                      </button>
                      <button
                        type="button"
                        className={density === "compact" ? "active" : ""}
                        onClick={() => {
                          closeCommandDeckMenus();
                          setDensity("compact");
                        }}
                      >
                        Compact
                      </button>
                    </div>
                  </div>
                  <div className="shell-preferences-group">
                    <span className="shell-action-label">Effects</span>
                    <div className="ui-experience-switch ui-density-switch">
                      <button
                        type="button"
                        className={effectsMode === "auto" ? "active" : ""}
                        onClick={() => {
                          closeCommandDeckMenus();
                          setEffectsMode("auto");
                        }}
                      >
                        Auto
                      </button>
                      <button
                        type="button"
                        className={effectsMode === "full" ? "active" : ""}
                        onClick={() => {
                          closeCommandDeckMenus();
                          setEffectsMode("full");
                        }}
                      >
                        Full
                      </button>
                      <button
                        type="button"
                        className={effectsMode === "reduced" ? "active" : ""}
                        onClick={() => {
                          closeCommandDeckMenus();
                          setEffectsMode("reduced");
                        }}
                      >
                        Reduced
                      </button>
                    </div>
                  </div>
                  <div className="shell-preferences-group shell-preferences-switches">
                    <GCSwitch
                      checked={showTechnicalDetails}
                      onCheckedChange={(checked) => {
                        closeCommandDeckMenus();
                        setShowTechnicalDetails(checked);
                      }}
                      label="Technical details"
                    />
                  </div>
                  <HelpHint
                    label="Command deck guidance"
                    text={nextStepByTab[tab]}
                  />
                  {isDevDiagnosticsEnabled() ? (
                    <button
                      type="button"
                      className="shell-quick-action shell-preferences-diagnostics"
                      onClick={() => {
                        closeCommandDeckMenus();
                        setDiagnosticsOpen((current) => !current);
                      }}
                    >
                      {diagnosticsOpen ? "Hide diagnostics" : "Diagnostics"}
                    </button>
                  ) : null}
                </div>
              </details>
            </div>
          </div>
        </div>
      </header>
      <main className="content shell-content shell-content-command-deck">
        {notifications.length > 0 ? (
          <div className="shell-notification-region">
            <NotificationStack
              items={notifications}
              onDismiss={(id) => setNotifications((current) => current.filter((item) => item.id !== id))}
            />
          </div>
        ) : null}
        {shellGatewayState.status === "degraded-live-updates" ? (
          <div className="status-banner warning">
            {shellGatewayState.summary} {shellGatewayState.nextStep}
          </div>
        ) : null}
        <PageErrorBoundary
          resetKey={tab}
          pageLabel={activeNav?.label ?? "Mission Control"}
          onReturnToChat={() => setTab("chat")}
        >
          <Suspense fallback={<PageLoadingFallback label={activeNav?.label ?? "Mission Control"} />}>
            {content}
          </Suspense>
        </PageErrorBoundary>
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
