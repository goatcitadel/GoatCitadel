// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryArea } from "./LibraryArea";
import { LIBRARY_SECTION_LABELS } from "./library-sections";
import { CITADEL_PAGE_LABELS } from "../../../app/route-model";
// Each mocked page draws its AreaHeader, as the real pages do, so the Library tab row renders.
const { areaHeader } = vi.hoisted(() => ({
  areaHeader: async () =>
    (await vi.importActual<typeof import("../../ui/AreaHeader")>("../../ui/AreaHeader")).AreaHeader,
}));
vi.mock("./CapabilityCatalog", async () => {
  const AreaHeader = await areaHeader();
  return {
    CapabilityCatalog: ({ footer }: { footer?: ReactNode | ((search: string) => ReactNode) }) => (
      <div>
        <AreaHeader title="Skills and tools" />
        Capability directory
        {typeof footer === "function" ? footer("") : footer}
      </div>
    ),
  };
});
vi.mock("./MeshCapabilityPublications", () => ({
  MeshCapabilityPublications: ({ workspaceId }: { workspaceId: string }) => (
    <div>mesh publications in {workspaceId}</div>
  ),
}));
vi.mock("./LibrarySkillPacks", () => ({
  LibrarySkillPacks: ({ workspaceId }: { workspaceId: string }) => <div>skill packs in {workspaceId}</div>,
}));
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
vi.mock("./LibraryResources", async () => {
  const AreaHeader = await areaHeader();
  return {
    LibraryResources: ({ kind, workspaceId }: { kind: string; workspaceId: string }) => (
      <div>
        <AreaHeader title="Resources" />
        {kind} in {workspaceId}
      </div>
    ),
  };
});
vi.mock("./LibraryCommunications", async () => {
  const AreaHeader = await areaHeader();
  return {
    LibraryCommunications: ({ workspaceId }: { workspaceId: string }) => (
      <div>
        <AreaHeader title="Mail" />
        mail in {workspaceId}
      </div>
    ),
  };
});
vi.mock("./LibraryCurator", async () => {
  const AreaHeader = await areaHeader();
  return {
    LibraryCurator: ({ workspaceId }: { workspaceId: string }) => (
      <div>
        <AreaHeader title="Skill curator" />
        curator in {workspaceId}
      </div>
    ),
  };
});
vi.mock("./LibraryJourney", async () => {
  const AreaHeader = await areaHeader();
  return {
    LibraryJourney: ({ workspaceId }: { workspaceId: string }) => (
      <div>
        <AreaHeader title="Journey timeline" />
        journey in {workspaceId}
      </div>
    ),
  };
});
vi.mock("./LibraryPromptPacks", async () => {
  const AreaHeader = await areaHeader();
  return {
    LibraryPromptPacks: ({ workspaceId }: { workspaceId: string }) => (
      <div>
        <AreaHeader title="Prompt packs" />
        prompt packs in {workspaceId}
      </div>
    ),
  };
});
vi.mock("./LibraryKnowledgeWorkspace", async () => {
  const AreaHeader = await areaHeader();
  return {
    LibraryKnowledgeWorkspace: ({ workspaceId }: { workspaceId: string }) => (
      <div>
        <AreaHeader title="Knowledge" />
        knowledge in {workspaceId}
      </div>
    ),
  };
});
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
  it("names every section tab with the label its page heading uses", async () => {
    await navigate("/library?shell=cockpit");
    const tabs = [...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Library sections"] a')];
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) {
      const section = (new URL(tab.href, "http://cockpit.invalid").pathname.split("/")[2] ??
        "capabilities") as keyof typeof LIBRARY_SECTION_LABELS;
      expect(tab.textContent).toBe(LIBRARY_SECTION_LABELS[section]);
    }
  });
});

describe("native Library resource routes", () => {
  it("preserves native Citadel Overview and Blueprint route continuity with exact selected scope", async () => {
    await navigate("/library/citadel-overview?shell=cockpit");
    expect(container.textContent).toContain("Overview for personal");
    expect(container.querySelector("h1")?.textContent).toBe(CITADEL_PAGE_LABELS["citadel-overview"]);
    expect(container.textContent).not.toContain("Capability directory");
    expect(container.querySelector('[aria-current="page"]')).toBeNull();
    // LB-N08: the header names Settings › Citadel as a link, not as plain text.
    const settingsLink = [...container.querySelectorAll("a")].find((link) => link.textContent === "Settings › Citadel");
    expect(settingsLink?.getAttribute("href")).toBe("/settings/citadel?shell=cockpit");
    await navigate("/library/citadel-blueprint?shell=cockpit");
    expect(container.textContent).toContain("Blueprint for personal");
    expect(container.querySelector("h1")?.textContent).toBe("Export/import · Blueprint");
    expect(container.textContent).not.toContain("Capability directory");
    await navigate("/library/citadel-wards?shell=cockpit");
    expect(container.textContent).toContain("Wards for personal");
    expect(container.querySelector('a[href="/library/citadel-wards?shell=classic"]')).toBeNull();
    await navigate("/library/citadel?shell=cockpit");
    expect(container.textContent).toContain("Mason for personal");
    expect(container.querySelector("h1")?.textContent).toBe(CITADEL_PAGE_LABELS.citadel);
    await navigate("/library/citadel-council?shell=cockpit");
    expect(container.textContent).toContain("Council for personal");
    await navigate("/library/citadel-vault?shell=cockpit");
    expect(container.textContent).toContain("Vault for personal");
    expect(container.textContent).not.toContain("Capability directory");
  });
  it("titles a Citadel page with one heading, without a hidden repeat of it (LB-R01)", async () => {
    await navigate("/library/citadel?shell=cockpit");
    const label = CITADEL_PAGE_LABELS.citadel;
    const headings = [...container.querySelectorAll("h1, h2, h3")].filter((heading) => heading.textContent === label);
    expect(headings.map((heading) => heading.tagName)).toEqual(["H1"]);
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
    // LB-N10: an unknown Library link says plainly that the page wasn't found and links back to Library.
    expect(container.querySelector("h1")?.textContent).toBe("Page not found");
    expect(container.textContent).toContain("No Library page at this link");
    expect(
      [...container.querySelectorAll("a")].find((link) => link.textContent === "Open Library")?.getAttribute("href"),
    ).toBe("/library?shell=cockpit");
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
  expect(container.textContent).not.toContain("No Library page at this link");
});

it("opens the experimental native curator by direct link without adding it to the section tabs", async () => {
  await navigate("/library/curator?shell=cockpit");
  expect(container.textContent).toContain("curator in scoped-workspace");
  expect(container.querySelector('nav a[href*="/library/curator"]')).toBeNull();
  expect(container.textContent).not.toContain("No Library page at this link");
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
