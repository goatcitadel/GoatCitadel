export type Space = "operate" | "observe" | "configure";
export type WorkSurface = "chat" | "cowork" | "code";
export type OperatePage = "surface" | "tasks" | "approvals";
export type ObservePage = "activity" | "sessions" | "artifacts" | "costs" | "system" | "quality";
export type ConfigurePage = "settings" | "integrations" | "tools" | "agents";
export type SpacePage = OperatePage | ObservePage | ConfigurePage;
export type VisibleWorkPage = WorkSurface | "tasks" | "approvals";
export type VisibleObservePage = "timeline" | "health" | "artifacts" | "quality";
export type VisibleTunePage = "general" | "runtime" | "workspaces" | "integrations" | "tools" | "agents";
export type VisiblePage = VisibleWorkPage | VisibleObservePage | VisibleTunePage;

export type ActivityTab = "activity" | "scheduler" | "improvement";
export type ArtifactsTab = "memory" | "files";
export type SettingsTab =
  | "general"
  | "providers"
  | "access"
  | "budget"
  | "runtime"
  | "workspaces"
  | "addons"
  | "onboarding";
export type IntegrationsTab = "overview" | "channels" | "mcp";
export type AgentsTab = "overview" | "herd-live" | "herd-lab" | "skills";

export type NestedHostTab = ActivityTab | ArtifactsTab | SettingsTab | IntegrationsTab | AgentsTab;

export interface ResolvedRoute {
  space: Space;
  page: SpacePage;
  surface?: WorkSurface;
  tab?: NestedHostTab;
  sessionId?: string;
  turnId?: string;
  approvalId?: string;
}

interface RouteInfo {
  space: Space;
  page: SpacePage;
  label: string;
  description: string;
}

export const SPACE_META: Record<Space, { label: string; description: string }> = {
  operate: {
    label: "Work",
    description: "Chat, Cowork, Code, and the decisions around active work.",
  },
  observe: {
    label: "Watch",
    description: "What the system is doing and how it is behaving.",
  },
  configure: {
    label: "Setup",
    description: "Models, runtime, governance, and integrations.",
  },
};

export const PAGE_META: Record<SpacePage, RouteInfo> = {
  surface: {
    space: "operate",
    page: "surface",
    label: "Work",
    description: "Fast path into chat, orchestration, and implementation.",
  },
  tasks: {
    space: "operate",
    page: "tasks",
    label: "Tasks",
    description: "Queue for open work, blockers, and linked sessions.",
  },
  approvals: {
    space: "operate",
    page: "approvals",
    label: "Approvals",
    description: "Persisted approval history, audit context, and recovery.",
  },
  activity: {
    space: "observe",
    page: "activity",
    label: "Activity",
    description: "Realtime events, scheduler state, and improvement signals.",
  },
  sessions: {
    space: "observe",
    page: "sessions",
    label: "Sessions",
    description: "Recent runs, timelines, and outcomes.",
  },
  artifacts: {
    space: "observe",
    page: "artifacts",
    label: "Artifacts",
    description: "Browse memory and files from one place.",
  },
  costs: {
    space: "observe",
    page: "costs",
    label: "Costs",
    description: "Spend and usage posture.",
  },
  system: {
    space: "observe",
    page: "system",
    label: "System",
    description: "Machine and runtime health.",
  },
  quality: {
    space: "observe",
    page: "quality",
    label: "Quality",
    description: "Prompt testing, benchmarks, and regressions.",
  },
  settings: {
    space: "configure",
    page: "settings",
    label: "Settings",
    description: "Defaults, runtime, workspaces, and onboarding.",
  },
  integrations: {
    space: "configure",
    page: "integrations",
    label: "Integrations",
    description: "Connected services and MCP servers.",
  },
  tools: {
    space: "configure",
    page: "tools",
    label: "Tools",
    description: "Tool access, grants, and permissions.",
  },
  agents: {
    space: "configure",
    page: "agents",
    label: "Agents",
    description: "Roster, herd views, and skills.",
  },
};

