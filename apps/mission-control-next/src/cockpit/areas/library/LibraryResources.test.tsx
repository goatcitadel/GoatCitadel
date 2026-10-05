// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryResources } from "./LibraryResources";
import { LibraryResourceDetail } from "./LibraryResourceDetail";
import type { LibraryResource, ResourcePage } from "./library-resources";

const api = vi.hoisted(() => ({ load: vi.fn(), preview: vi.fn() }));
vi.mock("./library-resources", async (original) => ({
  ...(await original<typeof import("./library-resources")>()),
  loadLibraryResources: api.load,
}));
vi.mock("./library-resource-preview", () => ({ readLibraryResource: api.preview }));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer", () => ({
  GeneratedArtifactViewer: () => null,
}));
const resource = (name: string): LibraryResource => ({
  kind: "files",
  item: { relativePath: name, size: 4, modifiedAt: "2026-09-30" },
});
let root: Root, container: HTMLDivElement, client: QueryClient;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.load.mockResolvedValue({ items: [resource("Visible file")], coverage: "Installation shared files" });
  api.preview.mockResolvedValue({ text: "Visible content" });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});
async function render(workspaceId = "one") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LibraryResources key={workspaceId} kind="files" workspaceId={workspaceId} citadelId="personal" />
      </QueryClientProvider>,
    ),
  );
}
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;

describe("Library resource inspection lifecycle", () => {
  it("loads previews only after explicit inspection and clears them on refresh", async () => {
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Visible file"));
    expect(api.preview).not.toHaveBeenCalled();
    await act(async () => button("Inspect").click());
    expect(container.textContent).toContain("Visible content");
    const pending = deferred<ResourcePage>();
    api.load.mockReturnValueOnce(pending.promise);
    await act(async () => button("Refresh files").click());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Visible content"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => pending.resolve({ items: [], coverage: "Refreshed" }));
  });
  it("withholds an old workspace response after navigation", async () => {
    const pending = deferred<ResourcePage>();
    api.load.mockReturnValueOnce(pending.promise);
    await render("one");
    await render("two");
    await vi.waitFor(() => expect(container.textContent).toContain("Visible file"));
    await act(async () => pending.resolve({ items: [resource("Old workspace response")], coverage: "old" }));
    expect(container.textContent).not.toContain("Old workspace response");
  });
  it("ignores late preview content after the resource identity changes", async () => {
    const pending = deferred<{ text: string }>();
    api.preview.mockReturnValueOnce(pending.promise);
    await act(async () =>
      root.render(<LibraryResourceDetail resource={resource("first")} workspaceId="one" citadelId="personal" />),
    );
    await act(async () =>
      root.render(<LibraryResourceDetail resource={resource("second")} workspaceId="two" citadelId="personal" />),
    );
    await act(async () => pending.resolve({ text: "Old private content" }));
    expect(container.textContent).toContain("Visible content");
    expect(container.textContent).not.toContain("Old private content");
  });
  it("keeps the last directory beside a failed read and says how old it is", async () => {
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Visible file"));
    api.load.mockRejectedValueOnce(new Error("Owner unavailable"));
    await act(async () => button("Refresh files").click());
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain("Visible file");
    expect(container.textContent).toContain("Showing the last version from");
    expect(container.textContent).not.toContain("Files unavailable");
  });
  it("shows the unavailable state when the first read fails", async () => {
    api.load.mockRejectedValueOnce(new Error("Owner unavailable"));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Files unavailable"));
  });
  it("keeps the directory and an open preview while the directory is read again", async () => {
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Visible file"));
    await act(async () => button("Inspect").click());
    expect(container.textContent).toContain("Visible content");
    const pending = deferred<ResourcePage>();
    api.load.mockReturnValueOnce(pending.promise);
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["library", "resources"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Checking for changes…");
    expect(container.textContent).not.toContain("Loading files…");
    expect(container.textContent).toContain("Visible file");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () =>
      pending.resolve({ items: [resource("Visible file")], coverage: "Installation shared files" }),
    );
    await vi.waitFor(() => expect(container.textContent).not.toContain("Checking for changes…"));
  });
});
