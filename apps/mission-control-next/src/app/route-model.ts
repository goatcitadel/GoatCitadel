import { RAIL_GROUPS, ROUTE_SECTION_LABELS, navigationAreaForRoute } from "./route-navigation-metadata";
export { RAIL_GROUPS, CITADEL_PAGE_LABELS, navigationAreaForRoute } from "./route-navigation-metadata";
export { parseAppRoute, buildAppHref } from "./route-address";
import { readRouteReleaseStatus } from "./route-release-status";
export { ROUTE_RELEASE_SCOPE, getRouteReleaseScope, describeReleaseScopeForOperator } from "./route-release-scope";
import { normalizeAppRoute, getRouteReleaseKey } from "./route-release-kernel";
export { normalizeAppRoute, getRouteReleaseKey, describeReleaseSurfaceStatus } from "./route-release-kernel";
import type { ChatMode } from "@goatcitadel/contracts";

export type PrimaryArea = "chat" | "cowork" | "code" | "projects" | "library" | "ops" | "settings";
export type CoworkSection = "workspace" | "tasks" | "board";
export type LibrarySection =
  | "agents"
  | "skills"
  | "capabilities"
  | "memory"
  | "journey"
  | "knowledge"
  | "notes"
  | "communications"
  | "files"
  | "artifacts"
  | "prompt-packs"
  | "curator"
  | "citadel"
  | "citadel-overview"
  | "citadel-wards"
  | "citadel-council"
  | "citadel-blueprint"
  | "citadel-vault";
export type OpsSection =
  | "boards"
  | "activity"
  | "sessions"
  | "schedules"
  | "workers"
  | "improvement"
  | "notifications"
  | "approvals"
  | "costs"
  | "quality"
  | "runtime"
  | "diagnostics"
  | "kanban";
export type SettingsSection =
  | "general"
  | "providers"
  | "personalities"
  | "access"
  | "permissions"
  | "budget"
  | "onboarding"
  | "runtime"
  | "local-ai"
  | "workspaces"
  | "integrations"
  | "channels"
  | "mcp"
  | "web-search"
  | "tools"
  | "hooks"
  | "trust-policy"
  | "workspace-capabilities"
  | "citadel-capabilities";
export type ReleaseSurfaceStatus = "ship" | "hide" | "experimental" | "needs_release_polish";

export interface AppRoute {
  channelPlan?: string;
  channelDraft?: string;
  channelRevision?: number;
  channelWorkspace?: string;
  channelConnection?: string;
  area: PrimaryArea;
  mode?: ChatMode; // unified-surface conversation mode (chat area only)
  section?: CoworkSection | LibrarySection | OpsSection | SettingsSection;
  view?: string;
  category?: string;
  evidence?: string;
  includeGlobal?: string;
  eventId?: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  artifactId?: string;
  approvalId?: string;
  projectId?: string;
  theme?: string;
}

export interface AreaMeta {
  id: PrimaryArea;
  label: string;
  description: string;
  kicker: string;
}

export interface RailItem {
  id: string;
  label: string;
  description: string;
  area: PrimaryArea;
  section?: AppRoute["section"];
  preserveThread?: boolean;
}

export interface RouteReleaseScope {
  area: PrimaryArea;
  section: "root" | CoworkSection | LibrarySection | OpsSection | SettingsSection;
  status: ReleaseSurfaceStatus;
  releaseAction: string;
  verification: string;
  note: string;
}

export const AREA_META: Record<PrimaryArea, AreaMeta> = {
  chat: {
    id: "chat",
    label: "Chat",
    kicker: "Conversation",
    description: "One chat workspace for planning, building, search, attachments, approvals, and quick help.",
  },
  cowork: {
    id: "cowork",
    label: "Chat",
    kicker: "Legacy",
    description: "Legacy planning links now open Chat or the Ops board.",
  },
  code: {
    id: "code",
    label: "Chat",
    kicker: "Legacy",
    description: "Legacy Code links now open Chat with governed code capabilities available inside the conversation.",
  },
  projects: {
    id: "projects",
    label: "Projects",
    kicker: "Containers",
    description: "Project containers with conversation, planning, and build threads grouped together.",
  },
  library: {
    id: "library",
    label: "Library",
    kicker: "Knowledge",
    description: "Agents, skills, capabilities, knowledge, memory, files, artifacts, and prompt packs.",
  },
  ops: {
    id: "ops",
    label: "Ops",
    kicker: "Operations",
    description: "Approvals, activity, spend, runtime, and diagnostics.",
  },
  settings: {
    id: "settings",
    label: "Settings",
    kicker: "Configuration",
    description: "Providers, runtimes, workspaces, integrations, and policy.",
  },
};