export const SPACE_PAGES: Record<Space, Array<{ page: SpacePage; label: string }>> = {
  operate: [
    { page: "surface", label: "Work" },
    { page: "tasks", label: "Tasks" },
    { page: "approvals", label: "Approvals" },
  ],
  observe: [
    { page: "activity", label: "Activity" },
    { page: "sessions", label: "Sessions" },
    { page: "artifacts", label: "Artifacts" },
    { page: "costs", label: "Costs" },
    { page: "system", label: "System" },
    { page: "quality", label: "Quality" },
  ],
  configure: [
    { page: "settings", label: "Settings" },
    { page: "integrations", label: "Integrations" },
    { page: "tools", label: "Tools" },
    { page: "agents", label: "Agents" },
  ],
};

export const VISIBLE_SPACE_PAGES: Record<Space, Array<{ page: VisiblePage; label: string }>> = {
  operate: [
    { page: "chat", label: "Chat" },
    { page: "cowork", label: "Cowork" },
    { page: "code", label: "Code" },
    { page: "tasks", label: "Tasks" },
    { page: "approvals", label: "Approvals" },
  ],
  observe: [
    { page: "timeline", label: "Timeline" },
    { page: "health", label: "Health" },
    { page: "artifacts", label: "Artifacts" },
    { page: "quality", label: "Quality" },
  ],
  configure: [
    { page: "general", label: "General" },
    { page: "runtime", label: "Runtime" },
    { page: "workspaces", label: "Workspaces" },
    { page: "integrations", label: "Integrations" },
    { page: "tools", label: "Tools" },
    { page: "agents", label: "Agents" },
  ],
};

export const DEFAULT_ROUTE: ResolvedRoute = {
  space: "operate",
  page: "surface",
  surface: "chat",
};

const LEGACY_TAB_REDIRECTS: Record<string, ResolvedRoute> = {
  dashboard: { space: "operate", page: "surface", surface: "chat" },
  chat: { space: "operate", page: "surface", surface: "chat" },
  assembly: { space: "operate", page: "surface", surface: "cowork" },
  tasks: { space: "operate", page: "tasks" },
  approvals: { space: "operate", page: "approvals" },
  activity: { space: "observe", page: "activity", tab: "activity" },
  cron: { space: "observe", page: "activity", tab: "scheduler" },
  improvement: { space: "observe", page: "activity", tab: "improvement" },
  sessions: { space: "observe", page: "sessions" },
  memory: { space: "observe", page: "artifacts", tab: "memory" },
  files: { space: "observe", page: "artifacts", tab: "files" },
  costs: { space: "observe", page: "costs" },
  system: { space: "observe", page: "system" },
  promptLab: { space: "observe", page: "quality" },
  settings: { space: "configure", page: "settings", tab: "general" },
  workspaces: { space: "configure", page: "settings", tab: "workspaces" },
  addons: { space: "configure", page: "settings", tab: "addons" },
  onboarding: { space: "configure", page: "settings", tab: "onboarding" },
  mesh: { space: "configure", page: "settings", tab: "runtime" },
  npu: { space: "configure", page: "settings", tab: "runtime" },
  integrations: { space: "configure", page: "integrations", tab: "overview" },
  channels: { space: "configure", page: "integrations", tab: "channels" },
  mcp: { space: "configure", page: "integrations", tab: "mcp" },
  tools: { space: "configure", page: "tools" },
  agents: { space: "configure", page: "agents", tab: "overview" },
  skills: { space: "configure", page: "agents", tab: "skills" },
  office: { space: "configure", page: "agents", tab: "herd-live" },
  officeLab: { space: "configure", page: "agents", tab: "herd-lab" },
};

function isSpace(value: string | null): value is Space {
  return value === "operate" || value === "observe" || value === "configure";
}

function isOperatePage(value: string | null): value is OperatePage {
  return value === "surface" || value === "tasks" || value === "approvals";
}

function isObservePage(value: string | null): value is ObservePage {
  return (
    value === "activity" ||
    value === "sessions" ||
    value === "artifacts" ||
    value === "costs" ||
    value === "system" ||
    value === "quality"
  );
}

function isConfigurePage(value: string | null): value is ConfigurePage {
  return value === "settings" || value === "integrations" || value === "tools" || value === "agents";
}

