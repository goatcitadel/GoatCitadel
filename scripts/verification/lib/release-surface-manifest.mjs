export const RELEASE_SURFACE_MANIFEST = [
  { slug: "work-chat", href: "?space=operate&page=surface&surface=chat", readySelector: ".chat-v11.mode-chat" },
  { slug: "work-cowork", href: "?space=operate&page=surface&surface=cowork", readySelector: ".chat-v11.mode-cowork" },
  { slug: "work-code", href: "?space=operate&page=surface&surface=code", readySelector: ".chat-v11.mode-code" },
  { slug: "work-tasks", href: "?space=operate&page=tasks", readyText: "Tasks" },
  { slug: "work-approvals", href: "?space=operate&page=approvals", readyText: "Approvals" },
  { slug: "observe-timeline", href: "?space=observe&page=activity&tab=activity", readyText: "Timeline" },
  { slug: "observe-health", href: "?space=observe&page=costs", readyText: "Health" },
  { slug: "observe-artifacts", href: "?space=observe&page=artifacts&tab=memory", readyText: "Artifacts" },
  { slug: "observe-quality", href: "?space=observe&page=quality", readyText: "Quality" },
  { slug: "tune-general", href: "?space=configure&page=settings&tab=general", readyText: "General" },
  { slug: "tune-runtime", href: "?space=configure&page=settings&tab=runtime", readyText: "Runtime" },
  { slug: "tune-workspaces", href: "?space=configure&page=settings&tab=workspaces", readyText: "Workspaces" },
  {
    slug: "tune-integrations",
    href: "?space=configure&page=integrations&tab=overview",
    readyText: "How connections work",
  },
  { slug: "tune-tools", href: "?space=configure&page=tools", readyText: "Tools" },
  { slug: "tune-agents", href: "?space=configure&page=agents&tab=overview", readyText: "Agents" },
];

export const RELEASE_SURFACE_VARIANTS = [
  {
    slug: "desktop-dark",
    viewport: { width: 1440, height: 1024 },
    colorScheme: "dark",
    themeQuery: "",
  },
  {
    slug: "desktop-light",
    viewport: { width: 1440, height: 1024 },
    colorScheme: "light",
    themeQuery: "theme=light",
  },
  /*
   * Laptop captures the typical 13-14" panel where the threaded surface still
   * runs the full three-column stage but at noticeably tighter widths.
   */
  {
    slug: "laptop-dark",
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    themeQuery: "",
  },
  {
    slug: "laptop-light",
    viewport: { width: 1280, height: 800 },
    colorScheme: "light",
    themeQuery: "theme=light",
  },
  /*
   * Desktop-narrow sits just below the 1180px useMediaQuery boundary in
   * ThreadedSurfacePage and the 1360px stage-collapse breakpoint in
   * threaded-surface.css; this is where the compact-layout class kicks in.
   */
  {
    slug: "desktop-narrow-dark",
    viewport: { width: 1180, height: 900 },
    colorScheme: "dark",
    themeQuery: "",
  },
  {
    slug: "desktop-narrow-light",
    viewport: { width: 1180, height: 900 },
    colorScheme: "light",
    themeQuery: "theme=light",
  },
  {
    slug: "mobile-dark",
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    themeQuery: "",
  },
  {
    slug: "mobile-light",
    viewport: { width: 390, height: 844 },
    colorScheme: "light",
    themeQuery: "theme=light",
  },
];

export const NEXT_RELEASE_SURFACE_STATUS_BY_SLUG = {
  chat: "ship",
  cowork: "needs_release_polish",
  "cowork-tasks": "needs_release_polish",
  "cowork-board": "needs_release_polish",
  code: "needs_release_polish",
  projects: "needs_release_polish",
  "library-agents": "ship",
  "library-skills": "ship",
  "library-capabilities": "ship",
  "library-memory": "needs_release_polish",
  "library-knowledge": "needs_release_polish",
  "library-files": "ship",
  "library-artifacts": "needs_release_polish",
  "library-prompt-packs": "ship",
  "library-curator": "experimental",
  "ops-activity": "needs_release_polish",
  "ops-sessions": "ship",
  "ops-schedules": "needs_release_polish",
  "ops-improvement": "experimental",
  "ops-notifications": "needs_release_polish",
  "ops-approvals": "ship",
  "ops-costs": "ship",
  "ops-runtime": "ship",
  "ops-diagnostics": "ship",
  "ops-kanban": "experimental",
  "settings-general": "ship",
  "settings-onboarding": "needs_release_polish",
  "settings-providers": "needs_release_polish",
  "settings-personalities": "experimental",
  "settings-access": "ship",
  "settings-permissions": "ship",
  "settings-runtime": "ship",
  "settings-workspaces": "ship",
  "settings-budget": "ship",
  "settings-addons": "experimental",
  "settings-integrations": "needs_release_polish",
  "settings-channels": "needs_release_polish",
  "settings-mcp": "needs_release_polish",
  "settings-tools": "ship",
};

