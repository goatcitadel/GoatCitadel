import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function installMockWindow(locationOverrides: Record<string, unknown> = {}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        pathname: "/mission-control",
        search: "",
        hash: "",
        ...locationOverrides,
      },
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    },
  });
}

describe("dev-diagnostics-store invariants", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes a stable empty route when browser location parts are missing", async () => {
    installMockWindow({
      pathname: undefined,
      search: undefined,
      hash: undefined,
    });

    const diagnostics = await import("./dev-diagnostics-store");
    const bundle = diagnostics.buildDevDiagnosticsBundle();

    expect(bundle.route).toBe("");
  });

  it("drops invalid route and identifier values instead of recording NaN or undefined strings", async () => {
    installMockWindow();
    const diagnostics = await import("./dev-diagnostics-store");

    diagnostics.setDevDiagnosticsCurrentRoute("NaN" as unknown as string);
    diagnostics.recordClientDiagnostic({
      level: "info",
      category: "ui",
      event: "invariant.check",
      message: "Testing diagnostic sanitization",
      route: "undefined" as unknown as string,
      correlationId: "NaN" as unknown as string,
      sessionId: "undefined" as unknown as string,
      providerId: "null" as unknown as string,
      modelId: "   ",
    });

    const bundle = diagnostics.buildDevDiagnosticsBundle();
    const event = (bundle.browserDiagnostics as Array<Record<string, unknown>>)[0];

    expect(bundle.route).toBe("");
    expect(event?.route).toBe("");
    expect(event?.correlationId).toBeUndefined();
    expect(event?.sessionId).toBeUndefined();
    expect(event?.providerId).toBeUndefined();
    expect(event?.modelId).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain("NaN");
    expect(JSON.stringify(bundle)).not.toContain("undefined");
  });

  it("does not echo diagnostics to the console during test runs", async () => {
    installMockWindow();
    const consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const diagnostics = await import("./dev-diagnostics-store");

    diagnostics.recordClientDiagnostic({
      level: "info",
      category: "ui",
      event: "test.console_suppressed",
      message: "This should stay in the diagnostics buffer only.",
    });

    expect(consoleDebugSpy).not.toHaveBeenCalled();
  });
});
