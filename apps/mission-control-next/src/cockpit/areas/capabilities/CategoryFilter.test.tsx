// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CategoryFilter, type CategoryOption } from "./CategoryFilter";

const FIVE: readonly CategoryOption[] = [
  { id: "data", label: "Data" },
  { id: "dev", label: "Development" },
  { id: "auto", label: "Automation" },
  { id: "creative", label: "Creative" },
  { id: "research", label: "Research" },
];

let container: HTMLDivElement;
let root: Root;

const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
const row = (name: string) => buttons().find((button) => button.textContent === name);
const overflow = () => buttons().find((button) => /^\+\d+$/.test(button.textContent ?? ""));
const popover = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const popoverButton = (name: string) =>
  [...(popover()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === name);
const pressed = () =>
  buttons()
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((b) => b.textContent);

async function renderFilter(props: Partial<Parameters<typeof CategoryFilter>[0]> = {}) {
  const onChange = vi.fn();
  await act(async () => root.render(<CategoryFilter options={FIVE} selected={[]} onChange={onChange} {...props} />));
  return onChange;
}

/** Lets the closing panel's own return-focus step run (it happens on a timer after the panel unmounts). */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));

/** A parent that keeps the selection, as the Connectors tab does. */
function Stateful({ initial = [] }: { initial?: string[] }) {
  const [selected, setSelected] = useState<string[]>(initial);
  return <CategoryFilter options={FIVE} selected={selected} onChange={setSelected} />;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CategoryFilter", () => {
  it("names its group Categories unless the list says what the buttons choose", async () => {
    await renderFilter();
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Categories");

    await renderFilter({ label: "Where it came from" });
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Where it came from");
    // Naming the group changes nothing about the buttons.
    expect(buttons().map((button) => button.textContent)).toEqual(["All", "Data", "Development", "Automation", "+2"]);
  });

  it("shows All and the first three options, and presses All when nothing is selected", async () => {
    await renderFilter();
    expect(buttons().map((button) => button.textContent)).toEqual(["All", "Data", "Development", "Automation", "+2"]);
    expect(pressed()).toEqual(["All"]);
  });

  it("shows the hidden count on the overflow button", async () => {
    await renderFilter();
    expect(overflow()?.textContent).toBe("+2");
    expect(overflow()?.getAttribute("aria-label")).toBe("+2 more categories");
    await renderFilter({ selected: ["research"] });
    expect(overflow()?.textContent).toBe("+1");
    expect(overflow()?.getAttribute("aria-label")).toBe("+1 more category");
  });

  it("honours visibleCount and drops the overflow button when everything fits", async () => {
    await renderFilter({ visibleCount: 4 });
    expect(overflow()?.textContent).toBe("+1");
    await renderFilter({ visibleCount: 5 });
    expect(overflow()).toBeUndefined();
    expect(buttons()).toHaveLength(6);
  });

  it("keeps a selected category visible after it overflows", async () => {
    await renderFilter({ selected: ["research"] });
    expect(row("Research")?.getAttribute("aria-pressed")).toBe("true");
    expect(pressed()).toEqual(["Research"]);
    expect(overflow()?.textContent).toBe("+1");
    // It left the overflow list, so only the one category that is still hidden is offered there.
    await act(async () => overflow()?.click());
    expect(popover()?.textContent).toBe("Creative");
  });

  it("treats every category selected as All", async () => {
    await renderFilter({ selected: FIVE.map((option) => option.id) });
    expect(pressed()).toEqual(["All"]);
    expect(overflow()?.textContent).toBe("+2");
  });

  it("clears the selection when the last unselected category is chosen", async () => {
    const onChange = await renderFilter({
      options: FIVE.slice(0, 3),
      selected: ["data", "dev"],
    });
    await act(async () => row("Automation")?.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("ignores selected ids that are not options", async () => {
    await renderFilter({ selected: ["retired"] });
    expect(pressed()).toEqual(["All"]);
  });

  it("selects one category from All, adds to it in option order and clears back to All", async () => {
    const onChange = await renderFilter();
    await act(async () => row("Automation")?.click());
    expect(onChange).toHaveBeenLastCalledWith(["auto"]);

    const onAdd = await renderFilter({ selected: ["auto"] });
    await act(async () => row("Data")?.click());
    expect(onAdd).toHaveBeenLastCalledWith(["data", "auto"]);

    const onClear = await renderFilter({ selected: ["auto"] });
    await act(async () => row("Automation")?.click());
    expect(onClear).toHaveBeenLastCalledWith([]);
  });

  it("returns to All from the All button", async () => {
    const onChange = await renderFilter({ selected: ["data", "auto"] });
    await act(async () => row("All")?.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("offers the hidden categories in the overflow and selects from there", async () => {
    const onChange = await renderFilter();
    expect(popover()).toBeNull();
    await act(async () => overflow()?.click());
    expect(popover()?.getAttribute("aria-label")).toBe("More categories");
    expect(popoverButton("Creative")).toBeDefined();
    expect(popoverButton("Research")).toBeDefined();
    expect(popoverButton("Data")).toBeUndefined();
    await act(async () => popoverButton("Research")?.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["research"]);
  });
});

describe("CategoryFilter focus", () => {
  it("moves focus to a category picked from the overflow, which now shows in the row", async () => {
    await act(async () => root.render(<Stateful />));
    await act(async () => overflow()?.click());
    await act(async () => popoverButton("Research")?.click());
    expect(popover()).toBeNull();
    expect(row("Research")?.getAttribute("aria-pressed")).toBe("true");
    await settle();
    expect(document.activeElement).toBe(row("Research"));
    expect(overflow()?.textContent).toBe("+1");
  });

  it("moves focus to the overflow button when a promoted category is cleared", async () => {
    await act(async () => root.render(<Stateful initial={["research"]} />));
    row("Research")?.focus();
    await act(async () => row("Research")?.click());
    expect(row("Research")).toBeUndefined();
    expect(document.activeElement).toBe(overflow());
    expect(overflow()?.textContent).toBe("+2");
  });

  it("moves focus to the chosen category when the overflow button goes away", async () => {
    await act(async () => root.render(<Stateful initial={[]} />));
    await act(async () => overflow()?.click());
    await act(async () => popoverButton("Creative")?.click());
    await act(async () => overflow()?.click());
    await act(async () => popoverButton("Research")?.click());
    expect(overflow()).toBeUndefined();
    await settle();
    expect(document.activeElement).toBe(row("Research"));
  });
});
