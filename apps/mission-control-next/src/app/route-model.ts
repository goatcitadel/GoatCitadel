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
  | "addons"
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

/**
 * Citadel page names, plain name first. One map for the Settings tabs, the nav rail, page headings and document
 * titles. Slugs and URLs keep their Citadel names.
 */
export const CITADEL_PAGE_LABELS = {
  "citadel-overview": "Citadel overview",
  citadel: "Guided setup · Mason",
  "citadel-wards": "Rules · Wards",
  "citadel-council": "Agents · Council",
  "citadel-vault": "Secrets · Vault",
  "citadel-blueprint": "Export/import · Blueprint",
} as const satisfies Partial<Record<LibrarySection, string>>;

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
      label: CITADEL_PAGE_LABELS["citadel-overview"],
      description: "See the active Citadel's Charter, Chambers, and Gatehouse settings.",
      area: "library",
      section: "citadel-overview",
    },
    {
      id: "library-citadel",
      label: CITADEL_PAGE_LABELS.citadel,
      description: "Stage Personal or Company Citadels before connecting accounts or opening Gates.",
      area: "library",
      section: "citadel",
    },
    {
      id: "library-citadel-wards",
      label: CITADEL_PAGE_LABELS["citadel-wards"],
      description: "List, add, and test the Gatehouse rules (Wards). A deny rule always wins.",
      area: "library",
      section: "citadel-wards",
    },
    {
      id: "library-citadel-council",
      label: CITADEL_PAGE_LABELS["citadel-council"],
      description: "Choose which agents from the catalog sit on this Citadel's Council.",
      area: "library",
      section: "citadel-council",
    },
    {
      id: "library-citadel-vault",
      label: CITADEL_PAGE_LABELS["citadel-vault"],
      description: "Store, reveal, and delete sealed Citadel secrets.",
      area: "library",
      section: "citadel-vault",
    },
    {
      id: "library-citadel-blueprint",
      label: CITADEL_PAGE_LABELS["citadel-blueprint"],
      description: "Export a secret-free Blueprint, or validate and import one.",
      area: "library",
      section: "citadel-blueprint",
    },
    {
      id: "library-agents",
      label: "Agents",
      description: "Reusable agent profiles and catalog controls.",
      area: "library",
      section: "agents",
    },
    {
      id: "library-skills",
      label: "Skills",
      description: "Curate reusable behavior and activation posture.",
      area: "library",
      section: "skills",
    },
    {
      id: "library-capabilities",
      label: "Capabilities",
      description: "See what skills, tools, providers, MCP entries, and channels are available or degraded.",
      area: "library",
      section: "capabilities",
    },
    {
      id: "library-memory",
      label: "Memory",
      description: "Maintain durable memory items and lifecycle policy.",
      area: "library",
      section: "memory",
    },
    {
      id: "library-journey",
      label: "Journey",
      description: "Inspect experimental read-only skill-learning and candidate evidence.",
      area: "library",
      section: "journey",
    },
    {
      id: "library-knowledge",
      label: "Knowledge",
      description: "Knowledge ingest and retrieval as attachable context.",
      area: "library",
      section: "knowledge",
    },
    {
      id: "library-notes",
      label: "Notes",
      description: "Business notes, checklists, reminders, and follow-ups.",
      area: "library",
      section: "notes",
    },
    {
      id: "library-communications",
      label: "Mail",
      description: "Mail, calendar agenda, contacts, and approval-gated drafts.",
      area: "library",
      section: "communications",
    },
    {
      id: "library-files",
      label: "Files",
      description: "Browse uploaded and workspace files outside Build.",
      area: "library",
      section: "files",
    },
    {
      id: "library-artifacts",
      label: "Artifacts",
      description: "Reopen generated outputs from conversation, planning, and build work.",
      area: "library",
      section: "artifacts",
    },
    {
      id: "library-prompt-packs",
      label: "Prompt packs",
      description: "Author, export, benchmark, review prompt packs, and inspect model comparisons.",
      area: "library",
      section: "prompt-packs",
    },
    {
      id: "library-curator",
      label: "Skill curator",
      description: "Review ranked skill health, immunity flags, and archive proposals.",
      area: "library",
      section: "curator",
    },
  ],
  ops: [
    {
      id: "ops-boards",
      label: "Saved boards",
      description: "Trusted saved layouts composed from canonical Ops summaries.",
      area: "ops",
      section: "boards",
    },
    {
      id: "ops-activity",
      label: "Activity",
      description: "Realtime event feed and retained operational signal.",
      area: "ops",
      section: "activity",
    },
    {
      id: "ops-sessions",
      label: "Sessions",
      description: "Session timelines, summaries, and operator evidence.",
      area: "ops",
      section: "sessions",
    },
    {
      id: "ops-schedules",
      label: "Schedules",
      description: "Cron posture and scheduler review queue.",
      area: "ops",
      section: "schedules",
    },
    {
      id: "ops-workers",
      label: "Remote workers",
      description: "Operator-visible remote-worker registry, assignments, events, and reconciliation.",
      area: "ops",
      section: "workers",
    },
    {
      id: "ops-improvement",
      label: "Improvement",
      description: "Replay and improvement loops.",
      area: "ops",
      section: "improvement",
    },
    {
      id: "ops-notifications",
      label: "Notifications",
      description: "Runtime issues, self-repair proposals, and operator follow-up.",
      area: "ops",
      section: "notifications",
    },
    {
      id: "ops-approvals",
      label: "Approvals",
      description: "Decision inbox, replay, and approval history.",
      area: "ops",
      section: "approvals",
    },
    {
      id: "ops-costs",
      label: "Costs",
      description: "Spend visibility without a dashboard maze.",
      area: "ops",
      section: "costs",
    },
    {
      id: "ops-quality",
      label: "Quality",
      description: "Eval proof, prompt-pack gates, and export posture.",
      area: "ops",
      section: "quality",
    },
    {
      id: "ops-runtime",
      label: "Runtime",
      description: "Gateway health, daemon posture, host vitals, and backups.",
      area: "ops",
      section: "runtime",
    },
    {
      id: "ops-diagnostics",
      label: "Diagnostics",
      description: "Durable, daemon, admin, docs, and readiness diagnostics.",
      area: "ops",
      section: "diagnostics",
    },
    {
      id: "ops-kanban",
      label: "Kanban",
      description: "Multi-agent board with distress signals, retry budgets, and bulk operator controls.",
      area: "ops",
      section: "kanban",
    },
  ],
  settings: [
    {
      id: "settings-general",
      label: "General",
      description: "Base defaults every other surface inherits.",
      area: "settings",
      section: "general",
    },
    {
      id: "settings-onboarding",
      label: "Get started",
      description: "Try a safe demo or connect a model. Everything else is optional.",
      area: "settings",
      section: "onboarding",
    },
    {
      id: "settings-providers",
      label: "Providers & models",
      description: "Provider credentials, model catalogs, and active routing defaults.",
      area: "settings",
      section: "providers",
    },
    {
      id: "settings-personalities",
      label: "Personalities",
      description: "Conversation personality presets and the global conversation default.",
      area: "settings",
      section: "personalities",
    },
    {
      id: "settings-access",
      label: "Access & devices",
      description: "Gateway sign-in, approved devices, and desktop and mobile access checks.",
      area: "settings",
      section: "access",
    },
    {
      id: "settings-permissions",
      label: "Permissions",
      description: "Permission profiles, active defaults, and local overrides.",
      area: "settings",
      section: "permissions",
    },
    {
      id: "settings-trust-policy",
      label: "Trust & policy",
      description: "Read-only view of trust for capabilities, tools, and sources.",
      area: "settings",
      section: "trust-policy",
    },
    {
      id: "settings-runtime",
      label: "Runtime configuration",
      description: "Managed local runtime, Gateway process, and local voice.",
      area: "settings",
      section: "runtime",
    },
    {
      id: "settings-local-ai",
      label: "Local AI",
      description: "llama.cpp setup, hardware readiness, model fit, local endpoints, and serve jobs.",
      area: "settings",
      section: "local-ai",
    },
    {
      id: "settings-workspaces",
      label: "Workspaces",
      description: "Citadel and workspace directory, workspace details, and design context.",
      area: "settings",
      section: "workspaces",
    },
    {
      id: "settings-integrations",
      label: "Integrations",
      description: "Connections, connectors, and integration overview.",
      area: "settings",
      section: "integrations",
    },
    {
      id: "settings-channels",
      label: "Channels",
      description: "Comms and delivery setup.",
      area: "settings",
      section: "channels",
    },
    {
      id: "settings-mcp",
      label: "MCP servers",
      description: "MCP server status, templates, and transport configuration.",
      area: "settings",
      section: "mcp",
    },
    {
      id: "settings-web-search",
      label: "Web & Search",
      description: "Firecrawl, search engines, and web-search API keys.",
      area: "settings",
      section: "web-search",
    },
    {
      id: "settings-tools",
      label: "Tools",
      description: "Low-level tool catalog and scoped allow/deny grants.",
      area: "settings",
      section: "tools",
    },
    {
      id: "settings-hooks",
      label: "Hooks",
      description: "Governed lifecycle hooks, delivery status, and history.",
      area: "settings",
      section: "hooks",
    },
    {
      id: "settings-addons",
      label: "Add-ons & packs",
      description: "Installed extensions and workspace add-ons.",
      area: "settings",
      section: "addons",
    },
    {
      id: "settings-budget",
      label: "Budgets",
      description: "Choose a budget preference: Saver, Balanced, or Power. It is not a dollar limit.",
      area: "settings",
      section: "budget",
    },
    {
      id: "settings-workspace-capabilities",
      label: "Workspace capabilities",
      description: "Choose which skills, plugins, and MCP servers this workspace uses.",
      area: "settings",
      section: "workspace-capabilities",
    },
    {
      id: "settings-citadel-capabilities",
      label: "Citadel capabilities",
      description: "Govern which skills, plugins, and MCP servers exist in this Citadel.",
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

/**
 * Single source of truth for rail grouping. Drives both the nav rail
 * (buildRailSections) and breadcrumb derivation (routeKicker), so the two can
 * never disagree. Areas absent here render as one ungrouped rail. Sections
 * intentionally omitted from every group stay reachable via deep link but are
 * not surfaced in grouped navigation. Release-bearing trust/setup settings stay
 * grouped so operators can find them without command search.
 */
export const RAIL_GROUPS: Partial<Record<PrimaryArea, RailGroup[]>> = {
  settings: [
    { id: "settings-general", label: "General", sections: ["general", "personalities"] },
    { id: "settings-models", label: "Models", sections: ["onboarding", "providers", "local-ai"] },
    {
      id: "settings-connections",
      label: "Connections",
      sections: ["channels", "integrations", "mcp", "web-search", "addons"],
    },
    { id: "settings-safety", label: "Safety", sections: ["permissions", "tools", "trust-policy", "hooks", "budget"] },
    {
      id: "settings-citadel",
      label: "Citadel",
      sections: [
        "citadel-overview",
        "workspaces",
        "citadel",
        "citadel-wards",
        "citadel-council",
        "citadel-vault",
        "citadel-blueprint",
        "workspace-capabilities",
        "citadel-capabilities",
      ],
    },
    { id: "settings-access", label: "Access", sections: ["access"] },
    { id: "settings-advanced", label: "Advanced", sections: ["runtime"] },
  ],
  library: [
    { id: "library-agents", label: "Agents", sections: ["agents"] },
    {
      id: "library-skills",
      label: "Skills and tools",
      sections: ["skills", "capabilities", "prompt-packs", "curator", "journey"],
    },
    { id: "library-knowledge", label: "Knowledge", sections: ["knowledge", "memory", "notes"] },
    { id: "library-files", label: "Files", sections: ["files", "artifacts"] },
    { id: "library-mail", label: "Mail", sections: ["communications"] },
  ],
  ops: [
    { id: "ops-approvals", label: "Approvals", sections: ["approvals"] },
    { id: "ops-activity", label: "Activity", sections: ["activity", "sessions", "notifications"] },
    { id: "ops-work-board", label: "Work board", sections: ["kanban", "boards", "schedules"] },
    { id: "ops-costs", label: "Costs", sections: ["costs"] },
    { id: "ops-health", label: "Health", sections: ["runtime", "diagnostics", "workers"] },
    { id: "ops-quality", label: "Quality", sections: ["quality", "improvement"] },
  ],
};

/** Navigation ownership can change while old public paths remain canonical. */
export function navigationAreaForRoute(route: Pick<AppRoute, "area" | "section">): PrimaryArea {
  return route.area === "library" && route.section?.startsWith("citadel") ? "settings" : route.area;
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

export function parseAppRoute(input: string | URL): AppRoute {
  const url = typeof input === "string" ? new URL(input, "http://goatcitadel.local") : input;
  const rawParts = url.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = rawParts.map((part) => part.toLowerCase());
  const params = url.searchParams;
  const area = (parts[0] as PrimaryArea | undefined) ?? "chat";
  const normalizedArea = isPrimaryArea(area) ? area : "chat";
  const routeArea = normalizedArea;
  const routeSection = area === "settings" && parts[1] === "safety" ? "permissions" : parts[1];
  const rawMode = readParam(params, "mode");
  const parsedMode = rawMode === "chat" ? "chat" : undefined;
  const nextRoute: AppRoute = normalizeAppRoute({
    area: routeArea,
    channelPlan: readParam(params, "channelPlan"),
    channelDraft: readParam(params, "channelDraft"),
    channelWorkspace: readParam(params, "channelWorkspace"),
    channelConnection: readParam(params, "channelConnection"),
    channelRevision: /^[1-9][0-9]*$/.test(params.get("channelRevision") ?? "")
      ? Number(params.get("channelRevision"))
      : undefined,
    section: routeArea === "projects" ? undefined : (routeSection as AppRoute["section"]),
    mode: parsedMode,
    sessionId: readParam(params, "sessionId"),
    turnId: readParam(params, "turnId"),
    runId: readParam(params, "runId"),
    artifactId: readParam(params, "artifactId"),
    approvalId: readParam(params, "approvalId"),
    projectId:
      area === "projects"
        ? safeDecodePathSegment(rawParts[1]) || readParam(params, "projectId")
        : readParam(params, "projectId"),
    theme: readParam(params, "theme"),
    view: readParam(params, "view"),
    category: readParam(params, "category"),
    evidence: readParam(params, "evidence"),
    includeGlobal: readParam(params, "includeGlobal"),
    eventId: readParam(params, "eventId"),
  });
  return nextRoute;
}

export function buildAppHref(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  const params = new URLSearchParams();
  writeParam(params, "channelPlan", next.channelPlan);
  writeParam(params, "channelDraft", next.channelDraft);
  writeParam(params, "channelWorkspace", next.channelWorkspace);
  writeParam(params, "channelConnection", next.channelConnection);
  if (next.channelRevision) params.set("channelRevision", String(next.channelRevision));
  writeParam(params, "sessionId", next.sessionId);
  writeParam(params, "turnId", next.turnId);
  writeParam(params, "runId", next.runId);
  writeParam(params, "artifactId", next.artifactId);
  writeParam(params, "approvalId", next.approvalId);
  if (next.area !== "projects") {
    writeParam(params, "projectId", next.projectId);
  }
  writeParam(params, "view", next.view);
  if (next.area === "library" && next.section === "journey") {
    writeParam(params, "category", next.category);
    writeParam(params, "evidence", next.evidence);
    writeParam(params, "includeGlobal", next.includeGlobal);
    writeParam(params, "eventId", next.eventId);
  }
  // theme is a global localStorage preference, not per-URL state (see 819ef761f); do not serialize it into hrefs.
  // Chat is the only operator conversation surface; legacy mode params are not serialized.

  const path =
    next.area === "chat"
      ? "/chat"
      : next.area === "projects"
        ? `/projects${next.projectId ? `/${encodeURIComponent(next.projectId)}` : ""}`
        : `/${next.area}/${next.section ?? ""}`;

  const query = params.toString();
  return query ? `${path}?${query}` : path;
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

function isPrimaryArea(value: string | undefined): value is PrimaryArea {
  return (
    value === "chat" ||
    value === "cowork" ||
    value === "code" ||
    value === "projects" ||
    value === "library" ||
    value === "ops" ||
    value === "settings"
  );
}

function readParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value : undefined;
}

function safeDecodePathSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function writeParam(params: URLSearchParams, key: string, value?: string): void {
  if (value?.trim()) {
    params.set(key, value.trim());
  }
}
