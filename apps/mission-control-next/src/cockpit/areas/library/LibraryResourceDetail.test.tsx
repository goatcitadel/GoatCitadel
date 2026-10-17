// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryResourceDetail } from "./LibraryResourceDetail";
import type { LibraryResource } from "./library-resources";

const api = vi.hoisted(() => ({ preview: vi.fn(), current: vi.fn(() => true) }));
vi.mock("./library-resource-preview", () => ({ readLibraryResource: api.preview }));
vi.mock("./use-library-operation", () => ({
  useLibraryOperation: () => ({ identity: "access", current: api.current }),
}));
vi.mock("./LibraryFileDownload", () => ({ LibraryFileDownload: () => <button type="button">Download file</button> }));
vi.mock("../../ui/NativeOwnerLink", () => ({ NativeOwnerLink: () => null }));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ search: "", hash: "" }) }));

const resource: LibraryResource = {
  kind: "files",
  item: { relativePath: "docs/big.log", size: 4, modifiedAt: "2026-09-30T00:00:00.000Z" },
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  api.current.mockReturnValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(<LibraryResourceDetail resource={resource} workspaceId="one" citadelId="personal" />),
  );
}

it("offers Reopen instead of loading forever when access changes mid-read (LB-18)", async () => {
  api.current.mockReturnValue(false);
  api.preview.mockResolvedValue({ text: "Withheld content" });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Access changed while the preview was loading"));
  expect(container.textContent).not.toContain("Loading resource preview…");
  expect(container.textContent).not.toContain("Withheld content");
  const reopen = [...container.querySelectorAll("button")].find((item) => item.textContent === "Reopen preview")!;
  expect(document.activeElement).toBe(reopen);
  api.current.mockReturnValue(true);
  api.preview.mockResolvedValue({ text: "Fresh content" });
  await act(async () => reopen.click());
  await vi.waitFor(() => expect(container.textContent).toContain("Fresh content"));
  expect(api.preview).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Access changed");
});

it("shows a neutral note, not an error, when a file has no inline preview (LB-10)", async () => {
  api.preview.mockResolvedValue({ unavailable: "Preview not available for this file. Download it to open it." });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Preview not available"));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Download file");
});

it("renders a previewed image from an object URL and revokes it on close (LB-10)", async () => {
  const create = vi.fn(() => "blob:preview");
  const revoke = vi.fn();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  api.preview.mockResolvedValue({ image: new Blob(["abc"], { type: "image/png" }) });
  await render();
  await vi.waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview"));
  expect(container.querySelector("img")?.getAttribute("alt")).toBe("Preview of big.log");
  act(() => root.render(<p>closed</p>));
  expect(revoke).toHaveBeenCalledWith("blob:preview");
  vi.unstubAllGlobals();
});
