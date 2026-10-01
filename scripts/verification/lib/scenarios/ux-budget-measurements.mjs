import { NEXT_RELEASE_SURFACE_MANIFEST } from "../release-surface-manifest.mjs";

export const TOAST_SETTLE_MS = 5_000;

export const UX_BUDGET_ROUTE_SLUGS = Object.freeze([
  "chat",
  "projects",
  "library-skills",
  "library-capabilities",
  "ops-activity",
  "ops-approvals",
  "settings-onboarding",
  "settings-providers",
  "settings-trust-policy",
]);
export const COCKPIT_ROUTES = Object.freeze([
  "/chat",
  "/inbox",
  "/work",
  "/work/history",
  "/work/schedules",
  "/library",
  "/system",
  "/system/spend",
  "/system/quality",
  "/system/diagnostics",
  "/system/activity",
  "/system/dashboards",
  "/settings/general",
  "/settings/models",
  "/settings/first-run",
  "/__gallery",
]);
export const UX_BUDGET_ENFORCEMENT_DEFAULTS = Object.freeze({ chatBudget: true, railReach: true });

export const CHAT_VIEWPORTS = Object.freeze([
  { variant: "desktop", viewport: { width: 1440, height: 900 } },
  { variant: "mobile", viewport: { width: 390, height: 844 } },
]);

export const COPY_EXEMPT_SELECTOR = [
  "code",
  "pre",
  "kbd",
  "samp",
  "textarea",
  "input",
  "select",
  "script",
  "style",
  "[data-copy-exempt]",
  ".mc-assistant-renderer",
  ".mc-next-technical-detail",
].join(", ");

export function collectVisibleUiText(exemptSelector) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent?.trim();
    const parent = node.parentElement;
    if (!value || !parent || parent.closest(exemptSelector)) continue;
    const closedDetails = parent.closest("details:not([open])");
    if (closedDetails && !closedDetails.querySelector(":scope > summary")?.contains(parent)) continue;
    const style = getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
    parts.push(value);
  }
  return parts.join("\n");
}

export function measureLayout() {
  const scroller = document.querySelector(".mc-next-thread-scroll");
  const rail = document.querySelector(".mc-next-rail");
  const railRect = rail?.getBoundingClientRect();
  return {
    viewportHeight: window.innerHeight,
    scrollerHeight: scroller?.clientHeight ?? 0,
    railVisible: Boolean(railRect && railRect.width > 0 && getComputedStyle(rail).display !== "none"),
    railBottom: railRect?.bottom ?? 0,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    toastCount: document.querySelectorAll(".notification-stack .notification-item").length,
    heights: Object.fromEntries(
      [
        ".mc-next-topbar",
        ".mc-next-thread-header",
        ".mc-next-thread-status-lane",
        ".mc-next-thread-scroll",
        ".mc-next-composer",
        ".mc-next-composer-blocking-prompt",
      ].map((selector) => [
        selector,
        Math.round(document.querySelector(selector)?.getBoundingClientRect().height ?? 0),
      ]),
    ),
  };
}

export function manifestEntry(slug) {
  const entry = NEXT_RELEASE_SURFACE_MANIFEST.find((candidate) => candidate.slug === slug);
  if (!entry) throw new Error(`UX budget route missing from release manifest: ${slug}`);
  return entry;
}
