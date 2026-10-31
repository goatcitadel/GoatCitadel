/**
 * The current view in an area's navigation: a tab link on wider screens, or the phone section picker
 * (`OverflowTabs` swaps the tab strip for a select when an area has many views) with that view selected.
 */
function currentAreaViewSelector(label, href) {
  return `nav[aria-label="${label}"] a[aria-current="page"][href="${href}"], nav[aria-label="${label}"] select:has(option:checked[value="${href}"])`;
}

/** Additive cockpit captures. These never reuse a classic route's PNG slug. */
export const COCKPIT_VISUAL_MANIFEST = [
  {
    slug: "cockpit-chat",
    href: "/chat",
    shell: "cockpit",
    fixtureSessionKey: "approval",
    readySelector: 'section[aria-label="Chat"] [aria-label="Messages"]',
    // A following transcript opens at its newest turn; never capture it mid-pin.
    readyAtLatest: true,
  },
  // The Chat Code Mode card: waiting with Code Mode on, waiting with it off (one click turns it on and runs), and ran.
  // The visual lane pins the readiness read per state; the pending and enable captures share one seeded request.
  ...[
    ["pending", "codeModePending"],
    ["enable", "codeModePending"],
    ["done", "codeModeRan"],
  ].map(([state, fixtureSessionKey]) => ({
    slug: `cockpit-chat-code-mode-card-${state}`,
    href: "/chat",
    shell: "cockpit",
    fixtureSessionKey,
    readySelector: 'section[aria-label="Chat"] [aria-label="Messages"]',
    readyAtLatest: true,
    visualState: `code-mode-${state}`,
  })),
  { slug: "cockpit-inbox", href: "/inbox", shell: "cockpit", readyText: "Inbox" },
  ...[
    ["board", "/work", "Work"],
    ["history", "/work/history", "History"],
    ["schedules", "/work/schedules", "Schedules"],
  ].map(([slug, href, readyText]) => ({
    slug: `cockpit-work-${slug}`,
    href,
    shell: "cockpit",
    readyText,
    readySelector: `nav[aria-label="Work views"] a[aria-current="page"][href="${href}"]`,
  })),
  ...[
    ["capabilities", "/library", "Candidates and mesh"],
    ["memory", "/library/memory", "Memory"],
    ["notes", "/library/notes", "Notes"],
    ["files", "/library/files", "Files"],
    ["artifacts", "/library/artifacts", "Artifacts"],
  ].map(([slug, href, readyText]) => ({
    slug: `cockpit-library-${slug}`,
    href,
    shell: "cockpit",
    readyText,
    readySelector: currentAreaViewSelector("Library sections", `${href}?shell=cockpit`),
  })),
  ...[
    ["health", "/system", "System"],
    ["spend", "/system/spend", "Spend"],
    ["quality", "/system/quality", "Quality"],
    ["diagnostics", "/system/diagnostics", "Diagnostics"],
    ["activity", "/system/activity", "Activity log"],
    ["dashboards", "/system/dashboards", "Dashboards"],
  ].map(([slug, href, readyText]) => ({
    slug: `cockpit-system-${slug}`,
    href,
    shell: "cockpit",
    readyText,
    readySelector: currentAreaViewSelector("System views", href),
  })),
  // These pages print "Loading…" as plain text, not a status region, so wait for a section only loaded data renders.
  {
    slug: "cockpit-system-runtime",
    href: "/system/runtime",
    shell: "cockpit",
    readyText: "Runtime",
    readySelector: "#main-content #runtime-server",
  },
  {
    slug: "cockpit-system-spend-details",
    href: "/system/spend/details",
    shell: "cockpit",
    readyText: "Spend details",
    readySelector: '#main-content [role="group"][aria-label="Time window"]',
  },
  // Connections is not here: #655 retired that page and redirects its address to Capabilities.
  ...["General", "Models", "Safety", "Citadel", "Access", "Advanced"].map((label) => ({
    slug: `cockpit-settings-${label.toLowerCase()}`,
    href: `/settings/${label.toLowerCase()}`,
    shell: "cockpit",
    // Each Settings page titles itself with its own name ("General", "Models"…); "Settings" is only the search title.
    readyText: label,
    readySelector: `#main-content section[aria-label="${label}"]:not([hidden])`,
  })),
  {
    slug: "cockpit-first-run",
    href: "/settings/first-run",
    shell: "cockpit",
    fullscreen: true,
    readyText: "Get started",
    readySelector: 'nav[aria-label="Setup steps"]',
  },
  {
    slug: "cockpit-gallery",
    href: "/__gallery",
    shell: "cockpit",
    readyText: "Cockpit components",
    readySelector: '[data-cockpit-gallery="true"]',
  },
];
