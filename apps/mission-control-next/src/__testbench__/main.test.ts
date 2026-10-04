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

  it("sets the gateway origin tag before the app is mounted", async () => {
    vi.stubEnv("VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN", "http://127.0.0.1:41873");
    vi.stubEnv("VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT", "/tmp/sandbox");
    document.body.innerHTML = '<div id="testbench-root"></div>';
    window.history.replaceState(null, "", "/testbench.html?target=sandbox");
    const originAtMount: Array<string | undefined> = [];
    mountMock.mockImplementation(() => {
      originAtMount.push(document.querySelector<HTMLMetaElement>('meta[name="goatcitadel-gateway-origin"]')?.content);
    });
    await import("./main");
    await vi.waitFor(() => expect(mountMock).toHaveBeenCalledTimes(1));
    expect(originAtMount).toEqual(["http://127.0.0.1:41873"]);
    expect(mountMock.mock.calls[0]?.[1]).toEqual({ requested: "sandbox", origin: "http://127.0.0.1:41873" });
  });

  it("shows a readable message when the app fails to load", async () => {
    document.body.innerHTML = '<div id="testbench-root"></div>';
    window.history.replaceState(null, "", "/testbench.html?target=real");
    mountMock.mockImplementation(() => {
      throw new Error("boom");
    });
    await import("./main");
    await vi.waitFor(() =>
      expect(document.getElementById("testbench-root")?.textContent).toBe("The test bench failed to load: boom"),
    );
  });

  it("refuses to run in a production build", async () => {
    vi.stubEnv("PROD", true);
    document.body.innerHTML = '<div id="testbench-root"></div>';
    await import("./main");
    expect(document.body.textContent).toContain("does not run in production builds");
    expect(mountMock).not.toHaveBeenCalled();
  });
});
