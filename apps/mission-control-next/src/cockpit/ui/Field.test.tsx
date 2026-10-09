// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Field } from "./Field";
it("links the real input to its label, help and validation error", () => {
  const container = document.createElement("div"); const root = createRoot(container);
  try {
    act(() => root.render(<Field label="Name" help="Choose a name" error="Name is required">{(field) => <input {...field} />}</Field>));
    const input = container.querySelector("input")!;
    expect(container.querySelector("label")?.htmlFor).toBe(input.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const ids = input.getAttribute("aria-describedby")!.split(" ");
    expect(ids.map(id => container.querySelector(`[id="${id}"]`)?.textContent)).toEqual(["Choose a name", "Name is required"]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Name is required");
  } finally { act(() => root.unmount()); }
});
