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
  { slug: "tune-integrations", href: "?space=configure&page=integrations&tab=overview", readyText: "Integrations" },
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

export function buildVisualBaselineFileName(routeSlug, variantSlug) {
  return `visual-regression-${routeSlug}-${variantSlug}.png`;
}
