import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaderMocks = vi.hoisted(() => ({
  config: vi.fn(),
  init: vi.fn(),
}));

vi.mock("@monaco-editor/loader", () => ({
  default: {
    config: loaderMocks.config,
    init: loaderMocks.init,
  },
}));

describe("monaco loader helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    loaderMocks.init.mockResolvedValue({ editor: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes known editor languages", async () => {
    const { normalizeMonacoLoaderLanguage } = await import("./monaco-loader");
    expect(normalizeMonacoLoaderLanguage(" JS ")).toBe("javascript");
    expect(normalizeMonacoLoaderLanguage("tsx")).toBe("typescript");
    expect(normalizeMonacoLoaderLanguage("zsh")).toBe("shell");
    expect(normalizeMonacoLoaderLanguage("md")).toBe("markdown");
    expect(normalizeMonacoLoaderLanguage("json")).toBe("json");
    expect(normalizeMonacoLoaderLanguage("unknown")).toBe("plaintext");
    expect(normalizeMonacoLoaderLanguage()).toBe("plaintext");
  });

  it("configures Monaco once and reuses runtime and in-flight language loads", async () => {
    vi.stubGlobal("window", {});
    const { loadMonacoEditorRuntime } = await import("./monaco-loader");

    const [first, second] = await Promise.all([
      loadMonacoEditorRuntime("typescript"),
      loadMonacoEditorRuntime("typescript"),
    ]);

    expect(first).toBe(second);
    expect(loaderMocks.config).toHaveBeenCalledTimes(1);
    expect(loaderMocks.config).toHaveBeenCalledWith({ paths: { vs: "/vendor/monaco/vs" } });
    expect(loaderMocks.init).toHaveBeenCalledTimes(1);
    await expect(loadMonacoEditorRuntime("plaintext")).resolves.toBe(first);
  });

  it("fails clearly outside the browser", async () => {
    const { loadMonacoEditorRuntime } = await import("./monaco-loader");
    await expect(loadMonacoEditorRuntime("ts")).rejects.toThrow("Monaco runtime is only available in the browser");
  });
});
