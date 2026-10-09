// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import { ProjectHome } from "./ProjectHome";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
const api = vi.hoisted(() => ({ sessions: vi.fn(), artifacts: vi.fn(), projects: vi.fn(), create: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChatSessions: api.sessions,
  fetchChatGeneratedArtifacts: api.artifacts,
  fetchChatProjects: api.projects,
  createChatSession: api.create,
}));
const project = {
  projectId: "project",
  workspaceId: "one",
  name: "Owned",
  lifecycleStatus: "active",
  revision: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
} as ChatProjectRecord;
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, "", "/chat/projects/project");
  api.sessions.mockResolvedValue({ items: [] });
  api.artifacts.mockResolvedValue({ items: [] });
  api.projects.mockResolvedValue({ items: [project] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <ProjectHome workspaceId="one" project={project} available />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
}
async function start() {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Start Implement for Owned"]')!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
it("uses canonical project preflight and one scoped Chat for intake", async () => {
  api.create.mockResolvedValue({ sessionId: "chat", workspaceId: "one", projectId: "project" });
  await render();
  await start();
  expect(api.create).toHaveBeenCalledExactlyOnceWith(
    {
      workspaceId: "one",
      citadelId: undefined,
      projectId: "project",
      mode: "chat",
      origin: "operator",
      title: "Implement - Owned",
      tags: ["project-intake", "intent:implement"],
    },
    { originSurface: "chat" },
  );
  expect(window.location.pathname).toBe("/chat");
  expect(window.location.search).toContain("sessionId=chat");
});
it("does not create a conversation after project revision or access changes", async () => {
  api.projects.mockResolvedValue({ items: [{ ...project, revision: 2 }] });
  await render();
  await start();
  expect(api.create).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Project changed");
  api.projects.mockImplementation(async () => {
    notifyGatewayAccessChanged();
    return { items: [project] };
  });
  await start();
  expect(api.create).not.toHaveBeenCalled();
});
it("keeps missing artifact evidence distinct from empty records and uses native project artifact scope", async () => {
  api.artifacts.mockRejectedValue(new Error("artifact storage unavailable"));
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Artifact records are unavailable"));
  expect(host.querySelector<HTMLAnchorElement>('a[href*="/library/artifacts"]')?.getAttribute("href")).toContain(
    "projectId=project",
  );
  expect(api.artifacts).toHaveBeenCalledWith({
    workspaceId: "one",
    citadelId: undefined,
    projectId: "project",
    limit: 1000,
  });
});