export function isWorkSurface(value: string | null): value is WorkSurface {
  return value === "chat" || value === "cowork" || value === "code";
}

function normalizeTab(page: SpacePage, tab: string | null): NestedHostTab | undefined {
  if (!tab) {
    return undefined;
  }

  if (page === "activity" && (tab === "activity" || tab === "scheduler" || tab === "improvement")) {
    return tab;
  }
  if (page === "artifacts" && (tab === "memory" || tab === "files")) {
    return tab;
  }
  if (
    page === "settings" &&
    (tab === "general" ||
      tab === "providers" ||
      tab === "access" ||
      tab === "budget" ||
      tab === "runtime" ||
      tab === "workspaces" ||
      tab === "addons" ||
      tab === "onboarding")
  ) {
    return tab;
  }
  if (page === "integrations" && (tab === "overview" || tab === "channels" || tab === "mcp")) {
    return tab;
  }
  if (page === "agents" && (tab === "overview" || tab === "herd-live" || tab === "herd-lab" || tab === "skills")) {
    return tab;
  }

  return undefined;
}

export function normalizeResolvedRoute(route: ResolvedRoute): ResolvedRoute {
  if (route.space === "operate" && route.page === "surface") {
    return {
      ...route,
      surface: route.surface ?? "chat",
    };
  }
  if (route.page === "activity") {
    return {
      ...route,
      tab: normalizeTab(route.page, route.tab ?? null) ?? "activity",
    };
  }
  if (route.page === "artifacts") {
    return {
      ...route,
      tab: normalizeTab(route.page, route.tab ?? null) ?? "memory",
    };
  }
  if (route.page === "settings") {
    return {
      ...route,
      tab: normalizeTab(route.page, route.tab ?? null) ?? "general",
    };
  }
  if (route.page === "integrations") {
    return {
      ...route,
      tab: normalizeTab(route.page, route.tab ?? null) ?? "overview",
    };
  }
  if (route.page === "agents") {
    return {
      ...route,
      tab: normalizeTab(route.page, route.tab ?? null) ?? "overview",
    };
  }
  return route;
}

export function readRouteFromLocation(): ResolvedRoute {
  if (typeof window === "undefined") {
    return DEFAULT_ROUTE;
  }

  const url = new URL(window.location.href);
  const legacyTab = url.searchParams.get("tab");
  if (legacyTab && legacyTab in LEGACY_TAB_REDIRECTS) {
    const legacyRoute = LEGACY_TAB_REDIRECTS[legacyTab]!;
    const querySurface = url.searchParams.get("surface");
    const nextSurface =
      legacyRoute.page === "surface"
        ? isWorkSurface(querySurface)
          ? querySurface
          : legacyRoute.surface
        : legacyRoute.surface;
    return normalizeResolvedRoute({
      ...legacyRoute,
      surface: nextSurface,
    });
  }

  const space = url.searchParams.get("space");
  const page = url.searchParams.get("page");
  const surface = url.searchParams.get("surface");
  const nestedTab = url.searchParams.get("tab");
  const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
  const turnId = url.searchParams.get("turnId")?.trim() || undefined;
  const approvalId = url.searchParams.get("approvalId")?.trim() || undefined;

  if (isSpace(space)) {
    if (space === "operate" && isOperatePage(page)) {
      return normalizeResolvedRoute({
        space,
        page,
        surface: isWorkSurface(surface) ? surface : undefined,
        sessionId,
        turnId,
        approvalId,
      });
    }
    if (space === "observe" && isObservePage(page)) {
      return normalizeResolvedRoute({
        space,
        page,
        tab: normalizeTab(page, nestedTab),
      });
    }
    if (space === "configure" && isConfigurePage(page)) {
      return normalizeResolvedRoute({
        space,
        page,
        tab: normalizeTab(page, nestedTab),
      });
    }
  }

  return DEFAULT_ROUTE;
}

