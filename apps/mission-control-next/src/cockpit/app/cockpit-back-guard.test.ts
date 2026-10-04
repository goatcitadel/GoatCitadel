// @vitest-environment happy-dom
import type { Window as HappyDomWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SHELL_HISTORY_POSITION } from "../../app/shell-transition";
import {
  COCKPIT_LOCATION_EVENT,
  readCockpitLocation,
  registerCockpitBackGuard,
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