export const RAIL_ITEMS: Record<PrimaryArea, RailItem[]> = {
  chat: [
    {
      id: "chat-thread",
      label: "Conversation",
      description: "Active work thread with artifacts and attachments close at hand.",
      area: "chat",
      preserveThread: true,
    },
    {
      id: "chat-artifacts",
      label: "Artifacts",
      description: "Jump to generated outputs from active work.",
      area: "library",
      section: "artifacts",
      preserveThread: true,
    },
    {
      id: "chat-memory",
      label: "Memory",
      description: "Inspect what the system knows and what it learned.",
      area: "library",
      section: "memory",
    },
    {
      id: "chat-approvals",
      label: "Approvals",
      description: "Review pending tool or risk decisions.",
      area: "ops",
      section: "approvals",
    },
  ],
  cowork: [
    {
      id: "cowork-workspace",
      label: "Workspace",
      description: "Delegation-first surface for multi-step work.",
      area: "cowork",
      section: "workspace",
      preserveThread: true,
    },
    {
      id: "cowork-tasks",
      label: "Task Board",
      description: "Move between planning, assigned, review, blocked, and done.",
      area: "cowork",
      section: "tasks",
    },
    {
      id: "cowork-board",
      label: "Agent Board",
      description: "See agent posture and live board state.",
      area: "cowork",
      section: "board",
    },
    {
      id: "cowork-approvals",
      label: "Approvals",
      description: "Surface risky checkpoints where the operator expects them.",
      area: "ops",
      section: "approvals",
    },
  ],
  code: [
    {
      id: "code-workbench",
      label: "Workbench",
      description: "Implementation help with file actions, diffs, and candidates.",
      area: "code",
      preserveThread: true,
    },
    {
      id: "code-files",
      label: "Files",
      description: "Browse shared workspace files outside the active thread.",
      area: "library",
      section: "files",
    },
    {
      id: "code-runtime",
      label: "Runtime",
      description: "Keep serving posture and spend visible while coding.",
      area: "ops",
      section: "runtime",
    },
    {
      id: "code-approvals",
      label: "Approvals",
      description: "Review Code Mode and tool decisions from the build lane.",
      area: "ops",
      section: "approvals",
      preserveThread: true,
    },
    {
      id: "code-prompt-packs",
      label: "Prompt Packs",
      description: "Jump into quality gates and pack authoring.",
      area: "library",
      section: "prompt-packs",
    },
  ],
  projects: [
    {
      id: "projects-list",
      label: "Projects",
      description: "Browse project containers and their cross-surface threads.",
      area: "projects",
    },
    {
      id: "projects-citadels",
      label: "Citadels",
      description: "Govern personal, company, and project context with a Charter, Chambers, and Gatehouse rules.",
      area: "library",
      section: "citadel-overview",
    },
    {
      id: "projects-artifacts",
      label: "Artifacts",
      description: "Reopen generated outputs tied to project work.",
      area: "library",
      section: "artifacts",
    },
    {
      id: "projects-sessions",
      label: "Sessions",
      description: "Review retained project runs, timelines, and evidence.",
      area: "ops",
      section: "sessions",
    },
    {
      id: "projects-memory",
      label: "Memory",
      description: "Inspect reusable context and provenance before continuing work.",
      area: "library",
      section: "memory",
    },
  ],
  library: [
    {
      id: "library-citadel-overview",
      label: ROUTE_SECTION_LABELS.library["citadel-overview"],
      description: "See the active Citadel's Charter, Chambers, and Gatehouse settings.",
      area: "library",
      section: "citadel-overview",
    },
    {
      id: "library-citadel",
      label: ROUTE_SECTION_LABELS.library["citadel"],
      description: "Stage Personal or Company Citadels before connecting accounts or opening Gates.",
      area: "library",
      section: "citadel",
    },
    {
      id: "library-citadel-wards",
      label: ROUTE_SECTION_LABELS.library["citadel-wards"],
      description: "List, add, and test the Gatehouse rules (Wards). A deny rule always wins.",
      area: "library",
      section: "citadel-wards",
    },
    {
      id: "library-citadel-council",
      label: ROUTE_SECTION_LABELS.library["citadel-council"],
      description: "Choose which agents from the catalog sit on this Citadel's Council.",
      area: "library",
      section: "citadel-council",
    },
    {
      id: "library-citadel-vault",
      label: ROUTE_SECTION_LABELS.library["citadel-vault"],
      description: "Store, reveal, and delete sealed Citadel secrets.",
      area: "library",
      section: "citadel-vault",
    },
    {
      id: "library-citadel-blueprint",
      label: ROUTE_SECTION_LABELS.library["citadel-blueprint"],
      description: "Export a secret-free Blueprint, or validate and import one.",
      area: "library",
      section: "citadel-blueprint",
    },
    {
      id: "library-agents",
      label: ROUTE_SECTION_LABELS.library["agents"],
      description: "Reusable agent profiles and catalog controls.",
      area: "library",
      section: "agents",
    },
    {
      id: "library-skills",
      label: ROUTE_SECTION_LABELS.library["skills"],
      description: "Curate reusable behavior and activation posture.",
      area: "library",
      section: "skills",
    },
    {
      id: "library-capabilities",
      label: ROUTE_SECTION_LABELS.library["capabilities"],
      description: "See what skills, tools, providers, MCP entries, and channels are available or degraded.",
      area: "library",
      section: "capabilities",
    },
    {
      id: "library-memory",
      label: ROUTE_SECTION_LABELS.library["memory"],
      description: "Maintain durable memory items and lifecycle policy.",
      area: "library",
      section: "memory",
    },
    {
      id: "library-journey",
      label: ROUTE_SECTION_LABELS.library["journey"],
      description: "Inspect experimental read-only skill-learning and candidate evidence.",
      area: "library",
      section: "journey",
    },
    {
      id: "library-knowledge",
      label: ROUTE_SECTION_LABELS.library["knowledge"],
      description: "Knowledge ingest and retrieval as attachable context.",
      area: "library",
      section: "knowledge",
    },
    {
      id: "library-notes",
      label: ROUTE_SECTION_LABELS.library["notes"],
      description: "Business notes, checklists, reminders, and follow-ups.",
      area: "library",
      section: "notes",
    },
    {
      id: "library-communications",
      label: ROUTE_SECTION_LABELS.library["communications"],
      description: "Mail, calendar agenda, contacts, and approval-gated drafts.",
      area: "library",
      section: "communications",
    },
    {
      id: "library-files",
      label: ROUTE_SECTION_LABELS.library["files"],
      description: "Browse uploaded and workspace files outside Build.",
      area: "library",
      section: "files",
    },
    {
      id: "library-artifacts",
      label: ROUTE_SECTION_LABELS.library["artifacts"],
      description: "Reopen generated outputs from conversation, planning, and build work.",
      area: "library",
      section: "artifacts",
    },
    {
      id: "library-prompt-packs",
      label: ROUTE_SECTION_LABELS.library["prompt-packs"],
      description: "Author, export, benchmark, review prompt packs, and inspect model comparisons.",
      area: "library",
      section: "prompt-packs",
    },
    {
      id: "library-curator",
      label: ROUTE_SECTION_LABELS.library["curator"],
      description: "Review ranked skill health, immunity flags, and archive proposals.",
      area: "library",
      section: "curator",
    },
  ],
  ops: [
    {
      id: "ops-boards",
      label: ROUTE_SECTION_LABELS.ops["boards"],
      description: "Trusted saved layouts composed from canonical Ops summaries.",
      area: "ops",
      section: "boards",
    },
    {
      id: "ops-activity",
      label: ROUTE_SECTION_LABELS.ops["activity"],
      description: "Realtime event feed and retained operational signal.",
      area: "ops",
      section: "activity",
    },
    {
      id: "ops-sessions",
      label: ROUTE_SECTION_LABELS.ops["sessions"],
      description: "Session timelines, summaries, and operator evidence.",
      area: "ops",
      section: "sessions",
    },
    {
      id: "ops-schedules",
      label: ROUTE_SECTION_LABELS.ops["schedules"],
      description: "Cron posture and scheduler review queue.",
      area: "ops",
      section: "schedules",
    },
    {
      id: "ops-workers",
      label: ROUTE_SECTION_LABELS.ops["workers"],
      description: "Operator-visible remote-worker registry, assignments, events, and reconciliation.",
      area: "ops",
      section: "workers",
    },
    {
      id: "ops-improvement",
      label: ROUTE_SECTION_LABELS.ops["improvement"],
      description: "Replay and improvement loops.",
      area: "ops",
      section: "improvement",
    },
    {
      id: "ops-notifications",
      label: ROUTE_SECTION_LABELS.ops["notifications"],
      description: "Runtime issues, self-repair proposals, and operator follow-up.",
      area: "ops",
      section: "notifications",
    },
    {
      id: "ops-approvals",
      label: ROUTE_SECTION_LABELS.ops["approvals"],
      description: "Decision inbox, replay, and approval history.",
      area: "ops",
      section: "approvals",
    },
    {
      id: "ops-costs",
      label: ROUTE_SECTION_LABELS.ops["costs"],
      description: "Spend visibility without a dashboard maze.",
      area: "ops",
      section: "costs",
    },
    {
      id: "ops-quality",
      label: ROUTE_SECTION_LABELS.ops["quality"],
      description: "Eval proof, prompt-pack gates, and export posture.",
      area: "ops",
      section: "quality",
    },
    {
      id: "ops-runtime",
      label: ROUTE_SECTION_LABELS.ops["runtime"],
      description: "Gateway health, daemon posture, host vitals, and backups.",
      area: "ops",
      section: "runtime",
    },
    {
      id: "ops-diagnostics",
      label: ROUTE_SECTION_LABELS.ops["diagnostics"],
      description: "Durable, daemon, admin, docs, and readiness diagnostics.",
      area: "ops",
      section: "diagnostics",
    },
    {
      id: "ops-kanban",
      label: ROUTE_SECTION_LABELS.ops["kanban"],
      description: "Multi-agent board with distress signals, retry budgets, and bulk operator controls.",
      area: "ops",
      section: "kanban",
    },
  ],
  settings: [
    {
      id: "settings-general",
      label: ROUTE_SECTION_LABELS.settings["general"],
      description: "Base defaults every other surface inherits.",
      area: "settings",
      section: "general",
    },
    {
      id: "settings-onboarding",
      label: ROUTE_SECTION_LABELS.settings["onboarding"],
      description: "Try a safe demo or connect a model. Everything else is optional.",
      area: "settings",
      section: "onboarding",
    },
    {
      id: "settings-providers",
      label: ROUTE_SECTION_LABELS.settings["providers"],
      description: "Provider credentials, model catalogs, and active routing defaults.",
      area: "settings",
      section: "providers",
    },
    {
      id: "settings-personalities",
      label: ROUTE_SECTION_LABELS.settings["personalities"],
      description: "Conversation personality presets and the global conversation default.",
      area: "settings",
      section: "personalities",
    },
    {
      id: "settings-access",
      label: ROUTE_SECTION_LABELS.settings["access"],
      description: "Gateway sign-in, approved devices, and desktop and mobile access checks.",
      area: "settings",
      section: "access",
    },
    {
      id: "settings-permissions",
      label: ROUTE_SECTION_LABELS.settings["permissions"],
      description: "Permission profiles, active defaults, and local overrides.",
      area: "settings",
      section: "permissions",
    },
    {
      id: "settings-trust-policy",
      label: ROUTE_SECTION_LABELS.settings["trust-policy"],
      description: "Read-only view of trust for capabilities, tools, and sources.",
      area: "settings",
      section: "trust-policy",
    },
    {
      id: "settings-runtime",
      label: ROUTE_SECTION_LABELS.settings["runtime"],
      description: "Managed local runtime, Gateway process, and local voice.",
      area: "settings",
      section: "runtime",
    },
    {
      id: "settings-local-ai",
      label: ROUTE_SECTION_LABELS.settings["local-ai"],
      description: "llama.cpp setup, hardware readiness, model fit, local endpoints, and serve jobs.",
      area: "settings",
      section: "local-ai",
    },
    {
      id: "settings-workspaces",
      label: ROUTE_SECTION_LABELS.settings["workspaces"],
      description: "Citadel and workspace directory, workspace details, and design context.",
      area: "settings",
      section: "workspaces",
    },
    {
      id: "settings-integrations",
      label: ROUTE_SECTION_LABELS.settings["integrations"],
      description: "Connections, connectors, and integration overview.",
      area: "settings",
      section: "integrations",
    },
    {
      id: "settings-channels",
      label: ROUTE_SECTION_LABELS.settings["channels"],
      description: "Comms and delivery setup.",
      area: "settings",
      section: "channels",
    },
    {
      id: "settings-mcp",
      label: ROUTE_SECTION_LABELS.settings["mcp"],
      description: "MCP server status, templates, and transport configuration.",
      area: "settings",
      section: "mcp",
    },
    {
      id: "settings-web-search",
      label: ROUTE_SECTION_LABELS.settings["web-search"],
      description: "Firecrawl, search engines, and web-search API keys.",
      area: "settings",
      section: "web-search",
    },
    {
      id: "settings-tools",
      label: ROUTE_SECTION_LABELS.settings["tools"],
      description: "Low-level tool catalog and scoped allow/deny grants.",
      area: "settings",
      section: "tools",
    },
    {
      id: "settings-hooks",
      label: ROUTE_SECTION_LABELS.settings["hooks"],
      description: "Governed lifecycle hooks, delivery status, and history.",
      area: "settings",
      section: "hooks",
    },
    {
      id: "settings-budget",
      label: ROUTE_SECTION_LABELS.settings["budget"],
      description: "Choose a budget preference: Saver, Balanced, or Power. It is not a dollar limit.",
      area: "settings",
      section: "budget",
    },
    {
      id: "settings-workspace-capabilities",
      label: ROUTE_SECTION_LABELS.settings["workspace-capabilities"],
      description: "Choose which skills, integrations, and MCP servers this workspace uses.",
      area: "settings",
      section: "workspace-capabilities",
    },
    {
      id: "settings-citadel-capabilities",
      label: ROUTE_SECTION_LABELS.settings["citadel-capabilities"],
      description: "Govern which skills, integrations, and MCP servers exist in this Citadel.",
      area: "settings",
      section: "citadel-capabilities",
    },
  ],
};

