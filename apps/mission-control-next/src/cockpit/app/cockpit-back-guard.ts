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
const SHEET_ENTRY = "goatcitadel.cockpit.sheet";
type SheetEntry = { id: string; close?: () => void; base: Entry; position: number; active: boolean };
const sheets: SheetEntry[] = [];
const sheetEntries = new Map<string, SheetEntry>();
let sheetSerial = 0;
let sheetRestore: { target: Entry; after?: () => void } | null = null;
let knownLastPosition = 0;
const pendingSheets: (() => void)[] = [];
function sheetId(): string | undefined {
  const value = window.history.state?.[SHEET_ENTRY];
  return typeof value === "string" && /^\d+:\d+$/u.test(value) ? value : undefined;
}
function orphanedSheetBase(entry: Entry): Entry | null {
  const id = sheetId();
  if (!id || sheetEntries.has(id) || entry.position === null || entry.position <= 0) return null;
  const base = { href: entry.href, position: entry.position - 1 };
  // Remember only navigation metadata so Forward can also skip the orphan.
  sheetEntries.set(id, { id, base, position: entry.position, active: false });
  return base;
}
/** A temporary same-document entry catches Back even after a full-document entry or reload. */
export function registerCockpitSheetBack(close: () => void): () => void {
  if (sheetRestore) {
    // React StrictMode and opening another sheet can remount before the
    // browser finishes an earlier cleanup traversal. Push only after it lands.
    let disposed = false, cleanup: (() => void) | undefined;
    pendingSheets.push(() => { if (!disposed) cleanup = registerCockpitSheetBack(close); });
    return () => { disposed = true; cleanup?.(); };
  }
  const base = stampShownEntry();
  for (const [id, previous] of sheetEntries) {
    if (!previous.active && previous.position > base.position!) sheetEntries.delete(id);
  }
  const entry: SheetEntry = { id: `${Date.now()}:${++sheetSerial}`, close, base, position: base.position! + 1, active: true };
  sheets.push(entry); sheetEntries.set(entry.id, entry);
  window.history.pushState({ ...window.history.state, [SHELL_HISTORY_POSITION]: entry.position, [SHEET_ENTRY]: entry.id }, "", base.href);
  knownLastPosition = entry.position;
  follow(liveEntry());
  return () => {
    const index = sheets.indexOf(entry); if (index >= 0) sheets.splice(index, 1);
    const wasActive = entry.active; entry.active = false; entry.close = undefined;
    if (wasActive && sheetId() === entry.id && !sheetRestore) {
      sheetRestore = { target: entry.base };
      window.history.go(-1);
    }
  };
}

/** Complete an already-reviewed navigation from the real page entry, not a sheet duplicate. */
export function afterCockpitSheetsClose(after: () => void): boolean {
  if (sheetRestore) { sheetRestore.after = after; return true; }
  const current = sheetEntries.get(sheetId() ?? "");
  if (!current) return false;
  let target = current.base;
  for (const entry of sheets) if (entry.active && entry.base.position! < target.position!) target = entry.base;
  sheetRestore = { target, after };
  for (const entry of [...sheets].reverse()) {
    if (!entry.active) continue;
    entry.active = false;
    const close = entry.close; entry.close = undefined; close?.();
  }
  // Closing a route-backed sheet can request its own cleanup URL. The
  // already-reviewed destination remains the final navigation for this action.
  sheetRestore.after = after;
  window.history.go(target.position! - current.position);
  return true;
}
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
  if (entry.position !== null) { lastPosition = entry.position; knownLastPosition = Math.max(knownLastPosition, entry.position); }
  restoring = null;
  frozen = null;
  allowed = null;
  expected = [];
}

function expectHashChange(from: string, to: string) {
  if (from !== to) expected = [...expected.slice(-7), { from, to }];
}

