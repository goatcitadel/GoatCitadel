import { afterEach, describe, expect, it, vi } from "vitest";
import { retireMissionControlServiceWorkers } from "./service-worker-cleanup";

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalCachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");

function defineGlobal(name: "navigator" | "caches" | "location", value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreGlobal(name: "navigator" | "caches" | "location", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

function registration(input: {
  scope?: string;
  active?: string | null;
  waiting?: string | null;
  installing?: string | null;
}) {
  return {
    scope: input.scope ?? "https://mission.local/",
    active: input.active === undefined ? null : { scriptURL: input.active },
    waiting: input.waiting === undefined ? null : { scriptURL: input.waiting },
    installing: input.installing === undefined ? null : { scriptURL: input.installing },
    unregister: vi.fn(async () => true),
  };
}

afterEach(() => {
  restoreGlobal("navigator", originalNavigatorDescriptor);
  restoreGlobal("caches", originalCachesDescriptor);
  restoreGlobal("location", originalLocationDescriptor);
  vi.restoreAllMocks();
});

describe("retireMissionControlServiceWorkers", () => {
  it("returns without service worker support", async () => {
    defineGlobal("navigator", {});
    const deleteCache = vi.fn();
    defineGlobal("caches", {
      keys: vi.fn(async () => ["goatcitadel-mission-control-old"]),
      delete: deleteCache,
    });

    await expect(retireMissionControlServiceWorkers()).resolves.toBeUndefined();

    expect(deleteCache).not.toHaveBeenCalled();
  });

  it("unregisters only same-origin mission-control sw.js registrations and deletes matching caches", async () => {
    const activeMissionControl = registration({ active: "https://mission.local/sw.js" });
    const waitingMissionControl = registration({ waiting: "https://mission.local/nested/sw.js" });
    const installingMissionControl = registration({ installing: "https://mission.local/sw.js" });
    const offOriginScope = registration({
      scope: "https://other.local/",
      active: "https://mission.local/sw.js",
    });
    const offOriginScript = registration({ active: "https://cdn.local/sw.js" });
    const wrongScriptName = registration({ active: "https://mission.local/service-worker.js" });
    const malformedScript = registration({ active: "not a url" });
    const missingScript = registration({});
    const registrations = [
      activeMissionControl,
      waitingMissionControl,
      installingMissionControl,
      offOriginScope,
      offOriginScript,
      wrongScriptName,
      malformedScript,
      missingScript,
    ];
    const getRegistrations = vi.fn(async () => registrations);
    const deleteCache = vi.fn(async () => true);
    defineGlobal("location", { origin: "https://mission.local" });
    defineGlobal("navigator", { serviceWorker: { getRegistrations } });
    defineGlobal("caches", {
      keys: vi.fn(async () => [
        "goatcitadel-mission-control-v1",
        "other-app-cache",
        "goatcitadel-mission-control-assets",
      ]),
      delete: deleteCache,
    });

    await retireMissionControlServiceWorkers();

    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(activeMissionControl.unregister).toHaveBeenCalledTimes(1);
    expect(waitingMissionControl.unregister).toHaveBeenCalledTimes(1);
    expect(installingMissionControl.unregister).toHaveBeenCalledTimes(1);
    expect(offOriginScope.unregister).not.toHaveBeenCalled();
    expect(offOriginScript.unregister).not.toHaveBeenCalled();
    expect(wrongScriptName.unregister).not.toHaveBeenCalled();
    expect(malformedScript.unregister).not.toHaveBeenCalled();
    expect(missingScript.unregister).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenCalledWith("goatcitadel-mission-control-v1");
    expect(deleteCache).toHaveBeenCalledWith("goatcitadel-mission-control-assets");
  });

  it("still unregisters matching workers when cache storage is unavailable", async () => {
    const activeMissionControl = registration({ active: "https://mission.local/sw.js" });
    defineGlobal("location", { origin: "https://mission.local" });
    defineGlobal("navigator", {
      serviceWorker: {
        getRegistrations: vi.fn(async () => [activeMissionControl]),
      },
    });
    defineGlobal("caches", undefined);

    await retireMissionControlServiceWorkers();

    expect(activeMissionControl.unregister).toHaveBeenCalledTimes(1);
  });
});
