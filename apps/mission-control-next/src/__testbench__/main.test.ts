// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const { mountMock } = vi.hoisted(() => ({ mountMock: vi.fn() }));
vi.mock("./ui/mount", () => ({ mountTestbench: mountMock }));

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  mountMock.mockReset();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("test bench entry", () => {
  it("resolves the target from the URL and mounts the app", async () => {
    document.body.innerHTML = '<div id="testbench-root"></div>';
    window.history.replaceState(null, "", "/testbench.html?target=real");
    await import("./main");
    await vi.waitFor(() => expect(mountMock).toHaveBeenCalledTimes(1));
    const [container, request] = mountMock.mock.calls[0] ?? [];
    expect((container as HTMLElement).id).toBe("testbench-root");
    expect(request).toEqual({ requested: "real", origin: undefined });
  });

  it("refuses to run in a production build", async () => {
    vi.stubEnv("PROD", true);
    document.body.innerHTML = '<div id="testbench-root"></div>';
    await import("./main");
    expect(document.body.textContent).toContain("does not run in production builds");
    expect(mountMock).not.toHaveBeenCalled();
  });
});
