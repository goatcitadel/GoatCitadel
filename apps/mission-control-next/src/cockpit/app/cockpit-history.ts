import { resolveCockpitCompatibility } from "./cockpit-compatibility";
import { SHELL_HISTORY_POSITION, SHELL_NAVIGATION_EVENTS } from "../../app/shell-transition";
import { buildSettingsIndex } from "../areas/settings/settings-index";
import { COCKPIT_LOCATION_EVENT, afterCockpitSheetsClose, nextCockpitPosition, readCockpitLocation } from "./cockpit-back-guard";
import type { CockpitNavigationOptions } from "./cockpit-navigation-context";

export { COCKPIT_LOCATION_EVENT };
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
  return `${generation}:${readCockpitLocation().href}`;
}

/** Normalize only local native URLs. Preserve record IDs, the full query, and the hash. */
export function cockpitHref(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return null;
  try {
    const resolution = resolveCockpitCompatibility(href);
    const target = new URL(resolution.kind === "native" ? resolution.href : href, "http://cockpit.invalid");
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
  const sourceHref = cockpitHref(from),
    targetHref = cockpitHref(to);
  if (!sourceHref || !targetHref) return false;
  const source = new URL(sourceHref, "http://cockpit.invalid");
  const target = new URL(targetHref, "http://cockpit.invalid");
  if (source.pathname !== target.pathname || source.search !== target.search || source.hash === target.hash)
    return false;
  const page = buildSettingsIndex().find((candidate) => source.pathname === `/settings/${candidate.id}`);
  return Boolean(
    page &&
    page.entries.some((entry) => {
      const entryHref = new URL(entry.href, "http://cockpit.invalid");
      return (
        entry.destination === "cockpit" && entryHref.pathname === target.pathname && entryHref.hash === target.hash
      );
    }),
  );
}

/** Internal commit for current reviewed frame/link capabilities and bound canonical Chat synchronization. */
export function commitCockpitNavigation(href: string, options?: CockpitNavigationOptions, isCurrent: () => boolean = () => true): boolean {
  if (!isCurrent()) return false;
  const destination = cockpitHref(href);
  if (!destination) return false;
  const current = window.location.pathname + window.location.search + window.location.hash;
  const actual = new URL(current, "http://cockpit.invalid");
  actual.searchParams.set("shell", "cockpit");
  if (actual.pathname + actual.search + actual.hash === destination) return false;
  if (afterCockpitSheetsClose(() => commitCockpitNavigation(href, options, isCurrent))) return true;
  // A replaced entry keeps its state, position included. A pushed entry is numbered after the shown one.
  if (options?.replace) window.history.replaceState(window.history.state, "", destination);
  else window.history.pushState({ [SHELL_HISTORY_POSITION]: nextCockpitPosition() }, "", destination);
  window.dispatchEvent(new Event(COCKPIT_LOCATION_EVENT));
  return true;
}
