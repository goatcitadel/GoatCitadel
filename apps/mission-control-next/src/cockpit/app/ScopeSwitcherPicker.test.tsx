// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ScopeSwitcherPicker } from "./ScopeSwitcherPicker";

vi.mock("./use-cockpit-scope", () => ({
  useCockpitScope: () => ({
    busy: false,
    error: "The operating scope could not be read.",
    directoryError: undefined,
    citadels: [],
    workspaces: [],
  }),
}));

it("shows a failed scope read in the shared error callout (U-GL-013)", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ScopeSwitcherPicker
        activeCitadelId="citadel-a"
        activeWorkspaceId="workspace-a"
        open={false}
        setOpen={() => undefined}
        description="Choose a scope"
        onCloseAutoFocus={() => undefined}
        onBusyChange={() => undefined}
        onSelect={() => undefined}
      />,
    );
  });
  try {
    const callout = container.querySelector('[data-tone="error"]');
    expect(callout?.textContent).toContain("The operating scope could not be read.");
    expect(callout?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
