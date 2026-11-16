// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GovernedSettingLoadState } from "./GovernedSettingParts";
import type { GovernedRuntimeSetting } from "./use-governed-runtime-setting";

type Read = { isLoading: boolean; isError: boolean; isFetching: boolean; error: unknown; data: unknown };
function governed(read: Partial<Read>, overrides: { ready?: boolean; busy?: boolean; reading?: boolean } = {}) {
  const refresh = vi.fn();
  const value = {
    settings: { isLoading: false, isError: false, isFetching: false, error: null, data: { revision: 2 }, ...read },
    ready: overrides.ready ?? true,
    busy: overrides.busy ?? false,
    reading: overrides.reading ?? false,
    refresh,
  };
  return { value: value as unknown as GovernedRuntimeSetting<boolean>, refresh };
}

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const tryAgain = () => [...container.querySelectorAll("button")].find((item) => item.textContent === "Try again");
async function show(state: ReturnType<typeof governed>) {
  await act(async () =>
    root.render(<GovernedSettingLoadState governed={state.value} loading="Loading…" incomplete="Incomplete." />),
  );
}

describe("a setting read that did not work offers Try again (U-ST-014)", () => {
  it("a failed read shows its error and a Try again that reads again", async () => {
    const state = governed(
      { isError: true, error: new Error("Gateway unreachable"), data: undefined },
      { ready: false },
    );
    await show(state);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => tryAgain()!.click());
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("an incomplete read offers Try again too", async () => {
    await show(governed({}, { ready: false }));
    expect(container.textContent).toContain("Incomplete.");
    expect(tryAgain()).toBeTruthy();
  });

  it("a good read and a first load show no Try again", async () => {
    await show(governed({}));
    expect(tryAgain()).toBeUndefined();
    await show(governed({ isLoading: true, data: undefined }, { ready: false }));
    expect(container.textContent).toContain("Loading…");
    expect(tryAgain()).toBeUndefined();
  });

  it("Try again waits while a read or a save is already running", async () => {
    await show(governed({ isError: true, error: new Error("x"), data: undefined }, { ready: false, reading: true }));
    expect(tryAgain()!.disabled).toBe(true);
    await show(governed({ isError: true, error: new Error("x"), data: undefined }, { ready: false, busy: true }));
    expect(tryAgain()!.disabled).toBe(true);
  });
});
