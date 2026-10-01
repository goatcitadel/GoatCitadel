// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatConversationFilters } from "./ChatConversationFilters";

let root: Root;
let container: HTMLDivElement;
const rail = () => ({ availableFolders: [{ folderId: "folder-a", name: "Folder A", count: 2 }],
  selectedFolderId: "folder-a", onSelectFolderId: vi.fn(), selectedProjectId: "project-a",
  onSelectProjectId: vi.fn(), search: "retained query", onSearchChange: vi.fn() });
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("No network in filter tests"))));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("shared cockpit conversation filters", () => {
  it("uses the exact project and folder owner callbacks without assigning the active conversation", async () => {
    const owner = rail();
    await act(async () => root.render(<ChatConversationFilters rail={owner} projectOptions={[
      { value: "project-a", label: "Project A" }, { value: "project-b", label: "Project B" },
    ]} />));
    const projects = container.querySelector("select")!;
    expect(projects.value).toBe("project-a");
    await act(async () => { projects.value = "project-b"; projects.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(owner.onSelectProjectId).toHaveBeenCalledExactlyOnceWith("project-b");
    expect(owner.onSelectFolderId).not.toHaveBeenCalled();
    const all = [...container.querySelectorAll("button")].find((button) => button.textContent === "All conversations")!;
    await act(async () => all.click());
    expect(owner.onSelectFolderId).toHaveBeenCalledExactlyOnceWith("all");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("retains missing project/folder filters visibly until the operator clears them", async () => {
    const owner = { ...rail(), availableFolders: [] };
    await act(async () => root.render(<ChatConversationFilters rail={owner} />));
    expect(container.querySelector("select")?.value).toBe("project-a");
    expect(container.textContent).toContain("Current project · unavailable in this catalog");
    expect(container.textContent).toContain("The selected folder has no conversations in these results");
    expect(container.querySelector("input")?.value).toBe("retained query");
    expect(owner.onSelectProjectId).not.toHaveBeenCalled();
    expect(owner.onSelectFolderId).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
