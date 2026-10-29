// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import { CapabilityCatalog } from "./CapabilityCatalog";
import { catalogHref, readCatalogLocation } from "./capability-catalog-route";

// Skills and tools live in Capabilities, so the Library lists only these kinds. The skill and the tool are here to
// show that the catalog leaves them out.
const items: CapabilityCatalogEntry[] = [
  {
    capabilityId: "candidate:review",
    kind: "candidate_skill",
    category: "self_generated",
    title: "Review changes",
    summary: "A drafted skill that reviews a patch.",
    callable: false,
    trustLabel: "reviewed",
  },
  {
    capabilityId: "mesh_tool:read",
    kind: "mesh_tool",
    category: "mesh_published",
    title: "Read files",
    summary: "A tool a mesh node publishes.",
    callable: false,
  },
  {
    capabilityId: "skill:review",
    kind: "skill",
    category: "built_in",
    title: "Installed review skill",
    summary: "Review a patch.",
    callable: true,
    trustLabel: "reviewed",
  },
  {
    capabilityId: "tool:read",
    kind: "tool",
    category: "built_in",
    title: "Installed read tool",
    summary: "Read a file.",
    callable: true,
  },
];
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === "skills"
      ? { data: { items, callableKnown: true, skillsKnown: false, skillsById: {}, issues: [] }, refetch: vi.fn() }
      : { isError: true, refetch: vi.fn() },
}));
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: CapabilityCatalogEntry[];
    itemContent: (index: number, item: CapabilityCatalogEntry) => ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={item.capabilityId}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/");
});
async function navigate(path: string) {
  await act(async () => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    root.render(
      <CockpitNavigationProvider>
        <CapabilityCatalog />
      </CockpitNavigationProvider>,
    );
  });
}

describe("Library catalog links", () => {
  it("lists only candidates, proposals and mesh entries in Library", async () => {
    await navigate("/library?shell=cockpit");
    expect(container.textContent).toContain("2 of 2 capabilities shown");
    expect(container.textContent).toContain("Review changes");
    expect(container.textContent).toContain("Read files");
    expect(container.textContent).not.toContain("Installed review skill");
    expect(container.textContent).not.toContain("Installed read tool");
    // The Type filter offers only the kinds the Library lists.
    const typeSelect = [...container.querySelectorAll("select")].find((select) =>
      select.closest("label")?.textContent?.startsWith("Type"),
    );
    expect([...typeSelect!.options].map((option) => option.textContent)).toEqual([
      "All types",
      "Candidate skill",
      "Mesh tool",
    ]);
  });
  it("says where skills and tools went when nothing matches", async () => {
    await navigate("/library?shell=cockpit&type=proposal");
    expect(container.textContent).toContain("No matching capabilities");
    const links = [...container.querySelectorAll<HTMLAnchorElement>("section a")];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Skills", "/capabilities/skills?shell=cockpit"],
      ["Tools", "/capabilities/tools?shell=cockpit"],
    ]);
  });
  it("responds to query-only navigation and restores filtered views", async () => {
    await navigate("/library?type=candidate_skill&shell=cockpit");
    expect(container.textContent).toContain("1 of 2 capabilities shown");
    expect(container.textContent).not.toContain("Read files");
    await navigate("/library?type=mesh_tool&shell=cockpit");
    expect(container.textContent).toContain("Read files");
    expect(container.textContent).not.toContain("Review changes");
  });
  it("announces a short count only after filtering settles", async () => {
    await navigate("/library?shell=cockpit");
    const status = () => [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    expect(status()).toEqual(["2 of 2 shown"]);
    await navigate("/library?type=mesh_tool&shell=cockpit");
    // The visible count updates at once; the live region waits for the debounce.
    expect(container.textContent).toContain("1 of 2 capabilities shown");
    expect(status()).toEqual(["2 of 2 shown"]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(status()).toEqual(["1 of 2 shown"]);
  });
  it("opens the exact linked kind and ID without falling back to the first item", async () => {
    await navigate("/library/mesh_tool/mesh_tool%3Aread?shell=cockpit");
    expect(container.querySelector('aside[aria-label="Capability details"] h2')?.textContent).toBe("Read files");
    await navigate("/library/proposal/mesh_tool%3Aread?shell=cockpit");
    expect(container.textContent).toContain("Capability unavailable");
    expect(container.querySelector('aside[aria-label="Capability details"]')).toBeNull();
  });
  it("uses a stable URL when an operator selects a capability", async () => {
    await navigate("/library?shell=cockpit");
    const row = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Read files"));
    await act(async () => row!.click());
    expect(window.location.pathname).toBe("/library/mesh_tool/mesh_tool%3Aread");
    expect(window.location.search).toContain("shell=cockpit");
  });
  it("rejects malformed selections and bounds query input", () => {
    expect(readCatalogLocation(["tool", "%E0%A4%A"], "").invalidSelection).toBe(true);
    expect(readCatalogLocation([], `?q=${"x".repeat(500)}&status=made_up`).filters).toMatchObject({
      search: "x".repeat(200),
      status: "all",
    });
    expect(readCatalogLocation(["skills"], "").filters.kind).toBe("skill");
    expect(catalogHref({ search: "a&b", kind: "mesh_tool", status: "all", trust: "all" }, items[1])).toBe(
      "/library/mesh_tool/mesh_tool%3Aread?shell=cockpit&q=a%26b&type=mesh_tool",
    );
  });
});
