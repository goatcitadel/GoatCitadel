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
});
