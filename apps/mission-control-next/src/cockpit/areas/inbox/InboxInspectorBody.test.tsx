// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { expect, it, vi } from "vitest";
import { InboxInspectorBody } from "./InboxInspectorBody";

// The approval detail states the expiry itself (IN-R04); stub it so this test sees only the inspector body's lines.
vi.mock("./InboxApprovalDetail", () => ({ InboxApprovalDetail: () => <p>Approval detail</p> }));
vi.mock("./InboxUserInputDetail", () => ({ InboxUserInputDetail: () => <p>Question detail</p> }));
vi.mock("./InboxSourceContext", () => ({ InboxSourceContext: () => null }));
vi.mock("./InboxOwnerLink", () => ({ InboxOwnerLink: () => null }));
vi.mock("./inbox-viewed-updates", () => ({ inboxUpdateVersion: () => undefined }));

const base: OperatorInboxItem = {
  id: "approval:a",
  kind: "approval",
  group: "needs_decision",
  title: "Review memory write",
  summary: "Writes memory.",
  createdAt: "2026-10-19T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
  source: { workspaceId: "default", approvalId: "a" },
  href: "/inbox?approvalId=a",
} as OperatorInboxItem;

const render = (item: OperatorInboxItem) =>
  renderToStaticMarkup(
    <InboxInspectorBody
      item={item}
      workspaceId="default"
      installation="local"
      explicitDetails={false}
      onOpened={vi.fn()}
    />,
  );

it("leaves an approval's expiry to its detail, so the inspector states it once", () => {
  expect(render(base)).not.toMatch(/Expires in|Expiry passed/);
});

it("still shows the expiry for other kinds that carry one", () => {
  expect(render({ ...base, id: "user_input:a", kind: "user_input" } as OperatorInboxItem)).toMatch(/Expires in/);
});