const MODE_RAIL_THREAD: RailItem = {
  id: "chat-thread",
  label: "Conversation",
  description: "The active work thread with artifacts and attachments close at hand.",
  area: "chat",
  preserveThread: true,
};
const MODE_RAIL_APPROVALS: RailItem = {
  id: "chat-approvals",
  label: "Approvals",
  description: "Review pending tool or risk decisions.",
  area: "ops",
  section: "approvals",
  preserveThread: true,
};

/** Chat rail for the single conversation surface. Legacy mode values are ignored. */
export function buildModeRail(mode: ChatMode | undefined): RailItem[] {
  void mode;
  return [
    MODE_RAIL_THREAD,
    {
      id: "chat-artifacts",
      label: "Artifacts",
      description: "Jump to generated outputs from active work.",
      area: "library",
      section: "artifacts",
      preserveThread: true,
    },
    {
      id: "chat-memory",
      label: "Memory",
      description: "Inspect what the system knows and what it learned.",
      area: "library",
      section: "memory",
    },
    MODE_RAIL_APPROVALS,
  ];
}

export interface RailGroup {
  id: string;
  label: string;
  sections: NonNullable<AppRoute["section"]>[];
}

export function navigationRailItems(area: PrimaryArea): RailItem[] {
  if (area === "settings")
    return [
      ...RAIL_ITEMS.settings,
      ...RAIL_ITEMS.library.filter((item) => navigationAreaForRoute(item) === "settings"),
    ];
  return RAIL_ITEMS[area].filter((item) => navigationAreaForRoute(item) === area);
}

