import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
const createRootMock = vi.fn(() => ({ render: renderMock }));

vi.mock("react-dom/client", () => ({
  createRoot: createRootMock,
}));

vi.mock("@next/app/MissionControlNextApp", () => ({
  MissionControlNextApp: () => null,
}));

vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  UiPreferencesProvider: ({ children }: { children: unknown }) => children,
}));

describe("Mission Control Next main entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    createRootMock.mockClear();
    renderMock.mockClear();
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
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    vi.stubGlobal("caches", {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts the app and retires stale service workers", async () => {
    await import("./main");

    expect(createRootMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(navigator.serviceWorker.getRegistrations).toHaveBeenCalledTimes(1);
  });
});
