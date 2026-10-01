// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetWorkspaceAttemptsForTests } from "../../../features/native-routes/settings/workspace-editor-state";
import { WorkspaceSettings } from "./WorkspaceSettings";
import type { ReactNode } from "react";
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ open, children, title }: { open: boolean; children: ReactNode; title: string }) => open ? <div role="dialog" aria-label={title}>{children}</div> : null }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ setActiveCitadelId: vi.fn(), setActiveWorkspaceId: vi.fn() }) }));

const api = vi.hoisted(() => ({
  fetchWorkspaces: vi.fn(),
  listCitadels: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  archiveWorkspace: vi.fn(),
  restoreWorkspace: vi.fn(),
  archiveCitadel: vi.fn(),
  restoreCitadel: vi.fn(),
  createCitadel: vi.fn(),
  updateCitadel: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ ...api, isApiRequestError: () => false }));
let client: QueryClient;
let view: ReactTestRenderer;
let items: WorkspaceRecord[];
const record = (id: string): WorkspaceRecord => ({
  workspaceId: id,
  citadelId: "personal",
  revision: 1,
  name: `Workspace ${id}`,
  description: "Saved description",
  slug: `workspace-${id}`,
  lifecycleStatus: "active",
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
});
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const button = (label: string) => view.root.findAllByType("button").find((node) => text(node) === label)!;
const input = (label: string) =>
  view.root
    .findAllByType("label")
    .find((node) => text(node).startsWith(label))!
    .findByType("input");
const click = async (node: ReactTestInstance) => {
  await act(async () => node.props.onClick());
};
async function mount(citadelId = "personal") {
  await act(async () => {
    view = create(
      <QueryClientProvider client={client}>
        <WorkspaceSettings citadelId={citadelId} activeWorkspaceId="one" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetWorkspaceAttemptsForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  items = [record("one")];
  api.fetchWorkspaces.mockImplementation(async () => ({ citadelId: "personal", items }));
  api.listCitadels.mockResolvedValue({
    items: [{ citadelId: "personal", revision: "a".repeat(64), slug: "personal", kind: "personal", name: "Personal", lifecycleStatus: "active", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" }],
  });
  api.updateWorkspace.mockImplementation(async (id: string, body: { name: string; description: string }) => {
    items = items.map((item) => (item.workspaceId === id ? { ...item, ...body, revision: item.revision + 1 } : item));
    return items.find((item) => item.workspaceId === id);
  });
  api.createWorkspace.mockImplementation(async (body: { name: string; description: string; citadelId: string }) => {
    const item = { ...record("new"), ...body };
    items = [...items, item];
    return item;
  });
});
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  client.clear();
  __resetSessionDraftsForTests();
  __resetWorkspaceAttemptsForTests();
});

describe("native workspace directory", () => {
  it("includes native lifecycle and Citadel management with an explicit governance link", async () => {
    await mount();
    expect(text(view.root)).toContain("Citadel directory");
    expect(text(view.root.findByProps({ href: "/library/citadel-overview?shell=classic" }))).toBe("Open Citadel governance");
    expect(api.updateWorkspace).not.toHaveBeenCalled();
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });
  it("shows only the explicit scope and makes no mutation on opening an editor", async () => {
    await mount();
    expect(text(view.root)).toContain("Current workspace");
    expect(text(view.root)).toContain("Active");
    await click(button("Edit metadata"));
    expect(input("Workspace name").props.value).toBe("Workspace one");
    expect(view.root.findAllByType("label").some((node) => text(node) === "Slug")).toBe(false);
    expect(api.createWorkspace).not.toHaveBeenCalled();
    expect(api.updateWorkspace).not.toHaveBeenCalled();
    await act(async () => input("Workspace name").props.onChange({ target: { value: "Renamed workspace" } }));
    await click(button("Save workspace metadata"));
    expect(api.updateWorkspace).toHaveBeenCalledExactlyOnceWith("one", {
      expectedRevision: 1,
      name: "Renamed workspace",
      description: "Saved description",
      slug: "workspace-one",
    });
  });
  it("withholds foreign records and controls when scope evidence conflicts", async () => {
    items = [record("one"), { ...record("foreign"), citadelId: "company" }];
    await mount();
    expect(text(view.root)).toContain("scope evidence is unavailable");
    expect(text(view.root)).not.toContain("Workspace foreign");
    expect(button("New workspace").props.disabled).toBe(true);
  });
  it("does not invent a default scope", async () => {
    await mount("");
    expect(api.fetchWorkspaces).not.toHaveBeenCalled();
    expect(text(view.root)).toContain("Citadel: Unavailable");
    expect(button("New workspace").props.disabled).toBe(true);
  });
  it("bounds the directory and supports search over the loaded records", async () => {
    items = Array.from({ length: 25 }, (_, i) => record(String(i)));
    await mount();
    expect(view.root.findByProps({ "aria-label": "Workspace directory" }).findAllByType("li")).toHaveLength(20);
    await click(button("Show more workspaces"));
    expect(view.root.findByProps({ "aria-label": "Workspace directory" }).findAllByType("li")).toHaveLength(25);
    await act(async () => input("Search workspaces").props.onChange({ target: { value: "Workspace 24" } }));
    expect(view.root.findByProps({ "aria-label": "Workspace directory" }).findAllByType("li")).toHaveLength(1);
  });
  it("preserves unsaved metadata when closing and reopening", async () => {
    await mount();
    await click(button("Edit metadata"));
    await act(async () => input("Workspace name").props.onChange({ target: { value: "Retained name" } }));
    await click(button("Close editor and keep draft"));
    await click(button("Edit metadata"));
    expect(input("Workspace name").props.value).toBe("Retained name");
    expect(api.updateWorkspace).not.toHaveBeenCalled();
  });
  it("shows an unavailable state after failed refresh and preserves the edit draft", async () => {
    await mount();
    await click(button("Edit metadata"));
    await act(async () => input("Workspace name").props.onChange({ target: { value: "Retained" } }));
    api.fetchWorkspaces.mockRejectedValue(new Error("offline"));
    await click(button("Refresh workspaces"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(text(view.root)).toContain("Workspace directory unavailable");
    expect(input("Workspace name").props.value).toBe("Retained");
    expect(button("Save workspace metadata").props.disabled).toBe(true);
  });
  it("requires a lifecycle review, preserves drafts on cancel, and locks editing after an unknown outcome", async () => {
    await mount(); await click(button("Edit metadata"));
    await act(async () => input("Workspace name").props.onChange({ target: { value: "Keep draft" } }));
    await click(button("Archive"));
    expect(text(view.root)).toContain("Stored work is retained");
    expect(api.archiveWorkspace).not.toHaveBeenCalled();
    await click(button("Cancel")); expect(input("Workspace name").props.value).toBe("Keep draft");
    await click(button("Archive")); api.archiveWorkspace.mockRejectedValue(new Error("response lost"));
    await click(button("Confirm archive workspace"));
    expect(api.archiveWorkspace).toHaveBeenCalledExactlyOnceWith("one", 1);
    expect(button("Archive").props.disabled).toBe(true);
    expect(button("Save workspace metadata").props.disabled).toBe(true);
    expect(text(view.root)).toContain("outcome is unconfirmed");
    expect(input("Workspace name").props.value).toBe("Keep draft");
  });
});
