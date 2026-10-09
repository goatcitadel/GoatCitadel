// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
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
