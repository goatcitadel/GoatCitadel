// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { COCKPIT_LOCATION_EVENT } from "./cockpit-back-guard";
import { useCockpitScroll } from "./use-cockpit-scroll";
it("restores a route's scroll on return and keeps other scopes separate", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  function Probe({ identity }: { identity: string }) {
    const ref = useCockpitScroll(identity);
    return <main ref={ref}>Area</main>;
  }
  try {
    await act(async () => root.render(<Probe identity="caller-a:work:a" />));
    const main = element.querySelector("main")!;
    main.dispatchEvent(new Event("wheel"));
    main.scrollTop = 310;
    main.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(<Probe identity="caller-a:library:a" />));
    expect(main.scrollTop).toBe(0);
    await act(async () => root.render(<Probe identity="caller-a:work:a" />));
    expect(main.scrollTop).toBe(310);
    await act(async () => root.render(<Probe identity="caller-b:work:a" />));
    expect(main.scrollTop).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});

function Probe({ identity }: { identity: string }) {
  const ref = useCockpitScroll(identity);
  return <main ref={ref}>Area</main>;
}

it.each([COCKPIT_LOCATION_EVENT, "popstate"])(
  "keeps the position saved at %s even when the next page clamps the shared scroller (U-GL-049)",
  async (eventName) => {
    const element = document.createElement("div");
    const root = createRoot(element);
    try {
      await act(async () => root.render(<Probe identity="caller-a:work:a" />));
      const main = element.querySelector("main")!;
      main.dispatchEvent(new Event("wheel"));
      main.scrollTop = 200;
      main.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event(eventName));
      // The next page is shorter, so the browser clamps the one shared scroller before React swaps the page.
      main.scrollTop = 90;
      main.dispatchEvent(new Event("scroll"));
      await act(async () => root.render(<Probe identity="caller-a:library:a" />));
      await act(async () => root.render(<Probe identity="caller-a:work:a" />));
      expect(main.scrollTop).toBe(200);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("restores after keyboard scrolling and late content", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => root.render(<Probe identity="caller-a:work:b" />));
    const main = element.querySelector("main")!;
    main.dispatchEvent(new Event("keydown"));
    main.scrollTop = 500;
    main.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event(COCKPIT_LOCATION_EVENT));
    main.scrollTop = 0;
    main.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(<Probe identity="caller-a:library:b" />));
    await act(async () => root.render(<Probe identity="caller-a:work:b" />));
    main.scrollTop = 0;
    await act(async () => {
      main.append(document.createElement("p"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(main.scrollTop).toBe(500);
  } finally {
    await act(async () => root.unmount());
  }
});
