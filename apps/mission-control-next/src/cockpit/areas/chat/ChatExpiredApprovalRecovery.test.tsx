// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { ChatExpiredApprovalRecovery } from "./ChatExpiredApprovalRecovery";
let tree: ReactTestRenderer;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
});
it("expiry alone never claims a known execution outcome and a dirty draft is preserved", async () => {
  const change = vi.fn(),
    props = {
      draft: "Keep my draft",
      onDraftChange: change,
      thread: { turns: [{ turnId: "t", userMessage: { content: "Old request" } }] } as never,
    };
  await act(async () => {
    tree = create(<ChatExpiredApprovalRecovery props={props} turnId="t" />);
  });
  expect(JSON.stringify(tree.toJSON())).not.toContain("The action did not run");
  await act(async () => tree.root.findByType("button").props.onClick());
  expect(change).not.toHaveBeenCalled();
  expect(JSON.stringify(tree.toJSON())).toContain("already has text");
});
