// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AreaHeader, AreaTabsProvider } from "./AreaHeader";
import { MetricList } from "./MetricList";
import { Section } from "./Section";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("puts the title row first and the area's tab row under it, with the current tab marked", async () => {
  const navigate = vi.fn();
  await act(async () =>
    root.render(
      <AreaTabsProvider
        label="System views"
        current="spend"
        navigate={navigate}
        tabs={[
          { id: "health", label: "Health", href: "/system" },
          { id: "spend", label: "Spend", href: "/system/spend" },
        ]}
      >
        <AreaHeader title="Spend" description="Model costs by day." actions={<button type="button">Refresh</button>} />
      </AreaTabsProvider>,
    ),
  );
  const header = container.querySelector("header")!;
  const order = [...header.querySelectorAll("h1, nav")].map((node) => node.tagName);
  expect(order).toEqual(["H1", "NAV"]);
  expect(header.querySelector('nav[aria-label="System views"] [aria-current="page"]')?.textContent).toBe("Spend");
  await act(async () => (header.querySelector('a[href="/system"]') as HTMLAnchorElement).click());
  expect(navigate).toHaveBeenCalledWith("/system");
});

it("renders no tab row outside an area and keeps sections and metrics flat", async () => {
  await act(async () =>
    root.render(
      <>
        <AreaHeader title="Inbox" />
        <Section title="Needs decision" description="Approvals waiting on you.">
          <MetricList label="Spend summary" items={[{ term: "Cost", value: "$1.20", hint: "at least" }]} />
        </Section>
      </>,
    ),
  );
  expect(container.querySelector("nav")).toBeNull();
  const section = container.querySelector("section")!;
  expect(section.getAttribute("aria-labelledby")).toBe(section.querySelector("h2")!.id);
  expect(container.querySelector('dl[aria-label="Spend summary"] dt')?.textContent).toBe("Cost");
});
