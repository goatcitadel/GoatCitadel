// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Suspense } from "react";
import { canPreload, preloadable } from "./preloadable";

afterEach(() => vi.unstubAllGlobals());

it("shares one import across repeated intent and the actual render", async () => {
  let resolve!: (module: { default: () => React.ReactNode }) => void;
  const loader = vi.fn(() => new Promise<{ default: () => React.ReactNode }>((done) => { resolve = done; }));
  const Component = preloadable(loader);
  const first = Component.preload();
  const second = Component.preload();
  expect(loader).toHaveBeenCalledOnce();
  resolve({ default: () => <p>Destination ready</p> });
  await Promise.all([first, second]);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<Suspense fallback="Loading"><Component /></Suspense>));
    expect(container.textContent).toBe("Destination ready");
    expect(loader).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); }
});

it("lets navigation retry an unsuccessful speculative import", async () => {
  const loader = vi.fn()
    .mockRejectedValueOnce(new Error("Temporary download failure"))
    .mockResolvedValue({ default: () => <p>Recovered</p> });
  const Component = preloadable(loader);
  await expect(Component.preload()).resolves.toBeUndefined();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Suspense fallback="Loading"><Component /></Suspense>));
    expect(container.textContent).toBe("Recovered");
    expect(loader).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); }
});

it.each([
  { onLine: false },
  { onLine: true, connection: { saveData: true } },
  { onLine: true, connection: { effectiveType: "2g" } },
  { onLine: true, connection: { effectiveType: "slow-2g" } },
])("skips speculation on a constrained connection but still permits navigation: %j", async (navigatorState) => {
  vi.stubGlobal("navigator", navigatorState);
  expect(canPreload()).toBe(false);
  const loader = vi.fn(async () => ({ default: () => <p>Explicit destination</p> }));
  const Component = preloadable(loader);
  await Component.preload();
  expect(loader).not.toHaveBeenCalled();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Suspense fallback="Loading"><Component /></Suspense>));
    expect(container.textContent).toBe("Explicit destination");
    expect(loader).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); }
});
