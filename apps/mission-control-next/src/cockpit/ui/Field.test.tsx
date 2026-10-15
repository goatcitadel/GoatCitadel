// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Field } from "./Field";
it("links the real input to its label, help and validation error", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <Field label="Name" help="Choose a name" error="Name is required">
          {(field) => <input {...field} />}
        </Field>,
      ),
    );
    const input = container.querySelector("input")!;
    expect(container.querySelector("label")?.htmlFor).toBe(input.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const ids = input.getAttribute("aria-describedby")!.split(" ");
    expect(ids.map((id) => container.querySelector(`[id="${id}"]`)?.textContent)).toEqual([
      "Name is required",
      "Choose a name",
    ]);
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe("Name is required");
    expect(alert.className).toContain("text-status-failed");
    expect(alert.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  } finally {
    act(() => root.unmount());
  }
});

it("marks required fields visually and for assistive technology", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <Field label="Server URL" required>
          {(field) => <input {...field} />}
        </Field>,
      ),
    );
    expect(container.querySelector("input")?.getAttribute("aria-required")).toBe("true");
    expect(container.querySelector('label [aria-hidden="true"]')?.textContent).toBe("*");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
