// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import { ChatProjects } from "./ChatProjects";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { commitCockpitNavigation } from "../../app/cockpit-history";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  sessions: vi.fn(),
  createSession: vi.fn(),
}));
const scope = vi.hoisted(() => ({ activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => scope }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  fetchChatProjects: api.list,
  createChatProject: api.create,
  updateChatProject: api.update,
  archiveChatProject: api.archive,
  restoreChatProject: api.restore,
  fetchChatGeneratedArtifacts: vi.fn().mockResolvedValue({ items: [] }),
  fetchAutonomousActivationGrants: vi.fn().mockResolvedValue({ items: [] }),
  fetchChatSessions: api.sessions,
  createChatSession: api.createSession,
}));
vi.mock("./ProjectRecents", () => ({ ProjectRecents: () => <p>Recent project history</p> }));
vi.mock("../../ui/ClassicOwnerLink", () => ({
  ClassicOwnerLink: ({ href, label }: { href: string; label: string }) => <a href={href}>{label}</a>,
}));
vi.mock("../../../shell-preference", async (original) => ({
  ...(await original<typeof import("../../../shell-preference")>()),
  switchShell: vi.fn(),
}));
let root: Root, host: HTMLDivElement, client: QueryClient;
let records: ChatProjectRecord[];
const project = (changes: Partial<ChatProjectRecord> = {}): ChatProjectRecord => ({
  projectId: "project-a",
  workspaceId: "workspace-a",
  name: "Project Alpha",
  workspacePath: "F:/authorized/alpha",
  description: "Alpha description",
  color: "teal",
  revision: 2,
  lifecycleStatus: "active",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  ...changes,
});
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <ChatProjects />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  await flush();
}
async function click(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  expect(node, label).toBeDefined();
  await act(async () => node!.click());
  await flush();
}
async function input(label: string, value: string) {
  const node =
    document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`) ??
    [...document.querySelectorAll<HTMLInputElement>("input")].find((item) =>
      document.querySelector(`label[for="${item.id}"]`)?.textContent?.startsWith(label),
    );
  expect(node, label).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionViewStateForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  window.localStorage.clear();
  Object.assign(scope, { activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a" });
  records = [project()];
  api.list.mockImplementation(async () => ({ items: records }));
  api.sessions.mockResolvedValue({ items: [] });
  api.create.mockImplementation(async (value) => {
    const result = project({ ...value, projectId: "created", revision: 1 });
    records = [...records, result];
    return result;
  });
  api.update.mockImplementation(async (id, value) => {
    const result = project({ ...value, projectId: id, revision: value.expectedRevision + 1 });
    records = [result];
    return result;
  });
  api.archive.mockImplementation(async () => {
    records = [project({ lifecycleStatus: "archived", revision: 3 })];
    return records[0];
  });
  api.restore.mockImplementation(async () => {
    records = [project({ revision: 4 })];
    return records[0];
  });
  window.history.replaceState(null, "", "/chat/projects?shell=cockpit");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
});
it("keeps one project overview and fanout sibling through repeated revision and caller changes", async () => {
  window.history.replaceState(null, "", "/chat/projects/project-a");
  await render();
  for (const revision of [3,4,5]) {
    records = [project({revision})];
    await act(async () => { await client.invalidateQueries(); }); await flush();
    expect(host.querySelectorAll('[aria-label="Project overview"]')).toHaveLength(1);
    expect(host.querySelectorAll('[aria-label="Automatic fan-out"]')).toHaveLength(1);
  }
  await act(async () => notifyGatewayAccessChanged()); await flush();
  expect(host.querySelectorAll('[aria-label="Project overview"]')).toHaveLength(1);
  expect(window.location.pathname).toBe('/chat/projects/project-a');
});
it("reads only the scoped canonical list, creates all public fields, and opens the returned detail", async () => {
  await render();
  expect(api.list).toHaveBeenCalledWith(
    "all",
    300,
    "workspace-a",
    "citadel-a",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await click("New project");
  await click("Create project");
  expect(api.create).not.toHaveBeenCalled();
  expect(host.textContent).toContain("required");
  await input("Project name", "New Alpha");
  await input("Workspace path", "F:/authorized/new");
  await input("Project description", "Preserved context");
  await input("Project color", "blue");
  await click("Create project");
  expect(api.create).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "workspace-a",
    citadelId: "citadel-a",
    name: "New Alpha",
    workspacePath: "F:/authorized/new",
    description: "Preserved context",
    color: "blue",
  });
  expect(window.location.pathname).toBe("/chat/projects/created");
  expect(host.textContent).toContain("New Alpha");
});
it("preserves missing and foreign detail URLs without silently selecting another project", async () => {
  records.push(project({ projectId: "foreign", workspaceId: "workspace-b" }));
  window.history.replaceState(null, "", "/chat/projects/foreign");
  await render();
  expect(host.textContent).toContain("Project unavailable in this scope");
  expect(window.location.pathname).toBe("/chat/projects/foreign");
  expect(host.querySelector('[aria-label="Edit project"]')).toBeNull();
});
it("pins locally and reviews archive Cancel0 / confirm1 with the canonical revision, then restores", async () => {
  window.history.replaceState(null, "", "/chat/projects/project-a");
  await render();
  await click("Pin project");
  expect(host.textContent).toContain("Unpin project");
  await click("Archive project");
  await click("Cancel");
  expect(api.archive).not.toHaveBeenCalled();
  await click("Archive project");
  await click("Confirm archive");
  expect(api.archive).toHaveBeenCalledExactlyOnceWith("project-a", 2);
  expect(host.textContent).toContain("Archived project");
  await click("All projects");
  await click("Archived");
  expect(host.textContent).toContain("Project Alpha");
  await act(async () => {
    commitCockpitNavigation("/chat/projects/project-a");
  });
  await flush();
  await click("Restore project");
  await click("Confirm restore");
  expect(api.restore).toHaveBeenCalledExactlyOnceWith("project-a", 3);
  expect(host.textContent).toContain("Active project");
});
it("keeps a conflicting edit draft, exposes fresh fields and only retries after explicit revision reconciliation", async () => {
  window.history.replaceState(null, "", "/chat/projects/project-a");
  await render();
  await click("Edit project");
  await input("Project name", "My draft");
  const savedPath = `F:/authorized/${"long-directory-segment".repeat(12)}/canonical`;
  const conflictError = `Revision conflict at ${savedPath}`;
  api.update.mockImplementationOnce(async () => {
    records = [project({ name: "Concurrent edit", workspacePath: savedPath, revision: 7 })];
    throw new Error(conflictError);
  });
  await click("Save project");
  expect(api.update).toHaveBeenCalledWith(
    "project-a",
    expect.objectContaining({ name: "My draft", expectedRevision: 2 }),
  );
  expect(host.textContent).toContain("Current saved project: Concurrent edit");
  expect(host.textContent).toContain(savedPath);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(conflictError);
  expect([...host.querySelectorAll("input")].some((item) => item.value === "F:/authorized/alpha")).toBe(true);
  expect([...host.querySelectorAll("input")].some((item) => item.value === "My draft")).toBe(true);
  await click("Use current revision with my draft");
  await click("Save project");
  expect(api.update).toHaveBeenLastCalledWith(
    "project-a",
    expect.objectContaining({ name: "My draft", expectedRevision: 7 }),
  );
});
it("native dirty leave Cancel preserves draft and destination; discard continues once", async () => {
  window.history.replaceState(null, "", "/chat/projects/project-a");
  await render();
  await click("Edit project");
  await input("Project name", "Unsaved edit");
  await click("All projects");
  expect(document.body.textContent).toContain("Unsaved changes");
  await click("Cancel");
  expect(window.location.pathname).toBe("/chat/projects/project-a");
  expect([...host.querySelectorAll("input")].some((item) => item.value === "Unsaved edit")).toBe(true);
  await click("All projects");
  await click("Discard changes");
  expect(window.location.pathname).toBe("/chat/projects");
  expect(api.update).not.toHaveBeenCalled();
});
it("does not publish a late create into another workspace", async () => {
  let complete!: (value: ChatProjectRecord) => void;
  api.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  await click("New project");
  await input("Project name", "Delayed");
  await input("Workspace path", "F:/authorized/late");
  await click("Create project");
  scope.activeWorkspaceId = "workspace-b";
  await render();
  await act(async () => complete(project({ projectId: "late" })));
  await flush();
  expect(window.location.pathname).toBe("/chat/projects");
  expect(host.textContent).not.toContain("Delayed");
});
it("invalidates an archive review on caller access change before persistence", async () => {
  window.history.replaceState(null, "", "/chat/projects/project-a");
  await render();
  await click("Archive project");
  await act(async () => notifyGatewayAccessChanged());
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(api.archive).not.toHaveBeenCalled();
});
it("opens the exact conversation for the existing reviewed assignment owner", async () => {
  api.sessions.mockResolvedValue({
    items: [{ sessionId: "conversation-a", workspaceId: "workspace-a", title: "Unassigned chat", revision: 1 }],
  });
  window.history.replaceState(null, "", "/chat/projects/project-a");
  await render();
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Conversation to assign"]')!;
  await act(async () => {
    select.value = "conversation-a";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Review conversation assignment");
  expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("conversation-a");
  expect(new URLSearchParams(window.location.search).get("assignProjectId")).toBe("project-a");
  expect(window.location.pathname).toBe("/chat");
});
