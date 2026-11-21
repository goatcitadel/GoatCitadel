// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { FollowThroughItem } from "@goatcitadel/contracts";
import { ChatFollowThrough } from "./ChatFollowThrough";
let tree: ReactTestRenderer;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
});
it("shows the selected zone, outcome, destination and direct decision without submitting on view", async () => {
  const decide = vi.fn(),
    item = {
      owner: { kind: "commitment", ownerId: "c" },
      revision: 3,
      purpose: "Check the interview result",
      state: "awaiting_review",
      timezone: "America/Los_Angeles",
      delivery: "This conversation",
      permissionSummary: "Current restricted profile",
      budgetSummary: "$1 daily cap",
      actions: [{ action: "accept", label: "Accept follow-up" }],
      ownerHref: "/work/schedules",
    } as FollowThroughItem;
  await act(async () => {
    tree = create(<ChatFollowThrough items={[item]} onAction={decide} />);
  });
  expect(decide).not.toHaveBeenCalled();
  expect(JSON.stringify(tree.toJSON())).toContain("America/Los_Angeles");
  await act(async () => tree.root.findByProps({ "data-follow-through-action": "c:accept" }).props.onClick());
  expect(decide).toHaveBeenCalledWith(item, "accept");
});
it("states unknown delivery explicitly and never invents a resend button", async () => {
  await act(async () => {
    tree = create(
      <ChatFollowThrough
        items={[
          {
            owner: { kind: "schedule", ownerId: "j" },
            revision: 1,
            purpose: "Report",
            state: "unknown",
            timezone: "UTC",
            delivery: "Channel",
            permissionSummary: "Restricted",
            budgetSummary: "Budget applies",
            actions: [],
            ownerHref: "/work/schedules",
          },
        ]}
        onAction={vi.fn()}
      />,
    );
  });
  expect(JSON.stringify(tree.toJSON())).toContain("Automatic resend is off");
  expect(tree.root.findAllByType("button")).toHaveLength(0);
});
