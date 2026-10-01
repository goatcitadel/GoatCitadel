/** Additive cockpit captures. These never reuse a classic route's PNG slug. */
export const COCKPIT_VISUAL_MANIFEST = [
  {
    slug: "cockpit-chat", href: "/chat", shell: "cockpit", fixtureSessionKey: "approval",
    readySelector: 'section[aria-label="Chat"] [aria-label="Messages"]',
  },
  { slug: "cockpit-inbox", href: "/inbox", shell: "cockpit", readyText: "Inbox" },
  ...[
    ["board", "/work", "Work"],
    ["history", "/work/history", "Work history"],
    ["schedules", "/work/schedules", "Schedules"],
  ].map(([slug, href, readyText]) => ({
    slug: `cockpit-work-${slug}`, href, shell: "cockpit", readyText,
    readySelector: `nav[aria-label="Work views"] a[aria-current="page"][href="${href}"]`,
  })),
  ...[
    ["capabilities", "/library", "Library"],
    ["memory", "/library/memory", "Memory"],
    ["notes", "/library/notes", "Notes"],
    ["files", "/library/files", "Files"],
    ["artifacts", "/library/artifacts", "Artifacts"],
  ].map(([slug, href, readyText]) => ({
    slug: `cockpit-library-${slug}`, href, shell: "cockpit", readyText,
    readySelector: `nav[aria-label="Library sections"] a[aria-current="page"][href="${href}?shell=cockpit"]`,
  })),
  ...[
    ["health", "/system", "System"],
    ["spend", "/system/spend", "Spend"],
    ["quality", "/system/quality", "Quality"],
    ["diagnostics", "/system/diagnostics", "Diagnostics"],
    ["activity", "/system/activity", "Activity log"],
    ["dashboards", "/system/dashboards", "Dashboards"],
  ].map(([slug, href, readyText]) => ({
    slug: `cockpit-system-${slug}`, href, shell: "cockpit", readyText,
    readySelector: `nav[aria-label="System views"] a[aria-current="page"][href="${href}"]`,
  })),
  ...["General", "Models", "Connections", "Safety", "Citadel", "Access", "Advanced"].map(label => ({
    slug: `cockpit-settings-${label.toLowerCase()}`, href: `/settings/${label.toLowerCase()}`,
    shell: "cockpit", readyText: "Settings",
    readySelector: `#main-content section[aria-label="${label}"]:not([hidden])`,
  })),
  {
    slug: "cockpit-first-run", href: "/settings/first-run", shell: "cockpit", fullscreen: true,
    readyText: "Your first answer", readySelector: 'nav[aria-label="Setup steps"]',
  },
  {
    slug: "cockpit-gallery", href: "/__gallery", shell: "cockpit",
    readyText: "Cockpit components", readySelector: '[data-cockpit-gallery="true"]',
  },
];