/** The rail group a section belongs to, or undefined when ungrouped. */
export function railGroupForSection(area: PrimaryArea, section: AppRoute["section"]): RailGroup | undefined {
  if (!section) {
    return undefined;
  }
  return RAIL_GROUPS[area]?.find((group) => group.sections.includes(section));
}

/**
 * Derives a page's breadcrumb kicker from the route registry so it always
 * matches the nav rail: "Area · [Group ·] Section", with the section name taken
 * verbatim from the rail item label. Grouped sections render three levels;
 * ungrouped sections render two. Falls back to the area label for root/unknown.
 */
export function routeKicker(route: AppRoute): string {
  const normalized = normalizeAppRoute(route);
  const navigationArea = navigationAreaForRoute(normalized);
  const areaLabel = AREA_META[navigationArea].label;
  const section = normalized.section;
  if (!section) {
    return areaLabel;
  }
  const sectionLabel = RAIL_ITEMS[normalized.area]?.find((item) => item.section === section)?.label;
  if (!sectionLabel) {
    return areaLabel;
  }
  const group = railGroupForSection(navigationArea, section);
  // Collapse to "Area · Section" when the section's name equals its group's (e.g.
  // the Knowledge section inside the Knowledge group) to avoid a redundant
  // "Library · Knowledge · Knowledge".
  if (group && group.label.toLowerCase() !== sectionLabel.toLowerCase()) {
    return `${areaLabel} · ${group.label} · ${sectionLabel}`;
  }
  return `${areaLabel} · ${sectionLabel}`;
}

