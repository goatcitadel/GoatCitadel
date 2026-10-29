// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLastCapabilitiesTab, writeLastCapabilitiesTab } from "./last-tab-preference";

const KEY = "goatcitadel.cockpit.capabilities.last-tab.v1";

// happy-dom hands out bound wrappers, so a spy on Storage.prototype never intercepts; the instance is spied instead.
// Its spies are restored one by one because restoreAllMocks leaves them in place.
const restores: Array<() => void> = [];
function failing(method: "getItem" | "setItem") {
  const spy = vi.spyOn(window.localStorage, method).mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  restores.push(() => spy.mockRestore());
  return spy;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

describe("last Capabilities tab", () => {
  it("reads nothing before a tab was opened", () => {
    expect(readLastCapabilitiesTab()).toBeUndefined();
  });

  it.each(["skills", "connectors", "tools"] as const)("remembers %s", (tab) => {
    writeLastCapabilitiesTab(tab);
    expect(window.localStorage.getItem(KEY)).toBe(tab);
    expect(readLastCapabilitiesTab()).toBe(tab);
  });

  it("keeps only the latest tab", () => {
    writeLastCapabilitiesTab("tools");
    writeLastCapabilitiesTab("connectors");
    expect(readLastCapabilitiesTab()).toBe("connectors");
  });

  it.each(["plugins", "", "Tools", "Skills", "tools ", "constructor", "__proto__", '{"tab":"tools"}'])(
    "ignores the stored value %j because it names no tab",
    (stored) => {
      window.localStorage.setItem(KEY, stored);
      expect(readLastCapabilitiesTab()).toBeUndefined();
    },
  );

  it("reads nothing when storage cannot be read", () => {
    writeLastCapabilitiesTab("tools");
    const getItem = failing("getItem");
    expect(readLastCapabilitiesTab()).toBeUndefined();
    expect(getItem).toHaveBeenCalledWith(KEY);
  });

  it("does not fail when storage cannot be written", () => {
    const setItem = failing("setItem");
    expect(() => writeLastCapabilitiesTab("tools")).not.toThrow();
    expect(setItem).toHaveBeenCalledWith(KEY, "tools");
    // The failed write left nothing behind to read back.
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("does not fail when the storage object itself is unavailable", () => {
    const getter = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    restores.push(() => getter.mockRestore());
    expect(readLastCapabilitiesTab()).toBeUndefined();
    expect(() => writeLastCapabilitiesTab("connectors")).not.toThrow();
    expect(getter).toHaveBeenCalled();
  });
});
