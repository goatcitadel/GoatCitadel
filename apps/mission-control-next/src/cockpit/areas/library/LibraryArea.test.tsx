// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryArea } from "./LibraryArea";
vi.mock("./CapabilityCatalog", () => ({ CapabilityCatalog: () => <div>Capability directory</div> }));
vi.mock("./MeshCapabilityPublications", () => ({
  MeshCapabilityPublications: ({ workspaceId }: { workspaceId: string }) => <div>mesh publications in {workspaceId}</div>,
}));
vi.mock("../settings/CitadelOverviewSettings", () => ({ CitadelOverviewSettings: ({ citadelId }: { citadelId: string }) => <p>Overview for {citadelId}</p> }));
vi.mock("../settings/CitadelBlueprintSettings", () => ({ CitadelBlueprintSettings: ({ citadelId }: { citadelId: string }) => <p>Blueprint for {citadelId}</p> }));
vi.mock("../settings/CitadelWardsSettings", () => ({ CitadelWardsSettings: ({ citadelId }: { citadelId: string }) => <p>Wards for {citadelId}</p> }));
vi.mock("../settings/CitadelMasonSettings", () => ({ CitadelMasonSettings: ({ citadelId }: { citadelId: string }) => <p>Mason for {citadelId}</p> }));
vi.mock("../settings/CitadelCouncilSettings", () => ({ CitadelCouncilSettings: ({ citadelId }: { citadelId: string }) => <p>Council for {citadelId}</p> }));
vi.mock("../settings/CitadelVaultSettings", () => ({ CitadelVaultSettings: ({ citadelId }: { citadelId: string }) => <p>Vault for {citadelId}</p> }));
vi.mock("./LibraryResources", () => ({
  LibraryResources: ({ kind, workspaceId }: { kind: string; workspaceId: string }) => (
    <div>
      {kind} in {workspaceId}
    </div>
  ),
}));
vi.mock("./LibraryCommunications", () => ({ LibraryCommunications: ({ workspaceId }: { workspaceId: string }) => <div>mail in {workspaceId}</div> }));
vi.mock("./LibraryCurator", () => ({ LibraryCurator: ({ workspaceId }: { workspaceId: string }) => <div>curator in {workspaceId}</div> }));
vi.mock("./LibraryJourney", () => ({ LibraryJourney: ({ workspaceId }: { workspaceId: string }) => <div>journey in {workspaceId}</div> }));
vi.mock("./LibraryPromptPacks", () => ({ LibraryPromptPacks: ({ workspaceId }: { workspaceId: string }) => <div>prompt packs in {workspaceId}</div> }));
vi.mock("./LibraryKnowledgeWorkspace", () => ({ LibraryKnowledgeWorkspace: ({ workspaceId }: { workspaceId: string }) => <div>knowledge in {workspaceId}</div> }));
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
describe("native Library prompt packs", () => {
  it("opens the prompt-pack workbench as a native Library section", async () => {
    await navigate("/library/prompt-packs?shell=cockpit");
    expect(container.textContent).toContain("prompt packs in scoped-workspace");
    expect(container.textContent).not.toContain("Capability directory");
    const tab = container.querySelector('[aria-current="page"]');
    expect(tab?.textContent).toBe("Prompt packs");
  });
});

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
    await navigate("/library?shell=cockpit");
    expect(container.textContent).toContain("mesh publications in scoped-workspace");
    await navigate("/library/tool/tool%3Aread?shell=cockpit");
    expect(container.textContent).toContain("Capability directory");
    expect(container.textContent).not.toContain("mesh publications in");
    expect(window.location.pathname).toBe("/library/tool/tool%3Aread");
    await navigate("/library/notes/unknown?shell=cockpit");
    expect(container.textContent).toContain("Library destination unavailable");
    expect(container.textContent).not.toContain("Capability directory");
    expect(container.textContent).not.toContain("notes in scoped-workspace");
  });
});

it("opens native Mail for the active workspace from its Library section", async () => {
  await navigate("/library/memory?shell=cockpit");
  const mail = [...container.querySelectorAll("a")].find((link) => link.textContent === "Mail")!;
  expect(mail.getAttribute("href")).toBe("/library/communications?shell=cockpit");
  await act(async () => mail.click());
  expect(window.location.pathname).toBe("/library/communications");
  expect(container.textContent).toContain("mail in scoped-workspace");
  expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("Mail");
  expect(container.textContent).not.toContain("Capability directory");
  expect(container.textContent).not.toContain("Library destination unavailable");
});

it("opens the experimental native curator by direct link without adding it to the section tabs", async () => {
  await navigate("/library/curator?shell=cockpit");
  expect(container.textContent).toContain("curator in scoped-workspace");
  expect(container.querySelector('nav a[href*="/library/curator"]')).toBeNull();
  expect(container.textContent).not.toContain("Library destination unavailable");
});

it("opens the experimental native Journey by direct link without adding it to the section tabs", async () => {
  await navigate("/library/journey?shell=cockpit");
  expect(container.textContent).toContain("journey in scoped-workspace");
  expect(container.querySelector('nav a[href*="/library/journey"]')).toBeNull();
});

it("retains shipped direct governance access without adding unsupported menu entries", async () => {
 await navigate("/library/citadel-vault?shell=cockpit");
 expect(container.textContent).toContain("Vault for personal");
 expect(container.textContent).not.toContain("Direct URL only");
 expect(container.querySelector('nav a[href*="citadel-vault"]')).toBeNull();
});

it("reveals the selected Library section on direct and history navigation without changing focus", async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  await navigate("/library/artifacts?shell=cockpit");
  const artifact = container.querySelector('[aria-current="page"]')!;
  expect(artifact.textContent).toBe("Artifacts");
  expect(scroll.mock.contexts.at(-1)).toBe(artifact);
  await navigate("/library/notes?shell=cockpit");
  expect(scroll.mock.contexts.at(-1)).toBe(container.querySelector('[aria-current="page"]'));
  expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
  expect(document.activeElement).not.toBe(container.querySelector('[aria-current="page"]'));
  scroll.mockRestore();
});

it("selects the native knowledge route instead of the capability catalog", async () => {
  await navigate("/library/knowledge?shell=cockpit");
  await vi.waitFor(() =>
    expect(container.querySelector('a[href="/library/knowledge?shell=cockpit"]')?.getAttribute("aria-current")).toBe(
      "page",
    ),
  );
  expect(container.textContent).not.toContain("Capability directory");
  expect(container.textContent).toContain("knowledge in scoped-workspace");
});
