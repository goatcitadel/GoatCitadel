export type PrimaryArea = "chat" | "cowork" | "code" | "projects" | "library" | "ops" | "settings";
export type CoworkSection = "workspace" | "tasks" | "board";
export type LibrarySection = "agents" | "skills" | "memory" | "knowledge" | "files" | "artifacts" | "prompt-packs";
export type OpsSection =
  | "activity"
  | "sessions"
  | "schedules"
  | "improvement"
  | "notifications"
  | "approvals"
  | "costs"
  | "runtime"
  | "quality"
  | "diagnostics";
export type SettingsSection =
  | "general"
  | "providers"
  | "personalities"
  | "access"
  | "budget"
  | "onboarding"
  | "runtime"
  | "workspaces"
  | "addons"
  | "integrations"
  | "channels"
  | "mcp"
  | "tools";

export interface AppRoute {
  area: PrimaryArea;
  section?: CoworkSection | LibrarySection | OpsSection | SettingsSection;
  view?: string;
  sessionId?: string;
  turnId?: string;
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

export const AREA_META: Record<PrimaryArea, AreaMeta> = {
  chat: {
    id: "chat",
    label: "Chat",
    kicker: "Conversation",
    description: "Conversation, search, attachments, and quick help.",
  },
  cowork: {
    id: "cowork",
    label: "Cowork",
    kicker: "Orchestration",
    description: "Delegation, tasks, checkpoints, and shared execution.",
  },
  code: {
    id: "code",
    label: "Code",
    kicker: "Implementation",
    description: "Workbench, files, diffs, runs, and code-mode control.",
  },
  projects: {
    id: "projects",
    label: "Projects",
    kicker: "Containers",
    description: "Project containers with Chat, Cowork, and Code threads grouped together.",
  },
  library: {
    id: "library",
    label: "Library",
    kicker: "Knowledge",
    description: "Agents, skills, memory, files, and prompt packs.",
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
      label: "Thread",
      description: "Conversation with artifacts and attachments close at hand.",
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
  ],
  library: [
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
      id: "library-memory",
      label: "Memory",
      description: "Maintain durable memory items and lifecycle policy.",
      area: "library",
      section: "memory",
    },
    {
      id: "library-knowledge",
      label: "Knowledge",
      description: "Knowledge ingest and retrieval as attachable context.",
      area: "library",
      section: "knowledge",
    },
    {
      id: "library-files",
      label: "Files",
      description: "Browse uploaded and workspace files outside Code.",
      area: "library",
      section: "files",
    },
    {
      id: "library-artifacts",
      label: "Artifacts",
      description: "Reopen generated outputs from Chat, Cowork, and Code.",
      area: "library",
      section: "artifacts",
    },
    {
      id: "library-prompt-packs",
      label: "Prompt Packs",
      description: "Author, export, benchmark, and review prompt packs.",
      area: "library",
      section: "prompt-packs",
    },
  ],
  ops: [
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
      id: "ops-runtime",
      label: "Runtime",
      description: "Gateway health, daemon posture, host vitals, and backups.",
      area: "ops",
      section: "runtime",
    },
    {
      id: "ops-diagnostics",
      label: "Diagnostics",
      description: "Durable, daemon, admin, docs, and verification families.",
      area: "ops",
      section: "diagnostics",
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
      label: "Onboarding",
      description: "First-run readiness, defaults, and setup checkpoints.",
      area: "settings",
      section: "onboarding",
    },
    {
      id: "settings-providers",
      label: "Providers",
      description: "Model and provider defaults.",
      area: "settings",
      section: "providers",
    },
    {
      id: "settings-personalities",
      label: "Personalities",
      description: "Chat personality presets and the global Chat default.",
      area: "settings",
      section: "personalities",
    },
    {
      id: "settings-access",
      label: "Access",
      description: "Auth posture, secrets, and access boundaries.",
      area: "settings",
      section: "access",
    },
    {
      id: "settings-runtime",
      label: "Runtime",
      description: "Mesh, local runtimes, backups, and serving posture.",
      area: "settings",
      section: "runtime",
    },
    {
      id: "settings-workspaces",
      label: "Workspaces",
      description: "Workspace context, guidance, and extension posture.",
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
      label: "MCP",
      description: "MCP server posture, templates, and transport configuration.",
      area: "settings",
      section: "mcp",
    },
    {
      id: "settings-tools",
      label: "Tools",
      description: "Tool grants and catalog policy.",
      area: "settings",
      section: "tools",
    },
    {
      id: "settings-addons",
      label: "Add-ons",
      description: "Installed extensions and workspace add-on posture.",
      area: "settings",
      section: "addons",
    },
  ],
};

