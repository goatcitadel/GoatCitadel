import { SHELL_NAVIGATION_EVENTS } from "../../app/shell-transition";
import { buildSettingsIndex } from "../areas/settings/settings-index";
import type { CockpitNavigationOptions } from "./cockpit-navigation-context";

export const COCKPIT_LOCATION_EVENT = "goatcitadel:cockpit-location";
const listeners = new Set<() => void>();
let generation = 0;

function locationChanged() {
  generation += 1;
  listeners.forEach((listener) => listener());
}

export function subscribeCockpitHistory(listener: () => void) {
  if (listeners.size === 0) {
    for (const name of SHELL_NAVIGATION_EVENTS) window.addEventListener(name, locationChanged);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      for (const name of SHELL_NAVIGATION_EVENTS) window.removeEventListener(name, locationChanged);
    }
  };
}

export function readCockpitHistory() {
  return `${generation}:${window.location.href}`;
}

/** Normalize only local native URLs. Preserve record IDs, the full query, and the hash. */
export function cockpitHref(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return null;
  try {
    const target = new URL(href, "http://cockpit.invalid");
    if (target.origin !== "http://cockpit.invalid" || target.username || target.password) return null;
    if (target.searchParams.getAll("shell").some((shell) => shell !== "cockpit")) return null;
    target.searchParams.set("shell", "cockpit");
    return target.pathname + target.search + target.hash;
  } catch {
    return null;
  }
}

/** Settings force-mounts its sections. Only a recognized tab on the same actual page stays mounted. */
export function retainsSettingsPage(from: string, to: string): boolean {
  const sourceHref = cockpitHref(from), targetHref = cockpitHref(to);
  if (!sourceHref || !targetHref) return false;
  const source = new URL(sourceHref, "http://cockpit.invalid");
  const target = new URL(targetHref, "http://cockpit.invalid");
  if (source.pathname !== target.pathname || source.search !== target.search || source.hash === target.hash) return false;
  const page = buildSettingsIndex().find((candidate) => source.pathname === `/settings/${candidate.id}`);
  return Boolean(page && page.entries.some((entry) => {
    const entryHref = new URL(entry.href, "http://cockpit.invalid");
    return entry.destination === "cockpit" && entryHref.pathname === target.pathname && entryHref.hash === target.hash;
  }));
}

/** Internal commit for current reviewed frame/link capabilities and bound canonical Chat synchronization. */
export function commitCockpitNavigation(href: string, options?: CockpitNavigationOptions): boolean {
  const destination = cockpitHref(href);
  if (!destination) return false;
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (cockpitHref(current) === destination) return false;
  if (options?.replace) window.history.replaceState(window.history.state, "", destination);
  else window.history.pushState(null, "", destination);
  window.dispatchEvent(new Event(COCKPIT_LOCATION_EVENT));
  return true;
}
