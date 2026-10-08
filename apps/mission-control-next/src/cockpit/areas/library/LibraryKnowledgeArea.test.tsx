// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeRoutePagesProps } from "../../../features/native-routes/types";
import { LibraryKnowledgeArea } from "./LibraryKnowledgeArea";
const mocks = vi.hoisted(() => ({
  prefs: { activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a", setActiveWorkspaceId: vi.fn() },
  navigate: vi.fn(),
  workspaces: vi.fn(),
  section: null as NativeRoutePagesProps | null,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => mocks.prefs }));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({ fetchWorkspaces: mocks.workspaces }));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ search: "", navigate: mocks.navigate }) }));
vi.mock("../../../features/native-routes/library/LibraryKnowledgeSection", () => ({
  LibraryKnowledgeSection: (props: NativeRoutePagesProps) => {
    mocks.section = props;
    return <p>Existing knowledge owner</p>;
  },
}));
let container: HTMLDivElement, root: Root, client: QueryClient;
const render = () =>
  root.render(
    <QueryClientProvider client={client}>
      <LibraryKnowledgeArea />
    </QueryClientProvider>,
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.prefs = { activeWorkspaceId: "workspace-a", activeCitadelId: "citadel-a", setActiveWorkspaceId: vi.fn() };
  mocks.section = null;
  mocks.workspaces.mockResolvedValue({
    items: [{ workspaceId: "workspace-a", citadelId: "citadel-a", name: "Project Alpha" }],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
});
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
it("uses the scoped directory name while retaining the existing knowledge owner", async () => {
  await act(async () => render());
  await settle();
  expect(container.textContent).toContain("Project Alpha");
  expect(mocks.section?.activeWorkspaceName).toBe("Project Alpha");
  expect(mocks.section?.activeWorkspaceId).toBe("workspace-a");
  expect(mocks.workspaces).toHaveBeenCalledWith(
    "active",
    200,
    "citadel-a",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
it("cannot display a late directory name from a previous Citadel", async () => {
  let resolve!: (value: unknown) => void;
  const old = new Promise((done) => {
    resolve = done;
  });
  mocks.workspaces.mockReturnValueOnce(old);
  await act(async () => render());
  mocks.prefs = { ...mocks.prefs, activeCitadelId: "citadel-b" };
  mocks.workspaces.mockResolvedValue({
    items: [{ workspaceId: "workspace-a", citadelId: "citadel-b", name: "Project Beta" }],
  });
  await act(async () => render());
  await settle();
  await act(async () =>
    resolve({ items: [{ workspaceId: "workspace-a", citadelId: "citadel-a", name: "Private old name" }] }),
  );
  await settle();
  expect(container.textContent).toContain("Project Beta");
  expect(container.textContent).not.toContain("Private old name");
  expect(mocks.section?.activeCitadelId).toBe("citadel-b");
});
it("keeps governed approval navigation native and workspace-scoped", async () => {
  await act(async () => render());
  mocks.section!.navigate({ area: "ops", section: "approvals", approvalId: "approval/a?" });
  expect(mocks.navigate).toHaveBeenCalledWith(
    "/inbox?item=approval:approval%2Fa%3F&workspaceId=workspace-a&shell=cockpit",
  );
});