function openReview(target: Entry, traverse: boolean) {
  const sheet = sheets.filter(entry => entry.active).at(-1);
  if (sheet) { sheet.close?.(); return; }
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

/** A history-menu jump is not a sheet close landing. Keep the page frozen
 * while returning to the intended base; the next route Back uses the leave owner. */
function restoreSheetBase(event: Event, target: Entry): boolean {
  const restore = sheetRestore!;
  const delta = target.position === null || restore.target.position === null ? 0 : restore.target.position - target.position;
  if (!delta || Math.abs(delta) >= window.history.length) return false;
  event.stopImmediatePropagation();
  restore.after = undefined;
  frozen = locationOf(restore.target.href);
  expectHashChange(shown?.href ?? restore.target.href, target.href);
  expectHashChange(target.href, restore.target.href);
  window.history.go(delta);
  return true;
}

function onPopState(event: Event) {
  const target = liveEntry();
  if (sheetRestore && (target.position !== sheetRestore.target.position || target.href !== sheetRestore.target.href)) {
    if (restoreSheetBase(event, target)) return;
    // Without a trustworthy restoring delta, this remains a route traversal:
    // cancel stale cleanup and let the existing guard/notification path own it.
    sheetRestore = null;
    pendingSheets.splice(0);
  }
  if (sheetRestore) {
    event.stopImmediatePropagation();
    const restore = sheetRestore;
    const retiredTarget = sheetEntries.get(sheetId() ?? "");
    const retiredBase = retiredTarget && !retiredTarget.active ? retiredTarget.base : orphanedSheetBase(target);
    if (retiredBase) {
      restore.target = retiredBase;
      window.history.go(-1);
      return;
    }
    sheetRestore = null;
    const pendingHashes = expected;
    follow(target);
    expected = pendingHashes;
    const waiting = pendingSheets.splice(0);
    waiting.forEach(register => register());
    restore.after?.();
    return;
  }
  if (owner && shown && restoring) {
    event.stopImmediatePropagation();
    land(target);
    return;
  }
  const top = sheets.filter(entry => entry.active).at(-1);
  if (top && shown?.position === top.position && target.position !== top.position) {
    top.active = false;
    const close = top.close; top.close = undefined;
    if (target.position !== top.base.position || target.href !== top.base.href) {
      sheetRestore = { target: top.base };
      frozen = locationOf(top.base.href);
      close?.();
      if (restoreSheetBase(event, target)) return;
      sheetRestore = null;
      // An unnumbered/untrustworthy target must still reach the dirty owner.
    } else {
      event.stopImmediatePropagation();
      follow(target);
      close?.();
      const retiredTarget = sheetEntries.get(sheetId() ?? "");
      if (retiredTarget && !retiredTarget.active) {
        sheetRestore = { target: retiredTarget.base };
        window.history.go(-1);
      }
      return;
    }
  }
  const retired = sheetEntries.get(sheetId() ?? "");
  if (retired && !retired.active && shown) {
    event.stopImmediatePropagation();
    const forward = target.position! > shown.position!;
    // A closed sheet is never a second route stop. If no known forward route
    // follows it, return to the current page instead of exposing a dead entry.
    if (forward && target.position! >= knownLastPosition) {
      sheetRestore = { target: shown };
      window.history.go(shown.position! - target.position!);
    } else window.history.go(forward ? 1 : -1);
    return;
  }
  if (!owner || !shown) return;
  const confirmed = allowed;
  allowed = null;
  if (
    (confirmed && isEntry(target, confirmed)) ||
    (!(sheets.some(entry => entry.active) && shown.href !== target.href) && (samePage(shown.href, target.href) ||
    !owner.holds(shown.href, target.href)))
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
  // Reload does not restore an open sheet. Remove its same-document overlay
  // entry before the next interaction; keep the underlying route/state intact.
  const orphan = orphanedSheetBase(liveEntry());
  if (orphan && !sheetRestore) {
    sheetRestore = { target: orphan };
    window.history.go(-1);
  }
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
