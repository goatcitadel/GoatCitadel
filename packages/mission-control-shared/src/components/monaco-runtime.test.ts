// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  observeMonacoTheme,
  resolveMonacoTheme,
  setMonacoTestRuntimeEnabled,
  shouldRenderMonacoRuntime,
} from "./monaco-runtime";

describe("monaco runtime gate", () => {
  afterEach(() => {
    setMonacoTestRuntimeEnabled(false);
    vi.unstubAllGlobals();
  });

  it("keeps Monaco disabled in non-browser tests until explicitly enabled", () => {
    vi.stubGlobal("window", undefined);
    expect(shouldRenderMonacoRuntime()).toBe(false);

    vi.stubGlobal("window", {});
    expect(shouldRenderMonacoRuntime()).toBe(false);
    setMonacoTestRuntimeEnabled(true);
    expect(shouldRenderMonacoRuntime()).toBe(true);
  });

  it("allows Monaco outside test mode and ignores the test-only runtime flag setter", () => {
    vi.stubEnv("MODE", "development");
    vi.stubGlobal("window", {});

    expect(shouldRenderMonacoRuntime()).toBe(true);
    setMonacoTestRuntimeEnabled(false);
    expect(shouldRenderMonacoRuntime()).toBe(true);
  });
});

describe("canonical live Monaco theme ownership", () => {
  afterEach(() => {
    delete document.documentElement.dataset.shell;
    delete document.documentElement.dataset.theme;
    document.documentElement.classList.remove("theme-citadel-light", "theme-signal-noir");
    document.body.classList.remove("theme-citadel-light", "theme-signal-noir");
  });

  it("honors Cockpit light/dark over retained Classic residue without recreating the editor", async () => {
    document.documentElement.dataset.shell = "cockpit";
    document.documentElement.dataset.theme = "light";
    document.body.classList.add("theme-citadel-light");
    const apply = vi.fn();
    const stop = observeMonacoTheme(apply);
    try {
      expect(resolveMonacoTheme()).toBe("vs");
      expect(apply).toHaveBeenCalledExactlyOnceWith("vs");
      document.documentElement.dataset.theme = "dark";
      await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith("vs-dark"));
      expect(resolveMonacoTheme()).toBe("vs-dark");
      document.documentElement.dataset.theme = "light";
      await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith("vs"));
    } finally {
      stop();
    }
  });

  it("follows explicit Classic theme ownership and shell handoff through the existing root/body owners", async () => {
    document.documentElement.classList.add("theme-signal-noir");
    document.body.classList.add("theme-signal-noir");
    const apply = vi.fn();
    const stop = observeMonacoTheme(apply);
    try {
      expect(apply).toHaveBeenCalledExactlyOnceWith("vs-dark");
      document.documentElement.classList.replace("theme-signal-noir", "theme-citadel-light");
      document.body.classList.replace("theme-signal-noir", "theme-citadel-light");
      await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith("vs"));
      document.documentElement.dataset.shell = "cockpit";
      document.documentElement.dataset.theme = "dark";
      await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith("vs-dark"));
      delete document.documentElement.dataset.shell;
      await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith("vs"));
    } finally {
      stop();
    }
  });

  it("disconnects only the disposed editor observer and delivers no queued or later theme callback to it", async () => {
    document.documentElement.dataset.shell = "cockpit";
    document.documentElement.dataset.theme = "light";
    const disposed = vi.fn(),
      live = vi.fn();
    const stopDisposed = observeMonacoTheme(disposed),
      stopLive = observeMonacoTheme(live);
    try {
      expect(disposed).toHaveBeenCalledExactlyOnceWith("vs");
      document.documentElement.dataset.theme = "dark";
      stopDisposed();
      await vi.waitFor(() => expect(live).toHaveBeenLastCalledWith("vs-dark"));
      expect(disposed).toHaveBeenCalledExactlyOnceWith("vs");
      document.documentElement.dataset.theme = "light";
      await vi.waitFor(() => expect(live).toHaveBeenLastCalledWith("vs"));
      expect(disposed).toHaveBeenCalledExactlyOnceWith("vs");
    } finally {
      stopDisposed();
      stopLive();
    }
  });
});
