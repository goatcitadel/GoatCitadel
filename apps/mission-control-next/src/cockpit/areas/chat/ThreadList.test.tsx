// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./ThreadList";

vi.mock("./use-thread-activity", () => ({ useThreadActivity: () => ({ records: {}, loading: false, refresh: vi.fn() }) }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ThreadList folders", () => {
  it("places folders before recent threads and filters through the controller", async () => {
    const onSelectFolderId = vi.fn();
    const rail = {
      missionSessions: [], availableFolders: [{ folderId: "project-one", name: "Project One", count: 3 }],
      selectedFolderId: "all", selectedProjectId: "all", selectedSessionId: null, search: "", historyView: "active", creatingSession: false,
      onCreateSession: vi.fn(), onSearchChange: vi.fn(), onHistoryViewChange: vi.fn(), onSelectFolderId,
    } as unknown as MissionThreadedSessionRailData;
    await act(async () => root.render(<ThreadList rail={rail} />));
    const folders = container.querySelector("details");
    expect(folders?.open).toBe(true);
    expect(container.textContent?.indexOf("Folders")).toBeLessThan(container.textContent?.indexOf("Recent") ?? 0);
    const folder = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Project One"));
    if (!folder) throw new Error("Folder button missing");
    await act(async () => folder.click());
    expect(onSelectFolderId).toHaveBeenCalledWith("project-one");
    await act(async () => root.render(<ThreadList rail={{ ...rail, selectedFolderId: "project-one" }} />));
    expect(folder.getAttribute("aria-pressed")).toBe("true");
    const clear = [...container.querySelectorAll("button")].find((button) => button.textContent === "All conversations");
    await act(async () => clear?.click());
    expect(onSelectFolderId).toHaveBeenLastCalledWith("all");
    await act(async () => root.render(<ThreadList rail={{ ...rail, selectedFolderId: "all" }} />));
    expect(clear?.getAttribute("aria-pressed")).toBe("true");
  });
});
