// @vitest-environment happy-dom
import type { Window as HappyDomWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SHELL_HISTORY_POSITION } from "../../app/shell-transition";
import {
  COCKPIT_LOCATION_EVENT,
  readCockpitLocation,
  registerCockpitBackGuard,
  registerCockpitSheetBack,
  type CockpitBackGuardOwner,
} from "./cockpit-back-guard";
import { commitCockpitNavigation } from "./cockpit-history";

type TestOwner = { holds: Mock<CockpitBackGuardOwner["holds"]>; review: Mock<CockpitBackGuardOwner["review"]> };

let unregister: (() => void) | undefined;
let seen: string[] = [];
const later = () => seen.push(window.location.pathname);
const here = () => window.location.pathname + window.location.search + window.location.hash;
const position = () => (window.history.state as Record<string, unknown> | null)?.[SHELL_HISTORY_POSITION];

function register(holds = true): TestOwner {
  const owner: TestOwner = { holds: vi.fn(() => holds), review: vi.fn() };
  unregister = registerCockpitBackGuard(owner);
  return owner;
}
function proceedOf(owner: TestOwner, call = 0): () => void {
  return owner.review.mock.calls[call]![0];
}
/** Browsers apply a traversal in a later task. Happy DOM applies it inside go(), so defer it here. */
function deferTraversals() {
  const go = window.history.go.bind(window.history);
  vi.spyOn(window.history, "go").mockImplementation((delta) => {
    setTimeout(() => go(delta));
  });
}
async function settle() {
  await (window as unknown as Pick<HappyDomWindow, "happyDOM">).happyDOM.waitUntilComplete();
}

beforeEach(async () => {
  window.history.replaceState(null, "", "/work");
  await settle();
  seen = [];
});
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  window.removeEventListener("popstate", later);
  vi.restoreAllMocks();
  await settle();
});

