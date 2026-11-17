// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "./Tabs";

const { play } = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock("./use-control-wave", () => ({ useControlWave: () => ({ play }), warmControlWave: vi.fn() }));

it("a tab shows hover, keeps a minimum height and marks the current tab by colour and underline (RC-18)", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Tabs value="a">
        <TabsList aria-label="Views">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
  });
  try {
    const [current, other] = [...container.querySelectorAll('[role="tab"]')];
    expect(other!.className).toContain("hover:text-fg");
    expect(other!.className).toContain("min-h-9");
    expect(current!.getAttribute("aria-selected")).toBe("true");
    expect(current!.className).toContain("data-[state=active]:border-accent");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("waves for an activated tab without delaying selection or animating the gallery's own trigger", () => {
  play.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <Tabs defaultValue="first" activationMode="manual">
          <TabsList aria-label="Test tabs">
            <TabsTrigger value="first">First</TabsTrigger>
            <TabsTrigger value="second">Second</TabsTrigger>
            <TabsTrigger value="demo" wave={false}>
              Demo
            </TabsTrigger>
          </TabsList>
        </Tabs>,
      ),
    );
    const [, second, demo] = container.querySelectorAll("button");
    act(() => second!.focus());
    expect(second?.getAttribute("aria-selected")).toBe("false");
    expect(play).not.toHaveBeenCalled();

    act(() => second!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(second?.getAttribute("aria-selected")).toBe("true");
    expect(play).toHaveBeenCalledExactlyOnceWith(second, second, undefined, { preserveText: true });

    act(() => demo!.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true })));
    expect(demo?.getAttribute("aria-selected")).toBe("true");
    expect(play).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
