// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { MemoryMaintenanceView } from "./LibraryMemoryMaintenance";
import type { MemorySnapshot } from "./memory-diagnostics-shared";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  window.history.replaceState(null, "", "/library/memory?shell=cockpit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function render(data: Partial<MemorySnapshot> | null) {
  await act(async () =>
    root.render(
      <CockpitNavigationProvider>
        <MemoryMaintenanceView
          workspaceId="one"
          data={data as MemorySnapshot | null}
          disabled={false}
          request={vi.fn()}
          presentationScope="scope"
          ownerScope="owner"
          onInspectRun={vi.fn()}
        />
      </CockpitNavigationProvider>,
    ),
  );
}
const links = () =>
  [...container.querySelectorAll("a")].filter((entry) => entry.textContent === "Turn it on in Settings › Advanced");

it("says memory maintenance is turned off and links to its switch", async () => {
  await render({ maintenanceEnabled: false, maintenanceDurableReady: true, maintenanceRuns: [] });
  expect(container.textContent).toContain("Memory maintenance is turned off on this installation.");
  expect(new URL(links()[0]!.getAttribute("href")!, "http://cockpit.invalid").hash).toBe(
    "#feature-switch-memory-maintenance",
  );
});

it("says resumable runs are the cause, with no link, when maintenance is on but resumable runs are off", async () => {
  await render({ maintenanceEnabled: true, maintenanceDurableReady: false, maintenanceRuns: [] });
  expect(container.textContent).toContain(
    "Memory maintenance needs resumable runs, which are turned off on this installation. Controls stay locked.",
  );
  expect(container.textContent).not.toContain("Memory maintenance is turned off");
  expect(links()).toHaveLength(0);
});

it("does not claim maintenance is turned off when the settings read failed", async () => {
  await render({
    memoryAdminState: "unknown",
    maintenanceEnabled: false,
    maintenanceDurableReady: false,
    maintenanceRuns: [],
  });
  expect(container.textContent).toContain("Couldn't read whether memory maintenance is on.");
  expect(container.textContent).not.toContain("turned off");
  expect(links()).toHaveLength(0);
});

it("does not claim maintenance is turned off before memory has been read", async () => {
  await render(null);
  expect(container.textContent).not.toContain("turned off");
  expect(links()).toHaveLength(0);
});
