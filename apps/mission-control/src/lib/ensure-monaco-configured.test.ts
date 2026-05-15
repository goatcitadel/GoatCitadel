import { afterEach, describe, expect, it, vi } from "vitest";

type MonacoRuntimeGlobal = typeof globalThis & {
  MonacoEnvironment?: unknown;
};

function clearMonacoEnvironment(): void {
  Reflect.deleteProperty(globalThis, "MonacoEnvironment");
}

describe("ensureMonacoConfigured", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unmock("./configure-monaco");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearMonacoEnvironment();
  });

  it("returns immediately outside browser runtimes", async () => {
    const imports: string[] = [];
    vi.stubEnv("MODE", "development");
    vi.stubGlobal("window", undefined);
    vi.doMock("./configure-monaco", () => {
      imports.push("configure-monaco");
      return {};
    });

    const { ensureMonacoConfigured } = await import("./ensure-monaco-configured");

    await ensureMonacoConfigured();
    expect(imports).toEqual([]);
  });

  it("returns immediately when MonacoEnvironment already exists", async () => {
    const imports: string[] = [];
    vi.stubEnv("MODE", "development");
    vi.stubGlobal("window", {});
    (globalThis as MonacoRuntimeGlobal).MonacoEnvironment = { getWorker: vi.fn() };
    vi.doMock("./configure-monaco", () => {
      imports.push("configure-monaco");
      return {};
    });

    const { ensureMonacoConfigured } = await import("./ensure-monaco-configured");

    await ensureMonacoConfigured();
    expect(imports).toEqual([]);
  });

  it("skips worker configuration in the Vitest runtime", async () => {
    const imports: string[] = [];
    vi.stubEnv("MODE", "test");
    vi.stubGlobal("window", {});
    clearMonacoEnvironment();
    vi.doMock("./configure-monaco", () => {
      imports.push("configure-monaco");
      return {};
    });

    const { ensureMonacoConfigured } = await import("./ensure-monaco-configured");

    await ensureMonacoConfigured();
    expect(imports).toEqual([]);
  });

  it("imports the Monaco configuration module once in non-test browser runtimes", async () => {
    const imports: string[] = [];
    vi.stubEnv("MODE", "development");
    vi.stubGlobal("window", {});
    clearMonacoEnvironment();
    vi.doMock("./configure-monaco", () => {
      imports.push("configure-monaco");
      return {};
    });

    const { ensureMonacoConfigured } = await import("./ensure-monaco-configured");

    await Promise.all([ensureMonacoConfigured(), ensureMonacoConfigured()]);
    await ensureMonacoConfigured();

    expect(imports).toEqual(["configure-monaco"]);
  });
});