describe("cockpit Back and Forward gate", () => {
  it("sends an unnumbered skipped-base target through the existing dirty owner", async () => {
    const owner = register(true);
    window.history.pushState(null, "", "/legacy");
    window.dispatchEvent(new Event(COCKPIT_LOCATION_EVENT));
    commitCockpitNavigation("/settings/models#local-ai");
    const close = vi.fn(), cleanup = registerCockpitSheetBack(close);
    try {
      window.history.go(-2); await settle();
      expect(close).toHaveBeenCalledOnce();
      expect(here()).toBe("/settings/models?shell=cockpit#local-ai");
      expect(owner.holds).toHaveBeenCalled(); expect(owner.review).toHaveBeenCalledOnce();
    } finally { cleanup(); }
  });
  it.each(["initial document", "reloaded document", "SPA entry"])("gives an open sheet its own same-document Back entry after %s", async entryKind => {
    const owner = register(false);
    const destination = "/settings/models?shell=cockpit&workspaceId=scope%3Aa&view=llamacpp#local-ai";
    if (entryKind === "SPA entry") commitCockpitNavigation(destination);
    else {
      // Simulate the current entry belonging to a newly loaded document. Its
      // predecessor cannot safely be intercepted by this document's popstate.
      unregister?.();
      window.history.pushState({ retained: { entryKind } }, "", destination);
      register(false);
    }
    const state = structuredClone(window.history.state), length = window.history.length;
    const close = vi.fn();
    const cleanup = registerCockpitSheetBack(close);
    try {
    expect(window.history.length).toBe(length + 1);
    expect(here()).toBe(destination);
    window.history.back(); await settle();
    expect(close).toHaveBeenCalledOnce(); expect(here()).toBe(destination);
    expect(window.history.state).toEqual(state); expect(owner.review).not.toHaveBeenCalled();
    cleanup();
    window.history.back(); await settle(); expect(here()).toBe("/work");
    window.history.forward(); await settle(); expect(here()).toBe(destination);
    } finally { cleanup(); }
  });
  it("retires explicit Close/Escape entries so ordinary Back and Forward have no duplicate route stop", async () => {
    register(false); commitCockpitNavigation("/settings/models?view=llamacpp#local-ai");
    const destination = here();
    for (const _gesture of ["Close", "Escape"]) {
      const close = vi.fn(), cleanup = registerCockpitSheetBack(close);
      cleanup(); await settle();
      expect(here()).toBe(destination); expect(close).not.toHaveBeenCalled();
      window.history.back(); await settle(); expect(here()).toBe("/work");
      window.history.forward(); await settle(); expect(here()).toBe(destination);
    }
  });
  it("commits navigation only after removing sheet entries and retains dirty-review ownership", async () => {
    const owner = register(false); commitCockpitNavigation("/settings/models#local-ai");
    const close = vi.fn(), cleanup = registerCockpitSheetBack(close);
    commitCockpitNavigation("/settings/connections#mcp-servers"); await settle(); cleanup();
    expect(here()).toBe("/settings/connections?shell=cockpit#mcp-servers");
    window.history.back(); await settle(); expect(here()).toBe("/settings/models?shell=cockpit#local-ai");
    window.history.back(); await settle(); expect(here()).toBe("/work");
    expect(owner.review).not.toHaveBeenCalled();
  });
  it("handles a StrictMode cleanup/remount while traversal is deferred", async () => {
    register(false); commitCockpitNavigation("/settings/models#local-ai");
    deferTraversals();
    const first = registerCockpitSheetBack(vi.fn()); first();
    const close = vi.fn(), cleanup = registerCockpitSheetBack(close);
    await settle(); window.history.back(); await settle();
    expect(close).toHaveBeenCalledOnce(); expect(here()).toBe("/settings/models?shell=cockpit#local-ai");
    cleanup(); window.history.back(); await settle(); expect(here()).toBe("/work");
  });
  it("skips a lower sheet retired under the top and restores ordinary history", async () => {
    register(false); commitCockpitNavigation("/settings/models#local-ai");
    const lower = registerCockpitSheetBack(vi.fn());
    const close = vi.fn(), upper = registerCockpitSheetBack(close);
    lower(); window.history.back(); await settle(); upper();
    expect(close).toHaveBeenCalledOnce(); expect(here()).toBe("/settings/models?shell=cockpit#local-ai");
    window.history.back(); await settle(); expect(here()).toBe("/work");
  });
  it("does not expose a retired sheet as a Forward route stop", async () => {
    register(false); commitCockpitNavigation("/settings/models#local-ai");
    const cleanup = registerCockpitSheetBack(vi.fn()); cleanup(); await settle();
    const state = structuredClone(window.history.state);
    window.history.forward(); await settle(); expect(window.history.state).toEqual(state);
    window.history.back(); await settle(); expect(here()).toBe("/work");
  });
  it("rechecks the existing navigation capability after a deferred sheet close", async () => {
    register(false); commitCockpitNavigation("/settings/models#local-ai");
    deferTraversals(); const cleanup = registerCockpitSheetBack(vi.fn());
    let current = true;
    commitCockpitNavigation("/settings/connections", undefined, () => current);
    current = false; await settle(); cleanup();
    expect(here()).toBe("/settings/models?shell=cockpit#local-ai");
  });
  it("preserves replacement semantics after closing the sheet", async () => {
    register(false); commitCockpitNavigation("/settings/models#local-ai");
    const cleanup = registerCockpitSheetBack(vi.fn());
    commitCockpitNavigation("/settings/connections", { replace: true }); await settle(); cleanup();
    expect(here()).toBe("/settings/connections?shell=cockpit");
    window.history.back(); await settle(); expect(here()).toBe("/work");
  });
  it("removes orphan sheet entries retained by a document reload before opening another sheet", async () => {
    register(false); commitCockpitNavigation("/settings/models#local-ai");
    const base = structuredClone(window.history.state), destination = here();
    unregister?.();
    window.history.pushState({ ...base, [SHELL_HISTORY_POSITION]: Number(base[SHELL_HISTORY_POSITION]) + 1,
      "goatcitadel.cockpit.sheet": "1700000000000:999" }, "", destination);
    register(false); await settle();
    expect(window.history.state).toEqual(base);
    window.history.forward(); await settle(); expect(window.history.state).toEqual(base);
    const close = vi.fn(), cleanup = registerCockpitSheetBack(close);
    window.history.back(); await settle(); cleanup(); expect(close).toHaveBeenCalledOnce();
    expect(window.history.state).toEqual(base);
    window.history.back(); await settle(); expect(here()).toBe("/work");
  });
  it("closes the top sheet and restores the shown entry before any dirty leave review", async () => {
    const owner = register(true);
    commitCockpitNavigation("/library");
    const lower = vi.fn(); const top = vi.fn();
    const removeLower = registerCockpitSheetBack(lower); const removeTop = registerCockpitSheetBack(top);
    try {
      deferTraversals(); window.history.back();
      await vi.waitFor(() => expect(top).toHaveBeenCalledOnce());
      expect(here()).toBe("/library?shell=cockpit");
      expect(lower).not.toHaveBeenCalled(); expect(owner.review).not.toHaveBeenCalled();
      removeTop(); window.history.back();
      await vi.waitFor(() => expect(lower).toHaveBeenCalledOnce());
      expect(here()).toBe("/library?shell=cockpit");
    } finally { removeTop(); removeLower(); }
  });
  it("passes every move through while no owner is registered", () => {
    window.history.pushState(null, "", "/library");
    window.addEventListener("popstate", later);
    window.history.back();
    expect(here()).toBe("/work");
    expect(seen).toEqual(["/work"]);
    expect(readCockpitLocation()).toBe(window.location);
  });

  it("numbers the shown entry when it registers and each cockpit push after it", () => {
    window.history.replaceState({ retained: "entry" }, "", "/work");
    register(false);
    const start = position();
    expect(window.history.state).toEqual({ retained: "entry", [SHELL_HISTORY_POSITION]: start });
    expect(typeof start).toBe("number");
    commitCockpitNavigation("/library");
    expect(position()).toBe((start as number) + 1);
    commitCockpitNavigation("/library?type=tool", { replace: true });
    expect(position()).toBe((start as number) + 1);
    unregister?.();
    register(false);
    expect(position()).toBe((start as number) + 1);
  });

  it("swallows a held move and keeps the views on the source page until the restore lands", async () => {
    const owner = register();
    commitCockpitNavigation("/library");
    deferTraversals();
    window.addEventListener("popstate", later);
    window.history.back();
    expect(window.location.pathname).toBe("/work");
    expect(readCockpitLocation().pathname).toBe("/library");
    expect(readCockpitLocation().search).toBe("?shell=cockpit");
    expect(owner.review).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(owner.review).toHaveBeenCalledTimes(1));
    expect(here()).toBe("/library?shell=cockpit");
    expect(readCockpitLocation()).toBe(window.location);
    expect(owner.holds).toHaveBeenCalledWith("/library?shell=cockpit", "/work");
    expect(seen).toEqual([]);
  });

  it("lets the confirmed traversal through without asking again, while the kept draft stays dirty", async () => {
    const owner = register();
    commitCockpitNavigation("/library");
    const length = window.history.length;
    deferTraversals();
    window.history.back();
    await vi.waitFor(() => expect(owner.review).toHaveBeenCalledTimes(1));
    owner.holds.mockClear();
    window.addEventListener("popstate", later);
    proceedOf(owner)();
    await vi.waitFor(() => expect(seen).toEqual(["/work"]));
    expect(here()).toBe("/work");
    expect(owner.holds).not.toHaveBeenCalled();
    expect(window.history.length).toBe(length);
    window.history.forward();
    await vi.waitFor(() => expect(owner.review).toHaveBeenCalledTimes(2));
    expect(here()).toBe("/work");
    expect(seen).toEqual(["/work"]);
  });

  it("does not consult the owner for a hash-only move, wherever shell=cockpit appears", () => {
    window.history.replaceState(null, "", "/work#a");
    const owner = register();
    commitCockpitNavigation("/work#b");
    window.addEventListener("popstate", later);
    window.history.back();
    expect(here()).toBe("/work#a");
    expect(owner.holds).not.toHaveBeenCalled();
    expect(seen).toEqual(["/work"]);
  });

  it("puts the source URL on an entry without a position, and proceeding writes the destination back", () => {
    const owner = register();
    window.history.pushState(null, "", "/legacy");
    window.dispatchEvent(new Event(COCKPIT_LOCATION_EVENT));
    commitCockpitNavigation("/library");
    const length = window.history.length;
    window.addEventListener("popstate", later);
    window.history.back();
    expect(here()).toBe("/library?shell=cockpit");
    expect(owner.review).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    expect(window.history.length).toBeLessThanOrEqual(length);
    const located = vi.fn();
    window.addEventListener(COCKPIT_LOCATION_EVENT, located);
    proceedOf(owner)();
    window.removeEventListener(COCKPIT_LOCATION_EVENT, located);
    expect(here()).toBe("/legacy");
    expect(located).toHaveBeenCalledTimes(1);
    expect(window.history.length).toBeLessThanOrEqual(length);
  });

  it("falls back to the source URL when a restore lands on another entry", () => {
    const owner = register();
    commitCockpitNavigation("/a");
    commitCockpitNavigation("/b");
    // An inconsistent number on the shown entry sends the restore the wrong way.
    window.history.replaceState({ [SHELL_HISTORY_POSITION]: (position() as number) - 2 }, "");
    window.dispatchEvent(new Event(COCKPIT_LOCATION_EVENT));
    window.addEventListener("popstate", later);
    window.history.back();
    expect(here()).toBe("/b?shell=cockpit");
    expect(owner.review).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    proceedOf(owner)();
    expect(here()).toBe("/a?shell=cockpit");
  });

  it("never shows the target of a second Back that arrives during a restore", async () => {
    const owner = register();
    commitCockpitNavigation("/a");
    commitCockpitNavigation("/b");
    deferTraversals();
    window.addEventListener("popstate", later);
    window.history.back();
    window.history.back();
    expect(readCockpitLocation().pathname).toBe("/b");
    await settle();
    expect(window.location.pathname).toBe("/b");
    expect(readCockpitLocation()).toBe(window.location);
    expect(owner.review).toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("clears the hold when its owner unregisters mid-restore", async () => {
    const owner = register();
    commitCockpitNavigation("/library");
    deferTraversals();
    window.addEventListener("popstate", later);
    window.history.back();
    expect(readCockpitLocation().pathname).toBe("/library");
    unregister?.();
    unregister = undefined;
    expect(readCockpitLocation()).toBe(window.location);
    await vi.waitFor(() => expect(seen).toEqual(["/library"]));
    expect(owner.review).not.toHaveBeenCalled();
  });

  it("swallows the hashchange events of a held move and its restore, but not those of a later move", async () => {
    const owner = register();
    commitCockpitNavigation("/hooks#signing");
    await settle();
    const hashes: string[] = [];
    const record = (event: HashChangeEvent) =>
      hashes.push(`${new URL(event.oldURL).pathname} -> ${new URL(event.newURL).pathname}`);
    window.addEventListener("hashchange", record);
    window.history.back();
    await settle();
    expect(hashes).toEqual([]);
    expect(here()).toBe("/hooks?shell=cockpit#signing");
    proceedOf(owner)();
    await settle();
    window.removeEventListener("hashchange", record);
    expect(here()).toBe("/work");
    expect(hashes).toEqual(["/hooks -> /work"]);
  });
});
