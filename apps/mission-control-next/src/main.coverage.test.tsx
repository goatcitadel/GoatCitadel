import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const entryMocks = vi.hoisted(() => ({
  mountClassic: vi.fn(),
  mountCockpit: vi.fn(),
}));

vi.mock("./classic-entry", () => ({ mountClassic: entryMocks.mountClassic }));
vi.mock("./cockpit-entry", () => ({ mountCockpit: entryMocks.mountCockpit }));

describe("Mission Control Next main entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    entryMocks.mountClassic.mockClear();
    entryMocks.mountCockpit.mockClear();
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {},
      },
      getElementById: vi.fn(() => ({ id: "root" })),
    } as unknown as Document);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue([]),
      },
    } as unknown as Navigator);
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173", search: "" });
    vi.stubGlobal("window", { localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() } });
    vi.stubGlobal("caches", {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts only cockpit by default and retires stale service workers", async () => {
    await import("./main");

    await vi.waitFor(() =>
      expect(entryMocks.mountCockpit).toHaveBeenCalledWith(expect.objectContaining({ id: "root" })),
    );
    expect(entryMocks.mountClassic).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.shell).toBe("cockpit");
    expect(navigator.serviceWorker.getRegistrations).toHaveBeenCalledTimes(1);
  });

  it("loads only classic for an explicit rollback override", async () => {
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173", search: "?shell=classic" });
    await import("./main");

    await vi.waitFor(() =>
      expect(entryMocks.mountClassic).toHaveBeenCalledWith(expect.objectContaining({ id: "root" })),
    );
    expect(entryMocks.mountCockpit).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.shell).toBe("classic");
  });

  it("loads only the cockpit entry for a shell override", async () => {
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173", search: "?shell=cockpit" });
    await import("./main");

    await vi.waitFor(() =>
      expect(entryMocks.mountCockpit).toHaveBeenCalledWith(expect.objectContaining({ id: "root" })),
    );
    expect(entryMocks.mountClassic).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.shell).toBe("cockpit");
  });

  it("marks visual-regression mode when requested", async () => {
    vi.stubEnv("VITE_GOATCITADEL_VISUAL_REGRESSION_MODE", " TRUE ");

    await import("./main");

    expect(document.documentElement.dataset.visualRegression).toBe("true");
  });

  it("throws when the root element is missing", async () => {
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {},
      },
      getElementById: vi.fn(() => null),
    } as unknown as Document);

    await expect(import("./main")).rejects.toThrow("Root element not found");
  });
});
