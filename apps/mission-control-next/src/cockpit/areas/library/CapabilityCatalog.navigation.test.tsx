// @vitest-environment happy-dom
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import { CapabilityCatalog } from "./CapabilityCatalog";
import { catalogHref, readCatalogLocation } from "./capability-catalog-route";

const items: CapabilityCatalogEntry[] = [
  { capabilityId: "skill:review", kind: "skill", category: "built_in", title: "Review changes", summary: "Review a patch.", callable: true, trustLabel: "reviewed" },
  { capabilityId: "tool:read", kind: "tool", category: "built_in", title: "Read files", summary: "Read a file.", callable: true },
];
vi.mock("@tanstack/react-query", () => ({ useQuery: ({ queryKey }: { queryKey: string[] }) => queryKey[0] === "skills"
  ? { data: { items, callableKnown: true, skillsKnown: false, skillsById: {}, issues: [] }, refetch: vi.fn() }
  : { isError: true, refetch: vi.fn() } }));
vi.mock("react-virtuoso", () => ({ Virtuoso: ({ data, itemContent }: { data: CapabilityCatalogEntry[]; itemContent: (index: number, item: CapabilityCatalogEntry) => ReactNode }) =>
  <div>{data.map((item, index) => <div key={item.capabilityId}>{itemContent(index, item)}</div>)}</div> }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); window.history.replaceState(null, "", "/"); });
async function navigate(path: string) {
  await act(async () => { window.history.replaceState(null, "", path); window.dispatchEvent(new PopStateEvent("popstate")); root.render(<CockpitNavigationProvider><CapabilityCatalog /></CockpitNavigationProvider>); });
}

describe("Library catalog links", () => {
  it("responds to query-only navigation and restores filtered views", async () => {
    await navigate("/library?type=skill&shell=cockpit");
    expect(container.textContent).toContain("1 of 2 capabilities shown");
    expect(container.textContent).not.toContain("Read files");
    await navigate("/library?type=tool&shell=cockpit");
    expect(container.textContent).toContain("Read files");
    expect(container.textContent).not.toContain("Review changes");
  });
  it("opens the exact linked kind and ID without falling back to the first item", async () => {
    await navigate("/library/tool/tool%3Aread?shell=cockpit");
    expect(container.querySelector('aside[aria-label="Capability details"] h2')?.textContent).toBe("Read files");
    await navigate("/library/skill/tool%3Aread?shell=cockpit");
    expect(container.textContent).toContain("Capability unavailable");
    expect(container.querySelector('aside[aria-label="Capability details"]')).toBeNull();
  });
  it("uses a stable URL when an operator selects a capability", async () => {
    await navigate("/library?shell=cockpit");
    const row = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Read files"));
    await act(async () => row!.click());
    expect(window.location.pathname).toBe("/library/tool/tool%3Aread");
    expect(window.location.search).toContain("shell=cockpit");
  });
  it("rejects malformed selections and bounds query input", () => {
    expect(readCatalogLocation(["tool", "%E0%A4%A"], "").invalidSelection).toBe(true);
    expect(readCatalogLocation([], `?q=${"x".repeat(500)}&status=made_up`).filters).toMatchObject({ search: "x".repeat(200), status: "all" });
    expect(readCatalogLocation(["skills"], "").filters.kind).toBe("skill");
    expect(catalogHref({ search: "a&b", kind: "tool", status: "all", trust: "all" }, items[1])).toBe("/library/tool/tool%3Aread?shell=cockpit&q=a%26b&type=tool");
  });
});
