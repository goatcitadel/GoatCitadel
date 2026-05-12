import { afterEach, describe, expect, it, vi } from "vitest";
import { retireMissionControlServiceWorkers } from "./service-worker-cleanup";

describe("retireMissionControlServiceWorkers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("unregisters same-origin Mission Control service workers and deletes their caches", async () => {
    const unregisterMissionControl = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const unregisterOther = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const deleteCache = vi.fn<(_: string) => Promise<boolean>>().mockResolvedValue(true);

    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue([
          {
            active: { scriptURL: "http://127.0.0.1:5173/sw.js?build=old" },
            scope: "http://127.0.0.1:5173/",
            unregister: unregisterMissionControl,
          },
          {
            active: { scriptURL: "http://127.0.0.1:5173/other-worker.js" },
            scope: "http://127.0.0.1:5173/",
            unregister: unregisterOther,
          },
        ]),
      },
    });
    vi.stubGlobal("caches", {
      keys: vi.fn().mockResolvedValue(["goatcitadel-mission-control-old", "unrelated-cache"]),
      delete: deleteCache,
    });

    await retireMissionControlServiceWorkers();

    expect(unregisterMissionControl).toHaveBeenCalledTimes(1);
    expect(unregisterOther).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledWith("goatcitadel-mission-control-old");
    expect(deleteCache).not.toHaveBeenCalledWith("unrelated-cache");
  });

  it("returns quietly when service worker APIs are unavailable", async () => {
    vi.stubGlobal("navigator", {});

    await expect(retireMissionControlServiceWorkers()).resolves.toBeUndefined();
  });

  it("ignores non-matching registrations and tolerates missing cache storage", async () => {
    const unregister = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue([
          {
            active: { scriptURL: "http://127.0.0.1:5173/sw.js" },
            scope: "http://localhost:5173/",
            unregister,
          },
          {
            active: undefined,
            waiting: undefined,
            installing: undefined,
            scope: "http://127.0.0.1:5173/",
            unregister,
          },
          {
            active: { scriptURL: "not a url" },
            scope: "http://127.0.0.1:5173/",
            unregister,
          },
        ]),
      },
    });
    vi.stubGlobal("caches", undefined);

    await retireMissionControlServiceWorkers();

    expect(unregister).not.toHaveBeenCalled();
  });
});
