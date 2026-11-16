// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverflowTabs } from "../../ui/OverflowTabs";
import { SettingsSectionTabs } from "./SettingsSectionTabs";
import type { SettingsIndexPage } from "./settings-index";

vi.mock("./settings-controls", () => ({ preloadSettingsSection: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

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

const page = {
  id: "citadel",
  label: "Citadel",
  entries: ["workspaces", "overview"].map((section) => ({
    section,
    label: section,
    discoverable: true,
    releaseStatus: "ship",
  })),
} as unknown as SettingsIndexPage;

it("the Settings section tabs and the page tabs share one tab style, without a filled pill (U-GL-037)", async () => {
  await act(async () =>
    root.render(
      <>
        <SettingsSectionTabs page={page} value="workspaces" onChange={vi.fn()}>
          {(entry) => <p>{entry.label}</p>}
        </SettingsSectionTabs>
        <OverflowTabs
          label="Work views"
          tabs={[
            { id: "a", label: "A", href: "/a" },
            { id: "b", label: "B", href: "/b" },
          ]}
          current="a"
          navigate={vi.fn()}
        />
      </>,
    ),
  );
  const pill = container.querySelector('[role="tab"][aria-selected="false"]') as HTMLElement;
  const link = container.querySelector("nav a:not([aria-current])") as HTMLElement;
  for (const item of [pill, link]) {
    expect(item.className).toContain("hover:text-fg");
    expect(item.className).toContain("min-h-9");
    expect(item.className).toContain("border-b-2");
  }
  const current = container.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement;
  expect(current.className).toContain("data-[state=active]:border-accent");
  expect(current.className).not.toContain("bg-raised");
  expect(link.className).toContain("aria-[current=page]:border-accent");
  const list = container.querySelector('[role="tablist"]') as HTMLElement;
  expect(list.className).not.toContain("bg-sunken");
});
