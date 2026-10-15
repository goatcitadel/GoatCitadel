import type { ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationRoutingSettings } from "./NotificationRoutingSettings";

const owner = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../../features/native-routes/settings/sections/use-notification-routing", () => ({
  useNotificationRouting: () => owner.current,
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, children, title }: { open: boolean; children: ReactNode; title: string }) =>
    open ? <section aria-label={title}>{children}</section> : null,
}));

const target = {
  targetId: "target-1",
  label: "Ops pager",
  kind: "channel_connection",
  lifecycleState: "active",
  revision: 3,
};
const rule = {
  ruleId: "rule-1",
  label: "Failures",
  lifecycleState: "active",
  deliveryPolicy: "immediate",
  revision: 2,
  eventTypes: ["run.failed"],
  targetIds: ["target-1"],
};
let renderer: ReactTestRenderer | undefined;

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}
function buttons(root: ReactTestInstance = renderer!.root) {
  return root.findAllByType("button");
}
function button(label: string) {
  return buttons().find((node) => text(node) === label)!;
}
function setOwner(review: Record<string, unknown> | null) {
  owner.current = {
    attempt: { locked: false, pending: false, phase: "idle", message: "" },
    loading: false,
    loadError: null,
    notice: null,
    editor: null,
    review,
    targets: [target],
    rules: [rule],
    deliveries: [],
    targetDraft: { key: "target-draft", isDirty: false },
    ruleDraft: { key: "rule-draft", isDirty: false },
    leave: { request: vi.fn(), dialogProps: { open: false, keys: [], onCancel: vi.fn(), onContinue: vi.fn() } },
    testDelivery: () => undefined,
    testPending: () => false,
    handleTest: vi.fn(),
    handleTargetState: vi.fn(),
    handleArchiveRule: vi.fn(),
    confirmReview: vi.fn(),
    cancelReview: vi.fn(),
    reload: vi.fn(),
    setEditor: vi.fn(),
  };
}
async function mount() {
  await act(async () => {
    renderer = create(<NotificationRoutingSettings workspaceId="default" channels={[]} />);
  });
}
beforeEach(() => setOwner(null));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

it("keeps archive triggers neutral because archive is reversible", async () => {
  await mount();
  for (const label of ["Archive destination Ops pager", "Archive rule Failures"]) {
    expect(String(button(label).props.className)).not.toContain("border-status-failed");
  }
});

it.each([
  [{ kind: "test", target }, "Send test notification"],
  [{ kind: "target-state", target, input: { lifecycleState: "archived" } }, "Archive destination"],
  [{ kind: "target-state", target, input: { lifecycleState: "disabled" } }, "Disable destination"],
  [{ kind: "target-state", target, input: { lifecycleState: "active" } }, "Restore destination"],
  [{ kind: "rule-state", rule, input: { lifecycleState: "archived" } }, "Archive rule"],
  [{ kind: "rule-state", rule, input: { lifecycleState: "active" } }, "Restore rule"],
  [{ kind: "create-target", input: {} }, "Create destination"],
  [{ kind: "create-rule", input: {}, targets: [] }, "Create rule"],
])("confirms %o with a primary verb and Cancel last", async (change, label) => {
  setOwner({ ...change, generation: 1, title: "Review", message: "Exact scope" });
  await mount();
  const actions = buttons(renderer!.root.findByProps({ "aria-label": "Review" }));
  expect(actions.map(text)).toEqual([label, "Cancel notification action"]);
  expect(String(actions[0]!.props.className)).toContain("bg-accent");
  await act(async () => actions[0]!.props.onClick());
  expect(owner.current.confirmReview).toHaveBeenCalledOnce();
});