export const NEXT_RELEASE_SURFACE_MANIFEST = withReleaseSurfaceStatus([
  {
    slug: "chat",
    href: "/chat",
    readySelector: ".mc-next-threaded-surface[data-mode=\"chat\"]",
    expectedArea: "chat",
    expectedSection: "root",
    interaction: "open-inspector",
  },
  {
    slug: "cowork",
    href: "/cowork",
    readySelector: ".mc-next-threaded-surface[data-mode=\"cowork\"]",
    expectedArea: "cowork",
    expectedSection: "workspace",
    interaction: "open-inspector",
  },
  {
    slug: "cowork-tasks",
    href: "/cowork/tasks",
    readySelector: ".mc-next-directory-page",
    expectedArea: "cowork",
    expectedSection: "tasks",
    interaction: "open-inspector",
  },
  {
    slug: "cowork-board",
    href: "/cowork/board",
    readySelector: ".mc-next-directory-page",
    expectedArea: "cowork",
    expectedSection: "board",
    interaction: "open-inspector",
  },
  {
    slug: "code",
    href: "/code",
    readySelector: ".mc-next-threaded-surface[data-mode=\"code\"]",
    expectedArea: "code",
    expectedSection: "root",
    interaction: "open-inspector",
  },
  {
    slug: "projects",
    href: "/projects",
    readyText: "Project containers",
    expectedArea: "projects",
    expectedSection: "root",
    interaction: "open-inspector",
  },
  {
    slug: "library-agents",
    href: "/library/agents",
    readyText: "Agents",
    expectedArea: "library",
    expectedSection: "agents",
    interaction: "open-inspector",
  },
  {
    slug: "library-skills",
    href: "/library/skills",
    readyText: "Skills",
    expectedArea: "library",
    expectedSection: "skills",
    interaction: "open-inspector",
  },
  {
    slug: "library-capabilities",
    href: "/library/capabilities",
    readyText: "Capability browser",
    expectedArea: "library",
    expectedSection: "capabilities",
    interaction: "open-inspector",
  },
  {
    slug: "library-memory",
    href: "/library/memory",
    readyText: "Memory",
    expectedArea: "library",
    expectedSection: "memory",
    interaction: "open-inspector",
  },
  {
    slug: "library-knowledge",
    href: "/library/knowledge",
    readyText: "Knowledge sources",
    expectedArea: "library",
    expectedSection: "knowledge",
    interaction: "open-inspector",
  },
  {
    slug: "library-files",
    href: "/library/files",
    readySelector: ".mc-next-directory-page",
    expectedArea: "library",
    expectedSection: "files",
    interaction: "open-inspector",
  },
  {
    slug: "library-artifacts",
    href: "/library/artifacts",
    readyText: "Generated artifacts",
    expectedArea: "library",
    expectedSection: "artifacts",
    interaction: "open-inspector",
  },
  {
    slug: "library-prompt-packs",
    href: "/library/prompt-packs",
    readySelector: ".mc-pp-layout",
    expectedArea: "library",
    expectedSection: "prompt-packs",
    interaction: "open-inspector",
  },
  {
    slug: "library-curator",
    href: "/library/curator",
    readyText: "Skill Curator",
    expectedArea: "library",
    expectedSection: "curator",
    interaction: "open-inspector",
  },
  {
    slug: "ops-activity",
    href: "/ops/activity",
    readyText: "Activity feed",
    expectedArea: "ops",
    expectedSection: "activity",
    interaction: "open-inspector",
  },
  {
    slug: "ops-sessions",
    href: "/ops/sessions",
    readyText: "Sessions",
    expectedArea: "ops",
    expectedSection: "sessions",
    interaction: "open-inspector",
  },
  {
    slug: "ops-schedules",
    href: "/ops/schedules",
    readySelector: ".mc-next-directory-page",
    expectedArea: "ops",
    expectedSection: "schedules",
    interaction: "open-inspector",
  },
  {
    slug: "ops-improvement",
    href: "/ops/improvement",
    readyText: "Improvement",
    expectedArea: "ops",
    expectedSection: "improvement",
    interaction: "open-inspector",
  },
  {
    slug: "ops-notifications",
    href: "/ops/notifications",
    readyText: "Notification signals",
    expectedArea: "ops",
    expectedSection: "notifications",
    interaction: "open-inspector",
  },
  {
    slug: "ops-approvals",
    href: "/ops/approvals",
    readyText: "Approvals",
    expectedArea: "ops",
    expectedSection: "approvals",
    interaction: "open-inspector",
  },
  {
    slug: "ops-costs",
    href: "/ops/costs",
    readyText: "Costs",
    expectedArea: "ops",
    expectedSection: "costs",
    interaction: "open-inspector",
  },
  {
    slug: "ops-runtime",
    href: "/ops/runtime",
    readyText: "Runtime",
    expectedArea: "ops",
    expectedSection: "runtime",
    interaction: "open-inspector",
  },
  {
    slug: "ops-diagnostics",
    href: "/ops/diagnostics",
    readyText: "Diagnostics directory",
    expectedArea: "ops",
    expectedSection: "diagnostics",
    interaction: "open-inspector",
  },
  {
    slug: "ops-kanban",
    href: "/ops/kanban",
    readySelector: ".mc-next-kanban-board",
    expectedArea: "ops",
    expectedSection: "kanban",
    interaction: "open-inspector",
  },
  {
    slug: "settings-general",
    href: "/settings/general",
    readyText: "General",
    expectedArea: "settings",
    expectedSection: "general",
    interaction: "open-inspector",
  },
  {
    slug: "settings-onboarding",
    href: "/settings/onboarding",
    readyText: "Start Here",
    expectedArea: "settings",
    expectedSection: "onboarding",
    interaction: "open-inspector",
  },
  {
    slug: "settings-providers",
    href: "/settings/providers",
    readyText: "Providers",
    expectedArea: "settings",
    expectedSection: "providers",
    interaction: "open-inspector",
  },
  {
    slug: "settings-personalities",
    href: "/settings/personalities",
    readyText: "Personalities",
    expectedArea: "settings",
    expectedSection: "personalities",
    interaction: "open-inspector",
  },
  {
    slug: "settings-access",
    href: "/settings/access",
    readyText: "Access",
    expectedArea: "settings",
    expectedSection: "access",
    interaction: "open-inspector",
  },
  {
    slug: "settings-permissions",
    href: "/settings/permissions",
    readyText: "Permission profiles",
    expectedArea: "settings",
    expectedSection: "permissions",
    interaction: "open-inspector",
  },
  {
    slug: "settings-runtime",
    href: "/settings/runtime",
    readyText: "Runtime posture",
    expectedArea: "settings",
    expectedSection: "runtime",
    interaction: "open-inspector",
  },
  {
    slug: "settings-workspaces",
    href: "/settings/workspaces",
    readyText: "Workspaces",
    expectedArea: "settings",
    expectedSection: "workspaces",
    interaction: "open-inspector",
  },
  {
    slug: "settings-budget",
    href: "/settings/budget",
    readyText: "Budget mode",
    expectedArea: "settings",
    expectedSection: "budget",
    interaction: "open-inspector",
  },
  {
    slug: "settings-addons",
    href: "/settings/addons",
    readyText: "Add-ons",
    expectedArea: "settings",
    expectedSection: "addons",
    interaction: "open-inspector",
  },
  {
    slug: "settings-integrations",
    href: "/settings/integrations",
    readyText: "Integrations",
    expectedArea: "settings",
    expectedSection: "integrations",
    interaction: "open-inspector",
  },
  {
    slug: "settings-channels",
    href: "/settings/channels",
    readyText: "Channels",
    expectedArea: "settings",
    expectedSection: "channels",
    interaction: "open-inspector",
  },
  {
    slug: "settings-mcp",
    href: "/settings/mcp",
    readyText: "MCP",
    expectedArea: "settings",
    expectedSection: "mcp",
    interaction: "open-inspector",
  },
  {
    slug: "settings-tools",
    href: "/settings/tools",
    readyText: "Tool catalog",
    expectedArea: "settings",
    expectedSection: "tools",
    interaction: "open-inspector",
  },
]);

