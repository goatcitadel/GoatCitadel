import { describe, expect, it } from "vitest";
import { inboxSelectionHref } from "./inbox-selection-url";

describe("inboxSelectionHref", () => {
  it("names the item and its workspace and drops a linked approval", () => {
    expect(
      inboxSelectionHref(
        { pathname: "/inbox", search: "?workspaceId=w&approvalId=a1", hash: "" },
        "change_plan:p1",
        "w",
      ),
    ).toBe("/inbox?workspaceId=w&item=change_plan%3Ap1");
  });

  it("adds the workspace when the address did not name one", () => {
    expect(inboxSelectionHref({ pathname: "/inbox", search: "", hash: "" }, "approval:a", "default")).toBe(
      "/inbox?workspaceId=default&item=approval%3Aa",
    );
  });

  it("removes only the item and keeps other parameters and the hash", () => {
    expect(
      inboxSelectionHref({ pathname: "/inbox", search: "?workspaceId=w&item=x&filter=1", hash: "#top" }, null, "w"),
    ).toBe("/inbox?workspaceId=w&filter=1#top");
  });
});
