// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Section } from "./Section";

it.each([
  [2, "H2", "text-lg"],
  [3, "H3", "text-md"],
] as const)("a level %s section heading uses the %s scale step (U-GL-035)", async (level, tag, size) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Section title="Backups" headingLevel={level}>
        <p>Body</p>
      </Section>,
    );
  });
  try {
    const heading = container.querySelector("h2, h3")!;
    expect(heading.tagName).toBe(tag);
    expect(heading.className).toContain(size);
    expect(heading.className).toContain("font-display");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
