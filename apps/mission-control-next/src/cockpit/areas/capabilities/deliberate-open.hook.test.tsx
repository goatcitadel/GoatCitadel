// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { CockpitNavigationContext } from "../../app/cockpit-navigation-context";
import { useDeliberateOpen } from "./deliberate-open";

function mount(pendingReview: boolean) {
  let api!: ReturnType<typeof useDeliberateOpen>;
  function Probe() {
    api = useDeliberateOpen();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => {
    root.render(
      <CockpitNavigationContext.Provider
        value={{
          isTransitionPending: () => pendingReview,
          navigate: () => undefined,
          requestTransition: () => undefined,
        }}
      >
        <Probe />
      </CockpitNavigationContext.Provider>,
    );
  });
  return { api: () => api, unmount: () => act(() => root.unmount()) };
}

it("keeps the press while the address moves", () => {
  const page = mount(false);
  page.api().go("skill:a", () => window.history.pushState(null, "", "/capabilities/skills?item=a"));
  expect(page.api().take("skill:a")).toBe(true);
  page.unmount();
});

it("clears the press when the move went nowhere and no review is open (a declined move)", () => {
  const page = mount(false);
  page.api().go("skill:a", () => undefined);
  expect(page.api().take("skill:a")).toBe(false);
  page.unmount();
});

it("keeps the press while the leave review is still open", () => {
  const page = mount(true);
  page.api().go("skill:a", () => undefined);
  expect(page.api().take("skill:a")).toBe(true);
  page.unmount();
});

it("returns the same object on every render, so nothing that lists it re-runs", () => {
  const seen: unknown[] = [];
  let effects = 0;
  function Probe({ tick }: { tick: number }) {
    const deliberate = useDeliberateOpen();
    seen.push(deliberate);
    useEffect(() => {
      effects += 1;
    }, [deliberate]);
    return <p>{tick}</p>;
  }
  const root = createRoot(document.createElement("div"));
  for (const tick of [1, 2, 3]) act(() => root.render(<Probe tick={tick} />));
  expect(new Set(seen).size).toBe(1);
  expect(effects).toBe(1);
  act(() => root.unmount());
});