/*
 * Visual-only scenario variants for canonical routes. These do not register a
 * new canonical surface; they capture additional visual states (pending
 * approval, pending user input, etc.) of an existing canonical route by URL
 * flag and fixture-session-key binding. The fields mirror the canonical
 * manifest shape so the visual-regression lane can iterate both lists
 * uniformly.
 */
export const NEXT_VISUAL_SCENARIO_MANIFEST = [
  {
    slug: "chat-pending-approval",
    href: "/chat?vr-blocked=1",
    readySelector: ".mc-next-composer-blocking-prompt[data-blocker-kind=\"approval\"]",
    expectedArea: "chat",
    expectedSection: "root",
    interaction: "open-inspector",
    fixtureSessionKey: "approval",
  },
  {
    slug: "chat-pending-user-input",
    href: "/chat?vr-blocked=1",
    readySelector: ".mc-next-composer-blocking-prompt[data-blocker-kind=\"user-input\"]",
    expectedArea: "chat",
    expectedSection: "root",
    interaction: "open-inspector",
    fixtureSessionKey: "userInput",
  },
];

export const NEXT_VISUAL_REGRESSION_MANIFEST = [...NEXT_RELEASE_SURFACE_MANIFEST, ...NEXT_VISUAL_SCENARIO_MANIFEST];