export function buildRouteSearch(route: ResolvedRoute): string {
  const next = normalizeResolvedRoute(route);
  const params = new URLSearchParams();
  params.set("space", next.space);
  params.set("page", next.page);
  if (next.page === "surface" && next.surface) {
    params.set("surface", next.surface);
  }
  if (next.tab) {
    params.set("tab", next.tab);
  }
  if (next.sessionId) {
    params.set("sessionId", next.sessionId);
  }
  if (next.turnId) {
    params.set("turnId", next.turnId);
  }
  if (next.approvalId) {
    params.set("approvalId", next.approvalId);
  }
  return `?${params.toString()}`;
}

export function getPageLabel(route: ResolvedRoute): string {
  if (route.space === "operate" && route.page === "surface" && route.surface) {
    return route.surface === "chat" ? "Chat" : route.surface === "cowork" ? "Cowork" : "Code";
  }
  return PAGE_META[route.page].label;
}

export function getVisiblePage(route: ResolvedRoute): VisiblePage {
  if (route.space === "operate") {
    if (route.page === "surface") {
      return route.surface ?? "chat";
    }
    return route.page === "tasks" ? "tasks" : "approvals";
  }

  if (route.space === "observe") {
    if (route.page === "activity" || route.page === "sessions") {
      return "timeline";
    }
    if (route.page === "costs" || route.page === "system") {
      return "health";
    }
    return route.page === "artifacts" ? "artifacts" : "quality";
  }

  if (route.page === "integrations") {
    return "integrations";
  }
  if (route.page === "tools") {
    return "tools";
  }
  if (route.page === "agents") {
    return "agents";
  }

  if (route.page === "settings") {
    if (route.tab === "runtime") {
      return "runtime";
    }
    if (route.tab === "workspaces" || route.tab === "addons") {
      return "workspaces";
    }
    return "general";
  }

  return "general";
}

export function getVisiblePageLabel(route: ResolvedRoute): string {
  const visiblePage = getVisiblePage(route);
  const label = VISIBLE_SPACE_PAGES[route.space].find((item) => item.page === visiblePage)?.label;
  return label ?? getPageLabel(route);
}

export function buildRouteForVisiblePage(currentRoute: ResolvedRoute, targetPage: VisiblePage): ResolvedRoute {
  if (targetPage === "chat" || targetPage === "cowork" || targetPage === "code") {
    return {
      space: "operate",
      page: "surface",
      surface: targetPage,
      sessionId: currentRoute.sessionId,
      turnId: currentRoute.turnId,
      approvalId: currentRoute.approvalId,
    };
  }
  if (targetPage === "tasks" || targetPage === "approvals") {
    return { space: "operate", page: targetPage };
  }
  if (targetPage === "timeline") {
    if (currentRoute.space === "observe" && (currentRoute.page === "activity" || currentRoute.page === "sessions")) {
      return currentRoute;
    }
    return { space: "observe", page: "activity", tab: "activity" };
  }
  if (targetPage === "health") {
    if (currentRoute.space === "observe" && (currentRoute.page === "costs" || currentRoute.page === "system")) {
      return currentRoute;
    }
    return { space: "observe", page: "costs" };
  }
  if (targetPage === "artifacts" || targetPage === "quality") {
    return targetPage === "artifacts"
      ? { space: "observe", page: "artifacts", tab: "memory" }
      : { space: "observe", page: "quality" };
  }
  if (targetPage === "integrations" || targetPage === "tools" || targetPage === "agents") {
    if (targetPage === "integrations") {
      return { space: "configure", page: "integrations", tab: "overview" };
    }
    if (targetPage === "agents") {
      return { space: "configure", page: "agents", tab: "overview" };
    }
    return { space: "configure", page: "tools" };
  }
  if (targetPage === "runtime") {
    return { space: "configure", page: "settings", tab: "runtime" };
  }
  if (targetPage === "workspaces") {
    if (currentRoute.page === "settings" && (currentRoute.tab === "workspaces" || currentRoute.tab === "addons")) {
      return currentRoute;
    }
    return { space: "configure", page: "settings", tab: "workspaces" };
  }
  if (
    currentRoute.page === "settings" &&
    (currentRoute.tab === "general" ||
      currentRoute.tab === "providers" ||
      currentRoute.tab === "access" ||
      currentRoute.tab === "budget" ||
      currentRoute.tab === "onboarding")
  ) {
    return currentRoute;
  }
  return { space: "configure", page: "settings", tab: "general" };
}
