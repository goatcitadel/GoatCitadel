import { afterEach, describe, expect, it, vi } from "vitest";

const loaderMocks = vi.hoisted(() => ({
  config: vi.fn(),
  init: vi.fn(async () => ({
    editor: {
      create: vi.fn(),
    },
  })),
}));

vi.mock("@monaco-editor/loader", () => ({
  default: loaderMocks,
}));

function installBrowserWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {},
  });
}

describe("monaco-loader", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    loaderMocks.config.mockClear();
    loaderMocks.init.mockClear();
  });

  it("normalizes editor language aliases to Monaco contribution names", async () => {
    const { normalizeMonacoLoaderLanguage } = await import("./monaco-loader");

    expect(normalizeMonacoLoaderLanguage(" JS ")).toBe("javascript");
    expect(normalizeMonacoLoaderLanguage("jsx")).toBe("javascript");
    expect(normalizeMonacoLoaderLanguage("tsx")).toBe("typescript");
    expect(normalizeMonacoLoaderLanguage("bash")).toBe("shell");
    expect(normalizeMonacoLoaderLanguage("zsh")).toBe("shell");
    expect(normalizeMonacoLoaderLanguage("md")).toBe("markdown");
    expect(normalizeMonacoLoaderLanguage("json")).toBe("json");
    expect(normalizeMonacoLoaderLanguage("CSS")).toBe("css");
    expect(normalizeMonacoLoaderLanguage("yaml")).toBe("yaml");
    expect(normalizeMonacoLoaderLanguage("unknown")).toBe("plaintext");
    expect(normalizeMonacoLoaderLanguage()).toBe("plaintext");
  });

  it("rejects runtime loading outside a browser context", async () => {
    Reflect.deleteProperty(globalThis, "window");
    const { loadMonacoEditorRuntime } = await import("./monaco-loader");

    await expect(loadMonacoEditorRuntime("ts")).rejects.toThrow("Monaco runtime is only available in the browser.");
    expect(loaderMocks.config).not.toHaveBeenCalled();
    expect(loaderMocks.init).not.toHaveBeenCalled();
  });

  it("configures the AMD base once and shares concurrent language loads", async () => {
    installBrowserWindow();
    const { loadMonacoEditorRuntime } = await import("./monaco-loader");

    const [typescriptRuntime, javascriptRuntime, plaintextRuntime] = await Promise.all([
      loadMonacoEditorRuntime("ts"),
      loadMonacoEditorRuntime("tsx"),
      loadMonacoEditorRuntime("unknown"),
    ]);

    expect(typescriptRuntime).toBe(javascriptRuntime);
    expect(plaintextRuntime).toBe(typescriptRuntime);
    expect(loaderMocks.config).toHaveBeenCalledTimes(1);
    expect(loaderMocks.config).toHaveBeenCalledWith({ paths: { vs: "/vendor/monaco/vs" } });
    expect(loaderMocks.init).toHaveBeenCalledTimes(1);

    await loadMonacoEditorRuntime("javascript");
    expect(loaderMocks.config).toHaveBeenCalledTimes(1);
    expect(loaderMocks.init).toHaveBeenCalledTimes(1);
  });
});
