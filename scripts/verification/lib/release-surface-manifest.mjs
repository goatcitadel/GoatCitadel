/*
 * Legacy `RELEASE_SURFACE_MANIFEST` was retired in Track D Phase 3 alongside
 * the on-disk `apps/mission-control/` source. The Mission Control Next
 * manifest below is the only release-bearing surface set.
 */

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
  cowork: "ship",
  "cowork-tasks": "ship",
  "cowork-board": "ship",
  code: "ship",
  projects: "ship",
  "library-agents": "ship",
  "library-skills": "ship",
  "library-capabilities": "ship",
  "library-memory": "ship",
  "library-knowledge": "ship",
  "library-notes": "ship",
  "library-communications": "ship",
  "library-files": "ship",
  "library-artifacts": "ship",
  "library-prompt-packs": "ship",
  "library-curator": "experimental",
  "ops-activity": "ship",
  "ops-sessions": "ship",
  "ops-schedules": "ship",
  "ops-improvement": "experimental",
  "ops-notifications": "ship",
  "ops-approvals": "ship",
  "ops-costs": "ship",
  "ops-quality": "ship",
  "ops-runtime": "ship",
  "ops-diagnostics": "ship",
  "ops-kanban": "experimental",
  "settings-general": "ship",
  "settings-onboarding": "ship",
  "settings-providers": "ship",
  "settings-personalities": "experimental",
  "settings-access": "ship",
  "settings-permissions": "ship",
  "settings-trust-policy": "ship",
  "settings-runtime": "ship",
  "settings-local-ai": "ship",
  "settings-workspaces": "ship",
  "settings-budget": "ship",
  "settings-addons": "experimental",
  "settings-integrations": "ship",
  "settings-channels": "ship",
  "settings-mcp": "ship",
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
    slug: "library-notes",
    href: "/library/notes",
    readyText: "Notes",
    expectedArea: "library",
    expectedSection: "notes",
    interaction: "open-inspector",
  },
  {
    slug: "library-communications",
    href: "/library/communications",
    readyText: "Communications",
    expectedArea: "library",
    expectedSection: "communications",
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
    slug: "ops-quality",
    href: "/ops/quality",
    readyText: "Quality Dashboard",
    expectedArea: "ops",
    expectedSection: "quality",
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
    slug: "settings-trust-policy",
    href: "/settings/trust-policy",
    readyText: "Trust & Policy snapshot",
    expectedArea: "settings",
    expectedSection: "trust-policy",
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
    slug: "settings-local-ai",
    href: "/settings/local-ai",
    readyText: "Hardware readiness",
    expectedArea: "settings",
    expectedSection: "local-ai",
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
    expectedPath: "/ops/quality",
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

export function resolveSurfaceRegressionManifest() {
  return NEXT_RELEASE_SURFACE_MANIFEST;
}

export function resolveVisualRegressionManifest() {
  return NEXT_VISUAL_REGRESSION_MANIFEST;
}

export function resolveVisualRegressionVariants() {
  return RELEASE_SURFACE_VARIANTS;
}

export function resolveVisualBaselineNamespace(packageName) {
  return packageName === "@goatcitadel/mission-control-next" ? "mission-control-next" : "";
}

export function resolveLegacyRedirectManifest(packageName) {
  return packageName === "@goatcitadel/mission-control-next" ? NEXT_LEGACY_REDIRECT_MANIFEST : [];
}
