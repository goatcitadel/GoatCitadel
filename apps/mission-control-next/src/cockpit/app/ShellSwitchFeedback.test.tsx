// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ShellSwitchFeedback } from "./use-cockpit-shell-switch";

vi.mock("../ui/UnsavedChangesDialog", () => ({ UnsavedChangesDialog: () => null }));

type Owner = Parameters<typeof ShellSwitchFeedback>[0]["owner"];
const failed = { opening: false, error: "The view could not open.", dialogProps: {} } as unknown as Owner;

async function render(floating: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <p>
        A sentence with <a href="/x">a link</a>
        <ShellSwitchFeedback owner={failed} floating={floating} />
      </p>,
    );
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("keeps the inline failure a span, so it is valid inside a paragraph and adds no box to a dense row", async () => {
  const view = await render(false);
  try {
    const alert = view.container.querySelector('[role="alert"]')!;
    expect(alert.tagName).toBe("SPAN");
    expect(alert.closest("p")).not.toBeNull();
    expect(view.container.querySelector("[data-tone]")).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("shows the floating failure as one framed callout, without a second box around it", async () => {
  const view = await render(true);
  try {
    const callout = view.container.querySelector('[data-tone="error"]')!;
    expect(callout.textContent).toContain("The view could not open.");
    const wrapper = callout.closest(".fixed")!;
    expect(view.container.querySelectorAll("[role=alert]")).toHaveLength(1);
    expect(wrapper.className).toContain("fixed");
    expect(wrapper.className).toContain("shadow-overlay");
    expect(wrapper.className).not.toMatch(/(^|\s)(border|px-3|py-2|bg-overlay)(\s|$)/);
  } finally {
    await view.unmount();
  }
});
