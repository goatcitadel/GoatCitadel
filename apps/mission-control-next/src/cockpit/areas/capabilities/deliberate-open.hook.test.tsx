// @vitest-environment happy-dom
import { act } from "react";
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
