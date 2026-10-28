import { describe, expect, it } from "vitest";
import { inboxApprovalHref, inboxApprovalLink } from "./capability-links";
import * as connectorLinks from "./connectors/connector-links";

describe("inbox approval links", () => {
  it("opens the approval in the installation's own workspace", () => {
    const target = new URL(inboxApprovalHref("approval-1"), "http://localhost");
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe("approval-1");
    expect(target.searchParams.get("workspaceId")).toBe("default");
  });

  it("encodes the approval id", () => {
    expect(inboxApprovalHref("a b&c")).toBe("/inbox?approvalId=a%20b%26c&workspaceId=default");
  });

  it("names the link by its destination", () => {
    expect(inboxApprovalLink("approval-1")).toEqual({
      label: "Open in Inbox",
      href: "/inbox?approvalId=approval-1&workspaceId=default",
    });
  });

  it("is the same link the Connectors tab uses", () => {
    expect(connectorLinks.inboxApprovalHref).toBe(inboxApprovalHref);
    expect(connectorLinks.inboxApprovalLink).toBe(inboxApprovalLink);
  });
});
