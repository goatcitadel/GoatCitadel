// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchKnowledgeDocuments, fetchMemoryFiles } from "@goatcitadel/mission-control-shared/api/memory";
import { LibraryKnowledgeWorkspace } from "./LibraryKnowledgeWorkspace";

vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({
  fetchMemoryFiles: vi.fn(),
  fetchKnowledgeDocuments: vi.fn(),
}));
// The sibling Knowledge sections have their own tests; this file covers the memory-file list (LB-N04).
vi.mock("./LibraryKnowledgeActions", () => ({ LibraryKnowledgeActions: () => null }));
vi.mock("./LibraryKnowledgeEvidence", () => ({ LibraryKnowledgeEvidence: () => null }));
vi.mock("./LibraryExternalSources", () => ({ LibraryExternalSources: () => null }));
vi.mock("./LibraryEngineeringLearnings", () => ({ LibraryEngineeringLearnings: () => null }));
vi.mock("./LibraryFileDownload", () => ({ LibraryFileDownload: () => null }));
vi.mock("./LibraryResourceDetail", () => ({
  LibraryResourceDetail: ({ resource }: { resource: { item: { relativePath: string } } }) => (
    <p>Previewing {resource.item.relativePath}</p>
  ),
}));

const file = (relativePath: string) =>
  ({ relativePath, size: 1024, modifiedAt: "2026-10-01T00:00:00.000Z" }) as Awaited<
    ReturnType<typeof fetchMemoryFiles>
  >["items"][number];

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchKnowledgeDocuments).mockResolvedValue({ items: [], truncated: false });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LibraryKnowledgeWorkspace workspaceId="one" />
      </QueryClientProvider>,
    ),
  );
}
const section = () =>
  [...container.querySelectorAll("section")].find(
    (region) => region.querySelector("h2")?.textContent === "Memory files",
  )!;

it("renders memory files as hairline rows named by file name, with the path as secondary text", async () => {
  vi.mocked(fetchMemoryFiles).mockResolvedValue({
    items: [file("notes/drafts/plan.md"), file("readme.md")],
  } as Awaited<ReturnType<typeof fetchMemoryFiles>>);
  await render();
  await vi.waitFor(() => expect(section().querySelectorAll("li")).toHaveLength(2));
  const list = section().querySelector("ul")!;
  expect(list.classList.contains("divide-y")).toBe(true);
  const row = list.querySelector("li")!;
  expect(row.classList.contains("border")).toBe(false);
  expect(row.querySelector("h3")?.textContent).toBe("plan.md");
  expect(row.textContent).toContain("notes/drafts/plan.md");
  const preview = row.querySelector("button")!;
  expect(preview.textContent).toBe("Preview");
  expect(preview.getAttribute("aria-label")).toBe("Preview notes/drafts/plan.md");
  expect(preview.getAttribute("aria-label")!.startsWith(preview.textContent!)).toBe(true);
  await act(async () => preview.click());
  expect(container.textContent).toContain("Previewing notes/drafts/plan.md");
});

it("keeps the file filter inside the section it filters", async () => {
  vi.mocked(fetchMemoryFiles).mockResolvedValue({
    items: [file("notes/plan.md"), file("readme.md")],
  } as Awaited<ReturnType<typeof fetchMemoryFiles>>);
  await render();
  await vi.waitFor(() => expect(section().querySelectorAll("li")).toHaveLength(2));
  const input = section().querySelector("input")!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "readme");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect([...section().querySelectorAll("li h3")].map((heading) => heading.textContent)).toEqual(["readme.md"]);
});

it("hides the filter until there are memory files", async () => {
  vi.mocked(fetchMemoryFiles).mockResolvedValue({ items: [] } as unknown as Awaited<
    ReturnType<typeof fetchMemoryFiles>
  >);
  await render();
  await vi.waitFor(() => expect(container.textContent).not.toContain("Reading memory files"));
  expect(container.querySelector("input")).toBeNull();
});

const sources = () =>
  [...container.querySelectorAll("section")].find(
    (region) => region.querySelector("h2")?.textContent === "Knowledge sources",
  )!;
it("lists the stored sources with their kind and when they were added", async () => {
  vi.mocked(fetchMemoryFiles).mockResolvedValue({ items: [] } as Awaited<ReturnType<typeof fetchMemoryFiles>>);
  vi.mocked(fetchKnowledgeDocuments).mockResolvedValue({
    items: [
      {
        docId: "d1",
        namespace: "general",
        sourceType: "text",
        title: "Launch notes",
        createdAt: "2026-10-01T00:00:00Z",
      },
    ],
    truncated: true,
  });
  await render();
  await vi.waitFor(() => expect(sources().querySelectorAll("li")).toHaveLength(1));
  const row = sources().querySelector("li")!;
  expect(row.querySelector("h3")?.textContent).toBe("Launch notes");
  expect(row.textContent).toContain("Pasted text · Added");
  expect(row.textContent).not.toContain("d1");
  expect(sources().textContent).toContain("Showing the newest 1 source.");
  expect(sources().textContent).toContain("Sources are shared by every workspace on this installation.");
});
it("says there are no sources yet, apart from a failed read", async () => {
  vi.mocked(fetchMemoryFiles).mockResolvedValue({ items: [] } as Awaited<ReturnType<typeof fetchMemoryFiles>>);
  await render();
  await vi.waitFor(() => expect(sources().textContent).toContain("No knowledge sources yet"));
  expect(sources().textContent).not.toContain("Could not load knowledge sources.");
});
it("says the read failed instead of showing an empty list, and tries again", async () => {
  vi.mocked(fetchMemoryFiles).mockResolvedValue({ items: [] } as Awaited<ReturnType<typeof fetchMemoryFiles>>);
  vi.mocked(fetchKnowledgeDocuments).mockRejectedValueOnce(new Error("Gateway down"));
  await render();
  await vi.waitFor(() => expect(sources().textContent).toContain("Could not load knowledge sources."));
  expect(sources().textContent).not.toContain("No knowledge sources yet");
  const retry = [...sources().querySelectorAll("button")].find((node) => node.textContent === "Try again")!;
  await act(async () => retry.click());
  await vi.waitFor(() => expect(sources().textContent).toContain("No knowledge sources yet"));
});
it("shows it is reading again after Try again, not the old failure", async () => {
  vi.mocked(fetchMemoryFiles).mockResolvedValue({ items: [] } as Awaited<ReturnType<typeof fetchMemoryFiles>>);
  vi.mocked(fetchKnowledgeDocuments).mockRejectedValueOnce(new Error("Gateway down"));
  await render();
  await vi.waitFor(() => expect(sources().textContent).toContain("Could not load knowledge sources."));
  vi.mocked(fetchKnowledgeDocuments).mockReturnValue(new Promise(() => undefined));
  const retry = [...sources().querySelectorAll("button")].find((node) => node.textContent === "Try again")!;
  await act(async () => retry.click());
  await vi.waitFor(() => expect(sources().textContent).toContain("Reading knowledge sources…"));
  expect(sources().textContent).not.toContain("Could not load knowledge sources.");
});
