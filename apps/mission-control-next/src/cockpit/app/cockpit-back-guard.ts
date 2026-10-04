import { SHELL_HISTORY_POSITION } from "../../app/shell-transition";

/*
 * Browser Back and Forward can't be cancelled, and a real browser lets React re-render between two
 * `popstate` listeners. A listener that sees the new URL can unmount an editor before any later
 * listener decides anything. This gate is added when the module is evaluated, before the cockpit
 * mounts, so it runs ahead of every listener that can schedule a render. When its owner holds a
 * move, the gate swallows it, keeps the views on the page they show, traverses back to that entry
 * and lets the owner review the move. Confirming traverses forward again, so session history stays
 * the same.
 */

export const COCKPIT_LOCATION_EVENT = "goatcitadel:cockpit-location";

export interface CockpitBackGuardOwner {
  /** Whether leaving `from` for `to` needs the leave review. Hash-only moves never reach this. */
  holds(from: string, to: string): boolean;
  /** Open the leave review for a held move, or keep the one that is open. `proceed` reaches the move's target. */
  review(proceed: () => void): void;
}

export type CockpitLocation = Pick<Location, "href" | "pathname" | "search" | "hash">;

type Entry = { href: string; position: number | null };
type HashMove = { from: string; to: string };

let owner: CockpitBackGuardOwner | null = null;
/** The entry the views show. */
let shown: Entry | null = null;
let lastPosition = 0;
/** A held move whose restoring traversal has not landed yet. */
let restoring: Entry | null = null;
/** What the views read while a restore is in flight: the page they already show. */
let frozen: CockpitLocation | null = null;
/** The one confirmed traversal the gate lets through without asking again. */
let allowed: Entry | null = null;
/** Spec-following browsers (and Happy DOM) fire `hashchange` for these traversals; nothing else may see them. */
let expected: readonly HashMove[] = [];

function positionOf(state: unknown): number | null {
  const value = state && typeof state === "object" ? (state as Record<string, unknown>)[SHELL_HISTORY_POSITION] : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pathOf(url: string | URL | Location): string {
  const { pathname, search, hash } = typeof url === "string" ? new URL(url) : url;
  return pathname + search + hash;
}

function liveEntry(): Entry {
  return { href: pathOf(window.location), position: positionOf(window.history.state) };
}

/** Same path and query. The fragment and where or whether `shell=cockpit` appears don't matter. */
function samePage(from: string, to: string): boolean {
  const key = (href: string) => {
    const url = new URL(href, "http://cockpit.invalid");
    const query = new URLSearchParams(url.search);
    if (query.getAll("shell").every((shell) => shell === "cockpit")) query.delete("shell");
    return `${url.pathname}?${query.toString()}`;
  };
  return key(from) === key(to);
}

function isEntry(entry: Entry, expectedEntry: Entry): boolean {
  return entry.position === expectedEntry.position && samePage(entry.href, expectedEntry.href);
}

function follow(entry: Entry) {
  shown = entry;
  if (entry.position !== null) lastPosition = entry.position;
  restoring = null;
  frozen = null;
  allowed = null;
  expected = [];
}

function expectHashChange(from: string, to: string) {
  if (from !== to) expected = [...expected.slice(-7), { from, to }];
}

function openReview(target: Entry, traverse: boolean) {
  const from = shown!;
  owner!.review(() => {
    if (!owner || !shown || !isEntry(shown, from)) return;
    if (traverse) {
      allowed = target;
      window.history.go(target.position! - from.position!);
      return;
    }
    // The entry still holds the target's state; give it back its own URL.
    window.history.replaceState(window.history.state, "", target.href);
    window.dispatchEvent(new Event(COCKPIT_LOCATION_EVENT));
  });
}

/** Show the source URL on the entry the browser is on. Used when no position delta can be trusted. */
function putBack(target: Entry) {
  const source = shown!.href;
  expectHashChange(pathOf(window.location), source);
  window.history.replaceState(window.history.state, "", source);
  shown = { href: source, position: positionOf(window.history.state) };
  openReview(target, false);
}

function hold(target: Entry) {
  const from = shown!;
  expectHashChange(from.href, target.href);
  const delta = from.position === null || target.position === null ? 0 : from.position - target.position;
  if (delta === 0 || Math.abs(delta) >= window.history.length) {
    putBack(target);
    return;
  }
  restoring = target;
  frozen = locationOf(from.href);
  expectHashChange(target.href, from.href);
  // Happy DOM lands inside go(); a browser lands in a later task.
  window.history.go(delta);
}

function land(landing: Entry) {
  const target = restoring!;
  restoring = null;
  frozen = null;
  if (!isEntry(landing, shown!)) {
    putBack(target);
    return;
  }
  shown = landing;
  openReview(target, true);
}

function onPopState(event: Event) {
  if (!owner || !shown) return;
  const target = liveEntry();
  if (restoring) {
    event.stopImmediatePropagation();
    land(target);
    return;
  }
  const confirmed = allowed;
  allowed = null;
  if (
    (confirmed && isEntry(target, confirmed)) ||
    samePage(shown.href, target.href) ||
    !owner.holds(shown.href, target.href)
  ) {
    follow(target);
    return;
  }
  event.stopImmediatePropagation();
  hold(target);
}

function onHashChange(event: Event) {
  const { oldURL, newURL } = event as Partial<HashChangeEvent>;
  if (!owner || typeof oldURL !== "string" || typeof newURL !== "string") return;
  if (!URL.canParse(oldURL) || !URL.canParse(newURL)) return;
  const from = pathOf(oldURL),
    to = pathOf(newURL);
  const index = expected.findIndex((move) => move.from === from && move.to === to);
  if (index < 0) return;
  expected = expected.filter((_, position) => position !== index);
  event.stopImmediatePropagation();
}

/** A cockpit commit is a real navigation: it supersedes any hold and becomes the shown entry. */
function onLocation() {
  const entry = liveEntry();
  if (owner) follow(entry);
  else if (entry.position !== null) lastPosition = entry.position;
}

function locationOf(href: string): CockpitLocation {
  const { href: absolute, pathname, search, hash } = new URL(href, window.location.href);
  return { href: absolute, pathname, search, hash };
}

function stampShownEntry(): Entry {
  const entry = liveEntry();
  if (entry.position !== null) return entry;
  const state: unknown = window.history.state;
  const record = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
  window.history.replaceState({ ...record, [SHELL_HISTORY_POSITION]: lastPosition }, "");
  return { ...entry, position: lastPosition };
}

/** The location render-time readers use: the shown page while a held move is restored, else the live URL. */
export function readCockpitLocation(): CockpitLocation {
  return frozen ?? window.location;
}

/** The number for a new entry pushed after the shown one. */
export function nextCockpitPosition(): number {
  return (shown?.position ?? lastPosition) + 1;
}

/** One owner at a time. The latest registration wins; its cleanup clears any hold in progress. */
export function registerCockpitBackGuard(next: CockpitBackGuardOwner): () => void {
  owner = next;
  follow(stampShownEntry());
  return () => {
    if (owner !== next) return;
    owner = null;
    follow(liveEntry());
    shown = null;
  };
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("popstate", onPopState, { capture: true });
  window.addEventListener("hashchange", onHashChange, { capture: true });
  window.addEventListener(COCKPIT_LOCATION_EVENT, onLocation, { capture: true });
}
