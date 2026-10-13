import { COCKPIT_VISUAL_MANIFEST } from "../../../scripts/verification/lib/cockpit-visual-manifest.mjs";

/*
 * Public README/gallery captures of the default Cockpit layout. Each target joins
 * a Cockpit visual-manifest route so a renamed or retired route fails closed
 * instead of silently capturing the wrong page.
 */
export const PUBLIC_SCREENSHOT_TARGETS = Object.freeze([
  {
    slug: "chat",
    routeSlug: "cockpit-chat",
    sessionKey: "sessionId",
    file: "chat.png",
    theme: "dark",
    title: "Chat",
    description: "One conversation surface for questions, planning, agentic runs, approvals, and governed code work.",
    readyText: "Lumen Notes 2.0 launch plan",
  },
  {
    slug: "chat-light",
    routeSlug: "cockpit-chat",
    sessionKey: "sessionId",
    file: "chat-light.png",
    theme: "light",
    title: "Chat · Light theme",
    description: "The same Chat surface in the light Cockpit theme.",
    readyText: "Lumen Notes 2.0 launch plan",
  },
  {
    slug: "inbox",
    routeSlug: "cockpit-inbox",
    file: "inbox.png",
    theme: "dark",
    title: "Inbox",
    description: "Everything waiting on a human decision: approvals, questions, and proposals, with source context.",
  },
  {
    slug: "work-board",
    routeSlug: "cockpit-work-board",
    file: "work-board.png",
    theme: "dark",
    title: "Work · Board",
    description: "Tasks and runs across their lifecycle, with history and schedules one tab away.",
  },
  {
    slug: "work-schedules",
    routeSlug: "cockpit-work-schedules",
    file: "work-schedules.png",
    theme: "dark",
    title: "Work · Schedules",
    description: "Governed recurring automations with their cadence, state, and run history.",
  },
  {
    slug: "library-capabilities",
    routeSlug: "cockpit-library-capabilities",
    file: "library-capabilities.png",
    theme: "dark",
    title: "Library · Capabilities",
    description: "Inspectable skills, tools, MCP servers, and channels with trust and provenance.",
  },
  {
    slug: "system-health",
    routeSlug: "cockpit-system-health",
    file: "system-health.png",
    theme: "dark",
    title: "System · Health",
    description: "Gateway, database, provider, and backup health at a glance.",
  },
  {
    slug: "settings-citadel",
    routeSlug: "cockpit-settings-citadel",
    anchor: "citadel-overview",
    file: "settings-citadel.png",
    theme: "dark",
    title: "Settings · Citadel",
    description: "Citadel charter, wards, council, vault, and blueprint posture.",
  },
  {
    slug: "settings-safety",
    routeSlug: "cockpit-settings-safety",
    file: "settings-safety.png",
    theme: "dark",
    title: "Settings · Safety",
    description: "Permissions, tool approval mode and grants, trust policy, hooks, and budgets.",
  },
  {
    slug: "first-run",
    routeSlug: "cockpit-first-run",
    file: "first-run.png",
    theme: "light",
    title: "First-run setup",
    description: "Guided setup from a fresh install to a first answer.",
  },
]);

export function resolvePublicScreenshotTargets(
  seed,
  targets = PUBLIC_SCREENSHOT_TARGETS,
  manifest = COCKPIT_VISUAL_MANIFEST,
) {
  const routesBySlug = new Map(manifest.map((route) => [route.slug, route]));
  return targets.map((target) => {
    const routeSlug = target.routeSlug ?? target.slug;
    const route = routesBySlug.get(routeSlug);
    if (!route) {
      throw new Error(`Missing Mission Control Cockpit route manifest entry for screenshot target ${target.slug}.`);
    }
    const sessionId = target.sessionKey ? seed?.[target.sessionKey] : undefined;
    if (target.sessionKey && !sessionId) {
      throw new Error(`Missing seeded ${target.sessionKey} for screenshot target ${target.slug}.`);
    }
    const shellHref = withHash(withQueryParam(route.href, "shell", route.shell ?? "cockpit"), target.anchor);
    return {
      ...target,
      theme: target.theme ?? "dark",
      href: sessionId ? withQueryParam(shellHref, "sessionId", sessionId) : shellHref,
      fullscreen: route.fullscreen === true,
      readySelector: route.readySelector,
      readyText: target.readyText ?? route.readyText,
      settleMs: route.settleMs,
      scrollY: route.scrollY,
    };
  });
}

function withHash(href, anchor) {
  return anchor ? `${href}#${encodeURIComponent(anchor)}` : href;
}

function withQueryParam(href, key, value) {
  const url = new URL(href, "http://goatcitadel.local");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}
