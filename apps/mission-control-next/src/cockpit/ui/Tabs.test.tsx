// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "./Tabs";

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