export function getRouteLabel(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  if (next.area === "chat") {
    return AREA_META.chat.label;
  }
  if (next.area === "projects") {
    return AREA_META[next.area].label;
  }

  const item = RAIL_ITEMS[next.area].find((entry) => entry.section === next.section);
  return item?.label ?? AREA_META[next.area].label;
}

export function getRouteDescription(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  if (next.area === "chat") {
    return AREA_META.chat.description;
  }
  if (next.area === "projects") {
    return AREA_META[next.area].description;
  }
  return (
    RAIL_ITEMS[next.area].find((entry) => entry.section === next.section)?.description ??
    AREA_META[next.area].description
  );
}

/** Normalized public release status without loading verbose scope metadata. */
export function getRouteReleaseStatus(route: AppRoute): ReleaseSurfaceStatus {
  return readRouteReleaseStatus(getRouteReleaseKey(normalizeAppRoute(route))) ?? "hide";
}

/**
 * True when a route is flagged `experimental` in ROUTE_RELEASE_SCOPE. Most
 * experimental surfaces stay out of the primary navigation rails while
 * remaining reachable via direct URL, the command palette, and their
 * "Experimental" stage badge.
 */
export function isExperimentalRoute(route: { area: PrimaryArea; section?: AppRoute["section"] }): boolean {
  return readRouteReleaseStatus(getRouteReleaseKey(route)) === "experimental";
}

