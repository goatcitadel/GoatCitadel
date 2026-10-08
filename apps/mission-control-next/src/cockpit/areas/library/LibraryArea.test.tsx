// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryArea } from "./LibraryArea";
vi.mock("./CapabilityCatalog", () => ({ CapabilityCatalog: () => <div>Capability directory</div> }));
vi.mock("../settings/CitadelOverviewSettings", () => ({
  CitadelOverviewSettings: ({ citadelId }: { citadelId: string }) => <p>Overview for {citadelId}</p>,
}));
vi.mock("../settings/CitadelBlueprintSettings", () => ({
  CitadelBlueprintSettings: ({ citadelId }: { citadelId: string }) => <p>Blueprint for {citadelId}</p>,
}));
vi.mock("../settings/CitadelWardsSettings", () => ({
  CitadelWardsSettings: ({ citadelId }: { citadelId: string }) => <p>Wards for {citadelId}</p>,
}));
vi.mock("../settings/CitadelMasonSettings", () => ({
  CitadelMasonSettings: ({ citadelId }: { citadelId: string }) => <p>Mason for {citadelId}</p>,
}));
vi.mock("../settings/CitadelCouncilSettings", () => ({
  CitadelCouncilSettings: ({ citadelId }: { citadelId: string }) => <p>Council for {citadelId}</p>,
}));
vi.mock("../settings/CitadelVaultSettings", () => ({
  CitadelVaultSettings: ({ citadelId }: { citadelId: string }) => <p>Vault for {citadelId}</p>,
}));
vi.mock("./LibraryResources", () => ({
  LibraryResources: ({ kind, workspaceId }: { kind: string; workspaceId: string }) => (
    <div>
      {kind} in {workspaceId}
    </div>
  ),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "scoped-workspace", activeCitadelId: "personal" }),
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function navigate(path: string) {
  await act(async () => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    root.render(
      <CockpitNavigationProvider>
        <LibraryArea />
      </CockpitNavigationProvider>,
    );
  });
}
describe("native Library resource routes", () => {
  it("preserves native Citadel Overview and Blueprint route continuity with exact selected scope", async () => {
    await navigate("/library/citadel-overview?shell=cockpit");
    expect(container.textContent).toContain("Overview for personal");
    expect(container.textContent).not.toContain("Capability directory");
    expect(container.querySelector('[aria-current="page"]')).toBeNull();
    await navigate("/library/citadel-blueprint?shell=cockpit");
    expect(container.textContent).toContain("Blueprint for personal");
    expect(container.textContent).not.toContain("Capability directory");
    await navigate("/library/citadel-wards?shell=cockpit");
    expect(container.textContent).toContain("Wards for personal");
    expect(container.querySelector('a[href="/library/citadel-wards?shell=classic"]')).toBeNull();
    await navigate("/library/citadel?shell=cockpit");
    expect(container.textContent).toContain("Mason for personal");
    await navigate("/library/citadel-council?shell=cockpit");
    expect(container.textContent).toContain("Council for personal");
    await navigate("/library/citadel-vault?shell=cockpit");
    expect(container.textContent).toContain("Vault for personal");
    expect(container.textContent).not.toContain("Capability directory");
  });
  it("opens scoped resource tabs and preserves explicit classic management ownership", async () => {
    await navigate("/library/memory?shell=cockpit");
    expect(container.textContent).toContain("memory in scoped-workspace");
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("Memory");
    const notes = [...container.querySelectorAll("a")].find((link) => link.textContent === "Notes")!;
    await act(async () => notes.click());
    expect(window.location.pathname).toBe("/library/notes");
    expect(window.location.search).toBe("?shell=cockpit");
    expect(container.textContent).toContain("notes in scoped-workspace");
  });
  it("keeps exact capability links and unsupported resource suffixes with the existing catalog route owner", async () => {
    await navigate("/library/tool/tool%3Aread?shell=cockpit");
    expect(container.textContent).toContain("Capability directory");
    expect(window.location.pathname).toBe("/library/tool/tool%3Aread");
    await navigate("/library/notes/unknown?shell=cockpit");
    expect(container.textContent).toContain("Capability directory");
    expect(container.textContent).not.toContain("notes in scoped-workspace");
  });
});

it("selects the native knowledge route instead of the capability catalog", async () => {
  await navigate("/library/knowledge?shell=cockpit");
  await vi.waitFor(() =>
    expect(container.querySelector('a[href="/library/knowledge?shell=cockpit"]')?.getAttribute("aria-current")).toBe(
      "page",
    ),
  );
  expect(container.textContent).not.toContain("Capability directory");
});
