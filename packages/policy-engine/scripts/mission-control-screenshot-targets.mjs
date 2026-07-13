import { NEXT_RELEASE_SURFACE_MANIFEST } from "../../../scripts/verification/lib/release-surface-manifest.mjs";

export const PUBLIC_SCREENSHOT_TARGETS = Object.freeze([
  {
    slug: "chat",
    routeSlug: "chat",
    sessionKey: "sessionId",
    file: "chat.png",
    title: "Chat",
    description: "Fast conversation with runtime context, citations, attachments, and tool visibility close at hand.",
    readyText: "1.0 release prep",
  },
  {
    slug: "cowork",
    routeSlug: "chat",
    sessionKey: "coworkSessionId",
    file: "cowork.png",
    title: "Chat · Agentic work",
    description: "Supervised agentic work with approvals, checkpoints, delegation lineage, and synthesis status.",
    readyText: "Launch supervision plan",
  },
  {
    slug: "code",
    routeSlug: "chat",
    sessionKey: "codeSessionId",
    file: "code.png",
    title: "Chat · Code capability",
    description: "Implementation, review, debugging, and governed Code Mode execution launched from Chat.",
    readyText: "Installer proof checklist",
  },
  {
    slug: "projects",
    routeSlug: "projects",
    file: "projects.png",
    title: "Projects",
    description: "Workspace and project containers that group Chat threads and related evidence.",
    readyText: "Release readiness",
  },
  {
    slug: "library-citadel-overview",
    routeSlug: "library-citadel-overview",
    file: "library-citadel-overview.png",
    title: "Citadel / Overview",
    description: "Citadel charter, wards, council, blueprint, and vault posture for the active operating space.",
  },
  {
    slug: "library-capabilities",
    routeSlug: "library-capabilities",
    file: "library-capabilities.png",
    title: "Library / Capabilities",
    description: "Inspectable capability, skill, tool, provider, MCP, and channel evidence.",
  },
  {
    slug: "ops-runtime",
    routeSlug: "ops-runtime",
    file: "ops-runtime.png",
    title: "Ops / Runtime",
    description: "Operational health, runtime posture, diagnostics, and source-status truth.",
  },
  {
    slug: "settings-providers",
    routeSlug: "settings-providers",
    file: "settings-providers.png",
    title: "Settings / Providers",
    description: "Provider and model setup with key-on-file truth and safe local defaults.",
  },
]);

export function resolvePublicScreenshotTargets(
  seed,
  targets = PUBLIC_SCREENSHOT_TARGETS,
  manifest = NEXT_RELEASE_SURFACE_MANIFEST,
) {
  const routesBySlug = new Map(manifest.map((route) => [route.slug, route]));
  return targets.map((target) => {
    const routeSlug = target.routeSlug ?? target.slug;
    const route = routesBySlug.get(routeSlug);
    if (!route) {
      throw new Error(`Missing Mission Control Next route manifest entry for screenshot target ${target.slug}.`);
    }
    const sessionId = target.sessionKey ? seed?.[target.sessionKey] : undefined;
    if (target.sessionKey && !sessionId) {
      throw new Error(`Missing seeded ${target.sessionKey} for screenshot target ${target.slug}.`);
    }
    return {
      ...target,
      href: sessionId ? withQueryParam(route.href, "sessionId", sessionId) : route.href,
      readySelector: route.readySelector,
      readyText: target.readyText ?? route.readyText,
      settleMs: route.settleMs,
      scrollY: route.scrollY,
    };
  });
}

function withQueryParam(href, key, value) {
  const url = new URL(href, "http://goatcitadel.local");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}