/**
 * Primary-rail visibility is release-aware, with a narrow discoverability
 * exception for the personality catalog. Personalities remain explicitly
 * experimental on-surface, but hiding the only catalog leaves first-time users
 * with no way to inspect what is available before choosing a preset.
 */
export function isPrimaryRailRoute(route: { area: PrimaryArea; section?: AppRoute["section"] }): boolean {
  if (isHiddenRoute(route)) {
    return false;
  }
  if (!isExperimentalRoute(route)) {
    return true;
  }
  return route.area === "settings" && route.section === "personalities";
}

/**
 * True when a route is intentionally direct-URL-only. Hidden routes remain
 * routable for compatibility and verification, but must not leak into primary
 * navigation or command-palette discovery.
 */
export function isHiddenRoute(route: { area: PrimaryArea; section?: AppRoute["section"] }): boolean {
  return (readRouteReleaseStatus(getRouteReleaseKey(route)) ?? "hide") === "hide";
}

export function isReleaseSurfaceReady(status: ReleaseSurfaceStatus): boolean {
  return status === "ship";
}

export function buildNavigationTarget(current: AppRoute, item: RailItem): AppRoute {
  const preserveThread = item.preserveThread ?? false;
  return normalizeAppRoute({
    area: item.area,
    section: item.section,
    mode: item.area === "chat" ? current.mode : undefined,
    sessionId: preserveThread ? current.sessionId : undefined,
    turnId: preserveThread ? current.turnId : undefined,
    runId: preserveThread ? current.runId : undefined,
    artifactId: preserveThread ? current.artifactId : undefined,
    approvalId: preserveThread ? current.approvalId : undefined,
    projectId: preserveThread || item.area === "projects" ? current.projectId : undefined,
    theme: current.theme,
    view:
      item.area === "library" && item.section === "agents" && current.area === "library" && current.view === "catalog"
        ? current.view
        : undefined,
  });
}

export function isRailItemActive(route: AppRoute, item: RailItem): boolean {
  const next = normalizeAppRoute(route);
  if (item.area !== next.area) {
    return false;
  }
  if (!item.section) {
    return true;
  }
  return item.section === next.section;
}
