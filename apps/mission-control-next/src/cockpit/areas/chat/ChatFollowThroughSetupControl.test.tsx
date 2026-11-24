// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/follow-through", () => ({
  fetchFollowThroughSetup: api.read,
  createFollowThroughSetup: api.create,
}));
vi.mock("../../../features/native-routes/projects/use-project-access", () => ({
  useProjectAccess: () => ({ identity: "operator", current: () => true }),
}));
vi.mock("../../ui/NativeOwnerLink", () => ({
  NativeOwnerLink: ({ children }: { children: unknown }) => <a>{children as string}</a>,
}));
vi.mock("./ChatFollowThroughSetup", () => ({
  ChatFollowThroughSetupForm: ({
    onCreate,
  }: {
    onCreate: (input: { sourceHash: string; draft: Record<string, unknown> }) => Promise<void>;
  }) => (
    <button onClick={() => onCreate({ sourceHash: "hash", draft: { purpose: "Check" } })}>Create follow-through</button>
  ),
}));
import { ChatFollowThroughSetupControl } from "./ChatFollowThroughSetupControl";

let tree: ReactTestRenderer, client: QueryClient;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  client?.clear();
  vi.resetAllMocks();
});
const setup = { workspaceId: "A", sessionId: "s", sourceHash: "hash" };
const job = (jobId: string) => ({ jobId, actionConfig: { agentTurn: { sessionId: "s", workspaceId: "A" } } });
function render(open: boolean) {
  return (
    <QueryClientProvider client={client}>
      <ChatFollowThroughSetupControl open={open} workspaceId="A" sessionId="s" onClose={vi.fn()} onCreated={vi.fn()} />
    </QueryClientProvider>
  );
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
const button = (label: string) => tree.root.findAllByType("button").find((node) => node.children.join("") === label);

it("starts a fresh setup with a new identity each time it reopens after a save", async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  api.read.mockResolvedValue(setup);
  api.create.mockResolvedValueOnce(job("first")).mockResolvedValueOnce(job("second"));
  await act(async () => {
    tree = create(render(true));
  });
  await settle();
  await act(async () => {
    await button("Create follow-through")!.props.onClick();
  });
  expect(JSON.stringify(tree.toJSON())).toContain("Follow-through is saved.");
  await act(async () => tree.update(render(false)));
  await act(async () => tree.update(render(true)));
  await settle();
  expect(JSON.stringify(tree.toJSON())).not.toContain("Follow-through is saved.");
  await act(async () => {
    await button("Create follow-through")!.props.onClick();
  });
  expect(api.create).toHaveBeenCalledTimes(2);
  expect(api.create.mock.calls[1]![0].operationId).not.toBe(api.create.mock.calls[0]![0].operationId);
});
