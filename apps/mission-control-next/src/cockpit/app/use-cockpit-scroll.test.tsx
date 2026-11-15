// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
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

it("keeps saving after a navigation that never happened (a swallowed Back)", async () => {
  vi.useFakeTimers();
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => root.render(<Probe identity="caller-a:work:c" />));
    const main = element.querySelector("main")!;
    main.dispatchEvent(new Event("wheel"));
    window.dispatchEvent(new Event("popstate"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    main.scrollTop = 320;
    main.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(<Probe identity="caller-a:library:c" />));
    await act(async () => root.render(<Probe identity="caller-a:work:c" />));
    expect(main.scrollTop).toBe(320);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("keeps the saved position through a navigation that takes two seconds to arrive", async () => {
  vi.useFakeTimers();
  const element = document.createElement("div");
  const root = createRoot(element);
  const home = window.location.href;
  try {
    await act(async () => root.render(<Probe identity="caller-a:work:slow" />));
    const main = element.querySelector("main")!;
    main.dispatchEvent(new Event("wheel"));
    main.scrollTop = 420;
    main.dispatchEvent(new Event("scroll"));
    // The address moves at once; the next page (a lazy route chunk) is two seconds away.
    window.history.pushState(null, "", "/library?slow=1");
    window.dispatchEvent(new Event(COCKPIT_LOCATION_EVENT));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    main.scrollTop = 0;
    main.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(<Probe identity="caller-a:library:slow" />));
    await act(async () => root.render(<Probe identity="caller-a:work:slow" />));
    expect(main.scrollTop).toBe(420);
  } finally {
    await act(async () => root.unmount());
    window.history.replaceState(null, "", home);
    vi.useRealTimers();
  }
});

it("counts the page as back when the shell only added its own parameter to the address", async () => {
  vi.useFakeTimers();
  const element = document.createElement("div");
  const root = createRoot(element);
  const home = window.location.href;
  try {
    window.history.replaceState(null, "", "/work");
    await act(async () => root.render(<Probe identity="caller-a:work:shell" />));
    const main = element.querySelector("main")!;
    main.dispatchEvent(new Event("wheel"));
    window.dispatchEvent(new Event("popstate"));
    // The shell normalises the address with a replace while the Back is swallowed.
    window.history.replaceState(null, "", "/work?shell=cockpit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    main.scrollTop = 275;
    main.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(<Probe identity="caller-a:library:shell" />));
    await act(async () => root.render(<Probe identity="caller-a:work:shell" />));
    expect(main.scrollTop).toBe(275);
  } finally {
    await act(async () => root.unmount());
    window.history.replaceState(null, "", home);
    vi.useRealTimers();
  }
});
