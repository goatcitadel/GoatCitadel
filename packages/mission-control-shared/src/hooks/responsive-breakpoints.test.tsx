import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { RESPONSIVE_QUERIES } from "./responsive-breakpoints";
import { useMediaQuery } from "./useMediaQuery";

it.each([639, 639.2, 639.5, 639.99, 640, 640.2])("keeps phone and desktop predicates complementary at %s CSS pixels", (width) => {
  const listeners = new Set<unknown>();
  vi.stubGlobal("window", { matchMedia: (query: string) => ({
    matches: query === RESPONSIVE_QUERIES.phone ? width < 640 : width >= 640,
    addEventListener: (_: string, fn: unknown) => listeners.add(fn),
    removeEventListener: (_: string, fn: unknown) => listeners.delete(fn),
  }) });
  let observed: boolean[] = [];
  function Probe() { observed = [useMediaQuery(RESPONSIVE_QUERIES.phone), useMediaQuery(RESPONSIVE_QUERIES.abovePhone)]; return null; }
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => { renderer = create(<Probe />); });
    expect(observed).toEqual([width < 640, width >= 640]);
    expect(listeners.size).toBe(2);
    act(() => renderer!.unmount()); renderer = undefined;
    expect(listeners.size).toBe(0);
  } finally { renderer?.unmount(); vi.unstubAllGlobals(); }
});
