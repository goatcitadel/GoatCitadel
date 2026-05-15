import { afterEach, describe, expect, it, vi } from "vitest";

import { setMonacoTestRuntimeEnabled, shouldRenderMonacoRuntime } from "./monaco-runtime";

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
