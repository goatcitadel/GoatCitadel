// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitySearch } from "./CapabilitySearch";

let container: HTMLDivElement;
let root: Root;

const input = () => container.querySelector<HTMLInputElement>("input")!;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CapabilitySearch", () => {
  it("labels the search box with the tab name", async () => {
    await act(async () =>
      root.render(
        <CapabilitySearch tabLabel="Connectors" value="" onChange={vi.fn()} placeholder={'Try "automation"'} />,
      ),
    );
    const label = container.querySelector<HTMLLabelElement>(`label[for="${input().id}"]`);
    // The visible badge is the label, so the accessible name contains the text on screen.
    expect(label?.textContent).toBe("Search Connectors");
    expect(label?.querySelector(".sr-only")?.textContent).toBe("Search ");
    expect(input().placeholder).toBe('Try "automation"');
    expect(container.querySelector('[role="search"]')).not.toBeNull();
  });

  it("shows the value and reports what the operator types", async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(<CapabilitySearch tabLabel="Connectors" value="slack" onChange={onChange} placeholder="Search" />),
    );
    expect(input().value).toBe("slack");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input(), "slacks");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("slacks");
  });

  it("renders the tab's own actions beside the box", async () => {
    await act(async () =>
      root.render(
        <CapabilitySearch
          tabLabel="Connectors"
          value=""
          onChange={vi.fn()}
          placeholder="Search"
          actions={<button type="button">Add your own</button>}
        />,
      ),
    );
    expect(container.querySelector("button")?.textContent).toBe("Add your own");
  });

  it("renders no empty actions area without actions", async () => {
    await act(async () =>
      root.render(<CapabilitySearch tabLabel="Connectors" value="" onChange={vi.fn()} placeholder="Search" />),
    );
    expect(container.querySelector('[role="search"]')?.children).toHaveLength(1);
  });
});
