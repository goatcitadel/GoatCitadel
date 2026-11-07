import type { AppRoute, PrimaryArea, RailGroup, LibrarySection } from "./route-model";

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

/** Canonical section labels, shared with the full rail records without their descriptions. */
export const ROUTE_SECTION_LABELS = {
  library: {
    "citadel-overview": CITADEL_PAGE_LABELS["citadel-overview"],
    citadel: CITADEL_PAGE_LABELS.citadel,
    "citadel-wards": CITADEL_PAGE_LABELS["citadel-wards"],
    "citadel-council": CITADEL_PAGE_LABELS["citadel-council"],
    "citadel-vault": CITADEL_PAGE_LABELS["citadel-vault"],
    "citadel-blueprint": CITADEL_PAGE_LABELS["citadel-blueprint"],
    agents: "Agents",
    skills: "Skills",
    capabilities: "Capabilities",
    memory: "Memory",
    journey: "Journey",
    knowledge: "Knowledge",
    notes: "Notes",
    communications: "Mail",
    files: "Files",
    artifacts: "Artifacts",
    "prompt-packs": "Prompt packs",
    curator: "Skill curator",
  },
  ops: {
    boards: "Saved boards",
    activity: "Activity",
    sessions: "Sessions",
    schedules: "Schedules",
    workers: "Remote workers",
    improvement: "Improvement",
    notifications: "Notifications",
    approvals: "Approvals",
    costs: "Costs",
    quality: "Quality",
    runtime: "Runtime",
    diagnostics: "Diagnostics",
    kanban: "Kanban",
  },
  settings: {
    general: "General",
    onboarding: "Get started",
    providers: "Providers & models",
    personalities: "Personalities",
    access: "Access & devices",
    permissions: "Permissions",
    "trust-policy": "Trust & policy",
    runtime: "Runtime configuration",
    "local-ai": "Local AI",
    workspaces: "Workspaces",
    integrations: "Integrations",
    channels: "Channels",
    mcp: "MCP servers",
    "web-search": "Web & Search",
    tools: "Tools",
    hooks: "Hooks",
    budget: "Budgets",
    "workspace-capabilities": "Workspace capabilities",
    "citadel-capabilities": "Citadel capabilities",
  },
} as const;

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
      sections: ["channels", "integrations", "mcp", "web-search"],
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

export function readRouteSectionLabel(area: "library" | "ops" | "settings", section: string): string | undefined {
  const labels: Readonly<Partial<Record<string, string>>> = ROUTE_SECTION_LABELS[area];
  return Object.hasOwn(labels, section) ? labels[section] : undefined;
}
