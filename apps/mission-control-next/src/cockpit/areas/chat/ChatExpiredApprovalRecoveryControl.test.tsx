// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ read: vi.fn(), prepare: vi.fn(), fetch: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat-continuation", () => ({
  fetchChatContinuation: api.read,
  prepareChatContinuation: api.prepare,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChangePlan: api.fetch }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "local", activeWorkspaceId: "A" }),
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/OwnedChangePlanList", () => ({
  OwnedChangePlanList: () => null,
}));
vi.mock("../settings/SettingsApprovalDialog", () => ({ SettingsApprovalDialog: () => null }));
vi.mock("../../../features/native-routes/settings/use-settings-approval-continuation", () => ({
  useSettingsApprovalContinuation: () => ({ continueApproved: async () => false, visible: false, disabled: true }),
}));
import { ChatExpiredApprovalRecoveryControl } from "./ChatExpiredApprovalRecoveryControl";
let tree: ReactTestRenderer, client: QueryClient;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  client?.clear();
  vi.resetAllMocks();
});
const response = {
  version: 1,
  workspaceId: "A",
  sessionId: "s",
  sourceHash: "a".repeat(64),
  status: "review_required",
  reason: "Expired before setup",
  nextAction: { kind: "review_again", label: "Review again" },
};
async function mount(draftControls: Record<string, unknown> = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    tree = create(
      <QueryClientProvider client={client}>
        <ChatExpiredApprovalRecoveryControl
          sessionId="s"
          workspaceId="A"
          approvalId="expired"
          turnId="t"
          props={{ draft: "Keep my draft", ...draftControls }}
          onUpdated={() => {}}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
const buttons = () => tree.root.findAllByType("button");
it("views do not renew; simultaneous clicks keep one exact review pending", async () => {
  api.read.mockResolvedValue(response);
  let settle!: (value: unknown) => void;
  api.prepare.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  await mount();
  expect(api.prepare).not.toHaveBeenCalled();
  const review = buttons().find((button) => button.children.join("") === "Review again")!;
  await act(async () => {
    review.props.onClick();
    review.props.onClick();
    await Promise.resolve();
  });
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(api.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "A",
      sessionId: "s",
      sourceTurnId: "t",
      expectedSourceHash: response.sourceHash,
    }),
  );
  await act(async () =>
    settle({ ...response, plan: { planId: "foreign", origin: { workspaceId: "B", sessionId: "s" } } }),
  );
  expect(JSON.stringify(tree.toJSON())).toContain("scope changed");
});
it("unknown execution offers inspection without request restoration or renewal", async () => {
  api.read.mockResolvedValue({
    ...response,
    status: "unknown_effect",
    reason: "Inspect unknown delivery",
    nextAction: { kind: "inspect_owner", label: "Inspect execution outcome" },
  });
  await mount();
  expect(buttons().some((button) => ["Ask again", "Review again"].includes(button.children.join("")))).toBe(false);
  expect(JSON.stringify(tree.toJSON())).toContain("Inspect execution outcome");
  expect(api.prepare).not.toHaveBeenCalled();
});

it("waits for a known outcome before offering request restoration", async () => {
  api.read.mockReturnValue(new Promise(() => {}));
  await mount({ thread: { turns: [{ turnId: "t", userMessage: { content: "Original operator request" } }] } });
  expect(buttons().some((button) => button.children.join("") === "Ask again")).toBe(false);
});
