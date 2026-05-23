// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: tauriMocks.isPermissionGranted,
  requestPermission: tauriMocks.requestPermission,
  sendNotification: tauriMocks.sendNotification,
}));

interface RuntimeStatus {
  status: "ready" | "degraded" | "stopped" | "stale";
  gatewayUrl: string;
  uiUrl: string;
  targetUrl: string;
  packaged: boolean;
  runtimeRoot: string;
  runtimeStateDir: string;
  pidFiles: {
    gateway: string;
    ui: string;
  };
  pids: {
    gateway: { state: "running" };
    ui: { state: "running" };
  };
  logFiles: {
    gatewayStdout: string;
    gatewayStderr: string;
    missionControlStdout: string;
    missionControlStderr: string;
  };
  readiness: {
    gateway: boolean;
    ui: boolean;
  };
  onboardingCompleted: boolean;
  checkedAt: string;
}

describe("desktop shell bootstrap", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = [
      '<section id="startup"></section>',
      '<div id="mission-control-frame"></div>',
      '<p id="status-copy"></p>',
      '<div id="progress-bar"></div>',
      '<p id="runtime-meta"></p>',
      '<div id="recovery-actions"></div>',
      '<button id="retry-button"></button>',
      '<button id="open-browser-button"></button>',
      '<button id="open-logs-button"></button>',
      '<button id="open-folder-button"></button>',
      '<div id="desktop-toast"></div>',
    ].join("");
    tauriMocks.listen.mockResolvedValue(() => undefined);
    tauriMocks.isPermissionGranted.mockResolvedValue(true);
    tauriMocks.requestPermission.mockResolvedValue("granted");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("launches the runtime and opens the ready Mission Control target", async () => {
    tauriMocks.invoke.mockResolvedValueOnce(createRuntimeStatus({ status: "ready" }));

    await import("./main.js");
    await flushPromises();

    expect(tauriMocks.invoke).toHaveBeenCalledWith("launch_runtime");
    expect(element("status-copy").textContent).toBe("Runtime ready. Opening Mission Control...");
    expect(frameElement().src).toBe("http://127.0.0.1:5173/cowork");
    expect(element("startup").classList.contains("is-hidden")).toBe(true);
    expect(element("mission-control-frame").classList.contains("is-ready")).toBe(true);
  });

  it("surfaces gateway degradation after the shell has already loaded and recovers when health returns", async () => {
    vi.useFakeTimers();
    tauriMocks.invoke
      .mockResolvedValueOnce(createRuntimeStatus({ status: "ready" }))
      .mockResolvedValueOnce(createRuntimeStatus({ status: "stale", readiness: { gateway: false, ui: true } }))
      .mockResolvedValueOnce(createRuntimeStatus({ status: "ready", targetUrl: "http://127.0.0.1:5173/chat" }));

    await import("./main.js");
    await flushPromises();
    expect(element("startup").classList.contains("is-hidden")).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(element("status-copy").textContent).toBe("Runtime stale: gateway not ready, UI ready.");
    expect(element("recovery-actions").classList.contains("is-hidden")).toBe(false);
    expect(element("mission-control-frame").classList.contains("is-ready")).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(frameElement().src).toBe("http://127.0.0.1:5173/chat");
    expect(element("startup").classList.contains("is-hidden")).toBe(true);
    expect(element("mission-control-frame").classList.contains("is-ready")).toBe(true);
  });

  it("renders recovery actions when launch returns a degraded runtime", async () => {
    tauriMocks.invoke.mockResolvedValueOnce(
      createRuntimeStatus({
        status: "degraded",
        readiness: { gateway: true, ui: false },
      }),
    );

    await import("./main.js");
    await flushPromises();

    expect(element("recovery-actions").classList.contains("is-hidden")).toBe(false);
    expect(element("status-copy").textContent).toBe(
      "Runtime is degraded. Gateway and Mission Control did not both become ready.",
    );
    expect(element("runtime-meta").textContent).toBe("Logs: gateway.err.log");
  });

  it("routes shell buttons through desktop commands", async () => {
    tauriMocks.invoke.mockResolvedValueOnce(createRuntimeStatus({ status: "ready" }));
    await import("./main.js");
    await flushPromises();

    element("open-browser-button").click();
    element("open-logs-button").click();
    element("open-folder-button").click();

    expect(tauriMocks.invoke).toHaveBeenCalledWith("open_browser", { url: "http://127.0.0.1:5173/cowork" });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("open_logs");
    expect(tauriMocks.invoke).toHaveBeenCalledWith("open_install_folder");
  });

  it("covers browser fallback and packaged runtime metadata branches", async () => {
    tauriMocks.invoke.mockResolvedValueOnce(
      createRuntimeStatus({
        status: "ready",
        packaged: true,
        targetUrl: "",
        uiUrl: "http://127.0.0.1:5173/",
      }),
    );

    await import("./main.js");
    await flushPromises();
    element("open-browser-button").click();

    expect(element("runtime-meta").textContent).toBe("Gateway ready / UI ready / packaged install");
    expect(tauriMocks.invoke).toHaveBeenCalledWith("open_browser", { url: "http://127.0.0.1:5173/" });
  });

  it("does not open a browser before a runtime URL is known", async () => {
    tauriMocks.invoke.mockRejectedValueOnce(new Error("launch failed"));

    await import("./main.js");
    await flushPromises();
    tauriMocks.invoke.mockClear();
    element("open-browser-button").click();

    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("retries launch from the shell button", async () => {
    tauriMocks.invoke
      .mockResolvedValueOnce(createRuntimeStatus({ status: "degraded" }))
      .mockResolvedValueOnce(createRuntimeStatus({ status: "ready", targetUrl: "http://127.0.0.1:5173/retry" }));

    await import("./main.js");
    await flushPromises();
    element("retry-button").click();
    await flushPromises();

    expect(tauriMocks.invoke).toHaveBeenCalledWith("launch_runtime");
    expect(frameElement().src).toBe("http://127.0.0.1:5173/retry");
  });

  it("handles runtime events and falls back to plugin notifications", async () => {
    const listeners = new Map<string, (event?: { payload?: unknown }) => void>();
    tauriMocks.listen.mockImplementation((eventName: string, callback: (event?: { payload?: unknown }) => void) => {
      listeners.set(eventName, callback);
      return Promise.resolve(() => undefined);
    });
    tauriMocks.invoke
      .mockResolvedValueOnce(createRuntimeStatus({ status: "ready" }))
      .mockResolvedValueOnce(createRuntimeStatus({ status: "stale", readiness: { gateway: false, ui: false } }))
      .mockResolvedValueOnce(createRuntimeStatus({ status: "ready", targetUrl: "http://127.0.0.1:5173/chat" }));
    tauriMocks.isPermissionGranted.mockResolvedValue(false);
    tauriMocks.requestPermission.mockResolvedValue("granted");

    await import("./main.js");
    await flushPromises();
    delete (globalThis as { Notification?: unknown }).Notification;

    listeners.get("desktop://runtime-status-requested")?.();
    await flushPromises();
    expect(element("desktop-toast").textContent).toBe("Runtime stale: gateway not ready, UI not ready.");

    listeners.get("desktop://approval-created")?.({
      payload: { approvalId: "approval-1", kind: "tool", riskLevel: "high" },
    });
    await flushPromises();
    expect(tauriMocks.sendNotification).toHaveBeenCalledWith({
      title: "GoatCitadel approval waiting",
      body: "tool / high",
    });

    listeners.get("desktop://operator-attention")?.({
      payload: {
        title: "GoatCitadel run completed",
        body: "Results are ready to review.",
        routePath: "/ops/activity",
      },
    });
    await flushPromises();
    expect(tauriMocks.sendNotification).toHaveBeenCalledWith({
      title: "GoatCitadel run completed",
      body: "Results are ready to review.",
    });

    listeners.get("desktop://runtime-stopped")?.();
    expect(element("status-copy").textContent).toBe("Runtime stopped.");

    listeners.get("desktop://runtime-restarted")?.();
    await flushPromises();
    expect(frameElement().src).toBe("http://127.0.0.1:5173/chat");
  });

  it("uses browser notifications to deep-link approvals", async () => {
    const listeners = new Map<string, (event?: { payload?: unknown }) => void>();
    let notificationClick: (() => void) | undefined;
    const close = vi.fn();
    class TestNotification {
      public onclick: (() => void) | undefined;

      public constructor(
        public title: string,
        public options: { body?: string },
      ) {
        notificationClick = () => this.onclick?.();
      }

      public close(): void {
        close();
      }
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: TestNotification,
    });
    tauriMocks.listen.mockImplementation((eventName: string, callback: (event?: { payload?: unknown }) => void) => {
      listeners.set(eventName, callback);
      return Promise.resolve(() => undefined);
    });
    tauriMocks.invoke.mockResolvedValueOnce(
      createRuntimeStatus({
        status: "ready",
        uiUrl: "http://127.0.0.1:5173/",
      }),
    );

    await import("./main.js");
    await flushPromises();

    listeners.get("desktop://approval-created")?.({
      payload: { approvalId: "approval 1", status: "pending" },
    });
    await flushPromises();
    notificationClick?.();

    expect(frameElement().src).toBe("http://127.0.0.1:5173/ops/approvals?approvalId=approval%201");
    expect(close).toHaveBeenCalled();

    listeners.get("desktop://operator-attention")?.({
      payload: {
        title: "GoatCitadel needs attention",
        body: "A run needs review.",
        routePath: "/ops/notifications",
      },
    });
    await flushPromises();
    notificationClick?.();
    expect(frameElement().src).toBe("http://127.0.0.1:5173/ops/notifications");
  });

  it("shows refresh errors and hides toast after the timer", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    tauriMocks.listen.mockImplementation((eventName: string, callback: () => void) => {
      listeners.set(eventName, callback);
      return Promise.resolve(() => undefined);
    });
    tauriMocks.invoke
      .mockResolvedValueOnce(createRuntimeStatus({ status: "ready" }))
      .mockRejectedValueOnce("status failed");

    await import("./main.js");
    await flushPromises();

    listeners.get("desktop://runtime-status-requested")?.();
    await flushPromises();
    expect(element("desktop-toast").textContent).toBe("status failed");

    vi.runOnlyPendingTimers();
    expect(element("desktop-toast").classList.contains("is-hidden")).toBe(true);
  });

  it("shows Error refresh failures and ready refresh status branches", async () => {
    const listeners = new Map<string, () => void>();
    tauriMocks.listen.mockImplementation((eventName: string, callback: () => void) => {
      listeners.set(eventName, callback);
      return Promise.resolve(() => undefined);
    });
    tauriMocks.invoke
      .mockResolvedValueOnce(createRuntimeStatus({ status: "ready" }))
      .mockRejectedValueOnce(new Error("status unavailable"))
      .mockResolvedValueOnce(createRuntimeStatus({ status: "ready", readiness: { gateway: true, ui: true } }));

    await import("./main.js");
    await flushPromises();

    listeners.get("desktop://runtime-status-requested")?.();
    await flushPromises();
    expect(element("desktop-toast").textContent).toBe("status unavailable");

    listeners.get("desktop://runtime-status-requested")?.();
    await flushPromises();
    expect(element("desktop-toast").textContent).toBe("Runtime ready: gateway ready, UI ready.");
  });

  it("renders stopped status with mixed readiness from the last runtime", async () => {
    const listeners = new Map<string, () => void>();
    tauriMocks.listen.mockImplementation((eventName: string, callback: () => void) => {
      listeners.set(eventName, callback);
      return Promise.resolve(() => undefined);
    });
    tauriMocks.invoke.mockResolvedValueOnce(
      createRuntimeStatus({
        status: "degraded",
        readiness: { gateway: false, ui: true },
      }),
    );

    await import("./main.js");
    await flushPromises();
    listeners.get("desktop://runtime-stopped")?.();

    expect(element("runtime-meta").textContent).toBe("Gateway not ready / UI ready");
  });

  it("renders stopped status with ready gateway metadata", async () => {
    const listeners = new Map<string, () => void>();
    tauriMocks.listen.mockImplementation((eventName: string, callback: () => void) => {
      listeners.set(eventName, callback);
      return Promise.resolve(() => undefined);
    });
    tauriMocks.invoke.mockResolvedValueOnce(
      createRuntimeStatus({
        status: "degraded",
        readiness: { gateway: true, ui: false },
      }),
    );

    await import("./main.js");
    await flushPromises();
    listeners.get("desktop://runtime-stopped")?.();

    expect(element("runtime-meta").textContent).toBe("Gateway ready / UI not ready");
  });

  it("ignores approval deep-links before runtime status is available", async () => {
    const listeners = new Map<string, (event?: { payload?: unknown }) => void>();
    let notificationClick: (() => void) | undefined;
    class TestNotification {
      public onclick: (() => void) | undefined;

      public constructor() {
        notificationClick = () => this.onclick?.();
      }

      public close(): void {
        // no-op for this branch
      }
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: TestNotification,
    });
    tauriMocks.listen.mockImplementation((eventName: string, callback: (event?: { payload?: unknown }) => void) => {
      listeners.set(eventName, callback);
      return Promise.resolve(() => undefined);
    });
    tauriMocks.invoke.mockRejectedValueOnce(new Error("launch failed"));

    await import("./main.js");
    await flushPromises();

    listeners.get("desktop://approval-created")?.({ payload: { approvalId: "approval-1" } });
    await flushPromises();
    notificationClick?.();

    expect(frameElement().src).toBeUndefined();
    listeners.get("desktop://runtime-stopped")?.();
    expect(element("runtime-meta").textContent).toBe("Use Retry to start GoatCitadel again.");
  });

  it("surfaces launch failures", async () => {
    tauriMocks.invoke.mockRejectedValueOnce(new Error("launcher unavailable"));

    await import("./main.js");
    await flushPromises();

    expect(element("status-copy").textContent).toBe("launcher unavailable");
    expect(element("runtime-meta").textContent).toBe(
      "Runtime did not return a status payload. Open logs for the captured launcher output.",
    );
  });

  it("surfaces non-Error launch failures", async () => {
    tauriMocks.invoke.mockRejectedValueOnce("launcher string failure");

    await import("./main.js");
    await flushPromises();

    expect(element("status-copy").textContent).toBe("launcher string failure");
  });

  it("fails fast when required shell elements are missing", async () => {
    document.body.innerHTML = '<section id="startup"></section>';

    await expect(import("./main.js")).rejects.toThrow("Missing desktop shell element: mission-control-frame");
  });
});

function createRuntimeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  const readiness = overrides.readiness ?? { gateway: true, ui: true };
  return {
    status: "ready",
    gatewayUrl: "http://127.0.0.1:8787",
    uiUrl: "http://127.0.0.1:5173",
    targetUrl: "http://127.0.0.1:5173/cowork",
    packaged: false,
    runtimeRoot: "runtime",
    runtimeStateDir: "state",
    pidFiles: {
      gateway: "gateway.pid",
      ui: "ui.pid",
    },
    pids: {
      gateway: { state: "running" },
      ui: { state: "running" },
    },
    logFiles: {
      gatewayStdout: "gateway.out.log",
      gatewayStderr: "gateway.err.log",
      missionControlStdout: "ui.out.log",
      missionControlStderr: "ui.err.log",
    },
    readiness,
    onboardingCompleted: true,
    checkedAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing test element ${id}`);
  }
  return node;
}

function frameElement(): HTMLElement & { src?: string } {
  return element("mission-control-frame") as HTMLElement & { src?: string };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