export function normalizeAppRoute(route: AppRoute): AppRoute {
  const base = {
    area: route.area,
    sessionId: route.sessionId,
    turnId: route.turnId,
    artifactId: route.artifactId,
    approvalId: route.approvalId,
    projectId: route.projectId,
    theme: route.theme,
    view: route.view,
  };

  if (route.area === "cowork") {
    return {
      ...base,
      area: "cowork",
      section: (route.section as CoworkSection | undefined) ?? "workspace",
    };
  }
  if (route.area === "library") {
    return {
      ...base,
      area: "library",
      section: (route.section as LibrarySection | undefined) ?? "agents",
    };
  }
  if (route.area === "ops") {
    return {
      ...base,
      area: "ops",
      section: (route.section as OpsSection | undefined) ?? "activity",
    };
  }
  if (route.area === "settings") {
    return {
      ...base,
      area: "settings",
      section: (route.section as SettingsSection | undefined) ?? "general",
    };
  }
  return {
    ...base,
    area: route.area,
  };
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
  const nextRoute: AppRoute = normalizeAppRoute({
    area: isPrimaryArea(area) ? area : "chat",
    section: area === "projects" ? undefined : (parts[1] as AppRoute["section"]),
    sessionId: readParam(params, "sessionId"),
    turnId: readParam(params, "turnId"),
    artifactId: readParam(params, "artifactId"),
    approvalId: readParam(params, "approvalId"),
    projectId:
      area === "projects"
        ? safeDecodePathSegment(rawParts[1]) || readParam(params, "projectId")
        : readParam(params, "projectId"),
    theme: readParam(params, "theme"),
    view: readParam(params, "view"),
  });
  return nextRoute;
}

export function buildAppHref(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  const params = new URLSearchParams();
  writeParam(params, "sessionId", next.sessionId);
  writeParam(params, "turnId", next.turnId);
  writeParam(params, "artifactId", next.artifactId);
  writeParam(params, "approvalId", next.approvalId);
  if (next.area !== "projects") {
    writeParam(params, "projectId", next.projectId);
  }
  writeParam(params, "view", next.view);
  writeParam(params, "theme", next.theme);

  const path =
    next.area === "chat" || next.area === "code"
      ? `/${next.area}`
      : next.area === "projects"
        ? `/projects${next.projectId ? `/${encodeURIComponent(next.projectId)}` : ""}`
        : next.area === "cowork" && (!next.section || next.section === "workspace")
          ? "/cowork"
          : `/${next.area}/${next.section ?? ""}`;

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function getRouteLabel(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  if (next.area === "chat" || next.area === "code" || next.area === "projects") {
    return AREA_META[next.area].label;
  }
  if (next.area === "cowork") {
    return next.section === "tasks" ? "Task Board" : next.section === "board" ? "Agent Board" : "Cowork";
  }

  const item = RAIL_ITEMS[next.area].find((entry) => entry.section === next.section);
  return item?.label ?? AREA_META[next.area].label;
}

export function getRouteDescription(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  if (next.area === "chat" || next.area === "code" || next.area === "projects") {
    return AREA_META[next.area].description;
  }
  if (next.area === "cowork") {
    if (next.section === "tasks") {
      return "Tasks, activities, deliverables, and blockers stay inside the Cowork lane instead of floating as a separate product.";
    }
    if (next.section === "board") {
      return "The board exposes live agent posture without forcing agent catalog chrome over active work.";
    }
    return AREA_META.cowork.description;
  }
  return (
    RAIL_ITEMS[next.area].find((entry) => entry.section === next.section)?.description ??
    AREA_META[next.area].description
  );
}

export function buildNavigationTarget(current: AppRoute, item: RailItem): AppRoute {
  const preserveThread = item.preserveThread ?? false;
  return normalizeAppRoute({
    area: item.area,
    section: item.section,
    sessionId: preserveThread ? current.sessionId : undefined,
    turnId: preserveThread ? current.turnId : undefined,
    artifactId: preserveThread ? current.artifactId : undefined,
    approvalId: preserveThread ? current.approvalId : undefined,
    projectId: item.area === "projects" ? current.projectId : undefined,
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
