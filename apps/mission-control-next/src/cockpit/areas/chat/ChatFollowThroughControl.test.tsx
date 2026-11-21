// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/follow-through", () => ({
  fetchFollowThrough: api.read,
  requestFollowThroughAction: api.send,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture.invalid",
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "local", activeWorkspaceId: "A" }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/refresh-bus", () => ({ subscribeRefresh: () => () => {} }));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: vi.fn() }) }));
vi.mock("../../../features/native-routes/projects/use-project-access", () => ({
  useProjectAccess: () => ({ identity: "operator" }),
}));
import { ChatFollowThroughControl } from "./ChatFollowThroughControl";
let tree: ReactTestRenderer, client: QueryClient;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  client?.clear();
  sessionStorage.clear();
  vi.resetAllMocks();
});
const item = {
  owner: { kind: "schedule", ownerId: "j" },
  revision: 2,
  executionGeneration: 0,
  purpose: "Check",
  state: "upcoming",
  timezone: "UTC",
  delivery: "Here",
  permissionSummary: "Current",
  budgetSummary: "Shared cap",
  actions: [{ action: "run_now", label: "Run now" }],
  ownerHref: "/work/schedules?jobId=j",
};
const response = { version: 1, workspaceId: "A", sessionId: "s", items: [item], warnings: [], truncated: false };
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    tree = create(
      <QueryClientProvider client={client}>
        <ChatFollowThroughControl sessionId="s" workspaceId="A" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
const button = (label: string) => tree.root.findAllByType("button").find((node) => node.children.join("") === label);
it("an uncertain request retains its exact identity across reopening and only retries the reviewed execution", async () => {
  api.read.mockResolvedValue(response);
  api.send.mockRejectedValueOnce(new Error("connection lost"));
  await mount();
  await act(async () => {
    await button("Run now")!.props.onClick();
  });
  const first = api.send.mock.calls[0]![0];
  expect(first.expectedExecutionGeneration).toBe(0);
  await act(async () => tree.unmount());
  client.clear();
  await mount();
  expect(api.send).toHaveBeenCalledTimes(1);
  expect(button("Run now")?.props.disabled).toBe(true);
  api.send.mockResolvedValue({
    ...response,
    actionReceipt: { operationId: first.operationId, runId: "r", state: "completed" },
  });
  await act(async () => {
    await button("Retry exact run request")!.props.onClick();
  });
  expect(api.send).toHaveBeenCalledTimes(2);
  expect(api.send.mock.calls[1]![0]).toEqual(first);
});
it("does not treat a successful HTTP response without its canonical receipt as a confirmed run", async () => {
  api.read.mockResolvedValue(response);
  api.send.mockResolvedValue(response);
  await mount();
  await act(async () => {
    await button("Run now")!.props.onClick();
  });
  expect(Boolean(button("Retry exact run request"))).toBe(true);
  expect(button("Run now")?.props.disabled).toBe(true);
});