export const NEXT_LEGACY_REDIRECT_MANIFEST = [
  { slug: "legacy-tab-chat", href: "/?tab=chat&surface=chat", expectedPath: "/chat", interaction: "open-inspector" },
  { slug: "legacy-tab-assembly", href: "/?tab=assembly", expectedPath: "/cowork", interaction: "open-inspector" },
  { slug: "legacy-tab-tasks", href: "/?tab=tasks", expectedPath: "/cowork/tasks", interaction: "open-inspector" },
  { slug: "legacy-tab-board", href: "/?tab=herd-live", expectedPath: "/cowork/board", interaction: "open-inspector" },
  { slug: "legacy-surface-chat", href: "/?surface=chat", expectedPath: "/chat", interaction: "open-inspector" },
  { slug: "legacy-surface-cowork", href: "/?surface=cowork", expectedPath: "/cowork", interaction: "open-inspector" },
  { slug: "legacy-surface-code", href: "/?surface=code", expectedPath: "/code", interaction: "open-inspector" },
  {
    slug: "legacy-space-code",
    href: "/?space=operate&page=surface&surface=code",
    expectedPath: "/code",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-activity",
    href: "/?space=observe&page=activity&tab=activity",
    expectedPath: "/ops/activity",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-scheduler",
    href: "/?space=observe&page=activity&tab=scheduler",
    expectedPath: "/ops/schedules",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-improvement",
    href: "/?space=observe&page=activity&tab=improvement",
    expectedPath: "/ops/improvement",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-memory",
    href: "/?space=observe&page=artifacts&tab=memory",
    expectedPath: "/library/memory",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-artifacts",
    href: "/?space=observe&page=artifacts&tab=generated",
    expectedPath: "/library/artifacts",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-quality",
    href: "/?space=observe&page=quality",
    expectedPath: "/library/prompt-packs",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-settings-runtime",
    href: "/?space=configure&page=settings&tab=runtime",
    expectedPath: "/settings/runtime",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-settings-permissions",
    href: "/?space=configure&page=settings&tab=permissions",
    expectedPath: "/settings/permissions",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-settings-workspaces",
    href: "/?space=configure&page=settings&tab=workspaces",
    expectedPath: "/settings/workspaces",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-channels",
    href: "/?space=configure&page=integrations&tab=channels",
    expectedPath: "/settings/channels",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-mcp",
    href: "/?space=configure&page=integrations&tab=mcp",
    expectedPath: "/settings/mcp",
    interaction: "open-inspector",
  },
  {
    slug: "legacy-space-skills",
    href: "/?space=configure&page=agents&tab=skills",
    expectedPath: "/library/skills",
    interaction: "open-inspector",
  },
];

function withReleaseSurfaceStatus(routes) {
  return routes.map((route) => ({
    ...route,
    releaseStatus: NEXT_RELEASE_SURFACE_STATUS_BY_SLUG[route.slug] ?? "hide",
  }));
}

export const CURRENT_SHELL_CONTRACT = {
  shellSelector: ".layout-shell",
  chromeSelector: ".shell-bar",
  forbiddenSelector: ".gateway-access-shell",
  loadingSelector: ".shell-page-loading",
};

export const NEXT_SHELL_CONTRACT = {
  shellSelector: ".mc-next-shell",
  chromeSelector: ".mc-next-topbar",
  forbiddenSelector: ".gateway-access-shell",
  loadingSelector: ".mc-next-route-fallback",
};

export function buildVisualBaselineFileName(routeSlug, variantSlug) {
  return `visual-regression-${routeSlug}-${variantSlug}.png`;
}

export function resolveShellContract(packageName) {
  return packageName === "@goatcitadel/mission-control-next" ? NEXT_SHELL_CONTRACT : CURRENT_SHELL_CONTRACT;
}

export function resolveSurfaceRegressionManifest(packageName) {
  return packageName === "@goatcitadel/mission-control-next" ? NEXT_RELEASE_SURFACE_MANIFEST : RELEASE_SURFACE_MANIFEST;
}

export function resolveVisualRegressionManifest(packageName) {
  return packageName === "@goatcitadel/mission-control-next" ? NEXT_VISUAL_REGRESSION_MANIFEST : RELEASE_SURFACE_MANIFEST;
}

export function resolveVisualRegressionVariants(_packageName) {
  return RELEASE_SURFACE_VARIANTS;
}

export function resolveVisualBaselineNamespace(packageName) {
  return packageName === "@goatcitadel/mission-control-next" ? "mission-control-next" : "";
}

export function resolveLegacyRedirectManifest(packageName) {
  return packageName === "@goatcitadel/mission-control-next" ? NEXT_LEGACY_REDIRECT_MANIFEST : [];
}
