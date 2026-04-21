import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
const createRootMock = vi.fn(() => ({ render: renderMock }));

vi.mock("react-dom/client", () => ({
  createRoot: createRootMock,
}));

vi.mock("./App", () => ({
  App: () => null,
}));

vi.mock("./state/ui-preferences", () => ({
  UiPreferencesProvider: ({ children }: { children: unknown }) => children,
}));

describe("main entrypoint coverage", () => {
  beforeEach(() => {
    vi.resetModules();
    createRootMock.mockClear();
    renderMock.mockClear();
    const addEventListener = vi.fn();
    const serviceWorkerRegister = vi.fn();
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => ({ id: "root" })),
    } as unknown as Document);
    vi.stubGlobal("window", {
      addEventListener,
    } as unknown as Window & typeof globalThis);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: serviceWorkerRegister,
      },
    } as unknown as Navigator);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts the app root", async () => {
    await import("./main");
    expect(createRootMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("does not register the service worker outside production builds", async () => {
    await import("./main");

    expect(window.addEventListener).not.toHaveBeenCalledWith("load", expect.any(Function));
    expect(navigator.serviceWorker.register).not.toHaveBeenCalled();
  });
});
