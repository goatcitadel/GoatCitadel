import { buildAppHref, normalizeAppRoute, parseAppRoute, type AppRoute } from "./route-model";

export function adaptLegacyUrl(input: string | URL): AppRoute | null {
  const url = typeof input === "string" ? new URL(input, "http://goatcitadel.local") : input;
  const params = url.searchParams;
  const ids = {
    sessionId: readParam(params, "sessionId"),
    turnId: readParam(params, "turnId"),
    artifactId: readParam(params, "artifactId"),
    approvalId: readParam(params, "approvalId"),
    theme: readParam(params, "theme"),
  };

  const legacyTab = readParam(params, "tab");
  const querySurface = readParam(params, "surface");
  if (!legacyTab && !readParam(params, "space") && !readParam(params, "page") && querySurface) {
    return normalizeAppRoute({
      area: querySurface === "cowork" || querySurface === "code" ? querySurface : "chat",
      ...ids,
    });
  }
  if (legacyTab) {
    const fromLegacyTab = translateLegacyTab(legacyTab, querySurface);
    if (fromLegacyTab) {
      return normalizeAppRoute({
        ...fromLegacyTab,
        ...ids,
      });
    }
  }

  const space = readParam(params, "space");
  const page = readParam(params, "page");
  if (!space && !page) {
    return null;
  }

  if (space === "operate" && page === "surface") {
    const surface = querySurface === "cowork" || querySurface === "code" ? querySurface : "chat";
    return normalizeAppRoute({
      area: surface,
      ...ids,
    });
  }

  if (space === "operate" && page === "tasks") {
    return normalizeAppRoute({ area: "cowork", section: "tasks", ...ids });
  }

  if (space === "operate" && page === "approvals") {
    return normalizeAppRoute({ area: "ops", section: "approvals", ...ids });
  }

  if (space === "observe" && page === "activity") {
    if (legacyTab === "scheduler") {
      return normalizeAppRoute({ area: "ops", section: "schedules", ...ids });
    }
    return normalizeAppRoute({ area: "ops", section: "activity", ...ids });
  }

  if (space === "observe" && page === "sessions") {
    return normalizeAppRoute({ area: "ops", section: "sessions", ...ids });
  }

  if (space === "observe" && page === "artifacts") {
    return normalizeAppRoute({ area: "library", section: "memory", ...ids });
  }

  if (space === "observe" && page === "costs") {
    return normalizeAppRoute({ area: "ops", section: "costs", ...ids });
  }

  if (space === "observe" && page === "system") {
    return normalizeAppRoute({ area: "ops", section: "runtime", ...ids });
  }

  if (space === "observe" && page === "quality") {
    return normalizeAppRoute({ area: "library", section: "prompt-packs", ...ids });
  }

  if (space === "configure" && page === "settings") {
    const section = translateSettingsTab(legacyTab);
    return normalizeAppRoute({ area: "settings", section, ...ids });
  }

  if (space === "configure" && page === "integrations") {
    const section = legacyTab === "channels" ? "channels" : legacyTab === "mcp" ? "mcp" : "integrations";
    return normalizeAppRoute({ area: "settings", section, ...ids });
  }

  if (space === "configure" && page === "tools") {
    return normalizeAppRoute({ area: "settings", section: "tools", ...ids });
  }

  if (space === "configure" && page === "agents") {
    if (legacyTab === "board") {
      return normalizeAppRoute({ area: "cowork", section: "board", ...ids });
    }
    return normalizeAppRoute({ area: "library", section: "agents", ...ids });
  }

  return normalizeAppRoute({ area: "chat", ...ids });
}

export function resolveRouteFromLocation(input: string | URL): AppRoute {
  const url = typeof input === "string" ? new URL(input, "http://goatcitadel.local") : input;
  const legacy = adaptLegacyUrl(url);
  return legacy ?? parseAppRoute(url);
}

export function coerceLegacyHrefToNext(input: string | URL): string | null {
  const route = adaptLegacyUrl(input);
  return route ? buildAppHref(route) : null;
}

function translateLegacyTab(
  tab: string,
  querySurface?: string,
): Omit<AppRoute, "sessionId" | "turnId" | "artifactId" | "approvalId" | "theme"> | null {
  const normalized = tab.trim().toLowerCase();
  const workSurface = querySurface === "cowork" || querySurface === "code" ? querySurface : "chat";

  switch (normalized) {
    case "dashboard":
    case "chat":
      return { area: workSurface };
    case "assembly":
      return { area: "cowork" };
    case "tasks":
      return { area: "cowork", section: "tasks" };
    case "approvals":
      return { area: "ops", section: "approvals" };
    case "activity":
      return { area: "ops", section: "activity" };
    case "cron":
      return { area: "ops", section: "schedules" };
    case "improvement":
      return { area: "ops", section: "improvement" };
    case "sessions":
      return { area: "ops", section: "sessions" };
    case "memory":
      return { area: "library", section: "memory" };
    case "files":
      return { area: "library", section: "files" };
    case "generated":
      return { area: "library", section: "artifacts" };
    case "costs":
      return { area: "ops", section: "costs" };
    case "system":
      return { area: "ops", section: "runtime" };
    case "promptlab":
      return { area: "library", section: "prompt-packs" };
    case "settings":
      return { area: "settings", section: "general" };
    case "workspaces":
      return { area: "settings", section: "workspaces" };
    case "addons":
      return { area: "settings", section: "addons" };
    case "onboarding":
      return { area: "settings", section: "onboarding" };
    case "mesh":
    case "npu":
      return { area: "settings", section: "runtime" };
    case "integrations":
      return { area: "settings", section: "integrations" };
    case "channels":
      return { area: "settings", section: "channels" };
    case "mcp":
      return { area: "settings", section: "mcp" };
    case "tools":
      return { area: "settings", section: "tools" };
    case "agents":
      return { area: "library", section: "agents" };
    case "skills":
      return { area: "library", section: "skills" };
    case "catalog":
      return { area: "library", section: "agents", view: "catalog" };
    case "office":
    case "officelab":
    case "herd-live":
    case "herd-lab":
      return { area: "cowork", section: "board" };
    default:
      return null;
  }
}

function translateSettingsTab(tab?: string): AppRoute["section"] {
  switch (tab) {
    case "providers":
      return "providers";
    case "personalities":
      return "personalities";
    case "access":
      return "access";
    case "budget":
      return "budget";
    case "runtime":
      return "runtime";
    default:
      return "general";
  }
}

function readParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value : undefined;
}
